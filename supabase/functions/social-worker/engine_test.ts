// Run: deno test supabase/functions/social-worker/engine_test.ts
// Uses an in-memory repo and a mocked Meta Graph API. Never contacts Meta.
import { assert, assertEquals, assertMatch } from 'jsr:@std/assert@1';
import { processPost, reconcilePost, refreshTokens, type Repo, type Row } from './engine.ts';
import { encryptToken, decryptToken, imageSize, instagramImageProblem, parseCaptionVariants, parseProfile, parseShortToken, parseLongToken, verifySignedRequest, withTransparency, cleanHashtags } from '../_shared/social_meta.ts';

const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const NOW = Date.parse('2026-12-01T12:00:00Z');

type Call = { method: string; path: string; params: Record<string, string> };
function metaMock(handlers: Record<string, (c: Call, n: number) => { status?: number; body?: unknown; throws?: boolean }>) {
  const calls: Call[] = [];
  const counts: Record<string, number> = {};
  const f = (async (input: URL | string, init?: RequestInit) => {
    const u = new URL(String(input));
    const method = init?.method || 'GET';
    const params = Object.fromEntries(method === 'GET' ? u.searchParams : new URLSearchParams(String(init?.body)));
    const path = u.pathname.replace(/^\/(v\d+\.\d+\/)?/, '');
    const call = { method, path, params }; calls.push(call);
    const key = Object.keys(handlers).find((k) => { const [m, p] = k.split(' '); return m === method && new RegExp('^' + p + '$').test(path); });
    if (!key) throw new Error('unexpected call ' + method + ' ' + path);
    counts[key] = (counts[key] ?? 0) + 1;
    const r = handlers[key](call, counts[key]);
    if (r.throws) throw new TypeError('network down');
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { f, calls, count: (m: string, p: string) => calls.filter((c) => c.method === m && c.path === p).length };
}

async function setup(over: { post?: Row; account?: Row; media?: Row } = {}) {
  const post: Row = { id: 'p1', user_id: 'u1', creator_id: 'c1', account_id: 'a1', media_id: 'm1', caption: 'Bonjour ✨ #CréatriceVirtuelle', state: 'processing', attempts: 1, container_checks: 0, reconcile_checks: 0, external_container_id: null, publish_attempted_at: null, scheduled_at: '2026-12-01T11:59:00Z', ...over.post };
  const account: Row = { id: 'a1', platform: 'instagram', state: 'connected', platform_user_id: '17841400000000001', permissions: ['instagram_business_basic', 'instagram_business_content_publish'], token_expires_at: '2027-01-15T00:00:00Z', encrypted_token: await encryptToken('IGTOKEN-TEST', KEY), ...over.account };
  const media: Row = { storage_path: 'u1/c1/m1.jpg', mime_type: 'image/jpeg', state: 'ready', bytes: 500_000, width: 1080, height: 1350, ...over.media };
  const events: { event: string; detail?: string | null }[] = [];
  const accountPatches: Row[] = [];
  const repo: Repo = {
    getAccount: async () => account, getMedia: async () => media,
    updatePost: async (_id, patch, guard) => {
      if (post.state !== guard.state) return false;
      if (guard.publishNull && post.publish_attempted_at) return false;
      Object.assign(post, patch); return true;
    },
    updateAccount: async (_id, patch) => { accountPatches.push(patch); Object.assign(account, patch); },
    event: async (_p, event, detail) => { events.push({ event, detail }); },
    signedUrl: async (path) => 'https://owbcnkcuxcgsawjqkssk.supabase.co/storage/v1/object/sign/relais-social-private/' + path + '?token=signed',
    accountsToRefresh: async () => account.state === 'connected' ? [account] : [], expireAccounts: async () => 0,
  };
  return { post, account, media, events, accountPatches, repo };
}
const deps = (repo: Repo, f: typeof fetch) => ({ repo, fetch: f, tokenKey: KEY, now: () => NOW, sleep: async () => {} });
const IG = '17841400000000001';
const quotaOk = () => ({ body: { data: [{ quota_usage: 2, config: { quota_total: 50, quota_duration: 86400 } }] } });

Deno.test('happy path: container → FINISHED → publish → confirmed with permalink', async () => {
  const s = await setup();
  const m = metaMock({
    [`GET ${IG}/content_publishing_limit`]: quotaOk,
    [`POST ${IG}/media`]: (c) => { assertEquals(c.params.access_token, 'IGTOKEN-TEST'); assertMatch(c.params.image_url, /^https:\/\/owbcnkcuxcgsawjqkssk/); return { body: { id: 'C1' } }; },
    'GET C1': () => ({ body: { status_code: 'FINISHED' } }),
    [`POST ${IG}/media_publish`]: (c) => { assertEquals(c.params.creation_id, 'C1'); return { body: { id: 'M1' } }; },
    'GET M1': () => ({ body: { id: 'M1', permalink: 'https://www.instagram.com/p/abc/' } }),
  });
  assertEquals(await processPost(s.post, deps(s.repo, m.f)), 'published');
  assertEquals(s.post.state, 'published');
  assertEquals(s.post.external_post_id, 'M1');
  assertEquals(s.post.external_permalink, 'https://www.instagram.com/p/abc/');
  assertEquals(m.count('POST', `${IG}/media_publish`), 1);
});

Deno.test('container still IN_PROGRESS → deferred, no publish call, resumes next tick without new container', async () => {
  const s = await setup();
  let ready = false;
  const m = metaMock({
    [`GET ${IG}/content_publishing_limit`]: quotaOk,
    [`POST ${IG}/media`]: () => ({ body: { id: 'C1' } }),
    'GET C1': () => ({ body: { status_code: ready ? 'FINISHED' : 'IN_PROGRESS' } }),
    [`POST ${IG}/media_publish`]: () => ({ body: { id: 'M1' } }),
    'GET M1': () => ({ body: { permalink: 'https://www.instagram.com/p/x/' } }),
  });
  assertEquals(await processPost(s.post, deps(s.repo, m.f)), 'deferred');
  assertEquals(s.post.state, 'processing');
  assertEquals(s.post.container_checks, 1);
  assertEquals(m.count('POST', `${IG}/media_publish`), 0);
  ready = true;
  assertEquals(await processPost(s.post, deps(s.repo, m.f)), 'published');
  assertEquals(m.count('POST', `${IG}/media`), 1, 'container must be reused');
});

Deno.test('network timeout on media_publish → unknown, never re-published by processPost', async () => {
  const s = await setup();
  const m = metaMock({
    [`GET ${IG}/content_publishing_limit`]: quotaOk,
    [`POST ${IG}/media`]: () => ({ body: { id: 'C1' } }),
    'GET C1': () => ({ body: { status_code: 'FINISHED' } }),
    [`POST ${IG}/media_publish`]: () => ({ throws: true }),
  });
  assertEquals(await processPost(s.post, deps(s.repo, m.f)), 'unknown');
  assertEquals(s.post.state, 'unknown');
  assert(s.post.publish_attempted_at);
  // Even if somehow re-run, the guard refuses
  s.post.state = 'processing';
  assertEquals(await processPost(s.post, deps(s.repo, m.f)), 'skipped');
  assertEquals(m.count('POST', `${IG}/media_publish`), 1);
});

Deno.test('definite transient Meta error on publish with container still FINISHED → safe retry later', async () => {
  const s = await setup();
  const m = metaMock({
    [`GET ${IG}/content_publishing_limit`]: quotaOk,
    [`POST ${IG}/media`]: () => ({ body: { id: 'C1' } }),
    'GET C1': () => ({ body: { status_code: 'FINISHED' } }),
    [`POST ${IG}/media_publish`]: () => ({ status: 400, body: { error: { message: 'Application request limit reached', code: 4 } } }),
  });
  assertEquals(await processPost(s.post, deps(s.repo, m.f)), 'deferred');
  assertEquals(s.post.state, 'processing');
  assertEquals(s.post.publish_attempted_at, null);
});

Deno.test('publish rejected but container reports PUBLISHED → unknown (no false failure)', async () => {
  const s = await setup();
  const m = metaMock({
    [`GET ${IG}/content_publishing_limit`]: quotaOk,
    [`POST ${IG}/media`]: () => ({ body: { id: 'C1' } }),
    'GET C1': (_c, n) => ({ body: { status_code: n === 1 ? 'FINISHED' : 'PUBLISHED' } }),
    [`POST ${IG}/media_publish`]: () => ({ status: 400, body: { error: { message: 'Fatal', code: 1 } } }),
  });
  assertEquals(await processPost(s.post, deps(s.repo, m.f)), 'unknown');
});

Deno.test('expired token (code 190) → account expired, post failed, no container', async () => {
  const s = await setup();
  const m = metaMock({
    [`GET ${IG}/content_publishing_limit`]: () => ({ status: 400, body: { error: { message: 'Error validating access token', code: 190 } } }),
  });
  assertEquals(await processPost(s.post, deps(s.repo, m.f)), 'failed');
  assertEquals(s.account.state, 'expired');
  assertMatch(s.post.last_error, /reconnecte/);
  assertEquals(m.count('POST', `${IG}/media`), 0);
});

Deno.test('token expired locally → failed before any Meta call', async () => {
  const s = await setup({ account: { token_expires_at: '2026-11-30T00:00:00Z' } });
  const m = metaMock({});
  assertEquals(await processPost(s.post, deps(s.repo, m.f)), 'failed');
  assertEquals(m.calls.length, 0);
  assertEquals(s.account.state, 'expired');
});

Deno.test('missing publish permission → failed before any Meta call', async () => {
  const s = await setup({ account: { permissions: ['instagram_business_basic'] } });
  const m = metaMock({});
  assertEquals(await processPost(s.post, deps(s.repo, m.f)), 'failed');
  assertMatch(s.post.last_error, /instagram_business_content_publish/);
  assertEquals(m.calls.length, 0);
});

Deno.test('Meta rejects media (aspect ratio, code 36003) → failed with message', async () => {
  const s = await setup();
  const m = metaMock({
    [`GET ${IG}/content_publishing_limit`]: quotaOk,
    [`POST ${IG}/media`]: () => ({ status: 400, body: { error: { message: 'The aspect ratio is not supported.', code: 36003, error_subcode: 2207009 } } }),
  });
  assertEquals(await processPost(s.post, deps(s.repo, m.f)), 'failed');
  assertMatch(s.post.last_error, /aspect ratio/);
});

Deno.test('container ERROR → failed, container cleared', async () => {
  const s = await setup();
  const m = metaMock({
    [`GET ${IG}/content_publishing_limit`]: quotaOk,
    [`POST ${IG}/media`]: () => ({ body: { id: 'C1' } }),
    'GET C1': () => ({ body: { status_code: 'ERROR', status: 'Error: image could not be downloaded' } }),
  });
  assertEquals(await processPost(s.post, deps(s.repo, m.f)), 'failed');
  assertEquals(s.post.external_container_id, null);
});

Deno.test('network error on container creation → deferred with backoff (container creation is safe to retry)', async () => {
  const s = await setup();
  const m = metaMock({ [`GET ${IG}/content_publishing_limit`]: quotaOk, [`POST ${IG}/media`]: () => ({ throws: true }) });
  assertEquals(await processPost(s.post, deps(s.repo, m.f)), 'deferred');
  assertEquals(s.post.attempts, 2);
  assert(Date.parse(s.post.next_check_at) > NOW);
});

Deno.test('quota reached → deferred 30 min, nothing created', async () => {
  const s = await setup();
  const m = metaMock({ [`GET ${IG}/content_publishing_limit`]: () => ({ body: { data: [{ quota_usage: 50, config: { quota_total: 50 } }] } }) });
  assertEquals(await processPost(s.post, deps(s.repo, m.f)), 'deferred');
  assertEquals(Date.parse(s.post.next_check_at), NOW + 30 * 60_000);
  assertEquals(m.count('POST', `${IG}/media`), 0);
});

Deno.test('non-JPEG or bad ratio media → failed before Meta', async () => {
  for (const media of [{ mime_type: 'image/png' }, { width: 1080, height: 1920 }, { bytes: 9 * 1024 * 1024 }]) {
    const s = await setup({ media });
    const m = metaMock({});
    assertEquals(await processPost(s.post, deps(s.repo, m.f)), 'failed');
    assertEquals(m.calls.length, 0);
  }
});

Deno.test('reconcile: post found in account media → published (confirmed)', async () => {
  const s = await setup({ post: { state: 'unknown', external_container_id: 'C1', publish_attempted_at: '2026-12-01T11:58:00Z' } });
  const m = metaMock({
    'GET C1': () => ({ body: { status_code: 'PUBLISHED' } }),
    [`GET ${IG}/media`]: () => ({ body: { data: [{ id: 'M9', caption: 'Bonjour ✨  #CréatriceVirtuelle', permalink: 'https://www.instagram.com/p/zz/', timestamp: '2026-12-01T11:58:30+0000' }] } }),
  });
  assertEquals(await reconcilePost(s.post, deps(s.repo, m.f)), 'published');
  assertEquals(s.post.external_post_id, 'M9');
  assertEquals(m.calls.filter((c) => c.method === 'POST').length, 0, 'reconcile must never POST');
});

Deno.test('reconcile: container FINISHED, absent from account after 10 min → failed (verified not published)', async () => {
  const s = await setup({ post: { state: 'unknown', external_container_id: 'C1', publish_attempted_at: '2026-12-01T11:40:00Z' } });
  const m = metaMock({ 'GET C1': () => ({ body: { status_code: 'FINISHED' } }), [`GET ${IG}/media`]: () => ({ body: { data: [] } }) });
  assertEquals(await reconcilePost(s.post, deps(s.repo, m.f)), 'failed');
});

Deno.test('reconcile: PUBLISHED but not found yet → stays unknown', async () => {
  const s = await setup({ post: { state: 'unknown', external_container_id: 'C1', publish_attempted_at: '2026-12-01T11:40:00Z' } });
  const m = metaMock({ 'GET C1': () => ({ body: { status_code: 'PUBLISHED' } }), [`GET ${IG}/media`]: () => ({ body: { data: [{ id: 'X', caption: 'autre', timestamp: '2026-12-01T11:41:00+0000' }] } }) });
  assertEquals(await reconcilePost(s.post, deps(s.repo, m.f)), 'unknown');
  assertEquals(s.post.state, 'unknown');
});

Deno.test('token refresh: new token encrypted, expiry extended', async () => {
  const s = await setup({ account: { token_expires_at: '2026-12-05T00:00:00Z' } });
  const m = metaMock({ 'GET refresh_access_token': (c) => { assertEquals(c.params.grant_type, 'ig_refresh_token'); return { body: { access_token: 'NEWTOKEN', token_type: 'bearer', expires_in: 5184000 } }; } });
  assertEquals(await refreshTokens(deps(s.repo, m.f)), 1);
  assertEquals(await decryptToken(s.account.encrypted_token, KEY), 'NEWTOKEN');
  assertEquals(Date.parse(s.account.token_expires_at), NOW + 5184000 * 1000);
});

Deno.test('token refresh refused (190) → account expired', async () => {
  const s = await setup({ account: { token_expires_at: '2026-12-05T00:00:00Z' } });
  const m = metaMock({ 'GET refresh_access_token': () => ({ status: 400, body: { error: { message: 'Session has expired', code: 190 } } }) });
  assertEquals(await refreshTokens(deps(s.repo, m.f)), 0);
  assertEquals(s.account.state, 'expired');
});

Deno.test('errors never leak the access token', async () => {
  const s = await setup();
  const m = metaMock({ [`GET ${IG}/content_publishing_limit`]: quotaOk, [`POST ${IG}/media`]: () => ({ status: 400, body: { error: { message: 'bad url access_token=IGTOKEN-TEST123456789012345678', code: 100 } } }) });
  await processPost(s.post, deps(s.repo, m.f));
  assert(!String(s.post.last_error).includes('IGTOKEN-TEST'));
  assert(!JSON.stringify(s.events).includes('IGTOKEN-TEST'));
});

// ---------- shared helpers ----------
Deno.test('OAuth parsing handles wrapped and flat Meta responses', () => {
  assertEquals(parseShortToken({ data: [{ access_token: 'A', user_id: 123, permissions: 'instagram_business_basic,instagram_business_content_publish' }] }), { access_token: 'A', user_id: '123', permissions: ['instagram_business_basic', 'instagram_business_content_publish'] });
  assertEquals(parseShortToken({ access_token: 'B', user_id: '9', permissions: ['instagram_business_basic'] })?.permissions, ['instagram_business_basic']);
  assertEquals(parseShortToken({ error_type: 'OAuthException', code: 400 }), null);
  assertEquals(parseLongToken({ access_token: 'L', expires_in: 5183944 })?.expires_in, 5183944);
  assertEquals(parseProfile({ data: [{ id: '111', user_id: '17841400000000001', username: 'elyna', account_type: 'MEDIA_CREATOR' }] })?.ig_user_id, '17841400000000001');
  assertEquals(parseProfile({ id: '111', username: 'x' }), null, 'app-scoped id alone must not be used for publishing');
});

Deno.test('image header parsing (JPEG/PNG) and Instagram constraints', () => {
  const png = new Uint8Array(32); png.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 4, 56, 0, 0, 5, 70]);
  assertEquals(imageSize(png), { width: 1080, height: 1350 });
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 5, 70, 4, 56, 3, 0, 0, 0, 0]);
  assertEquals(imageSize(jpg), { width: 1080, height: 1350 });
  assertEquals(instagramImageProblem({ mime_type: 'image/jpeg', bytes: 1, width: 1080, height: 1350 }), null);
  assertEquals(instagramImageProblem({ mime_type: 'image/jpeg', bytes: 1, width: 1080, height: 1080 }), null);
  assert(instagramImageProblem({ mime_type: 'image/jpeg', bytes: 1, width: 1080, height: 1920 }));
  assert(instagramImageProblem({ mime_type: 'image/webp', bytes: 1, width: 1080, height: 1080 }));
});

