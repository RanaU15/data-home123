const PocketBase = require('pocketbase').default;
const pb = new PocketBase('https://pbflat.formics.io');
pb.autoCancellation(false);
async function run() {
    await pb.admins.authWithPassword('ranaurvadipsinh1@gmail.com', 'rana@1512@');
    const n = await pb.collection('notifications').getFullList({sort: '-created_at'}); 
    console.log('Total notifs:', n.length);
    if(n.length > 0) {
        console.log('Latest 5:', n.slice(0,5).map(x => ({id: x.id, email_sent: x.email_sent, email_error: x.email_error})));
    }
}
run().catch(console.error);
