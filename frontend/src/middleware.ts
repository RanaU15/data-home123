import { defineMiddleware } from 'astro:middleware';
import { getUser } from './lib/auth';

const publicRoutes = ['/login', '/register', '/forgot-password', '/reset-password'];

export const onRequest = defineMiddleware(async (context, next) => {
  const { url, redirect } = context;
  const path = url.pathname;

  const { user } = await getUser(context);
  const isPublicRoute = publicRoutes.some(route => path.startsWith(route));

  // If not logged in and not on a public route, redirect to login
  if (!user && !isPublicRoute) {
    return redirect('/login');
  }

  // If logged in and trying to access login/register, redirect to home
  if (user && isPublicRoute) {
    return redirect('/');
  }

  return next();
});
