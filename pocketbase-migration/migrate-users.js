require("dotenv").config();

const PocketBase = require("pocketbase").default;
const { Client } = require("pg");

const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL;
const POCKETBASE_URL = process.env.POCKETBASE_URL;
const PB_ADMIN_EMAIL = process.env.PB_ADMIN_EMAIL;
const PB_ADMIN_PASSWORD = process.env.PB_ADMIN_PASSWORD;

// Temporary password for migrated users.
// They should change this after migration.
const TEMP_PASSWORD = "ChangeMe@2026!";

async function main() {
    console.log("==============================================");
    console.log(" Supabase → PocketBase User Migration");
    console.log("==============================================");

    // --------------------------------------------------
    // Connect to Supabase
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
    // Connect to PocketBase
    // --------------------------------------------------

    const pb = new PocketBase(POCKETBASE_URL);

    await pb
        .collection("_superusers")
        .authWithPassword(
            PB_ADMIN_EMAIL,
            PB_ADMIN_PASSWORD
        );

    console.log("✓ PocketBase superuser authenticated.");

    // --------------------------------------------------
    // Get users collection
    // --------------------------------------------------

    const usersCollection = await pb.collections.getOne(
        "_pb_users_auth_"
    );

    // --------------------------------------------------
    // Add supabase_id field if missing
    // --------------------------------------------------

    const hasSupabaseId = usersCollection.fields?.some(
        (field) => field.name === "supabase_id"
    );

    if (!hasSupabaseId) {
        console.log("\nAdding users.supabase_id...");

        usersCollection.fields.push({
            name: "supabase_id",
            type: "text",
            required: false,
            unique: true,
            options: {
                min: null,
                max: 100,
                pattern: "",
            },
        });

        await pb.collections.update(
            usersCollection.id,
            {
                fields: usersCollection.fields,
            }
        );

        console.log("✓ users.supabase_id added.");
    } else {
        console.log("✓ users.supabase_id already exists.");
    }

    // --------------------------------------------------
    // Read Supabase users
    // --------------------------------------------------

    console.log("\nReading Supabase users...");

    const result = await pg.query(`
    SELECT
      id,
      email,
      email_confirmed_at,
      created_at,
      updated_at,
      last_sign_in_at,
      raw_user_meta_data
    FROM auth.users
    ORDER BY created_at;
  `);

    console.log(`✓ Found ${result.rows.length} Supabase users.`);

    // --------------------------------------------------
    // Migrate each user
    // --------------------------------------------------

    let created = 0;
    let skipped = 0;
    let failed = 0;

    for (const user of result.rows) {
        console.log("\n----------------------------------------------");
        console.log(`User: ${user.email}`);
        console.log(`Supabase ID: ${user.id}`);

        try {
            // Check by Supabase ID first
            let existing = null;

            try {
                existing = await pb
                    .collection("_pb_users_auth_")
                    .getFirstListItem(
                        `supabase_id="${user.id}"`
                    );
            } catch (error) {
                // Not found - continue
            }

            // Check by email if Supabase ID was not found
            if (!existing && user.email) {
                try {
                    existing = await pb
                        .collection("_pb_users_auth_")
                        .getFirstListItem(
                            `email="${user.email}"`
                        );
                } catch (error) {
                    // Not found - continue
                }
            }

            // ------------------------------------------------
            // Existing user
            // ------------------------------------------------

            if (existing) {
                console.log(
                    `⚠ Already exists in PocketBase: ${existing.id}`
                );

                // Make sure supabase_id is attached
                if (existing.supabase_id !== user.id) {
                    await pb
                        .collection("_pb_users_auth_")
                        .update(existing.id, {
                            supabase_id: user.id,
                        });

                    console.log("✓ supabase_id updated.");
                }

                skipped++;
                continue;
            }

            // ------------------------------------------------
            // Get display name
            // ------------------------------------------------

            let name = "";

            if (user.raw_user_meta_data) {
                const metadata =
                    typeof user.raw_user_meta_data === "string"
                        ? JSON.parse(user.raw_user_meta_data)
                        : user.raw_user_meta_data;

                name =
                    metadata.full_name ||
                    metadata.name ||
                    "";
            }

            // ------------------------------------------------
            // Create PocketBase user
            // ------------------------------------------------

            const newUser = await pb
                .collection("_pb_users_auth_")
                .create({
                    email: user.email,

                    // Temporary password.
                    // User should change this later.
                    password: TEMP_PASSWORD,
                    passwordConfirm: TEMP_PASSWORD,

                    emailVisibility: true,

                    // Preserve Supabase verification status
                    verified: !!user.email_confirmed_at,

                    name: name,

                    // Our mapping field
                    supabase_id: user.id,
                });

            console.log(
                `✓ Created PocketBase user: ${newUser.id}`
            );

            created++;
        } catch (error) {
            failed++;

            console.error(
                `❌ Failed: ${user.email}`
            );

            console.error(
                error.response?.data ||
                error.message ||
                error
            );
        }
    }

    // --------------------------------------------------
    // Close Supabase connection
    // --------------------------------------------------

    await pg.end();

    pb.authStore.clear();

    // --------------------------------------------------
    // Summary
    // --------------------------------------------------

    console.log("\n==============================================");
    console.log(" USER MIGRATION COMPLETE");
    console.log("==============================================");

    console.log(`Supabase users : ${result.rows.length}`);
    console.log(`Created        : ${created}`);
    console.log(`Skipped        : ${skipped}`);
    console.log(`Failed         : ${failed}`);

    console.log("\nTemporary password:");
    console.log(TEMP_PASSWORD);

    console.log(`
IMPORTANT:
The existing Supabase password hashes were NOT copied.

All newly migrated users currently use the temporary
password above.

We will handle the proper password-reset/authentication
process separately.
`);

    console.log("Supabase data was NOT modified.");
}

main().catch((error) => {
    console.error("\n==============================================");
    console.error("❌ MIGRATION FAILED");
    console.error("==============================================");

    console.error(
        error.response?.data ||
        error.message ||
        error
    );

    process.exit(1);
});