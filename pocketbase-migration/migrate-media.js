/*
 * ============================================================
 * SUPABASE → POCKETBASE MEDIA MIGRATION
 * ============================================================
 *
 * Features:
 * - Dry-run is completely read-only
 * - Loads .env automatically
 * - Migrates only Supabase Storage media referenced by posts
 * - Images → migrated_images
 * - Videos → migrated_videos
 * - Video thumbnails → migrated_video_thumbnails
 * - Resumable
 * - Avoids duplicate files
 * - Retries failed downloads/uploads
 * - Supports --limit=N
 * - Continues from the last incomplete post
 * - Windows-safe state-file handling
 * - Does NOT delete anything from Supabase
 *
 * Usage:
 *
 *   node migrate-media.js --dry-run
 *
 *   node migrate-media.js --limit=1
 *
 *   node migrate-media.js --limit=10
 *
 *   node migrate-media.js
 *
 * ============================================================
 */

const process = require("node:process");
const fs = require("node:fs");
const path = require("node:path");
const PocketBase = require("pocketbase").default;

// ------------------------------------------------------------
// LOAD .ENV
// ------------------------------------------------------------

try {
    process.loadEnvFile(".env");
} catch (_) {
    // .env is optional if variables already exist.
}

// ------------------------------------------------------------
// CONFIG
// ------------------------------------------------------------

const SUPABASE_URL =
    process.env.SUPABASE_URL ||
    "https://gimjsxpwteluwiopcrqq.supabase.co";

const SUPABASE_SERVICE_ROLE_KEY =
    process.env.SUPABASE_SERVICE_ROLE_KEY;

const PB_URL =
    process.env.PB_URL ||
    "https://pbflat.formics.io";

const PB_EMAIL =
    process.env.PB_EMAIL;

const PB_PASSWORD =
    process.env.PB_PASSWORD;

const DRY_RUN =
    process.argv.includes("--dry-run");

// Number of different posts processed simultaneously.
const CONCURRENCY = 5;

// Download retry count.
const RETRIES = 3;

// State file.
const STATE_FILE =
    path.join(__dirname, "media-migration-state.json");

// ------------------------------------------------------------
// LIMIT
// ------------------------------------------------------------

const limitArg = process.argv.find(arg =>
    arg.startsWith("--limit=")
);

let LIMIT = null;

if (limitArg) {
    const parsed = Number.parseInt(
        limitArg.substring("--limit=".length),
        10
    );

    if (!Number.isInteger(parsed) || parsed < 1) {
        console.error("");
        console.error("Invalid --limit value.");
        console.error(
            "Example: node migrate-media.js --limit=1"
        );
        console.error(
            "Example: node migrate-media.js --limit=10"
        );
        process.exit(1);
    }

    LIMIT = parsed;
}

// ------------------------------------------------------------
// VALIDATE ENV
// ------------------------------------------------------------

if (!SUPABASE_URL) {
    console.error("Missing SUPABASE_URL");
    process.exit(1);
}

if (!SUPABASE_SERVICE_ROLE_KEY) {
    console.error(
        "Missing SUPABASE_SERVICE_ROLE_KEY"
    );

    console.error(
        "Use .env or set the PowerShell environment variable."
    );

    process.exit(1);
}

if (!PB_EMAIL || !PB_PASSWORD) {
    console.error(
        "Missing PocketBase credentials."
    );

    console.error("");
    console.error("Required:");
    console.error("PB_EMAIL");
    console.error("PB_PASSWORD");

    process.exit(1);
}

// ------------------------------------------------------------
// POCKETBASE
// ------------------------------------------------------------

const pb = new PocketBase(PB_URL);

// IMPORTANT:
// Disable SDK auto cancellation.
// Different posts must be allowed to run independently.
pb.autoCancellation(false);

// ------------------------------------------------------------
// STATE
// ------------------------------------------------------------

function createEmptyState() {
    return {
        uploaded: {},
        failed: {},
        nextGroupIndex: 0
    };
}

// ------------------------------------------------------------
// LOAD STATE
// ------------------------------------------------------------

function loadState() {
    if (!fs.existsSync(STATE_FILE)) {
        return createEmptyState();
    }

    try {
        const parsed =
            JSON.parse(
                fs.readFileSync(
                    STATE_FILE,
                    "utf8"
                )
            );

        return {
            uploaded:
                parsed.uploaded || {},

            failed:
                parsed.failed || {},

            nextGroupIndex:
                Number.isInteger(
                    parsed.nextGroupIndex
                )
                    ? parsed.nextGroupIndex
                    : 0
        };
    } catch (error) {
        console.warn("");
        console.warn(
            "Could not read state file."
        );
        console.warn(
            "Starting with a fresh state."
        );
        console.warn(
            error.message
        );

        return createEmptyState();
    }
}

