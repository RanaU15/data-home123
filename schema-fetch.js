const PocketBase = require('pocketbase').default;
const pb = new PocketBase('https://pbflat.formics.io');
pb.autoCancellation(false);

async function run() {
    await pb.admins.authWithPassword('ranaurvadipsinh1@gmail.com', 'rana@1512@');
    
    const profsCol = await pb.collections.getOne('profiles');
    console.log("PROFILES:", JSON.stringify(profsCol, null, 2));
}

run().catch(console.error);
