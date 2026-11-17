// Relais IA Social Worker V2 — Instagram Autopost queue runner.
// Called once per minute by pg_cron job "relais-social-worker" (created INACTIVE; owner activates it).
// Auth: header x-social-worker-secret checked against the Vault secret (or SOCIAL_WORKER_SECRET env).
import { createClient } from 'npm:@supabase/supabase-js@2.57.0';
import { processPost, reconcilePost, refreshTokens, type Repo, type Row } from './engine.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const BUCKET = 'relais-social-private';
const db = createClient(SUPABASE_URL, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } });
const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function authorized(req: Request) {
  const given = req.headers.get('x-social-worker-secret') || '';
  if (given.length < 32) return false;
  const env = Deno.env.get('SOCIAL_WORKER_SECRET');
  if (env && timingSafeEqual(given, env)) return true;
  const { data, error } = await db.rpc('social_worker_auth', { p_secret: given });
  return !error && data === true;
}

const repo: Repo = {
  async getAccount(post) { const { data } = await db.from('social_accounts').select('*').eq('id', post.account_id).eq('user_id', post.user_id).eq('creator_id', post.creator_id).maybeSingle(); return data; },
  async getMedia(post) { const { data } = await db.from('social_media').select('storage_path,mime_type,state,bytes,width,height').eq('id', post.media_id).eq('user_id', post.user_id).eq('creator_id', post.creator_id).maybeSingle(); return data; },
  async updatePost(id, patch, guard) {
    let q = db.from('social_posts').update(patch).eq('id', id).eq('state', guard.state);
    if (guard.publishNull) q = q.is('publish_attempted_at', null);
    const { data, error } = await q.select('id');
    if (error) throw Error('DB update failed: ' + error.message);
    return (data?.length ?? 0) > 0;
  },
  async updateAccount(id, patch) { await db.from('social_accounts').update(patch).eq('id', id); },
  async event(post, event, detail) { await db.from('social_job_events').insert({ user_id: post.user_id, post_id: post.id, event, detail: detail ? String(detail).slice(0, 300) : null }); },
  async signedUrl(path, seconds) { const { data, error } = await db.storage.from(BUCKET).createSignedUrl(path, seconds); if (error || !data?.signedUrl) throw Error('Image inaccessible dans le stockage privé'); return data.signedUrl; },
  async accountsToRefresh(limit) {
    const now = Date.now();
    const { data } = await db.from('social_accounts').select('id,encrypted_token,token_expires_at,token_refreshed_at,connected_at')
      .eq('platform', 'instagram').eq('state', 'connected').not('encrypted_token', 'is', null)
      .lt('token_expires_at', new Date(now + 10 * 864e5).toISOString()).gt('token_expires_at', new Date(now).toISOString())
      .or(`token_refreshed_at.is.null,token_refreshed_at.lt.${new Date(now - 864e5).toISOString()}`).limit(limit);
    return (data ?? []) as Row[];
  },
  async expireAccounts() {
    const { data } = await db.from('social_accounts').update({ state: 'expired', last_error: 'Token expiré', updated_at: new Date().toISOString() })
      .eq('state', 'connected').lt('token_expires_at', new Date().toISOString()).select('id');
    return data?.length ?? 0;
  },
};

Deno.serve(async (req) => {
  if (req.method !== 'POST' || !(await authorized(req))) return respond({ error: 'forbidden' }, 403);
  const tokenKey = Deno.env.get('SOCIAL_TOKEN_KEY');
  if (!tokenKey || !Deno.env.get('INSTAGRAM_APP_SECRET')) return respond({ ok: false, error: 'Meta non configuré', processed: 0 }, 503);
  const deps = { repo, fetch, tokenKey };
  const started = Date.now();
  const summary: Record<string, number> = {};
  const bump = (k: string) => { summary[k] = (summary[k] ?? 0) + 1; };
  try {
    await db.rpc('social_flag_stale_publishes');
    for (let i = 0; i < 5 && Date.now() - started < 35_000; i++) {
      const { data, error } = await db.rpc('social_claim_due_post');
      if (error) { console.error('claim failed', error.message); break; }
      if (!data?.length) break;
      try { bump(await processPost(data[0], deps)); } catch (e) { console.error('process error', e instanceof Error ? e.message : e); bump('error'); }
    }
    for (let i = 0; i < 3 && Date.now() - started < 45_000; i++) {
      const { data, error } = await db.rpc('social_claim_unknown_post');
      if (error || !data?.length) break;
      try { bump('reconcile_' + await reconcilePost(data[0], deps)); } catch (e) { console.error('reconcile error', e instanceof Error ? e.message : e); bump('error'); }
    }
    if (Date.now() - started < 45_000) summary.tokens_refreshed = await refreshTokens(deps);
  } catch (e) { console.error('social worker', e instanceof Error ? e.message : e); return respond({ ok: false, summary }, 500); }
  return respond({ ok: true, summary });
});
