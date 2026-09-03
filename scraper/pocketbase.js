const path = require("path");
require("dotenv").config({ path: path.join(__dirname, '../.env') });
const PocketBase = require('pocketbase/cjs');
const crypto = require('crypto');
const NotificationService = require("../backend/services/NotificationService");

const pbUrl = process.env.POCKETBASE_URL || "https://pbflat.formics.io";
const pb = new PocketBase(pbUrl);

let pbAuthPromise = null;

async function getPb() {
    if (!pb.authStore.isValid) {
        if (!pbAuthPromise) {
            pbAuthPromise = pb.admins.authWithPassword(
                process.env.PB_ADMIN_EMAIL || 'ranaurvadipsinh1@gmail.com',
                process.env.PB_ADMIN_PASSWORD || 'rana@1512@'
            ).catch(e => {
                console.error("PocketBase auth error:", e);
            });
        }
        await pbAuthPromise;
    }
    return pb;
}

let pipeline = null;
let extractor = null;
try {
    const transformers = require("@xenova/transformers");
    pipeline = transformers.pipeline;
    transformers.env.allowLocalModels = true;
    transformers.env.useBrowserCache = false;
} catch (e) {
    console.warn("⚠️ @xenova/transformers not available. Embeddings won't be generated.");
}

/**
 * Normalize Facebook URLs to extract the canonical facebook_post_id
 */
function normalizeFacebookPostId(url) {
    if (!url) return null;
    try {
        const parsed = new URL(url, "https://www.facebook.com");

        if (parsed.searchParams.has("multi_permalinks")) {
            return parsed.searchParams.get("multi_permalinks");
        }
        
        if (parsed.searchParams.has("set")) {
            const setParam = parsed.searchParams.get("set");
            if (setParam.startsWith('gm.')) return setParam.replace('gm.', '');
            if (setParam.startsWith('pcb.')) return setParam.replace('pcb.', '');
        }
        
        if (parsed.searchParams.has("story_fbid")) return parsed.searchParams.get("story_fbid");
        if (parsed.searchParams.has("fbid")) return parsed.searchParams.get("fbid");

        const match = parsed.pathname.match(/\/(?:posts|permalink)\/(\d+)/);
        if (match && match[1]) return match[1];

        if (/^\d+$/.test(url)) return url;

        return null;
    } catch (e) {
        if (/^\d+$/.test(url)) return url;
        return null;
    }
}

/**
 * Fetch existing normalized post IDs and temporary IDs for a group to cache in memory.
 */
async function getExistingPermalinksForGroup(groupUrl, groupName, groupId) {
    const existingFacebookPostIds = new Set();
    const existingTemporaryIds = new Set();
    let pbRowsCount = 0;

    const pbClient = await getPb();
    
    try {
        const data = await pbClient.collection("posts").getFullList({
            filter: `group_url ~ "${groupId}"`,
            fields: 'id, permalink, temporary_id, facebook_post_id, group_url'
        });

        pbRowsCount = data.length;
        for (const row of data) {
            let fbId = row.facebook_post_id;
            if (!fbId && row.permalink) {
                fbId = normalizeFacebookPostId(row.permalink);
                if (fbId) {
                    await pbClient.collection("posts").update(row.id, { facebook_post_id: fbId }).catch(() => { });
                }
            }
            if (!fbId && row.id && !row.id.startsWith("http")) {
                fbId = normalizeFacebookPostId(row.id);
            }
            if (fbId) existingFacebookPostIds.add(fbId);
            if (row.temporary_id) {
                existingTemporaryIds.add(row.temporary_id);
            } else if (row.id && !row.id.startsWith("http") && !/^\d+$/.test(row.id)) {
                existingTemporaryIds.add(row.id);
            }
        }
    } catch (err) {
        console.error(`❌ Unexpected error fetching existing posts from PocketBase:`, err.message);
    }

    console.log(`Loaded existing posts:\n${pbRowsCount}\n`);
    console.log(`existingPostIds:\n${existingFacebookPostIds.size}\n`);
    console.log(`existingTemporaryIds:\n${existingTemporaryIds.size}\n`);

    return { existingFacebookPostIds, existingTemporaryIds };
}

/**
 * Update an existing temporary post record with its newly discovered permalink and facebook_post_id.
 */
