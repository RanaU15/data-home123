const fs = require('fs');
let code = fs.readFileSync('scraper/scraper.js', 'utf16le');
function check(name, start, end) {
    if (code.indexOf(start) === -1) console.log(name + ' START failed');
    else if (code.indexOf(end, code.indexOf(start)) === -1) console.log(name + ' END failed');
    else console.log(name + ' OK');
}
check('getVideoSignature', 'function getVideoSignature(urlStr) {', '    }\n}\n');
check('downloadToBuffer', '// Helper function to download into memory', '    return null;\n}\n');
check('cleanPermalink', 'function cleanPermalink(url) {', '    }\n}\n');
check('isTodayPost', 'function isTodayPost(timestamp) {', '    return false;\n}\n');
check('extractPlayableVideoUrl', 'async function extractPlayableVideoUrl(context, permalink) {', '}\n');
check('extractMetadata', '            // --- META EXTRACTOR FUNCTION ---', '            };\n');
