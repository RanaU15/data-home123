require("dotenv").config();
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
                            await supabase.from("posts").update({ facebook_post_id: fbId }).eq("id", row.id).catch(() => {});
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
 * Upload a local image to Supabase Storage 'images' bucket.
 */
async function uploadImageToSupabase(localPath, storagePath, contentType = 'image/jpeg') {
    if (!supabase) return null;
    try {
        if (!fs.existsSync(localPath)) return null;
        const fileBuffer = fs.readFileSync(localPath);

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
                temporary_id: null,
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
                        await supabase
                            .from("posts")
                            .update({
                                id: post.permalink,
                                permalink: post.permalink,
                                facebook_post_id: post.facebook_post_id,
                                temporary_id: null,
                                needs_permalink: false,
                                body: post.body,
                                likes: post.likes,
                                comments: post.comments,
                                shares: post.shares,
                                screenshot: post.screenshot,
                                images: post.images,
                                scraped_at: post.scraped_at
                            })
                            .eq("id", temp.id);
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
            body: post.body,
            post_date: post.post_date,
            permalink: post.permalink,
            likes: post.likes,
            comments: post.comments,
            shares: post.shares,
            screenshot: post.screenshot,
            images: post.images,
            scraped_at: post.scraped_at,
            temporary_id: post.temporary_id,
            needs_permalink: post.needs_permalink,
            facebook_post_id: post.facebook_post_id
        }));

        const { data, error } = await supabase
            .from("posts")
            .upsert(cleanPosts, {
                onConflict: "id",
                ignoreDuplicates: true
            });

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

async function checkDuplicateInSupabase(groupId, facebookPostId, temporaryId) {
    if (!supabase) return false;
    try {
        if (facebookPostId) {
            const { data, error } = await supabase
                .from("posts")
                .select("facebook_post_id")
                .eq("group_id", groupId)
                .eq("facebook_post_id", facebookPostId)
                .limit(1);
            if (!error && data && data.length > 0) {
                return true;
            }
        } else if (temporaryId) {
            const { data, error } = await supabase
                .from("posts")
                .select("temporary_id")
                .eq("group_id", groupId)
                .eq("temporary_id", temporaryId)
                .limit(1);
            if (!error && data && data.length > 0) {
                return true;
            }
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
    uploadImageToSupabase,
    deleteImageFromSupabase,
    normalizeFacebookPostId,
    checkDuplicateInSupabase
};
