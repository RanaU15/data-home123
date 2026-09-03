import PocketBase from 'pocketbase';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60',
      ...corsHeaders,
    },
  });
}

function errorResponse(message, status = 500) {
  return jsonResponse({ success: false, message }, status);
}

// In-memory state variables
let isScraperRunning = false;
let lastScheduledRun = null;
let lastSuccessfulRun = null;
let lastError = null;
const workerStartTime = Date.now();

// Structured logger
function log(level, message, data = {}) {
  console.log(JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...data }));
}

async function triggerScraper(env) {
  const endpoint = env.SCRAPER_ENDPOINT || '';
  const token = env.SCRAPER_SECRET_TOKEN || '';
  
  if (!endpoint) throw new Error("SCRAPER_ENDPOINT not configured");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(`${endpoint}/trigger-scrape`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Scraper-Token': token
      },
      body: JSON.stringify({
        triggered_by: "cloudflare-cron",
        triggered_at: new Date().toISOString()
      }),
      signal: controller.signal
    });
    
    if (!res.ok) {
      if (res.status === 409) {
         throw new Error("Scraper is already running (409 Conflict)");
      }
      throw new Error(`Scraper trigger failed with status ${res.status}`);
    }
    
    return await res.json().catch(() => ({}));
  } finally {
    clearTimeout(timeout);
  }
}

async function withRetry(fn, maxAttempts = 3, baseDelayMs = 2000) {
  let attempt = 1;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (err.message.includes("409")) throw err; // Don't retry if already running
      if (attempt >= maxAttempts) {
        throw err;
      }
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      log("warn", "Trigger attempt failed, retrying", { attempt, delay, error: err.message });
      await new Promise(r => setTimeout(r, delay));
      attempt++;
    }
  }
}

