const PocketBase = require('pocketbase').default;
const pb = new PocketBase('https://pbflat.formics.io');
pb.autoCancellation(false);
async function run() {
    await pb.admins.authWithPassword('ranaurvadipsinh1@gmail.com', 'rana@1512@');
    const posts = await pb.collection('posts').getFullList({filter: 'has_video = true'});
    console.log('Posts with video:', posts.length);
    if (posts.length > 0) {
        console.log('Sample video_urls from first 3:');
        for (let i = 0; i < Math.min(3, posts.length); i++) {
            console.log(posts[i].id, posts[i].video_urls);
        }
    }
}
run().catch(console.error);
