-- Relais IA V2.1 : MIGRATION ADDITIVE / Ne pas exécuter deux fois des migrations à la main.
-- À appliquer via supabase db push APRÈS sauvegarde de production.
ALTER TABLE public.bot_settings
  ADD COLUMN IF NOT EXISTS reply_length text NOT NULL DEFAULT 'medium',
  ADD COLUMN IF NOT EXISTS emoji_level text NOT NULL DEFAULT 'rare',
  ADD COLUMN IF NOT EXISTS reply_tone text NOT NULL DEFAULT 'warm',
  ADD COLUMN IF NOT EXISTS pronouns text NOT NULL DEFAULT 'tu',
  ADD COLUMN IF NOT EXISTS ai_paused_reason text,
  ADD COLUMN IF NOT EXISTS ai_paused_at timestamptz;
-- CHECKs idempotents
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'relais_reply_length_check') THEN
  ALTER TABLE public.bot_settings ADD CONSTRAINT relais_reply_length_check CHECK (reply_length IN ('short','medium','long'));
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'relais_emoji_level_check') THEN
  ALTER TABLE public.bot_settings ADD CONSTRAINT relais_emoji_level_check CHECK (emoji_level IN ('none','rare','frequent'));
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'relais_reply_tone_check') THEN
  ALTER TABLE public.bot_settings ADD CONSTRAINT relais_reply_tone_check CHECK (reply_tone IN ('warm','neutral','professional'));
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'relais_pronouns_check') THEN
  ALTER TABLE public.bot_settings ADD CONSTRAINT relais_pronouns_check CHECK (pronouns IN ('tu','vous'));
 END IF;
END $$;
GRANT UPDATE (reply_length, emoji_level, reply_tone, pronouns) ON public.bot_settings TO authenticated;
-- ai_paused_reason et ai_paused_at : service role seulement

