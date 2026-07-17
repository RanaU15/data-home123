const { launchBrowser, ensureLoggedIn, getContext } = require('./auth');
const fs = require('fs');

async function testMbasicText() {
    await launchBrowser();
    await ensureLoggedIn();
    
    const context = getContext();
    const cookies = await context.cookies();
    
    const mobileContext = await context.browser().newContext({
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
        viewport: { width: 375, height: 667 }
    });
    await mobileContext.addCookies(cookies);

    const page = await mobileContext.newPage();
    const url = "https://mbasic.facebook.com/groups/644861357496091/posts/1397504602231759/";
    
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const text = await page.evaluate(() => document.body.innerText);
    console.log(text);
    process.exit(0);
}
testMbasicText().catch(console.error);
