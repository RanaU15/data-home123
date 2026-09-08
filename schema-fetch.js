const PocketBase = require('pocketbase').default;
const pb = new PocketBase('https://pbflat.formics.io');
pb.autoCancellation(false);

async function run() {
    await pb.admins.authWithPassword('ranaurvadipsinh1@gmail.com', 'rana@1512@');
    
    const postsCol = await pb.collections.getOne('posts');
    require('fs').writeFileSync('scratch/posts-schema.json', JSON.stringify(postsCol, null, 2), 'utf-8');
}

run().catch(console.error);
