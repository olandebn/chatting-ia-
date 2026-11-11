-- Relais IA : schéma principal
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------- Config privée (service role uniquement) ----------
create table public.app_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
alter table public.app_config enable row level security;
revoke all on public.app_config from anon, authenticated;

insert into public.app_config(key, value) values
  ('cron_secret', replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','')),
  ('webhook_secret', replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','')),
  ('admin_setup_code', upper(substr(replace(gen_random_uuid()::text,'-',''),1,10))),
  ('anthropic_model', 'claude-haiku-5-5');

-- ---------- Plans ----------
create table public.plans (
  id text primary key,
  name text not null,
  msg_quota int not null,
  price_label text,
  description text,
  learning boolean not null default false,
  buy boolean not null default false,
  sort int not null default 0
);
insert into public.plans(id,name,msg_quota,price_label,description,learning,buy,sort) values
  ('trial','Essai',50,'Gratuit · 7 jours','Pour tester l''assistant sur quelques discussions.',true,true,0),
  ('starter','Starter',1000,'19 € / mois','Réponses IA, modes et délais, statistiques.',false,false,1),
  ('pro','Pro',5000,'49 € / mois','Tout Starter + apprentissage du style et liens de vente.',true,true,2),
  ('scale','Scale',20000,'99 € / mois','Pour les gros volumes de discussions.',true,true,3);
alter table public.plans enable row level security;

-- ---------- Profils ----------
create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  email text,
  display_name text,
  is_admin boolean not null default false,
  plan_id text not null default 'trial' references public.plans,
  period_start timestamptz not null default now(),
  period_end timestamptz not null default now() + interval '7 days',
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false)
$$;

-- ---------- Réglages du bot ----------
create table public.bot_settings (
  user_id uuid primary key references public.profiles on delete cascade,
  mode text not null default 'observation' check (mode in ('observation','validation','auto')),
  delay_min_s int not null default 60,
  delay_max_s int not null default 300,
  resume_minutes int not null default 30 check (resume_minutes between 0 and 1440),
  buy_enabled boolean not null default false,
  ai_notice_enabled boolean not null default true,
  ai_notice_text text not null default 'Petite info : certaines réponses ici sont rédigées avec l''aide d''une IA. Écris /stopai si tu préfères ne plus en recevoir.',
  persona text not null default '',
  updated_at timestamptz not null default now(),
  check (delay_min_s >= 0 and delay_max_s >= delay_min_s and delay_max_s <= 86400)
);
alter table public.bot_settings enable row level security;

-- ---------- Liaison Telegram ----------
create table public.telegram_links (
  user_id uuid primary key references public.profiles on delete cascade,
  link_code text unique not null default substr(replace(gen_random_uuid()::text,'-',''),1,20),
  telegram_user_id bigint unique,
  telegram_username text,
  telegram_name text,
  linked_at timestamptz
);
alter table public.telegram_links enable row level security;

create table public.business_connections (
  id text primary key,
  telegram_user_id bigint not null,
  user_chat_id bigint,
  can_reply boolean not null default false,
  is_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);
create index on public.business_connections(telegram_user_id);
alter table public.business_connections enable row level security;

-- ---------- Discussions & messages ----------
create table public.chats (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles on delete cascade,
  tg_chat_id bigint not null,
  title text,
  username text,
  mode_override text check (mode_override in ('off','observation','validation','auto')),
  pinned boolean not null default false,
  paused_until timestamptz,
  ai_stopped boolean not null default false,
  notice_sent boolean not null default false,
  unread int not null default 0,
  last_message_at timestamptz,
  last_message_preview text,
  created_at timestamptz not null default now(),
  unique(user_id, tg_chat_id)
);
create index on public.chats(user_id, last_message_at desc);
alter table public.chats enable row level security;

create table public.messages (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles on delete cascade,
  chat_id bigint not null references public.chats on delete cascade,
  tg_message_id bigint,
  role text not null check (role in ('contact','owner','ai')),
  text text not null,
  created_at timestamptz not null default now()
);
create index on public.messages(chat_id, created_at desc);
create index on public.messages(user_id, created_at);
alter table public.messages enable row level security;

-- File d'attente des réponses + brouillons
create table public.replies (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles on delete cascade,
  chat_id bigint not null references public.chats on delete cascade,
  status text not null default 'scheduled'
    check (status in ('scheduled','generating','draft','sent','cancelled','skipped','failed')),
  due_at timestamptz not null,
  draft_text text,
  sent_text text,
  error text,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create unique index replies_one_open on public.replies(chat_id) where status in ('scheduled','generating');
create index on public.replies(status, due_at);
create index on public.replies(user_id, created_at desc);
alter table public.replies enable row level security;

-- Événements anonymes pour les stats et quotas (aucun contenu)
create table public.events (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles on delete cascade,
  chat_id bigint,
  kind text not null check (kind in ('received','owner','ai_sent','draft','link_sent')),
  created_at timestamptz not null default now()
);
create index on public.events(user_id, kind, created_at);
alter table public.events enable row level security;

-- ---------- Apprentissage ----------
create table public.instructions (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles on delete cascade,
  text text not null check (length(text) between 3 and 1000),
  active boolean not null default true,
  source text not null default 'dashboard' check (source in ('dashboard','telegram')),
  created_at timestamptz not null default now()
);
alter table public.instructions enable row level security;

create table public.examples (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles on delete cascade,
  chat_id bigint references public.chats on delete set null,
  contact_text text not null,
  reply_text text not null,
  status text not null default 'pending' check (status in ('pending','validated')),
  created_at timestamptz not null default now()
);
create index on public.examples(user_id, status, created_at desc);
alter table public.examples enable row level security;

-- ---------- Liens de vente (Buy) ----------
create table public.links (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles on delete cascade,
  title text not null check (length(title) between 1 and 120),
  url text not null check (url ~* '^https?://'),
  price_label text,
  description text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.links enable row level security;

-- ---------- Droits ----------
revoke all on public.plans, public.profiles, public.bot_settings, public.telegram_links,
  public.business_connections, public.chats, public.messages, public.replies, public.events,
  public.instructions, public.examples, public.links from anon, authenticated;

grant select on public.plans to anon, authenticated;
grant update (name, msg_quota, price_label, description, learning, buy) on public.plans to authenticated;
grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;
grant select on public.bot_settings to authenticated;
grant update (mode, delay_min_s, delay_max_s, resume_minutes, buy_enabled, ai_notice_enabled, ai_notice_text, persona, updated_at) on public.bot_settings to authenticated;
grant select on public.telegram_links, public.business_connections to authenticated;
grant select on public.chats to authenticated;
grant update (pinned, mode_override, paused_until, ai_stopped) on public.chats to authenticated;
grant select on public.messages, public.replies, public.events to authenticated;
grant select, insert, delete on public.instructions to authenticated;
grant update (active, text) on public.instructions to authenticated;
grant select, delete on public.examples to authenticated;
grant update (status, reply_text) on public.examples to authenticated;
grant select, insert, delete on public.links to authenticated;
grant update (title, url, price_label, description, active) on public.links to authenticated;

-- ---------- Politiques RLS ----------
create policy plans_read on public.plans for select using (true);
create policy plans_admin on public.plans for update to authenticated using (public.is_admin()) with check (public.is_admin());

create policy profiles_read on public.profiles for select to authenticated using (id = auth.uid() or public.is_admin());
create policy profiles_update on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy settings_read on public.bot_settings for select to authenticated using (user_id = auth.uid());
create policy settings_update on public.bot_settings for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy links_tg_read on public.telegram_links for select to authenticated using (user_id = auth.uid());
create policy bc_read on public.business_connections for select to authenticated
  using (telegram_user_id = (select telegram_user_id from public.telegram_links where user_id = auth.uid()));

create policy chats_read on public.chats for select to authenticated using (user_id = auth.uid());
create policy chats_update on public.chats for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy messages_read on public.messages for select to authenticated using (user_id = auth.uid());
create policy replies_read on public.replies for select to authenticated using (user_id = auth.uid());
create policy events_read on public.events for select to authenticated using (user_id = auth.uid());

create policy instr_all on public.instructions for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy examples_all on public.examples for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy links_all on public.links for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- user_id rempli automatiquement à l'insertion côté client
create or replace function public.set_owner() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null then new.user_id := auth.uid(); end if;
  return new;
end $$;
create trigger instructions_owner before insert on public.instructions for each row execute function public.set_owner();
create trigger links_owner before insert on public.links for each row execute function public.set_owner();

-- ---------- Création de compte ----------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles(id, email, display_name)
    values (new.id, new.email, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email,'@',1)));
  insert into public.bot_settings(user_id) values (new.id);
  insert into public.telegram_links(user_id) values (new.id);
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();