async function runScheduledScrape(env) {
  if (isScraperRunning) {
    log("warn", "Cron trigger skipped: Scraper is already running");
    return { skipped: true };
  }

  isScraperRunning = true;
  lastScheduledRun = new Date().toISOString();
  const startTime = Date.now();

  try {
    const res = await withRetry(() => triggerScraper(env), 3, 2000);
    lastSuccessfulRun = new Date().toISOString();
    lastError = null;
    log("info", "Scrape triggered successfully", { durationMs: Date.now() - startTime, response: res });
    return { success: true };
  } catch (err) {
    lastError = { message: err.message, at: new Date().toISOString() };
    log("error", "Failed to trigger scrape", { error: err.message, durationMs: Date.now() - startTime });
    return { success: false, error: err.message };
  } finally {
    isScraperRunning = false;
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== 'GET' && request.method !== 'POST') {
      return errorResponse('Method Not Allowed', 405);
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Validate Env variables
    if (!env.POCKETBASE_URL) {
      return errorResponse('Server Configuration Error: Missing POCKETBASE_URL', 500);
    }

    const pb = new PocketBase(env.POCKETBASE_URL);
    pb.autoCancellation(false);
    // Optional admin auth if needed
    if (env.PB_ADMIN_EMAIL && env.PB_ADMIN_PASSWORD) {
        try {
            await pb.admins.authWithPassword(env.PB_ADMIN_EMAIL, env.PB_ADMIN_PASSWORD);
        } catch(e) {
            console.error("PocketBase Admin Auth failed", e);
        }
    }

    try {
      if (path === '/health') {
        if (request.method !== 'GET') return errorResponse('Method Not Allowed', 405);
        return jsonResponse({
          status: 'ok',
          workerVersion: env.WORKER_VERSION || '1.0.0',
          uptime: Math.floor((Date.now() - workerStartTime) / 1000) + 's',
          scheduler: {
            currentlyRunning: isScraperRunning,
            lastScheduledRun: lastScheduledRun,
            lastSuccessfulRun: lastSuccessfulRun,
            lastError: lastError,
            cronSchedule: "*/30 * * * * (every 30 min UTC)"
          },
          timestamp: new Date().toISOString()
        });
      }

      if (path === '/trigger') {
        if (request.method !== 'POST') return errorResponse('Method Not Allowed', 405);
        ctx.waitUntil(runScheduledScrape(env));
        return jsonResponse({
          message: "Scrape triggered manually",
          triggeredAt: new Date().toISOString(),
          note: "Check /health for status"
        }, 202);
      }

      if (path === '/posts') {
        const page = parseInt(url.searchParams.get('page') || '1');
        const limit = parseInt(url.searchParams.get('limit') || '20');
        const group = url.searchParams.get('group');
        const sort = url.searchParams.get('sort') === 'asc' ? '+scraped_at' : '-scraped_at';

        const postType = url.searchParams.get('post_type');
        const hasVideo = url.searchParams.get('has_video');
        const author = url.searchParams.get('author');
        const dateRangeStart = url.searchParams.get('date_start');
        const dateRangeEnd = url.searchParams.get('date_end');

        let filterParts = [];
        if (group) filterParts.push(`group_name="${group.replace(/"/g, '\\"')}"`);
        if (postType) filterParts.push(`post_type="${postType.replace(/"/g, '\\"')}"`);
        if (hasVideo === 'true') filterParts.push(`has_video=true`);
        if (hasVideo === 'false') filterParts.push(`has_video=false`);
        if (author) filterParts.push(`author~"${author.replace(/"/g, '\\"')}"`);
        if (dateRangeStart) filterParts.push(`scraped_at>="${dateRangeStart}"`);
        if (dateRangeEnd) filterParts.push(`scraped_at<="${dateRangeEnd}"`);

        const filterStr = filterParts.join(" && ");

        const data = await pb.collection('posts').getList(page, limit, {
            filter: filterStr,
            sort: sort
        });

        return jsonResponse({
          success: true,
          data: data.items,
          meta: {
            total: data.totalItems,
            page,
            limit,
            totalPages: data.totalPages
          }
        });
      }

      if (path.startsWith('/post/')) {
        const id = path.split('/post/')[1];
        if (!id) return errorResponse('Missing post ID', 400);

        try {
            const data = await pb.collection('posts').getOne(id);
            return jsonResponse({
              success: true,
              data
            });
        } catch (error) {
            return errorResponse('Post not found', 404);
        }
      }

      if (path === '/search') {
        const q = url.searchParams.get('q');
        const page = parseInt(url.searchParams.get('page') || '1');
        const limit = parseInt(url.searchParams.get('limit') || '20');

        if (!q) {
          return errorResponse('Missing search query parameter "q"', 400);
        }

        const queryStr = q.trim().replace(/"/g, '\\"');
        
        const data = await pb.collection('posts').getList(page, limit, {
            filter: `body~"${queryStr}"`,
            sort: '-scraped_at'
        });

        return jsonResponse({
          success: true,
          data: data.items,
          meta: {
            total: data.totalItems,
            page,
            limit,
            totalPages: data.totalPages
          }
        });
      }

      if (path === '/groups') {
        const data = await pb.collection('posts').getFullList({
            fields: 'group_name'
        });

        // Extract unique groups
        const uniqueGroups = [...new Set(data.map(item => item.group_name).filter(Boolean))];

        return jsonResponse({
          success: true,
          data: uniqueGroups
        });
      }

      if (path === '/stats') {
        const todayStr = new Date(new Date().setHours(0, 0, 0, 0)).toISOString().split('T')[0] + " 00:00:00.000Z";
        
        const [postsRes, todayRes, groupsRes, latestRes] = await Promise.all([
          pb.collection('posts').getList(1, 1),
          pb.collection('posts').getList(1, 1, { filter: `scraped_at>="${todayStr}"` }),
          pb.collection('posts').getFullList({ fields: 'group_name' }),
          pb.collection('posts').getList(1, 1, { sort: '-scraped_at', fields: 'scraped_at' })
        ]);

        const total_posts = postsRes.totalItems || 0;
        const today_posts = todayRes.totalItems || 0;

        let uniqueGroups = [];
        if (groupsRes) {
          uniqueGroups = [...new Set(groupsRes.map(item => item.group_name).filter(Boolean))];
        }
        const total_groups = uniqueGroups.length;

        const latest_scrape = latestRes.items.length > 0 ? latestRes.items[0].scraped_at : null;

        return jsonResponse({
          success: true,
          data: {
            total_posts,
            total_groups,
            today_posts,
            latest_scrape
          }
        });
      }

      return errorResponse('Not Found', 404);

    } catch (err) {
      console.error(err);
      return errorResponse('Internal Server Error', 500);
    }
  },

  async scheduled(event, env, ctx) {
    log("info", "Cron trigger received", {
      cron: event.cron,
      scheduledTime: new Date(event.scheduledTime).toISOString(),
    });
    ctx.waitUntil(runScheduledScrape(env));
  }
};
