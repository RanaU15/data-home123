create table if not exists group_sync (
group_id text,
month text,
completed boolean default false,
posts_processed integer default 0,
posts_inserted integer default 0,
duplicates_skipped integer default 0,
last_backfill_date timestamptz,
updated_at timestamptz default now(),
primary key(group_id,month)
);
