require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const nodemailer = require('nodemailer');

async function testEmail() {
    console.log("Starting SMTP test...");

    const {
        SMTP_HOST,
        SMTP_PORT,
        SMTP_USER,
        SMTP_PASSWORD,
        SMTP_FROM
    } = process.env;

    const port = parseInt(SMTP_PORT, 10);
    const isSecure = port === 465;

    console.log("Connecting to SMTP...");

    const transporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port: port,
        secure: isSecure,
        auth: {
            user: SMTP_USER,
            pass: SMTP_PASSWORD
        }
    });

    try {
        console.log("Sending email...");
        
        const info = await transporter.sendMail({
            from: SMTP_FROM,
            to: SMTP_USER,
            subject: "Facebook Data Inspector SMTP Test",
            text: `✅ SMTP configuration is working.

This is a test email sent using Nodemailer.

If you received this email,
your Facebook Data Inspector email notification system is configured correctly.`
        });

        console.log("\n✅ Email sent successfully");
        console.log("Message ID:");
        console.log(info.messageId);

    } catch (error) {
        console.error("\n❌ SMTP Test Failed");
        console.error(error.stack);
    }
}

testEmail();
