require('dotenv').config();
const express = require('express');
const sgMail = require('@sendgrid/mail');
const nodemailer = require('nodemailer');
const cors = require('cors');


const Queue = require('bull');
const Redis = require('ioredis');

// Redis and Bull Queue Configuration

let UPSTASH_REDIS_URL = process.env.UPSTASH_REDIS_URL;

// Redis configuration with reconnect strategy
const redisOptions = {
    maxRetriesPerRequest: 3,
    enableReadyCheck: false,
    retryStrategy(times) {
        const delay = Math.min(times * 50, 2000);
        return delay;
    },
    reconnectOnError(err) {
        const targetError = 'READONLY';
        if (err.message.includes(targetError)) {
            return true;
        }
        return false;
    },
    tls: { rejectUnauthorized: false }
};

// Simple Redis client for general operations
const redis = new Redis(UPSTASH_REDIS_URL, redisOptions);

// Simplified Bull queue configuration with improved connection handling
const emailQueue = new Queue('email-reminders', {
    redis: {
        port: 6379,
        host: new URL(UPSTASH_REDIS_URL).hostname,
        password: new URL(UPSTASH_REDIS_URL).password,
        tls: { rejectUnauthorized: false },
        maxRetriesPerRequest: 3,
        enableReadyCheck: false,
        retryStrategy(times) {
            const delay = Math.min(times * 50, 2000);
            return delay;
        }
    },
    defaultJobOptions: {
        attempts: 3,
        backoff: {
            type: 'fixed',
            delay: 3000
        },
        removeOnComplete: true,
        removeOnFail: 100
    }
});



const app = express();
app.use(express.json());
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true
}));

// Add security headers
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});

// Validate environment variables
const validateEnvVariables = () => {
    const required = [
        'SENDGRID_API_KEY',
        'EMAIL_FROM',
        'GMAIL_USER_1',
        'GMAIL_APP_PASSWORD_1',
        'REDIS_URL'  
    ];

    if (process.env.NODE_ENV === 'production') {
        if (!process.env.REDIS_URL) {
            console.error("Missing REDIS_URL in production environment");
            process.exit(1);
        }
    }

    const missing = required.filter(key => !process.env[key]);
    if (missing.length > 0) {
        console.error("Missing required environment variables:", missing);
        process.exit(1);
    }
};
validateEnvVariables();

// Email service configuration
const gmailAccounts = [
    {
        user: process.env.GMAIL_USER_1,
        pass: process.env.GMAIL_APP_PASSWORD_1,
        dailyLimit: 500
    },
    {
        user: process.env.GMAIL_USER_2,
        pass: process.env.GMAIL_APP_PASSWORD_2,
        dailyLimit: 500
    },
    {
        user: process.env.GMAIL_USER_3,
        pass: process.env.GMAIL_APP_PASSWORD_3,
        dailyLimit: 500
    }
].filter(account => account.user && account.pass);

// Email Service Class
class EmailService {
    
    constructor() {
        this.currentGmailIndex = 0;
        this.setupTransporters();
        this.resetCountsDaily();
    }

    setupTransporters() {
        this.gmailTransporters = gmailAccounts.map(account => 
            nodemailer.createTransport({
                service: 'gmail',
                auth: {
                    user: account.user,
                    pass: account.pass
                }
            })
        );
    }

    async resetCountsDaily() {
        setInterval(async () => {
            await redis.set('sendgrid_count', 0);
            for (let i = 0; i < gmailAccounts.length; i++) {
                await redis.set(`gmail_count_${i}`, 0);
            }
        }, 24 * 60 * 60 * 1000);
    }

    async getGmailCount(index) {
        const count = await redis.get(`gmail_count_${index}`);
        return parseInt(count) || 0;
    }

    async incrementGmailCount(index) {
        await redis.incr(`gmail_count_${index}`);
    }

    async getSendGridCount() {
        const count = await redis.get('sendgrid_count');
        return parseInt(count) || 0;
    }

    async incrementSendGridCount() {
        await redis.incr('sendgrid_count');
    }

