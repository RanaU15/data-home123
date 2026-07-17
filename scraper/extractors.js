const https = require('https');
const http = require('http');

function getVideoSignature(urlStr) {
    try {
        const urlObj = new URL(urlStr);
        const parts = urlObj.pathname.split('/').pop().split('_');
        if (parts.length >= 3 && parts[1].length > 8 && !isNaN(parts[1])) {
            return parts[1];
        }
        return urlObj.pathname;
    } catch (e) {
        return urlStr.split('?')[0];
    }
}


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


function cleanPermalink(url) {
    if (!url) return null;
    try {
        const parsed = new URL(url, "https://www.facebook.com");
        parsed.searchParams.delete("__cft__[0]");
        parsed.searchParams.delete("__cft__");
        parsed.searchParams.delete("__tn__");
        parsed.searchParams.delete("fbclid");
        
        if (parsed.searchParams.has("set")) {
            const setVal = parsed.searchParams.get("set");
            if (!setVal.startsWith("gm.") && !setVal.startsWith("pcb.")) {
                parsed.searchParams.delete("set");
            }
        }
        
        parsed.searchParams.delete("type");
        parsed.searchParams.delete("eid");

        if (parsed.pathname.includes("/posts/") || parsed.pathname.includes("/permalink/")) {
            parsed.search = ""; // Strip search entirely for standard post permalinks
        }
        
        const finalUrl = parsed.toString();
        // Reject group homepages
        if (finalUrl.match(/^https?:\/\/(www\.)?facebook\.com\/groups\/[^\/]+\/?$/) || finalUrl.match(/^https?:\/\/(www\.)?facebook\.com\/groups\/?$/)) {
            return null;
        }
        
        return finalUrl;
    } catch (e) {
        return url;
    }
}


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