// ------------------------------------------------------------
// WINDOWS-SAFE STATE SAVE
// ------------------------------------------------------------
//
// Previous version used:
//
//   media-migration-state.json.tmp
//
// Multiple state saves + Windows file locking could cause:
//
//   EPERM: operation not permitted, rename
//
// This version:
// - creates a UNIQUE temp file
// - retries rename several times
// - cleans up temp files
// - falls back to direct write if necessary
//
// ------------------------------------------------------------

function saveState(state) {
    const data =
        JSON.stringify(
            state,
            null,
            2
        );

    let lastError = null;

    // Try multiple times because Windows Defender,
    // indexing, antivirus, etc. can temporarily lock files.
    for (
        let attempt = 1;
        attempt <= 10;
        attempt++
    ) {
        const tempFile =
            `${STATE_FILE}.${process.pid}.${Date.now()}.${Math.random()
                .toString(36)
                .slice(2)}.tmp`;

        try {
            // Write a completely separate temp file.
            fs.writeFileSync(
                tempFile,
                data,
                {
                    encoding: "utf8",
                    flag: "w"
                }
            );

            // Atomic replacement.
            fs.renameSync(
                tempFile,
                STATE_FILE
            );

            return;
        } catch (error) {
            lastError = error;

            // Try removing our temp file.
            try {
                if (fs.existsSync(tempFile)) {
                    fs.unlinkSync(tempFile);
                }
            } catch (_) {
                // Ignore cleanup errors.
            }

            // Small synchronous delay.
            // This is intentionally synchronous because
            // saveState itself is synchronous.
            if (attempt < 10) {
                const waitUntil =
                    Date.now() +
                    Math.min(
                        250 * attempt,
                        1500
                    );

                while (
                    Date.now() <
                    waitUntil
                ) {
                    // Wait.
                }
            }
        }
    }

    // --------------------------------------------------------
    // FALLBACK
    // --------------------------------------------------------
    //
    // If Windows still refuses rename after 10 attempts,
    // directly write the state file.
    //
    // This is less atomic but prevents the entire migration
    // from crashing only because of a temporary Windows lock.
    //
    try {
        fs.writeFileSync(
            STATE_FILE,
            data,
            "utf8"
        );

        console.warn("");
        console.warn(
            "⚠ State file atomic rename was locked."
        );
        console.warn(
            "✓ State was saved using fallback write."
        );

        return;
    } catch (fallbackError) {
        console.error("");
        console.error(
            "❌ Could not save migration state."
        );
        console.error(
            "Original error:",
            lastError?.message
        );
        console.error(
            "Fallback error:",
            fallbackError.message
        );

        throw fallbackError;
    }
}

// ------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------

function sleep(ms) {
    return new Promise(
        resolve =>
            setTimeout(
                resolve,
                ms
            )
    );
}

// ------------------------------------------------------------
// SUPABASE STORAGE URL
// ------------------------------------------------------------

function isSupabaseStorageUrl(value) {
    if (typeof value !== "string") {
        return false;
    }

    return value.includes(
        ".supabase.co/storage/v1/object/"
    );
}

// ------------------------------------------------------------
// STORAGE PATH
// ------------------------------------------------------------
//
// Supports:
//
// /storage/v1/object/public/images/xxx.jpg
// /storage/v1/object/authenticated/images/xxx.jpg
// /storage/v1/object/sign/images/xxx.jpg
//
// Returns:
//
// images/xxx.jpg
//
// ------------------------------------------------------------

function getStoragePath(url) {
    try {
        const parsed =
            new URL(url);

        const marker =
            "/storage/v1/object/";

        const index =
            parsed.pathname.indexOf(
                marker
            );

        if (index === -1) {
            return null;
        }

        const remaining =
            parsed.pathname.substring(
                index + marker.length
            );

        const parts =
            remaining.split("/");

        if (parts.length < 2) {
            return null;
        }

        // Remove:
        // public
        // authenticated
        // sign
        //
        // if present.
        const first =
            parts[0];

        if (
            first === "public" ||
            first === "authenticated" ||
            first === "sign"
        ) {
            parts.shift();
        }

        return decodeURIComponent(
            parts.join("/")
        );
    } catch (_) {
        return null;
    }
}

// ------------------------------------------------------------
// FILE NAME
// ------------------------------------------------------------

function getFileName(url) {
    const storagePath =
        getStoragePath(url);

    if (!storagePath) {
        return null;
    }

    return path.basename(
        storagePath
    );
}

// ------------------------------------------------------------
// BUCKET
// ------------------------------------------------------------

