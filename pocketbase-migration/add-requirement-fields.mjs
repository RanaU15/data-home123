import PocketBase from 'pocketbase';
import dotenv from 'dotenv';

dotenv.config();

const pbUrl = process.env.POCKETBASE_URL || 'http://127.0.0.1:8091';
const adminEmail = process.env.PB_ADMIN_EMAIL || 'admin@example.com';
const adminPassword = process.env.PB_ADMIN_PASSWORD || 'admin1234';

const pb = new PocketBase(pbUrl);

async function addRequirementFields() {
  try {
    await pb.admins.authWithPassword(adminEmail, adminPassword);
    console.log('Logged in as admin successfully.');

    // 1. Get the current schema for 'posts' collection
    const postsCollection = await pb.collections.getOne('posts');
    const existingSchema = postsCollection.fields || postsCollection.schema || [];

    const newFields = [
      {
        name: 'source',
        type: 'text',
        required: false,
        min: null, max: null, pattern: ''
      },
      {
        name: 'post_type',
        type: 'text',
        required: false,
        min: null, max: null, pattern: ''
      },
      {
        name: 'created_by',
        type: 'relation',
        required: false,
        collectionId: (await pb.collections.getOne('profiles')).id,
        cascadeDelete: false,
        minSelect: 0,
        maxSelect: 1
      }
    ];

    let schemaUpdated = false;

    for (const field of newFields) {
      if (!existingSchema.find(f => f.name === field.name)) {
        console.log(`Adding missing field: ${field.name}`);
        existingSchema.push(field);
        schemaUpdated = true;
      } else {
        console.log(`Field ${field.name} already exists.`);
      }
    }

    if (schemaUpdated) {
      if (postsCollection.fields) {
          postsCollection.fields = existingSchema;
      } else {
          postsCollection.schema = existingSchema;
      }
      await pb.collections.update('posts', postsCollection);
      console.log('Successfully updated posts collection schema.');
    } else {
      console.log('No schema updates were necessary.');
    }

  } catch (err) {
    console.error('Migration failed:', err.message);
    if (err.response) {
      console.error(JSON.stringify(err.response, null, 2));
    }
  }
}

addRequirementFields();
