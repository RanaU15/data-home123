import { filterPosts, type FilterState } from './filters';
import { getEmbedding } from './embeddings';
import { supabase } from './supabase';

export async function performHybridSearch(allPosts: any[], queryText: string, parsedFilters: FilterState): Promise<any[]> {
  // 1. Exact matches
  const exactMatchPosts = filterPosts(allPosts, parsedFilters, true);
  
  if (!queryText) {
    return exactMatchPosts;
  }

  // 2. Semantic matches
  let vectorResults: any[] = [];
  try {
    const embedding = await getEmbedding(queryText);
    const { data, error } = await supabase.rpc('match_posts', {
      query_embedding: embedding,
      match_threshold: 0.3,
      match_count: 50
    });
    if (error) {
      console.error("Vector search error:", error);
    } else {
      vectorResults = data || [];
    }
  } catch (err) {
    console.error("Failed to generate embedding or query supabase:", err);
  }
  
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
