import PocketBase from 'pocketbase';
import type { AstroCookies } from 'astro';

export interface Post {
  id: string;
  group_name?: string;
  group_url?: string;
  group_id?: string;
  author?: string;
  author_profile_url?: string;
  author_avatar?: string;
  body?: string;
  permalink?: string;
  post_url?: string;
  likes?: number;
  comments?: number;
  shares?: number;
  reaction_count?: number;
  comment_count?: number;
  share_count?: number;
  screenshot?: string;
  images?: any;
  image_urls?: string[];
  video_urls?: string[];
  video_thumbnail?: string;
  video_duration?: string;
  video_count?: number;
  has_video?: boolean;
  post_type?: string;
  location?: string;
  property_type?: string;
  preferred_tenant?: string;
  requirement?: string;
  scraped_at?: string;
  temporary_id?: string;
  needs_permalink?: boolean;
  facebook_post_id?: string;
  facebook_video_url?: string;
  source?: string;
  created_by?: string;
  
  // PocketBase migration fields
  supabase_id?: string;
  migrated_images?: string[];
  migrated_videos?: string[];
  migrated_video_thumbnails?: string[];
  collectionId?: string;
  collectionName?: string;
}

const pbUrl = import.meta.env.PUBLIC_POCKETBASE_URL || 'https://pbflat.formics.io';

export const pb = new PocketBase(pbUrl);
pb.autoCancellation(false);

export function parseImages(imagesData: any, screenshot?: string): string[] {
  if (!imagesData) {
    return screenshot ? [screenshot] : [];
  }
  try {
    if (Array.isArray(imagesData)) {
      return imagesData.length > 0 ? imagesData : screenshot ? [screenshot] : [];
    }
    if (typeof imagesData === 'string') {
      const parsed = JSON.parse(imagesData);
      if (Array.isArray(parsed)) {
        return parsed.length > 0 ? parsed : screenshot ? [screenshot] : [];
      }
    }
  } catch (e) {
    // ignore parse error
  }
  return screenshot ? [screenshot] : [];
}

export function parseVideoUrls(videoData: any): string[] {
  if (!videoData) return [];
  try {
    if (Array.isArray(videoData)) return videoData;
    if (typeof videoData === 'string') {
      const parsed = JSON.parse(videoData);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) {}
  return [];
}

export function formatDate(dateStr?: string): string {
  if (!dateStr) return 'Unknown date';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    
    return d.toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true
    });
  } catch (e) {
    return dateStr;
  }
}

export function getDisplayDate(post: Post): string {
  if (post.scraped_at) {
    return formatDate(post.scraped_at);
  }
  return '';
}

export const createPocketBaseServerClient = (context: { cookies: AstroCookies, request: Request }) => {
  const client = new PocketBase(pbUrl);
  client.autoCancellation(false);
  
  // Load from Astro cookies
  const pbAuthCookie = context.cookies.get('pb_auth');
  if (pbAuthCookie && pbAuthCookie.value) {
    try {
      client.authStore.loadFromCookie(`pb_auth=${pbAuthCookie.value}`);
    } catch (e) {
      console.error('Error loading PocketBase auth from cookie', e);
    }
  }

  return client;
};

export const updatePocketBaseCookie = (context: { cookies: AstroCookies }, client: PocketBase) => {
  if (client.authStore.isValid) {
    // Extract the raw cookie string that PocketBase generates and just save the value
    const cookieStr = client.authStore.exportToCookie({ httpOnly: false });
    const match = cookieStr.match(/pb_auth=([^;]+)/);
    if (match && match[1]) {
      context.cookies.set('pb_auth', match[1], {
        path: '/',
        secure: import.meta.env.PROD,
        sameSite: 'lax',
        httpOnly: false,
        maxAge: 60 * 60 * 24 * 7 // 1 week
      });
    }
  } else {
    context.cookies.delete('pb_auth', { path: '/' });
  }
};
