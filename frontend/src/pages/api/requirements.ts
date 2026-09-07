import type { APIRoute } from 'astro';
import { createPocketBaseServerClient } from '../../lib/pocketbase';
import PocketBase from 'pocketbase';

export const POST: APIRoute = async ({ request, cookies }) => {
  const pb = createPocketBaseServerClient({ cookies, request });

  // 1. Verify authentication
  if (!pb.authStore.isValid) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const data = await request.json();
    const { body, location, property_type, preferred_tenant, author_name } = data;

    // 2. Validate the requirement content
    if (!body || typeof body !== 'string' || body.trim() === '') {
      return new Response(JSON.stringify({ error: 'Requirement description is required.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Determine created_by (we need the profile ID of the user)
    const userRec = pb.authStore.record;
    let profileId = null;
    if (userRec) {
      try {
        const profile = await pb.collection('profiles').getFirstListItem(`user="${userRec.id}"`);
        profileId = profile.id;
      } catch (e) {
        console.error('Could not find profile for user', userRec.id);
      }
    }

    // 3. Create the requirement post using an Admin client
    const adminPb = new PocketBase(process.env.PUBLIC_POCKETBASE_URL || import.meta.env.PUBLIC_POCKETBASE_URL || 'https://pbflat.formics.io');
    const adminEmail = process.env.PB_ADMIN_EMAIL || import.meta.env.PB_ADMIN_EMAIL || 'ranaurvadipsinh1@gmail.com';
    const adminPass = process.env.PB_ADMIN_PASSWORD || import.meta.env.PB_ADMIN_PASSWORD || 'rana@1512@';
    
    await adminPb.admins.authWithPassword(adminEmail, adminPass);

    const postData = {
      body: body.trim(),
      location: location || '',
      property_type: property_type || '',
      preferred_tenant: preferred_tenant || '',
      source: 'website',
      post_type: 'requirement',
      author: author_name?.trim() || userRec?.name || userRec?.email || 'User',
      created_by: profileId,
      scraped_at: new Date().toISOString(),
      supabase_id: `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
    };

    const newPost = await adminPb.collection('posts').create(postData);

    // Return the newly created post
    return new Response(JSON.stringify({ success: true, post: newPost }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('Failed to create requirement:', error);
    return new Response(JSON.stringify({ error: error.message || 'Internal Server Error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
