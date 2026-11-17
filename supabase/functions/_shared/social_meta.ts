// Relais IA — shared helpers for social-api and social-worker (Instagram API with Instagram Login).
// Pure functions + a tiny Graph client with injectable fetch so everything can be tested with mocks.

export const GRAPH_VERSION = 'v27.0';
export const GRAPH_HOST = 'https://graph.instagram.com';
export const IG_AUTHORIZE = 'https://www.instagram.com/oauth/authorize';
export const IG_TOKEN = 'https://api.instagram.com/oauth/access_token';
export const REQUIRED_SCOPES = ['instagram_business_basic', 'instagram_business_content_publish'] as const;
export const IG_MAX_JPEG_BYTES = 8 * 1024 * 1024;
export const IG_MIN_RATIO = 4 / 5;
export const IG_MAX_RATIO = 1.91;
export const IG_MIN_WIDTH = 320;

export type Fetch = typeof fetch;

// ---------- Token encryption (AES-256-GCM, key = SOCIAL_TOKEN_KEY, 32 bytes base64) ----------
async function aesKey(b64: string | undefined) {
  if (!b64) throw Error('SOCIAL_TOKEN_KEY non configuré');
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  if (raw.length !== 32) throw Error('SOCIAL_TOKEN_KEY doit contenir 32 octets en base64');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function encryptToken(value: string, keyB64: string | undefined) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(keyB64), new TextEncoder().encode(value)));
  const out = new Uint8Array(iv.length + ct.length); out.set(iv); out.set(ct, iv.length);
  let s = ''; for (const b of out) s += String.fromCharCode(b);
  return btoa(s);
}
export async function decryptToken(value: string, keyB64: string | undefined) {
  const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, await aesKey(keyB64), bytes.slice(12));
  return new TextDecoder().decode(plain);
}

// ---------- Meta responses ----------
/** Meta sometimes wraps responses in {data:[{...}]}; accept both shapes. */
export function unwrap(json: any): any {
  if (json && typeof json === 'object' && !('access_token' in json) && !('user_id' in json) && !('id' in json)
      && Array.isArray(json.data) && json.data.length === 1 && json.data[0] && typeof json.data[0] === 'object') return json.data[0];
  return json;
}
export function parsePermissions(p: unknown): string[] {
  const list = Array.isArray(p) ? p : typeof p === 'string' ? p.split(/[,\s]+/) : [];
  return [...new Set(list.map((x) => String(x).trim()).filter((x) => /^[a-z_]{3,80}$/.test(x)))];
}
export function parseShortToken(json: any): { access_token: string; user_id: string; permissions: string[] } | null {
  const j = unwrap(json);
  if (!j || typeof j.access_token !== 'string' || !j.access_token) return null;
  return { access_token: j.access_token, user_id: j.user_id != null ? String(j.user_id) : '', permissions: parsePermissions(j.permissions) };
}
export function parseLongToken(json: any): { access_token: string; expires_in: number } | null {
  const j = unwrap(json);
  if (!j || typeof j.access_token !== 'string' || !j.access_token) return null;
  const e = Number(j.expires_in);
  return { access_token: j.access_token, expires_in: Number.isFinite(e) && e > 0 ? Math.min(e, 5184000) : 5184000 };
}
export function parseProfile(json: any) {
  const j = unwrap(json);
  const igId = j?.user_id != null ? String(j.user_id) : '';
  if (!/^\d{3,30}$/.test(igId)) return null;
  return {
    ig_user_id: igId,
    app_scoped_id: j.id != null ? String(j.id) : null,
    username: typeof j.username === 'string' ? j.username.slice(0, 60) : '',
    account_type: typeof j.account_type === 'string' ? j.account_type.slice(0, 30) : null,
    profile_picture_url: typeof j.profile_picture_url === 'string' && j.profile_picture_url.startsWith('https://') ? j.profile_picture_url.slice(0, 1000) : null,
  };
}

/** Error classification. `definite` = Meta answered with a structured error (request rejected). */
export class MetaError extends Error {
  constructor(message: string, public status: number, public code: number | null, public subcode: number | null, public definite: boolean) { super(message); }
  get isAuth() { return this.code === 190 || this.status === 401; }
  get isPermission() { return this.code === 10 || this.code === 200 || (this.code !== null && this.code >= 200 && this.code < 300); }
  get isRateLimit() { return [4, 17, 32, 613, 9].includes(this.code ?? -1) || this.status === 429; }
  get isTransient() { return !this.definite || this.isRateLimit || this.code === 2 || this.code === 1 || this.status >= 500 || this.subcode === 2207001 || this.code === 9007; }
}
const safeMsg = (s: unknown) => String(s ?? '').replace(/access_token=[^&\s]+/g, 'access_token=***').replace(/EA[A-Za-z0-9]{20,}|IG[A-Za-z0-9]{20,}/g, '***').slice(0, 180);

