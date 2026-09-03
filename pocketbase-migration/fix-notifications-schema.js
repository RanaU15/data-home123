require("dotenv").config();

const PocketBase = require("pocketbase/cjs");

const pb = new PocketBase(process.env.POCKETBASE_URL);

async function main() {
    console.log("Connecting to PocketBase...");

    await pb.collection("_superusers").authWithPassword(
        process.env.PB_ADMIN_EMAIL,
        process.env.PB_ADMIN_PASSWORD
    );

    console.log("✓ PocketBase authenticated");

    const collection = await pb.collections.getOne("notifications");

    const exists = collection.fields.some(
        (field) => field.name === "supabase_id"
    );

    if (exists) {
        console.log("✓ notifications.supabase_id already exists");
        return;
    }

    console.log("Adding notifications.supabase_id...");

    collection.fields.push({
        name: "supabase_id",
        type: "text",
        required: false,
        unique: true,
        options: {
            min: null,
            max: null,
            pattern: "",
        },
    });

    await pb.collections.update(collection.id, collection);

    console.log("✓ notifications.supabase_id added");
    console.log("");
    console.log("SCHEMA FIX COMPLETE");
}

main().catch((error) => {
    console.error("");
    console.error("❌ SCHEMA FIX ERROR");
    console.error(error?.response || error?.message || error);
    process.exit(1);
});