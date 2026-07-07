const path = require("path");
require("dotenv").config({ path: path.join(__dirname, '../.env') });
const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;

if (supabaseUrl && supabaseServiceKey && supabaseUrl !== "YOUR_SUPABASE_URL_HERE") {
    supabase = createClient(supabaseUrl, supabaseServiceKey);
} else {
    console.warn("⚠️ Supabase credentials not fully configured in .env.");
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
        if (parsed.searchParams.has("story_fbid")) {
            return parsed.searchParams.get("story_fbid");
        }
        if (parsed.searchParams.has("fbid")) {
            return parsed.searchParams.get("fbid");
        }

        const match = parsed.pathname.match(/\/(?:posts|permalink)\/(\d+)/);
        if (match && match[1]) {
            return match[1];
        }

        if (/^\d+$/.test(url)) {
            return url;
        }

        return null;
    } catch (e) {
        if (/^\d+$/.test(url)) {
            return url;
        }
        return null;
    }
}

/**
 * Fetch existing normalized post IDs and temporary IDs for a group to cache in memory.
 * Automatically migrates older rows in Supabase to set facebook_post_id if missing.
 */
async function getExistingPermalinksForGroup(groupUrl, groupName, groupId) {
    const existingFacebookPostIds = new Set();
    const existingTemporaryIds = new Set();
    let supabaseRowsCount = 0;

    // Load from Supabase
    if (supabase) {
        try {
            const { data, error } = await supabase
                .from("posts")
                .select("id, permalink, temporary_id, facebook_post_id, group_url")
                .ilike("group_url", `%${groupId}%`);

            if (error) {
                console.error(`❌ Error fetching existing posts from Supabase for group ${groupName}:`, error.message);
            } else if (data) {
                supabaseRowsCount = data.length;
                for (const row of data) {
                    let fbId = row.facebook_post_id;
                    if (!fbId && row.permalink) {
                        fbId = normalizeFacebookPostId(row.permalink);
                        if (fbId) {
                            await supabase.from("posts").update({ facebook_post_id: fbId }).eq("id", row.id).catch(() => { });
                        }
                    }
                    if (!fbId && row.id) {
                        fbId = normalizeFacebookPostId(row.id);
                    }
                    if (fbId) {
                        existingFacebookPostIds.add(fbId);
                    }
                    if (row.temporary_id) {
                        existingTemporaryIds.add(row.temporary_id);
                    } else if (row.id && !row.id.startsWith("https://") && !/^\d+$/.test(row.id)) {
                        existingTemporaryIds.add(row.id);
                    }
                }
            }
        } catch (err) {
            console.error(`❌ Unexpected error fetching existing posts from Supabase:`, err.message);
        }
    }

    console.log(`Loaded existing posts:\n${supabaseRowsCount}\n`);
    console.log(`existingPostIds:\n${existingFacebookPostIds.size}\n`);
    console.log(`existingTemporaryIds:\n${existingTemporaryIds.size}\n`);

    return { existingFacebookPostIds, existingTemporaryIds };
}

/**
 * Upload an image buffer to Supabase Storage 'images' bucket.
 */
async function uploadImageToSupabase(fileBuffer, storagePath, contentType = 'image/jpeg') {
    if (!supabase) return null;
    try {
        if (!fileBuffer) return null;

        const { data, error } = await supabase.storage
            .from("images")
            .upload(storagePath, fileBuffer, {
                contentType,
                upsert: true
            });

        if (error) {
            console.error(`❌ Supabase Storage upload error for ${storagePath}:`, error.message);
            return { error };
        }

        const { data: { publicUrl } } = supabase.storage
            .from("images")
            .getPublicUrl(storagePath);

        return { publicUrl, storagePath };
    } catch (err) {
        console.error(`❌ Unexpected Storage upload error:`, err.message);
        return { error: err };
    }
}

/**
 * Upload a video buffer to Supabase Storage 'videos' bucket.
 */
