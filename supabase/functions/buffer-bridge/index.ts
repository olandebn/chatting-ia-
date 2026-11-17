// Relais IA — Buffer Bridge V1 (personal Buffer API key, Instagram image posts only).
// Independent from social-api/social-worker, Telegram and NoTrack.
// Deployment: --no-verify-jwt because signed GET/HEAD image URLs are consumed by Buffer;
// all POST actions validate Supabase user JWT AND profiles.is_admin server-side.
import { createClient } from 'npm:@supabase/supabase-js@2.57.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const BUFFER_KEY = Deno.env.get('BUFFER_API_KEY') || '';
const MEDIA_KEY = Deno.env.get('BUFFER_MEDIA_SIGNING_KEY') || '';
const BUCKET = 'relais-social-private';
const FRONTEND_ORIGIN = 'https://olandebn.github.io';
const BRIDGE_URL = `${SUPABASE_URL}/functions/v1/buffer-bridge`;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_AHEAD_MS = 14 * 24 * 3600 * 1000;
const mediaExpirationMs = (due: Date) => due.getTime() + 3 * 24 * 3600 * 1000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

function cors(req: Request): Record<string, string> {
  const h: Record<string, string> = { 'Vary': 'Origin' };
  if ((req.headers.get('origin') || '') === FRONTEND_ORIGIN) {
    h['Access-Control-Allow-Origin'] = FRONTEND_ORIGIN;
    h['Access-Control-Allow-Methods'] = 'POST,GET,HEAD,OPTIONS';
    h['Access-Control-Allow-Headers'] = 'authorization,apikey,content-type,x-client-info,x-supabase-client-platform,x-supabase-client-platform-version,x-supabase-client-runtime,x-supabase-client-runtime-version';
  }
  return h;
}
function json(req: Request, value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors(req) } });
}
function fail(req: Request, message: string, status = 400) { return json(req, { error: message }, status); }
function safeMessage(e: unknown) { return e instanceof Error ? e.message.slice(0, 260) : 'Erreur de connexion à Buffer'; }
function isUuid(x: unknown): x is string { return typeof x === 'string' && UUID.test(x); }
function enc(s: string) { return new TextEncoder().encode(s); }
function hex(bytes: Uint8Array) { return [...bytes].map((n) => n.toString(16).padStart(2, '0')).join(''); }
function fromHex(s: string) { if (!/^[a-f0-9]{64}$/i.test(s)) return null; return new Uint8Array(s.match(/../g)!.map((p) => parseInt(p, 16))); }
let importedKey: Promise<CryptoKey> | undefined;
function hmacKey() {
  if (!MEDIA_KEY) throw Error('BUFFER_MEDIA_SIGNING_KEY manquant');
  return importedKey ||= crypto.subtle.importKey('raw', enc(MEDIA_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function sign(s: string) { return hex(new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(), enc(s)))); }
async function validSignature(s: string, signature: string) {
  const sig = fromHex(signature);
  return !!sig && await crypto.subtle.verify('HMAC', await hmacKey(), sig, enc(s));
}
async function bufferQuery(query: string) {
  if (!BUFFER_KEY) throw Error('Clé Buffer non configurée');
  const res = await fetch('https://api.buffer.com', {
    method: 'POST', headers: { Authorization: 'Bearer ' + BUFFER_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }), signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw Error(res.status === 401 ? 'Clé Buffer invalide (401)' : `Buffer HTTP ${res.status}`);
  const body = await res.json();
  if (body.errors?.length) throw Error(String(body.errors[0]?.message || 'Erreur GraphQL Buffer').slice(0, 260));
  return body.data || {};
}
async function listChannels() {
  const r = await bufferQuery('query RelaisOrganizations { account { organizations { id name } } }');
  const orgs = Array.isArray(r.account?.organizations) ? r.account.organizations.slice(0, 30) : [];
  const channels: Array<{ id: string, name: string, service: string, organization_id: string, organization_name: string }> = [];
  for (const o of orgs) {
    if (typeof o.id !== 'string') continue;
    const q = `query RelaisChannels { channels(input: { organizationId: ${JSON.stringify(o.id)} }) { id name service } }`;
    const cs = (await bufferQuery(q)).channels;
    for (const c of Array.isArray(cs) ? cs : []) {
      if (String(c.service).toLowerCase() === 'instagram') channels.push({
        id: String(c.id), name: String(c.name || 'Instagram'), service: 'instagram',
        organization_id: o.id, organization_name: String(o.name || ''),
      });
    }
  }
  return channels;
}
async function mediaAccessLink(jobId: string, expires: number) {
  const tag = await sign(`${jobId}:${expires}`);
  return `${BRIDGE_URL}?media=${encodeURIComponent(jobId)}&expires=${expires}&signature=${tag}`;
}

async function serveMedia(req: Request, url: URL) {
  if (!MEDIA_KEY || !SERVICE) return fail(req, 'Stockage non configuré', 503);
  const id = url.searchParams.get('media'), expiresStr = url.searchParams.get('expires') || '', signature = url.searchParams.get('signature') || '';
  const expires = Number(expiresStr), now = Math.floor(Date.now() / 1000);
  if (!isUuid(id) || !/^\d{10}$/.test(expiresStr) || !Number.isSafeInteger(expires) || expires < now || expires > now + 18 * 24 * 3600 || !(await validSignature(`${id}:${expires}`, signature))) {
    return fail(req, 'Lien invalide ou expiré', 403);
  }
  const { data: job, error } = await admin.from('social_buffer_jobs').select('user_id,creator_id,media_id,status,url_expires_at').eq('id', id).maybeSingle();
  if (error || !job || !['pending', 'queued', 'uncertain'].includes(job.status)) return fail(req, 'Publication indisponible', 404);
  if (Date.parse(job.url_expires_at) < Date.now() || Math.floor(Date.parse(job.url_expires_at) / 1000) !== expires) return fail(req, 'Lien expiré', 403);
  const { data: media } = await admin.from('social_media').select('storage_path,mime_type,bytes,state').eq('id', job.media_id).eq('user_id', job.user_id).eq('creator_id', job.creator_id).maybeSingle();
  if (!media || !['ready', 'archived'].includes(media.state) || media.mime_type !== 'image/jpeg' || media.bytes > MAX_IMAGE_BYTES) return fail(req, 'Photo non disponible', 404);
  const headers = { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' };
  if (req.method === 'HEAD') return new Response(null, { status: 200, headers });
  const { data, error: blobError } = await admin.storage.from(BUCKET).download(media.storage_path);
  if (blobError || !data) return fail(req, 'Impossible de lire cette photo', 404);
  return new Response(data, { status: 200, headers });
}

async function post(req: Request) {
  if (!SERVICE || !SUPABASE_URL) return fail(req, 'Supabase non configuré', 503);
  const header = req.headers.get('authorization') || '';
  const token = /^Bearer\s+(.+)$/i.exec(header)?.[1] || '';
  if (!token) return fail(req, 'Authentification requise', 401);
  const { data: userInfo, error: authError } = await admin.auth.getUser(token);
  const userId = userInfo.user?.id;
  if (authError || !userId) return fail(req, 'Session expirée', 401);
  // Global Buffer API key is account-wide. Never let arbitrary Relais IA users publish to its channels.
  const { data: profile } = await admin.from('profiles').select('is_admin').eq('id', userId).maybeSingle();
  if (!profile?.is_admin) return fail(req, 'Réservé à l’administrateur RelaisIA', 403);
  let b: Record<string, unknown>;
  try { b = await req.json(); if (!b || typeof b !== 'object' || Array.isArray(b)) throw Error('JSON invalide'); } catch { return fail(req, 'JSON invalide'); }
  const action = b.action;
  if (action !== 'status' && action !== 'schedule') return fail(req, 'Action inconnue');
  const creatorId = b.creator_id;
  if (!isUuid(creatorId)) return fail(req, 'Créateur invalide');
  const { data: creator } = await admin.from('social_creators').select('id').eq('id', creatorId).eq('user_id', userId).maybeSingle();
  if (!creator) return fail(req, 'Créateur introuvable', 404);
  const { data: jobs, error: jobError } = await admin.from('social_buffer_jobs')
    .select('id,source_post_id,buffer_post_id,channel_id,caption,due_at,status,last_error,created_at')
    .eq('user_id', userId).eq('creator_id', creatorId).order('created_at', { ascending: false }).limit(75);
  if (jobError) return fail(req, 'Table Buffer absente : exécute setup/BUFFER_SCHEMA.sql', 503);
  if (action === 'status') {
    if (!BUFFER_KEY || !MEDIA_KEY) return json(req, { configured: false, channels: [], jobs });
    try { return json(req, { configured: true, channels: await listChannels(), jobs }); }
    catch (e) { return json(req, { configured: false, channels: [], jobs, error: safeMessage(e) }); }
  }
  if (!BUFFER_KEY || !MEDIA_KEY) return fail(req, 'Configure BUFFER_API_KEY et BUFFER_MEDIA_SIGNING_KEY dans Supabase', 503);
  if (b.confirm !== true) return fail(req, 'Confirme explicitement la programmation');
  if (!isUuid(b.post_id) || typeof b.channel_id !== 'string' || b.channel_id.length > 160 || typeof b.due_at !== 'string') return fail(req, 'Champs invalides');
  const due = new Date(b.due_at);
  if (!Number.isFinite(due.getTime()) || due.getTime() < Date.now() + 10 * 60_000 || due.getTime() > Date.now() + MAX_AHEAD_MS) return fail(req, 'Choisis une date entre 10 minutes et 14 jours');
  const { data: p } = await admin.from('social_posts').select('id,media_id,caption,state,account_id').eq('id', b.post_id).eq('user_id', userId).eq('creator_id', creatorId).maybeSingle();
  if (!p || p.state !== 'draft' || p.account_id) return fail(req, 'Sélectionne un brouillon disponible, non planifié sur Meta');
  const { data: media } = await admin.from('social_media').select('id,mime_type,bytes,width,height,state,is_synthetic').eq('id', p.media_id).eq('user_id', userId).eq('creator_id', creatorId).maybeSingle();
  const ratio = media?.width && media?.height ? media.width / media.height : 0;
  if (!media || media.state !== 'ready' || media.mime_type !== 'image/jpeg' || media.bytes > MAX_IMAGE_BYTES || !media.width || ratio < 0.8 || ratio > 1.91) return fail(req, 'Photo incompatible : JPEG ≤8 Mo et ratio 4:5 à 1,91:1');
  if (typeof p.caption !== 'string' || !p.caption.trim() || p.caption.length > 2200) return fail(req, 'Légende invalide');
  const channels = await listChannels();
  const channel = channels.find((x) => x.id === b.channel_id);
  if (!channel) return fail(req, 'Compte Instagram absent ou non connecté à Buffer', 404);
  const cap = media.is_synthetic && !/#(?:CréatriceVirtuelle|IA)\b/i.test(p.caption) ? p.caption.trim() + '\n\n#CréatriceVirtuelle' : p.caption;
  const expires = Math.floor(mediaExpirationMs(due) / 1000);
  const { data: job, error: insertError } = await admin.from('social_buffer_jobs').insert({
    user_id: userId, creator_id: creatorId, source_post_id: p.id, media_id: p.media_id,
    channel_id: channel.id, organization_id: channel.organization_id, caption: cap,
    due_at: due.toISOString(), url_expires_at: new Date(expires * 1000).toISOString(), status: 'pending',
  }).select('id').single();
  if (insertError || !job) return fail(req, insertError?.code === '23505' ? 'Ce brouillon a déjà été envoyé à Buffer (risque de doublon)' : 'Impossible de réserver la publication', 409);
  const url = await mediaAccessLink(job.id, expires);
  const gql = `mutation RelaisCreateImagePost {
    createPost(input: {
      text: ${JSON.stringify(cap)}
      channelId: ${JSON.stringify(channel.id)}
      schedulingType: automatic
      mode: customScheduled
      dueAt: ${JSON.stringify(due.toISOString())}
      assets: [{ image: { url: ${JSON.stringify(url)} } }]
      metadata: { instagram: { type: post, shouldShareToFeed: true } }
    }) {
      ... on PostActionSuccess { post { id dueAt } }
      ... on MutationError { message }
    }
  }`;
  try {
    const res = await bufferQuery(gql);
    const outcome = res.createPost;
    if (outcome?.post?.id) {
      const { error: upErr } = await admin.from('social_buffer_jobs').update({ status: 'queued', buffer_post_id: String(outcome.post.id), updated_at: new Date().toISOString() }).eq('id', job.id);
      // Remove this draft from the parallel Meta publishing path after the Buffer scheduling succeeds.
      const { error: postErr } = await admin.from('social_posts').update({ state: 'cancelled', updated_at: new Date().toISOString() }).eq('id', p.id).eq('state', 'draft').eq('user_id', userId);
      return json(req, { queued: true, id: job.id, buffer_post_id: String(outcome.post.id), due_at: outcome.post.dueAt || due.toISOString(), warning: upErr || postErr ? 'Buffer a confirmé la programmation, mais la synchronisation RelaisIA nécessite vérification.' : undefined });
    }
    const message = String(outcome?.message || 'Publication refusée par Buffer').slice(0, 260);
    await admin.from('social_buffer_jobs').update({ status: 'failed', last_error: message, updated_at: new Date().toISOString() }).eq('id', job.id);
    return fail(req, `${message}. Ce brouillon est bloqué contre les doublons ; duplique-le après vérification.`, 422);
  } catch (e) {
    // Network/timeout: the post MAY have been created, so never retry automatically.
    const message = safeMessage(e);
    await admin.from('social_buffer_jobs').update({ status: 'uncertain', last_error: message, updated_at: new Date().toISOString() }).eq('id', job.id);
    return fail(req, `Réponse Buffer incertaine (${message}). Vérifie Buffer avant toute nouvelle tentative.`, 502);
  }
}
Deno.serve(async (req: Request) => {
  try {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
    if (req.method === 'GET' || req.method === 'HEAD') return await serveMedia(req, new URL(req.url));
    if (req.method === 'POST') return await post(req);
    return fail(req, 'Méthode refusée', 405);
  } catch (e) { console.error('buffer-bridge', safeMessage(e)); return fail(req, safeMessage(e), 500); }
});
