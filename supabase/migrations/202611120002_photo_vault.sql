-- Relais IA : coffre-fort photos par utilisateur. Ne pas partager les photos avec les clients.
CREATE TABLE IF NOT EXISTS public.photo_vault_security (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  pin_digest text NOT NULL,
  failed_attempts int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.photo_vault_security ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.photo_vault_security FROM anon, authenticated;
-- Aucun accès direct au code, même haché, par les clients web.

CREATE TABLE IF NOT EXISTS public.photo_vault_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  storage_path text NOT NULL UNIQUE,
  display_name text NOT NULL,
  mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','image/webp')),
  bytes bigint NOT NULL CHECK (bytes > 0 AND bytes <= 5242880),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS photo_vault_items_user_created_idx
  ON public.photo_vault_items(user_id, created_at DESC);
ALTER TABLE public.photo_vault_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.photo_vault_items FROM anon, authenticated;
-- Le service role, appelé uniquement depuis la nouvelle fonction Edge, gère ces tables.

INSERT INTO storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
VALUES ('relais-private-photos', 'relais-private-photos', false, 5242880,
        ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO UPDATE SET public = false,
   file_size_limit = EXCLUDED.file_size_limit,
   allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Empêche même une politique générale permissive existante d'ouvrir ce bucket
-- aux utilisateurs web. Le service role utilisé côté Edge contourne la RLS.
DROP POLICY IF EXISTS relais_photos_deny_direct ON storage.objects;
CREATE POLICY relais_photos_deny_direct ON storage.objects
  AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (bucket_id <> 'relais-private-photos')
  WITH CHECK (bucket_id <> 'relais-private-photos');

-- Contrôle atomique du PIN avec verrouillage après cinq erreurs consécutives.
-- Le digest HMAC est calculé côté Edge avec un secret serveur PHOTO_VAULT_PEPPER.
CREATE OR REPLACE FUNCTION public.photo_vault_check(
  p_user uuid, p_digest text, p_action text DEFAULT 'unlock'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
 v public.photo_vault_security%ROWTYPE;
 n integer;
 remain integer;
BEGIN
 IF p_user IS NULL OR p_digest IS NULL OR length(p_digest) <> 64 THEN
  RETURN jsonb_build_object('ok', false, 'error', 'invalid_request');
 END IF;
 SELECT * INTO v FROM public.photo_vault_security WHERE user_id=p_user FOR UPDATE;
 IF p_action='setup' THEN
  IF FOUND THEN RETURN jsonb_build_object('ok',false,'error','already_setup'); END IF;
  INSERT INTO public.photo_vault_security(user_id,pin_digest) VALUES(p_user,p_digest);
  RETURN jsonb_build_object('ok',true);
 END IF;
 IF p_action <> 'unlock' THEN RETURN jsonb_build_object('ok',false,'error','invalid_action'); END IF;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','not_configured'); END IF;
 IF v.locked_until IS NOT NULL AND v.locked_until > now() THEN
  remain := CEIL(EXTRACT(EPOCH FROM (v.locked_until-now())))::integer;
  RETURN jsonb_build_object('ok',false,'error','locked','retry_after_seconds',remain);
 END IF;
 IF v.pin_digest <> p_digest THEN
  n := CASE WHEN v.locked_until IS NOT NULL THEN 1 ELSE v.failed_attempts+1 END;
  UPDATE public.photo_vault_security
   SET failed_attempts=CASE WHEN n>=5 THEN 0 ELSE n END,
       locked_until=CASE WHEN n>=5 THEN now()+interval '15 minutes' ELSE NULL END,
       updated_at=now()
   WHERE user_id=p_user;
  RETURN jsonb_build_object('ok',false,'error',CASE WHEN n>=5 THEN 'locked' ELSE 'wrong_pin' END);
 END IF;
 UPDATE public.photo_vault_security
  SET failed_attempts=0,locked_until=NULL,updated_at=now()
  WHERE user_id=p_user;
 RETURN jsonb_build_object('ok',true);
END;
$$;
REVOKE ALL ON FUNCTION public.photo_vault_check(uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.photo_vault_check(uuid,text,text) TO service_role;
