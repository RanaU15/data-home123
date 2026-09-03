const PocketBase = require('pocketbase').default;
const pb = new PocketBase('https://pbflat.formics.io');
async function run() {
    await pb.admins.authWithPassword('ranaurvadipsinh1@gmail.com', 'rana@1512@');
    let items = await pb.collection('notifications').getFullList({ batch: 200 });
    let count = 0;
    for (const notif of items) {
        if (!notif.created_at) {
            await pb.collection('notifications').update(notif.id, { created_at: notif.created });
            count++;
        }
    }
    console.log("Updated", count);
}
run().catch(console.error);
