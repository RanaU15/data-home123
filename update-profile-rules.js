const PocketBase = require('pocketbase').default;
const pb = new PocketBase('https://pbflat.formics.io');
pb.autoCancellation(false);

async function run() {
    await pb.admins.authWithPassword('ranaurvadipsinh1@gmail.com', 'rana@1512@');
    
    await pb.collections.update('profiles', {
        createRule: '@request.auth.id != "" && user = @request.auth.id',
        viewRule: 'user = @request.auth.id',
        listRule: 'user = @request.auth.id'
    });
    console.log("Profiles rules updated!");
}

run().catch(console.error);