CREATE TABLE IF NOT EXISTS public.contact_memory (
  chat_id bigint PRIMARY KEY REFERENCES public.chats(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  summary text NOT NULL DEFAULT '',
  facts jsonb NOT NULL DEFAULT '{}'::jsonb,
  topics text[] NOT NULL DEFAULT '{}'::text[],
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contact_memory_user_id_idx ON public.contact_memory(user_id);
ALTER TABLE public.contact_memory ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.contact_memory FROM anon, authenticated;
GRANT SELECT, DELETE ON public.contact_memory TO authenticated;
DROP POLICY IF EXISTS contact_memory_owner_read ON public.contact_memory;
CREATE POLICY contact_memory_owner_read ON public.contact_memory FOR SELECT TO authenticated USING (user_id=auth.uid());
DROP POLICY IF EXISTS contact_memory_owner_delete ON public.contact_memory;
CREATE POLICY contact_memory_owner_delete ON public.contact_memory FOR DELETE TO authenticated USING (user_id=auth.uid());
-- Le service role seul crée/modifie les mémoires. Contrôle de l'appartenance du chat, même en cas de bug serveur.
CREATE OR REPLACE FUNCTION public.relais_check_memory_owner() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.chats WHERE id=NEW.chat_id AND user_id=NEW.user_id) THEN
  RAISE EXCEPTION 'contact_memory: user_id/chat_id mismatch';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS relais_memory_owner_trigger ON public.contact_memory;
CREATE TRIGGER relais_memory_owner_trigger BEFORE INSERT OR UPDATE ON public.contact_memory
 FOR EACH ROW EXECUTE FUNCTION public.relais_check_memory_owner();
REVOKE EXECUTE ON FUNCTION public.relais_check_memory_owner() FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.processed_updates (
  update_id bigint PRIMARY KEY,
  processed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.processed_updates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.processed_updates FROM anon, authenticated;

ALTER TABLE public.links ADD COLUMN IF NOT EXISTS adult_only boolean NOT NULL DEFAULT false;
GRANT UPDATE (adult_only) ON public.links TO authenticated;

CREATE TABLE IF NOT EXISTS public.payments (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 chat_id bigint REFERENCES public.chats(id) ON DELETE SET NULL,
 link_id bigint REFERENCES public.links(id) ON DELETE SET NULL,
 provider text NOT NULL,
 provider_ref text NOT NULL,
 amount numeric(12,2) NOT NULL CHECK (amount >= 0),
 currency text NOT NULL DEFAULT 'EUR',
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','failed','refunded')),
 confirmed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(provider, provider_ref)
);
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payments FROM anon, authenticated;
GRANT SELECT ON public.payments TO authenticated;
DROP POLICY IF EXISTS payments_read_owner ON public.payments;
CREATE POLICY payments_read_owner ON public.payments FOR SELECT TO authenticated USING (user_id=auth.uid());
-- IMPORTANT : aucun INSERT/UPDATE client. Un vrai prestataire de paiement devra avoir son webhook signé.

CREATE TABLE IF NOT EXISTS public.ai_usage (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 chat_id bigint REFERENCES public.chats(id) ON DELETE SET NULL,
 provider text NOT NULL,
 model text NOT NULL,
 tokens_in integer NOT NULL DEFAULT 0 CHECK (tokens_in>=0),
 tokens_out integer NOT NULL DEFAULT 0 CHECK (tokens_out>=0),
 estimated_usd numeric(12,8) NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_usage_user_created_idx ON public.ai_usage(user_id, created_at DESC);
ALTER TABLE public.ai_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_usage FROM anon, authenticated;
GRANT SELECT ON public.ai_usage TO authenticated;
DROP POLICY IF EXISTS ai_usage_read_owner ON public.ai_usage;
CREATE POLICY ai_usage_read_owner ON public.ai_usage FOR SELECT TO authenticated USING (user_id=auth.uid());

-- Purge sans lire les contenus. Nécessite pg_cron déjà présent dans Relais IA.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'relais-processed-updates-cleanup') THEN
    PERFORM cron.schedule('relais-processed-updates-cleanup', '21 4 * * *',
      'DELETE FROM public.processed_updates WHERE processed_at < now() - interval ''48 hours'';');
  END IF;
END $$;

-- Statistiques agrégées côté serveur : pas de récupération massive des événements vers le navigateur.
CREATE OR REPLACE FUNCTION public.get_relais_v2_stats(p_from timestamptz, p_to timestamptz)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public AS $$
 SELECT jsonb_build_object(
   'failed_replies', (SELECT count(*) FROM public.replies r WHERE r.user_id=auth.uid() AND r.status='failed' AND r.created_at BETWEEN p_from AND p_to),
   'confirmed_payments', (SELECT count(*) FROM public.payments p WHERE p.user_id=auth.uid() AND p.status='confirmed' AND p.confirmed_at BETWEEN p_from AND p_to),
   'confirmed_revenue_eur', (SELECT COALESCE(sum(p.amount),0) FROM public.payments p WHERE p.user_id=auth.uid() AND p.status='confirmed' AND p.currency='EUR' AND p.confirmed_at BETWEEN p_from AND p_to),
   'estimated_ai_cost_usd', (SELECT COALESCE(sum(u.estimated_usd),0) FROM public.ai_usage u WHERE u.user_id=auth.uid() AND u.created_at BETWEEN p_from AND p_to),
   'tokens_in', (SELECT COALESCE(sum(u.tokens_in),0) FROM public.ai_usage u WHERE u.user_id=auth.uid() AND u.created_at BETWEEN p_from AND p_to),
   'tokens_out', (SELECT COALESCE(sum(u.tokens_out),0) FROM public.ai_usage u WHERE u.user_id=auth.uid() AND u.created_at BETWEEN p_from AND p_to)
 )
$$;
REVOKE EXECUTE ON FUNCTION public.get_relais_v2_stats(timestamptz,timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_relais_v2_stats(timestamptz,timestamptz) TO authenticated;
