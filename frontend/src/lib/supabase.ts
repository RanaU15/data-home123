import { createClient } from '@supabase/supabase-js';

export interface Post {
  id: string;
  group_name?: string;
  group_url?: string;
  group_id?: string;
  author?: string;
  body?: string;
  post_date?: string;
  date?: string;
  permalink?: string;
  likes?: number;
  comments?: number;
  shares?: number;
  screenshot?: string;
  images?: any;
  scraped_at?: string;
  temporary_id?: string;
  needs_permalink?: boolean;
  facebook_post_id?: string;
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

export function formatDate(dateStr?: string): string {
  if (!dateStr) return 'Unknown date';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return new Intl.DateTimeFormat('en-US', {
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
