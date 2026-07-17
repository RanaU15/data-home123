// import { pipeline, env } from '@xenova/transformers';

export async function getEmbedding(text: string): Promise<number[]> {
  console.warn("Local embeddings are disabled in Cloudflare Workers due to 'fs' module limitations.");
  // For now, return an empty array or handle semantic search via a separate API
  return [];
}
