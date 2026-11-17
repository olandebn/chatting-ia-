-- Synced from the deployed project (applied 2026-11-17). Social Automation V1 foundation.
create table if not exists public.social_creators (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 100),
  timezone text not null default 'Europe/Paris',
  description text not null default '',
  created_at timestamptz not null default now(),
  unique(id,user_id)
);
create index if not exists social_creators_owner on public.social_creators(user_id);
create table if not exists public.social_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  creator_id uuid not null,
  platform text not null check(platform in ('instagram','threads','tiktok','telegram')),
  platform_user_id text,
  username text,
  state text not null default 'disconnected' check(state in ('disconnected','connected','expired','error')),
  encrypted_token text,
  token_expires_at timestamptz,
  permissions text[] not null default '{}',
  updated_at timestamptz not null default now(),
  foreign key (creator_id,user_id) references public.social_creators(id,user_id) on delete cascade,
  unique(id,user_id,creator_id)
);
create unique index if not exists social_accounts_unique_platform_account on public.social_accounts(user_id,platform,platform_user_id) where platform_user_id is not null;
create index if not exists social_accounts_creator on public.social_accounts(user_id,creator_id);
create table if not exists public.social_oauth_states (
  state uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  creator_id uuid not null,
  expires_at timestamptz not null default now()+interval '10 minutes',
  used_at timestamptz,
  foreign key (creator_id,user_id) references public.social_creators(id,user_id) on delete cascade
);
create index if not exists social_oauth_expiration on public.social_oauth_states(expires_at);
create table if not exists public.social_media (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  creator_id uuid not null,
  filename text not null,
  storage_path text not null unique,
  mime_type text not null check(mime_type in ('image/jpeg','image/png','image/webp')),
  bytes bigint not null check(bytes between 1 and 15728640),
  state text not null default 'uploading' check(state in ('uploading','ready','archived')),
  caption_notes text not null default '',
  is_synthetic boolean not null default false,
  created_at timestamptz not null default now(),
  foreign key (creator_id,user_id) references public.social_creators(id,user_id) on delete cascade,
  unique(id,user_id,creator_id)
);
create index if not exists social_media_creator on public.social_media(user_id,creator_id,created_at desc);
create table if not exists public.social_posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  creator_id uuid not null,
  account_id uuid,
  media_id uuid not null,
  caption text not null default '' check(length(caption)<=2200),
  state text not null default 'draft' check(state in ('draft','scheduled','processing','published','failed','unknown','cancelled')),
  scheduled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  published_at timestamptz,
  external_container_id text,
  external_post_id text,
  external_permalink text,
  last_error text,
  attempts integer not null default 0 check(attempts between 0 and 10),
  idempotency_key uuid not null default gen_random_uuid() unique,
  foreign key (creator_id,user_id) references public.social_creators(id,user_id) on delete cascade,
  foreign key (account_id,user_id,creator_id) references public.social_accounts(id,user_id,creator_id),
  foreign key (media_id,user_id,creator_id) references public.social_media(id,user_id,creator_id)
);
create index if not exists social_posts_creator on public.social_posts(user_id,creator_id,created_at desc);
create index if not exists social_posts_due on public.social_posts(scheduled_at) where state='scheduled';
create table if not exists public.social_job_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  post_id uuid not null references public.social_posts(id) on delete cascade,
  event text not null,
  detail text,
  created_at timestamptz not null default now()
);
create index if not exists social_job_events_post on public.social_job_events(post_id,created_at desc);
-- (social_claim_due_post v1 is replaced in 20261117150000_social_autopost_v2.sql)
do $$
declare t text;
begin
  foreach t in array array['social_creators','social_accounts','social_oauth_states','social_media','social_posts','social_job_events'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on table public.%I from anon,authenticated',t);
  end loop;
end $$;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('relais-social-private','relais-social-private',false,15728640,array['image/jpeg','image/png','image/webp'])
on conflict(id) do nothing;
