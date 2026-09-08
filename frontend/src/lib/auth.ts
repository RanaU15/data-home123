import { createPocketBaseServerClient, pb, updatePocketBaseCookie } from './pocketbase';
import type { AstroGlobal } from 'astro';

export async function loginWithGoogle() {
  return loginWithOAuthProvider('google');
}

export async function loginWithFacebook() {
  return pb.collection('users').authWithOAuth2({
    provider: 'facebook',
    scopes: ['public_profile']
  });
}

async function loginWithOAuthProvider(provider: 'google' | 'facebook') {
  const authData = await pb.collection('users').authWithOAuth2({ provider });
  if (!pb.authStore.isValid || !pb.authStore.record) {
    throw new Error('OAuth login did not return a valid PocketBase session.');
  }
  return authData;
}

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
        } catch (e: any) {
          if (e?.status !== 404) {
            console.error('Failed to load profile for authenticated user', e);
          } else {
            try {
              const profile = await pb.collection('profiles').create({
                user: user.id,
                full_name: user.name || user.email || 'User',
                email: user.email || '',
                is_logged_in: true
              });
              profileId = profile.id;
            } catch (profileError) {
              console.error('Failed to create profile for authenticated user', profileError);
            }
          }
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
