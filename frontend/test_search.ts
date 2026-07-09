import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import { filterPosts, normalizeQuery } from './src/lib/filters.ts';

dotenv.config({ path: './.env' });

const supabase = createClient(process.env.PUBLIC_SUPABASE_URL, process.env.PUBLIC_SUPABASE_ANON_KEY);

async function runTests() {
  const { data: posts, error } = await supabase.from('posts').select('*').order('scraped_at', { ascending: false });
  if (error) {
    console.error(error);
    return;
  }
  
  const testCases = [
    { name: "2bhk paldi", globalQuery: "2bhk paldi", sidebarState: { propertyTypes: ["2bhk"], location: "paldi" } },
    { name: "3bhk bopal", globalQuery: "3bhk bopal", sidebarState: { propertyTypes: ["3bhk"], location: "bopal" } },
    { name: "girls satellite", globalQuery: "girls satellite", sidebarState: { propertyTypes: ["girlspg"], location: "satellite" } }
  ];

  for (const t of testCases) {
    console.log(`\nTesting: ${t.name}`);
    
    // Global Search Bar
    const globalFilters = normalizeQuery(t.globalQuery);
    const searchMatches = filterPosts(posts, globalFilters);
    
    // Sidebar Filters
    const sidebarMatches = filterPosts(posts, t.sidebarState);
    
    console.log(`Search Count: ${searchMatches.length}`);
    console.log(`Sidebar Count: ${sidebarMatches.length}`);
    
    if (searchMatches.length !== sidebarMatches.length) {
      console.log(`❌ Mismatch detected!`);
      console.log('Search Filters:', globalFilters);
      console.log('Sidebar Filters:', t.sidebarState);
    } else {
      let isIdentical = true;
      for (let i = 0; i < searchMatches.length; i++) {
        if (searchMatches[i].id !== sidebarMatches[i].id) {
          isIdentical = false;
        }
      }
      if (isIdentical) {
        console.log(`✔ Counts match!`);
        console.log(`✔ Post IDs are identical`);
        console.log(`✔ Result order is identical`);
      } else {
        console.log(`❌ Mismatch in order or IDs!`);
      }
    }
  }
}
runTests();
