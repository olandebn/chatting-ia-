// Relais IA — Instagram publication engine. Pure logic, dependencies injected (testable with mocks).
//
// Safety rules:
//  * Creating a media CONTAINER never publishes anything: it may be retried after transient errors.
//  * `media_publish` is called at most once per post: `publish_attempted_at` is written (guarded)
//    BEFORE the call. Any ambiguous outcome => state "unknown" + read-only reconciliation.
//  * A post is "published" only when Meta returns the media id, or when reconciliation finds
//    the post in the account's real media list.
import { decryptToken, encryptToken, graphClient, instagramImageProblem, MetaError, refreshLongToken, unwrap, type Fetch } from '../_shared/social_meta.ts';

export type Row = Record<string, any>;
export interface Repo {
  getAccount(post: Row): Promise<Row | null>;
  getMedia(post: Row): Promise<Row | null>;
  /** Guarded update. Returns true when a row was updated. */
  updatePost(id: string, patch: Row, guard: { state: string; publishNull?: boolean }): Promise<boolean>;
  updateAccount(id: string, patch: Row): Promise<void>;
  event(post: Row, event: string, detail?: string | null): Promise<void>;
  signedUrl(path: string, seconds: number): Promise<string>;
  accountsToRefresh(limit: number): Promise<Row[]>;
  expireAccounts(): Promise<number>;
}
export interface Deps { repo: Repo; fetch: Fetch; tokenKey: string | undefined; now?: () => number; sleep?: (ms: number) => Promise<void> }

const iso = (t: number) => new Date(t).toISOString();
const norm = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();
const MIN = 60_000;

async function usableAccount(post: Row, d: Deps, now: number): Promise<{ account: Row; token: string } | { error: string; expired?: boolean }> {
  const account = await d.repo.getAccount(post);
  if (!account || account.platform !== 'instagram') return { error: 'Compte Instagram introuvable pour cette publication.' };
  if (account.state !== 'connected' || !account.encrypted_token || !account.platform_user_id) return { error: 'Compte Instagram déconnecté ou expiré : reconnecte-le puis reprogramme la publication.' };
  if (!Array.isArray(account.permissions) || !account.permissions.includes('instagram_business_content_publish')) return { error: 'Permission instagram_business_content_publish non accordée : reconnecte le compte en acceptant la publication.' };
  if (!account.token_expires_at || Date.parse(account.token_expires_at) <= now) {
    await d.repo.updateAccount(account.id, { state: 'expired', last_error: 'Token expiré', updated_at: iso(now) });
    return { error: 'Token Instagram expiré : reconnexion requise.', expired: true };
  }
  try { return { account, token: await decryptToken(account.encrypted_token, d.tokenKey) }; }
  catch { return { error: 'Token illisible (clé SOCIAL_TOKEN_KEY modifiée ?) : reconnecte le compte.' }; }
}