function getBucket(url) {
    const storagePath =
        getStoragePath(url);

    if (!storagePath) {
        return null;
    }

    const parts =
        storagePath.split("/");

    /*
     * Expected:
     *
     * images/post_images/xxx.jpg
     * videos/videos/xxx.mp4
     */

    return parts[0] || null;
}

// ------------------------------------------------------------
// MEDIA TYPE
// ------------------------------------------------------------

function getMediaType(
    url,
    fieldName = ""
) {
    const lowerUrl =
        url.toLowerCase();

    const lowerField =
        fieldName.toLowerCase();

    // video_thumbnail field always wins.
    if (
        lowerField.includes(
            "thumbnail"
        )
    ) {
        return "thumbnail";
    }

    if (
        lowerUrl.includes(
            "/videos/"
        ) ||
        /\.(mp4|mov|avi|webm|mkv|m4v)(\?|$)/i.test(
            lowerUrl
        )
    ) {
        return "video";
    }

    if (
        lowerUrl.includes(
            "/images/"
        ) ||
        /\.(jpg|jpeg|png|gif|webp|heic|bmp)(\?|$)/i.test(
            lowerUrl
        )
    ) {
        return "image";
    }

    return null;
}

// ------------------------------------------------------------
// SUPABASE REQUEST
// ------------------------------------------------------------

