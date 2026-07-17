const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
    let cookies = JSON.parse(fs.readFileSync('scraper/facebook-cookies.json', 'utf8'));
    cookies = cookies.map(c => {
        delete c.sameSite;
        return c;
    });
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await context.addCookies(cookies);
    const page = await context.newPage();
    await page.goto('https://www.facebook.com/groups/658561818123997/?sorting_setting=CHRONOLOGICAL', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
    for (let i = 0; i < 3; i++) {
        await page.mouse.wheel(0, 3000);
        await page.waitForTimeout(3000);
    }
    await page.screenshot({ path: 'd:/facbook/logs/scroll_debug.png' });
    await browser.close();
})();
