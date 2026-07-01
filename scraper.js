const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
require("dotenv").config();
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
    uploadVideoToSupabase,
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
const MAX_SCROLL_COUNT = 25;

// Global browser state to keep browser alive across scheduled runs
let browser = null;
let context = null;
let page = null;
let isScraping = false;
let isShuttingDown = false;
let processedIndex = 0;

function getVideoSignature(urlStr) {
    try {
        const urlObj = new URL(urlStr);
        const parts = urlObj.pathname.split('/').pop().split('_');
        if (parts.length >= 3 && parts[1].length > 8 && !isNaN(parts[1])) {
            return parts[1]; // The asset ID
        }
        return urlObj.pathname; // Fallback to full path if pattern doesn't match
    } catch (e) {
        return urlStr.split('?')[0];
    }
}

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

// Helper function to download into memory with up to 3 retries
async function downloadToBuffer(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const buffer = await new Promise((resolve, reject) => {
                const client = url.startsWith("https") ? https : http;
                const req = client.get(url, { timeout: 30000 }, res => {
                    if (res.statusCode !== 200 && res.statusCode !== 206) {
                        res.resume();
                        return reject(new Error(`Status Code: ${res.statusCode}`));
                    }
                    const data = [];
                    res.on('data', chunk => data.push(chunk));
                    res.on('end', () => resolve(Buffer.concat(data)));
                    res.on('error', err => reject(err));
                });
                req.on('timeout', () => {
                    req.destroy();
                    reject(new Error('Request timeout'));
                });
                req.on('error', err => reject(err));
            });
            console.log(`Download success\nFile size: ${buffer.length}`);
            return buffer;
        } catch (error) {
            console.warn(`Download attempt ${i + 1} failed for ${url.substring(0, 50)}...: ${error.message}`);
            if (i === retries - 1) {
                console.warn(`All ${retries} download attempts failed.`);
                return null;
            }
            await new Promise(res => setTimeout(res, 1000 * (i + 1))); // Exponential backoff
        }
    }
    return null;
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

// Auto Login Function
async function autoLogin() {
    const email = process.env.FB_EMAIL;
    const password = process.env.FB_PASSWORD;

    if (!email || !password) {
        console.error("Session expired and FB_EMAIL / FB_PASSWORD not found in environment. Please add them or run npm run login.");
        updateHealthStatus({ running: false, last_error: "Session expired, no credentials provided" });
        process.exit(1);
    }

    console.log("Attempting automatic login...");
    await page.goto("https://www.facebook.com/login", { waitUntil: "domcontentloaded" });
    
    // Fill credentials
    await page.fill('#email', email);
    await page.fill('#pass', password);
    await page.click('button[name="login"]');

    console.log("Submitted login credentials, waiting for navigation...");
    try {
        await page.waitForURL(/.*facebook\.com\/(?!(login|.*login\.php)).*/, { timeout: 60000 });
        console.log("Automatic login successful! Saving new session...");
        await page.waitForTimeout(5000);
        await context.storageState({ path: SESSION_FILE });
        return true;
    } catch (err) {
        console.error("Automatic login failed! Please check your credentials or run npm run login manually.", err.message);
        updateHealthStatus({ running: false, last_error: "Automatic login failed" });
        process.exit(1);
    }
}

// Initialize or Recreate Browser
async function initBrowser(isRestart = false) {
    if (browser && browser.isConnected()) {
        await browser.close().catch(() => { });
    }

    const isCI = process.env.CI === 'true';
    browser = await chromium.launch({ headless: isCI ? true : false });
    
    if (fs.existsSync(SESSION_FILE)) {
        context = await browser.newContext({ storageState: SESSION_FILE });
    } else {
        context = await browser.newContext();
    }
    
    page = await context.newPage();
}

