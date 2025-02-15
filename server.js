require('dotenv').config();
const express = require('express');
const sgMail = require('@sendgrid/mail');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// Ensure API key exists before setting it
if (!process.env.SENDGRID_API_KEY || !process.env.EMAIL_FROM) {
    console.error("Missing required environment variables. Check SENDGRID_API_KEY and EMAIL_FROM.");
    process.exit(1);
}

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Array of motivational quotes
const motivationalQuotes = [
    "The harder you work for something, the greater you'll feel when you achieve it.",
    "Success doesn't come from what you do occasionally, it comes from what you do consistently.",
    "Don't watch the clock; do what it does. Keep going.",
    "Success is the sum of small efforts, repeated day in and day out.",
    "Believe in yourself and all that you are. Know that there is something inside you that is greater than any obstacle.",
    "The only way to do great work is to love what you do.",
    "You are braver than you believe, stronger than you seem, and smarter than you think.",
    "Push yourself, because no one else is going to do it for you."
];

const getRandomQuote = () => motivationalQuotes[Math.floor(Math.random() * motivationalQuotes.length)];

// Array of dynamic messages
const dynamicMessages = [
    "You promised yourself to solve a LeetCode problem again. It's time to stay true to your goal and crush it! 💪 Keep going!",
    "Keep the momentum going! Time to revisit that LeetCode problem and get stronger! 💪",
    "You're doing great! One more step towards mastery. Reattempt this problem and ace it! 🚀",
    "Stay sharp and keep practicing! This LeetCode problem is waiting for you! 🔥",
    "Challenge yourself again! Every reattempt makes you better. Let's do this! 💯"
];

const getRandomMessage = () => dynamicMessages[Math.floor(Math.random() * dynamicMessages.length)];

app.post('/send-reminder', async (req, res) => {
    try {
        const { email, problemLink, problemName, notes } = req.body;

        if (!email || !problemLink || !problemName) {
            return res.status(400).json({ success: false, error: "Email, problem link, and name are required." });
        }

        // Get a random message for each email
        const reminderMessage = getRandomMessage();

        // Construct the email content with notes
        let fullMessage = `
            <html>
                <body style="font-family: Arial, sans-serif; background-color: #f4f4f4; color: #333;">
                    <div style="max-width: 600px; margin: 20px auto; padding: 20px; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);">
                        <h1 style="color: #4CAF50;">LeetCode Reminder ⏰</h1>
                        <p style="font-size: 16px; line-height: 1.5;">${reminderMessage}</p>
                        <p style="font-size: 16px; margin-top: 20px;"><strong>Problem:</strong> 
                            <a href="${problemLink}" target="_blank" style="color: #1E88E5; text-decoration: none;">${problemName}</a>
                        </p>
        `;

        // Add notes to the email content if they exist
        if (notes) {
            fullMessage += `
                <div style="margin-top: 20px; padding: 10px; background-color: #f9f9f9; border-left: 4px solid #4CAF50;">
                    <h3 style="color: #4CAF50; margin: 0;">Your Notes:</h3>
                    <p style="font-size: 16px; color: #555;">${notes}</p>
                </div>
            `;
        }

        fullMessage += `
                        <p style="text-align: center; margin-top: 20px;">
                            <a href="${problemLink}" target="_blank" style="background-color: #4CAF50; color: white; padding: 10px 20px; border-radius: 5px; text-decoration: none; font-weight: bold;">Solve Now</a>
                        </p>
                        <hr style="border: 0; border-top: 1px solid #ddd; margin: 20px 0;">
                        <h2 style="color: #FF5722;">Motivational Quote:</h2>
                        <p style="font-size: 18px; font-weight: bold; font-style: italic; color: #555;">"${getRandomQuote()}"</p>
                    </div>
                </body>
            </html>
        `;

        const msg = {
            to: email,
            from: process.env.EMAIL_FROM,
            subject: "LeetCode Reminder ⏰",
            html: fullMessage
        };

        await sgMail.send(msg);
        res.json({ success: true, message: "Reminder email sent!" });
    } catch (error) {
        console.error("SendGrid Error:", error.response ? error.response.body : error);
        res.status(500).json({ success: false, error: "Email sending failed." });
    }
});

app.get('/test', (req, res) => {
    return res.status(200).json({
        success: true,
        message: "Server running successfully"
    });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
