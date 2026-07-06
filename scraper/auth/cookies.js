const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const COOKIES_FILE = path.join(__dirname, '../facebook-cookies.json');

/**
 * Loads raw cookies from JSON and converts them into Playwright storageState format
 */
function loadCookiesIntoStorageState() {
    if (!fs.existsSync(COOKIES_FILE)) {
        throw new Error(`Cookies file not found at ${COOKIES_FILE}`);
    }

    const rawCookies = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf-8'));

    // Map cookies to ensure they match Playwright's expected format if needed
    const mappedCookies = rawCookies.map(cookie => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        expires: cookie.expirationDate || (Date.now() / 1000) + 86400,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: cookie.sameSite === 'no_restriction' ? 'None' : (cookie.sameSite === 'lax' ? 'Lax' : (cookie.sameSite === 'strict' ? 'Strict' : 'None'))
    }));

    return {
        cookies: mappedCookies,
        origins: [] // Local storage/session storage origins if needed
    };
}

module.exports = {
    loadCookiesIntoStorageState
};