// Verify Facebook Session
async function verifySession() {
    try {
        if (!fs.existsSync(SESSION_FILE)) {
             return await autoLogin();
        }

        await page.goto("https://www.facebook.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
        const currentUrl = page.url();
        if (currentUrl.includes("/login") || currentUrl.includes("login.php")) {
            console.error("Session expired. Redirected to login page.");
            return await autoLogin();
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

            // --- INDEPENDENT EXTRACTORS ---
            const extractFeedBody = async (unit) => {
                return await unit.evaluate((el) => {
                    let bodyText = "";
                    let selectorMatched = false;
                    
                    let textBlocks = Array.from(el.querySelectorAll('div[data-ad-comet-preview="message"], div[data-ad-preview="message"]'));
                    if (textBlocks.length === 0) {
                        const allAuto = Array.from(el.querySelectorAll('div[dir="auto"]'));
                        textBlocks = allAuto.filter(auto => !auto.parentElement || !auto.parentElement.closest('div[dir="auto"]'));
                    }
                    if (textBlocks.length > 0) selectorMatched = true;
                    
                    const seenTexts = new Set();
                    let paragraphs = [];
                    
                    for (const block of textBlocks) {
                        const txt = (block.innerText || "").trim();
                        if (!txt) continue;
                        
                        if (/^(Like|Comment|Share|Send|Reply|Most Relevant|Write a comment|Suggested for you|Sponsored|See translation|Rate this translation|Most Recent|New Activity)$/i.test(txt)) {
                            break;
                        }
                        
                        if (/^(See less|See more|Continue reading|\.\.\. More|… More)$/i.test(txt)) {
                            continue;
                        }

                        if (!seenTexts.has(txt)) {
                            seenTexts.add(txt);
                            paragraphs.push(txt);
                        }
                    }
                    
                    bodyText = paragraphs.join('\n');
                    
                    const cleanUpRe = /(?:\s+|^)(?:See more|See less|… More|\.\.\. More|\.\.\. See more|Continue reading|See translation|Rate this translation|Like|Comment|Share|Send|Reply|Most Relevant|Most Recent|New Activity|Suggested for you|Sponsored|Write a comment)\s*$/gim;
                    let oldText;
                    do {
                        oldText = bodyText;
                        bodyText = bodyText.replace(cleanUpRe, '').trim();
                    } while (oldText !== bodyText);

                    return { bodyText: bodyText.trim(), selectorMatched };
                }).catch(() => ({ bodyText: "", selectorMatched: false }));
            };

            const extractPermalinkBody = async (page) => {
                return await page.evaluate(() => {
                    let bodyText = "";
                    const container = document.querySelector('div[role="main"]') || document.querySelector('article') || document.body;
                    
                    let textBlocks = Array.from(container.querySelectorAll('div[data-ad-comet-preview="message"], div[data-ad-preview="message"]'));
                    if (textBlocks.length === 0) {
                        const allAuto = Array.from(container.querySelectorAll('div[dir="auto"]'));
                        textBlocks = allAuto.filter(auto => !auto.parentElement || !auto.parentElement.closest('div[dir="auto"]'));
                    }
                    
                    const seenTexts = new Set();
                    let paragraphs = [];
                    
                    for (const block of textBlocks) {
                        const txt = (block.innerText || "").trim();
                        if (!txt) continue;
                        
                        if (/^(Like|Comment|Share|Send|Reply|Most Relevant|Write a comment|Suggested for you|Sponsored|See translation|Rate this translation|Most Recent|New Activity)$/i.test(txt)) {
                            break;
                        }
                        
                        if (/^(See less|See more|Continue reading|\.\.\. More|… More)$/i.test(txt)) {
                            continue;
                        }

                        if (!seenTexts.has(txt)) {
                            seenTexts.add(txt);
                            paragraphs.push(txt);
                        }
                    }
                    
                    bodyText = paragraphs.join('\n');
                    
                    const cleanUpRe = /(?:\s+|^)(?:See more|See less|… More|\.\.\. More|\.\.\. See more|Continue reading|See translation|Rate this translation|Like|Comment|Share|Send|Reply|Most Relevant|Most Recent|New Activity|Suggested for you|Sponsored|Write a comment)\s*$/gim;
                    let oldText;
                    do {
                        oldText = bodyText;
                        bodyText = bodyText.replace(cleanUpRe, '').trim();
                    } while (oldText !== bodyText);

                    return bodyText.trim();
                }).catch(() => "");
            };

            const postNetworkState = {
                capturedVideoCandidates: [],
                capturedVideoThumbnails: new Set(),
                capturedVideoSignatures: new Set(),
                totalVideoRequests: 0,
                uniqueVideos: 0,
            };

            const diagnosticLogs = {
                cardProcessingStart: Date.now(),
                firstMp4Intercepted: null,
                metadataExtractionStart: null,
                cardProcessingEnd: null,
                listenerAttached: true,
                mp4Intercepted: false,
                videoElementsCount: 0,
                dataVideoIdCount: 0,
                dataStoreVideoCount: 0,
                posterExists: false,
                clearedStatus: 'Not cleared'
            };

            const responseListener = async (res) => {
                try {
                    const url = res.url();
                    const resourceType = res.request().resourceType();
                    
                    const isMp4ByUrl = url.includes('.mp4') && url.includes('video') && url.includes('fbcdn.net');
                    let isMp4ByHeader = false;
                    let cType = null;
                    
                    if (!isMp4ByUrl && (resourceType === 'media' || resourceType === 'fetch' || resourceType === 'xhr')) {
                        cType = await res.headerValue('content-type').catch(() => null);
                        if (cType && (cType.includes('video/mp4') || cType.includes('video/'))) {
                            if (url.includes('fbcdn.net') && !url.includes('spacer')) {
                                isMp4ByHeader = true;
                            }
                        }
                    }

                    if (isMp4ByUrl || isMp4ByHeader) {
                        if (!diagnosticLogs.firstMp4Intercepted) diagnosticLogs.firstMp4Intercepted = Date.now();
                        diagnosticLogs.mp4Intercepted = true;
                        postNetworkState.totalVideoRequests++;
                        
                        const headers = res.headers();
                        const status = res.status();
                        const contentLength = parseInt(headers['content-length'] || '0', 10);
                        const contentRange = headers['content-range'] || null;
                        const acceptRanges = headers['accept-ranges'] || null;

                        postNetworkState.capturedVideoCandidates.push({
                            url,
                            contentLength,
                            contentRange,
                            acceptRanges,
                            status,
                            headers
                        });
                    }
                    
                    if (resourceType === 'image' || resourceType === 'fetch' || resourceType === 'xhr') {
                        if (url.includes('fbcdn.net') || url.includes('scontent.xx.fbcdn.net') || url.match(/scontent\.fraj.*\.fbcdn\.net/)) {
                            if (url.includes('t15.') || url.includes('video_preview') || url.includes('video') || url.includes('poster')) {
                                if (url.includes('.jpg') || url.includes('.jpeg') || url.includes('.webp') || url.includes('.png')) {
                                    postNetworkState.capturedVideoThumbnails.add(url);
                                    console.log(`Video thumbnail intercepted`);
                                }
                            }
                        }
                    }
                } catch (e) {}
            };

            targetPage.on('response', responseListener);

            const cleanupNetworkListener = () => {
                diagnosticLogs.listenerAttached = false;
                targetPage.off('response', responseListener);
                postNetworkState.capturedVideoCandidates = [];
                postNetworkState.capturedVideoThumbnails.clear();
                postNetworkState.capturedVideoSignatures.clear();
                diagnosticLogs.clearedStatus = 'Cleared after processing';
            };

            console.log("\n----------------------------------------");
            console.log("Found feed card\n");
            
            let { bodyText: previewBody, selectorMatched } = await extractFeedBody(feedUnit);
            
            if (!selectorMatched || previewBody.length === 0) {
                console.log("WARNING:\nOriginal body selector returned empty string.\nSkipping expansion.");
                console.log("Skipped card:\nNo body extracted.");
                console.log("----------------------------------------\n");
                processedIndex = i + 1;
                cleanupNetworkListener();
                continue;
            }

            let finalBody = previewBody;
            let expandedBody = previewBody;
            let feedTruncatedInit = previewBody.endsWith("...") || 
                                previewBody.endsWith("…") || 
                                previewBody.match(/\.\.\.\s*$/) || 
                                previewBody.match(/…\s*$/) ||
                                previewBody.includes("See more") ||
                                previewBody.includes("Continue reading") ||
                                (previewBody.length > 50 && !previewBody.match(/[.!?]$/) && previewBody.length < 250);

            if (feedTruncatedInit) {
                let clickSuccess = await feedUnit.evaluate(async (el) => {
                    const clickables = Array.from(el.querySelectorAll('div[role="button"], span[role="button"], button, a, div, span'));
                    let clicked = false;
                    for (const c of clickables) {
                        const txt = (c.innerText || "").trim().toLowerCase();
                        if (/^(see more|more|read more|continue reading|\.\.\. more|… more)$/i.test(txt)) {
                            const style = window.getComputedStyle(c);
                            if (style.display !== 'none' && style.visibility !== 'hidden' && c.offsetWidth > 0 && c.offsetHeight > 0) {
                                try {
                                    c.click();
                                    clicked = true;
                                } catch(e) {}
                            }
                        }
                    }
                    if (clicked) {
                        return new Promise((resolve) => {
                            let observerTriggered = false;
                            const observer = new MutationObserver(() => { observerTriggered = true; });
                            observer.observe(el, { childList: true, subtree: true, characterData: true });
                            
                            let timePassed = 0;
                            const interval = setInterval(() => {
                                timePassed += 100;
                                if (observerTriggered || timePassed >= 2500) {
                                    clearInterval(interval);
                                    observer.disconnect();
                                    resolve(true);
                                }
                            }, 100);
                        });
                    }
                    return false;
                }).catch(() => false);
                
                if (clickSuccess) {
                    await targetPage.waitForTimeout(500);
                    const extracted = await extractFeedBody(feedUnit);
                    expandedBody = extracted.bodyText;
                    
                    if (expandedBody.length > previewBody.length) {
                        finalBody = expandedBody;
                    }
                }
            }

            // --- META EXTRACTOR FUNCTION ---
            const extractMetadata = async (locator, passedBody = "") => {
                return await locator.evaluate((el, passedBody) => {
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

                    let bodyText = passedBody || "";
                    if (!passedBody) {
                        const messageEl = el.querySelector('[data-ad-comet-preview="message"], [data-ad-preview="message"]');
                        if (messageEl && messageEl.innerText.trim()) {
                            bodyText = messageEl.innerText.replace(/See translation\n?/g, '').trim();
                        } else {
                            const allAuto = Array.from(el.querySelectorAll('div[dir="auto"]'));
                            const textBlocks = allAuto.filter(auto => !auto.parentElement || !auto.parentElement.closest('div[dir="auto"]'));
                            for (const block of textBlocks) {
                                const txt = block.innerText || "";
                                if (txt.includes("Like") || txt.includes("Reply") || txt.includes("Share") || txt.includes("Comment") || txt.includes("Send") || txt.includes("Write a comment")) break;
                                if (!txt.includes("See translation") && txt.length > 3) bodyText += txt + "\n";
                            }
                            bodyText = bodyText.trim();
                        }
                    }

                    let author = "Unknown Author";
                    let author_profile_url = null;
                    const candidates = Array.from(el.querySelectorAll('h2, h3, h4, strong, a[href*="/user/"], a[href*="/profile.php"]'));
                    for (const cand of candidates) {
                        const txt = cand.innerText ? cand.innerText.trim() : "";
                        if (txt && txt !== "Facebook" && !txt.includes("Suggested") && !txt.includes("Sponsored")) {
                            author = txt.replace(/\bFollow\b|\bFollowing\b/g, '').replace(/[•·]/g, '').replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
                            if (cand.tagName === 'A') author_profile_url = cand.getAttribute("href") || null;
                            break;
                        }
                    }
                    
                    let author_avatar = null;
                    const avatarImg = el.querySelector('image[preserveAspectRatio="xMidYMid slice"]') || el.querySelector('img[src*="s60x60"], img[src*="s100x100"]');
                    if (avatarImg) author_avatar = avatarImg.getAttribute('href') || avatarImg.getAttribute('src');

                    let likes = 0;
                    let reaction_breakdown = {};
                    const reactionElements = [...el.querySelectorAll('[aria-label*="reaction"], [aria-label*="Like"], [aria-label*="superstar"], [role="button"], span.x1e558r4, div.x1n2onr6, svg')];
                    for (const item of reactionElements) {
                        const aria = item.getAttribute('aria-label') || "";
                        const txt = (item.innerText || "").trim();
                        if (aria.includes("react") || aria.includes("Like") || aria.includes("superstar")) {
                            const match = aria.match(/\d+/);
                            if (match) { 
                                likes = Number(match[0]); 
                                // Parse breakdown: "120 Like, 40 Love, 5 Care"
                                const breakdownMatches = aria.matchAll(/(\d+)\s+([A-Za-z]+)/g);
                                for (const bm of breakdownMatches) {
                                    const count = Number(bm[1]);
                                    const type = bm[2].toLowerCase();
                                    if (['like', 'love', 'care', 'haha', 'wow', 'sad', 'angry'].includes(type)) {
                                        reaction_breakdown[type] = count;
                                    }
                                }
                                if (likes > 0) break; 
                            }
                        }
                        if (txt.length > 0 && txt.length < 10 && /^\d+$/.test(txt)) {
                            const num = Number(txt);
                            if (num > 0) { likes = num; break; }
                        }
                    }

                    let comments_disabled = false;
                    const commentInputs = el.querySelectorAll('form input, [aria-label="Write a comment"], [placeholder="Write a comment..."]');
                    if (commentInputs.length === 0 && bodyText.includes("comments are disabled")) {
                        comments_disabled = true;
                    }

                    let comments = 0;
                    let shares = 0;
                    const footer = [...el.querySelectorAll('div[role="button"], a, span')];
                    for (const item of footer) {
                        const txt = (item.innerText || "").trim();
                        if (/^\d+\s+comments?$/i.test(txt)) comments = Number(txt.match(/\d+/)[0]);
                        if (/^\d+\s+shares?$/i.test(txt)) shares = Number(txt.match(/\d+/)[0]);
                    }

                    let rawVideoEls = Array.from(el.querySelectorAll('video'));
                    let dataVideoIdEls = Array.from(el.querySelectorAll('[data-video-id]'));
                    let dataStoreVideoEls = Array.from(el.querySelectorAll('[data-store*="video"]'));
                    
                    let diagnosticInfo = {
                        videoElementsCount: rawVideoEls.length,
                        dataVideoIdCount: dataVideoIdEls.length,
                        dataStoreVideoCount: dataStoreVideoEls.length,
                        posterExists: [...rawVideoEls, ...dataVideoIdEls, ...dataStoreVideoEls].some(v => v.hasAttribute('poster'))
                    };

                    let videoEls = Array.from(el.querySelectorAll('video, [data-video-id], [data-store*="video"]'));
                    let video_urls = videoEls.map(v => v.getAttribute('src') || v.getAttribute('data-video-id')).filter(Boolean);
                    const has_video = video_urls.length > 0;
                    const video_count = video_urls.length;
                    
                    let video_extraction_method = "None";
                    if (has_video) {
                        if (el.querySelector('video[src]')) video_extraction_method = "DOM src";
                        else if (el.querySelector('[data-video-id]')) video_extraction_method = "data-video-id";
                        else if (el.querySelector('[data-store*="video"]')) video_extraction_method = "data-store";
                    }

                    let video_thumbnail = null;
                    if (has_video) {
                        for (const v of videoEls) {
                            const poster = v.getAttribute('poster');
                            if (poster && poster.startsWith('http')) {
                                video_thumbnail = poster;
                                break;
                            }
                        }

                        if (!video_thumbnail) {
                            const possibleThumbnails = el.querySelectorAll('img');
                            for(let t of possibleThumbnails) {
                                const src = t.getAttribute('src');
                                if (!src || !src.startsWith('http') || src.includes('rsrc.php') || src.includes('emoji') || src.includes('avatar') || src.includes('sticker') || src.includes('reaction') || src.includes('fb_icon')) continue;
                                
                                const w = t.getAttribute('width');
                                const h = t.getAttribute('height');
                                if ((w && parseInt(w) < 150) || (h && parseInt(h) < 150)) continue;
                                
                                if(src.includes('fbcdn.net')) {
                                    video_thumbnail = src;
                                    break;
                                }
                            }
                        }
                    }
                    let video_duration = null; // Basic placeholder as requested

                    const imgEls = Array.from(el.querySelectorAll('img'));
                    const images = [];
                    for (const img of imgEls) {
                        const src = img.getAttribute('src') || "";
                        if (src && src.startsWith("http") && !src.includes("rsrc.php") && !src.includes("emoji") && !src.includes("avatar") && !src.includes("sticker") && !src.includes("p32x32") && !src.includes("p16x16") && !src.includes("p50x50") && !src.includes("s60x60") && !src.includes("badges") && !src.includes("profile") && !src.includes("reaction") && !src.includes("fb_icon") && !src.includes("spis_") && !src.includes("x1bwp2qo") && !src.includes("spacer") && !src.includes("cover")) {
                            const w = img.getAttribute('width');
                            const h = img.getAttribute('height');
                            if ((w && parseInt(w) < 150) || (h && parseInt(h) < 150)) continue;
                            images.push(src);
                        }
                    }
                    
                    let post_type = "text";
                    if (has_video && images.length > 0) post_type = "mixed";
                    else if (has_video && video_count > 1) post_type = "multiple_videos";
                    else if (has_video) post_type = "video";
                    else if (images.length > 1) post_type = "multiple_images";
                    else if (images.length === 1) post_type = "image";

                    // Support backwards compatibility for video field
                    const video = has_video ? video_urls[0] : "None";

                    return { 
                        permalinkObj, bodyText, author, author_profile_url, author_avatar, 
                        likes, comments, shares, video, video_urls, video_thumbnail, 
                        video_duration, video_count, has_video, video_extraction_method, images, post_type,
                        reaction_breakdown, comments_disabled, diagnosticInfo
                    };
                }, passedBody).catch(() => null);
            };

            // 1. Extract metadata & permalink
            diagnosticLogs.metadataExtractionStart = Date.now();
            let data = await extractMetadata(feedUnit, finalBody);

            if (!data) {
                console.log("Skipped");
                processedIndex = i + 1;
                cleanupNetworkListener();
                continue;
            }
            
            if (data.has_video) {
                console.log("Video detected");
                if (data.video_extraction_method) {
                    console.log(`Video extracted using:\n${data.video_extraction_method}`);
                }
            } else {
                console.log("No video detected");
            }

            // Completely skip Facebook feed sorting widgets (Most Relevant, Most recent, New activity, Suggested for you) or empty body
            const checkAuthor = (data.author || "").toLowerCase().trim();
            const checkBody = (data.bodyText || "").trim();
            if (checkAuthor === "most relevant" || checkAuthor === "most recent" || checkAuthor === "new activity" || checkAuthor === "suggested for you") {
                console.log("Skipped fake feed card");
                processedIndex = i + 1;
                cleanupNetworkListener();
                continue;
            }
            if (checkBody === "") {
                console.log("Skipped empty card");
                processedIndex = i + 1;
                cleanupNetworkListener();
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
                cleanupNetworkListener();
                continue;
            }

            // 2. Retry permalink extraction (250ms, 250ms, 500ms)
            if (!data || !data.permalinkObj) {
                const delays = [250, 250, 500];
                for (const delay of delays) {
                    await targetPage.waitForTimeout(delay).catch(() => { });
                    data = await extractMetadata(feedUnit);
                    if (data && data.permalinkObj) break;
                }
            }

            // 3. If still unavailable, click the timestamp and retry once more (Wait 700ms, search again)
            if (!data || !data.permalinkObj) {
                const timestampEl = feedUnit.locator('a[role="link"], a.x1i10hfl').filter({ hasText: /Just now|\dm|\d+m|\dh|\d+h|Today/i }).first();
                if (await timestampEl.count().catch(() => 0)) {
                    await timestampEl.click({ timeout: 2000, noWaitAfter: true }).catch(() => { });
                    await targetPage.waitForTimeout(700).catch(() => { });
                    data = await extractMetadata(feedUnit);
                }
            }

            if (!data) {
                console.log("Skipped");
                processedIndex = i + 1;
                cleanupNetworkListener();
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
                    cleanupNetworkListener();
                    break;
                }
                cleanupNetworkListener();
                continue;
            } else {
                oldPostCount = 0;
                console.log("Today's post");
            }

            // --- STAGE 2 FALLBACK (CRITICAL) ---
            let needsFallback = false;
            
            if (finalBody.endsWith("...")) needsFallback = true;
            if (finalBody.endsWith("…")) needsFallback = true;
            if (finalBody.includes("See more")) needsFallback = true;
            if (finalBody.includes("Continue reading")) needsFallback = true;
            if (finalBody.length < 50 && finalBody.endsWith("…")) needsFallback = true;
            if (feedTruncatedInit && finalBody.length <= previewBody.length) needsFallback = true;
            
            let permalinkBodyText = "";
            let expansionSource = "Feed";
            let reason = "Already complete";

            if (needsFallback) {
                reason = "Fallback";
            } else if (feedTruncatedInit && finalBody.length > previewBody.length) {
                reason = "Expanded";
            }
            
            if (needsFallback && permalink && permalink.startsWith("http")) {
                try {
                    const fallbackPage = await browser.newPage();
                    await fallbackPage.goto(permalink, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
                    await fallbackPage.waitForTimeout(3000).catch(() => {});
                    
                    permalinkBodyText = await extractPermalinkBody(fallbackPage);
                    
                    if (permalinkBodyText && permalinkBodyText.length > finalBody.length) {
                        finalBody = permalinkBodyText;
                        expansionSource = "Permalink";
                        reason = "Fallback";
                    }
                    
                    await fallbackPage.close().catch(() => {});
                } catch (e) {
                }
            }
            
            data.bodyText = finalBody;

            console.log(`Feed preview length: ${previewBody.length}`);
            console.log(`Feed expanded length: ${expandedBody.length}`);
            console.log(`Permalink length: ${permalinkBodyText.length || 0}`);
            console.log(`Final saved length: ${finalBody.length}`);
            console.log(`Expansion source: ${expansionSource}`);
            console.log(`Reason: ${reason}`);
            console.log("----------------------------------------\n");

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
            const decision = isDuplicate ? "UPDATE_EXISTING" : "PROCESS_NEW_POST";

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
                    cleanupNetworkListener();
                    break;
                }
                // Do NOT continue. We want to update it.
            } else {
                duplicateCount = 0;
            }

            if (isUpdateCase && !isDuplicate) {
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
                cleanupNetworkListener();
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

            const uploadedStoragePaths = [];
            let uploadedCount = 0;

            const imageUrls = [];
            for (let j = 0; j < data.images.length; j++) {
                const imgFilename = `post_${groupId}_${Date.now()}_${j + 1}.jpg`;
                const imgBuffer = await downloadToBuffer(data.images[j]);
                if (imgBuffer) {
                    const imgUploadRes = await uploadImageToSupabase(imgBuffer, `post_images/${imgFilename}`, 'image/jpeg');
                    if (imgUploadRes && imgUploadRes.publicUrl) {
                        imageUrls.push(imgUploadRes.publicUrl);
                        uploadedStoragePaths.push(imgUploadRes.storagePath);
                        uploadedCount++;
                        updateHealthStatus({ storage_uploads: healthStatus.storage_uploads + 1 });
                    }
                }
            }

            const uploadedVideoUrls = [];
            const uploadedVideoPaths = [];

            if (data.has_video && postNetworkState.capturedVideoCandidates.length > 0) {
                console.log(`\n--- VIDEO CANDIDATES ---`);
                
                let validCandidates = [];
                for (const candidate of postNetworkState.capturedVideoCandidates) {
                    let selected = "NO";
                    let reason = "";
                    
                    if (candidate.url.includes('init.mp4') || candidate.url.includes('dash')) {
                        reason = "Ignored: initialization segment";
                    } else if (candidate.contentLength < 500000) {
                        reason = `Ignored: Size < 500KB (${candidate.contentLength} bytes)`;
                    } else if (candidate.status === 206) {
                        if (candidate.contentRange && candidate.contentRange.startsWith('bytes 0-')) {
                            const match = candidate.contentRange.match(/bytes 0-(\d+)\/(\d+)/);
                            if (match && match[1] === (parseInt(match[2]) - 1).toString()) {
                                selected = "YES";
                                reason = "Valid complete 206 response";
                                validCandidates.push(candidate);
                            } else {
                                reason = `Ignored: Partial 206 response (${candidate.contentRange})`;
                            }
                        } else {
                            reason = `Ignored: Partial 206 response (No/Invalid Content-Range)`;
                        }
                    } else if (candidate.status === 200) {
                        selected = "YES";
                        reason = "Valid 200 complete response";
                        validCandidates.push(candidate);
                    } else {
                        reason = `Ignored: Status ${candidate.status}`;
                    }
                    
                    console.log(`URL: ${candidate.url.substring(0, 70)}...`);
                    console.log(`Content-Length: ${candidate.contentLength}`);
                    console.log(`Status: ${candidate.status}`);
                    console.log(`Selected: ${selected}`);
                    console.log(`Reason: ${reason}\n`);
                }
                
                let videoUrlArray = [];
                if (validCandidates.length > 0) {
                    validCandidates.sort((a, b) => b.contentLength - a.contentLength);
                    const uniqueSignatures = new Set();
                    for (const cand of validCandidates) {
                        const sig = getVideoSignature(cand.url);
                        if (!uniqueSignatures.has(sig)) {
                            uniqueSignatures.add(sig);
                            videoUrlArray.push(cand);
                            if (videoUrlArray.length >= (data.video_count || 1)) break;
                        }
                    }
                }
                
                for (let v = 0; v < videoUrlArray.length; v++) {
                    const candidate = videoUrlArray[v];
                    const actualVideoUrl = candidate.url;
                    const vidFilename = `post_${groupId}_${Date.now()}_${v + 1}.mp4`;
                    
                    console.log(`Downloading video...`);
                    const vidBuffer = await downloadToBuffer(actualVideoUrl);
                    if (vidBuffer) {
                        if (vidBuffer.length >= 500000) {
                            console.log(`Uploading video (Verified Size: ${vidBuffer.length} bytes)...`);
                            const uploadResult = await uploadVideoToSupabase(vidBuffer, `videos/${vidFilename}`);
                            if (uploadResult && uploadResult.publicUrl) {
                                console.log(`Video uploaded\nPublic URL:\n${uploadResult.publicUrl}`);
                                uploadedVideoUrls.push(uploadResult.publicUrl);
                                uploadedVideoPaths.push(uploadResult.storagePath);
                            } else {
                                console.warn(`Video upload failed`);
                            }
                        } else {
                            console.warn(`Video download failed verification: Size ${vidBuffer.length} bytes < 500KB`);
                        }
                    } else {
                        console.warn(`Video download failed`);
                    }
                }
                console.log(`Videos uploaded: ${uploadedVideoUrls.length}`);
                console.log(`--- END VIDEO CANDIDATES ---\n`);
            }

            if (uploadedVideoUrls.length > 0) {
                console.log(`Final saved videos: ${uploadedVideoUrls.length}`);
                data.video_urls = uploadedVideoUrls;
                data.video = uploadedVideoUrls[0]; 
                data.has_video = true;
                data.video_count = uploadedVideoUrls.length;
                if (data.post_type === 'image' && data.images.length > 0) {
                    data.post_type = 'mixed';
                } else if (data.post_type === 'text') {
                    data.post_type = uploadedVideoUrls.length > 1 ? 'multiple_videos' : 'video';
                }
            } else if (data.has_video) {
                data.video_urls = [];
                data.has_video = false;
                data.video = "None";
                if (data.post_type === 'video' || data.post_type === 'multiple_videos' || data.post_type === 'mixed') {
                    data.post_type = data.images.length > 1 ? 'multiple_images' : (data.images.length === 1 ? 'image' : 'text');
                }
            }
            
            // Process Video Thumbnail
            if (data.has_video || uploadedVideoUrls.length > 0) {
                let thumbnailSource = "";
                
                // If not found in DOM via poster (Priority 1), check network (Priority 2)
                if (!data.video_thumbnail && postNetworkState.capturedVideoThumbnails.size > 0) {
                    const thumbArray = Array.from(postNetworkState.capturedVideoThumbnails);
                    data.video_thumbnail = thumbArray[0];
                    thumbnailSource = "network";
                    console.log("Video thumbnail captured from network");
                } else if (data.video_thumbnail) {
                    console.log("Video poster found / Video thumbnail extracted from DOM");
                } else {
                    console.log("No thumbnail available");
                }
                
                if (data.video_thumbnail && data.video_thumbnail.startsWith('http')) {
                    const thumbFilename = `thumb_${groupId}_${Date.now()}.jpg`;
                    const thumbBuffer = await downloadToBuffer(data.video_thumbnail);
                    if (thumbBuffer) {
                        const uploadResult = await uploadImageToSupabase(thumbBuffer, `post_images/${thumbFilename}`, 'image/jpeg');
                        if (uploadResult && uploadResult.publicUrl) {
                            console.log(`Thumbnail uploaded`);
                            data.video_thumbnail = uploadResult.publicUrl;
                        } else {
                            console.warn("Thumbnail upload failed");
                        }
                    } else {
                        console.warn("Thumbnail upload failed");
                    }
                } else {
                    data.video_thumbnail = null;
                }
            }

            cleanupNetworkListener();
            
            diagnosticLogs.cardProcessingEnd = Date.now();
            if (data && data.diagnosticInfo) {
                diagnosticLogs.videoElementsCount = data.diagnosticInfo.videoElementsCount;
                diagnosticLogs.dataVideoIdCount = data.diagnosticInfo.dataVideoIdCount;
                diagnosticLogs.dataStoreVideoCount = data.diagnosticInfo.dataStoreVideoCount;
                diagnosticLogs.posterExists = data.diagnosticInfo.posterExists;
            }

            console.log("\n=== PIPELINE AUDIT DIAGNOSTICS ===");
            console.log(`1. Number of <video> elements found: ${diagnosticLogs.videoElementsCount}`);
            console.log(`2. Number of [data-video-id] elements found: ${diagnosticLogs.dataVideoIdCount}`);
            console.log(`3. Number of elements with data-store containing "video": ${diagnosticLogs.dataStoreVideoCount}`);
            console.log(`4. Whether a poster attribute exists: ${diagnosticLogs.posterExists}`);
            console.log(`5. MP4 requests intercepted during card: ${diagnosticLogs.mp4Intercepted}`);
            console.log(`6. Timestamps:`);
            console.log(`   - Card processing start: ${diagnosticLogs.cardProcessingStart}`);
            console.log(`   - First MP4 intercepted: ${diagnosticLogs.firstMp4Intercepted || 'None'}`);
            console.log(`   - Metadata extraction: ${diagnosticLogs.metadataExtractionStart || 'None'}`);
            console.log(`   - Card processing end: ${diagnosticLogs.cardProcessingEnd}`);
            console.log(`7. Network listener still attached: ${diagnosticLogs.listenerAttached}`);
            console.log(`8. Cleared arrays status: ${diagnosticLogs.clearedStatus}`);
            console.log("==================================\n");

            if (uploadedCount > 0) {
                console.log(`Uploaded ${uploadedCount} images from memory`);
            }

            // Final cleanup of Facebook UI labels before saving
            const cleanFacebookBody = (text) => {
                const garbageList = [
                    "See less", "See more", "Continue reading", "Like", "Comment", "Reply", 
                    "Share", "Send", "Most Relevant", "Most recent", "View more comments", 
                    "Write a comment", "Sponsored", "Suggested for you", "New activity", "See translation"
                ];
                let groupNamePattern = "";
                if (group.name) {
                    groupNamePattern = `|${group.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
                }
                const cleanupRegex = new RegExp(`(?:^|\\n)(?:${garbageList.join("|")}${groupNamePattern})\\s*$`, "gi");
                const cleanupRegexStart = new RegExp(`^(?:${garbageList.join("|")}${groupNamePattern})\\s*\\n?`, "gi");

                let cleaned = text;
                let previous = "";
                while (cleaned !== previous) {
                    previous = cleaned;
                    cleaned = cleaned.replace(cleanupRegex, "").trim();
                    cleaned = cleaned.replace(cleanupRegexStart, "").trim();
                }
                
                return cleaned;
            };
            
            data.bodyText = cleanFacebookBody(data.bodyText || "");
            
            function parseFacebookDate(dateStr) {
                if (!dateStr || dateStr.toLowerCase() === "today") return new Date().toISOString();
                let d = new Date();
                dateStr = dateStr.trim().toLowerCase();
                
                if (dateStr.includes("just now")) return d.toISOString();
                
                const mMatch = dateStr.match(/^(\d+)\s*m/);
                if (mMatch) { d.setMinutes(d.getMinutes() - parseInt(mMatch[1])); return d.toISOString(); }
                
                const hMatch = dateStr.match(/^(\d+)\s*h/);
                if (hMatch) { d.setHours(d.getHours() - parseInt(hMatch[1])); return d.toISOString(); }
                
                const dMatch = dateStr.match(/^(\d+)\s*d/);
                if (dMatch) { d.setDate(d.getDate() - parseInt(dMatch[1])); return d.toISOString(); }

                if (dateStr.includes("yesterday")) {
                    d.setDate(d.getDate() - 1);
                    const tMatch = dateStr.match(/at (\d+):(\d+)\s*(am|pm)/i);
                    if (tMatch) {
                        let [_, h, m, ampm] = tMatch;
                        h = parseInt(h);
                        if (ampm === "pm" && h !== 12) h += 12;
                        if (ampm === "am" && h === 12) h = 0;
                        d.setHours(h, parseInt(m), 0, 0);
                    }
                    return d.toISOString();
                }
                
                const parsed = new Date(dateStr.replace(' at ', ' '));
                if (!isNaN(parsed.getTime())) {
                    if (parsed.getFullYear() === 2001) parsed.setFullYear(new Date().getFullYear());
                    if (parsed > new Date()) parsed.setFullYear(parsed.getFullYear() - 1);
                    return parsed.toISOString();
                }
                
                return d.toISOString();
            }

            const postObj = {
                id: permalink,
                group_name: group.name,
                group_url: group.url,
                group_id: groupId,
                author: data.author,
                author_profile_url: data.author_profile_url,
                author_avatar: data.author_avatar,
                body: data.bodyText,
                post_time_text: timestamp,
                post_created_at: parseFacebookDate(timestamp),
                post_date: timestamp,
                permalink: data.permalinkObj ? permalink : null,
                post_url: data.permalinkObj ? permalink : null,
                likes: data.likes || 0,
                comments: data.comments || 0,
                shares: data.shares || 0,
                reaction_count: data.likes || 0,
                comment_count: data.comments || 0,
                share_count: data.shares || 0,
                images: imageUrls,
                image_count: data.images ? data.images.length : 0,
                video_urls: data.video_urls || [],
                video_thumbnail: data.video_thumbnail || null,
                video_duration: data.video_duration || null,
                video_count: data.video_count || 0,
                has_video: data.has_video || false,
                post_type: data.post_type || "text",
                reaction_breakdown: data.reaction_breakdown || {},
                comments_disabled: data.comments_disabled || false,
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
                console.log(`Database updated\nhas_video: ${postObj.has_video}\nvideo_urls: ${JSON.stringify(postObj.video_urls)}\nvideo_thumbnail: ${postObj.video_thumbnail}`);

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
if (require.main === module) {
    if (process.env.CI === 'true') {
        console.log("Running in CI single-execution mode...");
        runScrapeCycle().then(() => process.exit(0)).catch(() => process.exit(1));
    } else {
        console.log("Running in standalone scheduled mode...");
        runScrapeCycle();
        setInterval(runScrapeCycle, 30 * 60 * 1000);
    }
} else {
    // Export for trigger-server.js — all existing logic above is unchanged
    module.exports = { runScrapeCycle };
}
