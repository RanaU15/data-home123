require("dotenv").config();

const { Pool } = require("pg");
const PocketBase = require("pocketbase/cjs");

const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL;
const POCKETBASE_URL = process.env.POCKETBASE_URL;
const PB_ADMIN_EMAIL = process.env.PB_ADMIN_EMAIL;
const PB_ADMIN_PASSWORD = process.env.PB_ADMIN_PASSWORD;

if (!SUPABASE_DB_URL) throw new Error("Missing SUPABASE_DB_URL");
if (!POCKETBASE_URL) throw new Error("Missing POCKETBASE_URL");
if (!PB_ADMIN_EMAIL) throw new Error("Missing PB_ADMIN_EMAIL");
if (!PB_ADMIN_PASSWORD) throw new Error("Missing PB_ADMIN_PASSWORD");

const pool = new Pool({
    connectionString: SUPABASE_DB_URL,
    ssl: { rejectUnauthorized: false },
});

const pb = new PocketBase(POCKETBASE_URL);

// Important: prevent PocketBase SDK from cancelling concurrent requests.
pb.autoCancellation(false);

async function getProfileMap() {
    const map = new Map();

    const result = await pb.collection("profiles").getFullList({
        fields: "id,supabase_id",
    });

    for (const profile of result) {
        if (profile.supabase_id) {
            map.set(profile.supabase_id, profile.id);
        }
    }

    return map;
}

async function getPostMap() {
    const map = new Map();

    const result = await pb.collection("posts").getFullList({
        fields: "id,supabase_id",
    });

    for (const post of result) {
        if (post.supabase_id) {
            map.set(post.supabase_id, post.id);
        }
    }

    return map;
}

async function getAlertMap() {
    const map = new Map();

    const result = await pb.collection("alerts").getFullList({
        fields: "id,supabase_id",
    });

    for (const alert of result) {
        if (alert.supabase_id) {
            map.set(alert.supabase_id, alert.id);
        }
    }

    return map;
}

async function ensureSupabaseIdField() {
    try {
        await pb.collection("notifications").getList(1, 1, {
            fields: "id,supabase_id",
        });

        console.log("✓ notifications.supabase_id is accessible");
    } catch (err) {
        throw new Error(
            "notifications.supabase_id is missing from PocketBase. " +
            "Please add the field before running migration."
        );
    }
}

async function getExistingIds() {
    const records = await pb.collection("notifications").getFullList({
        fields: "id,supabase_id",
    });

    const ids = new Set();

    for (const record of records) {
        if (record.supabase_id) {
            ids.add(record.supabase_id);
        }
    }

    return ids;
}

