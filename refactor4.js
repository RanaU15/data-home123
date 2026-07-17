const fs = require('fs');
const path = require('path');

const scraperPath = path.join(__dirname, 'scraper', 'scraper.js');
let code = fs.readFileSync(scraperPath, 'utf8');

function extractAndRemove(name, startPattern, endPattern) {
    const start = code.indexOf(startPattern);
    if (start === -1) {
        console.error(`Could not find START for ${name}`);
        return null;
    }
    const end = code.indexOf(endPattern, start);
    if (end === -1) {
        console.error(`Could not find END for ${name}`);
        return null;
    }
    const funcCode = code.substring(start, end + endPattern.length);
    code = code.substring(0, start) + code.substring(end + endPattern.length);
    return funcCode;
}

const getVideoSignature = extractAndRemove('getVideoSignature', 'function getVideoSignature', '    }\n}\n');
const downloadToBuffer = extractAndRemove('downloadToBuffer', 'async function downloadToBuffer', '    return null;\n}\n');
const cleanPermalink = extractAndRemove('cleanPermalink', 'function cleanPermalink', '    }\n}\n');
const isTodayPost = extractAndRemove('isTodayPost', 'function isTodayPost', '    return false;\n}\n');
const extractPlayableVideoUrl = extractAndRemove('extractPlayableVideoUrl', 'async function extractPlayableVideoUrl', '    return Array.from(new Set([extractedMp4, extractedHls, ...backupVideoUrls].filter(Boolean)));\n}\n');
const extractMetadata = extractAndRemove('extractMetadata', '            const extractMetadata = async', '}, passedBody).catch(() => null);\n            };\n');

if (!getVideoSignature || !downloadToBuffer || !cleanPermalink || !isTodayPost || !extractPlayableVideoUrl || !extractMetadata) {
    console.error("Failed to extract one or more functions");
    process.exit(1);
}

// Write extractors.js
const extractorsCode = `const https = require('https');
const http = require('http');

${getVideoSignature}

${downloadToBuffer}

${cleanPermalink}

${isTodayPost}

${extractPlayableVideoUrl}

${extractMetadata.replace('            const extractMetadata = async', 'const extractMetadata = async')}

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

// Remove the eval logic from backfillHistorical.js
const backfillPath = path.join(__dirname, 'scraper', 'backfillHistorical.js');
let backfillCode = fs.readFileSync(backfillPath, 'utf8');
const dynStart = backfillCode.indexOf('// ==========================================');
const dynEnd = backfillCode.indexOf('// Helper for generating fingerprint');
backfillCode = backfillCode.substring(0, dynStart) + importStatement + backfillCode.substring(dynEnd);
fs.writeFileSync(backfillPath, backfillCode, 'utf8');

fs.writeFileSync(scraperPath, code, 'utf8');
console.log("Successfully refactored!");
