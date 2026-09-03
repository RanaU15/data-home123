require('dotenv').config();
const { Pool } = require('pg');

(async () => {
    const pool = new Pool({
        connectionString: process.env.SUPABASE_DB_URL,
        ssl: { rejectUnauthorized: false }
    });

    try {
        const client = await pool.connect();

        const columns = await client.query(`
      SELECT
        column_name,
        data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'posts'
      ORDER BY ordinal_position
    `);

        console.log('\n========== POST COLUMNS ==========\n');
        console.table(columns.rows);

        const posts = await client.query(`
      SELECT *
      FROM public.posts
      LIMIT 5
    `);

        console.log('\n========== SAMPLE POSTS ==========\n');
        console.log(JSON.stringify(posts.rows, null, 2));

        client.release();
    } finally {
        await pool.end();
    }
})().catch(error => {
    console.error(error);
    process.exit(1);
});