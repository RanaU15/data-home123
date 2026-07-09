import { pipeline, env } from '@xenova/transformers';

// Skip local model download for faster initial startup if needed, 
// but by default Transformers.js will download the model to a local cache.
env.allowLocalModels = true;
env.useBrowserCache = false;

let extractor: any = null;

export async function getEmbedding(text: string): Promise<number[]> {
  if (!extractor) {
    extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}
