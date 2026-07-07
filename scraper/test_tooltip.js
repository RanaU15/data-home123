const playwright = require('playwright');
const fs = require('fs');

async function test() {
  const cookiesStr = fs.readFileSync('facebook-cookies.json', 'utf8');
  const cookies = JSON.parse(cookiesStr);
  
  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.addCookies(cookies);
  const page = await context.newPage();
  
  await page.goto('https://www.facebook.com/groups/658561818123997', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000); // let feed load
  
  const els = await page.$$('a[role="link"]');
  for (const el of els) {
      const attrs = await page.evaluate(node => {
          if (!node || !node.getAttribute) return null;
          let text = node.innerText || '';
          if (text.includes('just now') || text.match(/^(\d+h|\d+m|yesterday)/i) || (node.getAttribute('aria-label') && node.getAttribute('aria-label').match(/\d/))) {
               return {
                  text,
                  ariaLabel: node.getAttribute('aria-label'),
                  childAria: node.querySelector('[aria-label]') ? node.querySelector('[aria-label]').getAttribute('aria-label') : null,
                  html: node.outerHTML
               };
          }
          return null;
      }, el);
      if (attrs) {
          console.log('FOUND TIMESTAMP ANCHOR', attrs);
          // hover it
          await el.hover({ force: true });
          await page.waitForTimeout(1500);
          
          // find any div containing 'at '
          const tooltips = await page.evaluate(() => {
              return Array.from(document.querySelectorAll('div, span')).filter(n => n.innerText && n.innerText.includes(' at ') && n.innerText.length < 50).map(n => ({ text: n.innerText, id: n.id, role: n.getAttribute('role') }));
          });
          console.log('Tooltips found:', tooltips);
          
          break; 
      }
  }
  await browser.close();
}
test();
