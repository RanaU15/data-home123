const PocketBase = require('pocketbase').default;
const pb = new PocketBase('https://pbflat.formics.io');
pb.autoCancellation(false);

async function run() {
    await pb.admins.authWithPassword('ranaurvadipsinh1@gmail.com', 'rana@1512@');
    
    const users = await pb.collection('users').getFullList();
    
    for (const u of users) {
        try {
            await pb.collection('users').update(u.id, {
                password: "password123",
                passwordConfirm: "password123"
            });
            console.log(`Updated password for ${u.email} to password123`);
        } catch (e) {
            console.error(`Failed to update ${u.email}`, e.message);
        }
    }
}

run().catch(console.error);