export function graphClient(fetchImpl: Fetch, token: string, timeoutMs = 20000) {
  async function call(method: 'GET' | 'POST', path: string, params: Record<string, string> = {}) {
    const url = new URL(`${GRAPH_HOST}/${GRAPH_VERSION}/${path}`);
    let init: RequestInit;
    if (method === 'GET') { url.search = new URLSearchParams({ ...params, access_token: token }).toString(); init = { method }; }
    else init = { method, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...params, access_token: token }) };
    let res: Response;
    try { res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }); }
    catch (e) { throw new MetaError('Réseau Meta injoignable : ' + safeMsg(e instanceof Error ? e.message : e), 0, null, null, false); }
    const text = await res.text();
    let json: any = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (!res.ok || json?.error) {
      const err = json?.error;
      const definite = !!err && typeof err === 'object' && res.status >= 400 && res.status < 500;
      throw new MetaError(`Meta ${res.status}${err?.code ? ' #' + err.code : ''} : ${safeMsg(err?.error_user_msg || err?.message || 'réponse invalide')}`, res.status, err?.code ?? null, err?.error_subcode ?? null, definite);
    }
    if (json === null) throw new MetaError('Réponse Meta illisible', res.status, null, null, false);
    return json;
  }
  return {
    me: () => call('GET', 'me', { fields: 'user_id,username,account_type,profile_picture_url' }),
    createImageContainer: (igId: string, imageUrl: string, caption: string) => call('POST', `${encodeURIComponent(igId)}/media`, { image_url: imageUrl, caption }),
    containerStatus: (containerId: string) => call('GET', encodeURIComponent(containerId), { fields: 'status_code,status' }),
    publish: (igId: string, containerId: string) => call('POST', `${encodeURIComponent(igId)}/media_publish`, { creation_id: containerId }),
    media: (mediaId: string) => call('GET', encodeURIComponent(mediaId), { fields: 'id,permalink,timestamp,caption' }),
    recentMedia: (igId: string) => call('GET', `${encodeURIComponent(igId)}/media`, { fields: 'id,caption,permalink,timestamp', limit: '25' }),
    publishingLimit: (igId: string) => call('GET', `${encodeURIComponent(igId)}/content_publishing_limit`, { fields: 'quota_usage,config' }),
  };
}
export type GraphClient = ReturnType<typeof graphClient>;

export async function refreshLongToken(fetchImpl: Fetch, token: string) {
  const u = new URL(`${GRAPH_HOST}/refresh_access_token`);
  u.search = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: token }).toString();
  let res: Response;
  try { res = await fetchImpl(u, { signal: AbortSignal.timeout(20000) }); }
  catch (e) { throw new MetaError('Réseau Meta injoignable', 0, null, null, false); }
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.error) throw new MetaError(`Renouvellement refusé : ${safeMsg(json?.error?.message || res.status)}`, res.status, json?.error?.code ?? null, null, !!json?.error);
  const parsed = parseLongToken(json);
  if (!parsed) throw new MetaError('Renouvellement : réponse invalide', res.status, null, null, false);
  return parsed;
}

