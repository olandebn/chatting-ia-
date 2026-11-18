// Social Automation V2 + Buffer Bridge V1. Does not change Telegram, NoTrack or Meta backend.
// All privileged work happens in the `social-api` Edge Function. No token ever reaches this page.
const SB_KEY = 'sb_publishable_8vsVUoNdH8ga_LzWX6OynQ_HO2QRPIE';
const IG_MAX = 8 * 1024 * 1024, MIN_R = 0.8, MAX_R = 1.91;
const STYLES = [['naturel', 'Naturel'], ['elegant', 'Élégant'], ['lifestyle', 'Lifestyle'], ['glamour', 'Glamour'], ['humoristique', 'Humoristique'], ['mysterieux', 'Mystérieux'], ['seduisant', 'Séduisant (non explicite)']];
const STATUS = { draft: 'Brouillon', scheduled: 'Planifié', processing: 'En cours', published: 'Publié', failed: 'Échec', unknown: 'À vérifier', cancelled: 'Annulé' };
const EVENTS = { draft_created: 'Brouillon créé', scheduled: 'Programmée', unscheduled: 'Retirée du planning', cancelled: 'Annulée', container_created: 'Média envoyé à Meta', deferred: 'Report', publish_attempt: 'Publication demandée à Meta', published: 'Publiée (confirmé par Meta)', failed: 'Échec', unknown: 'À vérifier' };
const OAUTH = {
  connected: ['Compte Instagram connecté.', false], authorization_denied: ['Autorisation refusée sur Instagram.', true],
  missing_permissions: ['Permissions incomplètes : accepte la publication de contenu lors de la connexion.', true],
  not_professional: ['Ce compte n’est pas un compte professionnel (Business ou Créateur).', true],
  account_linked_elsewhere: ['Ce compte Instagram est déjà relié à un autre créateur.', true],
  expired_state: ['Lien de connexion expiré : recommence.', true], invalid_state: ['Lien de connexion invalide : recommence.', true], consumed_state: ['Lien de connexion déjà utilisé : recommence.', true],
  not_configured: ['Identifiants Meta absents côté serveur.', true], connection_failed: ['Meta a refusé l’échange du code. Réessaie ; détails dans les journaux Supabase.', true],
};

