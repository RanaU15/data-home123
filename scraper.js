const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const crypto = require("crypto");
const {
    supabase,
    upsertPostToSupabase,
    updatePostPermalinkInSupabase,
    deletePostFromSupabase,
    getExistingPermalinksForGroup,
    uploadImageToSupabase,
    deleteImageFromSupabase,
    normalizeFacebookPostId,
    checkDuplicateInSupabase
} = require("./supabase");

// Configuration for Multiple Groups
const GROUPS = [
    {
        name: "Group 658561818123997",
        url: "https://www.facebook.com/groups/658561818123997/"
    },
    {
        name: "Group 644861357496091",
        url: "https://www.facebook.com/groups/644861357496091/"
    },
    {
        name: "Group 511463069896512",
        url: "https://www.facebook.com/groups/511463069896512/"
    },
    {
        name: "Flats and Flatmates Ahmedabad",
        url: "https://www.facebook.com/groups/FlatsandFlatmatesAhmedabadGroup/"
    }
];

const SESSION_FILE = path.join(__dirname, "facebook-session.json");
const JSON_FILE = path.join(__dirname, "posts.json");
const CSV_FILE = path.join(__dirname, "posts.csv");
const STATUS_FILE = path.join(__dirname, "status.json");
const IMAGES_DIR = path.join(__dirname, "images");
const MAX_SCROLL_COUNT = 25;

if (!fs.existsSync(IMAGES_DIR)) {
    fs.mkdirSync(IMAGES_DIR);
}

// Global browser state to keep browser alive across scheduled runs
let browser = null;
let context = null;
let page = null;
let isScraping = false;
let isShuttingDown = false;

let globalAllPostsData = [];

// Global Health Monitoring Stats
let healthStatus = {
    running: false,
    last_run: null,
    next_run: null,
    runtime_seconds: 0,
    groups_processed: 0,
    posts_added: 0,
    duplicates_skipped: 0,
    old_posts: 0,
    temporary_ids: 0,
    permalinks_found: 0,
    storage_uploads: 0,
    last_error: null
};

// Update and write status.json helper
function updateHealthStatus(updates) {
    healthStatus = { ...healthStatus, ...updates };
    try {
        fs.writeFileSync(STATUS_FILE, JSON.stringify(healthStatus, null, 2));
    } catch (err) { }
}

// Helper function to download images
function download(url, filename) {
    return new Promise((resolve) => {
        const client = url.startsWith("https") ? https : http;
        client.get(url, res => {
            if (res.statusCode !== 200) {
                res.resume();
                return resolve(false);
            }
            const file = fs.createWriteStream(filename);
            res.pipe(file);
            file.on("finish", () => {
                file.close();
                resolve(true);
            });
            file.on("error", () => {
                file.close();
                resolve(false);
            });
        }).on("error", () => {
            resolve(false);
        });
    });
}

// Clean and normalize permalinks by removing tracking parameters
function cleanPermalink(url) {
    if (!url) return null;
    try {
        const parsed = new URL(url, "https://www.facebook.com");
        parsed.searchParams.delete("__cft__[0]");
        parsed.searchParams.delete("__cft__");
        parsed.searchParams.delete("__tn__");
        parsed.searchParams.delete("fbclid");
        parsed.searchParams.delete("set");
        parsed.searchParams.delete("type");
        parsed.searchParams.delete("eid");

        if (parsed.pathname.includes("/posts/") || parsed.pathname.includes("/permalink/")) {
            parsed.search = ""; // Strip search entirely for standard post permalinks
        }
        return parsed.toString();
    } catch (e) {
        return url;
    }
}

// Timestamp Detection: Accept ONLY Just now, Xm, X min, X mins, Xh, X hr, X hrs, Today. Reject Yesterday, Xd, Months, Dates, Years
function isTodayPost(timestamp) {
    if (!timestamp) return false;
    const txt = timestamp.toLowerCase().trim();
    if (
        txt.includes("yesterday") ||
        txt.includes("1d") ||
        txt.includes("2d") ||
        txt.includes("3d") ||
        txt.includes("4d") ||
        txt.includes("5d") ||
        txt.includes("6d") ||
        txt.includes("7d") ||
        txt.includes("week") ||
        txt.includes("month") ||
        txt.includes("year") ||
        txt.includes("jan") ||
        txt.includes("feb") ||
        txt.includes("mar") ||
        txt.includes("apr") ||
        txt.includes("may") ||
        txt.includes("jun") ||
        txt.includes("jul") ||
        txt.includes("aug") ||
        txt.includes("sep") ||
        txt.includes("oct") ||
        txt.includes("nov") ||
        txt.includes("dec") ||
        txt.includes("2025") ||
        txt.includes("2026")
    ) {
        return false;
    }
    if (
        txt.includes("just now") ||
        txt.includes("now") ||
        txt.includes("m") ||
        txt.includes("min") ||
        txt.includes("mins") ||
        txt.includes("h") ||
        txt.includes("hr") ||
        txt.includes("hrs") ||
        txt.includes("today")
    ) {
        return true;
    }
    return false;
}

// Initialize or Recreate Browser
async function initBrowser(isRestart = false) {
    if (!fs.existsSync(SESSION_FILE)) {
        console.error(`Session expired.\nRun npm run login.`);
        updateHealthStatus({ running: false, last_error: "Session expired" });
        process.exit(1);
    }

    if (browser && browser.isConnected()) {
        await browser.close().catch(() => { });
    }

    browser = await chromium.launch({ headless: false });
    context = await browser.newContext({ storageState: SESSION_FILE });
    page = await context.newPage();
}

