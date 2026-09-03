const PocketBase = require('pocketbase').default;
const pb = new PocketBase('https://pbflat.formics.io');
async function run() {
    await pb.collection('users').authWithPassword('test15200512@gmail.com', 'password123');
    const notifs = await pb.collection('notifications').getList(1, 5, {
        expand: 'alert,post',
        sort: '-created'
    });
    console.log("Top 5 notifs:", JSON.stringify(notifs.items.map(n => ({
        id: n.id,
        created_at: n.created_at,
        alert: n.expand?.alert?.name,
        post_available: !!n.expand?.post,
        is_read: n.is_read
    })), null, 2));
}
run().catch(console.error);
