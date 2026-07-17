const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
    const browser = await chromium.launch({ headless: true });
    let cookies = JSON.parse(fs.readFileSync('d:/facbook/scraper/facebook-cookies.json', 'utf8'));
    cookies = cookies.map(c => { delete c.sameSite; return c; });
    
    const context = await browser.newContext();
    await context.addCookies(cookies);
    
    const page = await context.newPage();
    const url = 'https://www.facebook.com/groups/658561818123997/posts/1627447231454559/';
    console.log("Visiting:", url);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    
    console.log("Waiting 5s for hydration...");
    await page.waitForTimeout(5000);
    
    const html = await page.content();
    fs.writeFileSync('d:/facbook/logs/debug_real_post.html', html);
    console.log("Saved HTML");
    
    await browser.close();
})();
