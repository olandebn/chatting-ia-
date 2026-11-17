-- Synced from the deployed project (applied 2026-11-17).
alter table public.social_media add column if not exists sha256 text;
alter table public.social_media add constraint social_media_sha256_format check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$');
create unique index if not exists social_media_hash_unique_active on public.social_media(creator_id,sha256) where sha256 is not null and state in ('uploading','ready');
