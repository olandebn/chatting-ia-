select cron.schedule('relais-worker', '* * * * *', $job$
  select net.http_post(
    url := 'https://owbcnkcuxcgsawjqkssk.supabase.co/functions/v1/worker',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',(select value from public.app_config where key='cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 58000
  );
$job$);
select cron.schedule('relais-retention', '17 3 * * *', $job$
  delete from public.messages where created_at < now() - interval '30 days';
  delete from public.replies where created_at < now() - interval '90 days' and status not in ('scheduled','generating','draft');
  delete from net._http_response where created < now() - interval '1 day';
$job$);
