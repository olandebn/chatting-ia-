// Relais IA Social Automation API (v3). Isolated: does not touch the Telegram worker/webhook.
// NOTE: never name a constant `URL` here — it shadows the global URL constructor (bug fixed in v2).
import { createClient } from 'npm:@supabase/supabase-js@2.57.0';
import {
  CAPTION_STYLES, encryptToken, GRAPH_HOST, GRAPH_VERSION, IG_AUTHORIZE, IG_TOKEN, imageSize, instagramImageProblem,
  parseCaptionVariants, parseLongToken, parseProfile, parseShortToken, REQUIRED_SCOPES, sniffMime, verifySignedRequest, withTransparency,
} from '../_shared/social_meta.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const PUB = Deno.env.get('SUPABASE_ANON_KEY') || '';
const ORIGIN = 'https://olandebn.github.io';
const APP_PATH = '/chatting-ia-/';
const BUCKET = 'relais-social-private';
const REDIRECT = SUPABASE_URL + '/functions/v1/social-api';
const admin = createClient(SUPABASE_URL, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } });
const auth = createClient(SUPABASE_URL, PUB, { auth: { autoRefreshToken: false, persistSession: false } });
const cors = { 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Headers': 'authorization,apikey,content-type,x-client-info', 'Access-Control-Allow-Methods': 'OPTIONS,POST', 'Cache-Control': 'no-store', 'Vary': 'Origin' };
const result = (object: unknown, status = 200) => new Response(JSON.stringify(object), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const bad = (s: string, code = 400) => result({ error: s }, code);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isId = (x: unknown): x is string => typeof x === 'string' && uuid.test(x);
const safeText = (s: unknown, max: number) => typeof s === 'string' ? s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max) : '';
const accepted = new Set(['image/jpeg', 'image/png', 'image/webp']);
const nowIso = () => new Date().toISOString();
const errMessage = (e: unknown) => e instanceof Error ? e.message : String(e);
const env = (k: string) => Deno.env.get(k) || '';
const metaConfigured = () => !!(env('INSTAGRAM_APP_ID') && env('INSTAGRAM_APP_SECRET') && env('SOCIAL_TOKEN_KEY'));
const POST_FIELDS = 'id,media_id,media_ids,account_id,caption,caption_style,state,scheduled_at,created_at,updated_at,published_at,external_post_id,external_permalink,last_error,attempts,approved_at,publish_attempted_at';
// Ordered carousel selection. Always verify ownership and ready state on the server.
async function validateDraftMedia(userId: string, creatorId: string, coverId: string, requested: unknown) {
  if (!Array.isArray(requested) || requested.length < 1 || requested.length > 20 || requested[0] !== coverId ||
      requested.some((id) => !isId(id)) || new Set(requested).size !== requested.length) return null;
  const { data, error } = await admin.from('social_media')
    .select('id,is_synthetic,state,mime_type,bytes,width,height')
    .eq('user_id', userId).eq('creator_id', creatorId).in('id', requested);
  if (error || !data || data.length !== requested.length) return null;
  const found = new Map<string, any>(data.map((m: any) => [m.id, m]));
  const images: any[] = requested.map((id: string) => found.get(id));
  if (images.some((m) => !m || m.state !== 'ready')) return null;
  // Buffer carousel cards must be JPEG and Instagram compatible. Preserve legacy one-image Meta behavior.
  if (images.length > 1 && images.some((m) => m.mime_type !== 'image/jpeg' || m.bytes > 8 * 1024 * 1024 ||
      !m.width || !m.height || m.width < 320 || m.width / m.height < 0.8 || m.width / m.height > 1.91)) return null;
  return { ids: requested as string[], synthetic: images.some((m) => m.is_synthetic) };
}

const ACCOUNT_FIELDS = 'id,creator_id,platform,username,account_type,profile_picture_url,state,permissions,token_expires_at,token_refreshed_at,connected_at,last_error';

async function creatorFor(uid: string, id: string) { const { data, error } = await admin.from('social_creators').select('*').eq('user_id', uid).eq('id', id).maybeSingle(); if (error) throw error; return data; }
async function accountFor(uid: string, creator: string, accountId: string) { const { data, error } = await admin.from('social_accounts').select('*').eq('user_id', uid).eq('creator_id', creator).eq('id', accountId).maybeSingle(); if (error) throw error; return data; }
async function rateOk(uid: string, kind: string, limit: number, windowSeconds: number) { const { data, error } = await admin.rpc('social_rate_hit', { p_user: uid, p_kind: kind, p_limit: limit, p_window_seconds: windowSeconds }); if (error) throw error; return data === true; }
async function event(uid: string, postId: string, ev: string, detail?: string) { await admin.from('social_job_events').insert({ user_id: uid, post_id: postId, event: ev, detail: detail?.slice(0, 300) ?? null }); }

// ---------------- OAuth callback (GET, browser redirect from Instagram) ----------------
function redirectStatus(code: string) { const u = new URL(ORIGIN + APP_PATH); u.searchParams.set('social_oauth', code); u.hash = '#/app/social'; return Response.redirect(u.toString(), 302); }
async function oauthCallback(input: URL) {
  const state = input.searchParams.get('state') || '';
  if (!isId(state)) return redirectStatus('invalid_state');
  const { data: s } = await admin.from('social_oauth_states').select('*').eq('state', state).maybeSingle();
  if (!s || s.used_at || new Date(s.expires_at).getTime() < Date.now()) return redirectStatus('expired_state');
  const { data: consumed, error: consumeErr } = await admin.from('social_oauth_states').update({ used_at: nowIso() }).eq('state', state).is('used_at', null).select('state').maybeSingle();
  if (consumeErr || !consumed) return redirectStatus('consumed_state');
  if (input.searchParams.get('error')) return redirectStatus('authorization_denied');
  const code = (input.searchParams.get('code') || '').replace(/#_$/, '');
  if (!code) return redirectStatus('authorization_denied');
  if (!metaConfigured()) return redirectStatus('not_configured');
  const clientId = env('INSTAGRAM_APP_ID'), secret = env('INSTAGRAM_APP_SECRET');
  try {
    const shortRes = await fetch(IG_TOKEN, { method: 'POST', body: new URLSearchParams({ client_id: clientId, client_secret: secret, grant_type: 'authorization_code', redirect_uri: REDIRECT, code }), signal: AbortSignal.timeout(18000) });
    const short = parseShortToken(await shortRes.json().catch(() => null));
    if (!shortRes.ok || !short) throw Error('short-lived token exchange failed (' + shortRes.status + ')');
    const granted = short.permissions;
    if (granted.length && !REQUIRED_SCOPES.every((p) => granted.includes(p))) return redirectStatus('missing_permissions');
    const exUrl = new URL(GRAPH_HOST + '/access_token');
    exUrl.search = new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: secret, access_token: short.access_token }).toString();
    const longRes = await fetch(exUrl, { signal: AbortSignal.timeout(18000) });
    const long = parseLongToken(await longRes.json().catch(() => null));
    if (!longRes.ok || !long) throw Error('long-lived token exchange failed (' + longRes.status + ')');
    const meUrl = new URL(`${GRAPH_HOST}/${GRAPH_VERSION}/me`);
    meUrl.search = new URLSearchParams({ fields: 'user_id,username,account_type,profile_picture_url', access_token: long.access_token }).toString();
    const meRes = await fetch(meUrl, { signal: AbortSignal.timeout(18000) });
    const me = parseProfile(await meRes.json().catch(() => null));
    if (!meRes.ok || !me) throw Error('profile unavailable (' + meRes.status + ')');
    if (me.account_type && !/^(business|media_creator|creator)$/i.test(me.account_type)) return redirectStatus('not_professional');
    const { data: existing } = await admin.from('social_accounts').select('id,creator_id').eq('user_id', s.user_id).eq('platform', 'instagram').eq('platform_user_id', me.ig_user_id).maybeSingle();
    if (existing && existing.creator_id !== s.creator_id) return redirectStatus('account_linked_elsewhere');
    const permissions = granted.length ? granted : [...REQUIRED_SCOPES];
    const payload = {
      user_id: s.user_id, creator_id: s.creator_id, platform: 'instagram', platform_user_id: me.ig_user_id, platform_app_scoped_id: me.app_scoped_id,
      username: me.username, account_type: me.account_type, profile_picture_url: me.profile_picture_url, state: 'connected',
      encrypted_token: await encryptToken(long.access_token, env('SOCIAL_TOKEN_KEY')), token_expires_at: new Date(Date.now() + long.expires_in * 1000).toISOString(),
      token_refreshed_at: nowIso(), connected_at: nowIso(), permissions, last_error: null, updated_at: nowIso(),
    };
    const save = existing ? await admin.from('social_accounts').update(payload).eq('id', existing.id).eq('user_id', s.user_id) : await admin.from('social_accounts').insert(payload);
    if (save.error) throw save.error;
    return redirectStatus('connected');
  } catch (e) { console.error('social oauth callback failed', errMessage(e)); return redirectStatus('connection_failed'); }
}

