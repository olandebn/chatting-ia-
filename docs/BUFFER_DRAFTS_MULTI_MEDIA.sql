-- RelaisIA: retain the ordered media selection of each draft.
-- Additive: existing single-photo drafts keep media_ids NULL until edited or duplicated.
-- Does not alter existing jobs, permissions, or Instagram/Meta credentials.
ALTER TABLE public.social_posts
  ADD COLUMN IF NOT EXISTS media_ids uuid[];
COMMENT ON COLUMN public.social_posts.media_ids IS
  'Ordered media IDs of this draft; the first must equal media_id. NULL means legacy single image.';
