const PocketBase = require('pocketbase').default;

const POCKETBASE_URL = 'https://pbflat.formics.io';
const pb = new PocketBase(POCKETBASE_URL);
pb.autoCancellation(false);

async function fixRules() {
    console.log("Authenticating as Admin...");
    await pb.admins.authWithPassword("ranaurvadipsinh1@gmail.com", "rana@1512@");

    console.log("Updating posts rules...");
    // Posts: public read, admin write
    await pb.collections.update("posts", {
        listRule: "",
        viewRule: ""
    });

    console.log("Updating users rules...");
    // Users: Users can read/update themselves
    await pb.collections.update("users", {
        listRule: "id = @request.auth.id",
        viewRule: "id = @request.auth.id",
        updateRule: "id = @request.auth.id"
    });

    console.log("Updating profiles rules...");
    // Profiles: public read (to link post authors), user update
    await pb.collections.update("profiles", {
        listRule: "",
        viewRule: "",
        updateRule: "user = @request.auth.id"
    });

    console.log("Updating alerts rules...");
    // Alerts: only owner can read/write
    await pb.collections.update("alerts", {
        listRule: "user_id = @request.auth.id",
        viewRule: "user_id = @request.auth.id",
        createRule: "@request.auth.id != '' && user_id = @request.auth.id",
        updateRule: "user_id = @request.auth.id",
        deleteRule: "user_id = @request.auth.id"
    });

    console.log("Updating notifications rules...");
    // Notifications: only owner can read, admin write
    await pb.collections.update("notifications", {
        listRule: "user = @request.auth.id",
        viewRule: "user = @request.auth.id",
        updateRule: "user = @request.auth.id",
        deleteRule: "user = @request.auth.id"
    });

    console.log("Done updating rules!");
}

fixRules().catch(console.error);
