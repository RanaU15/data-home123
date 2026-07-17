// backfillLast6Months.js
// Standalone historical backfill — does NOT touch scraper.js.
// Reuses the same extractors.js / supabase.js / auth.js modules as the live scraper,
// so extraction logic and the posts table shape stay identical.
//
// Usage:
//   node backfillLast6Months.js                 (all groups)
//   node backfillLast6Months.js --group=0        (single group, 0-indexed into GROUPS below)
//
// TEMP DEBUG BUILD: includes [DEBUG] logging to diagnose why feedCards.count()
// may be returning 0. Remove the two [DEBUG] blocks once confirmed working.

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const crypto = require("crypto");

const {
    supabase,
    upsertPostToSupabase,
    getExistingPermalinksForGroup,
    normalizeFacebookPostId,
    checkDuplicateInSupabase
} = require("./supabase");

const auth = require("./auth");

const {
    cleanPermalink,
    extractPlayableVideoUrl,
    extractMetadata
} = require("./extractors");

const GROUPS = [
    { name: "Group 658561818123997", url: "https://www.facebook.com/groups/658561818123997/" },
    { name: "Group 644861357496091", url: "https://www.facebook.com/groups/644861357496091/" },
    { name: "Group 511463069896512", url: "https://www.facebook.com/groups/511463069896512/" },
    { name: "Flats and Flatmates Ahmedabad", url: "https://www.facebook.com/groups/FlatsandFlatmatesAhmedabadGroup/" }
];

const MAX_SCROLLS_SAFETY = 3000;
const SIX_MONTHS_AGO = (() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 6);
    return d;
})();

console.log(`Backfill cutoff (6 months ago): ${SIX_MONTHS_AGO.toISOString()}`);

const args = process.argv.slice(2);
let selectedGroupIndex = null;
for (const arg of args) {
    if (arg.startsWith("--group=")) selectedGroupIndex = parseInt(arg.split("=")[1], 10);
}

const delay = (ms) => new Promise((res) => setTimeout(res, ms));
const jitter = (min, max) => Math.floor(Math.random() * (max - min + 1) + min);

function parseFacebookTimestamp(tsText) {
    if (!tsText) return null;
    const text = tsText.toLowerCase().trim();
    const now = new Date();

    if (text.includes("just now")) return now;

    let m = text.match(/^(\d+)\s*m/);
    if (m) return new Date(now.getTime() - parseInt(m[1]) * 60000);

    m = text.match(/^(\d+)\s*h/);
    if (m) return new Date(now.getTime() - parseInt(m[1]) * 3600000);

    m = text.match(/^(\d+)\s*d/);
    if (m) return new Date(now.getTime() - parseInt(m[1]) * 86400000);

    if (text.includes("yesterday")) {
        const d = new Date(now.getTime() - 86400000);
        const timeMatch = text.match(/at\s+(\d+):(\d+)\s*(am|pm)/);
        if (timeMatch) {
            let hours = parseInt(timeMatch[1]);
            if (timeMatch[3] === "pm" && hours < 12) hours += 12;
            if (timeMatch[3] === "am" && hours === 12) hours = 0;
            d.setHours(hours, parseInt(timeMatch[2]), 0, 0);
        }
        return d;
    }

    const parseable = text.replace(" at ", " ");
    const parsed = new Date(parseable);
    if (!isNaN(parsed.getTime())) {
        if (parsed > now) parsed.setFullYear(parsed.getFullYear() - 1);
        return parsed;
    }

    return null;
}

function isNonPostCard(trimText) {
    if (!trimText || trimText.length < 20) return true;
    if (/^(sort group feed by|Filters|Write something|Create post)/i.test(trimText)) return true;
    if (/^(Facebook\s+){3,}/i.test(trimText)) return true;
    if (trimText.includes("Suggested for you") || trimText.includes("People you may know") ||
        trimText.includes("Sponsored") || trimText.includes("Group recommendations")) return true;
    return false;
}

async function ensureGroupSyncTable() {
    // Run once in Supabase:
    // create table if not exists group_sync_6mo (
    //   group_id text primary key,
    //   completed boolean default false,
    //   posts_inserted int default 0,
    //   duplicates_skipped int default 0,
    //   oldest_reached timestamptz,
    //   updated_at timestamptz default now()
    // );
}

