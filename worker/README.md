# Facebook Scraper API

Cloudflare Worker for serving Facebook scraper data from Supabase.

## Setup

1. Install dependencies:
   ```sh
   npm install
   ```

2. Set up environment variables locally:
   Create a `.dev.vars` file in the root with:
   ```
   SUPABASE_URL=your_supabase_url
   SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
   ```

3. Run locally:
   ```sh
   npm run dev
   ```

4. Deploy:
   ```sh
   npm run deploy
   ```
   *Make sure to add the secrets to Cloudflare before deploying:*
   ```sh
   npx wrangler secret put SUPABASE_URL
   npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
   ```
