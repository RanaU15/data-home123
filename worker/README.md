# Facebook Scraper API

Cloudflare Worker for serving Facebook scraper data from PocketBase.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Configure environment variables in `.dev.vars` for local development:
   ```bash
   POCKETBASE_URL=your_pocketbase_url
   PB_ADMIN_EMAIL=your_admin_email
   PB_ADMIN_PASSWORD=your_admin_password
   ```

3. Run locally:
   ```bash
   npm run dev
   ```

## Deployment

1. Login to Cloudflare:
   ```bash
   npx wrangler login
   ```

2. Set production secrets:
   ```bash
   npx wrangler secret put POCKETBASE_URL
   npx wrangler secret put PB_ADMIN_EMAIL
   npx wrangler secret put PB_ADMIN_PASSWORD
   ```
