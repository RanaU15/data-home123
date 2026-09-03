const PocketBase = require('pocketbase').default;
const POCKETBASE_URL = 'https://pbflat.formics.io';

async function testFrontend() {
    console.log("Simulating frontend requests...");

    // Simulate global pb instance in Astro
    const pb = new PocketBase(POCKETBASE_URL);
    pb.autoCancellation(false);

    try {
        console.log("Fetching posts (simulating getAllPosts)...");
        const data = await pb.collection('posts').getFullList({
            sort: '-scraped_at',
            batch: 100 // smaller batch to finish fast
        });
        console.log(`Success! Fetched ${data.length} posts without 403 error.`);
    } catch (e) {
        console.error("Error fetching posts:", e.message);
        console.error(e);
        process.exit(1);
    }

    try {
        console.log("Simulating individual post load...");
        const post = await pb.collection('posts').getFirstListItem('');
        console.log(`Success! Loaded post ${post.id}`);
    } catch (e) {
        console.error("Error loading single post:", e.message);
        process.exit(1);
    }

    console.log("All frontend simulated data fetches passed! No 403 or RefcountedCanceler errors.");
}

testFrontend();
