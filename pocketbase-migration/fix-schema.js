require("dotenv").config();

const PocketBase = require("pocketbase").default;

const POCKETBASE_URL = process.env.POCKETBASE_URL;
const PB_ADMIN_EMAIL = process.env.PB_ADMIN_EMAIL;
const PB_ADMIN_PASSWORD = process.env.PB_ADMIN_PASSWORD;

async function main() {
    console.log("==============================================");
    console.log(" PocketBase Schema Fix");
    console.log("==============================================");

    const pb = new PocketBase(POCKETBASE_URL);

    // Login
    await pb
        .collection("_superusers")
        .authWithPassword(PB_ADMIN_EMAIL, PB_ADMIN_PASSWORD);

    console.log("PocketBase superuser authenticated.");

    // --------------------------------------------------
    // Get collections
    // --------------------------------------------------

    const users = await pb.collections.getOne("_pb_users_auth_");

    const profiles = await pb.collections.getFirstListItem(
        'name="profiles"'
    );

    const alerts = await pb.collections.getFirstListItem(
        'name="alerts"'
    );

    // --------------------------------------------------
    // Helper
    // --------------------------------------------------

    function hasField(collection, name) {
        return collection.fields?.some((f) => f.name === name);
    }

    function getField(collection, name) {
        return collection.fields?.find((f) => f.name === name);
    }

    // --------------------------------------------------
    // 1. Add supabase_id to profiles
    // --------------------------------------------------

    console.log("\n[1] Checking profiles.supabase_id...");

    if (!hasField(profiles, "supabase_id")) {
        profiles.fields.push({
            name: "supabase_id",
            type: "text",
            required: false,
            unique: true,
            max: 100,
        });

        console.log("Adding profiles.supabase_id...");

        await pb.collections.update(profiles.id, {
            fields: profiles.fields,
        });

        console.log("✓ profiles.supabase_id added");
    } else {
        console.log("✓ profiles.supabase_id already exists");
    }

    // --------------------------------------------------
    // 2. Add supabase_id to alerts
    // --------------------------------------------------

    console.log("\n[2] Checking alerts.supabase_id...");

    // Reload collection after previous update
    const alertsCurrent = await pb.collections.getOne(alerts.id);

    if (!hasField(alertsCurrent, "supabase_id")) {
        alertsCurrent.fields.push({
            name: "supabase_id",
            type: "text",
            required: false,
            unique: true,
            max: 100,
        });

        console.log("Adding alerts.supabase_id...");

        await pb.collections.update(alertsCurrent.id, {
            fields: alertsCurrent.fields,
        });

        console.log("✓ alerts.supabase_id added");
    } else {
        console.log("✓ alerts.supabase_id already exists");
    }

    // --------------------------------------------------
    // 3. Add user relation to profiles
    // --------------------------------------------------

    console.log("\n[3] Checking profiles.user relation...");

    const profilesCurrent = await pb.collections.getOne(profiles.id);

    const existingUserRelation = getField(profilesCurrent, "user");

    if (!existingUserRelation) {
        profilesCurrent.fields.push({
            name: "user",
            type: "relation",
            required: false,
            collectionId: users.id,
            cascadeDelete: false,
            minSelect: null,
            maxSelect: 1,
        });

        console.log("Adding profiles.user relation...");

        await pb.collections.update(profilesCurrent.id, {
            fields: profilesCurrent.fields,
        });

        console.log("✓ profiles.user → users");
    } else {
        console.log("✓ profiles.user already exists");
    }

    // --------------------------------------------------
    // 4. Add user relation to alerts
    // --------------------------------------------------

    console.log("\n[4] Checking alerts.user relation...");

    const alertsFinal = await pb.collections.getOne(alerts.id);

    const existingAlertUserRelation = getField(
        alertsFinal,
        "user"
    );

    if (!existingAlertUserRelation) {
        alertsFinal.fields.push({
            name: "user",
            type: "relation",
            required: false,
            collectionId: profiles.id,
            cascadeDelete: false,
            minSelect: null,
            maxSelect: 1,
        });

        console.log("Adding alerts.user relation...");

        await pb.collections.update(alertsFinal.id, {
            fields: alertsFinal.fields,
        });

        console.log("✓ alerts.user → profiles");
    } else {
        console.log("✓ alerts.user already exists");
    }

    // --------------------------------------------------
    // Done
    // --------------------------------------------------

    console.log("\n==============================================");
    console.log(" SCHEMA FIX COMPLETE");
    console.log("==============================================");

    console.log(`
Added/verified:

profiles
  ├── supabase_id
  └── user → users

alerts
  ├── supabase_id
  └── user → profiles

No Supabase data was modified.
No records were migrated.
`);

    pb.authStore.clear();
}

main().catch((error) => {
    console.error("\n❌ ERROR");
    console.error(error.response?.data || error);
    process.exit(1);
});