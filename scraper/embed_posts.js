const path = require("path");
require("dotenv").config({ path: path.join(__dirname, '../.env') });
const { createClient } = require("@supabase/supabase-js");
const { pipeline, env } = require("@xenova/transformers");

env.allowLocalModels = true;
env.useBrowserCache = false;

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function run() {
    console.log("Loading embedding model...");
    const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');

    console.log("Fetching posts without embeddings...");
    let hasMore = true;
    let from = 0;
    let totalUpdated = 0;

    while (hasMore) {
        const { data: posts, error } = await supabase
            .from("posts")
            .select("id, body, author, group_name, location, post_type")
            .is("embedding", null)
            .range(from, from + 999);

        if (error) {
            console.error("Error fetching posts:", error);
            break;
        }

        if (!posts || posts.length === 0) {
            hasMore = false;
            break;
        }

        for (const post of posts) {
            const textToEmbed = [post.body, post.author, post.group_name, post.location, post.post_type].filter(Boolean).join(" ");
            if (!textToEmbed) continue;
            
            try {
                const output = await extractor(textToEmbed, { pooling: 'mean', normalize: true });
                const embedding = Array.from(output.data);
                
                await supabase.from("posts").update({ embedding }).eq("id", post.id);
                totalUpdated++;
                if (totalUpdated % 10 === 0) console.log(`Updated ${totalUpdated} posts...`);
            } catch (err) {
                console.error("Failed to embed post", post.id, err);
            }
        }
        
        // We stay at range 0-999 because we are updating them and they will no longer match .is("embedding", null)
    }

    console.log(`Done! Embedded ${totalUpdated} posts.`);
}

run();
