require("dotenv").config();

const PocketBase = require("pocketbase").default;

const POCKETBASE_URL = process.env.POCKETBASE_URL;
const PB_ADMIN_EMAIL = process.env.PB_ADMIN_EMAIL;
const PB_ADMIN_PASSWORD = process.env.PB_ADMIN_PASSWORD;

const COLLECTIONS = [
    "users",
    "profiles",
    "posts",
    "notifications",
    "alerts",
    "group_sync_6mo",
];

async function main() {
    console.log("==============================================");
    console.log(" PocketBase Schema Verification");
    console.log("==============================================");
    console.log("");

    const pb = new PocketBase(POCKETBASE_URL);

    console.log(`Connecting to PocketBase: ${POCKETBASE_URL}`);

    await pb
        .collection("_superusers")
        .authWithPassword(
            PB_ADMIN_EMAIL,
            PB_ADMIN_PASSWORD
        );

    console.log("PocketBase superuser authenticated.");
    console.log("");

    let errors = 0;

    for (const name of COLLECTIONS) {
        console.log("----------------------------------------------");
        console.log(`Collection: ${name}`);

        try {
            const collection = await pb.collections.getOne(
                name === "users"
                    ? "_pb_users_auth_"
                    : name
            );

            console.log(`ID:   ${collection.id}`);
            console.log(`Type: ${collection.type}`);
            console.log("");

            console.log("Fields:");

            for (const field of collection.fields || []) {
                let extra = "";

                if (field.type === "relation") {
                    extra =
                        ` -> ${field.collectionId}` +
                        ` (maxSelect=${field.maxSelect})`;
                }

                console.log(
                    `  ${field.name} | ${field.type}${extra}`
                );
            }

            console.log("");

        } catch (error) {
            errors++;

            console.error(
                `ERROR: Could not read collection "${name}"`
            );

            console.error(error.message);
        }
    }

    console.log("");
    console.log("==============================================");
    console.log("VERIFICATION COMPLETE");
    console.log("==============================================");

    if (errors === 0) {
        console.log("All 6 collections are accessible.");
    } else {
        console.log(`${errors} collection(s) have errors.`);
    }

    console.log("");
    console.log("No data was modified.");
}

main().catch((error) => {
    console.error("");
    console.error("==============================================");
    console.error("ERROR");
    console.error("==============================================");
    console.error(error);
    process.exit(1);
});