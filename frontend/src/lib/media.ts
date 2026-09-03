import type { Post } from './pocketbase';

export function getPocketBaseMediaUrl(collectionName: string, recordId: string, filename: string): string {
  const pbUrl = import.meta.env.PUBLIC_POCKETBASE_URL || 'https://pbflat.formics.io';
  return `${pbUrl}/api/files/${collectionName}/${recordId}/${filename}`;
}

export function resolvePostImages(post: Post | null): string[] {
  if (!post) return [];

  // If there are migrated PocketBase files
  if (post.migrated_images && Array.isArray(post.migrated_images) && post.migrated_images.length > 0) {
    return post.migrated_images.map(filename => getPocketBaseMediaUrl(post.collectionName || 'posts', post.id, filename));
  }

  // Fallback to original image_urls (which may be Supabase URLs or Facebook CDNs)
  // We want to avoid Supabase URLs if possible, but keep Facebook ones.
  let images: string[] = post.image_urls || [];
  
  if (images.length === 0 && post.images) {
    let oldImages = Array.isArray(post.images) ? post.images : [];
    if (typeof post.images === 'string') {
      try { oldImages = JSON.parse(post.images); } catch(e) {}
    }
    // Ignore supabase urls
    images = oldImages.filter((img: string) => !img.includes('supabase.co'));
  }

  return images;
}

export function resolvePostVideos(post: Post | null): string[] {
  if (!post) return [];
  if (post.migrated_videos && Array.isArray(post.migrated_videos) && post.migrated_videos.length > 0) {
    return post.migrated_videos.map(filename => getPocketBaseMediaUrl(post.collectionName || 'posts', post.id, filename));
  }
  return post.video_urls || [];
}

export function resolvePostVideoThumbnail(post: Post | null): string | null {
  if (!post) return null;
  if (post.migrated_video_thumbnails && Array.isArray(post.migrated_video_thumbnails) && post.migrated_video_thumbnails.length > 0) {
    return getPocketBaseMediaUrl(post.collectionName || 'posts', post.id, post.migrated_video_thumbnails[0]);
  }
  return post.video_thumbnail || null;
}
