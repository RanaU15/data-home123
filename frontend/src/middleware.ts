import { defineMiddleware } from 'astro:middleware';
import { getUser } from './lib/auth';

const authPages = [
  '/login',
  '/register',
  '/forgot-password',
  '/reset-password'
];

// Routes that REQUIRE authentication
const protectedRoutes = [
  '/alerts/create',
  '/alerts/edit',
  '/notifications'
];

export const onRequest = defineMiddleware(async (context, next) => {
  const { url, redirect } = context;
  const pathname = url.pathname;

  const { user } = await getUser(context);

  const isAuthPage = authPages.some(route =>
    pathname === route || pathname.startsWith(route + '/')
  );

  const isProtectedRoute = protectedRoutes.some(route =>
    pathname === route || pathname.startsWith(route + '/')
  );

  // Only protect alerts & notifications
  if (!user && isProtectedRoute) {
    return redirect(
      `/login?redirect=${encodeURIComponent(pathname)}`
    );
  }

  // Prevent logged-in users from visiting auth pages
  if (user && isAuthPage) {
    return redirect('/');
  }

  return next();
});