async function supabaseRequest(
    endpoint,
    options = {}
) {
    const url =
        `${SUPABASE_URL}/rest/v1/${endpoint}`;

    const response =
        await fetch(
            url,
            {
                ...options,

                headers: {
                    apikey:
                        SUPABASE_SERVICE_ROLE_KEY,

                    Authorization:
                        `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,

                    "Content-Type":
                        "application/json",

                    ...(options.headers || {})
                }
            }
        );

    if (!response.ok) {
        const text =
            await response.text();

        throw new Error(
            `Supabase ${response.status}: ${text}`
        );
    }

    return response.json();
}

// ------------------------------------------------------------
// LOAD SUPABASE POSTS
// ------------------------------------------------------------

async function loadSupabasePosts() {
    console.log("");
    console.log(
        "Reading Supabase posts..."
    );

    const allPosts = [];

    const pageSize = 500;

    let offset = 0;

    while (true) {
        const endpoint =
            `posts?select=*&offset=${offset}&limit=${pageSize}`;

        const rows =
            await supabaseRequest(
                endpoint
            );

        if (!rows.length) {
            break;
        }

        allPosts.push(
            ...rows
        );

        console.log(
            `  Loaded ${allPosts.length} Supabase posts`
        );

        if (
            rows.length <
            pageSize
        ) {
            break;
        }

        offset += pageSize;
    }

    console.log(
        `✓ Supabase posts: ${allPosts.length}`
    );

    return allPosts;
}

// ------------------------------------------------------------
// LOAD POCKETBASE POSTS
// ------------------------------------------------------------

async function loadPocketBasePosts() {
    console.log("");
    console.log(
        "Reading PocketBase posts..."
    );

    const records =
        await pb
            .collection("posts")
            .getFullList({
                batch: 500,

                fields:
                    "id,supabase_id"
            });

    console.log(
        `  Found ${records.length} PocketBase posts`
    );

    const map =
        new Map();

    for (
        const record
        of records
    ) {
        if (record.supabase_id) {
            map.set(
                String(
                    record.supabase_id
                ),
                record
            );
        }
    }

    console.log(
        `✓ PocketBase posts with supabase_id: ${map.size}`
    );

    return map;
}

// ------------------------------------------------------------
// EXTRACT URLS
// ------------------------------------------------------------

function collectUrls(
    value,
    output,
    fieldName = ""
) {
    if (!value) {
        return;
    }

    if (
        typeof value === "string"
    ) {
        if (
            isSupabaseStorageUrl(
                value
            )
        ) {
            output.push({
                url: value,
                field: fieldName
            });
        }

        return;
    }

    if (
        Array.isArray(value)
    ) {
        for (
            const item
            of value
        ) {
            collectUrls(
                item,
                output,
                fieldName
            );
        }

        return;
    }

    if (
        typeof value === "object"
    ) {
        for (
            const [
                key,
                item
            ]
            of Object.entries(value)
        ) {
            collectUrls(
                item,
                output,
                key
            );
        }
    }
}

// ------------------------------------------------------------
// EXTRACT POST MEDIA
// ------------------------------------------------------------

function extractPostMedia(post) {
    const media = [];

    /*
     * Only scan known media fields.
     *
     * This prevents unrelated Supabase
     * Storage URLs from being migrated.
     */

    const fields = [
        "images",
        "image_urls",
        "video_urls",
        "video_thumbnail"
    ];

    for (
        const field
        of fields
    ) {
        if (
            post[field] !== undefined &&
            post[field] !== null
        ) {
            collectUrls(
                post[field],
                media,
                field
            );
        }
    }

    // Remove duplicate URLs within this post.
    const seen =
        new Set();

    return media.filter(
        item => {
            if (
                seen.has(
                    item.url
                )
            ) {
                return false;
            }

            seen.add(
                item.url
            );

            return true;
        }
    );
}

// ------------------------------------------------------------
// BUILD MEDIA MAP
// ------------------------------------------------------------

function buildMediaMap(
    supabasePosts,
    pbPosts
) {
    console.log("");
    console.log(
        "Analyzing media references..."
    );

    const media = [];

    let missingPosts = 0;

    for (
        const post
        of supabasePosts
    ) {
        const supabaseId =
            String(
                post.id
            );

        const pbPost =
            pbPosts.get(
                supabaseId
            );

        if (!pbPost) {
            missingPosts++;
            continue;
        }

        const urls =
            extractPostMedia(
                post
            );

        for (
            const item
            of urls
        ) {
            const type =
                getMediaType(
                    item.url,
                    item.field
                );

            if (!type) {
                continue;
            }

            const fileName =
                getFileName(
                    item.url
                );

            if (!fileName) {
                continue;
            }

            media.push({
                postId:
                    pbPost.id,

                supabasePostId:
                    supabaseId,

                url:
                    item.url,

                field:
                    item.field,

                type,

                bucket:
                    getBucket(
                        item.url
                    ),

                fileName
            });
        }
    }

    /*
     * Unique by:
     *
     * post + URL
     */

    const uniqueMap =
        new Map();

    for (
        const item
        of media
    ) {
        const key =
            `${item.postId}|${item.url}`;

        if (
            !uniqueMap.has(
                key
            )
        ) {
            uniqueMap.set(
                key,
                item
            );
        }
    }

    const uniqueMedia =
        [
            ...uniqueMap.values()
        ];

    const images =
        uniqueMedia.filter(
            x =>
                x.type === "image"
        );

    const videos =
        uniqueMedia.filter(
            x =>
                x.type === "video"
        );

    const thumbnails =
        uniqueMedia.filter(
            x =>
                x.type === "thumbnail"
        );

    console.log(
        `  Found ${media.length} storage references`
    );

    console.log(
        `  Found ${uniqueMedia.length} unique storage files`
    );

    console.log(
        `  Unique images: ${images.length}`
    );

    console.log(
        `  Unique videos: ${videos.length}`
    );

    console.log(
        `  Video thumbnails: ${thumbnails.length}`
    );

    console.log(
        `  Missing PB posts: ${missingPosts}`
    );

    return {
        all:
            uniqueMedia,

        images,

        videos,

        thumbnails,

        missingPosts
    };
}

// ------------------------------------------------------------
// ENSURE POCKETBASE MEDIA FIELDS
// ------------------------------------------------------------

async function ensureMediaFields() {
    console.log("");
    console.log(
        "Checking PocketBase posts collection..."
    );

    const collection =
        await pb
            .collections
            .getOne("posts");

    const existing =
        new Set(
            collection.fields.map(
                field =>
                    field.name
            )
        );

    const fieldsToAdd = [
        {
            name:
                "migrated_images",

            maxSelect:
                99,

            maxSize:
                "100MB",

            mimeTypes: [
                "image/jpeg",
                "image/png",
                "image/gif",
                "image/webp",
                "image/heic",
                "image/bmp"
            ]
        },

        {
            name:
                "migrated_videos",

            maxSelect:
                99,

            maxSize:
                "100MB",

            mimeTypes: [
                "video/mp4",
                "video/quicktime",
                "video/webm",
                "video/x-msvideo",
                "video/x-matroska"
            ]
        },

        {
            name:
                "migrated_video_thumbnails",

            maxSelect:
                99,

            maxSize:
                "100MB",

            mimeTypes: [
                "image/jpeg",
                "image/png",
                "image/webp"
            ]
        }
    ];

    let changed = false;

    for (
        const field
        of fieldsToAdd
    ) {
        if (
            existing.has(
                field.name
            )
        ) {
            console.log(
                `  ✓ ${field.name} already exists`
            );

            continue;
        }

        console.log(
            `  + Adding ${field.name}`
        );

        collection.fields.push({
            type:
                "file",

            id:
                field.name,

            name:
                field.name,

            system:
                false,

            hidden:
                false,

            presentable:
                false,

            maxSelect:
                field.maxSelect,

            maxSize:
                field.maxSize,

            mimeTypes:
                field.mimeTypes,

            thumbs:
                [],

            protected:
                false,

            collectionId:
                collection.id
        });

        changed = true;
    }

    if (changed) {
        await pb
            .collections
            .update(
                collection.id,
                collection
            );

        console.log(
            "  ✓ PocketBase schema updated."
        );
    } else {
        console.log(
            "  ✓ No schema changes required."
        );
    }
}

// ------------------------------------------------------------
// DOWNLOAD FILE
// ------------------------------------------------------------

async function downloadFile(
    url
) {
    let lastError;

    for (
        let attempt = 1;
        attempt <= RETRIES;
        attempt++
    ) {
        try {
            const response =
                await fetch(
                    url,
                    {
                        headers: {
                            apikey:
                                SUPABASE_SERVICE_ROLE_KEY,

                            Authorization:
                                `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
                        }
                    }
                );

            if (!response.ok) {
                throw new Error(
                    `Download failed: HTTP ${response.status}`
                );
            }

            const buffer =
                Buffer.from(
                    await response.arrayBuffer()
                );

            if (!buffer.length) {
                throw new Error(
                    "Downloaded file is empty"
                );
            }

            return buffer;
        } catch (error) {
            lastError =
                error;

            console.warn(
                `      Download attempt ${attempt}/${RETRIES} failed: ${error.message}`
            );

            if (
                attempt <
                RETRIES
            ) {
                await sleep(
                    1000 * attempt
                );
            }
        }
    }

    throw lastError;
}