// ---------- Images ----------
export function sniffMime(v: Uint8Array): string | null {
  if (v[0] === 0xff && v[1] === 0xd8 && v[2] === 0xff) return 'image/jpeg';
  if (v.length > 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => v[i] === b)) return 'image/png';
  if (v.length > 12 && String.fromCharCode(...v.slice(0, 4)) === 'RIFF' && String.fromCharCode(...v.slice(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}
/** Reads width/height from JPEG SOFn, PNG IHDR or WebP VP8/VP8L/VP8X headers. */
export function imageSize(v: Uint8Array): { width: number; height: number } | null {
  const mime = sniffMime(v);
  if (mime === 'image/png' && v.length >= 24) return { width: (v[16] << 24 | v[17] << 16 | v[18] << 8 | v[19]) >>> 0, height: (v[20] << 24 | v[21] << 16 | v[22] << 8 | v[23]) >>> 0 };
  if (mime === 'image/webp' && v.length >= 30) {
    const chunk = String.fromCharCode(...v.slice(12, 16));
    if (chunk === 'VP8X') return { width: 1 + (v[24] | v[25] << 8 | v[26] << 16), height: 1 + (v[27] | v[28] << 8 | v[29] << 16) };
    if (chunk === 'VP8L') { const b = v.slice(21, 25); return { width: 1 + (((b[1] & 0x3f) << 8) | b[0]), height: 1 + (((b[3] & 0xf) << 10) | (b[2] << 2) | ((b[1] & 0xc0) >> 6)) }; }
    if (chunk === 'VP8 ') return { width: (v[26] | v[27] << 8) & 0x3fff, height: (v[28] | v[29] << 8) & 0x3fff };
    return null;
  }
  if (mime === 'image/jpeg') {
    let i = 2;
    while (i + 9 < v.length) {
      if (v[i] !== 0xff) { i++; continue; }
      const marker = v[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = v[i + 2] << 8 | v[i + 3];
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) return { height: v[i + 5] << 8 | v[i + 6], width: v[i + 7] << 8 | v[i + 8] };
      if (len < 2) return null;
      i += 2 + len;
    }
  }
  return null;
}
/** Returns a French reason if the media cannot be published as an Instagram image post, else null. */
export function instagramImageProblem(m: { mime_type: string; bytes: number; width?: number | null; height?: number | null }): string | null {
  if (m.mime_type !== 'image/jpeg') return 'Instagram n’accepte que le JPEG pour les photos.';
  if (Number(m.bytes) > IG_MAX_JPEG_BYTES) return 'Image trop lourde pour Instagram (8 Mo maximum).';
  if (!m.width || !m.height) return 'Dimensions de l’image inconnues.';
  if (m.width < IG_MIN_WIDTH) return 'Image trop petite (320 px de large minimum).';
  const r = m.width / m.height;
  if (r < IG_MIN_RATIO - 0.005 || r > IG_MAX_RATIO + 0.005) return `Format ${m.width}×${m.height} refusé par Instagram (ratio entre 4:5 et 1,91:1).`;
  return null;
}

// ---------- Captions ----------
export const CAPTION_STYLES: Record<string, string> = {
  naturel: 'naturel, spontané, chaleureux',
  elegant: 'élégant, raffiné, phrases courtes et soignées',
  lifestyle: 'lifestyle, quotidien, inspirant et concret',
  glamour: 'glamour, assuré, brillant sans excès',
  humoristique: 'humoristique, léger, autodérision bienveillante',
  mysterieux: 'mystérieux, évocateur, laisse planer une question',
  seduisant: 'séduisant mais strictement non explicite, suggestion élégante, aucune allusion sexuelle',
};
export const TRANSPARENCY_RE = /(cr[eé]atrice\s+virtuelle|g[eé]n[eé]r[eé]e?\s+par\s+(l['’])?ia|#cr[eé]atricevirtuelle|#ia\b|#aiart|#virtualinfluencer|#influenceusevirtuelle)/i;
export function withTransparency(caption: string, synthetic: boolean) {
  const c = caption.trim().slice(0, 2200);
  if (!synthetic || TRANSPARENCY_RE.test(c)) return c;
  return (c.slice(0, 2165) + '\n\n#CréatriceVirtuelle').trim();
}
export function cleanHashtags(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const tag = '#' + raw.trim().replace(/^#+/, '').replace(/\s+/g, '');
    if (!/^#[\p{L}\p{N}_]{2,40}$/u.test(tag)) continue;
    if (!out.some((t) => t.toLowerCase() === tag.toLowerCase())) out.push(tag);
    if (out.length >= 12) break;
  }
  return out;
}
export function parseCaptionVariants(raw: string) {
  let text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  const parsed = JSON.parse(text);
  const arr = Array.isArray(parsed?.variants) ? parsed.variants : [];
  const variants = arr.map((v: any) => typeof v === 'string' ? { text: v, hashtags: [], question: '' } : { text: String(v?.text ?? v?.caption ?? ''), hashtags: cleanHashtags(v?.hashtags), question: String(v?.question ?? '') })
    .map((v: any) => ({ text: v.text.replace(/\s+\n/g, '\n').trim().slice(0, 600), hashtags: v.hashtags, question: v.question.trim().slice(0, 160) }))
    .filter((v: any) => v.text.length >= 5);
  // Drop near-duplicates
  const seen = new Set<string>();
  return variants.filter((v: any) => { const k = v.text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '').slice(0, 60); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 3);
}

// ---------- Meta signed_request (deauthorize / data deletion callbacks) ----------
function b64urlDecode(s: string) { const p = s.replace(/-/g, '+').replace(/_/g, '/'); return Uint8Array.from(atob(p + '='.repeat((4 - p.length % 4) % 4)), (c) => c.charCodeAt(0)); }
export async function verifySignedRequest(signed: string, secret: string): Promise<any | null> {
  const [sig, payload] = signed.split('.', 2);
  if (!sig || !payload) return null;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('HMAC', key, b64urlDecode(sig), new TextEncoder().encode(payload));
  if (!ok) return null;
  try { const data = JSON.parse(new TextDecoder().decode(b64urlDecode(payload))); return data?.algorithm?.toUpperCase() === 'HMAC-SHA256' ? data : null; } catch { return null; }
}
