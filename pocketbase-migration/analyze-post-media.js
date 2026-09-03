require('dotenv').config();
const { Pool } = require('pg');

(async () => {
    const pool = new Pool({
        connectionString: process.env.SUPABASE_DB_URL,
        ssl: { rejectUnauthorized: false }
    });

    try {
        const client = await pool.connect();

        console.log('\n========================================');
        console.log('       POST MEDIA ANALYSIS');
        console.log('========================================\n');

        // --------------------------------------------------
        // 1. Count posts containing media
        // --------------------------------------------------

        const counts = await client.query(`
      SELECT
        COUNT(*) AS total_posts,

        COUNT(*) FILTER (
          WHERE images IS NOT NULL
          AND images <> 'null'::jsonb
          AND images <> '[]'::jsonb
        ) AS posts_with_images,

        COUNT(*) FILTER (
          WHERE video_urls IS NOT NULL
          AND video_urls <> 'null'::jsonb
          AND video_urls <> '[]'::jsonb
        ) AS posts_with_video_urls,

        COUNT(*) FILTER (
          WHERE video_thumbnail IS NOT NULL
          AND video_thumbnail <> ''
        ) AS posts_with_video_thumbnail,

        COUNT(*) FILTER (
          WHERE facebook_video_url IS NOT NULL
          AND facebook_video_url <> ''
        ) AS posts_with_facebook_video,

        COUNT(*) FILTER (
          WHERE image_urls IS NOT NULL
          AND cardinality(image_urls) > 0
        ) AS posts_with_image_urls

      FROM public.posts
    `);

        console.log('========== MEDIA COUNTS ==========\n');
        console.table(counts.rows);


        // --------------------------------------------------
        // 2. Sample image data
        // --------------------------------------------------

        const images = await client.query(`
      SELECT
        id,
        images,
        image_urls
      FROM public.posts
      WHERE
        (
          images IS NOT NULL
          AND images <> 'null'::jsonb
          AND images <> '[]'::jsonb
        )
        OR
        (
          image_urls IS NOT NULL
          AND cardinality(image_urls) > 0
        )
      LIMIT 10
    `);

        console.log('\n========== IMAGE SAMPLES ==========\n');

        images.rows.forEach((row, index) => {
            console.log(`\n--- POST ${index + 1} ---`);
            console.log('ID:', row.id);

            console.log('\nimages:');
            console.log(JSON.stringify(row.images, null, 2));

            console.log('\nimage_urls:');
            console.log(JSON.stringify(row.image_urls, null, 2));
        });


        // --------------------------------------------------
        // 3. Sample video data
        // --------------------------------------------------

        const videos = await client.query(`
      SELECT
        id,
        video_urls,
        video_thumbnail,
        facebook_video_url,
        video_duration,
        video_count,
        has_video,
        attachment_type
      FROM public.posts
      WHERE
        (
          video_urls IS NOT NULL
          AND video_urls <> 'null'::jsonb
          AND video_urls <> '[]'::jsonb
        )
        OR video_thumbnail IS NOT NULL
        OR facebook_video_url IS NOT NULL
        OR has_video = true
      LIMIT 10
    `);

        console.log('\n\n========== VIDEO SAMPLES ==========\n');

        videos.rows.forEach((row, index) => {
            console.log(`\n--- VIDEO POST ${index + 1} ---`);
            console.log('ID:', row.id);

            console.log('\nvideo_urls:');
            console.log(JSON.stringify(row.video_urls, null, 2));

            console.log('\nvideo_thumbnail:');
            console.log(row.video_thumbnail);

            console.log('\nfacebook_video_url:');
            console.log(row.facebook_video_url);

            console.log('\nvideo_duration:');
            console.log(row.video_duration);

            console.log('\nvideo_count:');
            console.log(row.video_count);

            console.log('\nhas_video:');
            console.log(row.has_video);

            console.log('\nattachment_type:');
            console.log(row.attachment_type);
        });


        // --------------------------------------------------
        // 4. Find Supabase Storage URLs inside posts
        // --------------------------------------------------

        const storageUrls = await client.query(`
      SELECT
        id,
        images,
        image_urls,
        video_urls,
        video_thumbnail,
        facebook_video_url
      FROM public.posts
      WHERE
        CAST(images AS text) ILIKE '%supabase%'
        OR CAST(image_urls AS text) ILIKE '%supabase%'
        OR CAST(video_urls AS text) ILIKE '%supabase%'
        OR COALESCE(video_thumbnail, '') ILIKE '%supabase%'
        OR COALESCE(facebook_video_url, '') ILIKE '%supabase%'
      LIMIT 20
    `);

        console.log('\n\n========== SUPABASE URL REFERENCES ==========\n');

        console.log(
            JSON.stringify(storageUrls.rows, null, 2)
        );


        // --------------------------------------------------
        // 5. Finish
        // --------------------------------------------------

        client.release();

        console.log('\n========================================');
        console.log('       MEDIA ANALYSIS COMPLETE');
        console.log('========================================\n');

    } catch (error) {
        console.error('\nERROR:');
        console.error(error);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
})();