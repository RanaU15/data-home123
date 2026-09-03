const { upsertPostToSupabase, getPb } = require('./scraper/pocketbase.js');

async function runTestScrape() {
    console.log("Starting controlled test scrape batch...");
    const pb = await getPb();

    // PHASE 2: Baseline
    const users = await pb.collection("users").getList(1, 1);
    const profiles = await pb.collection("profiles").getList(1, 1);
    const postsBefore = await pb.collection("posts").getList(1, 1);
    const notifsBefore = await pb.collection("notifications").getList(1, 1);
    const alertsBefore = await pb.collection("alerts").getList(1, 1);

    console.log("\n--- BASELINE ---");
    console.log("users:", users.totalItems);
    console.log("profiles:", profiles.totalItems);
    console.log("posts:", postsBefore.totalItems);
    console.log("notifications:", notifsBefore.totalItems);
    console.log("alerts:", alertsBefore.totalItems);

    // PHASE 3: Insert test batch
    const testPosts = [];
    for(let i = 1; i <= 15; i++) {
        testPosts.push({
            group_name: "TEST_QA_GROUP",
            group_id: "test_qa_group_999",
            author: "QA Tester",
            body: `This is test post number ${i} for migration testing. Keyword: MIGRATE${i}`,
            permalink: `https://facebook.com/test_qa_group/posts/999${i}`,
            facebook_post_id: `999${i}`,
            temporary_id: `temp_999${i}`,
            image_urls: [`https://example.com/test_image_${i}.jpg`],
            video_urls: [],
            post_type: "Test",
            scraped_at: new Date().toISOString()
        });
    }

    console.log("\nInserting 15 test posts via scraper integration...");
    const result = await upsertPostToSupabase(testPosts);
    if (result.error) {
        console.error("Failed to insert:", result.error);
        return;
    }

    console.log(`Inserted ${result.data.length} records.`);

    // Check new counts
    const postsAfter = await pb.collection("posts").getList(1, 1);
    console.log(`\n--- AFTER INSERT ---`);
    console.log(`posts: ${postsAfter.totalItems}`);

    // PHASE 12: Duplicate detection
    console.log("\nRunning duplicate detection test (re-inserting same batch)...");
    const result2 = await upsertPostToSupabase(testPosts);
    const postsAfterDup = await pb.collection("posts").getList(1, 1);
    
    // In upsertPostToSupabase, if a post exists, it updates it rather than skipping, so count should remain the same.
    console.log(`After duplicate run posts: ${postsAfterDup.totalItems}`);
    console.log(`Duplicates created: ${postsAfterDup.totalItems - postsAfter.totalItems}`);

}

runTestScrape().catch(console.error);
