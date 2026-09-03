const PocketBase = require('pocketbase').default;
const pb = new PocketBase('https://pbflat.formics.io');
async function run() {
    await pb.admins.authWithPassword('ranaurvadipsinh1@gmail.com', 'rana@1512@');
    
    let page = 1;
    let totalUpdated = 0;
    while(true) {
        const batch = await pb.collection('notifications').getList(page, 100, {
            filter: 'created_at="" || created_at=null'
        });
        
        if (batch.items.length === 0) break;
        
        for (const notif of batch.items) {
            // we use the system 'created' field to backfill
            await pb.collection('notifications').update(notif.id, { created_at: notif.created });
            totalUpdated++;
        }
        
        // PocketBase handles pagination nicely, but since we are filtering out those we update,
        // we can just keep pulling page 1 until it's empty. Wait, if we keep pulling page 1:
    }
    
    console.log(`Backfilled ${totalUpdated} notifications.`);
}
run().catch(console.error);