async function updatePostPermalinkInSupabase(temporaryId, newPermalink, facebookPostId) {
    const pbClient = await getPb();
    if (!temporaryId || !newPermalink) return { error: null };
    try {
        const record = await pbClient.collection("posts").getFirstListItem(`temporary_id="${temporaryId}"`);
        if (record) {
            const data = await pbClient.collection("posts").update(record.id, {
                permalink: newPermalink,
                facebook_post_id: facebookPostId,
                needs_permalink: false
            });
            return { data };
        }
        return { data: null };
    } catch (err) {
        console.error(`❌ PocketBase Update Permalink Error:`, err.message);
        return { error: err };
    }
}

/**
 * Trigger keyword alerts
 */
async function processKeywordAlerts(post) {
    const pbClient = await getPb();
    try {
        const alerts = await pbClient.collection("alerts").getFullList({
            filter: "enabled=true"
        });
            
        if (!alerts || alerts.length === 0) {
            return;
        }

        console.log(`\nChecking Alerts...`);
        
        const rawText = `${post.body || ''} ${post.author || ''} ${post.group_name || ''} ${post.location || ''} ${post.post_type || ''}`;
        const searchPool = rawText.replace(/[\W_]+/g, '').toLowerCase();
        let matchCount = 0;

        for (const alert of alerts) {
            const matchedKeywords = new Set();
            let isMatch = true;
            
            if (alert.property_types && alert.property_types.length > 0) {
                let categoryMatch = false;
                for (const keyword of alert.property_types) {
                    const cleanKeyword = keyword.replace(/[\W_]+/g, '').toLowerCase();
                    if (searchPool.includes(cleanKeyword)) {
                        categoryMatch = true;
                        matchedKeywords.add(keyword);
                    }
                }
                if (!categoryMatch) isMatch = false;
            }
            
            if (isMatch && alert.tenant_types && alert.tenant_types.length > 0) {
                let categoryMatch = false;
                for (const keyword of alert.tenant_types) {
                    const cleanKeyword = keyword.replace(/[\W_]+/g, '').toLowerCase();
                    if (searchPool.includes(cleanKeyword)) {
                        categoryMatch = true;
                        matchedKeywords.add(keyword);
                    }
                }
                if (!categoryMatch) isMatch = false;
            }
            
            if (isMatch && alert.location && alert.location.trim() !== '') {
                const cleanKeyword = alert.location.replace(/[\W_]+/g, '').toLowerCase();
                if (searchPool.includes(cleanKeyword)) {
                    matchedKeywords.add(alert.location.trim());
                } else {
                    isMatch = false;
                }
            }
            
            if (isMatch) {
                matchCount++;
                const keywordsArray = Array.from(matchedKeywords);
                console.log(`\nAlert #${alert.id}\nMatched:\n${keywordsArray.join('\n')}\nNotification Created`);
                
                const matchedTextStr = keywordsArray.length > 0 ? keywordsArray.join(' • ') : 'Matched all posts (no filters)';
                
                let notificationPayload = {
                    user: alert.user, // Alert has a user relation to profile
                    alert: alert.id,
                    post: post.id,
                    matched_keywords: keywordsArray,
                    matched_text: matchedTextStr,
                    is_read: false,
                    created_at: new Date().toISOString()
                };
                
                const metadata = {
                    alertName: alert.name,
                    author: post.author,
                    groupName: post.group_name,
                    facebookUrl: post.permalink || post.url,
                    preview: post.body
                };

                await NotificationService.notify(pbClient, notificationPayload, metadata);
            }
        }
        
        if (matchCount === 0) {
            console.log("No matching alerts.");
        }
    } catch (err) {
        console.error("❌ Unexpected error in processKeywordAlerts:", err.message);
    }
}

/**
 * Upsert a post or array of posts into PocketBase
 */
