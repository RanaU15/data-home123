const PocketBase = require('pocketbase').default;
const pb = new PocketBase('https://pbflat.formics.io');
pb.autoCancellation(false);

async function run() {
    await pb.admins.authWithPassword('ranaurvadipsinh1@gmail.com', 'rana@1512@');
    
    const users = await pb.collection('users').getFullList();
    const profiles = await pb.collection('profiles').getFullList();
    
    for (const u of users) {
        const hasProfile = profiles.find(p => p.user === u.id);
        if (!hasProfile) {
            console.log(`Creating profile for ${u.email}...`);
            await pb.collection('profiles').create({
                user: u.id,
                full_name: u.name || 'User',
                email: u.email
            });
            console.log(`Created profile for ${u.email}`);
        }
    }
}

run().catch(console.error);
