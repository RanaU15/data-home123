const PocketBase = require('pocketbase').default;
const pb = new PocketBase('https://pbflat.formics.io');
async function run() {
    await pb.admins.authWithPassword('ranaurvadipsinh1@gmail.com', 'rana@1512@');
    const userEmail = 'test15200512@gmail.com';
    const user = await pb.collection('users').getFirstListItem(`email="${userEmail}"`);
    console.log("User ID:", user.id);
    const notifs = await pb.collection('notifications').getList(1, 50, {
        filter: `user.user="${user.id}"`,
        sort: '-created_at',
        expand: 'alert,post'
    });
    console.log("Found notifs:", notifs.items.length);
}
run().catch(console.error);
