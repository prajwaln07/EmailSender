require('dotenv').config();
const express = require('express');
const sgMail = require('@sendgrid/mail');
const nodemailer = require('nodemailer');
const cors = require('cors');
const Queue = require('bull');
const { createBullBoard } = require('@bull-board/api');
const { BullAdapter } = require('@bull-board/api/bullAdapter');
const { ExpressAdapter } = require('@bull-board/express');
const Redis = require('ioredis');

// Update Redis configuration..
const getRedisConfig = () => {
    // Always use Upstash Redis URL in production (Render)
    const UPSTASH_URL = "rediss://default:AX3SAAIjcDFkNDQxMzc1MDM3MTM0MTgzOTdkNGY0MzUzMDVlYWE5ZnAxMA@summary-crayfish-32210.upstash.io:6379";
    
    return {
        url: UPSTASH_URL,
        tls: {
            rejectUnauthorized: false
        },
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => {
            const delay = Math.min(times * 50, 2000);
            return delay;
        }
    };
};

// Initialize Redis with the configuration
const redis = new Redis(getRedisConfig());

// Add better error logging for Redis
redis.on('error', (error) => {
    console.error('Redis connection error details:', {
        message: error.message,
        code: error.code,
        stack: error.stack
    });
});

redis.on('connect', () => {
    console.log('Successfully connected to Redis at:', redis.options.url);
});

// Create a new Bull queue for email reminders
const emailQueue = new Queue('email-reminders', {
    redis: getRedisConfig()
});

const app = express();
app.use(express.json());
app.use(cors({
    origin: process.env.FRONTEND_URL || '*',
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
        'REDIS_URL'  // Add this for production
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
].filter(account => account.user && account.pass); // Only include configured accounts

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
        if (sendGridCount < 100) {
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

        if (requests > 6) {
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

// Routes
app.post('/send-reminder', rateLimitMiddleware, async (req, res) => {
    try {
        const { email, timeInDays, problemLink, problemName, notes } = req.body;

        if (!email || !problemLink || !problemName) {
            return res.status(400).json({ 
                success: false, 
                error: "Email, problem link, and name are required." 
            });
        }

        await emailQueue.add(
            { email, problemLink, problemName, notes },
            {
                delay: 1*1000,
                attempts: 3
            }
        );

        return res.json({ 
            success: true, 
            message: `Reminder email scheduled for ${timeInDays} days` 
        });
    } catch (error) {
        console.error("Scheduling Error:", error);
        res.status(500).json({ success: false, error: "Failed to schedule email." });
    }
});

// Process email queue..
emailQueue.process(async (job) => {
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
});

// Queue event handlers
emailQueue.on('completed', (job) => {
});

emailQueue.on('failed', (job, err) => {
    console.error(`Job ${job.id} failed! Error:`, err);
});

// Bull Board setup
const serverAdapter = new ExpressAdapter();
createBullBoard({
    queues: [new BullAdapter(emailQueue)],
    serverAdapter
});

serverAdapter.setBasePath('/admin/queues');
app.use('/admin/queues', serverAdapter.getRouter());

// Basic routes
app.get('/', (req, res) => res.send("Server is running"));

// Testing Routes
app.get('/test-email-services', async (req, res) => {
    const testEmail = "prajwal.nimbalkar1910@gmail.com";
    const results = {
        sendgrid: null,
        gmailAccounts: []
    };

    // Test SendGrid
    try {
        sgMail.setApiKey(process.env.SENDGRID_API_KEY);
        await sgMail.send({
            to: testEmail,
            from: process.env.EMAIL_FROM,
            subject: "Test Email from SendGrid",
            html: `
                <h1>SendGrid Test Successful!</h1>
                <p>This email confirms that your SendGrid configuration is working correctly.</p>
                <p>Timestamp: ${new Date().toLocaleString()}</p>
            `
        });
        results.sendgrid = "Success";
    } catch (error) {
        results.sendgrid = `Failed: ${error.message}`;
    }

    // Test each Gmail account
    for (let i = 0; i < gmailAccounts.length; i++) {
        try {
            const transporter = nodemailer.createTransport({
                service: 'gmail',
                auth: {
                    user: gmailAccounts[i].user,
                    pass: gmailAccounts[i].pass
                }
            });

            await transporter.sendMail({
                from: gmailAccounts[i].user,
                to: testEmail,
                subject: `Test Email from Gmail Account ${i + 1}`,
                html: `
                    <h1>Gmail Account ${i + 1} Test Successful!</h1>
                    <p>This email confirms that your Gmail account ${i + 1} configuration is working correctly.</p>
                    <p>Sending from: ${gmailAccounts[i].user}</p>
                    <p>Timestamp: ${new Date().toLocaleString()}</p>
                `
            });

            results.gmailAccounts.push({
                account: gmailAccounts[i].user,
                status: "Success"
            });
        } catch (error) {
            results.gmailAccounts.push({
                account: gmailAccounts[i].user,
                status: `Failed: ${error.message}`
            });
        }
    }

    res.json({
        success: true,
        message: "Email service test completed",
        results
    });
});

// Email service status endpoint
app.get('/email-service-status', async (req, res) => {
    try {
        const sendGridCount = await emailService.getSendGridCount();
        
        const gmailStatus = await Promise.all(
            gmailAccounts.map(async (account, index) => {
                const count = await emailService.getGmailCount(index);
                return {
                    email: account.user,
                    emailsSent: count,
                    remaining: account.dailyLimit - count,
                    isAvailable: count < account.dailyLimit
                };
            })
        );

        res.json({
            success: true,
            status: {
                sendgrid: {
                    emailsSent: sendGridCount,
                    remaining: 100 - sendGridCount,
                    isAvailable: sendGridCount < 100
                },
                gmailAccounts: gmailStatus
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: "Failed to get email service status"
        });
    }
});

// Add this test endpoint
app.get('/redis-test', async (req, res) => {
    try {
        // Test Redis connection
        await redis.set('test', 'Hello from Render!');
        const testValue = await redis.get('test');
        
        res.json({
            success: true,
            message: 'Redis connection successful',
            testValue,
            redisOptions: {
                host: redis.options.host,
                port: redis.options.port,
                tls: !!redis.options.tls
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
            details: {
                code: error.code,
                syscall: error.syscall,
                hostname: error.hostname
            }
        });
    }
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
