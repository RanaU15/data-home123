const fs = require('fs');
const path = require('path');

const scraperPath = path.join(__dirname, 'scraper', 'scraper.js');
let code = fs.readFileSync(scraperPath, 'utf16le');

function extractAndRemove(name, startPattern, endPattern) {
    const start = code.indexOf(startPattern);
    if (start === -1) return null;
    const end = code.indexOf(endPattern, start) + endPattern.length;
    const funcCode = code.substring(start, end);
    // Remove from code
    code = code.substring(0, start) + code.substring(end);
    return funcCode;
}

// 1. getVideoSignature
const getVideoSignature = extractAndRemove('getVideoSignature', 'function getVideoSignature(urlStr) {', '    }\n}\n');

// 2. downloadToBuffer
const downloadToBuffer = extractAndRemove('downloadToBuffer', '// Helper function to download into memory', '    return null;\n}\n');

// 3. cleanPermalink
const cleanPermalink = extractAndRemove('cleanPermalink', '// Clean and normalize permalinks', '    }\n}\n');

// 4. isTodayPost
const isTodayPost = extractAndRemove('isTodayPost', '// Timestamp Detection:', '    return false;\n}\n');

// 5. extractPlayableVideoUrl
const extractPlayableVideoUrl = extractAndRemove('extractPlayableVideoUrl', '// ===== VIDEO EXTRACTION IMPROVEMENT =====', '    return Array.from(new Set([extractedMp4, extractedHls, ...backupVideoUrls].filter(Boolean)));\n}\n');

// 6. extractMetadata
const metaStartStr = '            // --- META EXTRACTOR FUNCTION ---\n            const extractMetadata = async (locator, passedBody = "") => {';
const metaEndStr = '}, passedBody).catch(() => null);\n            };\n';
const extractMetadata = extractAndRemove('extractMetadata', metaStartStr, metaEndStr);

if (!getVideoSignature || !downloadToBuffer || !cleanPermalink || !isTodayPost || !extractPlayableVideoUrl || !extractMetadata) {
    console.error("Failed to find one or more functions");
    process.exit(1);
}

// Generate extractors.js
const extractorsCode = `const https = require('https');
const http = require('http');

${getVideoSignature}

${downloadToBuffer}

${cleanPermalink}

${isTodayPost}

${extractPlayableVideoUrl}

${extractMetadata.replace('            // --- META EXTRACTOR FUNCTION ---\n            const', 'const')}

module.exports = {
    getVideoSignature,
    downloadToBuffer,
    cleanPermalink,
    isTodayPost,
    extractPlayableVideoUrl,
    extractMetadata
};
`;

fs.writeFileSync(path.join(__dirname, 'scraper', 'extractors.js'), extractorsCode, 'utf8');

// Insert imports into scraper.js
const importStatement = `const {
    getVideoSignature,
    downloadToBuffer,
    cleanPermalink,
    isTodayPost,
    extractPlayableVideoUrl,
    extractMetadata
} = require('./extractors');\n\n`;

const insertPos = code.indexOf('// Configuration for Multiple Groups');
code = code.substring(0, insertPos) + importStatement + code.substring(insertPos);

fs.writeFileSync(scraperPath, code, 'utf16le');
console.log("Successfully refactored scraper.js into extractors.js");