// ------------------------------------------------------------
// GET CURRENT POCKETBASE FILES
// ------------------------------------------------------------

async function getExistingFiles(
    postId
) {
    const record =
        await pb
            .collection("posts")
            .getOne(
                postId,
                {
                    fields:
                        "id,migrated_images,migrated_videos,migrated_video_thumbnails"
                }
            );

    return {
        images:
            Array.isArray(
                record.migrated_images
            )
                ? [
                    ...record.migrated_images
                ]
                : [],

        videos:
            Array.isArray(
                record.migrated_videos
            )
                ? [
                    ...record.migrated_videos
                ]
                : [],

        thumbnails:
            Array.isArray(
                record.migrated_video_thumbnails
            )
                ? [
                    ...record.migrated_video_thumbnails
                ]
                : []
    };
}

// ------------------------------------------------------------
// GET TARGET FIELD
// ------------------------------------------------------------

function getTargetField(
    type
) {
    if (
        type === "image"
    ) {
        return "migrated_images";
    }

    if (
        type === "video"
    ) {
        return "migrated_videos";
    }

    return "migrated_video_thumbnails";
}

// ------------------------------------------------------------
// GET EXISTING ARRAY NAME
// ------------------------------------------------------------

function getExistingArrayName(
    type
) {
    if (
        type === "image"
    ) {
        return "images";
    }

    if (
        type === "video"
    ) {
        return "videos";
    }

    return "thumbnails";
}

// ------------------------------------------------------------
// MIME TYPE
// ------------------------------------------------------------

function getMimeType(
    fileName,
    type
) {
    const ext =
        path
            .extname(
                fileName
            )
            .toLowerCase();

    const map = {
        ".jpg":
            "image/jpeg",

        ".jpeg":
            "image/jpeg",

        ".png":
            "image/png",

        ".gif":
            "image/gif",

        ".webp":
            "image/webp",

        ".heic":
            "image/heic",

        ".bmp":
            "image/bmp",

        ".mp4":
            "video/mp4",

        ".mov":
            "video/quicktime",

        ".webm":
            "video/webm",

        ".avi":
            "video/x-msvideo",

        ".mkv":
            "video/x-matroska",

        ".m4v":
            "video/mp4"
    };

    return (
        map[ext] ||
        (
            type === "video"
                ? "video/mp4"
                : "image/jpeg"
        )
    );
}

// ------------------------------------------------------------
// UPLOAD ONE FILE
// ------------------------------------------------------------

async function uploadFile(
    item,
    existing
) {
    const targetField =
        getTargetField(
            item.type
        );

    const existingArrayName =
        getExistingArrayName(
            item.type
        );

    const existingFiles =
        existing[
        existingArrayName
        ];

    /*
     * Check by original filename.
     *
     * This prevents duplicate uploads
     * when the script is restarted.
     */

    const alreadyExists =
        existingFiles.some(
            file =>
                file &&
                file.name ===
                item.fileName
        );

    if (alreadyExists) {
        return {
            skipped:
                true,

            reason:
                "already exists"
        };
    }

    console.log(
        `      Downloading: ${item.fileName}`
    );

    const buffer =
        await downloadFile(
            item.url
        );

    const mime =
        getMimeType(
            item.fileName,
            item.type
        );

    const file =
        new File(
            [buffer],
            item.fileName,
            {
                type:
                    mime
            }
        );

    const form =
        new FormData();

    /*
     * "+" means APPEND.
     *
     * Without "+" PocketBase would replace
     * the existing file field.
     */

    form.append(
        `${targetField}+`,
        file
    );

    await pb
        .collection("posts")
        .update(
            item.postId,
            form
        );

    return {
        uploaded:
            true,

        fileName:
            item.fileName,

        size:
            buffer.length
    };
}

