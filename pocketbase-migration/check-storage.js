require('dotenv').config();
const { Pool } = require('pg');

(async () => {
    const pool = new Pool({
        connectionString: process.env.SUPABASE_DB_URL,
        ssl: { rejectUnauthorized: false }
    });

    try {
        const client = await pool.connect();

        const result = await client.query(`
      SELECT
        bucket_id,
        COUNT(*) AS files,
        COALESCE(
          SUM((metadata->>'size')::bigint),
          0
        ) AS bytes
      FROM storage.objects
      WHERE archived_at IS NULL
        AND is_delete_marker = false
      GROUP BY bucket_id
      ORDER BY bucket_id
    `);

        console.table(
            result.rows.map(row => ({
                bucket: row.bucket_id,
                files: Number(row.files),
                sizeMB: (Number(row.bytes) / 1024 / 1024).toFixed(2)
            }))
        );

        client.release();
    } finally {
        await pool.end();
    }
})().catch(error => {
    console.error(error);
    process.exit(1);
});