// ---------------- Meta deauthorize / data deletion callbacks (signed_request) ----------------
async function metaCallback(req: Request, kind: string) {
  const secret = env('INSTAGRAM_APP_SECRET');
  if (!secret) return new Response('not configured', { status: 503 });
  const form = await req.formData().catch(() => null);
  const signed = String(form?.get('signed_request') || '');
  const data = signed ? await verifySignedRequest(signed, secret) : null;
  if (!data?.user_id) return new Response('invalid signed_request', { status: 400 });
  const igUser = String(data.user_id);
  const { data: rows } = await admin.from('social_accounts').select('id').eq('platform', 'instagram').or(`platform_user_id.eq.${igUser.replace(/[^0-9]/g, '')},platform_app_scoped_id.eq.${igUser.replace(/[^0-9]/g, '')}`);
  for (const r of rows ?? []) await admin.from('social_accounts').update({ state: 'disconnected', encrypted_token: null, token_expires_at: null, permissions: [], last_error: kind === 'data_deletion' ? 'Suppression demandée via Meta' : 'Accès retiré depuis Instagram', updated_at: nowIso() }).eq('id', r.id);
  console.log('meta callback', kind, 'accounts', rows?.length ?? 0);
  if (kind === 'data_deletion') {
    const confirmation = crypto.randomUUID();
    return new Response(JSON.stringify({ url: ORIGIN + APP_PATH + '#/guide', confirmation_code: confirmation }), { headers: { 'Content-Type': 'application/json' } });
  }
  return new Response('ok');
}