async function extractPlayableVideoUrl(context, permalink) {
    if (!permalink || !permalink.startsWith("http")) return [];
    
    let videoPage = null;
    let extractedMp4 = null;
    let extractedHls = null;
    let networkListener = null;

    try {
        console.log(`Opening permalink...`);
        videoPage = await context.newPage();
        
        // 14. Prevent memory leaks: define listener and remove it later
        networkListener = (response) => {
            try {
                const url = response.url();
                
                // 6. Listen to every network request for video URLs
                if (url.includes('video.xx.fbcdn.net') || 
                    url.includes('fbcdn.net/v/t') && (url.includes('.mp4') || url.includes('.m3u8')) ||
                    url.includes('.mp4') ||
                    url.includes('.m3u8') ||
                    url.includes('.mpd') ||
                    url.includes('video/mp4') ||
                    url.includes('application/vnd.apple.mpegurl')) {
                    
                    if (url.includes('.m3u8') || url.includes('.mpd') || url.includes('apple.mpegurl')) {
                        console.log(`Network request captured`);
                        console.log(`Video response captured`);
                        console.log(`Found HLS`);
                        if (!extractedHls) extractedHls = url;
                    } else if (url.includes('.mp4') || url.includes('video.xx.fbcdn') || url.includes('video/mp4')) {
                        console.log(`Network request captured`);
                        console.log(`Video response captured`);
                        console.log(`Found MP4`);
                        if (!extractedMp4) extractedMp4 = url;
                    }
                }
            } catch(e) {}
        };
        
        videoPage.on('response', networkListener);
        
        // 1. Open the permalink
        // 2. Wait until the page is fully interactive
        await videoPage.goto(permalink, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
        console.log(`Waiting for player...`);
        
        const startTime = Date.now();
        const maxWaitTime = 30000; // 10. Wait up to 30 seconds
        let attempt = 1;
        
        // 9. Retry extraction multiple times
        while (Date.now() - startTime < maxWaitTime) {
            console.log(`attempt ${attempt}`);
            
            if (extractedMp4 || extractedHls) {
                break;
            }
            
            // 3. Wait for a video element
            const playerSelectors = 'video, video[src], div[data-video-id], div[role="application"], video[playsinline]';
            const playerLocator = videoPage.locator(playerSelectors).first();
            
            if (await playerLocator.count().catch(()=>0) > 0) {
                console.log(`Player found`);
                
                // 4. Scroll the player into view
                await playerLocator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(()=>{});
                
                // 5. Simulate a real mouse click on the player
                await playerLocator.click({ force: true, delay: 100, timeout: 2000 }).catch(()=>{});
                console.log(`Player clicked`);
            }
            
            // 7. Inspect the video element itself
            const domUrls = await videoPage.evaluate(() => {
                let mp4 = null;
                let hls = null;
                const videoEl = document.querySelector('video');
                if (videoEl) {
                    const src = videoEl.src || videoEl.currentSrc;
                    if (src && src.startsWith('http') && !src.includes('blob:')) {
                        if (src.includes('.m3u8') || src.includes('.mpd')) hls = src;
                        else mp4 = src;
                    }
                    const sourceEl = videoEl.querySelector('source');
                    if (sourceEl && sourceEl.src && sourceEl.src.startsWith('http') && !sourceEl.src.includes('blob:')) {
                        if (sourceEl.src.includes('.m3u8') || sourceEl.src.includes('.mpd')) hls = sourceEl.src;
                        else mp4 = sourceEl.src;
                    }
                }
                return { mp4, hls };
            }).catch(() => ({ mp4: null, hls: null }));
            
            if (domUrls.mp4 && !extractedMp4) {
                console.log(`Video element src`);
                extractedMp4 = domUrls.mp4;
            } else if (domUrls.hls && !extractedHls) {
                console.log(`Video element src`);
                extractedHls = domUrls.hls;
            }
            
            // 8. If the video URL is inside GraphQL JSON, extract it
            const graphqlUrls = await videoPage.evaluate(() => {
                let hdUrl = null;
                let sdUrl = null;
                const scripts = Array.from(document.querySelectorAll('script'));
                for (const script of scripts) {
                    const text = script.innerText;
                    if (!text) continue;
                    
                    const hdMatch = text.match(/"(?:playable_url_quality_hd|browser_native_hd_url)"\s*:\s*"([^"]+)"/);
                    if (hdMatch && hdMatch[1]) {
                        try { hdUrl = JSON.parse(`"${hdMatch[1].replace(/\\/g, '\\\\')}"`).replace(/\\\//g, '/'); } 
                        catch(e) { hdUrl = hdMatch[1].replace(/\\\//g, '/'); }
                    }
                    
                    const sdMatch = text.match(/"(?:playable_url|browser_native_sd_url)"\s*:\s*"([^"]+)"/);
                    if (sdMatch && sdMatch[1]) {
                        try { sdUrl = JSON.parse(`"${sdMatch[1].replace(/\\/g, '\\\\')}"`).replace(/\\\//g, '/'); } 
                        catch(e) { sdUrl = sdMatch[1].replace(/\\\//g, '/'); }
                    }
                    
                    if (hdUrl || sdUrl) break;
                }
                return { hd: hdUrl, sd: sdUrl };
            }).catch(() => ({ hd: null, sd: null }));
            
            if (graphqlUrls.hd && !extractedMp4) {
                console.log(`GraphQL video URL`);
                extractedMp4 = graphqlUrls.hd; 
            } else if (graphqlUrls.sd && !extractedMp4 && !extractedHls) {
                console.log(`GraphQL video URL`);
                extractedMp4 = graphqlUrls.sd;
            }
            
            if (extractedMp4 || extractedHls) {
                break;
            }
            
            // wait 2 sec
            await videoPage.waitForTimeout(2000).catch(()=>{});
            
            // scroll
            await videoPage.mouse.wheel(0, 300).catch(()=>{});
            console.log(`scroll`);
            console.log(`click again`); // The next loop iteration will click again if player found
            
            attempt++;
        }
        
        // 11. Prefer MP4. If unavailable, save the HLS (.m3u8) URL.
        let finalUrl = null;
        if (extractedMp4) finalUrl = extractedMp4;
        else if (extractedHls) finalUrl = extractedHls;
        
        if (finalUrl) {
            console.log(`Final extracted URL:\n${finalUrl}`);
            return [finalUrl];
        }
        
        // 12. If no stream URL can be extracted, store the Reel permalink instead
        console.log(`No playable video URL found.`);
        console.log(`Reason for failure:\nCould not intercept or extract any valid MP4/HLS streams after 30 seconds.`);
        return [permalink];
        
    } catch (err) {
        console.log(`Reason for failure:\n${err.message}`);
        return [permalink]; 
    } finally {
        // 14. Remove listeners after extraction
        if (videoPage) {
            if (networkListener) {
                videoPage.off('response', networkListener);
            }
            await videoPage.close().catch(() => {});
        }
    }
}


const extractMetadata = async (locator, passedBody = "") => {
                return await locator.evaluate((el, passedBody) => {
                    let permalinkObj = null;
                    let bestUrl = null;
                    let bestType = "UNKNOWN";

                    // 1. Gather all anchors in the feed card
                    const anchors = Array.from(el.querySelectorAll('a[href]'));
                    
                    let urls = anchors.map(a => {
                        let href = a.getAttribute("href") || "";
                        let rawHref = href;
                        let ariaLabel = a.getAttribute("aria-label") || "";
                        if (!ariaLabel) {
                            const childAria = a.querySelector('[aria-label]');
                            if (childAria) ariaLabel = childAria.getAttribute("aria-label") || "";
                        }
                        
                        // Normalize relative URLs to absolute
                        if (href.startsWith('/')) {
                            href = 'https://www.facebook.com' + href;
                        }
                        
                        // Clean tracking parameters
                        try {
                            const parsed = new URL(href, 'https://www.facebook.com');
                            parsed.searchParams.delete('__cft__[0]');
                            parsed.searchParams.delete('__cft__');
                            parsed.searchParams.delete('__tn__');
                            parsed.searchParams.delete('mibextid');
                            parsed.searchParams.delete('refsrc');
                            parsed.searchParams.delete('refid');
                            href = parsed.toString();
                        } catch (e) {}
                        
                        return { 
                            href, 
                            rawHref,
                            element: a,
                            ariaLabel,
                            text: (a.innerText || "").replace(/\\n/g, '').trim(),
                            isProfile: href.includes('/user/') || href.includes('profile.php') || href.includes('comment_id') || href.includes('p.php')
                        };
                    }).filter(u => !u.isProfile);

                    // 2. Strict priority matching for permalinks
                    const patterns = [
                        { regex: /facebook\.com\/groups\/[^\/]+\/(posts|permalink)\/\d+/i, type: "GROUP_POST" },
                        { regex: /facebook\.com\/share\/p\//i, type: "SHARE" },
                        { regex: /facebook\.com\/watch\/\?v=/i, type: "WATCH" },
                        { regex: /facebook\.com\/reel\//i, type: "REEL" },
                        { regex: /facebook\.com\/story\.php\?story_fbid=/i, type: "STORY" },
                        { regex: /facebook\.com\/photo\/?\?fbid=/i, type: "PHOTO" }
                    ];

                    for (const pattern of patterns) {
                        const match = urls.find(u => pattern.regex.test(u.href));
                        if (match) {
                            bestUrl = match.href;
                            bestType = pattern.type;
                            break; // Stop at highest priority pattern match
                        }
                    }

                    if (!bestUrl) {
                        // Fallback to data-ft attribute if no standard URLs found
                        const dataFtEl = el.querySelector('[data-ft]');
                        if (dataFtEl) {
                            const ft = dataFtEl.getAttribute('data-ft');
                            try {
                                const parsedFt = JSON.parse(ft);
                                if (parsedFt.mf_story_key) {
                                    bestUrl = `https://www.facebook.com/posts/${parsedFt.mf_story_key}`;
                                    bestType = "DATA_FT_STORY";
                                }
                                else if (parsedFt.top_level_post_id) {
                                    bestUrl = `https://www.facebook.com/posts/${parsedFt.top_level_post_id}`;
                                    bestType = "DATA_FT_POST";
                                }
                            } catch (e) { }
                        }
                    }

                    if (bestUrl) {
                        let ts = null;
                        if (match) {
                            ts = match.ariaLabel || match.text;
                        }
                        permalinkObj = { url: bestUrl, type: bestType, timestamp: ts };
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
                    const imageSet = new Set();
                    for (const img of imgEls) {
                        const src = img.getAttribute('src') || "";
                        // Ensure it's an original Facebook image CDN URL
                        if (src && src.startsWith("http") && src.includes("scontent") && src.includes("fbcdn.net") && !src.includes("rsrc.php") && !src.includes("emoji") && !src.includes("avatar") && !src.includes("profile")) {
                            const w = img.getAttribute('width');
                            const h = img.getAttribute('height');
                            if ((w && parseInt(w) < 150) || (h && parseInt(h) < 150)) continue;
                            imageSet.add(src);
                        }
                    }
                    const images = Array.from(imageSet);
                    
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


module.exports = {
    getVideoSignature,
    downloadToBuffer,
    cleanPermalink,
    isTodayPost,
    extractPlayableVideoUrl,
    extractMetadata
};
