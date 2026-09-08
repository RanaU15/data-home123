require("dotenv").config({ path: __dirname + "/.env" });
const PocketBase = require("pocketbase/cjs");

async function main() {
  const pb = new PocketBase('https://pbflat.formics.io');
  await pb.admins.authWithPassword('ranaurvadipsinh1@gmail.com', 'rana@1512@');

  const profile = (await pb.collection('profiles').getList(1, 1)).items[0];
  const posts = await pb.collection('posts').getList(1, 10, { filter: 'source="website"' });

  for (let post of posts.items) {
    if (!post.created_by) {
      await pb.collection('posts').update(post.id, { created_by: profile.id });
      console.log('Updated', post.id);
    }
  }
}
main().catch(console.error);
