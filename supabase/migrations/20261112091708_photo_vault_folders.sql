-- Relais IA Photos privees V2 : dossiers hierarchiques, renommage, classement.
-- Migration additive : les photos existantes restent dans la racine (folder_id NULL).
CREATE TABLE IF NOT EXISTS public.photo_vault_folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  parent_id uuid,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT photo_vault_folder_id_user_unique UNIQUE (id, user_id),
  CONSTRAINT photo_vault_folder_parent_owner_fk FOREIGN KEY (parent_id, user_id)
    REFERENCES public.photo_vault_folders(id,user_id) ON DELETE RESTRICT,
  CONSTRAINT photo_vault_folder_no_self_parent CHECK (id <> parent_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS photo_vault_folder_root_name_unique
  ON public.photo_vault_folders(user_id,lower(name)) WHERE parent_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS photo_vault_folder_child_name_unique
  ON public.photo_vault_folders(user_id,parent_id,lower(name)) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS photo_vault_folder_parent_idx
  ON public.photo_vault_folders(user_id,parent_id,name);
ALTER TABLE public.photo_vault_folders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.photo_vault_folders FROM anon, authenticated;

ALTER TABLE public.photo_vault_items ADD COLUMN IF NOT EXISTS folder_id uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='photo_vault_item_folder_owner_fk') THEN
    ALTER TABLE public.photo_vault_items
      ADD CONSTRAINT photo_vault_item_folder_owner_fk
      FOREIGN KEY (folder_id,user_id)
      REFERENCES public.photo_vault_folders(id,user_id) ON DELETE RESTRICT;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS photo_vault_item_folder_idx
  ON public.photo_vault_items(user_id,folder_id,created_at DESC);
