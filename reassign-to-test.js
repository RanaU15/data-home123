require("dotenv").config({ path: __dirname + "/.env" });
const PocketBase = require("pocketbase/cjs");

async function main() {
  const pb = new PocketBase('https://pbflat.formics.io');
  await pb.admins.authWithPassword('ranaurvadipsinh1@gmail.com', 'rana@1512@');
  
  const testProfileId = '0a6a4dslevy7p82';
  const posts = await pb.collection('posts').getList(1, 20, { filter: 'source="website"' });
  
  for (let post of posts.items) {
    // If it was assigned to Rana, reassign to test user so they can test it
    if (post.created_by === 'cn9hb4tnw40hzbn' || !post.created_by) {
      await pb.collection('posts').update(post.id, { created_by: testProfileId });
      console.log('Reassigned', post.id, post.body.substring(0, 20));
    }
  }
}
main().catch(console.error);
