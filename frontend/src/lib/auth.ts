import { createSupabaseServerClient } from './supabase';
import type { AstroGlobal } from 'astro';

export const getUser = async (context: { cookies: AstroGlobal['cookies'], request: Request }) => {
  const supabase = createSupabaseServerClient(context);
  const { data, error } = await supabase.auth.getUser();
  return { user: data?.user, error };
};

export const logout = async (context: { cookies: AstroGlobal['cookies'], request: Request }) => {
  const supabase = createSupabaseServerClient(context);
  await supabase.auth.signOut();
};
