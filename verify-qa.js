const PocketBase = require('pocketbase').default;
const http = require('http');

async function runQa() {
    const pb = new PocketBase('https://pbflat.formics.io');
    pb.autoCancellation(false);

    console.log("=== QA Verification ===");

    // Phase 5: Search Test
    console.log("\n--- Search Test ---");
    const searchData = await pb.collection('posts').getList(1, 10, {
        filter: `body~"MIGRATE1"`
    });
    console.log(`Keyword search 'MIGRATE1': found ${searchData.totalItems}`);

    // Email Search/Filter Test (Phase 6)
    // The application might not have a specific "email search" but it might just be keyword search.
    // Assuming the user meant filtering by author/body for an email.
    console.log("\n--- Email Search Test ---");
    const emailSearchExists = await pb.collection('posts').getList(1, 10, {
        filter: `body~"test@example.com"`
    });
    console.log(`Email search 'test@example.com': found ${emailSearchExists.totalItems}`);
    
    // Auth Test (Phase 7)
    console.log("\n--- Auth Test ---");
    try {
        await pb.collection("users").authWithPassword("ranaurvadipsinh1@gmail.com", "rana@1512@");
        console.log("Login valid: PASS");
    } catch(e) {
        console.log("Login valid: FAIL", e.message);
    }
    
    try {
        await pb.collection("users").authWithPassword("ranaurvadipsinh1@gmail.com", "wrongpassword");
        console.log("Login invalid: FAIL (should have thrown)");
    } catch(e) {
        console.log("Login invalid: PASS (rejected)");
    }

    pb.authStore.clear();

    // Alerts (Phase 8)
    console.log("\n--- Alerts Test ---");
    await pb.admins.authWithPassword("ranaurvadipsinh1@gmail.com", "rana@1512@");
    const alerts = await pb.collection("alerts").getList(1, 1);
    console.log(`Alerts count: ${alerts.totalItems}`);

    // Cleanup: Delete the 15 test posts
    console.log("\n--- Cleanup ---");
    const testPosts = await pb.collection("posts").getFullList({
        filter: `group_name="TEST_QA_GROUP"`
    });
    console.log(`Found ${testPosts.length} test posts to clean up.`);
    for (const p of testPosts) {
        await pb.collection("posts").delete(p.id);
    }
    console.log("Cleanup complete!");
}

runQa().catch(console.error);