async function upsertPostToSupabase(posts) {
    const pbClient = await getPb();
    if (!posts) return null;

    const postsArray = Array.isArray(posts) ? posts : [posts];
    if (postsArray.length === 0) return null;

    let data = [];
    
    try {
        for (const post of postsArray) {
            let recordId = null;

            if (post.facebook_post_id) {
                try {
                    const existing = await pbClient.collection("posts").getFirstListItem(`facebook_post_id="${post.facebook_post_id}"`);
                    if (existing) recordId = existing.id;
                } catch(e) {}
            }
            if (!recordId && post.temporary_id) {
                try {
                    const existing = await pbClient.collection("posts").getFirstListItem(`temporary_id="${post.temporary_id}"`);
                    if (existing) recordId = existing.id;
                } catch(e) {}
            }

            const cleanPost = {
                group_name: post.group_name,
                group_url: post.group_url,
                group_id: post.group_id,
                author: post.author,
                author_profile_url: post.author_profile_url,
                author_avatar: post.author_avatar,
                body: post.body,
                permalink: post.permalink,
                post_url: post.post_url,
                likes: post.likes,
                comments: post.comments,
                shares: post.shares,
                reaction_count: post.reaction_count,
                comment_count: post.comment_count,
                share_count: post.share_count,
                reaction_breakdown: post.reaction_breakdown,
                comments_disabled: post.comments_disabled,
                image_urls: post.image_urls,
                image_count: post.image_count,
                video_urls: post.video_urls,
                video_thumbnail: post.video_thumbnail,
                video_duration: post.video_duration,
                video_count: post.video_count,
                has_video: post.has_video,
                post_type: post.post_type,
                scraped_at: post.scraped_at || new Date().toISOString(),
                temporary_id: post.temporary_id,
                needs_permalink: post.needs_permalink,
                facebook_post_id: post.facebook_post_id,
                facebook_video_url: post.facebook_video_url,
                supabase_id: crypto.randomUUID()
            };

            if (pipeline) {
                try {
                    if (!extractor) {
                        extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
                    }
                    const textToEmbed = [cleanPost.body, cleanPost.author, cleanPost.group_name, cleanPost.location, cleanPost.post_type].filter(Boolean).join(" ");
                    const output = await extractor(textToEmbed, { pooling: 'mean', normalize: true });
                    // No embedding field in PocketBase standard, skip or save if needed
                } catch (err) {}
            }

            let savedRecord = null;
            let isNew = false;
            
            if (recordId) {
                savedRecord = await pbClient.collection("posts").update(recordId, cleanPost);
            } else {
                savedRecord = await pbClient.collection("posts").create(cleanPost);
                isNew = true;
            }

            if (savedRecord) {
                data.push(savedRecord);
                if (isNew) {
                    await processKeywordAlerts(savedRecord);
                }
            }
        }
        return { data };
    } catch (err) {
        console.error(`❌ PocketBase Upsert Error:`, err.message, err.response);
        return { error: err };
    }
}

async function deletePostFromSupabase(postId) {
    const pbClient = await getPb();
    if (!postId) return;
    try {
        await pbClient.collection("posts").delete(postId);
    } catch (err) {
        console.error(`❌ Error deleting post ${postId}:`, err.message);
    }
}

async function getPostStatusInSupabase(groupId, facebookPostId, temporaryId) {
    const pbClient = await getPb();
    try {
        let filterParts = [`group_id="${groupId}"`];

        if (facebookPostId) filterParts.push(`facebook_post_id="${facebookPostId}"`);
        else if (temporaryId) filterParts.push(`temporary_id="${temporaryId}"`);
        else return null;

        const record = await pbClient.collection("posts").getFirstListItem(filterParts.join(" && "));
        return record;
    } catch (err) {
        return null;
    }
}

async function checkDuplicateInSupabase(groupId, facebookPostId, postUrl, temporaryId) {
    const pbClient = await getPb();
    try {
        if (facebookPostId) {
            const record = await pbClient.collection("posts").getFirstListItem(`group_id="${groupId}" && facebook_post_id="${facebookPostId}"`).catch(() => null);
            if (record) return true;
        }

        if (postUrl) {
            let record = await pbClient.collection("posts").getFirstListItem(`group_id="${groupId}" && post_url="${postUrl}"`).catch(() => null);
            if (record) return true;
            record = await pbClient.collection("posts").getFirstListItem(`group_id="${groupId}" && permalink="${postUrl}"`).catch(() => null);
            if (record) return true;
        }

        if (temporaryId) {
            const record = await pbClient.collection("posts").getFirstListItem(`group_id="${groupId}" && temporary_id="${temporaryId}"`).catch(() => null);
            if (record) return true;
        }
        return false;
    } catch (err) {
        return false;
    }
}

async function processEmailBatches() {
    const pbClient = await getPb();
    await NotificationService.processPendingBatches(pbClient);
}

// Keep export names the same so scraper script logic doesn't break
module.exports = {
    getPb,
    supabase: pb,
    upsertPostToSupabase,
    updatePostPermalinkInSupabase,
    deletePostFromSupabase,
    getExistingPermalinksForGroup,
    normalizeFacebookPostId,
    checkDuplicateInSupabase,
    getPostStatusInSupabase,
    processKeywordAlerts,
    processEmailBatches
};
