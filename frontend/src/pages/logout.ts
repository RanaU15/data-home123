import type { APIRoute } from 'astro';
import { logout } from '../lib/auth';
import { createPocketBaseServerClient, updatePocketBaseCookie } from '../lib/pocketbase';

export const GET: APIRoute = async (context) => {
  const pb = createPocketBaseServerClient(context);
  try {
    const userRec = pb.authStore.record;
    if (userRec) {
      const profile = await pb.collection('profiles').getFirstListItem(`user="${userRec.id}"`);
      await pb.collection('profiles').update(profile.id, { is_logged_in: false });
    }
  } catch (e) {
    console.error("Failed to set is_logged_in=false on logout", e);
  }
  
  await logout(context);
  return context.redirect('/');
};

export const POST: APIRoute = async (context) => {
  const pb = createPocketBaseServerClient(context);
  try {
    const userRec = pb.authStore.record;
    if (userRec) {
      const profile = await pb.collection('profiles').getFirstListItem(`user="${userRec.id}"`);
      await pb.collection('profiles').update(profile.id, { is_logged_in: false });
    }
  } catch (e) {
    console.error("Failed to set is_logged_in=false on logout", e);
  }

  await logout(context);
  return context.redirect('/');
};