// ------------------------------------------------------------
// PROCESS POST
// ------------------------------------------------------------

async function processPost(
    postId,
    items,
    state
) {
    /*
     * Read PocketBase first.
     *
     * This is important for resumability.
     *
     * Even if the state file says something was
     * uploaded, we verify the actual PB files.
     */

    const existing =
        await getExistingFiles(
            postId
        );

    let uploaded = 0;
    let skipped = 0;
    let failed = 0;

    for (
        const item
        of items
    ) {
        const key =
            `${postId}|${item.url}`;

        try {
            const result =
                await uploadFile(
                    item,
                    existing
                );

            if (
                result.skipped
            ) {
                skipped++;

                state.uploaded[key] = {
                    fileName:
                        item.fileName,

                    type:
                        item.type,

                    reason:
                        result.reason,

                    timestamp:
                        new Date().toISOString()
                };

                delete state.failed[key];

                // Save immediately.
                saveState(
                    state
                );

                console.log(
                    `      ↪ Skipped ${item.fileName} (${result.reason})`
                );

                continue;
            }

            uploaded++;

            state.uploaded[key] = {
                fileName:
                    item.fileName,

                type:
                    item.type,

                timestamp:
                    new Date().toISOString()
            };

            delete state.failed[key];

            /*
             * Add uploaded file to local existing list.
             *
             * Prevents duplicate upload attempts
             * inside the same post.
             */

            const arrayName =
                getExistingArrayName(
                    item.type
                );

            if (
                !existing[arrayName].some(
                    file =>
                        file &&
                        file.name ===
                        item.fileName
                )
            ) {
                existing[arrayName].push({
                    name:
                        item.fileName
                });
            }

            saveState(
                state
            );

            console.log(
                `      ✓ Uploaded ${item.fileName}`
            );
        } catch (error) {
            failed++;

            state.failed[key] = {
                postId:
                    item.postId,

                url:
                    item.url,

                fileName:
                    item.fileName,

                error:
                    error.message,

                timestamp:
                    new Date().toISOString()
            };

            saveState(
                state
            );

            console.error(
                `      ✗ FAILED ${item.fileName}: ${error.message}`
            );
        }
    }

    return {
        uploaded,
        skipped,
        failed
    };
}

// ------------------------------------------------------------
// CHECK GROUP COMPLETION
// ------------------------------------------------------------

function isGroupComplete(
    group,
    state
) {
    return group.items.every(
        item => {
            const key =
                `${item.postId}|${item.url}`;

            return Boolean(
                state.uploaded[key]
            );
        }
    );
}

// ------------------------------------------------------------
// FIND NEXT INCOMPLETE GROUP
// ------------------------------------------------------------

function findNextIncompleteIndex(
    groups,
    state
) {
    for (
        let i = 0;
        i < groups.length;
        i++
    ) {
        if (
            !isGroupComplete(
                groups[i],
                state
            )
        ) {
            return i;
        }
    }

    return groups.length;
}

// ------------------------------------------------------------
// CONCURRENCY RUNNER
// ------------------------------------------------------------

async function runConcurrent(
    groups,
    state
) {
    let nextIndex = 0;

    let totalUploaded = 0;
    let totalSkipped = 0;
    let totalFailed = 0;

    async function worker() {
        while (true) {
            const index =
                nextIndex++;

            if (
                index >=
                groups.length
            ) {
                return;
            }

            const group =
                groups[index];

            console.log("");
            console.log(
                `[${index + 1}/${groups.length}] Post ${group.postId}`
            );

            const result =
                await processPost(
                    group.postId,
                    group.items,
                    state
                );

            totalUploaded +=
                result.uploaded;

            totalSkipped +=
                result.skipped;

            totalFailed +=
                result.failed;

            console.log(
                `      Uploaded: ${result.uploaded} | Skipped: ${result.skipped} | Failed: ${result.failed}`
            );
        }
    }

    const workers = [];

    for (
        let i = 0;
        i <
        Math.min(
            CONCURRENCY,
            groups.length
        );
        i++
    ) {
        workers.push(
            worker()
        );
    }

    await Promise.all(
        workers
    );

    return {
        uploaded:
            totalUploaded,

        skipped:
            totalSkipped,

        failed:
            totalFailed
    };
}

