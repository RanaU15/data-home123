require("dotenv").config();

const PocketBase = require("pocketbase").default;
const { Client } = require("pg");

const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL;
const POCKETBASE_URL = process.env.POCKETBASE_URL;
const PB_ADMIN_EMAIL = process.env.PB_ADMIN_EMAIL;
const PB_ADMIN_PASSWORD = process.env.PB_ADMIN_PASSWORD;

const BATCH_SIZE = 100;

async function main() {
    console.log("==============================================");
    console.log(" Supabase → PocketBase Posts Migration");
    console.log("==============================================");

    // --------------------------------------------------
    // Connect Supabase
    // --------------------------------------------------

    const pg = new Client({
        connectionString: SUPABASE_DB_URL,
        ssl: {
            rejectUnauthorized: false,
        },
    });

    await pg.connect();

    console.log("✓ Supabase connected.");

    // --------------------------------------------------
    // Connect PocketBase
    // --------------------------------------------------

    const pb = new PocketBase(POCKETBASE_URL);

    await pb.collection("_superusers").authWithPassword(
        PB_ADMIN_EMAIL,
        PB_ADMIN_PASSWORD
    );

    console.log("✓ PocketBase superuser authenticated.");

    // --------------------------------------------------
    // Ensure supabase_id exists
    // --------------------------------------------------

    console.log("\nChecking posts.supabase_id...");

    const collections = await pb.collections.getFullList();

    const postsCollection = collections.find(
        (collection) => collection.name === "posts"
    );

    if (!postsCollection) {
        throw new Error(
            "PocketBase collection 'posts' does not exist."
        );
    }

    const hasSupabaseId = postsCollection.fields.some(
        (field) => field.name === "supabase_id"
    );

    if (!hasSupabaseId) {
        console.log("Adding posts.supabase_id...");

        await pb.collections.update(
            postsCollection.id,
            {
                fields: [
                    ...postsCollection.fields,
                    {
                        name: "supabase_id",
                        type: "text",
                        required: true,
                        unique: true,
                        options: {
                            min: 1,
                            max: 100,
                            pattern: "",
                        },
                    },
                ],
            }
        );

        console.log("✓ posts.supabase_id added.");
    } else {
        console.log("✓ posts.supabase_id already exists.");
    }

    // --------------------------------------------------
    // Read Supabase columns
    // --------------------------------------------------

    console.log("\nReading posts columns...");

    const columnResult = await pg.query(`
    SELECT
      column_name,
      data_type,
      udt_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'posts'
    ORDER BY ordinal_position;
  `);

    const columns = columnResult.rows.map(
        (row) => row.column_name
    );

    console.log(
        `✓ Found ${columns.length} Supabase columns.`
    );

    // --------------------------------------------------
    // Read all posts
    // --------------------------------------------------

    const countResult = await pg.query(`
    SELECT COUNT(*)::int AS count
    FROM public.posts;
  `);

    const total = countResult.rows[0].count;

    console.log(`✓ Found ${total} Supabase posts.`);

    // --------------------------------------------------
    // Fields available in PocketBase
    // --------------------------------------------------

    const updatedCollections =
        await pb.collections.getFullList();

    const latestPostsCollection =
        updatedCollections.find(
            (collection) => collection.name === "posts"
        );

    const pbFieldNames = new Set(
        latestPostsCollection.fields.map(
            (field) => field.name
        )
    );

    // --------------------------------------------------
    // Fields we should skip
    // --------------------------------------------------

    const skipFields = new Set([
        "id",
    ]);

    // --------------------------------------------------
    // PostgreSQL → PocketBase value conversion
    // --------------------------------------------------

    function convertValue(value, column) {
        if (value === null || value === undefined) {
            return null;
        }

        const dataType = column.data_type;
        const udtName = column.udt_name;

        // JSON / JSONB
        if (
            dataType === "json" ||
            dataType === "jsonb"
        ) {
            return value;
        }

        // PostgreSQL arrays
        if (
            dataType === "ARRAY" ||
            udtName?.startsWith("_")
        ) {
            return value;
        }

        // Boolean
        if (dataType === "boolean") {
            return Boolean(value);
        }

        // Numbers
        if (
            [
                "integer",
                "bigint",
                "smallint",
                "numeric",
                "real",
                "double precision",
            ].includes(dataType)
        ) {
            return Number(value);
        }

        // Dates / timestamps
        if (
            dataType.includes("timestamp") ||
            dataType === "date" ||
            dataType === "time"
        ) {
            if (value instanceof Date) {
                return value.toISOString();
            }

            return value;
        }

        // Everything else → string
        return String(value);
    }

    // --------------------------------------------------
    // Migrate in batches
    // --------------------------------------------------

    let created = 0;
    let updated = 0;
    let failed = 0;

    for (
        let offset = 0;
        offset < total;
        offset += BATCH_SIZE
    ) {
        console.log("\n==============================================");
        console.log(
            `Processing posts ${offset + 1} → ${Math.min(
                offset + BATCH_SIZE,
                total
            )} of ${total}`
        );
        console.log("==============================================");

        const result = await pg.query(
            `
      SELECT *
      FROM public.posts
      ORDER BY id
      LIMIT $1
      OFFSET $2;
      `,
            [BATCH_SIZE, offset]
        );

        for (const post of result.rows) {
            try {
                const supabaseId = String(post.id);

                // ------------------------------------------------
                // Check existing record
                // ------------------------------------------------

                let existing = null;

                try {
                    existing = await pb
                        .collection("posts")
                        .getFirstListItem(
                            `supabase_id="${supabaseId}"`
                        );
                } catch {
                    // Does not exist
                }

                // ------------------------------------------------
                // Build PocketBase data
                // ------------------------------------------------

                const data = {
                    supabase_id: supabaseId,
                };

                for (const column of columnResult.rows) {
                    const columnName = column.column_name;

                    if (skipFields.has(columnName)) {
                        continue;
                    }

                    // Only send fields that actually exist
                    // in PocketBase.
                    if (!pbFieldNames.has(columnName)) {
                        continue;
                    }

                    data[columnName] = convertValue(
                        post[columnName],
                        column
                    );
                }

                // ------------------------------------------------
                // Create / update
                // ------------------------------------------------

                if (existing) {
                    await pb
                        .collection("posts")
                        .update(existing.id, data);

                    updated++;
                } else {
                    await pb
                        .collection("posts")
                        .create(data);

                    created++;
                }

            } catch (error) {
                failed++;

                console.error(
                    `❌ Failed post: ${post.id}`
                );

                console.error(
                    error.response?.data ||
                    error.message ||
                    error
                );
            }
        }

        console.log(
            `Progress: Created=${created}, Updated=${updated}, Failed=${failed}`
        );
    }

    // --------------------------------------------------
    // Close connections
    // --------------------------------------------------

    await pg.end();

    pb.authStore.clear();

    // --------------------------------------------------
    // Final summary
    // --------------------------------------------------

    console.log("\n==============================================");
    console.log(" POSTS MIGRATION COMPLETE");
    console.log("==============================================");

    console.log(`Supabase posts : ${total}`);
    console.log(`Created        : ${created}`);
    console.log(`Updated        : ${updated}`);
    console.log(`Failed         : ${failed}`);

    console.log("\nSupabase data was NOT modified.");

    if (failed === 0) {
        console.log("✓ ALL POSTS MIGRATED SUCCESSFULLY");
    } else {
        console.log(
            `⚠ ${failed} posts failed and need investigation.`
        );
    }
}

main().catch((error) => {
    console.error("\n==============================================");
    console.error("❌ POSTS MIGRATION FAILED");
    console.error("==============================================");

    console.error(
        error.response?.data ||
        error.message ||
        error
    );

    process.exit(1);
});