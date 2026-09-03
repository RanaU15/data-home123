const crypto = require('crypto');
const EmailService = require('./EmailService');
const config = require('../config/app');

class NotificationService {
    /**
     * Creates a notification without sending an email immediately.
     */
    async notify(pb, notificationPayload, metadata) {
        try {
            // In PocketBase, if the user doesn't pass an id, one is auto-generated.
            // If they pass an id that exists, it fails.
            await pb.collection('notifications').create(notificationPayload);
            console.log(`\nNotification created for Alert #${notificationPayload.alert} (queued for batching)`);
            return { success: true };
        } catch (err) {
            if (err.status === 400 && err.response?.data?.id?.code === 'validation_not_unique') {
                return { success: true }; 
            }
            console.error("❌ Error inserting notification in NotificationService:", err.message);
            return { success: false, error: err.message };
        }
    }

    /**
     * Processes all pending notifications and dispatches grouped summary emails.
     */
    async processPendingBatches(pb) {
        try {
            console.log("\nProcessing pending email batches...");

            let pending = [];
            try {
                pending = await pb.collection('notifications').getFullList({
                    filter: 'email_sent=false && email_batch_id=""',
                    expand: 'alert,post,user.user'
                });
            } catch (err) {
                console.error("❌ Error fetching pending notifications:", err.message);
                return;
            }

            if (!pending || pending.length === 0) {
                console.log("No pending notifications for email batches.");
                return;
            }

            // Group by user profile ID and alert ID
            const groups = {};
            for (const notif of pending) {
                const groupKey = `${notif.user}_${notif.alert}`;
                if (!groups[groupKey]) {
                    groups[groupKey] = [];
                }
                groups[groupKey].push(notif);
            }

            for (const groupKey of Object.keys(groups)) {
                const groupNotifs = groups[groupKey].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
                
                const userId = groupNotifs[0].user;
                const alertName = groupNotifs[0].expand?.alert?.name || "Unknown Alert";
                const profileObj = groupNotifs[0].expand?.user;
                const userObj = profileObj?.expand?.user;
                
                if (profileObj && profileObj.is_logged_in !== true) {
                    console.log(`User ${userId} is OFFLINE. Discarding batch email for alert "${alertName}".`);
                    // Mark as sent but with a note so they are cleared from the queue silently
                    await this.updateBatchStatus(pb, groupNotifs, true, "Discarded (User Offline)", "offline_discard");
                    continue;
                }

                let userEmail = userObj?.email || null;
                let userFullName = userObj?.name || null;
                
                if (!userEmail) {
                    console.error(`❌ Error fetching user email for user ${userId}`);
                    await this.updateBatchStatus(pb, groupNotifs, false, "Failed to fetch user email", "");
                    continue;
                }

                const recipient = userFullName ? `"${userFullName}" <${userEmail}>` : userEmail;

                // For EmailService, we need to adapt groupNotifs to look like what it expects
                const adaptedNotifs = groupNotifs.map(n => ({
                    ...n,
                    posts: n.expand?.post || {}
                }));

                console.log(`Sending batch email to ${recipient} for alert "${alertName}" (${groupNotifs.length} posts)...`);
                
                const emailResult = await EmailService.sendSummaryEmail(recipient, alertName, adaptedNotifs);

                if (emailResult.success) {
                    const batchId = crypto.randomUUID().replace(/-/g, '').substring(0, 15);
                    console.log(`Batch email delivered to ${userEmail} [Batch ID: ${batchId}]`);
                    await this.updateBatchStatus(pb, groupNotifs, true, "", batchId);
                } else {
                    console.error(`Batch email failed to ${userEmail}. Reason:`, emailResult.error);
                    await this.updateBatchStatus(pb, groupNotifs, false, emailResult.error, "");
                }
            }

        } catch (err) {
            console.error("❌ Unexpected error processing email batches:", err.message);
        }
    }

    /**
     * Helper to update the email delivery status of a batch of notifications
     */
    async updateBatchStatus(pb, notifications, emailSent, emailError, batchId) {
        const updatePayload = {
            email_sent: emailSent,
            email_error: emailError || "",
            email_batch_id: batchId || ""
        };

        if (emailSent) {
            updatePayload.email_sent_at = new Date().toISOString();
        } else {
            updatePayload.email_sent_at = "";
        }

        for (const n of notifications) {
            try {
                await pb.collection('notifications').update(n.id, updatePayload);
            } catch (error) {
                console.error(`❌ Failed to update batch status for notification ${n.id}:`, error.message);
            }
        }
    }
}

module.exports = new NotificationService();