async function uploadVideoToSupabase(fileBuffer, storagePath, contentType = 'video/mp4') {
    if (!supabase) return null;
    try {
        if (!fileBuffer) return null;

        const { data, error } = await supabase.storage
            .from("videos")
            .upload(storagePath, fileBuffer, {
                contentType,
                upsert: true
            });

        if (error) {
            console.error(`❌ Supabase Storage video upload error for ${storagePath}:`, error.message);
            return { error };
        }

        const { data: { publicUrl } } = supabase.storage
            .from("videos")
            .getPublicUrl(storagePath);

        return { publicUrl, storagePath };
    } catch (err) {
        console.error(`❌ Unexpected Storage video upload error:`, err.message);
        return { error: err };
    }
}

/**
 * Remove an uploaded image from Supabase Storage (used for rollback).
 */
async function deleteImageFromSupabase(storagePath) {
    if (!supabase || !storagePath) return;
    try {
        await supabase.storage.from("images").remove([storagePath]);
    } catch (err) {
        console.error(`❌ Error rolling back storage file ${storagePath}:`, err.message);
    }
}

/**
 * Update an existing temporary post record with its newly discovered permalink and facebook_post_id.
 */
async function updatePostPermalinkInSupabase(temporaryId, newPermalink, facebookPostId) {
    if (!supabase || !temporaryId || !newPermalink) return { error: null };
    try {
        const { data, error } = await supabase
            .from("posts")
            .update({
                id: newPermalink,
                permalink: newPermalink,
                facebook_post_id: facebookPostId,
                needs_permalink: false
            })
            .eq("temporary_id", temporaryId);

        if (error) {
            console.error(`❌ Supabase Update Permalink Error:`, error.message);
            return { error };
        }
        return { data };
    } catch (err) {
        console.error(`❌ Unexpected Supabase Update Error:`, err.message);
        return { error: err };
    }
}

/**
 * Upsert a post or array of posts into the Supabase 'posts' table.
 */
