const PocketBase = require('pocketbase').default;
const pb = new PocketBase('https://pbflat.formics.io');
async function run() {
    await pb.admins.authWithPassword('ranaurvadipsinh1@gmail.com', 'rana@1512@');
    
    // Update notifications rules
    const notifs = await pb.collections.getOne('notifications');
    notifs.listRule = "user.user = @request.auth.id";
    notifs.viewRule = "user.user = @request.auth.id";
    notifs.createRule = "user.user = @request.auth.id";
    notifs.updateRule = "user.user = @request.auth.id";
    notifs.deleteRule = "user.user = @request.auth.id";
    await pb.collections.update('notifications', notifs);
    console.log("Updated notifications rules.");

}
run().catch(console.error);
