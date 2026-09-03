const { getPb, processKeywordAlerts } = require('./scraper/pocketbase');
const NotificationService = require('./backend/services/NotificationService');

async function run() {
    const pb = await getPb();
    
    console.log("Creating a mock post that matches '2 BHK'...");
    
    // We need a real post ID so the relation works. 
    // Let's insert a temporary post.
    const mockPost = await pb.collection('posts').create({
        body: "Looking for a 2 BHK apartment in Rajkot for my family.",
        author: "Test User",
        group_name: "Rajkot Flats",
        post_type: "Looking",
        url: "https://facebook.com/test1234",
        scraped_at: new Date().toISOString(),
        supabase_id: "test_uuid_" + Date.now()
    });

    console.log("Mock post inserted. ID:", mockPost.id);
    
    console.log("\nRunning Keyword Alerts...");
    await processKeywordAlerts(mockPost);
    
    console.log("\nProcessing Pending Batches (Email Dispatching)...");
    await NotificationService.processPendingBatches(pb);
    
    console.log("\nCleaning up mock post...");
    await pb.collection('posts').delete(mockPost.id);
    console.log("Cleanup done.");
}

run().catch(console.error);