export async function processPost(post: Row, d: Deps): Promise<string> {
  const now = (d.now ?? Date.now)();
  const sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const fail = async (msg: string, extra: Row = {}) => {
    await d.repo.updatePost(post.id, { state: 'failed', last_error: msg.slice(0, 300), lease_until: null, next_check_at: null, updated_at: iso(now), ...extra }, { state: 'processing' });
    await d.repo.event(post, 'failed', msg);
    return 'failed';
  };
  const later = async (ms: number, msg: string, extra: Row = {}) => {
    await d.repo.updatePost(post.id, { lease_until: null, next_check_at: iso(now + ms), last_error: msg.slice(0, 300), updated_at: iso(now), ...extra }, { state: 'processing' });
    await d.repo.event(post, 'deferred', msg);
    return 'deferred';
  };
  if (post.publish_attempted_at) return 'skipped'; // never re-run a publish attempt here

  const acc = await usableAccount(post, d, now);
  if ('error' in acc) return fail(acc.error);
  const { account, token } = acc;
  const media = await d.repo.getMedia(post);
  if (!media || media.state !== 'ready') return fail('Média indisponible ou archivé.');
  const problem = instagramImageProblem(media as { mime_type: string; bytes: number; width?: number | null; height?: number | null });
  if (problem) return fail(problem);
  if (!post.caption && post.caption !== '') return fail('Légende invalide.');

  const g = graphClient(d.fetch, token);
  const igId = String(account.platform_user_id);
  try {
    let container: string = post.external_container_id || '';
    if (!container) {
      try {
        const q = unwrap(await g.publishingLimit(igId));
        const used = Number(q?.quota_usage), total = Number(q?.config?.quota_total);
        if (Number.isFinite(used) && Number.isFinite(total) && total > 0 && used >= total) return later(30 * MIN, `Quota Instagram atteint (${used}/${total} sur 24 h) : nouvel essai dans 30 min.`);
      } catch (e) { if (e instanceof MetaError && e.isAuth) throw e; /* quota endpoint optional */ }
      const url = await d.repo.signedUrl(media.storage_path, 3600);
      const created = await g.createImageContainer(igId, url, post.caption || '');
      container = created?.id ? String(created.id) : '';
      if (!container) throw new MetaError('Conteneur Meta sans identifiant', 200, null, null, false);
      await d.repo.updatePost(post.id, { external_container_id: container, container_checks: 0, updated_at: iso(now) }, { state: 'processing' });
      await d.repo.event(post, 'container_created', container);
    }
    let code = '';
    for (let i = 0; i < 3; i++) {
      const st = await g.containerStatus(container);
      code = String(st?.status_code || '');
      if (code === 'FINISHED') break;
      if (code === 'ERROR' || code === 'EXPIRED') return fail(`Meta a refusé le média (${code}${st?.status ? ' : ' + String(st.status).slice(0, 120) : ''}).`, { external_container_id: null });
      if (code === 'PUBLISHED') {
        await d.repo.updatePost(post.id, { state: 'unknown', lease_until: null, next_check_at: iso(now + 2 * MIN), publish_attempted_at: post.publish_attempted_at ?? iso(now), last_error: 'Conteneur déjà publié : vérification en cours.' }, { state: 'processing' });
        await d.repo.event(post, 'unknown', 'Conteneur au statut PUBLISHED avant publication');
        return 'unknown';
      }
      if (i < 2) await sleep(2500);
    }
    if (code !== 'FINISHED') {
      const checks = Number(post.container_checks || 0) + 1;
      if (checks > 10) return fail('Meta n’a pas terminé le traitement du média après 10 minutes.', { external_container_id: null });
      return later(MIN, 'Meta prépare le média…', { container_checks: checks });
    }

    // ---- Point of no return: record the attempt BEFORE calling media_publish ----
    const guarded = await d.repo.updatePost(post.id, { publish_attempted_at: iso(now), lease_until: iso(now + 3 * MIN), updated_at: iso(now) }, { state: 'processing', publishNull: true });
    if (!guarded) return 'skipped';
    await d.repo.event(post, 'publish_attempt', container);
    let mediaId = '';
    try {
      const r = await g.publish(igId, container);
      mediaId = r?.id ? String(r.id) : '';
      if (!mediaId) throw new MetaError('Réponse de publication sans identifiant', 200, null, null, false);
    } catch (e) {
      const err = e instanceof MetaError ? e : new MetaError(String(e), 0, null, null, false);
      if (err.definite) {
        let after = '';
        try { after = String((await g.containerStatus(container))?.status_code || ''); } catch { /* unknown */ }
        if (after === 'FINISHED') {
          // Meta explicitly rejected the call and the container is still unpublished: nothing went live.
          if (err.isAuth) { await d.repo.updateAccount(account.id, { state: 'expired', last_error: 'Token refusé par Meta', updated_at: iso(now) }); return fail('Instagram a refusé le token : reconnecte le compte.', { publish_attempted_at: null }); }
          if (err.isTransient && Number(post.attempts || 0) < 5) return later(2 * MIN, 'Meta temporairement indisponible : nouvel essai dans 2 min.', { publish_attempted_at: null, attempts: Math.min(Number(post.attempts || 0) + 1, 10) });
          return fail(err.message, { publish_attempted_at: null });
        }
      }
      await d.repo.updatePost(post.id, { state: 'unknown', lease_until: null, next_check_at: iso(now + 2 * MIN), last_error: 'Publication peut-être effectuée : vérification automatique sur Instagram en cours.' }, { state: 'processing' });
      await d.repo.event(post, 'unknown', err.message);
      return 'unknown';
    }
    let permalink: string | null = null;
    try { const m = await g.media(mediaId); if (typeof m?.permalink === 'string' && m.permalink.startsWith('https://www.instagram.com/')) permalink = m.permalink; } catch { /* confirmation already given by media id */ }
    const saved = await d.repo.updatePost(post.id, { state: 'published', external_post_id: mediaId, external_permalink: permalink, published_at: iso(now), last_error: null, lease_until: null, next_check_at: null, updated_at: iso(now) }, { state: 'processing' });
    await d.repo.event(post, 'published', mediaId + (saved ? '' : ' (statut local modifié entre-temps)'));
    return 'published';
  } catch (e) {
    const err = e instanceof MetaError ? e : null;
    const msg = err ? err.message : 'Erreur interne : ' + String(e instanceof Error ? e.message : e).slice(0, 120);
    if (err?.isAuth) { await d.repo.updateAccount(account.id, { state: 'expired', last_error: 'Token refusé par Meta', updated_at: iso(now) }); return fail('Instagram a refusé le token : reconnecte le compte.'); }
    if (err?.definite && err.isPermission) return fail('Permission de publication refusée par Meta : ' + msg);
    if (!err || err.isTransient) {
      const attempts = Number(post.attempts || 0) + 1;
      if (attempts >= 5) return fail('Échec après 5 tentatives : ' + msg, { attempts: Math.min(attempts, 10) });
      return later(Math.min(2 ** attempts, 30) * MIN, 'Erreur temporaire, nouvel essai automatique : ' + msg, { attempts });
    }
    return fail(msg);
  }
}

