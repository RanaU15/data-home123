const { chromium } = require("playwright");
const path = require("path");

const SESSION_FILE = path.join(__dirname, "facebook-session.json");

(async () => {
    console.log("Launching browser for interactive login...");
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();

    console.log("Navigating to Facebook login page...");
    await page.goto("https://www.facebook.com/login");

    console.log("=============================================================");
    console.log("Please log in to your Facebook account in the browser window.");
    console.log("Once you have successfully logged in and see your news feed,");
    console.log("the script will automatically detect it and save your session.");
    console.log("=============================================================");

    // Wait for the user to log in and reach the home feed
    try {
        await page.waitForURL(/.*facebook\.com\/(?!(login|.*login\.php)).*/, { timeout: 180000 });
        console.log("Navigation detected! Saving session...");
    } catch (err) {
        console.log("Login timeout or navigation not automatically detected. Saving current session state anyway...");
    }

    // Give a few seconds for cookies and storage state to fully populate
    await page.waitForTimeout(5000);

    // Save storage state
    await context.storageState({ path: SESSION_FILE });
    console.log(`\nSuccess! Session saved to ${SESSION_FILE}`);
    console.log("You can now run 'npm run scrape' or 'node scraper.js' to scrape group posts using this session.");

    await browser.close();
})();
