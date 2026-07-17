const fs = require('fs');
let code = fs.readFileSync('scraper/scraper.js', 'utf16le');
const metaStart = code.indexOf('const extractMetadata = async (locator, passedBody = "") => {');
if (metaStart > -1) {
    const metaEndStr = '}, passedBody).catch(() => null);\n            };';
    const metaEnd = code.indexOf(metaEndStr, metaStart) + metaEndStr.length;
    const metaFunc = code.substring(metaStart, metaEnd);
    code = code.substring(0, metaStart) + code.substring(metaEnd);
    const insertPos = code.indexOf('// ===== VIDEO EXTRACTION IMPROVEMENT =====');
    code = code.substring(0, insertPos) + metaFunc + '\n\n' + code.substring(insertPos);
    code = code.replace('module.exports = { runOnceScrape, runScrapeCycle: runOnceScrape };', 'module.exports = { runOnceScrape, runScrapeCycle: runOnceScrape, extractMetadata, cleanPermalink, getVideoSignature, extractPlayableVideoUrl, isTodayPost, downloadToBuffer };');
    fs.writeFileSync('scraper/scraper.js', code, 'utf16le');
    console.log('Successfully refactored scraper.js');
} else {
    console.log('Could not find extractMetadata');
}