    async sendEmail(msg) {
        // Try SendGrid first
        const sendGridCount = await this.getSendGridCount();
        if (sendGridCount < 300) {
            try {
                sgMail.setApiKey(process.env.SENDGRID_API_KEY);
                await sgMail.send(msg);
                await this.incrementSendGridCount();
                return;
            } catch (error) {
                console.error('SendGrid failed:', error.message);
            }
        }

        // Try Gmail accounts
        for (let i = 0; i < gmailAccounts.length; i++) {
            const currentIndex = (this.currentGmailIndex + i) % gmailAccounts.length;
            const gmailCount = await this.getGmailCount(currentIndex);
            
            if (gmailCount < gmailAccounts[currentIndex].dailyLimit) {
                try {
                    const transporter = this.gmailTransporters[currentIndex];
                    await transporter.sendMail({
                        from: gmailAccounts[currentIndex].user,
                        to: msg.to,
                        subject: msg.subject,
                        html: msg.html
                    });
                    
                    await this.incrementGmailCount(currentIndex);
                    this.currentGmailIndex = currentIndex;
                    return;
                } catch (error) {
                    console.error(`Gmail account ${currentIndex + 1} failed:`, error.message);
                    continue;
                }
            }
        }

        throw new Error('All email services failed or reached their limits');
    }
}

const emailService = new EmailService();

// Rate limiting middleware
const rateLimitMiddleware = async (req, res, next) => {
    const clientIp = req.ip;
    const currentHour = Math.floor(Date.now() / 3600000);
    const key = `ratelimit:${clientIp}:${currentHour}`;

    try {
        const requests = await redis.incr(key);
        if (requests === 1) {
            await redis.expire(key, 3600);
        }

        if (requests > 7) {
            const ttl = await redis.ttl(key);
            return res.status(429).json({
                success: false,
                error: "Rate limit exceeded. Too many requests.",
                remainingTime: `Try again in ${Math.floor(ttl / 60)} minutes`
            });
        }
        
        next();
    } catch (error) {
        console.error('Rate limiting error:', error);
        next();
    }
};

// Add a connection health check
const checkRedisConnection = async () => {
    try {
        await redis.ping();
        return true;
    } catch (error) {
        console.error('Redis health check failed:', error);
        return false;
    }
};


// Modify the send-reminder route to include connection check
app.post('/send-reminder', rateLimitMiddleware, async (req, res) => {
    // Check Redis connection before proceeding
    const isRedisConnected = await checkRedisConnection();
    if (!isRedisConnected) {
        return res.status(503).json({
            success: false,
            error: "Service temporarily unavailable. Please try again later....."
        });
    }

    try {
        const { email, timeInDays, problemLink, problemName, notes } = req.body;

        if (!email || !problemLink || !problemName) {
            return res.status(400).json({ 
                success: false, 
                error: "Email, problem link, and name are required." 
            });
        }
        const job = await emailQueue.add(
            { email, problemLink, problemName, notes },
            {
                delay: timeInDays*24*60*60*1000,
                attempts: 3,
                removeOnComplete: true
            }
        );

        return res.json({ 
            success: true, 
            message: `Reminder email scheduled`,
            jobId: job.id
        });
    } catch (error) {
        console.error("Scheduling Error:", error);
        res.status(500).json({ 
            success: false, 
            error: "Failed to schedule email.",
            details: error.message
        });
    }
});

// Improved queue processing with better error handling
emailQueue.process(async (job) => {
    try {
        const { email, problemLink, problemName, notes } = job.data;
        
        const emailTemplate = `
            <html>
                <body style="font-family: Arial, sans-serif; background-color: #f4f4f4; color: #333;">
                    <div style="max-width: 600px; margin: 20px auto; padding: 20px; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);">
                        <h1 style="color: #4CAF50;">LeetCode Reminder ⏰</h1>
                        <p style="font-size: 16px; margin-top: 20px;"><strong>Problem:</strong> 
                            <a href="${problemLink}" target="_blank" style="color: #1E88E5; text-decoration: none;">${problemName}</a>
                        </p>
                        ${notes ? `
                            <div style="margin-top: 20px; padding: 10px; background-color: #f9f9f9; border-left: 4px solid #4CAF50;">
                                <h3 style="color: #4CAF50; margin: 0;">Your Notes:</h3>
                                <p style="font-size: 16px; color: #555;">${notes}</p>
                            </div>
                        ` : ''}
                        <p style="text-align: center; margin-top: 20px;">
                            <a href="${problemLink}" target="_blank" style="background-color: #4CAF50; color: white; padding: 10px 20px; border-radius: 5px; text-decoration: none; font-weight: bold;">Solve Now</a>
                        </p>
                    </div>
                </body>
            </html>
        `;

        await emailService.sendEmail({
            to: email,
            subject: "LeetCode Reminder ⏰",
            html: emailTemplate
        });

        console.log(`Job ${job.id} completed successfully`);
        return { success: true, email };
    } catch (error) {
        console.error(`Job ${job.id} failed:`, error);
        throw error;
    }
});



// Basic routes
app.get('/', (req, res) => res.send("Server is running"));



// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