// ------------------------------------------------------------
// GROUP MEDIA BY POST
// ------------------------------------------------------------

function groupByPost(
    media
) {
    const map =
        new Map();

    for (
        const item
        of media
    ) {
        if (
            !map.has(
                item.postId
            )
        ) {
            map.set(
                item.postId,
                []
            );
        }

        map.get(
            item.postId
        ).push(item);
    }

    return [
        ...map.entries()
    ].map(
        ([postId, items]) => ({
            postId,
            items
        })
    );
}

// ------------------------------------------------------------
// PRINT STATE
// ------------------------------------------------------------

function printStateSummary(
    state,
    groups
) {
    const uploadedCount =
        Object.keys(
            state.uploaded || {}
        ).length;

    const failedCount =
        Object.keys(
            state.failed || {}
        ).length;

    const nextIndex =
        findNextIncompleteIndex(
            groups,
            state
        );

    console.log("");
    console.log(
        "Resume state:"
    );

    console.log(
        `  Uploaded state entries: ${uploadedCount}`
    );

    console.log(
        `  Failed state entries:   ${failedCount}`
    );

    console.log(
        `  Next incomplete post:   ${nextIndex + 1}/${groups.length}`
    );
}

// ------------------------------------------------------------
// MAIN
// ------------------------------------------------------------