/** Read-only verification of an "unknown" post. Never calls media_publish. */
export async function reconcilePost(post: Row, d: Deps): Promise<string> {
  const now = (d.now ?? Date.now)();
  const setUnknown = async (ms: number | null, msg: string) => { await d.repo.updatePost(post.id, { lease_until: null, next_check_at: ms === null ? null : iso(now + ms), last_error: msg, updated_at: iso(now) }, { state: 'unknown' }); return 'unknown'; };
  const acc = await usableAccount(post, d, now);
  if ('error' in acc) return setUnknown(null, 'Vérification automatique impossible (' + acc.error + ') : vérifie manuellement sur Instagram.');
  const g = graphClient(d.fetch, acc.token);
  const igId = String(acc.account.platform_user_id);
  const since = Date.parse(post.publish_attempted_at || post.started_at || post.scheduled_at || '') - 10 * MIN;
  let status = '';
  try { status = String((await g.containerStatus(post.external_container_id))?.status_code || ''); } catch { /* keep checking */ }
  try {
    const list = await g.recentMedia(igId); // list endpoint: do NOT unwrap (a single item would become an object)
    const items: Row[] = Array.isArray(list?.data) ? list.data : [];
    const target = norm(post.caption);
    const hit = items.find((m) => norm(m.caption) === target && (!Number.isFinite(since) || Date.parse(m.timestamp) >= since));
    if (hit?.id) {
      const permalink = typeof hit.permalink === 'string' && hit.permalink.startsWith('https://www.instagram.com/') ? hit.permalink : null;
      await d.repo.updatePost(post.id, { state: 'published', external_post_id: String(hit.id), external_permalink: permalink, published_at: hit.timestamp ? iso(Date.parse(hit.timestamp)) : iso(now), last_error: null, lease_until: null, next_check_at: null, updated_at: iso(now) }, { state: 'unknown' });
      await d.repo.event(post, 'published', String(hit.id) + ' (confirmé par vérification du compte)');
      return 'published';
    }
  } catch (e) {
    if (e instanceof MetaError && e.isAuth) return setUnknown(null, 'Token refusé pendant la vérification : vérifie manuellement sur Instagram.');
    return setUnknown(3 * MIN, 'Vérification Instagram en attente (réseau).');
  }
  const elapsed = now - Date.parse(post.publish_attempted_at || post.started_at || iso(now));
  if (['FINISHED', 'ERROR', 'EXPIRED'].includes(status) && elapsed > 10 * MIN) {
    await d.repo.updatePost(post.id, { state: 'failed', last_error: `Non publiée : Meta indique que le conteneur n’a pas été publié (${status}) et le post est absent du compte.`, lease_until: null, next_check_at: null, updated_at: iso(now) }, { state: 'unknown' });
    await d.repo.event(post, 'failed', 'Vérification : conteneur ' + status + ', absent du compte');
    return 'failed';
  }
  if (Number(post.reconcile_checks || 0) >= 12) return setUnknown(null, 'Impossible de confirmer automatiquement : vérifie sur Instagram puis indique le résultat.');
  return setUnknown(status === 'PUBLISHED' ? 5 * MIN : 3 * MIN, status === 'PUBLISHED' ? 'Meta indique une publication : recherche du post sur le compte…' : 'Vérification en cours…');
}

/** Refresh long-lived tokens that expire within 10 days (Meta requires the token to be ≥ 24 h old). */
export async function refreshTokens(d: Deps, limit = 3) {
  const now = (d.now ?? Date.now)();
  let refreshed = 0;
  await d.repo.expireAccounts();
  for (const a of await d.repo.accountsToRefresh(limit)) {
    try {
      const token = await decryptToken(a.encrypted_token, d.tokenKey);
      const fresh = await refreshLongToken(d.fetch, token);
      await d.repo.updateAccount(a.id, { encrypted_token: await encryptToken(fresh.access_token, d.tokenKey), token_expires_at: iso(now + fresh.expires_in * 1000), token_refreshed_at: iso(now), last_error: null, updated_at: iso(now) });
      refreshed++;
    } catch (e) {
      const err = e instanceof MetaError ? e : null;
      if (err?.isAuth || (err?.definite && err.code === 190)) await d.repo.updateAccount(a.id, { state: 'expired', last_error: 'Renouvellement refusé : reconnexion requise', updated_at: iso(now) });
      else await d.repo.updateAccount(a.id, { last_error: 'Renouvellement du token reporté', token_refreshed_at: iso(now - 23 * 3600_000), updated_at: iso(now) });
    }
  }
  return refreshed;
}
