-- Relais IA — Social Automation V2 : Instagram Autopost.
-- Additive only. Does not touch Telegram tables, functions or cron jobs.

-- 1. Account metadata (real values returned by Meta, never invented)
alter table public.social_accounts add column if not exists platform_app_scoped_id text;
alter table public.social_accounts add column if not exists account_type text;
alter table public.social_accounts add column if not exists profile_picture_url text;
alter table public.social_accounts add column if not exists token_refreshed_at timestamptz;
alter table public.social_accounts add column if not exists connected_at timestamptz;
alter table public.social_accounts add column if not exists last_error text;

-- 2. Media dimensions, parsed server-side from the file header
alter table public.social_media add column if not exists width integer check (width is null or width between 1 and 20000);
alter table public.social_media add column if not exists height integer check (height is null or height between 1 and 20000);

-- 3. Publication state machine
alter table public.social_posts add column if not exists lease_until timestamptz;
alter table public.social_posts add column if not exists next_check_at timestamptz;
alter table public.social_posts add column if not exists container_checks integer not null default 0;
alter table public.social_posts add column if not exists reconcile_checks integer not null default 0;
alter table public.social_posts add column if not exists publish_attempted_at timestamptz;
alter table public.social_posts add column if not exists caption_style text;

create index if not exists social_posts_worker_queue on public.social_posts(next_check_at)
  where state in ('scheduled','processing','unknown');

-- 4. Simple per-user rate limiting for costly actions (AI generation, OAuth start)
create table if not exists public.social_rate_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind ~ '^[a-z_]{2,40}$'),
  created_at timestamptz not null default now()
);
create index if not exists social_rate_events_lookup on public.social_rate_events(user_id,kind,created_at desc);
alter table public.social_rate_events enable row level security;
revoke all on table public.social_rate_events from anon,authenticated;

create or replace function public.social_rate_hit(p_user uuid,p_kind text,p_limit int,p_window_seconds int)
returns boolean language plpgsql security definer set search_path=public as $$
declare n int;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user::text||p_kind,0));
  select count(*) into n from public.social_rate_events
   where user_id=p_user and kind=p_kind and created_at>now()-make_interval(secs=>p_window_seconds);
  if n>=p_limit then return false; end if;
  insert into public.social_rate_events(user_id,kind) values (p_user,p_kind);
  delete from public.social_rate_events where created_at<now()-interval '2 days';
  return true;
end $$;
revoke all on function public.social_rate_hit(uuid,text,int,int) from public,anon,authenticated;
grant execute on function public.social_rate_hit(uuid,text,int,int) to service_role;

-- 5. Queue claim with a short lease. One row per call, skip locked => no double processing.
--    A post whose publish call was already attempted (publish_attempted_at not null) is NEVER
--    re-claimed as "processing": it can only be reconciled (read-only checks) as "unknown".
create or replace function public.social_claim_due_post()
returns setof public.social_posts
language plpgsql security definer set search_path=public as $$
begin
  return query
  update public.social_posts p
     set state='processing',
         started_at=coalesce(p.started_at,now()),
         attempts=case when p.state='scheduled' then least(p.attempts+1,10) else p.attempts end,
         lease_until=now()+interval '3 minutes',
         updated_at=now()
   where p.id=(
     select s.id from public.social_posts s
      where s.approved_at is not null and s.account_id is not null
        and (
          (s.state='scheduled' and s.scheduled_at<=now() and s.attempts<5)
          or (s.state='processing' and s.publish_attempted_at is null
              and coalesce(s.lease_until,'-infinity'::timestamptz)<now()
              and coalesce(s.next_check_at,'-infinity'::timestamptz)<=now())
        )
      order by coalesce(s.next_check_at,s.scheduled_at),s.created_at
      limit 1 for update of s skip locked)
  returning p.*;
end $$;
revoke all on function public.social_claim_due_post() from public,anon,authenticated;
grant execute on function public.social_claim_due_post() to service_role;

