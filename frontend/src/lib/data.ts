import { pb } from './pocketbase';

let cachedPosts: any[] | null = null;
let lastFetchTime = 0;
const CACHE_TTL = 1000 * 15; // 15 seconds cache for near real-time updates

export async function getAllPosts(forceRefresh: boolean = false) {
  if (!forceRefresh && cachedPosts && Date.now() - lastFetchTime < CACHE_TTL) {
    return cachedPosts;
  }

  try {
    const data = await pb.collection('posts').getFullList({
      sort: '-scraped_at',
    });
    
    cachedPosts = data;
    lastFetchTime = Date.now();
  } catch (error) {
    console.error("Error fetching posts:", error);
    if (!cachedPosts) {
      cachedPosts = [];
    }
  }

  return cachedPosts;
}
