const PocketBase = require('pocketbase').default;
const pb = new PocketBase('https://pbflat.formics.io');
async function run() {
    await pb.admins.authWithPassword('ranaurvadipsinh1@gmail.com', 'rana@1512@');
    const notifs = await pb.collection('notifications').getList(1, 1, { expand: 'user' });
    if (notifs.items.length > 0) {
        const n = notifs.items[0];
        console.log("Notification ID:", n.id);
        console.log("Expand User:", n.expand?.user);
        console.log("Expand User User:", n.expand?.user?.user);
    }
}
run().catch(console.error);
