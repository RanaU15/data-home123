// migrate-posts-fast.js
//
// Supabase -> PocketBase
// Fast + safe posts migration
//
// IMPORTANT:
// - Does NOT modify Supabase
// - Does NOT modify PocketBase schema
// - Safe to run multiple times
// - Skips posts already migrated using supabase_id
// - Disables PocketBase SDK auto-cancellation
// - Uses limited concurrency
// - Retries temporary failures

require("dotenv").config();

const PocketBase = require("pocketbase").default;
const { Client } = require("pg");

// ============================================================
// CONFIG
// ============================================================

const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL;

const POCKETBASE_URL =
    process.env.POCKETBASE_URL || "https://pbflat.formics.io";

const POCKETBASE_EMAIL = process.env.PB_ADMIN_EMAIL;
const POCKETBASE_PASSWORD = process.env.PB_ADMIN_PASSWORD;

// Start with 10 concurrent requests.
const CONCURRENCY = 10;

// Retry temporary failures.
const MAX_RETRIES = 3;

// Number of posts read from Supabase at a time.
const READ_CHUNK_SIZE = 500;

// ============================================================
// VALIDATE ENV
// ============================================================

function checkEnv() {
    const required = [
        ["SUPABASE_DB_URL", SUPABASE_DB_URL],
        ["PB_ADMIN_EMAIL", POCKETBASE_EMAIL],
        ["PB_ADMIN_PASSWORD", POCKETBASE_PASSWORD],
        ["POCKETBASE_URL", POCKETBASE_URL],
    ];

    for (const [name, value] of required) {
        if (!value) {
            console.error(`❌ Missing environment variable: ${name}`);
            process.exit(1);
        }
    }
}

// ============================================================
// HELPERS
// ============================================================

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatTime(seconds) {
    if (!Number.isFinite(seconds)) {
        return "calculating...";
    }

    seconds = Math.max(0, Math.round(seconds));

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0) {
        return `${hours}h ${minutes}m ${secs}s`;
    }

    if (minutes > 0) {
        return `${minutes}m ${secs}s`;
    }

    return `${secs}s`;
}

function errorMessage(error) {
    if (!error) {
        return "Unknown error";
    }

    if (error.response) {
        if (typeof error.response === "string") {
            return error.response;
        }

        try {
            return JSON.stringify(error.response);
        } catch {
            return String(error.response);
        }
    }

    return error.message || String(error);
}

// ============================================================
// CLIENTS
// ============================================================

const pb = new PocketBase(POCKETBASE_URL);

const pg = new Client({
    connectionString: SUPABASE_DB_URL,
});

// ============================================================
// POCKETBASE AUTH
// ============================================================

async function authenticatePocketBase() {
    console.log("Connecting to PocketBase...");

    await pb.collection("_superusers").authWithPassword(
        POCKETBASE_EMAIL,
        POCKETBASE_PASSWORD
    );

    // VERY IMPORTANT for concurrent server-side requests.
    pb.autoCancellation(false);

    console.log("✓ PocketBase authenticated");
    console.log("✓ PocketBase auto-cancellation disabled");
}

// ============================================================
// SUPABASE POST COUNT
// ============================================================

async function getSupabasePostCount() {
    const result = await pg.query(`
        SELECT COUNT(*)::int AS count
        FROM public.posts
    `);

    return result.rows[0].count;
}

// ============================================================
// EXISTING POCKETBASE IDS
// ============================================================

async function getExistingPocketBaseIds() {
    console.log("Reading existing PocketBase post IDs...");

    const existing = new Set();

    let page = 1;

    while (true) {
        const result = await pb.collection("posts").getList(
            page,
            500,
            {
                fields: "id,supabase_id",
                skipTotal: false,
            }
        );

        for (const record of result.items) {
            if (record.supabase_id) {
                existing.add(String(record.supabase_id));
            }
        }

        if (page >= result.totalPages) {
            break;
        }

        page++;
    }

    console.log(
        `✓ Found ${existing.size} posts with supabase_id`
    );

    return existing;
}

// ============================================================
// GET SUPABASE POST COLUMNS
// ============================================================

