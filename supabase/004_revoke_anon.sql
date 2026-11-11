revoke execute on function public.admin_list_users() from public, anon;
revoke execute on function public.admin_set_plan(uuid, text, int) from public, anon;
revoke execute on function public.claim_admin(text) from public, anon;
revoke execute on function public.get_stats(timestamptz, timestamptz) from public, anon;
revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.my_overview() from public, anon;
revoke execute on function public.regenerate_link_code() from public, anon;
grant execute on function public.is_admin() to authenticated;
