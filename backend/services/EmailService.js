const nodemailer = require('nodemailer');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { frontendUrl, appName, companyName } = require('../config/app');

class EmailService {
    constructor() {
        this.transporter = null;
        this.isConfigured = false;
        
        const {
            SMTP_HOST,
            SMTP_PORT,
            SMTP_USER,
            SMTP_PASSWORD,
            SMTP_FROM
        } = process.env;

        if (SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASSWORD && SMTP_FROM) {
            this.transporter = nodemailer.createTransport({
                host: SMTP_HOST,
                port: parseInt(SMTP_PORT, 10),
                secure: parseInt(SMTP_PORT, 10) === 465, // true for 465, false for other ports
                auth: {
                    user: SMTP_USER,
                    pass: SMTP_PASSWORD
                }
            });
            this.fromAddress = SMTP_FROM;
            this.isConfigured = true;
        }
    }

    /**
     * Reusable send method
     */
    async send(to, subject, html, text) {
        if (!this.isConfigured) {
            console.log("SMTP not configured. Skipping email.");
            return { success: false, error: "SMTP not configured" };
        }

        try {
            await this.transporter.sendMail({
                from: this.fromAddress,
                to,
                subject,
                html,
                text,
                headers: {
                    'List-Unsubscribe': `<${frontendUrl}/alerts>`,
                    'Auto-Submitted': 'auto-generated',
                    'X-Auto-Response-Suppress': 'OOF, AutoReply'
                }
            });
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Sends a batch summary email for a single alert
     */
    async sendSummaryEmail(userEmail, alertName, notificationsList) {
        const postCount = notificationsList.length;
        const subject = `${companyName} • ${postCount} new matches for "${alertName || 'Unknown'}"`;
        
        let postsHtml = '';
        let postsText = '';
        
        const displayLimit = 5;
        const displayedPosts = notificationsList.slice(0, displayLimit);

        displayedPosts.forEach((notif, index) => {
            const post = notif.posts || {};
            
            // Format preview (max 250 chars)
            let formattedPreview = post.body || '';
            if (formattedPreview.length > 250) {
                formattedPreview = formattedPreview.substring(0, 250) + '...';
            }

            const facebookUrl = post.permalink || '#';
            const postId = post.id || '';
            const postDate = notif.created_at ? new Date(notif.created_at).toLocaleDateString() : 'Unknown';

            // HTML Version
            postsHtml += `
            <div style="margin-bottom: 20px;">
                <div style="font-weight: bold; margin-bottom: 5px; color: #1a73e8; font-size: 16px;">
                    ${index + 1}.
                </div>
                <div style="margin-bottom: 8px; font-size: 15px;">
                    <strong>Author:</strong> ${post.author || 'Unknown'}<br>
                    <strong>Group:</strong> ${post.group_name || 'Unknown'}<br>
                    <strong>Date:</strong> ${postDate}
                </div>
                <div style="margin-bottom: 8px; font-size: 15px;">
                    <strong>Preview:</strong>
                    <div style="background-color: #f9f9f9; border-left: 4px solid #1a73e8; padding: 15px; margin: 10px 0; font-style: italic; color: #555;">
                        ${formattedPreview}
                    </div>
                </div>
                <div>
                    <a href="${facebookUrl}" style="color: #1a73e8; text-decoration: none; font-weight: bold;">Open Facebook</a> | 
                    <a href="${frontendUrl}/post/${postId}" style="color: #1a73e8; text-decoration: none; font-weight: bold;">View Dashboard</a>
                </div>
                <hr style="border: 0; border-top: 1px dashed #ccc; margin: 20px 0 0 0;" />
            </div>
            `;

            // Plain-Text Version
            postsText += `\n${index + 1}.
Author: ${post.author || 'Unknown'}
Group: ${post.group_name || 'Unknown'}
Date: ${postDate}
Preview: ${formattedPreview}

Open Facebook: ${facebookUrl}
View Dashboard: ${frontendUrl}/post/${postId}
----------------------------------------\n`;
        });
        
        let morePostsHtml = '';
        let morePostsText = '';
        if (postCount > displayLimit) {
            morePostsHtml = `<div style="margin-bottom: 8px; font-size: 15px;"><em>...and ${postCount - displayLimit} more matching posts.</em></div>`;
            morePostsText = `\n...and ${postCount - displayLimit} more matching posts.\n`;
        }

        const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; background-color: #f4f4f4; margin: 0; padding: 20px;">
            <div style="background-color: #ffffff; max-width: 600px; margin: 0 auto; padding: 20px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
                <div style="border-bottom: 2px solid #eaeaea; padding-bottom: 10px; margin-bottom: 20px;">
                    <h1 style="font-size: 24px; color: #1a73e8; margin: 0;">${appName}</h1>
                </div>
                
                <div style="margin-bottom: 20px;">
                    <p style="margin: 0; font-size: 15px;">Hello,</p>
                    <p style="margin: 0; font-size: 15px;">Your alert <strong>"${alertName || 'Unknown'}"</strong> matched ${postCount} new Facebook post${postCount !== 1 ? 's' : ''}.</p>
                </div>

                <div style="margin-bottom: 20px;">
                    <h3 style="margin-bottom: 5px; font-size: 16px; color: #555;">Posts</h3>
                    ${postsHtml}
                    ${morePostsHtml}
                </div>

                <div style="margin-top: 30px; display: block; text-align: center;">
                    <a href="${frontendUrl}/notifications" style="display: inline-block; width: 100%; box-sizing: border-box; text-align: center; padding: 12px 0; background-color: #1a73e8; color: #ffffff !important; text-decoration: none; border-radius: 4px; font-weight: bold; margin-bottom: 10px;">View all matches</a>
                </div>

                <div style="margin-top: 30px; border-top: 1px solid #eaeaea; padding-top: 15px; font-size: 14px; color: #777;">
                    <p style="margin: 0;">You are receiving this email because you created a keyword alert in Facebook Data Inspector.</p>
                    <p style="margin: 0;">Manage your alerts: <a href="${frontendUrl}/alerts" style="color: #1a73e8;">${frontendUrl}/alerts</a></p>
                </div>
            </div>
        </body>
        </html>
        `;

        const text = `${appName}

Hello,
Your alert "${alertName || 'Unknown'}" matched ${postCount} new Facebook post${postCount !== 1 ? 's' : ''}.

Posts:
${postsText}
${morePostsText}
View all matches: ${frontendUrl}/notifications

You are receiving this email because you created a keyword alert in Facebook Data Inspector.
Manage your alerts: ${frontendUrl}/alerts`;

        return await this.send(userEmail, subject, html, text);
    }
}

module.exports = new EmailService();
