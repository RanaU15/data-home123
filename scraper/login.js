// login.js
// AUTH REFACTOR: Using Persistent Browser Profile for manual login
const auth = require("./auth");

(async () => {
    // AUTH REFACTOR: Launch persistent profile directly
    await auth.launchBrowser();
    const page = auth.getPage();

    console.log("Navigating to Facebook...");
    await page.goto("https://www.facebook.com/login", { waitUntil: "domcontentloaded" });

    // AUTH REFACTOR: Wait indefinitely for manual login
    await auth.waitForManualLogin();
    
    // Wait until Facebook home page loads
    await page.waitForTimeout(5000);
    
    console.log("Closing browser. Profile automatically persisted.");
    const context = auth.getContext();
    await context.close();
})();
