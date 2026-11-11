-- ---------- Quota ----------
create or replace function public.quota_used(p_user uuid) returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from public.events e
  join public.profiles p on p.id = e.user_id
  where e.user_id = p_user and e.kind = 'ai_sent' and e.created_at >= p.period_start
$$;
revoke execute on function public.quota_used(uuid) from public, anon, authenticated;

-- ---------- Vue d'ensemble du compte ----------
create or replace function public.my_overview() returns json
language plpgsql stable security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  r json;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  select json_build_object(
    'profile', (select row_to_json(p) from (select id, email, display_name, is_admin, plan_id, period_start, period_end from public.profiles where id = uid) p),
    'plan', (select row_to_json(pl) from public.plans pl join public.profiles p on p.plan_id = pl.id where p.id = uid),
    'quota_used', public.quota_used(uid),
    'telegram', (select row_to_json(t) from (select link_code, telegram_user_id, telegram_username, telegram_name, linked_at from public.telegram_links where user_id = uid) t),
    'connection', (select row_to_json(c) from (
        select bc.id is not null as present, bc.can_reply, bc.is_enabled, bc.updated_at
        from public.telegram_links tl join public.business_connections bc on bc.telegram_user_id = tl.telegram_user_id
        where tl.user_id = uid order by bc.updated_at desc limit 1) c),
    'bot_username', (select value from public.app_config where key = 'bot_username'),
    'pending_examples', (select count(*) from public.examples where user_id = uid and status = 'pending'),
    'validated_examples', (select count(*) from public.examples where user_id = uid and status = 'validated'),
    'pending_drafts', (select count(*) from public.replies where user_id = uid and status = 'draft')
  ) into r;
  return r;
end $$;
grant execute on function public.my_overview() to authenticated;

create or replace function public.public_bot_info() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('bot_username', (select value from public.app_config where key = 'bot_username'))
$$;
grant execute on function public.public_bot_info() to anon, authenticated;

create or replace function public.regenerate_link_code() returns text
language plpgsql security definer set search_path = public as $$
declare c text := substr(replace(gen_random_uuid()::text,'-',''),1,20);
begin
  update public.telegram_links set link_code = c where user_id = auth.uid();
  return c;
end $$;
grant execute on function public.regenerate_link_code() to authenticated;

-- ---------- Statistiques ----------
create or replace function public.get_stats(p_from timestamptz, p_to timestamptz) returns json
language plpgsql stable security definer set search_path = public as $$
declare uid uuid := auth.uid(); r json;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  with ev as (
    select kind, created_at, chat_id from public.events
    where user_id = uid and created_at >= p_from and created_at < p_to
  ), days as (
    select generate_series(date_trunc('day', p_from), date_trunc('day', p_to - interval '1 second'), interval '1 day') d
  )
  select json_build_object(
    'received', (select count(*) from ev where kind = 'received'),
    'ai_sent', (select count(*) from ev where kind = 'ai_sent'),
    'owner', (select count(*) from ev where kind = 'owner'),
    'drafts', (select count(*) from ev where kind = 'draft'),
    'link_sent', (select count(*) from ev where kind = 'link_sent'),
    'active_chats', (select count(distinct chat_id) from ev where kind = 'received'),
    'series', (select coalesce(json_agg(json_build_object(
        'day', to_char(d, 'YYYY-MM-DD'),
        'received', (select count(*) from ev where kind = 'received' and date_trunc('day', created_at) = d),
        'ai_sent', (select count(*) from ev where kind = 'ai_sent' and date_trunc('day', created_at) = d),
        'owner', (select count(*) from ev where kind = 'owner' and date_trunc('day', created_at) = d)
      ) order by d), '[]'::json) from days)
  ) into r;
  return r;
end $$;
grant execute on function public.get_stats(timestamptz, timestamptz) to authenticated;

-- ---------- Admin ----------
create or replace function public.claim_admin(p_code text) returns boolean
language plpgsql security definer set search_path = public as $$
declare c text;
begin
  if auth.uid() is null then return false; end if;
  select value into c from public.app_config where key = 'admin_setup_code';
  if c is null or upper(trim(p_code)) <> c then return false; end if;
  update public.profiles set is_admin = true, plan_id = 'scale', period_start = now(), period_end = now() + interval '100 years' where id = auth.uid();
  delete from public.app_config where key = 'admin_setup_code';
  return true;
end $$;
grant execute on function public.claim_admin(text) to authenticated;

create or replace function public.admin_list_users() returns table (
  id uuid, email text, display_name text, is_admin boolean, plan_id text,
  period_start timestamptz, period_end timestamptz, created_at timestamptz,
  quota_used int, telegram_username text, linked boolean, mode text
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  return query
    select p.id, p.email, p.display_name, p.is_admin, p.plan_id, p.period_start, p.period_end, p.created_at,
      public.quota_used(p.id), t.telegram_username, t.telegram_user_id is not null, s.mode
    from public.profiles p
    left join public.telegram_links t on t.user_id = p.id
    left join public.bot_settings s on s.user_id = p.id
    order by p.created_at desc;
end $$;
grant execute on function public.admin_list_users() to authenticated;

create or replace function public.admin_set_plan(p_user uuid, p_plan text, p_days int) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  update public.profiles
    set plan_id = p_plan, period_start = now(), period_end = now() + make_interval(days => greatest(p_days, 1))
    where id = p_user;
end $$;
grant execute on function public.admin_set_plan(uuid, text, int) to authenticated;

-- ---------- File d'attente (service role uniquement) ----------
create or replace function public.claim_due_replies(p_limit int default 20) returns setof public.replies
language plpgsql security definer set search_path = public as $$
begin
  return query
  update public.replies r set status = 'generating', claimed_at = now()
  where r.id in (
    select id from public.replies
    where (status = 'scheduled' and due_at <= now())
       or (status = 'generating' and claimed_at < now() - interval '5 minutes')
    order by due_at
    limit p_limit
    for update skip locked
  )
  returning r.*;
end $$;
revoke execute on function public.claim_due_replies(int) from public, anon, authenticated;
grant execute on function public.claim_due_replies(int) to service_role;

create or replace function public.get_config(p_key text) returns text
language sql stable security definer set search_path = public as $$
  select value from public.app_config where key = p_key
$$;
revoke execute on function public.get_config(text) from public, anon, authenticated;
grant execute on function public.get_config(text) to service_role;

-- Les fonctions SECURITY DEFINER créées par défaut sont exécutables par public : on restreint
revoke execute on function public.set_owner() from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
