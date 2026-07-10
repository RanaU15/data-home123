import { supabase } from './supabase';

let cachedPosts: any[] | null = null;
let lastFetchTime = 0;
const CACHE_TTL = 1000 * 60 * 5; // 5 minutes cache

export async function getAllPosts() {
  if (cachedPosts && Date.now() - lastFetchTime < CACHE_TTL) {
    return cachedPosts;
  }

  let allPosts: any[] = [];
  let from = 0;
  const pageSize = 1000;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await supabase
      .from('posts')
      .select('*')
      .order('scraped_at', { ascending: false })
      .range(from, from + pageSize - 1);

    if (error) {
      console.error("Error fetching posts:", error);
      break;
    }

    if (data && data.length > 0) {
      allPosts = allPosts.concat(data);
      from += pageSize;
      if (data.length < pageSize) {
        hasMore = false;
      }
    } else {
      hasMore = false;
    }
  }

  cachedPosts = allPosts;
  lastFetchTime = Date.now();
  return cachedPosts;
}
