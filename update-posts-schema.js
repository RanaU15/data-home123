require("dotenv").config({ path: __dirname + "/.env" });
const PocketBase = require("pocketbase/cjs");

async function main() {
  const pb = new PocketBase(process.env.PUBLIC_POCKETBASE_URL || 'https://pbflat.formics.io');
  
  await pb.admins.authWithPassword(
    process.env.PB_ADMIN_EMAIL || 'ranaurvadipsinh1@gmail.com',
    process.env.PB_ADMIN_PASSWORD || 'rana@1512@'
  );

  console.log("Logged in as admin.");
  
  const collection = await pb.collections.getOne("posts");
  console.log("Found posts collection.");

  let fields = collection.schema || collection.fields || [];
  let changed = false;

  // Add contact_number field if not exists
  if (!fields.find(f => f.name === "contact_number")) {
    fields.push({
      system: false,
      id: "contact_number_str",
      name: "contact_number",
      type: "text",
      required: false,
      presentable: false,
      unique: false,
      options: {
        min: null,
        max: null,
        pattern: ""
      }
    });
    changed = true;
    console.log("Added contact_number field.");
  }
  
  // Add photos field if not exists (we use this instead of migrated_images to be explicit and limit to 5 images)
  // Actually, wait, the user said "If the posts collection already has an image/file field, reuse it."
  // 'migrated_images' already exists, so we will just use that, but we will add a clean 'photos' just in case. 
  // No, let's strictly follow: use 'migrated_images' if it exists. 
  // I will check if 'migrated_images' exists.
  if (fields.find(f => f.name === "migrated_images")) {
    console.log("migrated_images exists, we will use it for photos.");
  } else {
    // If we wanted to create a new one:
    console.log("migrated_images not found?");
  }

  // Add property_type field if not exists
  if (!fields.find(f => f.name === "property_type")) {
    fields.push({ system: false, id: "property_type_str", name: "property_type", type: "text" });
    changed = true;
    console.log("Added property_type field.");
  }
  
  // Add preferred_tenant field if not exists
  if (!fields.find(f => f.name === "preferred_tenant")) {
    fields.push({ system: false, id: "preferred_tenant_str", name: "preferred_tenant", type: "text" });
    changed = true;
    console.log("Added preferred_tenant field.");
  }

  // Set API Rules
  let rulesChanged = false;
  if (collection.createRule !== '@request.auth.id != ""') {
    collection.createRule = '@request.auth.id != ""';
    rulesChanged = true;
  }
  
  const ownerRule = '@request.auth.id != "" && created_by.user = @request.auth.id';
  if (collection.updateRule !== ownerRule) {
    collection.updateRule = ownerRule;
    rulesChanged = true;
  }
  
  if (collection.deleteRule !== ownerRule) {
    collection.deleteRule = ownerRule;
    rulesChanged = true;
  }

  if (changed || rulesChanged) {
    await pb.collections.update("posts", {
      fields: fields,
      createRule: collection.createRule,
      updateRule: collection.updateRule,
      deleteRule: collection.deleteRule
    });
    console.log("Posts collection updated successfully.");
  } else {
    console.log("No changes needed for posts collection.");
  }
}

main().catch(console.error);