async function getPostColumns() {
    const result = await pg.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'posts'
        ORDER BY ordinal_position
    `);

    return result.rows.map((row) => row.column_name);
}

// ============================================================
// CONVERT SUPABASE VALUES
// ============================================================

function cleanValue(value) {
    if (value === undefined || value === null) {
        return null;
    }

    // PostgreSQL Date
    if (value instanceof Date) {
        return value.toISOString();
    }

    // Buffer
    if (Buffer.isBuffer(value)) {
        return value.toString("base64");
    }

    // Array
    if (Array.isArray(value)) {
        return value.map(cleanValue);
    }

    // JSON/object
    if (typeof value === "object") {
        return value;
    }

    return value;
}

// ============================================================
// CREATE POST
// ============================================================

async function createPost(post) {
    const data = {};

    for (const [key, value] of Object.entries(post)) {
        // Don't send Supabase's UUID as PocketBase "id".
        // It is stored in supabase_id instead.
        if (key === "id") {
            continue;
        }

        data[key] = cleanValue(value);
    }

    // Preserve original Supabase post ID.
    data.supabase_id = String(post.id);

    return pb.collection("posts").create(data);
}

// ============================================================
// RETRY
// ============================================================

async function createWithRetry(post) {
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            return await createPost(post);
        } catch (error) {
            lastError = error;

            const message = errorMessage(error);

            console.log(
                `\n⚠️ Retry ${attempt}/${MAX_RETRIES} for ${post.id}`
            );

            console.log(`   ${message}`);

            if (attempt < MAX_RETRIES) {
                const delay = 1000 * Math.pow(2, attempt - 1);

                await sleep(delay);
            }
        }
    }

    throw lastError;
}

// ============================================================
// PROCESS POSTS CONCURRENTLY
// ============================================================

async function processPosts(posts, state) {
    let index = 0;

    async function worker() {
        while (true) {
            const currentIndex = index++;

            if (currentIndex >= posts.length) {
                return;
            }

            const post = posts[currentIndex];

            try {
                await createWithRetry(post);

                state.migrated++;

                const processed =
                    state.migrated +
                    state.failed +
                    state.skipped;

                const elapsed =
                    (Date.now() - state.startTime) / 1000;

                const rate =
                    elapsed > 0
                        ? processed / elapsed
                        : 0;

                const remaining =
                    state.total - processed;

                const eta =
                    rate > 0
                        ? remaining / rate
                        : Infinity;

                process.stdout.write(
                    `\rProgress: ${processed}/${state.total} | ` +
                    `Migrated: ${state.migrated} | ` +
                    `Failed: ${state.failed} | ` +
                    `Skipped: ${state.skipped} | ` +
                    `Rate: ${rate.toFixed(1)}/sec | ` +
                    `ETA: ${formatTime(eta)}`
                );
            } catch (error) {
                state.failed++;

                console.log("\n");
                console.log(`❌ Failed post: ${post.id}`);
                console.log(`   ${errorMessage(error)}`);

                const processed =
                    state.migrated +
                    state.failed +
                    state.skipped;

                console.log(
                    `   Progress: ${processed}/${state.total}`
                );
            }
        }
    }

    const workerCount = Math.min(
        CONCURRENCY,
        posts.length
    );

    const workers = [];

    for (let i = 0; i < workerCount; i++) {
        workers.push(worker());
    }

    await Promise.all(workers);

    console.log("");
}

// ============================================================
// MAIN MIGRATION
// ============================================================

async function runMigration() {
    checkEnv();

    console.log("");
    console.log("==================================================");
    console.log(" Supabase → PocketBase Posts Migration");
    console.log("==================================================");
    console.log("");

    console.log(`PocketBase: ${POCKETBASE_URL}`);
    console.log(`Concurrency: ${CONCURRENCY}`);
    console.log(`Retries: ${MAX_RETRIES}`);
    console.log(`Read chunk: ${READ_CHUNK_SIZE}`);
    console.log("");

    // ----------------------------------------------------------
    // CONNECT SUPABASE
    // ----------------------------------------------------------

    console.log("Connecting to Supabase...");

    await pg.connect();

    console.log("✓ Supabase connected");

    // ----------------------------------------------------------
    // CONNECT POCKETBASE
    // ----------------------------------------------------------

    await authenticatePocketBase();

    // ----------------------------------------------------------
    // IMPORTANT
    // ----------------------------------------------------------
    // We DO NOT modify the PocketBase schema here.
    //
    // posts.supabase_id was already created during schema setup.
    // ----------------------------------------------------------

    console.log("Checking posts.supabase_id...");

    try {
        await pb.collection("posts").getList(
            1,
            1,
            {
                fields: "id,supabase_id",
            }
        );

        console.log("✓ posts.supabase_id is accessible");
    } catch (error) {
        console.error("");
        console.error(
            "❌ Could not read posts.supabase_id"
        );
        console.error(errorMessage(error));
        console.error("");
        console.error(
            "Open PocketBase Admin → Collections → posts → Fields"
        );
        console.error(
            "and make sure the field 'supabase_id' exists."
        );

        throw error;
    }

    // ----------------------------------------------------------
    // SUPABASE COUNT
    // ----------------------------------------------------------

    const supabaseCount =
        await getSupabasePostCount();

    console.log(
        `✓ Supabase posts: ${supabaseCount}`
    );

    // ----------------------------------------------------------
    // EXISTING PB POSTS
    // ----------------------------------------------------------

    let existingIds =
        await getExistingPocketBaseIds();

    // ----------------------------------------------------------
    // SUPABASE COLUMNS
    // ----------------------------------------------------------

    const columns =
        await getPostColumns();

    console.log(
        `✓ Found ${columns.length} Supabase columns`
    );

    // ----------------------------------------------------------
    // STATE
    // ----------------------------------------------------------

    const state = {
        total: supabaseCount,
        migrated: 0,
        failed: 0,
        skipped: 0,
        startTime: Date.now(),
    };

    console.log("");
    console.log("Starting migration...");
    console.log("");

    // ----------------------------------------------------------
    // KEYSET PAGINATION
    // ----------------------------------------------------------

    let lastId = null;

    while (true) {
        let query;
        let params;

        if (lastId === null) {
            query = `
                SELECT ${columns
                    .map((c) => `"${c}"`)
                    .join(", ")}
                FROM public.posts
                ORDER BY id
                LIMIT $1
            `;

            params = [READ_CHUNK_SIZE];
        } else {
            query = `
                SELECT ${columns
                    .map((c) => `"${c}"`)
                    .join(", ")}
                FROM public.posts
                WHERE id > $1
                ORDER BY id
                LIMIT $2
            `;

            params = [
                lastId,
                READ_CHUNK_SIZE,
            ];
        }

        const result =
            await pg.query(query, params);

        if (result.rows.length === 0) {
            break;
        }

        lastId =
            result.rows[
                result.rows.length - 1
            ].id;

        const missing = [];

        for (const post of result.rows) {
            const supabaseId =
                String(post.id);

            if (existingIds.has(supabaseId)) {
                state.skipped++;
            } else {
                missing.push(post);
            }
        }

        console.log("");
        console.log(
            `Supabase chunk: ${result.rows.length} posts`
        );

        console.log(
            `Already in PocketBase: ${result.rows.length - missing.length
            }`
        );

        console.log(
            `To migrate: ${missing.length}`
        );

        if (missing.length > 0) {
            await processPosts(
                missing,
                state
            );

            // Refresh existing IDs after each chunk.
            existingIds =
                await getExistingPocketBaseIds();
        }

        if (
            result.rows.length <
            READ_CHUNK_SIZE
        ) {
            break;
        }
    }

    // ----------------------------------------------------------
    // FINAL VERIFICATION
    // ----------------------------------------------------------

    console.log("");
    console.log("");
    console.log("==================================================");
    console.log(" FINAL VERIFICATION");
    console.log("==================================================");

    const finalCount =
        await pb.collection("posts").getList(
            1,
            1,
            {
                skipTotal: false,
            }
        );

    const finalSupabaseCount =
        await getSupabasePostCount();

    console.log("");

    console.log(
        `Supabase posts  : ${finalSupabaseCount}`
    );

    console.log(
        `PocketBase posts: ${finalCount.total}`
    );

    console.log("");

    console.log(
        `Migrated this run: ${state.migrated}`
    );

    console.log(
        `Skipped this run : ${state.skipped}`
    );

    console.log(
        `Failed this run  : ${state.failed}`
    );

    console.log("");

    if (
        finalCount.total >=
        finalSupabaseCount &&
        state.failed === 0
    ) {
        console.log(
            "✅ ALL POSTS ARE IN POCKETBASE"
        );
    } else if (
        finalCount.total <
        finalSupabaseCount
    ) {
        console.log(
            `⚠️ ${finalSupabaseCount -
            finalCount.total
            } posts still need migration.`
        );

        console.log(
            "You can safely run this script again."
        );
    } else {
        console.log(
            "⚠️ Migration finished with some failures."
        );

        console.log(
            "Run the script again to retry failed records."
        );
    }

    console.log("");
}

// ============================================================
// MAIN
// ============================================================

runMigration()
    .catch((error) => {
        console.error("");
        console.error("==================================================");
        console.error("❌ MIGRATION ERROR");
        console.error("==================================================");
        console.error("");
        console.error(errorMessage(error));
        console.error("");
    })
    .finally(async () => {
        try {
            await pg.end();
        } catch { }
    });