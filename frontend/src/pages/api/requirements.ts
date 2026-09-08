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
    const formData = await request.formData();
    
    const body = formData.get('body')?.toString() || '';
    const location = formData.get('location')?.toString() || '';
    const property_type = formData.get('property_type')?.toString() || '';
    const preferred_tenant = formData.get('preferred_tenant')?.toString() || '';
    const author_name = formData.get('author_name')?.toString() || '';
    const contact_number = formData.get('contact_number')?.toString() || '';

    // 2. Validate the requirement content
    if (!body || body.trim() === '') {
      return new Response(JSON.stringify({ error: 'Requirement description is required.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Extract photos
    const photos = formData.getAll('photos');
    if (photos.length > 5) {
      return new Response(JSON.stringify({ error: 'Maximum 5 photos allowed.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Determine created_by (we need the profile ID of the user)
    const userRec = (pb.authStore as any).record || (pb.authStore as any).model;
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

    const pbFormData = new FormData();
    pbFormData.append('body', body.trim());
    pbFormData.append('location', location);
    pbFormData.append('property_type', property_type);
    pbFormData.append('preferred_tenant', preferred_tenant);
    pbFormData.append('source', 'website');
    pbFormData.append('post_type', 'requirement');
    pbFormData.append('author', author_name.trim() || userRec?.name || userRec?.email || 'User');
    if (profileId) pbFormData.append('created_by', profileId);
    pbFormData.append('scraped_at', new Date().toISOString());
    pbFormData.append('supabase_id', `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`);
    pbFormData.append('contact_number', contact_number);

    for (const photo of photos) {
      // Use duck typing instead of instanceof File because Astro/Node might use a polyfill
      if (photo && typeof photo === 'object' && 'size' in photo && (photo as any).size > 0) {
        const fileObj = photo as any;
        // Convert to standard Node Blob to ensure PocketBase SDK handles it correctly
        const arrayBuffer = await fileObj.arrayBuffer();
        const blob = new Blob([arrayBuffer], { type: fileObj.type || 'image/jpeg' });
        pbFormData.append('migrated_images', blob, fileObj.name || 'image.jpg');
      }
    }

    const newPost = await adminPb.collection('posts').create(pbFormData);

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

export const DELETE: APIRoute = async ({ request, cookies }) => {
  const pb = createPocketBaseServerClient({ cookies, request });

  if (!pb.authStore.isValid) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  try {
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    
    if (!id) {
      return new Response(JSON.stringify({ error: 'Missing ID' }), { status: 400 });
    }
    
    // Attempt deletion. PocketBase API rules will enforce ownership.
    await pb.collection('posts').delete(id);
    
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  } catch (error: any) {
    console.error('Failed to delete requirement:', error);
    return new Response(JSON.stringify({ error: 'Forbidden or Not Found' }), { status: 403 });
  }
};

export const PUT: APIRoute = async ({ request, cookies }) => {
  const pb = createPocketBaseServerClient({ cookies, request });

  if (!pb.authStore.isValid) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  try {
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    
    if (!id) {
      return new Response(JSON.stringify({ error: 'Missing ID' }), { status: 400 });
    }

    // Attempt update. PocketBase API rules will enforce ownership.
    const formData = await request.formData();
    await pb.collection('posts').update(id, formData);
    
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  } catch (error: any) {
    console.error('Failed to update requirement:', error);
    return new Response(JSON.stringify({ error: 'Forbidden or Not Found' }), { status: 403 });
  }
};
