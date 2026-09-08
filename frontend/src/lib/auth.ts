import { createPocketBaseServerClient, updatePocketBaseCookie } from './pocketbase';
import type { AstroGlobal } from 'astro';

export const getUser = async (context: { cookies: AstroGlobal['cookies'], request: Request }) => {
  const pb = createPocketBaseServerClient(context);
  
  if (pb.authStore.isValid) {
    try {
      // Optional: refresh the token to ensure it's still valid
      await pb.collection('users').authRefresh();
      updatePocketBaseCookie(context, pb);
      const user = (pb.authStore as any).record || (pb.authStore as any).model;
      let profileId = null;
      if (user) {
        try {
          const profile = await pb.collection('profiles').getFirstListItem(`user="${user.id}"`);
          profileId = profile.id;
        } catch (e) {
          // Profile might not exist yet
        }
      }
      return { user: { ...user, profileId }, error: null };
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

export function isRequirementOwner(post: any, currentUser: any) {
  if (!post || post.post_type !== 'requirement') return false;
  if (!currentUser || !currentUser.profileId) return false;

  const ownerId = typeof post.created_by === 'object' ? post.created_by?.id : post.created_by;
  return String(ownerId) === String(currentUser.profileId);
}