export async function viewSocialAutomation(main, { sb, esc, toast, fail, fmtDate }) {
  const call = async (action, body = {}) => {
    const { data, error } = await sb.functions.invoke('social-api', { body: { action, ...body } });
    if (error) { let message = error.message, extra = null; try { extra = await error.context.json(); message = extra.error || message; } catch { } const e = Error(message); e.data = extra; throw e; }
    if (data?.error) { const e = Error(data.error); e.data = data; throw e; }
    return data;
  };
  const S = { creators: [], accounts: [], media: [], posts: [], urls: {}, creatorId: '', tab: 'overview', configured: false, ai: false, vision: false, scheduler: { active: false }, isAdmin: false, redirect: '', selected: new Set(), filter: 'all', month: monthStart(new Date()), composer: { mediaId: '', mediaIds: [], postId: '', caption: '', variants: [], style: 'naturel', showLibrary: true, visualStatus: '', visualError: '', visualKey: '', autoCaption: '', manualCaption: false }, uploads: [], urlsUpdatedAt: 0, buffer: { configured: false, channels: [], jobs: [], error: '', loading: false, loaded: false, channelId: '', draftId: '', mediaIds: [], dateValue: '', confirmed: false } };
  const $ = (s) => main.querySelector(s), $$ = (s) => [...main.querySelectorAll(s)];
  const p = (s) => esc(s ?? '');
  const busy = (b, on) => { if (!b) return; b.disabled = on; b.setAttribute('aria-busy', String(on)); };
  const when = (t) => t ? fmtDate(t) : '—';
  const mediaById = (id) => S.media.find((m) => m.id === id);
  const account = () => S.accounts.find((a) => a.creator_id === S.creatorId && a.platform === 'instagram' && a.state !== 'disconnected') || null;
  const igProblem = (m) => !m ? 'Média introuvable' : m.mime_type !== 'image/jpeg' ? 'JPEG requis' : m.bytes > IG_MAX ? 'Plus de 8 Mo' : !m.width ? 'Dimensions inconnues' : m.width < 320 ? 'Moins de 320 px' : (m.width / m.height < MIN_R - 0.005 || m.width / m.height > MAX_R + 0.005) ? `Ratio ${m.width}×${m.height} hors 4:5–1,91:1` : null;
  const pill = (state) => `<span class="social-pill s-${p(state)}">${p(STATUS[state] || state)}</span>`;
  const thumb = (id, cls = '') => { const u = S.urls[id]; return u ? `<img class="social-thumb ${cls}" src="${p(u)}" alt="" loading="lazy">` : `<span class="social-thumb social-thumb-empty ${cls}" aria-hidden="true"></span>`; };

  // ---------- OAuth return ----------
  const qs = new URLSearchParams(location.search);
  const oauth = qs.get('social_oauth');
  if (oauth) { history.replaceState(null, '', location.pathname + location.hash); const [msg, err] = OAUTH[oauth] || ['Retour Instagram inattendu.', true]; toast(msg, err); S.tab = 'accounts'; S.banner = { msg, err }; }

  async function loadStatus() {
    const r = await call('status');
    Object.assign(S, { creators: r.creators || [], accounts: r.accounts || [], configured: !!r.instagram_configured, ai: !!r.ai_configured, vision: !!r.vision_configured, scheduler: r.scheduler || { active: false }, isAdmin: !!r.is_admin, redirect: r.redirect_uri || '' });
    if (!S.creators.some((c) => c.id === S.creatorId)) S.creatorId = S.creators[0]?.id || '';
  }
  async function loadData() {
    if (!S.creatorId) { S.media = []; S.posts = []; return; }
    const r = await call('dashboard', { creator_id: S.creatorId });
    S.media = r.media || []; S.posts = r.posts || [];
    // Les URL du bucket privé expirent au bout de 15 min côté V3.
    if (Date.now() - S.urlsUpdatedAt > 12 * 60_000) { S.urls = {}; S.urlsUpdatedAt = 0; }
    const need = S.media.filter((m) => m.state === 'ready' && !S.urls[m.id]).map((m) => m.id);
    let urlsOk = true;
    for (let i = 0; i < need.length; i += 60) {
      try { Object.assign(S.urls, (await call('media_urls', { creator_id: S.creatorId, media_ids: need.slice(i, i + 60) })).urls || {}); }
      catch { urlsOk = false; }
    }
    if (urlsOk) S.urlsUpdatedAt = Date.now();
  }
  async function refresh() { await loadData(); draw(); }

  // ---------- Layout ----------
  const TABS = () => [['overview', 'Vue d’ensemble'], ['accounts', 'Compte Instagram'], ['media', 'Médias'], ['compose', 'Nouvelle publication'], ['posts', 'Publications'], ['calendar', 'Calendrier'], ...(S.isAdmin ? [['buffer', 'Buffer']] : [])];
  function layout(content) {
    main.innerHTML = `<div class="social-page">
      <div class="main-head"><div><h1>Social Automation</h1><p>Importe tes photos, rédige les légendes avec l’IA et programme tes publications Instagram.</p></div></div>
      ${S.banner ? `<div class="social-banner ${S.banner.err ? 'is-error' : 'is-ok'}" role="status">${p(S.banner.msg)}<button type="button" class="btn-ghost btn-sm" data-close-banner aria-label="Fermer">×</button></div>` : ''}
      <section class="panel social-toolbar"><label for="social-creator">Créateur</label>
        <select id="social-creator">${S.creators.length ? '' : '<option value="">Aucun</option>'}${S.creators.map((c) => `<option value="${p(c.id)}" ${c.id === S.creatorId ? 'selected' : ''}>${p(c.name)}</option>`).join('')}</select>
        <button type="button" id="social-new-creator" class="btn-sm">+ Nouveau créateur</button>
        <span class="social-toolbar-status">${igBadge()}</span></section>
      <nav class="social-tabs" role="tablist" aria-label="Social Automation">${TABS().map(([id, label]) => `<button type="button" role="tab" class="btn-sm ${S.tab === id ? 'social-selected' : ''}" data-tab="${id}" aria-selected="${S.tab === id}">${label}</button>`).join('')}</nav>
      ${content}</div>`;
    $('#social-creator').onchange = async (e) => { S.creatorId = e.target.value; S.selected.clear(); S.composer = { ...S.composer, mediaId: '', mediaIds: [], postId: '', caption: '', variants: [], showLibrary: true }; S.buffer.loaded = false; S.buffer.draftId = ''; S.buffer.mediaIds = []; S.buffer.confirmed = false; try { if (S.tab === 'buffer') await loadBuffer(); await refresh(); } catch (err) { fail(err); } };
    $('#social-new-creator').onclick = async () => { const name = prompt('Nom du créateur (ex : Elyna Moreau)'); if (!name?.trim()) return; try { const r = await call('create_creator', { name: name.trim() }); S.creators.push(r.creator); S.creatorId = r.creator.id; await refresh(); toast('Créateur créé'); } catch (e) { fail(e); } };
    $$('[data-tab]').forEach((b) => b.onclick = async () => {
      S.tab = b.dataset.tab;
      if (S.tab === 'buffer') {
        S.buffer.loading = true; draw();
        try { await loadBuffer(); } catch (e) { S.buffer.error = e.message || 'Connexion impossible'; }
        S.buffer.loading = false;
      }
      draw();
    });
    $('[data-close-banner]')?.addEventListener('click', () => { S.banner = null; draw(); });
  }
  function igBadge() {
    const a = account();
    if (S.tab === 'buffer') return `<span class="social-pill ${S.buffer.configured ? 's-published' : 's-failed'}">Buffer ${S.buffer.configured ? 'disponible' : 'non configuré'}</span>`;
    if (!S.configured) return '<span class="social-pill s-failed">Meta non configuré</span>';
    if (!a) return '<span class="social-pill">Instagram non connecté</span>';
    if (a.state === 'connected') return `<span class="social-pill s-published">@${p(a.username)} connecté</span>`;
    return `<span class="social-pill s-failed">@${p(a.username)} : ${a.state === 'expired' ? 'reconnexion requise' : 'erreur'}</span>`;
  }

  // ---------- Overview ----------
  function overview() {
    const a = account(), count = (s) => S.posts.filter((x) => x.state === s).length;
    const upcoming = S.posts.filter((x) => x.state === 'scheduled').sort((x, y) => x.scheduled_at.localeCompare(y.scheduled_at)).slice(0, 5);
    const attention = S.posts.filter((x) => ['failed', 'unknown'].includes(x.state)).slice(0, 5);
    const ready = S.media.filter((m) => m.state === 'ready').length, compatible = S.media.filter((m) => m.state === 'ready' && !igProblem(m)).length;
    const steps = [
      [S.configured, 'Identifiants Meta configurés côté serveur'],
      [a?.state === 'connected', a ? `Compte @${p(a.username)} ${a.state === 'connected' ? 'connecté' : 'à reconnecter'}` : 'Compte Instagram professionnel à connecter'],
      [compatible > 0, `${compatible} photo(s) compatibles Instagram sur ${ready}`],
      [count('scheduled') + count('published') > 0, 'Première publication programmée'],
      [!!S.scheduler.active, S.scheduler.active ? 'Publication automatique active (toutes les minutes)' : 'Publication automatique en pause (planificateur désactivé)'],
    ];
    return `<div class="social-stats">${[['Médias prêts', ready], ['Brouillons', count('draft')], ['Planifiés', count('scheduled')], ['Publiés (confirmés)', count('published')], ['À vérifier / échecs', count('unknown') + count('failed')]].map(([l, n]) => `<div class="panel social-stat"><small>${l}</small><strong>${n}</strong></div>`).join('')}</div>
      <div class="social-two">
        <section class="panel"><h2>Mise en route</h2><ol class="social-steps">${steps.map(([ok, t]) => `<li class="${ok ? 'is-done' : ''}"><span aria-hidden="true">${ok ? '✓' : '○'}</span>${t}</li>`).join('')}</ol>
          <p class="hint">Rien n’est publié sans ta programmation explicite. Un post n’est marqué « Publié » qu’après confirmation de Meta.</p></section>
        <section class="panel"><h2>Prochaines publications</h2>${upcoming.length ? upcoming.map(rowCompact).join('') : '<p class="muted">Aucune publication planifiée.</p>'}
          ${attention.length ? `<h3 class="social-h3">À traiter</h3>${attention.map(rowCompact).join('')}` : ''}</section>
      </div>`;
  }
  const rowCompact = (x) => `<div class="social-compact">${thumb(x.media_id, 'is-sm')}<div><strong>${x.scheduled_at ? when(x.scheduled_at) : when(x.created_at)}</strong><p class="small muted">${p((x.caption || '').slice(0, 90))}</p>${x.last_error && ['failed', 'unknown'].includes(x.state) ? `<p class="small social-err">${p(x.last_error)}</p>` : ''}</div>${pill(x.state)}</div>`;

  // ---------- Account ----------
  function accountsView() {
    const a = account(), perms = a?.permissions || [];
    const permRow = (k, label) => `<li class="${perms.includes(k) ? 'is-done' : ''}"><span aria-hidden="true">${perms.includes(k) ? '✓' : '✗'}</span>${label} <code>${k}</code></li>`;
    const days = a?.token_expires_at ? Math.round((Date.parse(a.token_expires_at) - Date.now()) / 864e5) : null;
    return `<section class="panel"><h2>Compte Instagram professionnel</h2>
      ${a ? `<div class="social-account">${a.profile_picture_url ? `<img src="${p(a.profile_picture_url)}" alt="" class="social-avatar" referrerpolicy="no-referrer">` : '<span class="social-avatar"></span>'}
        <div><strong>@${p(a.username || 'compte')}</strong> ${a.state === 'connected' ? '<span class="social-pill s-published">Connecté</span>' : `<span class="social-pill s-failed">${a.state === 'expired' ? 'Expiré' : 'Erreur'}</span>`}
        <p class="small muted">${p(a.account_type ? (a.account_type.toLowerCase().includes('creator') ? 'Compte Créateur' : 'Compte Business') : 'Type inconnu')} · connecté le ${when(a.connected_at)}</p>
        <p class="small muted">Accès valable jusqu’au ${when(a.token_expires_at)}${days !== null ? ` (${days} j)` : ''} · renouvelé automatiquement · dernier renouvellement ${when(a.token_refreshed_at)}</p>
        ${a.last_error ? `<p class="small social-err">${p(a.last_error)}</p>` : ''}</div></div>
        <ul class="social-steps">${permRow('instagram_business_basic', 'Lecture du profil')}${permRow('instagram_business_content_publish', 'Publication de contenu')}</ul>`
        : '<p class="muted">Aucun compte connecté pour ce créateur.</p>'}
      <div class="row social-actions">
        <button id="social-connect" type="button" class="btn-primary" ${!S.creatorId || !S.configured ? 'disabled' : ''}>${a ? 'Reconnecter Instagram' : 'Connecter Instagram professionnel'}</button>
        ${a ? `<button type="button" data-disconnect="${p(a.id)}" class="btn-sm btn-danger">Déconnecter</button>` : ''}
      </div>
      ${!S.configured ? '<p class="hint">Bouton désactivé : INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET ou SOCIAL_TOKEN_KEY manquent dans les secrets Supabase.</p>' : '<p class="hint">Tu seras redirigé vers Instagram pour autoriser Relais IA, puis ramené ici. Ton mot de passe n’est jamais saisi dans Relais IA.</p>'}
      <p class="hint">Déconnecter supprime le token chiffré et remet les publications planifiées en brouillon. Pour retirer aussi l’accès côté Instagram : Paramètres → Sécurité → Apps et sites web.</p></section>
      <section class="panel"><h2>Publication automatique</h2>
        <p>Planificateur serveur : ${S.scheduler.active ? '<span class="social-pill s-published">Actif — vérifie la file chaque minute</span>' : '<span class="social-pill">En pause</span>'}</p>
        <p class="hint">Il fonctionne même si ton ordinateur est éteint ou ton navigateur fermé.${S.scheduler.active ? '' : ' Tant qu’il est en pause, les publications planifiées attendent.'}</p>
        ${S.isAdmin ? `<button type="button" id="social-scheduler" class="btn-sm ${S.scheduler.active ? 'btn-danger' : ''}" ${!S.configured && !S.scheduler.active ? 'disabled' : ''}>${S.scheduler.active ? 'Mettre en pause' : 'Activer la publication automatique'}</button>` : ''}
        ${S.isAdmin && S.redirect ? `<details class="social-details"><summary>Paramètres à saisir dans Meta for Developers</summary><p class="small">URI de redirection OAuth : <code>${p(S.redirect)}</code></p><p class="small">Rappel d’annulation d’autorisation : <code>${p(S.redirect)}?meta=deauthorize</code></p><p class="small">Demande de suppression des données : <code>${p(S.redirect)}?meta=data_deletion</code></p></details>` : ''}
      </section>`;
  }

  // ---------- Media ----------
  function mediaView() {
    const items = S.media.filter((m) => m.state === 'ready');
    return `<section class="panel"><h2>Bibliothèque de médias</h2>
      <p class="muted">Photos privées (JPG, PNG, WebP, 15 Mo max). Instagram exige un JPEG de 8 Mo maximum au format 4:5 à 1,91:1.</p>
      <div id="social-drop" class="social-drop ${!S.creatorId ? 'is-disabled' : ''}" tabindex="0" role="button" aria-label="Importer des photos">
        <strong>Glisse tes photos ici</strong><span class="muted small">ou clique pour choisir (sélection multiple)</span>
        <input id="social-files" type="file" accept="image/jpeg,image/png,image/webp" multiple hidden ${!S.creatorId ? 'disabled' : ''}></div>
      <div class="social-options">
        <label><input id="social-synthetic" type="checkbox" checked> Images de créatrice virtuelle / générées par IA (mention de transparence ajoutée)</label>
        <label><input id="social-convert" type="checkbox" checked> Rendre compatible Instagram : conversion JPEG et recadrage centré au format 4:5 si nécessaire</label>
      </div>
      <ul id="social-uploads" class="social-uploads" aria-live="polite">${S.uploads.map(uploadRow).join('')}</ul></section>
      <section class="panel"><div class="social-gallery-head"><h2>${items.length} photo(s)</h2>
        <div class="social-actions">${S.selected.size ? `<span class="small muted">${S.selected.size} sélectionnée(s)</span><button type="button" id="social-compose-selected" class="btn-sm">Créer une publication</button><button type="button" id="social-archive-selected" class="btn-sm btn-danger">Archiver</button><button type="button" id="social-clear-selection" class="btn-sm btn-ghost">Désélectionner</button>` : ''}</div></div>
      <div class="social-media-grid">${items.length ? items.map((m) => {
        const prob = igProblem(m), used = S.posts.filter((x) => x.media_id === m.id && x.state !== 'cancelled');
        return `<article class="social-media-item ${S.selected.has(m.id) ? 'is-selected' : ''}">
          <button type="button" class="social-image" data-preview="${p(m.id)}" aria-label="Agrandir ${p(m.filename)}">${thumb(m.id)}</button>
          <label class="social-check"><input type="checkbox" data-select="${p(m.id)}" ${S.selected.has(m.id) ? 'checked' : ''}> <span title="${p(m.filename)}">${p(m.filename)}</span></label>
          <p class="small muted">${m.width ? `${m.width}×${m.height} · ` : ''}${Math.ceil(m.bytes / 1024)} Ko${m.is_synthetic ? ' · IA' : ''}</p>
          <p class="small">${prob ? `<span class="social-err">${p(prob)}</span>` : '<span class="social-ok">Compatible Instagram</span>'}${used.length ? ` · ${used.length} publication(s)` : ''}</p>
        </article>`;
      }).join('') : '<p class="muted">Aucune photo. Importe ta première image.</p>'}</div></section>`;
  }
  const uploadRow = (u) => `<li class="${u.error ? 'is-error' : u.done ? 'is-done' : ''}"><span class="social-upload-name">${p(u.name)}</span><progress max="100" value="${u.pct}"></progress><span class="small">${p(u.error || u.label)}</span></li>`;
  function paintUploads() { const ul = $('#social-uploads'); if (ul) ul.innerHTML = S.uploads.map(uploadRow).join(''); }

  async function sha256(blob) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), (v) => v.toString(16).padStart(2, '0')).join(''); }
  function jpegSize(buf) { const v = new Uint8Array(buf); let i = 2; while (i + 9 < v.length) { if (v[i] !== 0xff) { i++; continue; } const m = v[i + 1]; if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 1) { i += 2; continue; } const len = v[i + 2] << 8 | v[i + 3]; if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(m)) return { h: v[i + 5] << 8 | v[i + 6], w: v[i + 7] << 8 | v[i + 8] }; if (len < 2) return null; i += 2 + len; } return null; }
  async function prepare(file, convert) {
    if (!convert) return { blob: file, name: file.name, changed: false };
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const w = bmp.width, h = bmp.height, r = w / h;
    let rotated = false;
    if (file.type === 'image/jpeg') { const raw = jpegSize(await file.slice(0, 256 * 1024).arrayBuffer()); rotated = !!raw && (raw.w !== w || raw.h !== h); }
    const badRatio = r < MIN_R - 0.005 || r > MAX_R + 0.005;
    if (file.type === 'image/jpeg' && file.size <= IG_MAX && !badRatio && !rotated) { bmp.close?.(); return { blob: file, name: file.name, changed: false }; }
    let sx = 0, sy = 0, sw = w, sh = h;
    if (r < MIN_R) { sh = Math.round(w / MIN_R); sy = Math.round((h - sh) / 2); } else if (r > MAX_R) { sw = Math.round(h * MAX_R); sx = Math.round((w - sw) / 2); }
    const scale = Math.min(1, 1440 / sw), cw = Math.round(sw * scale), ch = Math.round(sh * scale);
    const canvas = document.createElement('canvas'); canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch); ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, cw, ch); bmp.close?.();
    let blob = null;
    for (const q of [0.92, 0.85, 0.75]) { blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', q)); if (blob && blob.size <= IG_MAX) break; }
    if (!blob) throw Error('Conversion JPEG impossible dans ce navigateur');
    return { blob, name: file.name.replace(/\.(png|webp|jpe?g)$/i, '') + '.jpg', changed: true };
  }
  function putWithProgress(url, blob, onPct) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest(); xhr.open('PUT', url);
      xhr.setRequestHeader('x-upsert', 'false'); xhr.setRequestHeader('apikey', SB_KEY);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onPct(Math.round(e.loaded / e.total * 100)); };
      xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(Error('Transfert refusé (' + xhr.status + ')'));
      xhr.onerror = () => reject(Error('Connexion interrompue pendant le transfert'));
      const fd = new FormData(); fd.append('cacheControl', '3600'); fd.append('', blob); xhr.send(fd);
    });
  }
  async function importFiles(files) {
    if (!S.creatorId) return;
    const synthetic = $('#social-synthetic')?.checked ?? true, convert = $('#social-convert')?.checked ?? true;
    const list = [...files].filter((f) => /^image\//.test(f.type)).slice(0, 100);
    if (!list.length) { toast('Aucune image reconnue', true); return; }
    const jobs = list.map((f) => ({ file: f, name: f.name, pct: 0, label: 'En attente', done: false, error: '' }));
    S.uploads = [...jobs, ...S.uploads.filter((u) => !u.done && !u.error)].slice(0, 100); paintUploads();
    let ok = 0, dup = 0, ko = 0;
    const worker = async () => {
      for (let job; (job = jobs.find((j) => !j.started));) {
        job.started = true;
        try {
          if (!['image/jpeg', 'image/png', 'image/webp'].includes(job.file.type)) throw Error('Format non pris en charge');
          if (job.file.size > 15 * 1024 * 1024) throw Error('Fichier de plus de 15 Mo');
          job.label = 'Préparation…'; paintUploads();
          const prep = await prepare(job.file, convert);
          job.name = prep.name; job.label = prep.changed ? 'Converti pour Instagram, envoi…' : 'Envoi…'; paintUploads();
          const hash = await sha256(prep.blob);
          const start = await call('start_upload', { creator_id: S.creatorId, filename: prep.name, mime_type: prep.blob.type || job.file.type, bytes: prep.blob.size, sha256: hash, is_synthetic: synthetic });
          if (start.duplicate) { job.done = true; job.pct = 100; job.label = 'Déjà dans la bibliothèque (doublon ignoré)'; dup++; paintUploads(); continue; }
          await putWithProgress(start.signed_url, prep.blob, (pct) => { job.pct = Math.min(pct, 99); job.label = `Envoi ${pct} %`; paintUploads(); });
          job.label = 'Vérification serveur…'; paintUploads();
          const fin = await call('finish_upload', { creator_id: S.creatorId, media_id: start.media_id });
          job.pct = 100; job.done = true; job.label = fin.instagram_problem ? 'Importée — ' + fin.instagram_problem : 'Importée'; ok++;
        } catch (e) { job.error = e.message || 'Échec'; job.pct = 0; ko++; }
        paintUploads();
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    toast(`${ok} importée(s)${dup ? `, ${dup} doublon(s)` : ''}${ko ? `, ${ko} échec(s)` : ''}`, ko > 0 && !ok);
    try { await refresh(); } catch (e) { fail(e); }
  }
  async function preview(id) {
    try {
      const v = await call('media_preview', { creator_id: S.creatorId, media_id: id });
      const d = document.createElement('dialog'); d.className = 'social-dialog social-lightbox';
      d.innerHTML = `<img src="${p(v.url)}" alt="Aperçu privé"><form method="dialog"><button class="btn-sm">Fermer</button></form>`;
      document.body.append(d); d.addEventListener('close', () => d.remove()); d.showModal();
    } catch (e) { fail(e); }
  }

  // ---------- Composer ----------
  const composerIds = () => S.composer.mediaIds?.length ? [...S.composer.mediaIds] : (S.composer.mediaId ? [S.composer.mediaId] : []);
  const newComposer = () => ({ mediaId: '', mediaIds: [], postId: '', caption: '', variants: [], style: 'naturel', description: '', question: true, showLibrary: true, visualStatus: '', visualError: '', visualKey: '', autoCaption: '', manualCaption: false });
  // ---------- Composer: one post may contain up to 20 ordered images ----------
  function composeView() {
    const c = S.composer, ids = composerIds(), m = ids.length ? mediaById(ids[0]) : null;
    const eligible = S.media.filter((x) => x.state === 'ready' && !igProblem(x));
    const prob = ids.map((id) => igProblem(mediaById(id))).find(Boolean) || null;
    const a = account(), editing = c.postId ? S.posts.find((x) => x.id === c.postId) : null;
    const showLibrary = c.showLibrary || ids.length === 0;
    return `<div class="social-compose">
      <section class="panel"><h2>${editing ? 'Modifier le brouillon' : '1. Choisis les photos de la publication'}</h2>
        <p class="small muted">Sélectionne jusqu’à 20 photos pour un seul carrousel Instagram. L’ordre affiché ici sera celui envoyé à Buffer.</p>
        <style>
          .social-carousel-editor{border:1px solid var(--line,#d5dce8);border-radius:14px;padding:13px;margin:12px 0 22px}
          .social-carousel-picker{display:flex;flex-wrap:wrap;gap:12px;margin:12px 0}
          .social-compose-photo{width:107px;display:flex;flex-direction:column;gap:5px}
          .social-compose-image{position:relative;width:107px;height:122px;border-radius:10px;overflow:hidden}
          .social-compose-image .social-thumb{width:100%;height:100%;object-fit:cover}
          .social-compose-number{position:absolute;top:5px;left:6px;border-radius:99px;padding:3px 7px;background:#1c2547;color:white;font-size:12px;font-weight:700}
          .social-compose-movers{display:flex;gap:5px}
          .social-compose-movers button{flex:1;cursor:pointer;min-width:28px;min-height:30px;background:transparent;border:1px solid #bfcadd;border-radius:6px;font-size:16px;color:inherit}
          .social-compose-movers button:disabled{opacity:.25;cursor:default}
          .social-compose-library{display:flex;gap:10px;flex-wrap:wrap;margin:13px 0}
          .social-compose-library .social-pick{position:relative;width:94px;height:116px}
        </style><div class="social-carousel-editor"><div class="social-gallery-head"><strong>${ids.length} photo(s) sélectionnée(s)</strong>${ids.length ? '<small class="muted">La photo 1 est la couverture</small>' : ''}</div>
        ${ids.length ? `<div class="social-carousel-picker">${ids.map((id, index) => {
          const photo = mediaById(id); return `<div class="social-compose-photo">
            <div class="social-compose-image">${thumb(id)}<span class="social-compose-number">${index+1}</span></div>
            <span class="small muted" title="${p(photo?.filename || '')}">${p((photo?.filename || 'Photo').slice(0, 17))}</span>
            <div class="social-compose-movers">
              <button type="button" data-compose-up="${p(id)}" aria-label="Déplacer la photo ${index+1} vers la gauche" ${index === 0 ? 'disabled' : ''}>←</button>
              <button type="button" data-compose-down="${p(id)}" aria-label="Déplacer la photo ${index+1} vers la droite" ${index === ids.length-1 ? 'disabled' : ''}>→</button>
              <button type="button" data-compose-remove="${p(id)}" aria-label="Retirer la photo ${index+1}">×</button>
            </div></div>`;
        }).join('')}</div>` : '<p class="muted">Aucune photo sélectionnée. Choisis celles de ton carrousel ci-dessous.</p>'}
        ${ids.length ? `<button type="button" id="social-toggle-gallery" class="btn-sm btn-ghost">${showLibrary ? 'Masquer la bibliothèque' : '+ Ajouter ou retirer des photos'}</button>` : ''}
        ${showLibrary ? `<div class="social-compose-library">${eligible.map((x) => {
          const n = ids.indexOf(x.id);
          return `<button type="button" class="social-pick ${n >= 0 ? 'is-selected' : ''}" data-compose-add="${p(x.id)}" aria-pressed="${n >= 0}" title="${p(x.filename)}">${thumb(x.id)}${n >= 0 ? `<span class="social-compose-number">${n+1}</span>` : ''}</button>`;
        }).join('')}</div>` : ''}
        </div>
        ${prob ? `<p class="small social-err">Photo incompatible : ${p(prob)}. Retire-la ou réimporte-la avec l’option de compatibilité Instagram.</p>` : ''}
        <h2 class="social-h2">2. Légende créée par l’IA</h2>
        <div class="social-form">
          ${S.vision ? `<p class="small muted">L’IA analyse les photos sélectionnées et prépare automatiquement une légende et des hashtags. Les images choisies sont transmises à Google Gemini pour cette analyse, mais rien n’est publié sans validation.</p>` : `<p class="small muted">Pour analyser réellement les images, ajoute une clé GEMINI_API_KEY aux secrets Supabase. En attendant, NoTrack peut rédiger à partir de ta description.</p>`}
          <label>Précisions facultatives pour l’IA <input id="social-description" maxlength="500" value="${p(c.description || '')}" placeholder="Facultatif : ambiance, idée à transmettre, contexte…"></label>
          ${c.visualStatus === 'loading' ? '<p class="small muted" role="status">Analyse des photos et création des légendes en cours…</p>' : ''}
          ${c.visualStatus === 'done' ? '<p class="small social-ok" role="status">Légende générée automatiquement. Tu peux la modifier avant validation.</p>' : ''}
          ${c.visualStatus === 'error' ? `<p class="small social-err" role="alert">Analyse automatique indisponible : ${p(c.visualError)}. Tu peux saisir une légende manuellement.</p>` : ''}
          <label>Style <select id="social-style">${STYLES.map(([k, l]) => `<option value="${k}" ${k === c.style ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label class="social-inline"><input id="social-question" type="checkbox" ${c.question === false ? '' : 'checked'}> Ajouter une question pour susciter des commentaires</label>
          <div class="social-actions"><button type="button" id="social-generate" class="btn-sm" ${!S.ai && !S.vision ? 'disabled' : ''}>${S.vision ? 'Régénérer depuis les photos' : (c.variants.length ? 'Régénérer' : 'Générer 3 légendes')}</button>${!S.ai && !S.vision ? '<span class="small muted">Aucune IA configurée</span>' : ''}</div>
          <div id="social-variants">${c.variants.map((v, i) => `<div class="social-variant"><p>${p(assemble(v))}</p><div class="social-actions"><button type="button" class="btn-sm" data-use="${i}">Utiliser</button><button type="button" class="btn-sm btn-ghost" data-copy="${i}">Copier</button></div></div>`).join('')}</div>
        </div></section>
      <section class="panel"><h2>3. Valide la légende</h2>
        <div class="social-form"><label>Légende finale (modifiable) <textarea id="social-caption" maxlength="2200" rows="8" placeholder="Légende, question et hashtags…">${p(c.caption)}</textarea></label>
          <p class="small muted"><span id="social-count">${c.caption.length}</span>/2200 · ${(c.caption.match(/#[\p{L}\p{N}_]+/gu) || []).length}/30 hashtags${ids.some((id) => mediaById(id)?.is_synthetic) ? ' · la mention #CréatriceVirtuelle sera ajoutée si absente' : ''}</p>
          <div class="social-preview">${m ? thumb(m.id, 'is-preview') : '<span class="social-thumb social-thumb-empty is-preview"></span>'}<div><strong>${ids.length > 1 ? `${ids.length} photos · ` : ''}@${p(a?.username || 'compte')}</strong><p id="social-preview-text" class="small">${p(c.caption || 'Ta légende apparaîtra ici.')}</p></div></div>
          <div class="social-actions">
            <button type="button" id="social-save" class="btn-sm" ${!m || !!prob ? 'disabled' : ''}>${editing ? 'Enregistrer les modifications' : 'Valider en brouillon'}</button>
            <button type="button" id="social-save-schedule" class="btn-primary" ${!m || !!prob ? 'disabled' : ''}>${S.isAdmin ? 'Valider et passer à Buffer' : 'Valider et programmer via Meta…'}</button>
            ${editing ? '<button type="button" id="social-new" class="btn-sm btn-ghost">Nouvelle publication</button>' : ''}
          </div></div></section></div>`;
  }
  const assemble = (v) => [v.text, v.question, (v.hashtags || []).join(' ')].filter(Boolean).join('\n\n');
  function readComposer() { const c = S.composer; c.caption = $('#social-caption')?.value ?? c.caption; c.description = $('#social-description')?.value ?? c.description; c.style = $('#social-style')?.value ?? c.style; c.question = $('#social-question')?.checked ?? c.question; }
  async function saveComposer() {
    readComposer(); const c = S.composer, ids = composerIds();
    if (!ids.length || ids.length > 20 || new Set(ids).size !== ids.length) throw Error('Choisis 1 à 20 photos différentes');
    if (ids.some((id) => igProblem(mediaById(id)))) throw Error('Une photo sélectionnée est incompatible avec Instagram');
    if (!c.caption.trim()) throw Error('La légende est vide');
    const r = c.postId
      ? await call('update_post', { creator_id: S.creatorId, post_id: c.postId, media_id: ids[0], media_ids: ids, caption: c.caption })
      : await call('create_post', { creator_id: S.creatorId, media_id: ids[0], media_ids: ids, caption: c.caption, caption_style: c.style });
    c.postId = r.post.id; c.mediaId = r.post.media_id; c.mediaIds = r.post.media_ids?.length ? [...r.post.media_ids] : [...ids]; c.caption = r.post.caption;
    return r.post;
  }

  // Analyse visuelle : déclenchée à la sélection, jamais à la publication.
  let visionTimer = null, visionSeq = 0;
  function autoGenerateFromPhotos(force = false) {
    const c = S.composer, ids = composerIds();
    if (!S.vision || !ids.length || !S.creatorId) return;
    if (!force && (c.manualCaption || (c.visualStatus === 'done' && c.visualKey === ids.join('|')))) return;
    if (visionTimer) clearTimeout(visionTimer);
    const seq = ++visionSeq, key = ids.join('|'), creatorId = S.creatorId;
    c.visualKey = key; c.visualStatus = 'loading'; c.visualError = '';
    draw();
    visionTimer = setTimeout(async () => {
      try {
        const r = await call('generate_visual_captions', {
          creator_id: creatorId, media_ids: ids, style: c.style,
          description: c.description || '', include_question: c.question !== false,
        });
        if (seq !== visionSeq || S.composer !== c || S.creatorId !== creatorId || composerIds().join('|') !== key) return;
        if (!Array.isArray(r.variants) || !r.variants.length || !r.variants.every((v) => v && typeof v.text === 'string' && Array.isArray(v.hashtags))) throw Error('Réponse IA incomplète');
        c.variants = r.variants;
        if (!c.manualCaption) {
          c.caption = assemble(r.variants[0]);
          c.autoCaption = c.caption;
        }
        c.visualStatus = 'done'; c.visualError = '';
        draw();
      } catch (e) {
        if (seq !== visionSeq || S.composer !== c || S.creatorId !== creatorId || composerIds().join('|') !== key) return;
        c.visualStatus = 'error'; c.visualError = e?.message || 'Service inaccessible';
        draw();
      }
    }, force ? 0 : 700);
  }
  function composerPhotosChanged() {
    const c = S.composer;
    if (visionTimer) clearTimeout(visionTimer);
    ++visionSeq;
    if (c.autoCaption && c.caption === c.autoCaption && !c.manualCaption) c.caption = '';
    c.variants = []; c.visualStatus = ''; c.visualKey = ''; c.visualError = ''; c.autoCaption = '';
    draw();
    autoGenerateFromPhotos();
  }

  // ---------- Schedule dialog ----------
  function pad(n) { return String(n).padStart(2, '0'); }
  function localInput(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; }
  function scheduleDialog(post) {
    const a = account();
    if (!a || a.state !== 'connected') { toast('Connecte d’abord le compte Instagram du créateur', true); S.tab = 'accounts'; draw(); return; }
    const m = mediaById(post.media_id), prob = igProblem(m);
    if (prob) { toast(prob, true); return; }
    const min = new Date(Date.now() + 5 * 60_000), def = new Date(Date.now() + 60 * 60_000); def.setMinutes(0, 0, 0); if (def < min) def.setHours(def.getHours() + 1);
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const d = document.createElement('dialog'); d.className = 'social-dialog';
    d.innerHTML = `<form method="dialog" class="social-form"><h2>Programmer la publication</h2>
      <div class="social-preview">${thumb(post.media_id, 'is-preview')}<p class="small">${p(post.caption.slice(0, 280))}${post.caption.length > 280 ? '…' : ''}</p></div>
      <label>Compte <select disabled><option>@${p(a.username)}</option></select></label>
      <label>Date et heure <input type="datetime-local" id="sd-at" required min="${localInput(min)}" value="${localInput(def)}" step="60"></label>
      <p class="small muted">Fuseau : ${p(tz)}. La publication part du serveur Supabase : ton ordinateur peut rester éteint.</p>
      ${S.scheduler.active ? '' : '<p class="small social-err">Le planificateur automatique est en pause : la publication attendra son activation.</p>'}
      <label class="social-inline"><input type="checkbox" id="sd-ok" required> Je confirme que cette image est non explicite, conforme aux règles d’Instagram et autorisée à être publiée sur @${p(a.username)}.</label>
      <p id="sd-err" class="small social-err" role="alert"></p>
      <div class="social-actions"><button value="cancel" formnovalidate class="btn-sm btn-ghost">Annuler</button><button id="sd-go" value="go" class="btn-primary">Programmer</button></div></form>`;
    document.body.append(d); d.addEventListener('close', () => d.remove()); d.showModal();
    const go = d.querySelector('#sd-go');
    go.onclick = async (ev) => {
      ev.preventDefault();
      const v = d.querySelector('#sd-at').value, okBox = d.querySelector('#sd-ok').checked, err = d.querySelector('#sd-err');
      if (!v) { err.textContent = 'Choisis une date.'; return; } if (!okBox) { err.textContent = 'Coche la confirmation.'; return; }
      const at = new Date(v); if (!(at.getTime() > Date.now() + 5 * 60_000)) { err.textContent = 'Choisis une heure au moins 5 minutes dans le futur.'; return; }
      busy(go, true);
      const send = (allow) => call('schedule_post', { creator_id: S.creatorId, post_id: post.id, account_id: a.id, scheduled_at: at.toISOString(), approved_non_explicit: true, allow_repost: allow });
      try {
        let r; try { r = await send(false); } catch (e) { if (e.data?.needs_repost_confirmation && confirm(e.message)) r = await send(true); else throw e; }
        d.close(); S.composer = newComposer();
        toast(r.scheduler_active ? 'Publication programmée pour le ' + fmtDate(at.toISOString()) : 'Programmée — en attente de l’activation du planificateur');
        S.tab = 'posts'; await refresh();
      } catch (e) { err.textContent = e.message; } finally { busy(go, false); }
    };
  }

  // ---------- Posts ----------
  function postsView() {
    const F = [['all', 'Toutes'], ['draft', 'Brouillons'], ['scheduled', 'Planifiées'], ['processing', 'En cours'], ['published', 'Publiées'], ['unknown', 'À vérifier'], ['failed', 'Échecs'], ['cancelled', 'Annulées']];
    const list = S.posts.filter((x) => S.filter === 'all' || x.state === S.filter);
    return `<section class="panel"><div class="social-gallery-head"><h2>Publications</h2><button type="button" id="social-reload" class="btn-sm btn-ghost">Actualiser</button></div>
      <div class="social-filters">${F.map(([k, l]) => { const n = k === 'all' ? S.posts.length : S.posts.filter((x) => x.state === k).length; return `<button type="button" class="btn-sm ${S.filter === k ? 'social-selected' : ''}" data-filter="${k}">${l} <span class="muted">${n}</span></button>`; }).join('')}</div>
      ${list.length ? list.map(postRow).join('') : '<p class="muted">Aucune publication dans cette catégorie.</p>'}</section>`;
  }
  function postRow(x) {
    const act = [];
    if (x.state === 'draft') act.push(`<button type="button" class="btn-sm" data-edit="${p(x.id)}">Modifier</button>`, `<button type="button" class="btn-sm btn-primary" data-schedule="${p(x.id)}">Programmer</button>`);
    if (x.state === 'scheduled') act.push(`<button type="button" class="btn-sm" data-unschedule="${p(x.id)}">Retirer du planning</button>`);
    if (['draft', 'scheduled'].includes(x.state)) act.push(`<button type="button" class="btn-sm btn-danger" data-cancel="${p(x.id)}">Annuler</button>`);
    if (x.state === 'unknown') act.push(`<button type="button" class="btn-sm" data-recheck="${p(x.id)}">Vérifier maintenant</button>`, `<button type="button" class="btn-sm btn-danger" data-notpublished="${p(x.id)}">Non publiée</button>`);
    if (['failed', 'cancelled', 'published'].includes(x.state)) act.push(`<button type="button" class="btn-sm" data-duplicate="${p(x.id)}">Dupliquer en brouillon</button>`);
    if (x.external_permalink) act.push(`<a class="btn-sm" href="${p(x.external_permalink)}" target="_blank" rel="noopener noreferrer">Voir sur Instagram</a>`);
    act.push(`<button type="button" class="btn-sm btn-ghost" data-events="${p(x.id)}" aria-expanded="false">Historique</button>`);
    const dateLine = x.state === 'published' ? `Publiée le ${when(x.published_at)}` : x.scheduled_at ? `Prévue le ${when(x.scheduled_at)}` : `Créée le ${when(x.created_at)}`;
    return `<article class="social-entry">${thumb(x.media_id, 'is-md')}<div class="social-entry-body"><div class="social-entry-top">${pill(x.state)}<strong>${dateLine}${(x.media_ids || []).length > 1 ? ` · ${x.media_ids.length} photos` : ''}</strong></div>
      <p class="small social-caption">${p(x.caption || '(sans légende)')}</p>
      ${x.last_error && x.state !== 'published' ? `<p class="small ${['failed', 'unknown'].includes(x.state) ? 'social-err' : 'muted'}">${p(x.last_error)}</p>` : ''}
      ${x.state === 'unknown' ? '<p class="small muted">Relais IA vérifie automatiquement le compte. Ne republie pas manuellement avant d’avoir vérifié sur Instagram.</p>' : ''}
      <div class="social-actions">${act.join('')}</div><ol class="social-events" id="ev-${p(x.id)}" hidden></ol></div></article>`;
  }


  // ---------- Buffer (separate personal API-key bridge; NO Meta App required) ----------
  const bufferCall = async (action, body = {}) => {
    const { data, error } = await sb.functions.invoke('buffer-bridge', { body: { action, creator_id: S.creatorId, ...body } });
    if (error) { let message = error.message; try { const detail = await error.context.json(); message = detail.error || message; } catch {} throw Error(message); }
    if (data?.error) throw Error(data.error);
    return data;
  };
  async function loadBuffer() {
    S.buffer.error = '';
    if (!S.creatorId) return;
    const r = await bufferCall('status');
    S.buffer.configured = !!r.configured;
    S.buffer.channels = r.channels || [];
    S.buffer.jobs = r.jobs || [];
    S.buffer.error = r.error || '';
    S.buffer.loaded = true;
    if (!S.buffer.channels.some((c) => c.id === S.buffer.channelId)) S.buffer.channelId = S.buffer.channels[0]?.id || '';
  }
  function bufferView() {
    const b = S.buffer;
    const existing = new Set(b.jobs.map((x) => x.source_post_id));
    const drafts = S.posts.filter((x) => x.state === 'draft' && !existing.has(x.id) && !igProblem(mediaById(x.media_id)));
    const chosen = drafts.find((x) => x.id === b.draftId) || drafts[0] || null;
    if (chosen && b.draftId !== chosen.id) { b.draftId = chosen.id; b.mediaIds = chosen.media_ids?.length ? [...chosen.media_ids] : [chosen.media_id]; b.confirmed = false; }
    if (!chosen) { b.draftId = ''; b.mediaIds = []; }
    if (chosen && (b.mediaIds[0] !== chosen.media_id || b.mediaIds.some((id) => igProblem(mediaById(id))))) b.mediaIds = chosen.media_ids?.length ? [...chosen.media_ids] : [chosen.media_id];
    const mediaOptions = S.media.filter((m) => m.state === 'ready' && !igProblem(m));
    const defaultTime = new Date(Date.now() + 2 * 60 * 60 * 1000); defaultTime.setMinutes(0, 0, 0);
    const maxTime = new Date(Date.now() + 14 * 86400_000);
    const statusLabel = { pending: 'En cours chez Buffer', queued: 'Programmé chez Buffer', failed: 'Refusé par Buffer', uncertain: 'Statut incertain : vérifier Buffer' };
    return `<section class="panel"><div class="social-gallery-head"><div><h2>Buffer — programmation Instagram</h2><p class="muted small">Cette intégration est indépendante de Meta for Developers. Buffer reçoit les publications validées et gère leur diffusion.</p></div>
      <button type="button" class="btn-sm btn-ghost" id="buffer-reload">Actualiser</button></div>
      ${b.loading ? '<p class="muted">Connexion à Buffer…</p>' : ''}
      ${b.error ? `<p class="social-err" role="alert">${p(b.error)}</p>` : ''}
      ${!b.configured ? `<p class="social-err">Buffer n'est pas encore configuré sur le serveur.</p><ol><li>Connecte le compte Instagram professionnel <strong>@starelyna</strong> dans <a href="https://buffer.com/" target="_blank" rel="noopener noreferrer">Buffer</a>.</li><li>Crée une clé dans <a href="https://publish.buffer.com/settings/api" target="_blank" rel="noopener noreferrer">Paramètres Buffer → API</a>.</li><li>Ajoute <code>BUFFER_API_KEY</code> et <code>BUFFER_MEDIA_SIGNING_KEY</code> dans les secrets Supabase puis déploie <code>buffer-bridge</code>. Ne colle jamais ta clé ici.</li></ol>` :
      `<div class="social-form"><p class="social-ok">Connexion API Buffer disponible · ${b.channels.length} compte(s) Instagram détecté(s).</p>
        ${b.channels.length ? `<label>Compte Instagram dans Buffer<select id="buffer-channel">${b.channels.map((c) => `<option value="${p(c.id)}" ${c.id === b.channelId ? 'selected' : ''}>${p(c.name)} (${p(c.organization_name)})</option>`).join('')}</select></label>` : '<p class="social-err">Connecte un compte Instagram professionnel à Buffer pour continuer.</p>'}
        <label>Brouillon RelaisIA<select id="buffer-draft">${drafts.length ? drafts.map((x) => `<option value="${p(x.id)}" ${x.id === b.draftId ? 'selected' : ''}>${p(x.caption.slice(0, 92))}</option>`).join('') : '<option value="">Aucun brouillon prêt</option>'}</select></label>
        ${chosen ? `<style>.social-carousel-picker{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0}.social-carousel-picker .social-pick{position:relative;width:104px;height:120px}.social-carousel-order{position:absolute;top:4px;right:4px;background:#192445;color:white;border-radius:50%;width:24px;height:24px;display:grid;place-items:center;font-weight:bold;font-size:12px}.social-carousel-control{border:1px solid var(--line);border-radius:12px;padding:12px}</style><div class="social-carousel-control"><strong>Photos de la publication · ${b.mediaIds.length}/20</strong>
          <p class="small muted">La première est celle du brouillon. Clique sur les autres photos dans l’ordre souhaité pour créer un carrousel. Clique à nouveau pour retirer une photo.</p>
          <div class="social-carousel-picker">${mediaOptions.map((m) => {
            const position = b.mediaIds.indexOf(m.id), isCover = m.id === chosen.media_id;
            return `<button type="button" class="social-pick ${position >= 0 ? 'is-selected' : ''}" data-buffer-photo="${p(m.id)}" aria-pressed="${position >= 0}" title="${p(m.filename)}${isCover ? ' — image de couverture' : ''}">${thumb(m.id)}${position >= 0 ? `<span class="social-carousel-order">${position + 1}</span>` : ''}</button>`;
          }).join('')}</div>
          <p class="small muted">${b.mediaIds.length > 1 ? 'Carrousel : ' + b.mediaIds.length + ' photos, envoyées dans cet ordre.' : 'Publication à photo unique. Sélectionne d’autres images pour un carrousel.'}</p>
        </div>` : ''}
        <label>Date de publication (heure locale)<input type="datetime-local" id="buffer-when" min="${localInput(new Date(Date.now() + 10 * 60_000))}" max="${localInput(maxTime)}" value="${p(b.dateValue || localInput(defaultTime))}"></label>
        <p class="small muted">Choisis une date entre 10 minutes et 14 jours. Les photos sont transmises via des liens signés qui restent accessibles à Buffer jusqu'à la publication.</p>
        <label class="social-inline"><input type="checkbox" id="buffer-confirm" ${b.confirmed ? 'checked' : ''}> Je confirme que le contenu est autorisé, non explicite et prêt à être programmé sur le compte Instagram sélectionné.</label>
        <button type="button" id="buffer-submit" class="btn-primary" ${!drafts.length || !b.channels.length ? 'disabled' : ''}>${b.mediaIds.length > 1 ? 'Programmer le carrousel' : 'Programmer via Buffer'}</button>
        <p class="small muted">L'envoi à Buffer programme réellement un post. Aucune publication n'est envoyée avant de cliquer et confirmer. Le planificateur Meta de RelaisIA n'est pas utilisé.</p></div>`}
      <div class="social-gallery-head"><h3>Historique des envois à Buffer</h3></div>
      ${b.jobs.length ? b.jobs.map((j) => `<div class="social-compact"><div><strong>${p(statusLabel[j.status] || j.status)} · ${when(j.due_at)}</strong><p class="small muted">${p(j.caption.slice(0, 120))}</p>${j.last_error ? `<p class="small social-err">${p(j.last_error)}</p>` : ''}${j.buffer_post_id ? `<p class="small muted">ID Buffer : ${p(j.buffer_post_id)} · statut Instagram à vérifier dans Buffer</p>` : ''}</div></div>`).join('') : '<p class="muted">Aucun envoi Buffer pour ce créateur.</p>'}
      <p class="small muted">Le statut « Programmé chez Buffer » n'est pas une confirmation de publication sur Instagram. Vérifie l'état final dans Buffer.</p></section>`;
  }

  // ---------- Calendar ----------
  function monthStart(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  function calendarView() {
    const m0 = S.month, y = m0.getFullYear(), mo = m0.getMonth(), first = (m0.getDay() + 6) % 7, days = new Date(y, mo + 1, 0).getDate();
    const key = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const byDay = new Map();
    for (const x of S.posts) { const t = x.state === 'published' ? x.published_at : x.scheduled_at; if (!t || x.state === 'cancelled') continue; const k = key(new Date(t)); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push({ ...x, t }); }
    const today = key(new Date()), cells = [];
    for (let i = 0; i < first; i++) cells.push('<div class="social-day is-out" aria-hidden="true"></div>');
    for (let d = 1; d <= days; d++) {
      const k = `${y}-${mo}-${d}`, items = (byDay.get(k) || []).sort((a, b) => a.t.localeCompare(b.t));
      cells.push(`<div class="social-day ${k === today ? 'is-today' : ''}"><span class="social-daynum">${d}</span>${items.map((x) => `<div class="social-cal-item s-${p(x.state)}" title="${p(STATUS[x.state])} — ${p(x.caption.slice(0, 80))}">${new Date(x.t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} ${p(STATUS[x.state])}</div>`).join('')}</div>`);
    }
    const upcoming = S.posts.filter((x) => ['scheduled', 'processing'].includes(x.state)).sort((a, b) => String(a.scheduled_at).localeCompare(String(b.scheduled_at)));
    return `<section class="panel"><div class="social-gallery-head"><h2>${m0.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })}</h2>
        <div class="social-actions"><button type="button" class="btn-sm" data-month="-1" aria-label="Mois précédent">‹</button><button type="button" class="btn-sm" data-month="0">Aujourd’hui</button><button type="button" class="btn-sm" data-month="1" aria-label="Mois suivant">›</button></div></div>
      <div class="social-cal" role="grid"><div class="social-dow">Lun</div><div class="social-dow">Mar</div><div class="social-dow">Mer</div><div class="social-dow">Jeu</div><div class="social-dow">Ven</div><div class="social-dow">Sam</div><div class="social-dow">Dim</div>${cells.join('')}</div>
      <p class="hint">Heures affichées dans le fuseau de ton appareil (${p(Intl.DateTimeFormat().resolvedOptions().timeZone)}).</p></section>
      <section class="panel"><h2>File d’attente</h2>${upcoming.length ? upcoming.map(rowCompact).join('') : '<p class="muted">Aucune publication en attente.</p>'}</section>`;
  }

  // ---------- Render + bindings ----------
  function draw() {
    const views = { overview, accounts: accountsView, media: mediaView, compose: composeView, posts: postsView, calendar: calendarView, buffer: bufferView };
    layout(!S.creators.length ? '<section class="panel"><h2>Bienvenue</h2><p>Crée un espace créateur pour commencer.</p></section>' : (views[S.tab] || overview)());
    const on = (sel, fn) => $$(sel).forEach((b) => b.onclick = (e) => fn(b, e));
    const act = (fn, msg) => async (b) => { busy(b, true); try { await fn(b); if (msg) toast(msg); await refresh(); } catch (e) { if (e?.message !== 'Annulé') fail(e); } finally { busy(b, false); } };
    if (S.tab === 'accounts') {
      const c = $('#social-connect'); if (c) c.onclick = async () => { busy(c, true); try { const r = await call('oauth_start', { creator_id: S.creatorId }); location.assign(r.url); } catch (e) { fail(e); busy(c, false); } };
      on('[data-disconnect]', async (b) => { if (!confirm('Déconnecter ce compte ? Le token est supprimé et les publications planifiées repassent en brouillon.')) return; try { const r = await call('disconnect', { creator_id: S.creatorId, account_id: b.dataset.disconnect }); await loadStatus(); await refresh(); toast(`Compte déconnecté${r.unscheduled ? ` · ${r.unscheduled} publication(s) remise(s) en brouillon` : ''}`); } catch (e) { fail(e); } });
      const s = $('#social-scheduler'); if (s) s.onclick = async () => {
        const activate = !S.scheduler.active;
        if (activate && prompt('Activer la publication automatique réelle sur Instagram ?\nLes publications planifiées seront envoyées à leur heure.\nTape ACTIVER pour confirmer.') !== 'ACTIVER') return;
        if (!activate && !confirm('Mettre en pause ? Les publications planifiées attendront.')) return;
        busy(s, true); try { const r = await call('scheduler_set', { active: activate, confirm: activate ? 'ACTIVER' : '' }); S.scheduler = r.scheduler; draw(); toast(activate ? 'Publication automatique activée' : 'Planificateur en pause'); } catch (e) { fail(e); } finally { busy(s, false); }
      };
    }
    if (S.tab === 'media') {
      const drop = $('#social-drop'), input = $('#social-files');
      if (drop && S.creatorId) {
        drop.onclick = () => input.click(); drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } };
        drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('is-over'); }; drop.ondragleave = () => drop.classList.remove('is-over');
        drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('is-over'); importFiles(e.dataTransfer.files); };
        input.onchange = () => { importFiles(input.files); input.value = ''; };
      }
      on('[data-preview]', (b) => preview(b.dataset.preview));
      $$('[data-select]').forEach((c) => c.onchange = () => { c.checked ? S.selected.add(c.dataset.select) : S.selected.delete(c.dataset.select); draw(); });
      on('#social-clear-selection', () => { S.selected.clear(); draw(); });
      on('#social-compose-selected', () => { const ids = [...S.selected].filter((id) => !igProblem(mediaById(id))).slice(0, 20); if (!ids.length) { toast('Sélectionne des images compatibles Instagram', true); return; } S.composer = { ...newComposer(), mediaId: ids[0], mediaIds: ids, showLibrary: false }; S.tab = 'compose'; draw(); autoGenerateFromPhotos(); if (S.selected.size > 20) toast('20 photos maximum : les autres ne sont pas incluses', true); });
      on('#social-archive-selected', act(async () => { if (!confirm(`Archiver ${S.selected.size} photo(s) ? Elles restent stockées en privé.`)) throw Error('Annulé'); const r = await call('archive_media', { creator_id: S.creatorId, media_ids: [...S.selected] }); S.selected.clear(); toast(`${r.archived} archivée(s)${r.blocked ? `, ${r.blocked} bloquée(s) car programmée(s)` : ''}`); }));
    }
    if (S.tab === 'compose') {
      on('[data-compose-add]', (b) => { readComposer(); const ids = composerIds(), id = b.dataset.composeAdd, index = ids.indexOf(id); if (index >= 0) ids.splice(index, 1); else if (ids.length < 20) ids.push(id); else { toast('20 photos maximum', true); return; } S.composer.mediaIds = ids; S.composer.mediaId = ids[0] || ''; composerPhotosChanged(); });
      on('[data-compose-remove]', (b) => { readComposer(); const ids = composerIds().filter((id) => id !== b.dataset.composeRemove); S.composer.mediaIds = ids; S.composer.mediaId = ids[0] || ''; composerPhotosChanged(); });
      const movePhoto = (id, direction) => { readComposer(); const ids = composerIds(), from = ids.indexOf(id), to = from + direction; if (from < 0 || to < 0 || to >= ids.length) return; [ids[from], ids[to]] = [ids[to], ids[from]]; S.composer.mediaIds = ids; S.composer.mediaId = ids[0]; composerPhotosChanged(); };
      on('[data-compose-up]', (b) => movePhoto(b.dataset.composeUp, -1));
      on('[data-compose-down]', (b) => movePhoto(b.dataset.composeDown, 1));
      on('#social-toggle-gallery', () => { readComposer(); S.composer.showLibrary = !S.composer.showLibrary; draw(); });
      const cap = $('#social-caption'); if (cap) cap.oninput = () => { S.composer.manualCaption = true; S.composer.caption = cap.value; $('#social-count').textContent = cap.value.length; $('#social-preview-text').textContent = cap.value || 'Ta légende apparaîtra ici.'; };
      on('#social-generate', async (b) => {
        readComposer(); const c = S.composer;
        if (S.vision) { c.manualCaption = false; autoGenerateFromPhotos(true); return; }
        if ((c.description || '').trim().length < 3) { toast('Décris la photo en quelques mots', true); return; }
        busy(b, true); b.textContent = 'Génération…';
        try {
          const r = await call('generate_captions', { creator_id: S.creatorId, description: c.description, style: c.style, include_question: c.question !== false, regenerate: c.variants.length > 0 });
          if (!Array.isArray(r.variants) || !r.variants.length || !r.variants.every((v) => v && typeof v.text === 'string' && Array.isArray(v.hashtags))) throw Error('Format des légendes incompatible avec l’API Social V3');
          c.variants = r.variants; draw();
        }
        catch (e) { fail(e); busy(b, false); b.textContent = c.variants.length ? 'Régénérer' : 'Générer 3 légendes'; }
      });
      on('[data-use]', (b) => { readComposer(); S.composer.manualCaption = true; S.composer.caption = assemble(S.composer.variants[Number(b.dataset.use)]); draw(); $('#social-caption')?.focus(); });
      on('[data-copy]', async (b) => { try { await navigator.clipboard.writeText(assemble(S.composer.variants[Number(b.dataset.copy)])); toast('Copié'); } catch { toast('Copie impossible', true); } });
      on('#social-save', async (b) => { busy(b, true); try { await saveComposer(); toast('Brouillon enregistré avec ' + composerIds().length + ' photo(s)'); S.composer = newComposer(); S.selected.clear(); S.tab = 'posts'; S.filter = 'draft'; await refresh(); } catch (e) { fail(e); } finally { busy(b, false); } });
      on('#social-save-schedule', async (b) => { busy(b, true); try { const post = await saveComposer(); await loadData(); if (S.isAdmin) { S.buffer.draftId = post.id; S.buffer.mediaIds = post.media_ids?.length ? [...post.media_ids] : [post.media_id]; S.buffer.confirmed = false; S.tab = 'buffer'; await loadBuffer(); S.selected.clear(); S.composer = newComposer(); draw(); toast('Brouillon prêt pour Buffer : vérifie les photos et l’heure avant de programmer.'); } else { if ((post.media_ids || []).length > 1) throw Error('Pour un carrousel, utilise Buffer'); draw(); scheduleDialog(post); } } catch (e) { fail(e); } finally { busy(b, false); } });
      on('#social-new', () => { S.composer = newComposer(); draw(); });
    }
    if (S.tab === 'posts') {
      on('[data-filter]', (b) => { S.filter = b.dataset.filter; draw(); });
      on('#social-reload', act(async () => { }));
      on('[data-edit]', (b) => { const x = S.posts.find((y) => y.id === b.dataset.edit); S.composer = { ...newComposer(), mediaId: x.media_id, mediaIds: x.media_ids?.length ? [...x.media_ids] : [x.media_id], showLibrary: false, postId: x.id, caption: x.caption, style: x.caption_style || 'naturel' }; S.tab = 'compose'; draw(); });
      on('[data-schedule]', (b) => scheduleDialog(S.posts.find((y) => y.id === b.dataset.schedule)));
      on('[data-unschedule]', act((b) => call('unschedule_post', { creator_id: S.creatorId, post_id: b.dataset.unschedule }), 'Remise en brouillon'));
      on('[data-cancel]', act(async (b) => { if (!confirm('Annuler cette publication ?')) throw Error('Annulé'); await call('cancel_post', { creator_id: S.creatorId, post_id: b.dataset.cancel }); }, 'Publication annulée'));
      on('[data-duplicate]', act((b) => call('duplicate_post', { creator_id: S.creatorId, post_id: b.dataset.duplicate }), 'Copie créée en brouillon'));
      on('[data-recheck]', act((b) => call('recheck_post', { creator_id: S.creatorId, post_id: b.dataset.recheck }), 'Vérification demandée (prochaine minute)'));
      on('[data-notpublished]', act(async (b) => { if (!confirm('Confirmes-tu avoir vérifié sur Instagram que ce post N’A PAS été publié ?')) throw Error('Annulé'); await call('resolve_unknown', { creator_id: S.creatorId, post_id: b.dataset.notpublished, outcome: 'not_published' }); }, 'Marquée non publiée'));
      on('[data-events]', async (b) => {
        const box = $('#ev-' + CSS.escape(b.dataset.events)); if (!box) return;
        if (!box.hidden) { box.hidden = true; b.setAttribute('aria-expanded', 'false'); return; }
        try { const r = await call('post_events', { creator_id: S.creatorId, post_id: b.dataset.events }); box.innerHTML = (r.events || []).map((e) => `<li><span class="muted">${when(e.created_at)}</span> ${p(EVENTS[e.event] || e.event)}${e.detail && !/^(\d+|C\w+)$/.test(e.detail) ? ` — <span class="muted">${p(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(e.detail) ? 'pour le ' + when(e.detail) : e.detail)}</span>` : ''}</li>`).join('') || '<li class="muted">Aucun événement</li>'; box.hidden = false; b.setAttribute('aria-expanded', 'true'); } catch (e) { fail(e); }
      });
    }
    if (S.tab === 'buffer') {
      on('#buffer-reload', async (b) => { busy(b, true); try { await loadBuffer(); await loadData(); draw(); } catch (e) { S.buffer.error = e.message || 'Erreur'; draw(); } finally { busy(b, false); } });
      const c = $('#buffer-channel'); if (c) c.onchange = () => { S.buffer.channelId = c.value; S.buffer.confirmed = false; $('#buffer-confirm').checked = false; };
      const draftSelect = $('#buffer-draft'); if (draftSelect) draftSelect.onchange = () => {
        S.buffer.draftId = draftSelect.value;
        const draft = S.posts.find((x) => x.id === S.buffer.draftId);
        S.buffer.mediaIds = draft ? (draft.media_ids?.length ? [...draft.media_ids] : [draft.media_id]) : [];
        S.buffer.dateValue = $('#buffer-when')?.value || '';
        S.buffer.confirmed = false;
        draw();
      };
      on('[data-buffer-photo]', (b) => {
        const id = b.dataset.bufferPhoto, cover = S.posts.find((x) => x.id === S.buffer.draftId)?.media_id;
        if (!cover || id === cover) return;
        const selected = S.buffer.mediaIds, at = selected.indexOf(id);
        if (at >= 0) selected.splice(at, 1);
        else if (selected.length < 20) selected.push(id);
        else { toast('20 images maximum par carrousel', true); return; }
        S.buffer.dateValue = $('#buffer-when')?.value || '';
        S.buffer.confirmed = false;
        draw();
      });
      const dt = $('#buffer-when'); if (dt) dt.onchange = () => { S.buffer.dateValue = dt.value; };
      const ck = $('#buffer-confirm'); if (ck) ck.onchange = () => { S.buffer.confirmed = ck.checked; };
      const submit = $('#buffer-submit'); if (submit) submit.onclick = async () => {
        const id = $('#buffer-draft')?.value, dateValue = $('#buffer-when')?.value;
        const ok = $('#buffer-confirm')?.checked;
        if (!id || !dateValue || !S.buffer.channelId) { toast('Sélectionne un brouillon, un compte et une date', true); return; }
        if (!ok) { toast('Confirme la publication avant de continuer', true); return; }
        const date = new Date(dateValue);
        if (!(date.getTime() > Date.now() + 10 * 60_000) || date.getTime() > Date.now() + 14 * 86400_000) { toast('Date entre 10 minutes et 14 jours requise', true); return; }
        const chan = S.buffer.channels.find((x) => x.id === S.buffer.channelId);
        if (!confirm(`Programmer réellement ${S.buffer.mediaIds.length} photo(s) dans une seule publication via Buffer sur ${chan?.name || 'Instagram'} pour le ${fmtDate(date.toISOString())} ?`)) return;
        busy(submit, true);
        try {
          const result = await bufferCall('schedule', { post_id: id, channel_id: S.buffer.channelId, due_at: date.toISOString(), media_ids: S.buffer.mediaIds, confirm: true });
          toast(result.warning || 'Publication enregistrée chez Buffer');
          await loadBuffer(); await loadData(); draw();
        } catch (e) { fail(e); try { await loadBuffer(); await loadData(); draw(); } catch {} }
        finally { busy(submit, false); }
      };
    }
    if (S.tab === 'calendar') on('[data-month]', (b) => { const n = Number(b.dataset.month); S.month = n === 0 ? monthStart(new Date()) : new Date(S.month.getFullYear(), S.month.getMonth() + n, 1); draw(); });
  }

  try { await loadStatus(); await loadData(); draw(); }
  catch (e) { main.innerHTML = '<section class="panel"><h2>Social Automation</h2><p>Le service Social Automation est inaccessible. Vérifie le déploiement de la fonction Supabase <code>social-api</code>.</p></section>'; fail(e); }
  // Live refresh while posts are in flight (only while this view is mounted)
  const timer = setInterval(async () => {
    if (!main.isConnected || !main.querySelector('.social-page')) { clearInterval(timer); return; }
    if (document.hidden) return;
    if (Date.now() - S.urlsUpdatedAt > 12 * 60_000 && S.creatorId) { try { await refresh(); } catch { } return; }
    if (!S.posts.some((x) => ['processing', 'unknown'].includes(x.state) || (x.state === 'scheduled' && Date.parse(x.scheduled_at) < Date.now() + 120_000))) return;
    if (['posts', 'overview', 'calendar'].includes(S.tab)) { try { await refresh(); } catch { } }
  }, 30_000);
}