Deno.test('captions: transparency, hashtags and variant parsing', () => {
  assertEquals(withTransparency('Un café ☕', true), 'Un café ☕\n\n#CréatriceVirtuelle');
  assertEquals(withTransparency('Un café #CréatriceVirtuelle', true), 'Un café #CréatriceVirtuelle');
  assertEquals(withTransparency('Un café', false), 'Un café');
  assertEquals(cleanHashtags(['mode', '#Mode', '#bad tag', '#ok_1', 42]), ['#mode', '#badtag', '#ok_1']);
  const v = parseCaptionVariants('```json\n{"variants":[{"text":"Lumière douce du matin","question":"Votre rituel ?","hashtags":["#matin","#CréatriceVirtuelle"]},{"text":"Lumière douce du matin","hashtags":[]},"Simple légende"]}\n```');
  assertEquals(v.length, 2);
  assertEquals(v[0].hashtags, ['#matin', '#CréatriceVirtuelle']);
});

Deno.test('signed_request verification', async () => {
  const secret = 'app-secret-test';
  const payload = btoa(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: '17841400000000001' })).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))))).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  assertEquals((await verifySignedRequest(sig + '.' + payload, secret))?.user_id, '17841400000000001');
  assertEquals(await verifySignedRequest(sig + '.' + payload, 'wrong'), null);
});
