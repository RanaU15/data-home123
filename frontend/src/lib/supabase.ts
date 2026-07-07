import { createClient } from '@supabase/supabase-js';

export interface Post {
  id: string;
  group_name?: string;
  group_url?: string;
  group_id?: string;
  author?: string;
  author_profile_url?: string;
  author_avatar?: string;
  body?: string;
  post_date?: string;
  post_time_text?: string;
  post_created_at?: string;
  date?: string;
  permalink?: string;
  post_url?: string;
  likes?: number;
  comments?: number;
  shares?: number;
  reaction_count?: number;
  comment_count?: number;
  share_count?: number;
  screenshot?: string;
  image_urls?: string[];
  video_urls?: string[];
  video_thumbnail?: string;
  video_duration?: string;
  video_count?: number;
  has_video?: boolean;
  post_type?: string;
  scraped_at?: string;
  temporary_id?: string;
  needs_permalink?: boolean;
  facebook_post_id?: string;
  facebook_video_url?: string;
  facebook_post_datetime?: string;
  facebook_post_time_text?: string;
}

const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL || 'https://gimjsxpwteluwiopcrqq.supabase.co';
const supabaseAnonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdpbWpzeHB3dGVsdXdpb3BjcnFxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MjM3MjQxNSwiZXhwIjoyMDk3OTQ4NDE1fQ.yOAo3SHHckS1m5R1WK6vGza0IK_Yb2BI0aepjTE5aYM';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

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
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(d);
  } catch (e) {
    return dateStr;
  }
}

export function getDisplayDate(post: Post): string {
  const formatIST = (dateStr: string) => {
    try {
      const d = new Date(dateStr);
      if (!isNaN(d.getTime())) {
        const formatter = new Intl.DateTimeFormat('en-US', {
          timeZone: 'Asia/Kolkata',
          day: 'numeric',
          month: 'short',
          year: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true
        });
        const parts = formatter.formatToParts(d);
        const p: Record<string, string> = {};
        for (const part of parts) p[part.type] = part.value;
        return `${p.day} ${p.month} ${p.year} • ${p.hour}:${p.minute} ${p.dayPeriod}`;
      }
    } catch(e) {}
    return null;
  };

  if (post.facebook_post_datetime) {
    const formatted = formatIST(post.facebook_post_datetime);
    if (formatted) return formatted;
  }
  
  if (post.facebook_post_time_text && post.facebook_post_time_text.trim() !== "") {
    const text = post.facebook_post_time_text.trim();
    if (!/^(Unknown|Invalid Date|null|undefined)$/i.test(text)) {
      return text;
    }
  }
  
  if (post.scraped_at) {
    const formatted = formatIST(post.scraped_at);
    if (formatted) return formatted;
  }
  
  return 'Time unavailable';
}
