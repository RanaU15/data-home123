const PocketBase = require('pocketbase').default;
const pb = new PocketBase('https://pbflat.formics.io');
pb.autoCancellation(false);
async function run() {
    await pb.admins.authWithPassword('ranaurvadipsinh1@gmail.com', 'rana@1512@');
    try {
        const pending = await pb.collection('notifications').getFullList({
            filter: 'email_sent=false && email_batch_id=""',
            expand: 'alert,post,user.user'
        });
        console.log("Success, pending count:", pending.length);
    } catch (err) {
        console.error("❌ Error fetching pending notifications:", err.message);
    }
}
run().catch(console.error);