async function saveCheckpoint(groupId, updates, retries = 3) {
    for (let i = 0; i < retries; i++) {
        const { error } = await supabase
            .from("group_sync_6mo")
            .upsert({ group_id: groupId, ...updates, updated_at: new Date().toISOString() });
        if (!error) return true;
        console.error(`Checkpoint save failed for ${groupId}, retry ${i + 1}/${retries}:`, error.message);
        await delay(2000);
    }
    return false;
}

async function backfillGroup(group, groupIndex, totalGroups, page, context) {
    const match = group.url.match(/groups\/([^\/]+)/);
    const groupId = match ? match[1] : String(groupIndex);

    console.log(`\n====================================`);
    console.log(`Group ${groupIndex + 1}/${totalGroups}: ${group.name} (${groupId})`);

    const { data: syncRow } = await supabase
        .from("group_sync_6mo")
        .select("*")
        .eq("group_id", groupId)
        .single();

    if (syncRow && syncRow.completed) {
        console.log(`Already completed for this group — skipping.`);
        return;
    }

    await page.goto(group.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    console.log("DOM loaded");

    try {
        await page.waitForSelector('div[role="feed"]', { timeout: 30000 });
    } catch (e) {
        console.log("Feed selector not found within timeout — reloading once.");
        await page.reload({ waitUntil: "domcontentloaded" }).catch(() => { });
        await page.waitForSelector('div[role="feed"]', { timeout: 30000 }).catch(() => { });
    }
    await delay(jitter(2500, 4500));

    const { existingFacebookPostIds, existingTemporaryIds } = await getExistingPermalinksForGroup(
        group.url,
        group.name,
        groupId
    );

    let postsInserted = syncRow?.posts_inserted || 0;
    let duplicatesSkipped = syncRow?.duplicates_skipped || 0;
    let postsSeenTotal = 0;
    let nextPauseThreshold = 500;

    let processedCardIds = new Set();
    let scrapedThisRun = new Set();
    let emptyScrolls = 0;
    let scrollCount = 0;
    let oldestSeenDate = new Date();
    let stopGroup = false;

    let lastLogTime = Date.now();
    const startTime = Date.now();

    while (!stopGroup && scrollCount < MAX_SCROLLS_SAFETY) {
        if (page.isClosed()) break;

        // --- FIX: multi-selector fallback, same pattern as scraper.js ---
        let feedCards = page.locator('div[role="feed"] > div');
        let count = await feedCards.count().catch(() => 0);
        let selectorUsed = 'div[role="feed"] > div';

        if (count === 0) {
            feedCards = page.locator('[data-pagelet="GroupFeed"] > div > div');
            count = await feedCards.count().catch(() => 0);
            selectorUsed = '[data-pagelet="GroupFeed"] > div > div';
        }
        if (count === 0) {
            feedCards = page.locator('div[data-testid="Keycommand_wrapper"]');
            count = await feedCards.count().catch(() => 0);
            selectorUsed = 'div[data-testid="Keycommand_wrapper"]';
        }

        // --- [DEBUG] block 1: remove once confirmed working ---
        if (scrollCount % 3 === 0) {
            console.log(`[DEBUG] selector="${selectorUsed}" feedCards.count() = ${count}`);
            if (count > 0) {
                const sample = await feedCards.nth(0).innerText().catch(() => "");
                console.log(`[DEBUG] first card sample text: "${sample.slice(0, 80).replace(/\n/g, ' ')}"`);
            } else {
                console.log(`[DEBUG] Zero cards found with ANY selector. Current URL: ${page.url()}`);
            }
        }
        // --- end [DEBUG] block 1 ---

        let foundNewCards = false;

        for (let i = 0; i < count; i++) {
            const card = feedCards.nth(i);

            let fullText = await card.innerText().catch(() => "");
            let trimText = fullText.trim();

            if (!trimText || trimText.length < 20) {
                await card.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => { });
                await delay(500);
                fullText = await card.innerText().catch(() => "");
                trimText = fullText.trim();
            }

            const cardId = trimText.length + "_" + trimText.slice(0, 40);
            if (processedCardIds.has(cardId)) continue;
            processedCardIds.add(cardId);
            foundNewCards = true;

            if (isNonPostCard(trimText)) {
                // --- [DEBUG] block 2: remove once confirmed working ---
                if (scrollCount % 3 === 0) {
                    console.log(`[DEBUG] Filtered as non-post: "${trimText.slice(0, 50).replace(/\n/g, ' ')}"`);
                }
                // --- end [DEBUG] block 2 ---
                continue;
            }

            postsSeenTotal++;

            let data = await extractMetadata(card, "");
            if (!data || !data.permalinkObj) {
                for (const ms of [250, 250, 500]) {
                    await delay(ms);
                    data = await extractMetadata(card, "");
                    if (data && data.permalinkObj) break;
                }
            }
            if (!data || !data.permalinkObj) {
                console.log("Skipped: no permalink found after retries.");
                continue;
            }

            const rawPermalink = data.permalinkObj.url;
            let permalink = cleanPermalink(rawPermalink);
            let facebookPostId = normalizeFacebookPostId(permalink);

            const urlType = data.permalinkObj.type || "UNKNOWN";
            if (rawPermalink && (urlType === "PHOTO" || urlType === "UNKNOWN")) {
                try {
                    const tempPage = await context.newPage();
                    await tempPage.goto(rawPermalink, { waitUntil: "domcontentloaded", timeout: 15000 });
                    const canonicalUrl = await tempPage.evaluate(() => {
                        const og = document.querySelector('meta[property="og:url"]');
                        if (og && og.content) return og.content;
                        const link = document.querySelector('link[rel="canonical"]');
                        return link ? link.href : null;
                    });
                    if (canonicalUrl && !canonicalUrl.includes("photo.php") && !canonicalUrl.includes("photo/?")) {
                        permalink = cleanPermalink(canonicalUrl);
                        facebookPostId = normalizeFacebookPostId(permalink);
                    }
                    await tempPage.close();
                } catch (e) { }
            }

            const postDate = parseFacebookTimestamp(data.permalinkObj.timestamp);
            if (postDate && postDate < oldestSeenDate) oldestSeenDate = postDate;

            const normalizedAuthor = (data.author || "Unknown Author").toLowerCase().trim();
            const normalizedBody = (data.bodyText || "").toLowerCase().replace(/\s+/g, " ").trim();
            const temporaryId = crypto
                .createHash("sha256")
                .update(groupId + normalizedAuthor + normalizedBody)
                .digest("hex");

            if (!permalink) permalink = temporaryId;

            if ((facebookPostId && scrapedThisRun.has(facebookPostId)) || scrapedThisRun.has(temporaryId)) {
                continue;
            }

            let hasPerm = facebookPostId ? existingFacebookPostIds.has(facebookPostId) : false;
            if (facebookPostId && !hasPerm) {
                hasPerm = await checkDuplicateInSupabase(groupId, facebookPostId, null, null);
                if (hasPerm) existingFacebookPostIds.add(facebookPostId);
            }
            const hasTemp = existingTemporaryIds.has(temporaryId);

            if (hasPerm || hasTemp) {
                duplicatesSkipped++;
                scrapedThisRun.add(facebookPostId || temporaryId);
                scrapedThisRun.add(temporaryId);
                continue;
            }

            let videoUrls = data.video_urls ? [...data.video_urls] : [];
            if (data.has_video && videoUrls.length === 0 && permalink) {
                const extracted = await extractPlayableVideoUrl(context, permalink);
                if (extracted.length > 0) videoUrls = extracted;
            }
            if (videoUrls.length === 0 && data.video_thumbnail) videoUrls = [data.video_thumbnail];

            const postObj = {
                id: permalink,
                group_name: group.name,
                group_url: group.url,
                group_id: groupId,
                author: data.author,
                author_profile_url: data.author_profile_url,
                author_avatar: data.author_avatar,
                body: data.bodyText,
                permalink: permalink.startsWith("http") ? permalink : null,
                post_url: permalink.startsWith("http") ? permalink : null,
                likes: data.likes || 0,
                comments: data.comments || 0,
                shares: data.shares || 0,
                reaction_count: data.likes || 0,
                comment_count: data.comments || 0,
                share_count: data.shares || 0,
                image_urls: data.images || [],
                image_count: data.images ? data.images.length : 0,
                video_urls: videoUrls,
                video_thumbnail: data.video_thumbnail || null,
                video_count: data.video_count || 0,
                has_video: data.has_video || false,
                post_type: data.post_type || "text",
                reaction_breakdown: data.reaction_breakdown || {},
                comments_disabled: data.comments_disabled || false,
                scraped_at: new Date().toISOString(),
                post_date_iso: (postDate || new Date()).toISOString(),
                temporary_id: facebookPostId ? null : temporaryId,
                needs_permalink: !facebookPostId,
                facebook_post_id: facebookPostId
            };

            try {
                const { error } = await upsertPostToSupabase(postObj);
                if (error) throw new Error(error.message);
                postsInserted++;
                if (facebookPostId) {
                    existingFacebookPostIds.add(facebookPostId);
                    scrapedThisRun.add(facebookPostId);
                }
                existingTemporaryIds.add(temporaryId);
                scrapedThisRun.add(temporaryId);
                console.log(`Inserted: "${(data.bodyText || "").slice(0, 60).replace(/\n/g, " ")}" — ${postObj.post_date_iso}`);
            } catch (err) {
                console.error(`Insert failed for ${postObj.id}:`, err.message);
            }
        }

        if (oldestSeenDate < SIX_MONTHS_AGO) {
            console.log(`Reached cutoff — oldest seen (${oldestSeenDate.toISOString()}) is before 6-month mark.`);
            stopGroup = true;
            break;
        }

        if (!foundNewCards) {
            emptyScrolls++;
            if (emptyScrolls >= 5) {
                console.log("Stalled — no new cards after 5 retries. Ending this group (may not have reached full 6 months).");
                break;
            }
        } else {
            emptyScrolls = 0;
        }

        await delay(jitter(2000, 4000));
        await page.mouse.wheel(0, jitter(2500, 4500));
        await delay(jitter(2500, 4500));
        scrollCount++;

        if (postsSeenTotal >= nextPauseThreshold) {
            await saveCheckpoint(groupId, {
                posts_inserted: postsInserted,
                duplicates_skipped: duplicatesSkipped,
                oldest_reached: oldestSeenDate.toISOString(),
                completed: false
            });
            const pauseMs = jitter(45000, 90000);
            console.log(`Checkpoint saved. Human-like pause: ${Math.round(pauseMs / 1000)}s (seen ${postsSeenTotal} posts so far)...`);
            await delay(pauseMs);
            nextPauseThreshold += 500;
        }

        if (Date.now() - lastLogTime > 30000) {
            lastLogTime = Date.now();
            console.log(`\n--- Status: ${group.name} ---`);
            console.log(`Scroll: ${scrollCount} | Seen: ${postsSeenTotal} | Inserted: ${postsInserted} | Duplicates: ${duplicatesSkipped}`);
            console.log(`Oldest seen so far: ${oldestSeenDate.toISOString()} (target: ${SIX_MONTHS_AGO.toISOString()})`);
            console.log(`---------------------------\n`);
        }
    }

    await saveCheckpoint(groupId, {
        posts_inserted: postsInserted,
        duplicates_skipped: duplicatesSkipped,
        oldest_reached: oldestSeenDate.toISOString(),
        completed: true
    });

    const runtimeMin = Math.round((Date.now() - startTime) / 60000);
    console.log(`\n==== ${group.name} DONE ====`);
    console.log(`Inserted: ${postsInserted} | Duplicates skipped: ${duplicatesSkipped} | Runtime: ${runtimeMin} min`);
    console.log(`Oldest date reached: ${oldestSeenDate.toISOString()}`);
    console.log(`=============================\n`);
}

async function run() {
    await ensureGroupSyncTable();
    await auth.launchBrowser();
    await auth.ensureLoggedIn();

    const context = auth.getContext();
    const page = auth.getPage();

    const groupsToRun = selectedGroupIndex !== null ? [GROUPS[selectedGroupIndex]] : GROUPS;

    for (let idx = 0; idx < groupsToRun.length; idx++) {
        const group = groupsToRun[idx];
        if (!group) {
            console.error(`Invalid --group index.`);
            continue;
        }
        try {
            await backfillGroup(group, selectedGroupIndex !== null ? selectedGroupIndex : idx, GROUPS.length, page, context);
        } catch (err) {
            console.error(`Fatal error on group ${group.name}:`, err);
        }
    }

    await auth.close();
    console.log("\nAll requested groups processed. Backfill run complete.");
    process.exit(0);
}

run().catch(async (e) => {
    console.error("Fatal top-level error:", e);
    await auth.close().catch(() => { });
    process.exit(1);
});