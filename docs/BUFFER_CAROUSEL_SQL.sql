-- RelaisIA Buffer carousel support. Additive only; existing jobs retain the original cover photo.
ALTER TABLE public.social_buffer_jobs
ADD COLUMN IF NOT EXISTS media_ids uuid[];
COMMENT ON COLUMN public.social_buffer_jobs.media_ids IS 'Ordered image IDs belonging to the Buffer post; null on legacy single-image jobs.';