// Verify Facebook Session
async function verifySession() {
    try {
        await page.goto("https://www.facebook.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
        const currentUrl = page.url();
        if (currentUrl.includes("/login") || currentUrl.includes("login.php")) {
            console.error("Session expired. Redirected to login page.");
            updateHealthStatus({ running: false, last_error: "Session expired" });
            process.exit(1);
        }
        return true;
    } catch (err) {
        return false;
    }
}

// SQLite removed completely

// Scrape a single group
async function scrapeGroup(group, groupIndex, totalGroups, targetPage, existingFacebookPostIds, existingTemporaryIds, allPostsData) {
    console.log(`\nGroup ${groupIndex}/${totalGroups}`);

    await targetPage.goto(group.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await targetPage.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
    await targetPage.waitForTimeout(5000);

    let oldPostCount = 0;
    let duplicateCount = 0;
    let scrollCount = 0;
    let previousCount = 0;
    let processedIndex = 0;
    let totalFeedItems = 0;
    let stopGroup = false;
    let noNewItemsCount = 0;
    const scrapedThisRun = new Set();

    const matchGroup = group.url.match(/groups\/([^\/]+)/);
    const groupId = matchGroup ? matchGroup[1] : "";

    while (!stopGroup && scrollCount < MAX_SCROLL_COUNT && !isShuttingDown) {
        if (targetPage.isClosed()) break;

        const feedUnits = targetPage.locator('div[role="feed"] > div');
        const count = await feedUnits.count().catch(() => 0);

        // Better virtual scrolling detection: if feed shrinks or DOM rebuilds, reset processedIndex safely
        if (count < totalFeedItems) {
            processedIndex = 0;
        }
        totalFeedItems = count;

        for (let i = processedIndex; i < count; i++) {
            if (stopGroup || targetPage.isClosed() || isShuttingDown) break;

            const feedUnit = feedUnits.nth(i);

            // Ignore promoted cards, suggestions, sponsored, reels, empty containers
            const fullText = await feedUnit.innerText().catch(() => "");
            if (!fullText || fullText.trim() === "" || fullText.includes("Suggested for you") || fullText.includes("Join Group") || fullText.includes("People you may know") || fullText.includes("Sponsored") || fullText.includes("Reels") || fullText.includes("Group recommendations")) {
                processedIndex = i + 1;
                continue; // Do not increment duplicateCount for non-post items
            }

            const seeMore = feedUnit.locator('div[role="button"]:has-text("See more")').first();
            if (await seeMore.count().catch(() => 0)) {
                await seeMore.click().catch(() => { });
                await targetPage.waitForTimeout(400).catch(() => { });
            }

            // 1. Extract metadata & permalink
            let data = await feedUnit.evaluate((el) => {
                let permalinkObj = null;
                let bestUrl = null;
                let bestTimestamp = "Today";

                // Smarter permalink extraction: check all possible locations
                const links = [...el.querySelectorAll('a[href*="/posts/"], a[href*="/permalink/"], a[href*="/photo.php"], a[href*="/story.php"], a[href*="multi_permalinks="], a[href*="story_fbid="], a[href*="fbid="]')];

                for (const a of links) {
                    const href = a.getAttribute("href") || "";
                    if (!href.includes("/user/") && !href.includes("profile.php") && !href.includes("comment_id") && !href.includes("p.php")) {
                        bestUrl = href;
                        if (a.innerText && a.innerText.trim()) {
                            bestTimestamp = a.innerText.trim();
                        }
                        break;
                    }
                }

                if (!bestUrl) {
                    const dataFtEl = el.querySelector('[data-ft]');
                    if (dataFtEl) {
                        const ft = dataFtEl.getAttribute('data-ft');
                        try {
                            const parsedFt = JSON.parse(ft);
                            if (parsedFt.mf_story_key) bestUrl = `/posts/${parsedFt.mf_story_key}`;
                            else if (parsedFt.top_level_post_id) bestUrl = `/posts/${parsedFt.top_level_post_id}`;
                        } catch (e) { }
                    }
                }

                if (bestUrl) {
                    permalinkObj = { url: bestUrl, timestamp: bestTimestamp };
                }

                const messageEl = el.querySelector('[data-ad-comet-preview="message"], [data-ad-preview="message"]');
                let bodyText = "";
                if (messageEl && messageEl.innerText.trim()) {
                    bodyText = messageEl.innerText.replace(/See translation\n?/g, '').trim();
                } else {
                    const textBlocks = Array.from(el.querySelectorAll('div[dir="auto"]'));
                    for (const block of textBlocks) {
                        const txt = block.innerText || "";
                        if (txt.includes("Like") || txt.includes("Reply") || txt.includes("Share") || txt.includes("Comment") || txt.includes("Send") || txt.includes("Write a comment")) {
                            break;
                        }
                        if (!txt.includes("See translation") && txt.length > 3) {
                            bodyText += txt + "\n";
                        }
                    }
                    bodyText = bodyText.trim();
                }

                let rawAuthor = "Unknown Author";
                const candidates = Array.from(el.querySelectorAll('h2, h3, h4, strong, a[href*="/user/"], a[href*="/profile.php"]'));
                for (const cand of candidates) {
                    const txt = cand.innerText ? cand.innerText.trim() : "";
                    if (txt && txt !== "Facebook" && !txt.includes("Suggested") && !txt.includes("Sponsored")) {
                        rawAuthor = txt;
                        break;
                    }
                }
                const author = rawAuthor
                    .replace(/\bFollow\b|\bFollowing\b/g, '')
                    .replace(/•/g, '')
                    .replace(/·/g, '')
                    .replace(/\n+/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim();

                let likes = 0;
                const reactionElements = [...el.querySelectorAll('[aria-label*="reaction"], [aria-label*="Like"], [aria-label*="superstar"], [role="button"], span.x1e558r4, div.x1n2onr6, svg')];
                for (const item of reactionElements) {
                    const aria = item.getAttribute('aria-label') || "";
                    const txt = (item.innerText || "").trim();
                    if (aria.includes("react") || aria.includes("Like") || aria.includes("superstar")) {
                        const match = aria.match(/\d+/);
                        if (match) {
                            likes = Number(match[0]);
                            if (likes > 0) break;
                        }
                    }
                    if (txt.length > 0 && txt.length < 10 && /^\d+$/.test(txt)) {
                        const num = Number(txt);
                        if (num > 0) {
                            likes = num;
                            break;
                        }
                    }
                }

                let comments = 0;
                let shares = 0;
                const footer = [...el.querySelectorAll('div[role="button"], a, span')];
                for (const item of footer) {
                    const txt = (item.innerText || "").trim();
                    if (/^\d+\s+comments?$/i.test(txt)) {
                        comments = Number(txt.match(/\d+/)[0]);
                    }
                    if (/^\d+\s+shares?$/i.test(txt)) {
                        shares = Number(txt.match(/\d+/)[0]);
                    }
                }

                const videoEl = el.querySelector('video');
                const video = videoEl ? (videoEl.getAttribute('src') || "Embedded Video Present") : "None";

                // Better image filtering: Ignore avatars, profile pictures, cover photos, UI icons, emoji, stickers, spacer images, < 150px
                const imgEls = Array.from(el.querySelectorAll('img'));
                const images = [];
                for (const img of imgEls) {
                    const src = img.getAttribute('src') || "";
                    if (
                        src &&
                        src.startsWith("http") &&
                        !src.includes("rsrc.php") &&
                        !src.includes("emoji") &&
                        !src.includes("avatar") &&
                        !src.includes("sticker") &&
                        !src.includes("p32x32") &&
                        !src.includes("p16x16") &&
                        !src.includes("p50x50") &&
                        !src.includes("s60x60") &&
                        !src.includes("badges") &&
                        !src.includes("profile") &&
                        !src.includes("reaction") &&
                        !src.includes("fb_icon") &&
                        !src.includes("spis_") &&
                        !src.includes("x1bwp2qo") &&
                        !src.includes("spacer") &&
                        !src.includes("cover")
                    ) {
                        const w = img.getAttribute('width');
                        const h = img.getAttribute('height');
                        if ((w && parseInt(w) < 150) || (h && parseInt(h) < 150)) continue;
                        images.push(src);
                    }
                }

                return { permalinkObj, bodyText, author, likes, comments, shares, video, images };
            }).catch(() => null);

            if (!data) {
                console.log("Skipped");
                processedIndex = i + 1;
                continue;
            }

            // Completely skip Facebook feed sorting widgets (Most Relevant, Most recent, New activity, Suggested for you) or empty body
            const checkAuthor = (data.author || "").toLowerCase().trim();
            const checkBody = (data.bodyText || "").trim();
            if (checkAuthor === "most relevant" || checkAuthor === "most recent" || checkAuthor === "new activity" || checkAuthor === "suggested for you") {
                console.log("Skipped fake feed card");
                processedIndex = i + 1;
                continue;
            }
            if (checkBody === "") {
                console.log("Skipped empty card");
                processedIndex = i + 1;
                continue;
            }

            // Immediately check scrapedThisRun to handle virtual scrolling flawlessly without redundant retries
            let tempRawPermalink = data.permalinkObj ? data.permalinkObj.url : null;
            let tempPermalink = cleanPermalink(tempRawPermalink);
            let tempFacebookPostId = normalizeFacebookPostId(tempPermalink);

            let normAuthorInitial = (data.author || "Unknown Author").toLowerCase()
                .replace(/\b(follow|following|admin|moderator|group expert|top contributor|facebook|suggested|sponsored)\b/g, '')
                .replace(/[•·,]/g, '')
                .replace(/\b\d+\s*(m|min|mins|h|hr|hrs|d|day|days|w|week|weeks|mo|month|months|yr|year|years)\b/g, '')
                .replace(/\b(just now|today|yesterday)\b/g, '')
                .replace(/\s+/g, ' ')
                .trim();

            let normBodyInitial = (data.bodyText || "").toLowerCase();
            if (group.name) {
                normBodyInitial = normBodyInitial.replace(new RegExp(group.name.toLowerCase(), 'g'), '');
            }
            if (normAuthorInitial && normAuthorInitial.length > 2) {
                normBodyInitial = normBodyInitial.replace(new RegExp(normAuthorInitial, 'g'), '');
            }
            normBodyInitial = normBodyInitial
                .replace(/\b(see translation|rate this translation|admin|moderator|group expert|top contributor|follow|following|like|comment|share|send|suggested|sponsored)\b/g, '')
                .replace(/[•·]/g, '')
                .replace(/\b\d+\s*(m|min|mins|h|hr|hrs|d|day|days|w|week|weeks|mo|month|months|yr|year|years)\b/g, '')
                .replace(/\b(just now|today|yesterday)\b/g, '')
                .replace(/\s+/g, ' ')
                .trim();

            let stableImgInitial = (data.images || []).map(imgUrl => {
                try {
                    const parsed = new URL(imgUrl);
                    return path.basename(parsed.pathname);
                } catch(e) {
                    return "";
                }
            }).filter(Boolean).sort().join("|");

            let tempTemporaryId = crypto.createHash('sha256').update(groupId + normAuthorInitial + "today" + normBodyInitial + stableImgInitial).digest('hex');

            if ((tempFacebookPostId && scrapedThisRun.has(tempFacebookPostId)) || scrapedThisRun.has(tempTemporaryId)) {
                processedIndex = i + 1;
                continue;
            }

            // 2. Retry permalink extraction (250ms, 250ms, 500ms)
            if (!data || !data.permalinkObj) {
                const delays = [250, 250, 500];
                for (const delay of delays) {
                    await targetPage.waitForTimeout(delay).catch(() => { });
                    data = await feedUnit.evaluate((el) => {
                        let permalinkObj = null;
                        let bestUrl = null;
                        let bestTimestamp = "Today";

                        const links = [...el.querySelectorAll('a[href*="/posts/"], a[href*="/permalink/"], a[href*="/photo.php"], a[href*="/story.php"], a[href*="multi_permalinks="], a[href*="story_fbid="], a[href*="fbid="]')];

                        for (const a of links) {
                            const href = a.getAttribute("href") || "";
                            if (!href.includes("/user/") && !href.includes("profile.php") && !href.includes("comment_id") && !href.includes("p.php")) {
                                bestUrl = href;
                                if (a.innerText && a.innerText.trim()) {
                                    bestTimestamp = a.innerText.trim();
                                }
                                break;
                            }
                        }

                        if (!bestUrl) {
                            const dataFtEl = el.querySelector('[data-ft]');
                            if (dataFtEl) {
                                const ft = dataFtEl.getAttribute('data-ft');
                                try {
                                    const parsedFt = JSON.parse(ft);
                                    if (parsedFt.mf_story_key) bestUrl = `/posts/${parsedFt.mf_story_key}`;
                                    else if (parsedFt.top_level_post_id) bestUrl = `/posts/${parsedFt.top_level_post_id}`;
                                } catch (e) { }
                            }
                        }

                        if (bestUrl) {
                            permalinkObj = { url: bestUrl, timestamp: bestTimestamp };
                        }

                        const messageEl = el.querySelector('[data-ad-comet-preview="message"], [data-ad-preview="message"]');
                        let bodyText = "";
                        if (messageEl && messageEl.innerText.trim()) {
                            bodyText = messageEl.innerText.replace(/See translation\n?/g, '').trim();
                        } else {
                            const textBlocks = Array.from(el.querySelectorAll('div[dir="auto"]'));
                            for (const block of textBlocks) {
                                const txt = block.innerText || "";
                                if (txt.includes("Like") || txt.includes("Reply") || txt.includes("Share") || txt.includes("Comment") || txt.includes("Send") || txt.includes("Write a comment")) {
                                    break;
                                }
                                if (!txt.includes("See translation") && txt.length > 3) {
                                    bodyText += txt + "\n";
                                }
                            }
                            bodyText = bodyText.trim();
                        }

                        let rawAuthor = "Unknown Author";
                        const candidates = Array.from(el.querySelectorAll('h2, h3, h4, strong, a[href*="/user/"], a[href*="/profile.php"]'));
                        for (const cand of candidates) {
                            const txt = cand.innerText ? cand.innerText.trim() : "";
                            if (txt && txt !== "Facebook" && !txt.includes("Suggested") && !txt.includes("Sponsored")) {
                                rawAuthor = txt;
                                break;
                            }
                        }
                        const author = rawAuthor
                            .replace(/\bFollow\b|\bFollowing\b/g, '')
                            .replace(/•/g, '')
                            .replace(/·/g, '')
                            .replace(/\n+/g, ' ')
                            .replace(/\s+/g, ' ')
                            .trim();

                        let likes = 0;
                        const reactionElements = [...el.querySelectorAll('[aria-label*="reaction"], [aria-label*="Like"], [aria-label*="superstar"], [role="button"], span.x1e558r4, div.x1n2onr6, svg')];
                        for (const item of reactionElements) {
                            const aria = item.getAttribute('aria-label') || "";
                            const txt = (item.innerText || "").trim();
                            if (aria.includes("react") || aria.includes("Like") || aria.includes("superstar")) {
                                const match = aria.match(/\d+/);
                                if (match) {
                                    likes = Number(match[0]);
                                    if (likes > 0) break;
                                }
                            }
                            if (txt.length > 0 && txt.length < 10 && /^\d+$/.test(txt)) {
                                const num = Number(txt);
                                if (num > 0) {
                                    likes = num;
                                    break;
                                }
                            }
                        }

                        let comments = 0;
                        let shares = 0;
                        const footer = [...el.querySelectorAll('div[role="button"], a, span')];
                        for (const item of footer) {
                            const txt = (item.innerText || "").trim();
                            if (/^\d+\s+comments?$/i.test(txt)) {
                                comments = Number(txt.match(/\d+/)[0]);
                            }
                            if (/^\d+\s+shares?$/i.test(txt)) {
                                shares = Number(txt.match(/\d+/)[0]);
                            }
                        }

                        const videoEl = el.querySelector('video');
                        const video = videoEl ? (videoEl.getAttribute('src') || "Embedded Video Present") : "None";

                        const imgEls = Array.from(el.querySelectorAll('img'));
                        const images = [];
                        for (const img of imgEls) {
                            const src = img.getAttribute('src') || "";
                            if (
                                src &&
                                src.startsWith("http") &&
                                !src.includes("rsrc.php") &&
                                !src.includes("emoji") &&
                                !src.includes("avatar") &&
                                !src.includes("sticker") &&
                                !src.includes("p32x32") &&
                                !src.includes("p16x16") &&
                                !src.includes("p50x50") &&
                                !src.includes("s60x60") &&
                                !src.includes("badges") &&
                                !src.includes("profile") &&
                                !src.includes("reaction") &&
                                !src.includes("fb_icon") &&
                                !src.includes("spis_") &&
                                !src.includes("x1bwp2qo") &&
                                !src.includes("spacer") &&
                                !src.includes("cover")
                            ) {
                                const w = img.getAttribute('width');
                                const h = img.getAttribute('height');
                                if ((w && parseInt(w) < 150) || (h && parseInt(h) < 150)) continue;
                                images.push(src);
                            }
                        }

                        return { permalinkObj, bodyText, author, likes, comments, shares, video, images };
                    }).catch(() => null);

                    if (data && data.permalinkObj) break;
                }
            }

            // 3. If still unavailable, click the timestamp and retry once more (Wait 700ms, search again)
            if (!data || !data.permalinkObj) {
                const timestampEl = feedUnit.locator('a[role="link"], a.x1i10hfl').filter({ hasText: /Just now|\dm|\d+m|\dh|\d+h|Today/i }).first();
                if (await timestampEl.count().catch(() => 0)) {
                    await timestampEl.click({ timeout: 2000, noWaitAfter: true }).catch(() => { });
                    await targetPage.waitForTimeout(700).catch(() => { });
                    data = await feedUnit.evaluate((el) => {
                        let permalinkObj = null;
                        let bestUrl = null;
                        let bestTimestamp = "Today";

                        const links = [...el.querySelectorAll('a[href*="/posts/"], a[href*="/permalink/"], a[href*="/photo.php"], a[href*="/story.php"], a[href*="multi_permalinks="], a[href*="story_fbid="], a[href*="fbid="]')];

                        for (const a of links) {
                            const href = a.getAttribute("href") || "";
                            if (!href.includes("/user/") && !href.includes("profile.php") && !href.includes("comment_id") && !href.includes("p.php")) {
                                bestUrl = href;
                                if (a.innerText && a.innerText.trim()) {
                                    bestTimestamp = a.innerText.trim();
                                }
                                break;
                            }
                        }

                        if (!bestUrl) {
                            const dataFtEl = el.querySelector('[data-ft]');
                            if (dataFtEl) {
                                const ft = dataFtEl.getAttribute('data-ft');
                                try {
                                    const parsedFt = JSON.parse(ft);
                                    if (parsedFt.mf_story_key) bestUrl = `/posts/${parsedFt.mf_story_key}`;
                                    else if (parsedFt.top_level_post_id) bestUrl = `/posts/${parsedFt.top_level_post_id}`;
                                } catch (e) { }
                            }
                        }

                        if (bestUrl) {
                            permalinkObj = { url: bestUrl, timestamp: bestTimestamp };
                        }

                        const messageEl = el.querySelector('[data-ad-comet-preview="message"], [data-ad-preview="message"]');
                        let bodyText = "";
                        if (messageEl && messageEl.innerText.trim()) {
                            bodyText = messageEl.innerText.replace(/See translation\n?/g, '').trim();
                        } else {
                            const textBlocks = Array.from(el.querySelectorAll('div[dir="auto"]'));
                            for (const block of textBlocks) {
                                const txt = block.innerText || "";
                                if (txt.includes("Like") || txt.includes("Reply") || txt.includes("Share") || txt.includes("Comment") || txt.includes("Send") || txt.includes("Write a comment")) {
                                    break;
                                }
                                if (!txt.includes("See translation") && txt.length > 3) {
                                    bodyText += txt + "\n";
                                }
                            }
                            bodyText = bodyText.trim();
                        }

                        let rawAuthor = "Unknown Author";
                        const candidates = Array.from(el.querySelectorAll('h2, h3, h4, strong, a[href*="/user/"], a[href*="/profile.php"]'));
                        for (const cand of candidates) {
                            const txt = cand.innerText ? cand.innerText.trim() : "";
                            if (txt && txt !== "Facebook" && !txt.includes("Suggested") && !txt.includes("Sponsored")) {
                                rawAuthor = txt;
                                break;
                            }
                        }
                        const author = rawAuthor
                            .replace(/\bFollow\b|\bFollowing\b/g, '')
                            .replace(/•/g, '')
                            .replace(/·/g, '')
                            .replace(/\n+/g, ' ')
                            .replace(/\s+/g, ' ')
                            .trim();

                        let likes = 0;
                        const reactionElements = [...el.querySelectorAll('[aria-label*="reaction"], [aria-label*="Like"], [aria-label*="superstar"], [role="button"], span.x1e558r4, div.x1n2onr6, svg')];
                        for (const item of reactionElements) {
                            const aria = item.getAttribute('aria-label') || "";
                            const txt = (item.innerText || "").trim();
                            if (aria.includes("react") || aria.includes("Like") || aria.includes("superstar")) {
                                const match = aria.match(/\d+/);
                                if (match) {
                                    likes = Number(match[0]);
                                    if (likes > 0) break;
                                }
                            }
                            if (txt.length > 0 && txt.length < 10 && /^\d+$/.test(txt)) {
                                const num = Number(txt);
                                if (num > 0) {
                                    likes = num;
                                    break;
                                }
                            }
                        }

                        let comments = 0;
                        let shares = 0;
                        const footer = [...el.querySelectorAll('div[role="button"], a, span')];
                        for (const item of footer) {
                            const txt = (item.innerText || "").trim();
                            if (/^\d+\s+comments?$/i.test(txt)) {
                                comments = Number(txt.match(/\d+/)[0]);
                            }
                            if (/^\d+\s+shares?$/i.test(txt)) {
                                shares = Number(txt.match(/\d+/)[0]);
                            }
                        }

                        const videoEl = el.querySelector('video');
                        const video = videoEl ? (videoEl.getAttribute('src') || "Embedded Video Present") : "None";

                        const imgEls = Array.from(el.querySelectorAll('img'));
                        const images = [];
                        for (const img of imgEls) {
                            const src = img.getAttribute('src') || "";
                            if (
                                src &&
                                src.startsWith("http") &&
                                !src.includes("rsrc.php") &&
                                !src.includes("emoji") &&
                                !src.includes("avatar") &&
                                !src.includes("sticker") &&
                                !src.includes("p32x32") &&
                                !src.includes("p16x16") &&
                                !src.includes("p50x50") &&
                                !src.includes("s60x60") &&
                                !src.includes("badges") &&
                                !src.includes("profile") &&
                                !src.includes("reaction") &&
                                !src.includes("fb_icon") &&
                                !src.includes("spis_") &&
                                !src.includes("x1bwp2qo") &&
                                !src.includes("spacer") &&
                                !src.includes("cover")
                            ) {
                                const w = img.getAttribute('width');
                                const h = img.getAttribute('height');
                                if ((w && parseInt(w) < 150) || (h && parseInt(h) < 150)) continue;
                                images.push(src);
                            }
                        }

                        return { permalinkObj, bodyText, author, likes, comments, shares, video, images };
                    }).catch(async () => {
                        return await targetPage.evaluate(() => {
                            return null;
                        });
                    });
                }
            }

            if (!data) {
                console.log("Skipped");
                processedIndex = i + 1;
                continue;
            }

            const timestamp = data.permalinkObj ? (data.permalinkObj.timestamp || "Today") : "Today";
            let rawPermalink = data.permalinkObj ? data.permalinkObj.url : null;
            let permalink = cleanPermalink(rawPermalink);
            let facebookPostId = normalizeFacebookPostId(permalink);
            let temporaryId = null;

            if (!isTodayPost(timestamp)) {
                console.log("Old post detected");
                updateHealthStatus({ old_posts: healthStatus.old_posts + 1 });
                oldPostCount++;
                processedIndex = i + 1;
                if (oldPostCount >= 5) {
                    console.log("Group stopped because 5 consecutive old posts found.");
                    stopGroup = true;
                    break;
                }
                continue;
            } else {
                oldPostCount = 0;
                console.log("Today's post");
            }

            // 4. Generate temporary_id using stable normalized author, body, and images
            const normalizedAuthor = (data.author || "Unknown Author").toLowerCase()
                .replace(/\b(follow|following|admin|moderator|group expert|top contributor|facebook|suggested|sponsored)\b/g, '')
                .replace(/[•·,]/g, '')
                .replace(/\b\d+\s*(m|min|mins|h|hr|hrs|d|day|days|w|week|weeks|mo|month|months|yr|year|years)\b/g, '')
                .replace(/\b(just now|today|yesterday)\b/g, '')
                .replace(/\s+/g, ' ')
                .trim();

            let normalizedBodyText = (data.bodyText || "").toLowerCase();
            if (group.name) {
                normalizedBodyText = normalizedBodyText.replace(new RegExp(group.name.toLowerCase(), 'g'), '');
            }
            if (normalizedAuthor && normalizedAuthor.length > 2) {
                normalizedBodyText = normalizedBodyText.replace(new RegExp(normalizedAuthor, 'g'), '');
            }
            normalizedBodyText = normalizedBodyText
                .replace(/\b(see translation|rate this translation|admin|moderator|group expert|top contributor|follow|following|like|comment|share|send|suggested|sponsored)\b/g, '')
                .replace(/[•·]/g, '')
                .replace(/\b\d+\s*(m|min|mins|h|hr|hrs|d|day|days|w|week|weeks|mo|month|months|yr|year|years)\b/g, '')
                .replace(/\b(just now|today|yesterday)\b/g, '')
                .replace(/\s+/g, ' ')
                .trim();

            const stableImages = (data.images || []).map(imgUrl => {
                try {
                    const parsed = new URL(imgUrl);
                    return path.basename(parsed.pathname);
                } catch(e) {
                    return "";
                }
            }).filter(Boolean).sort().join("|");

            temporaryId = crypto.createHash('sha256').update(groupId + normalizedAuthor + "today" + normalizedBodyText + stableImages).digest('hex');

            if (!permalink) {
                permalink = temporaryId;
            }

            // Virtual scrolling check for current run
            if ((facebookPostId && scrapedThisRun.has(facebookPostId)) || scrapedThisRun.has(temporaryId)) {
                processedIndex = i + 1;
                continue;
            }

            let hasPerm = facebookPostId ? existingFacebookPostIds.has(facebookPostId) : false;
            let hasTemp = !facebookPostId ? existingTemporaryIds.has(temporaryId) : false;

            // Perform definitive Supabase duplicate check as single source of truth if not in memory set
            if (facebookPostId && !hasPerm) {
                hasPerm = await checkDuplicateInSupabase(groupId, facebookPostId, null);
                if (hasPerm) existingFacebookPostIds.add(facebookPostId);
            } else if (!facebookPostId && !hasTemp) {
                hasTemp = await checkDuplicateInSupabase(groupId, null, temporaryId);
                if (hasTemp) existingTemporaryIds.add(temporaryId);
            }

            const isDuplicate = hasPerm || hasTemp;
            const decision = isDuplicate ? "SKIP_DUPLICATE" : "PROCESS_NEW_POST";

            console.log("--------------------------------\n");
            console.log(`Facebook Post ID:\n${facebookPostId || "N/A"}\n`);
            console.log(`Temporary ID:\n${temporaryId}\n`);
            console.log(`existingPostIds.has(...)\n${hasPerm}\n`);
            console.log(`existingTemporaryIds.has(...)\n${hasTemp}\n`);
            console.log(`Decision:\n${decision}\n`);
            console.log("--------------------------------");

            const isUpdateCase = facebookPostId && !existingFacebookPostIds.has(facebookPostId) && existingTemporaryIds.has(temporaryId);

            // Duplicate detection BEFORE downloading images or saving anything.
            if (isDuplicate) {
                if (hasPerm) {
                    console.log("Duplicate by Facebook ID");
                } else {
                    console.log("Duplicate by temporary_id");
                }

                updateHealthStatus({ duplicates_skipped: healthStatus.duplicates_skipped + 1 });
                scrapedThisRun.add(facebookPostId || temporaryId);
                scrapedThisRun.add(temporaryId);
                processedIndex = i + 1;

                duplicateCount++;
                if (duplicateCount >= 4) {
                    console.log("Group stopped because 4 consecutive duplicates found.");
                    stopGroup = true;
                    break;
                }
                continue;
            }

            duplicateCount = 0;

            if (isUpdateCase) {
                // When a real facebook_post_id is discovered for a previously saved temporary_id, perform an UPDATE in Supabase.
                try {
                    const updateRes = await updatePostPermalinkInSupabase(temporaryId, permalink, facebookPostId);
                    if (updateRes && updateRes.error) {
                        throw new Error(updateRes.error.message);
                    }

                    console.log("Temporary record upgraded in Supabase");
                    if (facebookPostId) existingFacebookPostIds.add(facebookPostId);
                    scrapedThisRun.add(facebookPostId || permalink);
                    scrapedThisRun.add(temporaryId);
                    updateHealthStatus({ permalinks_found: healthStatus.permalinks_found + 1 });
                } catch (err) {
                    console.log("Failed");
                    console.error(`❌ Update failed for temporary_id ${temporaryId}:`, err.message);
                    updateHealthStatus({ last_error: err.message });
                }
                processedIndex = i + 1;
                continue;
            }

            // Brand new post: Images must only be downloaded and uploaded after duplicate validation passes.
            if (facebookPostId) {
                updateHealthStatus({ permalinks_found: healthStatus.permalinks_found + 1 });
            } else {
                updateHealthStatus({ temporary_ids: healthStatus.temporary_ids + 1 });
            }

            await feedUnit.scrollIntoViewIfNeeded().catch(() => { });
            await targetPage.waitForTimeout(1000).catch(() => { });

            // Compress screenshots before upload to reduce storage
            const localScreenshotPath = path.join(IMAGES_DIR, `post_${groupId}_${Date.now()}.jpg`);
            await feedUnit.screenshot({ path: localScreenshotPath, type: 'jpeg', quality: 50 }).catch(() => { });

            let screenshotUrl = `images/${path.basename(localScreenshotPath)}`;
            const uploadedStoragePaths = [];
            const localFilesToClean = [];
            let uploadedCount = 0;

            if (fs.existsSync(localScreenshotPath)) {
                localFilesToClean.push(localScreenshotPath);
                const uploadRes = await uploadImageToSupabase(localScreenshotPath, `post_images/${path.basename(localScreenshotPath)}`, 'image/jpeg');
                if (uploadRes && uploadRes.publicUrl) {
                    screenshotUrl = uploadRes.publicUrl;
                    uploadedStoragePaths.push(uploadRes.storagePath);
                    uploadedCount++;
                    updateHealthStatus({ storage_uploads: healthStatus.storage_uploads + 1 });
                }
            }

            const imageUrls = [];
            for (let j = 0; j < data.images.length; j++) {
                const imgFilename = `post_${groupId}_${Date.now()}_${j + 1}.jpg`;
                const localImgPath = path.join(IMAGES_DIR, imgFilename);
                const dlSuccess = await download(data.images[j], localImgPath);
                if (dlSuccess && fs.existsSync(localImgPath)) {
                    localFilesToClean.push(localImgPath);
                    const imgUploadRes = await uploadImageToSupabase(localImgPath, `post_images/${imgFilename}`, 'image/jpeg');
                    if (imgUploadRes && imgUploadRes.publicUrl) {
                        imageUrls.push(imgUploadRes.publicUrl);
                        uploadedStoragePaths.push(imgUploadRes.storagePath);
                        uploadedCount++;
                        updateHealthStatus({ storage_uploads: healthStatus.storage_uploads + 1 });
                    } else {
                        imageUrls.push(`images/${imgFilename}`);
                    }
                }
            }

            if (uploadedCount > 0) {
                console.log(`Uploaded ${uploadedCount} images`);
            }

            // Clean local files immediately after uploading
            for (const f of localFilesToClean) {
                if (fs.existsSync(f)) {
                    fs.unlinkSync(f);
                }
            }

            const postObj = {
                id: permalink,
                group_name: group.name,
                group_url: group.url,
                group_id: groupId,
                author: data.author,
                body: data.bodyText,
                post_date: timestamp,
                permalink: data.permalinkObj ? permalink : null,
                likes: data.likes || 0,
                comments: data.comments || 0,
                shares: data.shares || 0,
                screenshot: screenshotUrl,
                images: imageUrls,
                scraped_at: new Date().toISOString(),
                temporary_id: temporaryId,
                needs_permalink: !data.permalinkObj,
                facebook_post_id: facebookPostId
            };

            try {
                const upsertRes = await upsertPostToSupabase(postObj);
                if (upsertRes && upsertRes.error) {
                    throw new Error(upsertRes.error.message);
                }
                console.log("Saved to Supabase");
                console.log("Saved new post");

                // After every successful save, immediately add both facebook_post_id and temporary_id into the in-memory Set so duplicates later in the same cycle are skipped.
                if (facebookPostId) {
                    existingFacebookPostIds.add(facebookPostId);
                    scrapedThisRun.add(facebookPostId);
                }
                if (temporaryId) {
                    existingTemporaryIds.add(temporaryId);
                    scrapedThisRun.add(temporaryId);
                }

                allPostsData.push(postObj);
                updateHealthStatus({ posts_added: healthStatus.posts_added + 1 });
            } catch (err) {
                console.log("Failed");
                console.error(`❌ Transaction failed for post ${postObj.id}. Rolling back storage and database...`, err.message);
                updateHealthStatus({ last_error: err.message });

                // Roll back Supabase Storage
                for (const sp of uploadedStoragePaths) {
                    await deleteImageFromSupabase(sp);
                }
                // Roll back Supabase Database
                await deletePostFromSupabase(postObj.id);
            }

            processedIndex = i + 1;
        }

        if (stopGroup || targetPage.isClosed() || scrollCount >= MAX_SCROLL_COUNT || isShuttingDown) {
            break;
        }

        await targetPage.mouse.wheel(0, 4000).catch(() => { });

        const scrollStartTime = Date.now();
        while (Date.now() - scrollStartTime < 10000) {
            await targetPage.waitForTimeout(1000).catch(() => { });
            if (targetPage.isClosed() || isShuttingDown) break;
            const newCount = await targetPage.locator('div[role="feed"] > div').count().catch(() => 0);
            if (newCount > previousCount) {
                break;
            }
        }

        if (!targetPage.isClosed() && !isShuttingDown) {
            const currentCount = await targetPage.locator('div[role="feed"] > div').count().catch(() => 0);
            if (currentCount <= previousCount) {
                noNewItemsCount++;
                if (noNewItemsCount >= 3) {
                    break;
                }
            } else {
                noNewItemsCount = 0;
                previousCount = currentCount;
            }
        }
        scrollCount++;
    }

    console.log("Finished group");
}

// Main Scrape Cycle Function
async function runScrapeCycle() {
    if (isScraping) {
        console.log("Previous scrape still running. Skipping scheduled cycle.");
        return;
    }

    if (isShuttingDown) return;

    isScraping = true;
    const startTime = Date.now();
    const startIso = new Date(startTime).toISOString();
    console.log("\nCycle started");

    updateHealthStatus({ running: true, last_run: startIso });
    globalAllPostsData = [];

    try {
        if (!browser || !browser.isConnected() || !page || page.isClosed()) {
            await initBrowser();
        }

        const isSessionValid = await verifySession();
        if (!isSessionValid) {
            isScraping = false;
            return;
        }

        for (let g = 0; g < GROUPS.length; g++) {
            if (isShuttingDown) break;
            const group = GROUPS[g];

            const matchGroup = group.url.match(/groups\/([^\/]+)/);
            const groupId = matchGroup ? matchGroup[1] : "";
            const { existingFacebookPostIds, existingTemporaryIds } = await getExistingPermalinksForGroup(group.url, group.name, groupId);

            // Browser recovery: Retry each group up to 3 times
            for (let attempt = 1; attempt <= 3; attempt++) {
                if (isShuttingDown) break;
                try {
                    await scrapeGroup(group, g + 1, GROUPS.length, page, existingFacebookPostIds, existingTemporaryIds, globalAllPostsData);
                    updateHealthStatus({ groups_processed: healthStatus.groups_processed + 1 });
                    break;
                } catch (err) {
                    if (attempt < 3 && !isShuttingDown) {
                        await new Promise(resolve => setTimeout(resolve, 5000));
                        if (!browser || !browser.isConnected() || !page || page.isClosed()) {
                            await initBrowser(true);
                        }
                    } else {
                        updateHealthStatus({ last_error: err.message });
                    }
                }
            }
        }

        // Save to JSON
        if (globalAllPostsData.length > 0) {
            let existingJson = [];
            if (fs.existsSync(JSON_FILE)) {
                try { existingJson = JSON.parse(fs.readFileSync(JSON_FILE, "utf8")); } catch (e) { }
            }
            const existingIds = new Set(existingJson.map(p => p.id));
            const newUniquePosts = globalAllPostsData.filter(p => !existingIds.has(p.id));
            const updatedJson = [...existingJson, ...newUniquePosts];
            fs.writeFileSync(JSON_FILE, JSON.stringify(updatedJson, null, 2));
        }

        // Save to CSV
        if (globalAllPostsData.length > 0) {
            const hasCsv = fs.existsSync(CSV_FILE);
            let existingCsvIds = new Set();
            if (hasCsv) {
                try {
                    const lines = fs.readFileSync(CSV_FILE, "utf8").split("\n");
                    lines.slice(1).forEach(line => {
                        const match = line.match(/^"([^"]+)"/);
                        if (match && match[1]) existingCsvIds.add(match[1]);
                    });
                } catch (e) { }
            }
            let csvContent = hasCsv ? "" : "ID,Group Name,Group URL,Author,Post Date,Permalink,Likes,Comments,Shares,Screenshot,Images,Body\n";
            globalAllPostsData.forEach(post => {
                if (!existingCsvIds.has(post.id)) {
                    const cleanAuthor = post.author.replace(/"/g, '""');
                    const cleanBody = post.body.replace(/"/g, '""');
                    const imagesJson = JSON.stringify(post.images).replace(/"/g, '""');
                    csvContent += `"${post.id}","${post.group_name}","${post.group_url}","${cleanAuthor}","${post.post_date}","${post.permalink || ''}","${post.likes}","${post.comments}","${post.shares}","${post.screenshot}","${imagesJson}","${cleanBody}"\n`;
                }
            });
            if (hasCsv && csvContent.length > 0) {
                fs.appendFileSync(CSV_FILE, csvContent);
            } else if (!hasCsv) {
                fs.writeFileSync(CSV_FILE, csvContent);
            }
        }

    } catch (err) {
        updateHealthStatus({ last_error: err.message });
    }

    const runtimeSec = Number(((Date.now() - startTime) / 1000).toFixed(0));
    const nextRunTime = new Date(startTime + 30 * 60 * 1000);

    console.log("\nCycle finished");
    console.log(`Runtime: ${runtimeSec} seconds`);
    console.log(`Next run: ${nextRunTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);

    updateHealthStatus({
        running: false,
        runtime_seconds: runtimeSec,
        next_run: nextRunTime.toISOString()
    });

    isScraping = false;
}

// Graceful shutdown on SIGINT or SIGTERM
async function handleExit() {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log("\nGraceful shutdown initiated. Exporting pending data and closing browser...");

    // Export JSON
    if (globalAllPostsData.length > 0) {
        let existingJson = [];
        if (fs.existsSync(JSON_FILE)) {
            try { existingJson = JSON.parse(fs.readFileSync(JSON_FILE, "utf8")); } catch (e) { }
        }
        const existingIds = new Set(existingJson.map(p => p.id));
        const newUniquePosts = globalAllPostsData.filter(p => !existingIds.has(p.id));
        const updatedJson = [...existingJson, ...newUniquePosts];
        fs.writeFileSync(JSON_FILE, JSON.stringify(updatedJson, null, 2));

        // Export CSV
        const hasCsv = fs.existsSync(CSV_FILE);
        let existingCsvIds = new Set();
        if (hasCsv) {
            try {
                const lines = fs.readFileSync(CSV_FILE, "utf8").split("\n");
                lines.slice(1).forEach(line => {
                    const match = line.match(/^"([^"]+)"/);
                    if (match && match[1]) existingCsvIds.add(match[1]);
                });
            } catch (e) { }
        }
        let csvContent = hasCsv ? "" : "ID,Group Name,Group URL,Author,Post Date,Permalink,Likes,Comments,Shares,Screenshot,Images,Body\n";
        globalAllPostsData.forEach(post => {
            if (!existingCsvIds.has(post.id)) {
                const cleanAuthor = post.author.replace(/"/g, '""');
                const cleanBody = post.body.replace(/"/g, '""');
                const imagesJson = JSON.stringify(post.images).replace(/"/g, '""');
                csvContent += `"${post.id}","${post.group_name}","${post.group_url}","${cleanAuthor}","${post.post_date}","${post.permalink || ''}","${post.likes}","${post.comments}","${post.shares}","${post.screenshot}","${imagesJson}","${cleanBody}"\n`;
            }
        });
        if (hasCsv && csvContent.length > 0) {
            fs.appendFileSync(CSV_FILE, csvContent);
        } else if (!hasCsv) {
            fs.writeFileSync(CSV_FILE, csvContent);
        }
    }

    updateHealthStatus({ running: false });

    if (browser && browser.isConnected()) {
        await browser.close().catch(() => { });
    }
    console.log("Exited cleanly.");
    process.exit(0);
}

process.on("SIGINT", handleExit);
process.on("SIGTERM", handleExit);

// Initialize scraper scheduler
console.log("Scheduler started");
runScrapeCycle(); // Initial run immediately
setInterval(runScrapeCycle, 30 * 60 * 1000);