async function upsertPostToSupabase(posts) {
    if (!supabase || !posts) return null;

    const postsArray = Array.isArray(posts) ? posts : [posts];
    if (postsArray.length === 0) return null;

    try {
        for (const post of postsArray) {
            if (post.permalink && post.temporary_id) {
                const { data: tempRecords } = await supabase
                    .from("posts")
                    .select("id, temporary_id")
                    .eq("temporary_id", post.temporary_id)
                    .is("permalink", null);

                if (tempRecords && tempRecords.length > 0) {
                    for (const temp of tempRecords) {
                        const updatePayload = {
                            id: post.permalink,
                            permalink: post.permalink,
                            facebook_post_id: post.facebook_post_id,
                            needs_permalink: false,
                            body: post.body,
                            likes: post.likes,
                            comments: post.comments,
                            shares: post.shares,
                            reaction_count: post.reaction_count,
                            comment_count: post.comment_count,
                            share_count: post.share_count,
                            reaction_breakdown: post.reaction_breakdown,
                            comments_disabled: post.comments_disabled,
                            images: post.images,
                            image_count: post.image_count,
                            video_urls: post.video_urls,
                            video_thumbnail: post.video_thumbnail,
                            video_duration: post.video_duration,
                            video_count: post.video_count,
                            has_video: post.has_video,
                            post_type: post.post_type,
                            author_avatar: post.author_avatar,
                            author_profile_url: post.author_profile_url,
                            post_url: post.post_url,
                            post_created_at: post.post_created_at,
                            post_time_text: post.post_time_text,
                            facebook_post_datetime: post.facebook_post_datetime,
                            facebook_post_time_text: post.facebook_post_time_text,
                            facebook_time_source: post.facebook_time_source,
                            scraped_at: post.scraped_at,
                            facebook_video_url: post.facebook_video_url
                        };
                        
                        let updateRes = await supabase
                            .from("posts")
                            .update(updatePayload)
                            .eq("id", temp.id);
                            
                        if (updateRes.error && (updateRes.error.message.includes("schema cache") || updateRes.error.message.includes("Could not find the"))) {
                            if (updateRes.error.message.includes("facebook_video_url")) delete updatePayload.facebook_video_url;
                            if (updateRes.error.message.includes("facebook_post_datetime")) delete updatePayload.facebook_post_datetime;
                            if (updateRes.error.message.includes("facebook_post_time_text")) delete updatePayload.facebook_post_time_text;
                            if (updateRes.error.message.includes("facebook_time_source")) delete updatePayload.facebook_time_source;
                            if (updateRes.error.message.includes("images")) {
                                console.warn(`\n⚠️  WARNING: The 'images' column is missing in your Supabase database!`);
                                delete updatePayload.images;
                            }
                            
                            updateRes = await supabase
                                .from("posts")
                                .update(updatePayload)
                                .eq("id", temp.id);
                        }
                    }
                }
            }
            
            // Auto-heal missing IDs: If the scraper failed to extract a permalink this run
            // but the post already exists in the DB (by temporary_id), we MUST inherit the 
            // existing row's true `id` and `permalink` so the upsert updates it instead of violating constraints.
            if (!post.facebook_post_id && post.temporary_id) {
                const { data: existing } = await supabase
                    .from("posts")
                    .select("id, facebook_post_id, permalink")
                    .eq("temporary_id", post.temporary_id)
                    .maybeSingle();
                
                if (existing) {
                    post.id = existing.id;
                    if (existing.permalink && !post.permalink) {
                        post.permalink = existing.permalink;
                    }
                    if (existing.facebook_post_id && !post.facebook_post_id) {
                        post.facebook_post_id = existing.facebook_post_id;
                    }
                }
            }
        }

        const cleanPosts = postsArray.map(post => ({
            id: post.id,
            group_name: post.group_name,
            group_url: post.group_url,
            group_id: post.group_id,
            author: post.author,
            author_profile_url: post.author_profile_url,
            author_avatar: post.author_avatar,
            body: post.body,
            post_date: post.post_date,
            post_created_at: post.post_created_at,
            post_time_text: post.post_time_text,
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
            images: post.images,
            image_count: post.image_count,
            video_urls: post.video_urls,
            video_thumbnail: post.video_thumbnail,
            video_duration: post.video_duration,
            video_count: post.video_count,
            has_video: post.has_video,
            post_type: post.post_type,
            scraped_at: post.scraped_at,
            temporary_id: post.temporary_id,
            needs_permalink: post.needs_permalink,
            facebook_post_id: post.facebook_post_id,
            facebook_video_url: post.facebook_video_url,
            facebook_post_datetime: post.facebook_post_datetime,
            facebook_post_time_text: post.facebook_post_time_text,
            facebook_time_source: post.facebook_time_source
        }));

        let { data, error } = await supabase
            .from("posts")
            .upsert(cleanPosts, {
                onConflict: "id",
                ignoreDuplicates: false
            });

        if (error && (error.message.includes("schema cache") || error.message.includes("Could not find the"))) {
            if (error.message.includes("facebook_video_url")) {
                console.warn(`\n⚠️  WARNING: The 'facebook_video_url' column is missing in your Supabase database!`);
                console.warn(`⚠️  ALTER TABLE posts ADD COLUMN IF NOT EXISTS facebook_video_url TEXT;`);
            }
            if (error.message.includes("facebook_post_datetime")) {
                console.warn(`\n⚠️  WARNING: The 'facebook_post_datetime' column is missing in your Supabase database!`);
                console.warn(`⚠️  ALTER TABLE posts ADD COLUMN IF NOT EXISTS facebook_post_datetime TIMESTAMPTZ;`);
                console.warn(`⚠️  ALTER TABLE posts ADD COLUMN IF NOT EXISTS facebook_post_time_text TEXT;`);
                console.warn(`⚠️  ALTER TABLE posts ADD COLUMN IF NOT EXISTS facebook_time_source TEXT;`);
            }
            if (error.message.includes("images")) {
                console.warn(`\n⚠️  CRITICAL WARNING: The 'images' column is missing in your Supabase database!`);
                console.warn(`⚠️  Images will NOT be saved until you add this column!`);
            }
            console.warn(`⚠️  Retrying upload without the missing columns to prevent crashing...\n`);
            
            const fallbackPosts = cleanPosts.map(p => {
                const copy = { ...p };
                if (error.message.includes("facebook_video_url")) delete copy.facebook_video_url;
                if (error.message.includes("facebook_post_datetime")) {
                    delete copy.facebook_post_datetime;
                    delete copy.facebook_post_time_text;
                    delete copy.facebook_time_source;
                }
                if (error.message.includes("images")) delete copy.images;
                return copy;
            });
            
            const fallbackRes = await supabase
                .from("posts")
                .upsert(fallbackPosts, {
                    onConflict: "id",
                    ignoreDuplicates: false
                });
                
            data = fallbackRes.data;
            error = fallbackRes.error;
        }

        if (error) {
            console.error(`❌ Supabase Upsert Error:`, error.message);
            return { error };
        }

        return { data };
    } catch (err) {
        console.error(`❌ Unexpected Supabase Error:`, err.message);
        return { error: err };
    }
}

