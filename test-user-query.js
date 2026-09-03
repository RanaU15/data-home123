const PocketBase = require('pocketbase').default;
const pb = new PocketBase('https://pbflat.formics.io');
async function run() {
    // Auth as the user
    await pb.collection('users').authWithPassword('test15200512@gmail.com', 'password123');
    const notifs = await pb.collection('notifications').getList(1, 50, {
        expand: 'alert,post',
        sort: '-created_at'
    });
    console.log("Found notifs as user:", notifs.items.length);
}
run().catch(console.error);
