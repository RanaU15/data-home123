import { createClient } from '@supabase/supabase-js';

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
      ...corsHeaders,
    },
  });
}

function errorResponse(message, status = 500) {
  return jsonResponse({ success: false, message }, status);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== 'GET') {
      return errorResponse('Method Not Allowed', 405);
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Validate Env variables
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      return errorResponse('Server Configuration Error', 500);
    }

    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

    try {
      if (path === '/health') {
        return jsonResponse({
          success: true,
          status: 'OK',
          version: '1.0.0',
          timestamp: new Date().toISOString()
        });
      }

      if (path === '/posts') {
        const page = parseInt(url.searchParams.get('page') || '1');
        const limit = parseInt(url.searchParams.get('limit') || '20');
        const group = url.searchParams.get('group');
        const sort = url.searchParams.get('sort') === 'asc' ? 'asc' : 'desc';

        const offset = (page - 1) * limit;

        let query = supabase
          .from('posts')
          .select('*', { count: 'exact' });

        if (group) {
          query = query.eq('group_name', group);
        }

        query = query
          .order('scraped_at', { ascending: sort === 'asc' })
          .range(offset, offset + limit - 1);

        const { data, count, error } = await query;

        if (error) throw error;

        return jsonResponse({
          success: true,
          data,
          meta: {
            total: count,
            page,
            limit,
            totalPages: Math.ceil(count / limit)
          }
        });
      }

      if (path.startsWith('/post/')) {
        const id = path.split('/post/')[1];
        if (!id) return errorResponse('Missing post ID', 400);

        const { data, error } = await supabase
          .from('posts')
          .select('*')
          .eq('id', id)
          .single();

        if (error || !data) {
          return errorResponse('Post not found', 404);
        }

        return jsonResponse({
          success: true,
          data
        });
      }

      if (path === '/search') {
        const q = url.searchParams.get('q');
        const page = parseInt(url.searchParams.get('page') || '1');
        const limit = parseInt(url.searchParams.get('limit') || '20');

        if (!q) {
          return errorResponse('Missing search query parameter "q"', 400);
        }

        const offset = (page - 1) * limit;

        const { data, count, error } = await supabase
          .from('posts')
          .select('*', { count: 'exact' })
          .or(`body.ilike.%${q}%,author.ilike.%${q}%,group_name.ilike.%${q}%`)
          .order('scraped_at', { ascending: false })
          .range(offset, offset + limit - 1);

        if (error) throw error;

        return jsonResponse({
          success: true,
          data,
          meta: {
            total: count,
            page,
            limit,
            totalPages: Math.ceil(count / limit)
          }
        });
      }

      if (path === '/groups') {
        const { data, error } = await supabase
          .from('posts')
          .select('group_name')
          .limit(5000);

        if (error) throw error;

        // Extract unique groups
        const uniqueGroups = [...new Set(data.map(item => item.group_name).filter(Boolean))];

        return jsonResponse({
          success: true,
          data: uniqueGroups
        });
      }

      if (path === '/stats') {
        // Run aggregations in parallel
        const [postsRes, todayRes, groupsRes, latestRes] = await Promise.all([
          supabase.from('posts').select('*', { count: 'exact', head: true }),

          supabase.from('posts')
            .select('*', { count: 'exact', head: true })
            .gte('scraped_at', new Date(new Date().setHours(0, 0, 0, 0)).toISOString()),

          supabase.from('posts').select('group_name').limit(5000),

          supabase.from('posts')
            .select('scraped_at')
            .order('scraped_at', { ascending: false })
            .limit(1)
            .single()
        ]);

        const total_posts = postsRes.count || 0;
        const today_posts = todayRes.count || 0;

        let uniqueGroups = [];
        if (groupsRes.data) {
          uniqueGroups = [...new Set(groupsRes.data.map(item => item.group_name).filter(Boolean))];
        }
        const total_groups = uniqueGroups.length;

        const latest_scrape = latestRes.data ? latestRes.data.scraped_at : null;

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
};
