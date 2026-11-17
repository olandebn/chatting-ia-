-- Synced from the deployed project (applied 2026-11-17).
alter table public.social_posts add column if not exists approved_at timestamptz;
