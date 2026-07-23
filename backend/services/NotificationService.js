const crypto = require('crypto');
const EmailService = require('./EmailService');
const config = require('../config/app');

class NotificationService {
    /**
     * Creates a notification without sending an email immediately.
     */
    async notify(supabase, notificationPayload, metadata) {
        try {
            // Insert notification
            const { error: insertError } = await supabase
                .from('notifications')
                .insert(notificationPayload);

            if (insertError) {
                if (insertError.message && (insertError.message.includes('duplicate') || insertError.message.includes('unique'))) {
                    // Do nothing for duplicates
                    return { success: true }; 
                }
                console.error("❌ Error inserting notification in NotificationService:", insertError.message);
                return { success: false, error: insertError.message };
            }
            
            console.log(`\nNotification created for Alert #${notificationPayload.alert_id} (queued for batching)`);
            return { success: true };

        } catch (err) {
            console.error("❌ Unexpected error in NotificationService.notify:", err.message);
            return { success: false, error: err.message };
        }
    }

    /**
     * Processes all pending notifications and dispatches grouped summary emails.
     */
    async processPendingBatches(supabase) {
        try {
            console.log("\nProcessing pending email batches...");

            // Fetch pending notifications joining with alerts, posts, and profiles
            // Include those with email_error so they can be retried, but ensure email_batch_id is NULL
            const { data: pending, error } = await supabase
                .from('notifications')
                .select(`
                    id,
                    user_id,
                    alert_id,
                    matched_keywords,
                    created_at,
                    alerts ( name ),
                    posts ( id, author, group_name, body, permalink ),
                    profiles ( email, full_name )
                `)
                .eq('email_sent', false)
                .is('email_batch_id', null);

            if (error) {
                console.error("❌ Error fetching pending notifications:", error.message);
                return;
            }

            if (!pending || pending.length === 0) {
                console.log("No pending notifications for email batches.");
                return;
            }

            // Group by user_id and alert_id
            const groups = {};
            for (const notif of pending) {
                const groupKey = `${notif.user_id}_${notif.alert_id}`;
                if (!groups[groupKey]) {
                    groups[groupKey] = [];
                }
                groups[groupKey].push(notif);
            }

            for (const groupKey of Object.keys(groups)) {
                // Sort by newest first
                const groupNotifs = groups[groupKey].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
                
                const userId = groupNotifs[0].user_id;
                const alertId = groupNotifs[0].alert_id;
                const alertName = groupNotifs[0].alerts ? groupNotifs[0].alerts.name : "Unknown Alert";

                let userEmail = null;
                let userFullName = null;

                // Try to get email from profiles join first
                if (groupNotifs[0].profiles && groupNotifs[0].profiles.email) {
                    userEmail = groupNotifs[0].profiles.email;
                    userFullName = groupNotifs[0].profiles.full_name;
                } else {
                    // Fallback to admin auth API if profile join fails
                    const { data: userData } = await supabase.auth.admin.getUserById(userId);
                    if (userData && userData.user && userData.user.email) {
                        userEmail = userData.user.email;
                        userFullName = userData.user.user_metadata?.full_name || null;
                    }
                }
                
                if (!userEmail) {
                    console.error(`❌ Error fetching user email for user ${userId}`);
                    await this.updateBatchStatus(supabase, groupNotifs, false, "Failed to fetch user email", null);
                    continue;
                }

                const recipient = userFullName ? `"${userFullName}" <${userEmail}>` : userEmail;

                console.log(`Sending batch email to ${recipient} for alert "${alertName}" (${groupNotifs.length} posts)...`);
                
                // Send summary email
                const emailResult = await EmailService.sendSummaryEmail(recipient, alertName, groupNotifs);

                if (emailResult.success) {
                    // Generate a unique batch ID only on success
                    const batchId = crypto.randomUUID();
                    console.log(`Batch email delivered to ${userEmail} [Batch ID: ${batchId}]`);
                    await this.updateBatchStatus(supabase, groupNotifs, true, null, batchId);
                } else {
                    console.error(`Batch email failed to ${userEmail}. Reason:`, emailResult.error);
                    // Do NOT assign batch ID on failure to allow retry
                    await this.updateBatchStatus(supabase, groupNotifs, false, emailResult.error, null);
                }
            }

        } catch (err) {
            console.error("❌ Unexpected error processing email batches:", err.message);
        }
    }

    /**
     * Helper to update the email delivery status of a batch of notifications
     */
    async updateBatchStatus(supabase, notifications, emailSent, emailError, batchId) {
        const notificationIds = notifications.map(n => n.id);
        
        const updatePayload = {
            email_sent: emailSent,
            email_error: emailError,
            email_batch_id: batchId
        };

        if (emailSent) {
            updatePayload.email_sent_at = new Date().toISOString();
        } else {
            updatePayload.email_sent_at = null;
        }

        const { error } = await supabase
            .from('notifications')
            .update(updatePayload)
            .in('id', notificationIds);
            
        if (error) {
            console.error(`❌ Failed to update batch status:`, error.message);
        }
    }
}

module.exports = new NotificationService();