async function main() {
    console.log("");
    console.log(
        "========================================"
    );

    console.log(
        "SUPABASE → POCKETBASE MEDIA MIGRATION"
    );

    console.log(
        "========================================"
    );

    console.log(
        `PocketBase: ${PB_URL}`
    );

    console.log(
        `Mode: ${DRY_RUN
            ? "DRY RUN"
            : "REAL MIGRATION"
        }`
    );

    if (LIMIT !== null) {
        console.log(
            `Batch limit: ${LIMIT} post(s)`
        );
    } else {
        console.log(
            "Batch limit: NONE (full migration)"
        );
    }

    // --------------------------------------------------------
    // AUTH POCKETBASE
    // --------------------------------------------------------

    console.log("");
    console.log(
        "Authenticating PocketBase..."
    );

    await pb
        .collection("_superusers")
        .authWithPassword(
            PB_EMAIL,
            PB_PASSWORD
        );

    console.log(
        "✓ PocketBase authenticated."
    );

    // --------------------------------------------------------
    // READ SOURCE / TARGET
    // --------------------------------------------------------

    const supabasePosts =
        await loadSupabasePosts();

    const pbPosts =
        await loadPocketBasePosts();

    // --------------------------------------------------------
    // ANALYZE
    // --------------------------------------------------------

    const media =
        buildMediaMap(
            supabasePosts,
            pbPosts
        );

    // --------------------------------------------------------
    // DRY RUN
    // --------------------------------------------------------

    if (DRY_RUN) {
        console.log("");
        console.log(
            "========================================"
        );

        console.log(
            "DRY RUN — NO FILES WILL BE UPLOADED"
        );

        console.log(
            "========================================"
        );

        console.log(
            `Supabase posts:        ${supabasePosts.length}`
        );

        console.log(
            `Media references:      ${media.all.length}`
        );

        console.log(
            `Unique media URLs:     ${media.all.length}`
        );

        console.log(
            `Unique images:         ${media.images.length}`
        );

        console.log(
            `Unique videos:         ${media.videos.length}`
        );

        console.log(
            `Video thumbnails:      ${media.thumbnails.length}`
        );

        console.log(
            `Missing PB posts:      ${media.missingPosts}`
        );

        console.log("");
        console.log(
            "Example media:"
        );

        for (
            const item
            of media.all.slice(
                0,
                20
            )
        ) {
            console.log(
                `  ${item.type.padEnd(10)} ${item.fileName}`
            );
        }

        console.log("");
        console.log(
            "DRY RUN COMPLETE."
        );

        console.log(
            "No files were downloaded."
        );

        console.log(
            "No PocketBase records were updated."
        );

        console.log(
            "No PocketBase schema changes were made."
        );

        console.log(
            "No Supabase data was modified."
        );

        return;
    }

    // --------------------------------------------------------
    // REAL MIGRATION
    // --------------------------------------------------------

    await ensureMediaFields();

    const state =
        loadState();

    const allGroups =
        groupByPost(
            media.all
        );

    if (
        allGroups.length === 0
    ) {
        console.log("");
        console.log(
            "No posts containing Supabase Storage media were found."
        );

        return;
    }

    // --------------------------------------------------------
    // DETERMINE RESUME POSITION
    // --------------------------------------------------------

    /*
     * Always calculate from uploaded state.
     *
     * This is important if the migration was stopped
     * previously with Ctrl+C or crashed.
     */

    const calculatedNextIndex =
        findNextIncompleteIndex(
            allGroups,
            state
        );

    state.nextGroupIndex =
        calculatedNextIndex;

    saveState(
        state
    );

    // --------------------------------------------------------
    // SELECT GROUPS
    // --------------------------------------------------------

    let groups;

    const startIndex =
        calculatedNextIndex;

    if (LIMIT !== null) {
        if (
            startIndex >=
            allGroups.length
        ) {
            console.log("");
            console.log(
                "========================================"
            );

            console.log(
                "NOTHING LEFT TO MIGRATE"
            );

            console.log(
                "========================================"
            );

            console.log(
                `All ${allGroups.length} media posts are complete.`
            );

            printStateSummary(
                state,
                allGroups
            );

            return;
        }

        groups =
            allGroups.slice(
                startIndex,
                startIndex + LIMIT
            );
    } else {
        /*
         * Full migration.
         *
         * Existing files are skipped,
         * so this is safe even if previous
         * runs already uploaded media.
         *
         * We intentionally process all groups
         * for full migration so actual PB files
         * can repair missing state entries.
         */

        groups =
            allGroups;
    }

    // --------------------------------------------------------
    // SUMMARY
    // --------------------------------------------------------

    console.log("");
    console.log(
        "========================================"
    );

    console.log(
        "REAL MEDIA MIGRATION"
    );

    console.log(
        "========================================"
    );

    console.log(
        `All posts containing media: ${allGroups.length}`
    );

    console.log(
        `Starting from post index:  ${startIndex}`
    );

    console.log(
        `Posts selected this run:   ${groups.length}`
    );

    console.log(
        `Total media files:         ${media.all.length}`
    );

    console.log(
        `Images:                    ${media.images.length}`
    );

    console.log(
        `Videos:                    ${media.videos.length}`
    );

    console.log(
        `Thumbnails:                ${media.thumbnails.length}`
    );

    console.log(
        `Concurrency:               ${CONCURRENCY}`
    );

    if (LIMIT !== null) {
        console.log(
            `Limit:                     ${LIMIT}`
        );
    }

    console.log(
        `State file:                ${STATE_FILE}`
    );

    console.log("");

    printStateSummary(
        state,
        allGroups
    );

    console.log("");
    console.log(
        "Starting migration..."
    );

    // --------------------------------------------------------
    // RUN
    // --------------------------------------------------------

    const result =
        await runConcurrent(
            groups,
            state
        );

    // --------------------------------------------------------
    // UPDATE RESUME POSITION
    // --------------------------------------------------------

    state.nextGroupIndex =
        findNextIncompleteIndex(
            allGroups,
            state
        );

    saveState(
        state
    );

    // --------------------------------------------------------
    // FINAL
    // --------------------------------------------------------

    console.log("");
    console.log(
        "========================================"
    );

    console.log(
        "MEDIA MIGRATION RUN COMPLETE"
    );

    console.log(
        "========================================"
    );

    console.log(
        `Uploaded: ${result.uploaded}`
    );

    console.log(
        `Skipped:  ${result.skipped}`
    );

    console.log(
        `Failed:   ${result.failed}`
    );

    console.log(
        `Next post: ${state.nextGroupIndex <
            allGroups.length
            ? state.nextGroupIndex + 1
            : "ALL COMPLETE"
        }`
    );

    console.log(
        `State:    ${STATE_FILE}`
    );

    // --------------------------------------------------------
    // FAILURE MESSAGE
    // --------------------------------------------------------

    if (
        result.failed > 0
    ) {
        console.log("");
        console.log(
            "⚠ Some files failed."
        );

        console.log(
            "Run the same command again."
        );

        console.log(
            "Failed files will be retried."
        );
    } else {
        console.log("");
        console.log(
            "✓ No upload failures in this run."
        );
    }

    // --------------------------------------------------------
    // COMPLETE MESSAGE
    // --------------------------------------------------------

    if (
        state.nextGroupIndex >=
        allGroups.length
    ) {
        console.log("");
        console.log(
            "========================================"
        );

        console.log(
            "✓ ALL MEDIA MIGRATION COMPLETE"
        );

        console.log(
            "========================================"
        );

        console.log(
            `Completed media posts: ${allGroups.length}`
        );

        console.log(
            `Total media references: ${media.all.length}`
        );
    }
}

// ------------------------------------------------------------
// RUN
// ------------------------------------------------------------

main().catch(
    error => {
        console.error("");
        console.error(
            "========================================"
        );

        console.error(
            "MIGRATION FAILED"
        );

        console.error(
            "========================================"
        );

        console.error(
            error
        );

        process.exit(1);
    }
);