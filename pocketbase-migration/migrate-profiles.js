require("dotenv").config();

const PocketBase = require("pocketbase").default;
const { Client } = require("pg");

const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL;
const POCKETBASE_URL = process.env.POCKETBASE_URL;
const PB_ADMIN_EMAIL = process.env.PB_ADMIN_EMAIL;
const PB_ADMIN_PASSWORD = process.env.PB_ADMIN_PASSWORD;

async function main() {
    console.log("==============================================");
    console.log(" Supabase → PocketBase Profile Migration");
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
    // Read Supabase profiles
    // --------------------------------------------------

    console.log("\nReading Supabase profiles...");

    const result = await pg.query(`
    SELECT
      id,
      full_name,
      email,
      avatar_url,
      created_at,
      updated_at
    FROM public.profiles
    ORDER BY created_at;
  `);

    console.log(`✓ Found ${result.rows.length} profiles.`);

    // --------------------------------------------------
    // Migrate profiles
    // --------------------------------------------------

    let created = 0;
    let updated = 0;
    let failed = 0;

    for (const profile of result.rows) {
        console.log("\n----------------------------------------------");
        console.log(`Profile: ${profile.email || profile.full_name || profile.id}`);
        console.log(`Supabase ID: ${profile.id}`);

        try {
            // ------------------------------------------------
            // Find corresponding PocketBase user
            // ------------------------------------------------

            let pbUser;

            try {
                pbUser = await pb
                    .collection("_pb_users_auth_")
                    .getFirstListItem(
                        `supabase_id="${profile.id}"`
                    );
            } catch (error) {
                console.error(
                    "❌ Could not find PocketBase user for profile."
                );

                console.error(
                    `Supabase user ID: ${profile.id}`
                );

                failed++;
                continue;
            }

            console.log(
                `✓ PocketBase user: ${pbUser.id}`
            );

            // ------------------------------------------------
            // Check if profile already exists
            // ------------------------------------------------

            let existing = null;

            try {
                existing = await pb
                    .collection("profiles")
                    .getFirstListItem(
                        `supabase_id="${profile.id}"`
                    );
            } catch (error) {
                // Profile doesn't exist
            }

            // ------------------------------------------------
            // Prepare profile data
            // ------------------------------------------------

            const data = {
                supabase_id: profile.id,

                full_name:
                    profile.full_name || "",

                email:
                    profile.email || "",

                avatar_url:
                    profile.avatar_url || "",

                created_at:
                    profile.created_at || null,

                updated_at:
                    profile.updated_at || null,

                // Connect profile → PocketBase user
                user: pbUser.id,
            };

            // ------------------------------------------------
            // Update existing
            // ------------------------------------------------

            if (existing) {
                await pb
                    .collection("profiles")
                    .update(existing.id, data);

                console.log(
                    `✓ Updated PocketBase profile: ${existing.id}`
                );

                updated++;
                continue;
            }

            // ------------------------------------------------
            // Create new profile
            // ------------------------------------------------

            const newProfile = await pb
                .collection("profiles")
                .create(data);

            console.log(
                `✓ Created PocketBase profile: ${newProfile.id}`
            );

            created++;

        } catch (error) {
            failed++;

            console.error(
                `❌ Failed profile: ${profile.id}`
            );

            console.error(
                error.response?.data ||
                error.message ||
                error
            );
        }
    }

    // --------------------------------------------------
    // Close connections
    // --------------------------------------------------

    await pg.end();

    pb.authStore.clear();

    // --------------------------------------------------
    // Summary
    // --------------------------------------------------

    console.log("\n==============================================");
    console.log(" PROFILE MIGRATION COMPLETE");
    console.log("==============================================");

    console.log(`Supabase profiles : ${result.rows.length}`);
    console.log(`Created           : ${created}`);
    console.log(`Updated           : ${updated}`);
    console.log(`Failed            : ${failed}`);

    console.log("\nSupabase data was NOT modified.");
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