-- A publish attempt whose lease expired without a result (crash/timeout) becomes "unknown".
create or replace function public.social_flag_stale_publishes()
returns integer language plpgsql security definer set search_path=public as $$
declare n int;
begin
  with x as (
    update public.social_posts set state='unknown',lease_until=null,next_check_at=now()+interval '2 minutes',
      last_error='Publication interrompue : vérification automatique en cours',updated_at=now()
     where state='processing' and publish_attempted_at is not null and lease_until<now()
    returning id,user_id)
  insert into public.social_job_events(user_id,post_id,event,detail)
  select user_id,id,'unknown','Bail expiré après tentative de publication' from x;
  get diagnostics n=row_count;
  return n;
end $$;
revoke all on function public.social_flag_stale_publishes() from public,anon,authenticated;
grant execute on function public.social_flag_stale_publishes() to service_role;

create or replace function public.social_claim_unknown_post()
returns setof public.social_posts
language plpgsql security definer set search_path=public as $$
begin
  return query
  update public.social_posts p
     set lease_until=now()+interval '2 minutes',reconcile_checks=p.reconcile_checks+1,updated_at=now()
   where p.id=(
     select s.id from public.social_posts s
      where s.state='unknown' and s.reconcile_checks<12 and s.external_container_id is not null
        and coalesce(s.lease_until,'-infinity'::timestamptz)<now()
        and coalesce(s.next_check_at,'-infinity'::timestamptz)<=now()
      order by s.next_check_at nulls first
      limit 1 for update of s skip locked)
  returning p.*;
end $$;
revoke all on function public.social_claim_unknown_post() from public,anon,authenticated;
grant execute on function public.social_claim_unknown_post() to service_role;

-- 6. Worker authentication secret, generated inside the database (never shown to anyone).
do $$
begin
  if not exists (select 1 from vault.secrets where name='social_worker_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32),'hex'),'social_worker_secret','Header secret for social-worker cron calls');
  end if;
end $$;

create or replace function public.social_worker_auth(p_secret text)
returns boolean language sql stable security definer set search_path=public,vault as $$
  select coalesce(length(p_secret)>=32 and p_secret=(select decrypted_secret from vault.decrypted_secrets where name='social_worker_secret' limit 1),false);
$$;
revoke all on function public.social_worker_auth(text) from public,anon,authenticated;
grant execute on function public.social_worker_auth(text) to service_role;

-- 7. Scheduler, created INACTIVE. Activation requires explicit owner approval.
do $$
declare jid bigint;
begin
  select jobid into jid from cron.job where jobname='relais-social-worker';
  if jid is null then
    jid := cron.schedule('relais-social-worker','* * * * *',$cmd$
      select net.http_post(
        url := 'https://owbcnkcuxcgsawjqkssk.supabase.co/functions/v1/social-worker',
        headers := jsonb_build_object('Content-Type','application/json','x-social-worker-secret',
          (select decrypted_secret from vault.decrypted_secrets where name='social_worker_secret' limit 1)),
        body := '{}'::jsonb,
        timeout_milliseconds := 55000);
    $cmd$);
    perform cron.alter_job(job_id:=jid,active:=false);
  end if;
end $$;

create or replace function public.social_scheduler_status()
returns jsonb language sql stable security definer set search_path=public,cron as $$
  select coalesce((select jsonb_build_object('exists',true,'active',active,'schedule',schedule) from cron.job where jobname='relais-social-worker'),
                  jsonb_build_object('exists',false,'active',false));
$$;
revoke all on function public.social_scheduler_status() from public,anon,authenticated;
grant execute on function public.social_scheduler_status() to service_role;

-- Only callable by service_role; social-api additionally checks profiles.is_admin.
create or replace function public.social_set_scheduler(p_active boolean)
returns jsonb language plpgsql security definer set search_path=public,cron as $$
declare jid bigint;
begin
  select jobid into jid from cron.job where jobname='relais-social-worker';
  if jid is null then raise exception 'social scheduler missing'; end if;
  perform cron.alter_job(job_id:=jid,active:=p_active);
  return public.social_scheduler_status();
end $$;
revoke all on function public.social_set_scheduler(boolean) from public,anon,authenticated;
grant execute on function public.social_set_scheduler(boolean) to service_role;

-- 8. Housekeeping: expired OAuth states (10 min lifetime)
delete from public.social_oauth_states where expires_at<now()-interval '1 day';
