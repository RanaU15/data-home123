const PocketBase = require('pocketbase').default;
const pb = new PocketBase('https://pbflat.formics.io');
pb.autoCancellation(false);

async function run() {
    await pb.admins.authWithPassword('ranaurvadipsinh1@gmail.com', 'rana@1512@');
    
    const profsCol = await pb.collections.getOne('profiles');
    const hasField = profsCol.fields.find(f => f.name === 'is_logged_in');
    
    if (!hasField) {
        profsCol.fields.push({
            name: "is_logged_in",
            type: "bool",
            required: false,
            presentable: false,
            system: false
        });
        await pb.collections.update('profiles', { fields: profsCol.fields });
        console.log("Added is_logged_in to profiles collection.");
    } else {
        console.log("is_logged_in already exists.");
    }
}

run().catch(console.error);