// ---------------- Authenticated JSON API (POST from GitHub Pages) ----------------
async function postHandler(req: Request) {
  if (req.headers.get('origin') !== ORIGIN) return bad('Origine non autorisée', 403);
  const bearer = req.headers.get('authorization')?.match(/^Bearer\s+([^\s]+)$/i)?.[1];
  if (!bearer) return bad('Session requise', 401);
  const { data: userInfo, error: userErr } = await auth.auth.getUser(bearer);
  if (userErr || !userInfo.user) return bad('Session expirée : reconnecte-toi à Relais IA', 401);
  const uid = userInfo.user.id;
  if (Number(req.headers.get('content-length') || 0) > 64_000) return bad('Requête trop volumineuse', 413);
  let b: any; try { b = await req.json(); } catch { return bad('JSON invalide'); }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return bad('Requête invalide');
  const action = String(b.action || '');
  try {
    if (action === 'status') {
      const [creators, accounts, sched, profile] = await Promise.all([
        admin.from('social_creators').select('id,name,timezone,description').eq('user_id', uid).order('created_at'),
        admin.from('social_accounts').select(ACCOUNT_FIELDS).eq('user_id', uid),
        admin.rpc('social_scheduler_status'),
        admin.from('profiles').select('is_admin').eq('id', uid).maybeSingle(),
      ]);
      if (creators.error || accounts.error) throw creators.error || accounts.error;
      return result({
        creators: creators.data, accounts: accounts.data, instagram_configured: metaConfigured(), ai_configured: !!env('NOTRACK_API_KEY'),
        scheduler: sched.data ?? { exists: false, active: false }, is_admin: !!profile.data?.is_admin, redirect_uri: REDIRECT, graph_version: GRAPH_VERSION,
      });
    }
    if (action === 'create_creator') {
      const name = safeText(b.name, 100); if (!name) return bad('Nom du créateur requis');
      const { count } = await admin.from('social_creators').select('id', { count: 'exact', head: true }).eq('user_id', uid);
      if ((count ?? 0) >= 20) return bad('Limite de 20 créateurs atteinte');
      const { data, error } = await admin.from('social_creators').insert({ user_id: uid, name }).select('id,name,timezone,description').single(); if (error) throw error; return result({ creator: data });
    }
    if (action === 'scheduler_set') {
      const { data: p } = await admin.from('profiles').select('is_admin').eq('id', uid).maybeSingle();
      if (!p?.is_admin) return bad('Réservé à l’administrateur', 403);
      const active = b.active === true;
      if (active && (!metaConfigured() || b.confirm !== 'ACTIVER')) return bad('Configuration Meta incomplète ou confirmation manquante');
      const { data, error } = await admin.rpc('social_set_scheduler', { p_active: active }); if (error) throw error;
      console.log('social scheduler set', active, 'by', uid);
      return result({ scheduler: data });
    }

    if (!isId(b.creator_id) || !(await creatorFor(uid, b.creator_id))) return bad('Créateur introuvable', 404);
    const creator: string = b.creator_id;

    if (action === 'update_creator') {
      const patch: Record<string, string> = {};
      if (typeof b.description === 'string') patch.description = safeText(b.description, 600);
      if (typeof b.timezone === 'string') { const tz = safeText(b.timezone, 60); try { new Intl.DateTimeFormat('fr-FR', { timeZone: tz }); patch.timezone = tz; } catch { return bad('Fuseau horaire invalide'); } }
      const { data, error } = await admin.from('social_creators').update(patch).eq('id', creator).eq('user_id', uid).select('id,name,timezone,description').single(); if (error) throw error; return result({ creator: data });
    }
    if (action === 'dashboard') {
      const [media, posts] = await Promise.all([
        admin.from('social_media').select('id,filename,mime_type,bytes,width,height,state,is_synthetic,created_at').eq('user_id', uid).eq('creator_id', creator).neq('state', 'archived').order('created_at', { ascending: false }).limit(300),
        admin.from('social_posts').select(POST_FIELDS).eq('user_id', uid).eq('creator_id', creator).order('created_at', { ascending: false }).limit(300),
      ]);
      if (media.error || posts.error) throw media.error || posts.error;
      return result({ media: media.data, posts: posts.data });
    }
    if (action === 'start_upload') {
      const mime = String(b.mime_type || ''); const bytes = Number(b.bytes || 0);
      const filename = safeText(b.filename, 160).replace(/[\\/]/g, '_');
      const sha256 = String(b.sha256 || '').toLowerCase(); if (!/^[a-f0-9]{64}$/.test(sha256)) return bad('Empreinte SHA-256 requise');
      if (!filename || !accepted.has(mime) || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > 15 * 1024 * 1024) return bad('Image JPG, PNG ou WebP requise (15 Mo max)');
      if (!(await rateOk(uid, 'upload', 300, 3600))) return bad('Trop d’imports en une heure, réessaie plus tard', 429);
      const { data: dup } = await admin.from('social_media').select('id,state,created_at,storage_path').eq('user_id', uid).eq('creator_id', creator).eq('sha256', sha256).in('state', ['ready', 'uploading']).limit(1).maybeSingle();
      if (dup?.state === 'ready') return result({ duplicate: true, media_id: dup.id });
      if (dup?.state === 'uploading') { // stale/failed earlier transfer: clean and retry
        await admin.storage.from(BUCKET).remove([dup.storage_path]);
        await admin.from('social_media').delete().eq('id', dup.id).eq('user_id', uid).eq('state', 'uploading');
      }
      const id = crypto.randomUUID(); const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/png' ? 'png' : 'webp'; const path = `${uid}/${creator}/${id}.${ext}`;
      const { data: signed, error: signErr } = await admin.storage.from(BUCKET).createSignedUploadUrl(path);
      if (signErr || !signed) throw signErr || Error('Impossible de préparer le transfert');
      const { error } = await admin.from('social_media').insert({ id, user_id: uid, creator_id: creator, filename, storage_path: path, mime_type: mime, bytes, sha256, state: 'uploading', is_synthetic: !!b.is_synthetic });
      if (error) { if (String(error.code) === '23505') return result({ duplicate: true }); throw error; }
      return result({ media_id: id, path, token: signed.token, signed_url: signed.signedUrl });
    }
    if (action === 'finish_upload') {
      if (!isId(b.media_id)) return bad('Média invalide');
      const { data: m } = await admin.from('social_media').select('*').eq('id', b.media_id).eq('user_id', uid).eq('creator_id', creator).maybeSingle();
      if (!m) return bad('Média introuvable', 404);
      if (m.state === 'ready') return result({ ok: true, media_id: m.id });
      const { data: blob, error: downloadErr } = await admin.storage.from(BUCKET).download(m.storage_path);
      if (downloadErr || !blob) return bad('Transfert incomplet, réessaie');
      const content = new Uint8Array(await blob.arrayBuffer());
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', content)), (x) => x.toString(16).padStart(2, '0')).join('');
      const size = imageSize(content);
      if (blob.size !== Number(m.bytes) || digest !== m.sha256 || sniffMime(content.slice(0, 16)) !== m.mime_type || !size || size.width < 1 || size.height < 1 || size.width > 20000 || size.height > 20000) {
        await admin.storage.from(BUCKET).remove([m.storage_path]);
        await admin.from('social_media').delete().eq('id', m.id).eq('user_id', uid);
        return bad('Fichier incorrect, corrompu ou ne correspondant pas à une image valide');
      }
      const { error } = await admin.from('social_media').update({ state: 'ready', width: size.width, height: size.height }).eq('id', m.id).eq('user_id', uid); if (error) throw error;
      return result({ ok: true, media_id: m.id, width: size.width, height: size.height, instagram_problem: instagramImageProblem({ ...m, ...size }) });
    }
    if (action === 'media_urls') {
      const ids = Array.isArray(b.media_ids) ? b.media_ids.filter(isId).slice(0, 60) : [];
      if (!ids.length) return result({ urls: {} });
      const { data: rows, error } = await admin.from('social_media').select('id,storage_path').eq('user_id', uid).eq('creator_id', creator).eq('state', 'ready').in('id', ids); if (error) throw error;
      if (!rows?.length) return result({ urls: {} });
      const { data: signed, error: sErr } = await admin.storage.from(BUCKET).createSignedUrls(rows.map((r) => r.storage_path), 900); if (sErr) throw sErr;
      const byPath = new Map((signed ?? []).map((s: any) => [s.path, s.signedUrl]));
      return result({ urls: Object.fromEntries(rows.map((r) => [r.id, byPath.get(r.storage_path) ?? null])) });
    }
    if (action === 'media_preview') {
      if (!isId(b.media_id)) return bad('Média invalide');
      const { data: m } = await admin.from('social_media').select('storage_path').eq('user_id', uid).eq('creator_id', creator).eq('id', b.media_id).eq('state', 'ready').maybeSingle();
      if (!m) return bad('Média introuvable', 404);
      const { data: s, error } = await admin.storage.from(BUCKET).createSignedUrl(m.storage_path, 300); if (error) throw error; return result({ url: s.signedUrl });
    }
    if (action === 'archive_media') {
      const ids = (Array.isArray(b.media_ids) ? b.media_ids : [b.media_id]).filter(isId).slice(0, 100);
      if (!ids.length) return bad('Média invalide');
      const { data: inUse } = await admin.from('social_posts').select('media_id').eq('user_id', uid).eq('creator_id', creator).in('media_id', ids).in('state', ['scheduled', 'processing', 'unknown']);
      const blocked = new Set((inUse ?? []).map((r) => r.media_id));
      const ok = ids.filter((id: string) => !blocked.has(id));
      if (ok.length) { const { error } = await admin.from('social_media').update({ state: 'archived' }).eq('user_id', uid).eq('creator_id', creator).in('id', ok); if (error) throw error; }
      return result({ archived: ok.length, blocked: blocked.size });
    }
    if (action === 'create_post') {
      if (!isId(b.media_id)) return bad('Choisis une photo');
      const caption = safeText(b.caption, 2200); if (!caption) return bad('La légende est vide');
      const style = Object.hasOwn(CAPTION_STYLES, String(b.caption_style)) ? String(b.caption_style) : null;
      const selection = await validateDraftMedia(uid, creator, b.media_id, b.media_ids === undefined ? [b.media_id] : b.media_ids);
      if (!selection) return bad('Sélection invalide : 1 à 20 photos du créateur, JPEG compatibles pour un carrousel');
      const finalCaption = withTransparency(caption, selection.synthetic);
      const { data, error } = await admin.from('social_posts').insert({ user_id: uid, creator_id: creator, media_id: selection.ids[0], media_ids: selection.ids, caption: finalCaption, caption_style: style, state: 'draft' }).select(POST_FIELDS).single(); if (error) throw error;
      await event(uid, data.id, 'draft_created');
      return result({ post: data });
    }
    if (action === 'update_post') {
      if (!isId(b.post_id)) return bad('Brouillon invalide');
      const { data: original } = await admin.from('social_posts').select('media_id,media_ids').eq('id', b.post_id).eq('user_id', uid).eq('creator_id', creator).eq('state', 'draft').maybeSingle();
      if (!original) return bad('Seuls les brouillons peuvent être modifiés');
      const coverId = b.media_id === undefined ? original.media_id : b.media_id;
      if (!isId(coverId)) return bad('Photo de couverture invalide');
      const selected = b.media_ids === undefined ? (original.media_ids?.length ? original.media_ids : [coverId]) : b.media_ids;
      const selection = await validateDraftMedia(uid, creator, coverId, selected);
      if (!selection) return bad('Sélection invalide : 1 à 20 photos du créateur, JPEG compatibles pour un carrousel');
      const caption = safeText(b.caption, 2200); if (!caption) return bad('La légende est vide');
      const { data: p, error } = await admin.from('social_posts').update({ media_id: selection.ids[0], media_ids: selection.ids, caption: withTransparency(caption, selection.synthetic), updated_at: nowIso() }).eq('id', b.post_id).eq('user_id', uid).eq('creator_id', creator).eq('state', 'draft').select(POST_FIELDS).maybeSingle();
      if (error) throw error; if (!p) return bad('Seuls les brouillons peuvent être modifiés'); return result({ post: p });
    }
        if (action === 'schedule_post') {
      if (!isId(b.post_id) || !isId(b.account_id)) return bad('Identifiants invalides');
      if (b.approved_non_explicit !== true) return bad('Confirme que le contenu est non explicite et conforme aux règles d’Instagram');
      const at = new Date(String(b.scheduled_at || ''));
      if (!Number.isFinite(at.getTime()) || at.getTime() < Date.now() + 2 * 60_000 || at.getTime() > Date.now() + 180 * 864e5) return bad('Date invalide : au moins 2 minutes dans le futur et au plus 6 mois');
      if (!metaConfigured()) return bad('Intégration Meta non configurée côté serveur');
      const account = await accountFor(uid, creator, b.account_id);
      if (!account || account.platform !== 'instagram' || account.state !== 'connected' || !account.encrypted_token) return bad('Connecte un compte Instagram professionnel avant de programmer');
      if (!account.permissions?.includes('instagram_business_content_publish')) return bad('Permission de publication non accordée : reconnecte Instagram');
      if (!account.token_expires_at || Date.parse(account.token_expires_at) < at.getTime() && Date.parse(account.token_expires_at) < Date.now() + 864e5) return bad('Token Instagram bientôt expiré : reconnecte le compte');
      const { data: post } = await admin.from('social_posts').select('id,media_id,media_ids,caption').eq('user_id', uid).eq('creator_id', creator).eq('id', b.post_id).eq('state', 'draft').maybeSingle(); if (!post) return bad('Brouillon introuvable');
      if ((post.media_ids || []).length > 1) return bad('Carrousel : utilise Buffer, pas le planificateur Meta');
      const { data: m } = await admin.from('social_media').select('mime_type,state,bytes,width,height').eq('user_id', uid).eq('creator_id', creator).eq('id', post.media_id).maybeSingle();
      if (m?.state !== 'ready') return bad('Média indisponible');
      const problem = instagramImageProblem(m); if (problem) return bad(problem);
      const { data: twins } = await admin.from('social_posts').select('id,state').eq('user_id', uid).eq('creator_id', creator).eq('media_id', post.media_id).neq('id', post.id).in('state', ['scheduled', 'processing', 'unknown', 'published']);
      if (twins?.some((t) => t.state !== 'published')) return bad('Cette photo est déjà programmée ou en cours de publication');
      if (twins?.some((t) => t.state === 'published') && b.allow_repost !== true) return result({ needs_repost_confirmation: true, error: 'Cette photo a déjà été publiée. Confirme pour la republier.' }, 409);
      const { data: done, error } = await admin.from('social_posts').update({ state: 'scheduled', account_id: account.id, scheduled_at: at.toISOString(), approved_at: nowIso(), updated_at: nowIso(), attempts: 0, last_error: null, next_check_at: null, lease_until: null, container_checks: 0, reconcile_checks: 0, external_container_id: null, publish_attempted_at: null })
        .eq('id', b.post_id).eq('user_id', uid).eq('creator_id', creator).eq('state', 'draft').select(POST_FIELDS).maybeSingle();
      if (error) throw error; if (!done) return bad('Brouillon déjà modifié ailleurs');
      await event(uid, post.id, 'scheduled', at.toISOString());
      const { data: sched } = await admin.rpc('social_scheduler_status');
      return result({ post: done, scheduler_active: !!sched?.active });
    }
    if (action === 'unschedule_post') {
      if (!isId(b.post_id)) return bad('ID invalide');
      const { data, error } = await admin.from('social_posts').update({ state: 'draft', scheduled_at: null, approved_at: null, updated_at: nowIso() }).eq('id', b.post_id).eq('user_id', uid).eq('creator_id', creator).eq('state', 'scheduled').select(POST_FIELDS).maybeSingle();
      if (error) throw error; if (!data) return bad('Publication déjà en cours : impossible de la retirer'); await event(uid, data.id, 'unscheduled'); return result({ post: data });
    }
    if (action === 'cancel_post') {
      if (!isId(b.post_id)) return bad('ID invalide');
      const { data: post, error } = await admin.from('social_posts').update({ state: 'cancelled', updated_at: nowIso() }).eq('id', b.post_id).eq('user_id', uid).eq('creator_id', creator).in('state', ['draft', 'scheduled']).select('id').maybeSingle();
      if (error) throw error; if (!post) return bad('Publication déjà en cours ou introuvable'); await event(uid, post.id, 'cancelled'); return result({ ok: true });
    }
    if (action === 'duplicate_post') {
      if (!isId(b.post_id)) return bad('ID invalide');
      const { data: p } = await admin.from('social_posts').select('media_id,media_ids,caption,caption_style,state').eq('id', b.post_id).eq('user_id', uid).eq('creator_id', creator).in('state', ['failed', 'cancelled', 'published']).maybeSingle();
      if (!p) return bad('Seules les publications terminées peuvent être dupliquées');
      const { data, error } = await admin.from('social_posts').insert({ user_id: uid, creator_id: creator, media_id: p.media_id, media_ids: p.media_ids?.length ? p.media_ids : [p.media_id], caption: p.caption, caption_style: p.caption_style, state: 'draft' }).select(POST_FIELDS).single(); if (error) throw error;
      await event(uid, data.id, 'draft_created', 'copie de ' + b.post_id); return result({ post: data });
    }
    if (action === 'recheck_post') {
      if (!isId(b.post_id)) return bad('ID invalide');
      const { data, error } = await admin.from('social_posts').update({ next_check_at: nowIso(), reconcile_checks: 6, lease_until: null, updated_at: nowIso() }).eq('id', b.post_id).eq('user_id', uid).eq('creator_id', creator).eq('state', 'unknown').not('external_container_id', 'is', null).select('id').maybeSingle();
      if (error) throw error; if (!data) return bad('Vérification automatique impossible pour cette publication'); return result({ ok: true });
    }
    if (action === 'resolve_unknown') {
      if (!isId(b.post_id) || b.outcome !== 'not_published') return bad('Requête invalide');
      const { data, error } = await admin.from('social_posts').update({ state: 'failed', last_error: 'Non publiée (vérifié manuellement sur Instagram)', next_check_at: null, lease_until: null, updated_at: nowIso() }).eq('id', b.post_id).eq('user_id', uid).eq('creator_id', creator).eq('state', 'unknown').select('id').maybeSingle();
      if (error) throw error; if (!data) return bad('Publication introuvable'); await event(uid, data.id, 'failed', 'Résolu manuellement : non publiée'); return result({ ok: true });
    }
    if (action === 'post_events') {
      if (!isId(b.post_id)) return bad('ID invalide');
      const { data: p } = await admin.from('social_posts').select('id').eq('id', b.post_id).eq('user_id', uid).eq('creator_id', creator).maybeSingle(); if (!p) return bad('Publication introuvable', 404);
      const { data, error } = await admin.from('social_job_events').select('event,detail,created_at').eq('post_id', p.id).eq('user_id', uid).order('created_at', { ascending: false }).limit(50); if (error) throw error;
      return result({ events: data });
    }
    if (action === 'oauth_start') {
      if (!metaConfigured()) return bad('Configure INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET et SOCIAL_TOKEN_KEY dans les secrets Supabase.', 503);
      if (!(await rateOk(uid, 'oauth_start', 10, 3600))) return bad('Trop de tentatives de connexion, réessaie dans une heure', 429);
      const { data: record, error } = await admin.from('social_oauth_states').insert({ user_id: uid, creator_id: creator }).select('state').single(); if (error) throw error;
      const u = new URL(IG_AUTHORIZE);
      u.search = new URLSearchParams({ client_id: env('INSTAGRAM_APP_ID'), redirect_uri: REDIRECT, response_type: 'code', scope: REQUIRED_SCOPES.join(','), state: record.state }).toString();
      return result({ url: u.toString() });
    }
    if (action === 'disconnect') {
      if (!isId(b.account_id)) return bad('Compte invalide');
      const { data: row } = await admin.from('social_accounts').select('id').eq('id', b.account_id).eq('user_id', uid).eq('creator_id', creator).maybeSingle(); if (!row) return bad('Compte introuvable', 404);
      const { data: pending } = await admin.from('social_posts').update({ state: 'draft', scheduled_at: null, approved_at: null, updated_at: nowIso() }).eq('user_id', uid).eq('account_id', row.id).eq('state', 'scheduled').select('id');
      const { error } = await admin.from('social_accounts').update({ state: 'disconnected', encrypted_token: null, token_expires_at: null, permissions: [], last_error: null, updated_at: nowIso() }).eq('id', row.id).eq('user_id', uid); if (error) throw error;
      return result({ ok: true, unscheduled: pending?.length ?? 0 });
    }
    if (action === 'generate_captions') {
      const description = safeText(b.description, 500), styleKey = String(b.style || '');
      if (description.length < 3 || !Object.hasOwn(CAPTION_STYLES, styleKey)) return bad('Décris la photo et choisis un style');
      const apiKey = env('NOTRACK_API_KEY'); if (!apiKey) return bad('Génération IA non configurée', 503);
      if (!(await rateOk(uid, 'captions', 60, 3600))) return bad('Limite de 60 générations par heure atteinte', 429);
      const c = await creatorFor(uid, creator);
      const system = [
        'Tu es rédacteur social media francophone. Tu écris des légendes Instagram pour ' + (c?.name || 'une créatrice') + ', une créatrice de contenu VIRTUELLE (personnage généré par IA).',
        c?.description ? 'Contexte du personnage (fourni par son équipe) : ' + safeText(c.description, 600) : '',
        'Ton : ' + CAPTION_STYLES[styleKey] + '.',
        'Règles strictes : contenu mode, lifestyle ou portrait, jamais sexuel ni explicite ; aucune information personnelle inventée (âge, ville, marques, relations, événements) ; ne prétends jamais être une personne réelle ; pas de promesse trompeuse ; pas d’emoji en excès (3 maximum) ; pas de répétition de mots entre variantes.',
        'Produis trois variantes VRAIMENT différentes : 1) courte et percutante (moins de 120 caractères), 2) moyenne avec une petite mise en situation, 3) plus personnelle et conversationnelle.',
        b.include_question === false ? 'N’ajoute pas de question.' : 'Pour chaque variante, propose une question courte qui invite aux commentaires.',
        'Pour chaque variante, 5 à 10 hashtags pertinents en français ou anglais, sans espaces, dont au moins un parmi #CréatriceVirtuelle ou #IA.',
        'Réponds UNIQUEMENT avec ce JSON : {"variants":[{"text":"...","question":"...","hashtags":["#...","#..."]}]}',
      ].filter(Boolean).join('\n');
      const response = await fetch('https://api.notrack.ai/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'notrack-uncensored', stream: false, max_tokens: 900, temperature: b.regenerate ? 0.95 : 0.75, messages: [{ role: 'system', content: system }, { role: 'user', content: 'Description de la photo : ' + description }] }), signal: AbortSignal.timeout(30000) });
      if (!response.ok) return bad(response.status === 429 ? 'NoTrack occupé, réessaie dans une minute' : 'NoTrack indisponible (' + response.status + ')', 503);
      const responseData = await response.json().catch(() => null);
      let variants;
      try { variants = parseCaptionVariants(String(responseData?.choices?.[0]?.message?.content || '')); } catch { return bad('Réponse IA inexploitable, régénère', 502); }
      if (!variants.length) return bad('Réponse IA vide, régénère', 502);
      return result({ variants, style: styleKey });
    }
    return bad('Action inconnue', 404);
  } catch (e) { console.error('social api', action, errMessage(e)); return bad('Erreur interne du module social (' + action + '). Consulte les journaux Supabase.', 500); }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const input = new URL(req.url);
  if (req.method === 'GET') return oauthCallback(input);
  if (req.method === 'POST') {
    const meta = input.searchParams.get('meta');
    if (meta === 'deauthorize' || meta === 'data_deletion') return metaCallback(req, meta);
    return postHandler(req);
  }
  return bad('Méthode non autorisée', 405);
});
