import { pb } from './pocketbase';

export type PostFeed = 'all' | 'facebook' | 'requirements' | 'your';

export interface PostPage<T = any> {
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
  items: T[];
  error?: unknown;
}

function escapeFilterValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function getFeedFilter(feed: PostFeed, profileId?: string): string {
  if (feed === 'requirements') return 'post_type="requirement"';
  if (feed === 'your') {
    if (!profileId) return 'post_type="requirement" && id="__no_authenticated_user__"';
    return `post_type="requirement" && created_by="${escapeFilterValue(profileId)}"`;
  }
  if (feed === 'facebook') {
    return '(post_type="facebook" || (source="facebook" && post_type!="requirement") || (source="" && post_type!="requirement"))';
  }
  return '';
}

function addSearchFilter(filter: string, query?: string): string {
  const value = query?.trim();
  if (!value) return filter;

  const escaped = escapeFilterValue(value);
  const search = [
    `body~"${escaped}"`,
    `author~"${escaped}"`,
    `group_name~"${escaped}"`,
    `location~"${escaped}"`,
    `property_type~"${escaped}"`,
    `preferred_tenant~"${escaped}"`,
    `requirement~"${escaped}"`
  ].join(' || ');

  return filter ? `${filter} && (${search})` : `(${search})`;
}

export async function getPostsPage({
  feed = 'all',
  page = 1,
  perPage = 20,
  profileId,
  query
}: {
  feed?: PostFeed;
  page?: number;
  perPage?: number;
  profileId?: string;
  query?: string;
} = {}): Promise<PostPage> {
  const safePage = Math.max(1, page);
  const filter = addSearchFilter(getFeedFilter(feed, profileId), query);

  try {
    const data = await pb.collection('posts').getList(safePage, perPage, {
      sort: '-scraped_at',
      ...(filter ? { filter } : {})
    });

    return {
      page: data.page,
      perPage: data.perPage,
      totalItems: data.totalItems,
      totalPages: data.totalPages,
      items: data.items
    };
  } catch (error) {
    console.error("Error fetching posts:", error);
    return {
      page: safePage,
      perPage,
      totalItems: 0,
      totalPages: 1,
      items: [],
      error
    };
  }
}

// Kept for the dedicated search page until its filter UI is moved to server queries.
export async function getAllPosts(): Promise<any[]> {
  try {
    return await pb.collection('posts').getFullList({ sort: '-scraped_at' });
  } catch (error) {
    console.error("Error fetching posts:", error);
    return [];
  }
}
