const { chromium } = require('playwright');
const fs = require('fs');

async function extractTimestampViaMbasic(context, permalink) {
    if (!permalink || !permalink.startsWith("http")) return null;
    
    // Construct actual mbasic URL
    let mbasicUrl = permalink.replace('www.facebook.com', 'mbasic.facebook.com');
    if (!mbasicUrl.includes('mbasic.facebook.com')) {
        mbasicUrl = mbasicUrl.replace('facebook.com', 'mbasic.facebook.com');
    }
    
    let mbasicPage;
    try {
        mbasicPage = await context.newPage();
        await mbasicPage.goto(mbasicUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await mbasicPage.waitForTimeout(1000);
        
        console.log(`Visited: ${mbasicUrl}`);
        const title = await mbasicPage.title();
        console.log(`Title: ${title}`);
        
        const timestampText = await mbasicPage.evaluate(() => {
            const timeEl = document.querySelector('abbr');
            if (timeEl) {
                return timeEl.innerText;
            }
            // Fallback for mbasic sometimes not using abbr
            const elements = Array.from(document.querySelectorAll('*'));
            for (const el of elements) {
                const text = el.innerText || "";
                if (text.match(/^(Yesterday|Today|Just now|\d+ (mins|hrs|hr|min) ago|\d{1,2} [A-Z][a-z]+( \d{4})?( at \d{1,2}:\d{2} [AP]M)?)$/i)) {
                    if (el.tagName === 'A' || el.tagName === 'DIV' || el.tagName === 'SPAN') {
                        return text;
                    }
                }
            }
            return null;
        });
        
        return timestampText;
    } catch (err) {
        return null;
    } finally {
        if (mbasicPage) await mbasicPage.close().catch(()=>{});
    }
}

(async () => {
    let cookies = JSON.parse(fs.readFileSync('scraper/facebook-cookies.json', 'utf8'));
    cookies = cookies.map(c => {
        delete c.sameSite;
        return c;
    });
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await context.addCookies(cookies);
    
    console.log(await extractTimestampViaMbasic(context, 'https://www.facebook.com/groups/658561818123997/posts/1627447231454559/'));
    
    await browser.close();
})();
