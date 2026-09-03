require("dotenv").config();

const PocketBase = require("pocketbase").default;
const { Client } = require("pg");

const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL;
const POCKETBASE_URL = process.env.POCKETBASE_URL;
const PB_ADMIN_EMAIL = process.env.PB_ADMIN_EMAIL;
const PB_ADMIN_PASSWORD = process.env.PB_ADMIN_PASSWORD;

async function main() {
    console.log("==============================================");
    console.log(" Supabase → PocketBase Alert Migration");
    console.log("==============================================");

    // --------------------------------------------------
    // Supabase
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
    // PocketBase
    // --------------------------------------------------

    const pb = new PocketBase(POCKETBASE_URL);

    await pb.collection("_superusers").authWithPassword(
        PB_ADMIN_EMAIL,
        PB_ADMIN_PASSWORD
    );

    console.log("✓ PocketBase superuser authenticated.");

    // --------------------------------------------------
    // Read Supabase alerts
    // --------------------------------------------------

    console.log("\nReading Supabase alerts...");

    const result = await pg.query(`
    SELECT
      id,
      user_id,
      name,
      property_types,
      tenant_types,
      location,
      enabled,
      created_at
    FROM public.alerts
    ORDER BY created_at;
  `);

    console.log(`✓ Found ${result.rows.length} alerts.`);

    let created = 0;
    let updated = 0;
    let failed = 0;

    // --------------------------------------------------
    // Migrate
    // --------------------------------------------------

    for (const alert of result.rows) {
        console.log("\n----------------------------------------------");

        console.log(
            `Alert: ${alert.name || alert.id}`
        );

        console.log(
            `Supabase ID: ${alert.id}`
        );

        try {
            // ------------------------------------------------
            // Find PocketBase profile
            // ------------------------------------------------

            let pbProfile = null;

            if (alert.user_id) {
                try {
                    pbProfile = await pb
                        .collection("profiles")
                        .getFirstListItem(
                            `supabase_id="${alert.user_id}"`
                        );

                    console.log(
                        `✓ PocketBase profile: ${pbProfile.id}`
                    );
                } catch (error) {
                    console.log(
                        `⚠ Profile not found for user_id: ${alert.user_id}`
                    );
                }
            }

            // ------------------------------------------------
            // Check existing alert
            // ------------------------------------------------

            let existing = null;

            try {
                existing = await pb
                    .collection("alerts")
                    .getFirstListItem(
                        `supabase_id="${alert.id}"`
                    );
            } catch (error) {
                // Alert doesn't exist
            }

            // ------------------------------------------------
            // Prepare data
            // ------------------------------------------------

            const data = {
                supabase_id: alert.id,

                user_id:
                    alert.user_id || "",

                name:
                    alert.name || "",

                property_types:
                    alert.property_types ?? null,

                tenant_types:
                    alert.tenant_types ?? null,

                location:
                    alert.location || "",

                enabled:
                    Boolean(alert.enabled),

                created_at:
                    alert.created_at || null,
            };

            // Add PocketBase relation if profile exists
            if (pbProfile) {
                data.user = pbProfile.id;
            }

            // ------------------------------------------------
            // Update existing
            // ------------------------------------------------

            if (existing) {
                await pb
                    .collection("alerts")
                    .update(existing.id, data);

                console.log(
                    `✓ Updated PocketBase alert: ${existing.id}`
                );

                updated++;
                continue;
            }

            // ------------------------------------------------
            // Create
            // ------------------------------------------------

            const newAlert = await pb
                .collection("alerts")
                .create(data);

            console.log(
                `✓ Created PocketBase alert: ${newAlert.id}`
            );

            created++;

        } catch (error) {
            failed++;

            console.error(
                `❌ Failed alert: ${alert.id}`
            );

            console.error(
                error.response?.data ||
                error.message ||
                error
            );
        }
    }

    // --------------------------------------------------
    // Close
    // --------------------------------------------------

    await pg.end();

    pb.authStore.clear();

    // --------------------------------------------------
    // Summary
    // --------------------------------------------------

    console.log("\n==============================================");
    console.log(" ALERT MIGRATION COMPLETE");
    console.log("==============================================");

    console.log(`Supabase alerts : ${result.rows.length}`);
    console.log(`Created         : ${created}`);
    console.log(`Updated         : ${updated}`);
    console.log(`Failed          : ${failed}`);

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