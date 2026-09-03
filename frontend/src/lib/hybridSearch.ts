import { filterPosts, type FilterState } from './filters';
import { getEmbedding } from './embeddings';

export async function performHybridSearch(allPosts: any[], queryText: string, parsedFilters: FilterState): Promise<any[]> {
  // 1. Exact matches
  const exactMatchPosts = filterPosts(allPosts, parsedFilters, true);
  
  if (!queryText) {
    return exactMatchPosts;
  }

  // 2. Semantic matches (Bypassed since PocketBase does not natively support vector search
  // and local embeddings in CF workers are disabled anyway)
  let vectorResults: any[] = [];
  
  const vectorIds = new Set(vectorResults.map((r: any) => r.id));
  
  // Filter allPosts to those returned by vector search, AND passing strict filters
  const semanticMatchPosts = filterPosts(
    allPosts.filter(p => vectorIds.has(p.id)), 
    parsedFilters, 
    false // strictLocation = false
  );
  
  // Merge and deduplicate
  const exactIds = new Set(exactMatchPosts.map(p => p.id));
  const newSemanticPosts = semanticMatchPosts.filter(p => !exactIds.has(p.id));
  
  return [...exactMatchPosts, ...newSemanticPosts];
}
