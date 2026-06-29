const { supabase } = require("./supabase");

async function viewDatabase() {
    console.log(`\n--- Reading data from Supabase 'posts' table ---\n`);

    if (!supabase) {
        console.error("❌ Supabase client not configured.");
        process.exit(1);
    }

    const { data: rows, error } = await supabase.from("posts").select("*");

    if (error) {
        console.error("Error querying database:", error.message);
        return;
    }

    if (!rows || rows.length === 0) {
        console.log("No posts found in the database (table is empty).");
    } else {
        console.log(`Found ${rows.length} posts in the database:\n`);
        
        // Print a clean summary table of key fields
        const summary = rows.map(row => ({
            ID: row.id,
            Author: row.author,
            Date: row.post_date || row.date,
            Likes: row.likes,
            Comments: row.comments,
            Shares: row.shares,
            Permalink: row.permalink
        }));
        console.table(summary);

        console.log("\n--- Detailed View of First Post ---");
        console.log(JSON.stringify(rows[0], null, 2));
    }
}

viewDatabase();