/**
 * Delete a post from Supabase (used for rollback).
 */
async function deletePostFromSupabase(postId) {
    if (!supabase || !postId) return;
    try {
        await supabase.from("posts").delete().eq("id", postId);
    } catch (err) {
        console.error(`❌ Error rolling back post ${postId}:`, err.message);
    }
}

// ===== VIDEO EXTRACTION IMPROVEMENT =====
async function getPostStatusInSupabase(groupId, facebookPostId, temporaryId) {
    if (!supabase) return null;
    try {
        let query = supabase.from("posts").select("id, video_urls, has_video, image_urls, body").eq("group_id", groupId);
        
        if (facebookPostId) {
            query = query.eq("facebook_post_id", facebookPostId);
        } else if (temporaryId) {
            query = query.eq("temporary_id", temporaryId);
        } else {
            return null;
        }
        
        const { data, error } = await query.limit(1);
        if (!error && data && data.length > 0) {
            return data[0];
        }
        return null;
    } catch (err) {
        return null;
    }
}

async function checkDuplicateInSupabase(groupId, facebookPostId, postUrl, temporaryId) {
    if (!supabase) return false;
    try {
        if (facebookPostId) {
            const { data, error } = await supabase
                .from("posts")
                .select("facebook_post_id")
                .eq("group_id", groupId)
                .eq("facebook_post_id", facebookPostId)
                .limit(1);
            if (!error && data && data.length > 0) return true;
        }
        
        if (postUrl) {
            const { data, error } = await supabase
                .from("posts")
                .select("post_url")
                .eq("group_id", groupId)
                .eq("post_url", postUrl)
                .limit(1);
            if (!error && data && data.length > 0) return true;
            
            // Also check 'permalink' column just in case since they both represent the URL
            const { data: permData, error: permError } = await supabase
                .from("posts")
                .select("permalink")
                .eq("group_id", groupId)
                .eq("permalink", postUrl)
                .limit(1);
            if (!permError && permData && permData.length > 0) return true;
        }
        
        if (temporaryId) {
            const { data, error } = await supabase
                .from("posts")
                .select("temporary_id")
                .eq("group_id", groupId)
                .eq("temporary_id", temporaryId)
                .limit(1);
            if (!error && data && data.length > 0) return true;
        }
        return false;
    } catch (err) {
        return false;
    }
}

module.exports = {
    supabase,
    upsertPostToSupabase,
    updatePostPermalinkInSupabase,
    deletePostFromSupabase,
    getExistingPermalinksForGroup,
    normalizeFacebookPostId,
    checkDuplicateInSupabase,
    getPostStatusInSupabase
};
