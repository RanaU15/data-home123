const { launchBrowser, ensureLoggedIn, getContext } = require('./auth');

async function testPermalinkTimestamp() {
    await launchBrowser();
    await ensureLoggedIn();
    
    const context = getContext();
    const page = await context.newPage();
    const url = "https://www.facebook.com/groups/644861357496091/posts/1397504602231759/";
    
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    
    const timestamp = await page.evaluate(() => {
        let ts = null;
        const scripts = Array.from(document.querySelectorAll('script'));
        for (const script of scripts) {
            const text = script.innerText;
            if (text.includes('dateCreated') || text.includes('publish_time') || text.includes('creation_time')) {
                // Try ld+json
                if (script.type === 'application/ld+json') {
                    try {
                        const data = JSON.parse(text);
                        if (data.dateCreated) return data.dateCreated;
                    } catch(e) {}
                }
                
                // Try to match publish_time or creation_time in relay JSON
                const match = text.match(/"(?:publish_time|creation_time)"\s*:\s*(\d+)/);
                if (match && match[1]) {
                    ts = parseInt(match[1]);
                    return new Date(ts * 1000).toISOString();
                }
            }
        }
        return ts;
    });

    console.log("Extracted Timestamp:", timestamp);
    process.exit(0);
}
testPermalinkTimestamp().catch(console.error);
