require("dotenv").config({ path: __dirname + "/.env" });
const PocketBase = require("pocketbase/cjs");

async function main() {
  const pb = new PocketBase('https://pbflat.formics.io');
  await pb.admins.authWithPassword('ranaurvadipsinh1@gmail.com', 'rana@1512@');
  
  const posts = await pb.collection('posts').getList(1, 5, { filter: 'source="website"', expand: 'created_by' });
  
  console.log(JSON.stringify(posts.items.map(i => ({
    id: i.id, 
    created_by: i.created_by, 
    expanded_user: i.expand?.created_by?.user
  })), null, 2));
}
main().catch(console.error);
