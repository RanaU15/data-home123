// auth.js
// AUTH REFACTOR: Authentication helper for persistent browser profile
const { chromium } = require("playwright");
const path = require("path");

let context = null;
let page = null;

const PROFILE_PATH = path.join(__dirname, "facebook-profile");

async function launchBrowser() {
    if (context) {
        try {
            await context.close();
        } catch (e) { }
    }

    console.log("Launching persistent browser profile...");
    // AUTH REFACTOR: Using launchPersistentContext instead of browser.newContext
    context = await chromium.launchPersistentContext(PROFILE_PATH, {
        headless: true,
        viewport: null,
        args: [
            "--disable-blink-features=AutomationControlled"
        ]
    });

    const pages = context.pages();
    page = pages.length > 0 ? pages[0] : await context.newPage();
}

async function isLoggedOut() {
    const url = page.url();
    return url.includes('/login') || url.includes('login.php');
}

async function waitForManualLogin() {
    console.log("=============================================================");
    console.log("Please login manually...");
    console.log("Waiting for successful login...");
    console.log("=============================================================");

    // AUTH REFACTOR: Wait indefinitely for manual login
    await page.waitForURL(/.*facebook\.com\/(?!(login|.*login\.php)).*/, { timeout: 0 });
    console.log("Login complete. Resuming...");
}

async function ensureLoggedIn() {
    if (!context || !page) {
        await launchBrowser();
    }

    // AUTH REFACTOR: Go to Facebook and let it redirect naturally
    await page.goto("https://www.facebook.com/", { waitUntil: "domcontentloaded", timeout: 60000 });

    if (await isLoggedOut()) {
        await waitForManualLogin();
    } else {
        console.log("Already logged in. Skipping login step.");
    }
}

async function restartBrowser() {
    // AUTH REFACTOR: Reuse the same profile
    await launchBrowser();
}

async function recoverSession() {
    // AUTH REFACTOR: Recovery using persistent profile
    await restartBrowser();
    await ensureLoggedIn();
}

module.exports = {
    launchBrowser,
    ensureLoggedIn,
    isLoggedOut,
    waitForManualLogin,
    restartBrowser,
    recoverSession,
    getContext: () => context,
    getPage: () => page
};
