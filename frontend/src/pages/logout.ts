import type { APIRoute } from 'astro';
import { logout } from '../lib/auth';

export const GET: APIRoute = async (context) => {
  await logout(context);
  return context.redirect('/');
};

export const POST: APIRoute = async (context) => {
  await logout(context);
  return context.redirect('/');
};
