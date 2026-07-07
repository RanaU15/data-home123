// auth.js
// AUTH REFACTOR: Authentication helper for stored cookies
const { chromium } = require("playwright");
const { loadCookiesIntoStorageState } = require("./auth/cookies");

let browser = null;
let context = null;
let page = null;

async function launchBrowser() {
    if (context) {
        try {
            await context.close();
        } catch (e) { }
    }
    if (browser) {
        try {
            await browser.close();
        } catch (e) { }
    }

    console.log("Launching headless browser...");
    // MUST run headless: true, NO persistent profile
    browser = await chromium.launch({
        headless: true,
        args: [
            "--disable-blink-features=AutomationControlled",
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage"
        ]
    });

    console.log("Loading stored cookies...");
    let storageState;
    try {
        storageState = loadCookiesIntoStorageState();
    } catch (e) {
        console.error("Failed to load cookies:", e.message);
        throw e;
    }

    context = await browser.newContext({
        storageState: storageState,
        viewport: null
    });

    const loadedCookies = await context.cookies();

    console.log("==================================");
    console.log("Cookies loaded into browser:", loadedCookies.length);

    console.log(
        loadedCookies
            .filter(c =>
                ["c_user", "xs", "fr", "datr", "sb"].includes(c.name)
            )
            .map(c => ({
                name: c.name,
                domain: c.domain,
                path: c.path,
                expires: c.expires,
                secure: c.secure,
                httpOnly: c.httpOnly
            }))
    );

    console.log("==================================");

    page = await context.newPage();
}

async function isLoggedOut() {
    await page.waitForTimeout(2000);
    const emailInput = await page.$('input[name="email"]');
    const passInput = await page.$('input[name="pass"]');
    if (emailInput || passInput) {
        return true;
    }
    const profileElement = await page.$('[aria-label="Your profile"]');
    if (profileElement) {
        return false;
    }
    // Also check url
    if (page.url().includes('login') || page.url().includes('checkpoint')) {
        return true;
    }
    return false;
}

async function ensureLoggedIn() {
    if (!context || !page) {
        await launchBrowser();
    }

    console.log("Navigating to Facebook to check session...");
    await page.goto("https://www.facebook.com/", { waitUntil: "domcontentloaded", timeout: 60000 });

    console.log("==================================");
    console.log("Current URL:", page.url());
    console.log("Current Title:", await page.title());

    const pageCookies = await context.cookies("https://www.facebook.com");

    console.log(
        pageCookies
            .filter(c =>
                ["c_user", "xs", "fr", "datr", "sb"].includes(c.name)
            )
            .map(c => ({
                name: c.name,
                valueLength: c.value.length,
                domain: c.domain
            }))
    );

    console.log("==================================");
    console.log("Current URL:", page.url());

    if (await isLoggedOut() || page.url().includes("/login")) {
        console.error("=============================================================");
        console.error("SESSION_EXPIRED: Facebook cookies are invalid or expired.");
        console.error("Please update facebook-cookies.json and restart.");
        console.error("=============================================================");
        throw new Error("SESSION_EXPIRED"); // Stop scraper immediately
    } else {
        console.log("Session verified via cookies. Already logged in.");
    }
}

async function restartBrowser() {
    await launchBrowser();
}

async function recoverSession() {
    await restartBrowser();
    await ensureLoggedIn();
}

module.exports = {
    launchBrowser,
    ensureLoggedIn,
    isLoggedOut,
    restartBrowser,
    recoverSession,
    getContext: () => context,
    getPage: () => page,
    close: async () => {
        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
    }
};
