import { createPocketBaseServerClient, updatePocketBaseCookie } from './pocketbase';
import type { AstroGlobal } from 'astro';

export const getUser = async (context: { cookies: AstroGlobal['cookies'], request: Request }) => {
  const pb = createPocketBaseServerClient(context);
  
  if (pb.authStore.isValid) {
    try {
      // Optional: refresh the token to ensure it's still valid
      await pb.collection('users').authRefresh();
      updatePocketBaseCookie(context, pb);
      return { user: pb.authStore.model, error: null };
    } catch (error) {
      // Token expired or invalid
      pb.authStore.clear();
      updatePocketBaseCookie(context, pb);
      return { user: null, error };
    }
  }
  
  return { user: null, error: null };
};

export const logout = async (context: { cookies: AstroGlobal['cookies'], request: Request }) => {
  const pb = createPocketBaseServerClient(context);
  pb.authStore.clear();
  updatePocketBaseCookie(context, pb);
};