async function main() {
    console.log("");
    console.log("==================================================");
    console.log(" Supabase → PocketBase Notifications Migration");
    console.log("==================================================");
    console.log("");

    console.log(`PocketBase: ${POCKETBASE_URL}`);
    console.log("");

    // --------------------------------------------------
    // Connect Supabase
    // --------------------------------------------------

    console.log("Connecting to Supabase...");

    const client = await pool.connect();

    console.log("✓ Supabase connected");

    // --------------------------------------------------
    // Connect PocketBase
    // --------------------------------------------------

    console.log("Connecting to PocketBase...");

    await pb.collection("_superusers").authWithPassword(
        PB_ADMIN_EMAIL,
        PB_ADMIN_PASSWORD
    );

    console.log("✓ PocketBase authenticated");
    console.log("✓ PocketBase auto-cancellation disabled");

    // --------------------------------------------------
    // Check field
    // --------------------------------------------------

    console.log("");
    console.log("Checking notifications.supabase_id...");

    await ensureSupabaseIdField();

    // --------------------------------------------------
    // Get Supabase count
    // --------------------------------------------------

    const countResult = await client.query(`
    SELECT COUNT(*)::int AS count
    FROM public.notifications
  `);

    const supabaseCount = countResult.rows[0].count;

    console.log(`✓ Supabase notifications: ${supabaseCount}`);

    // --------------------------------------------------
    // Get Supabase columns
    // --------------------------------------------------

    const columnsResult = await client.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'notifications'
    ORDER BY ordinal_position
  `);

    const columns = columnsResult.rows.map((row) => row.column_name);

    console.log(`✓ Found ${columns.length} Supabase columns`);

    // --------------------------------------------------
    // Existing PocketBase records
    // --------------------------------------------------

    console.log("");
    console.log("Reading existing PocketBase notification IDs...");

    let existingIds = await getExistingIds();

    console.log(`✓ Found ${existingIds.size} notifications with supabase_id`);

    // --------------------------------------------------
    // Relation maps
    // --------------------------------------------------

    console.log("");
    console.log("Reading PocketBase relations...");

    const profileMap = await getProfileMap();
    const postMap = await getPostMap();
    const alertMap = await getAlertMap();

    console.log(`✓ Profiles mapped: ${profileMap.size}`);
    console.log(`✓ Posts mapped: ${postMap.size}`);
    console.log(`✓ Alerts mapped: ${alertMap.size}`);

    // --------------------------------------------------
    // Read notifications
    // --------------------------------------------------

    console.log("");
    console.log("Reading Supabase notifications...");

    const result = await client.query(`
    SELECT *
    FROM public.notifications
    ORDER BY id
  `);

    const notifications = result.rows;

    console.log(`✓ Read ${notifications.length} notifications`);

    // --------------------------------------------------
    // Migrate
    // --------------------------------------------------

    console.log("");
    console.log("Starting migration...");
    console.log("");

    let created = 0;
    let skipped = 0;
    let failed = 0;

    for (let i = 0; i < notifications.length; i++) {
        const source = notifications[i];

        const supabaseId = String(source.id);

        process.stdout.write(
            `[${i + 1}/${notifications.length}] ${supabaseId} ... `
        );

        // Already exists
        if (existingIds.has(supabaseId)) {
            skipped++;

            console.log("SKIPPED");
            continue;
        }

        try {
            const data = {};

            // ------------------------------------------------
            // Copy normal fields
            // ------------------------------------------------

            for (const column of columns) {
                if (column === "id") continue;

                // These are handled below as PocketBase relations.
                if (
                    column === "user_id" ||
                    column === "post_id" ||
                    column === "alert_id"
                ) {
                    continue;
                }

                const value = source[column];

                if (value !== undefined) {
                    data[column] = value;
                }
            }

            // ------------------------------------------------
            // Original Supabase ID
            // ------------------------------------------------

            data.supabase_id = supabaseId;

            // ------------------------------------------------
            // user_id → profile relation
            // ------------------------------------------------

            if (source.user_id) {
                const profileId = profileMap.get(String(source.user_id));

                if (profileId) {
                    data.user = profileId;
                } else {
                    console.log(
                        `WARNING: profile not found for user_id ${source.user_id}`
                    );
                }

                // Keep original UUID too if field exists.
                data.user_id = String(source.user_id);
            }

            // ------------------------------------------------
            // post_id → posts relation
            // ------------------------------------------------

            if (source.post_id) {
                const postId = postMap.get(String(source.post_id));

                if (postId) {
                    data.post = postId;
                } else {
                    console.log(
                        `WARNING: post not found for post_id ${source.post_id}`
                    );
                }

                data.post_id = String(source.post_id);
            }

            // ------------------------------------------------
            // alert_id → alerts relation
            // ------------------------------------------------

            if (source.alert_id) {
                const alertId = alertMap.get(String(source.alert_id));

                if (alertId) {
                    data.alert = alertId;
                } else {
                    console.log(
                        `WARNING: alert not found for alert_id ${source.alert_id}`
                    );
                }

                data.alert_id = String(source.alert_id);
            }

            // ------------------------------------------------
            // Create PocketBase record
            // ------------------------------------------------

            await pb.collection("notifications").create(data);

            existingIds.add(supabaseId);
            created++;

            console.log("CREATED");
        } catch (error) {
            failed++;

            console.log("FAILED");

            console.log(
                "  Error:",
                error?.response?.message ||
                error?.message ||
                error
            );
        }
    }

    // --------------------------------------------------
    // Final verification
    // --------------------------------------------------

    console.log("");
    console.log("==================================================");
    console.log(" FINAL VERIFICATION");
    console.log("==================================================");
    console.log("");

    const pbResult = await pb.collection("notifications").getList(1, 1, {
        perPage: 1,
    });

    const pocketBaseCount = pbResult.totalItems;

    console.log(`Supabase notifications  : ${supabaseCount}`);
    console.log(`PocketBase notifications: ${pocketBaseCount}`);

    console.log("");
    console.log(`Created this run : ${created}`);
    console.log(`Skipped this run : ${skipped}`);
    console.log(`Failed this run  : ${failed}`);

    console.log("");

    if (
        failed === 0 &&
        supabaseCount === pocketBaseCount
    ) {
        console.log("✓ ALL NOTIFICATIONS MIGRATED SUCCESSFULLY");
    } else {
        console.log("⚠️ Verification requires attention.");
    }

    console.log("");

    client.release();
    await pool.end();
}

main().catch(async (error) => {
    console.error("");
    console.error("❌ MIGRATION ERROR");
    console.error(error?.response || error?.message || error);

    try {
        await pool.end();
    } catch { }

    process.exit(1);
});