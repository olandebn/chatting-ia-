// Social Automation V2 — Instagram Autopost. Isolated view; does not touch Telegram services.
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
  const S = { creators: [], accounts: [], media: [], posts: [], urls: {}, creatorId: '', tab: 'overview', configured: false, ai: false, scheduler: { active: false }, isAdmin: false, redirect: '', selected: new Set(), filter: 'all', month: monthStart(new Date()), composer: { mediaId: '', postId: '', caption: '', variants: [], style: 'naturel' }, uploads: [] };
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
    Object.assign(S, { creators: r.creators || [], accounts: r.accounts || [], configured: !!r.instagram_configured, ai: !!r.ai_configured, scheduler: r.scheduler || { active: false }, isAdmin: !!r.is_admin, redirect: r.redirect_uri || '' });
    if (!S.creators.some((c) => c.id === S.creatorId)) S.creatorId = S.creators[0]?.id || '';
  }
  async function loadData() {
    if (!S.creatorId) { S.media = []; S.posts = []; return; }
    const r = await call('dashboard', { creator_id: S.creatorId });
    S.media = r.media || []; S.posts = r.posts || [];
    const need = S.media.filter((m) => m.state === 'ready' && !S.urls[m.id]).map((m) => m.id);
    for (let i = 0; i < need.length; i += 60) { try { Object.assign(S.urls, (await call('media_urls', { creator_id: S.creatorId, media_ids: need.slice(i, i + 60) })).urls || {}); } catch { } }
  }
  async function refresh() { await loadData(); draw(); }

  // ---------- Layout ----------
  const TABS = [['overview', 'Vue d’ensemble'], ['accounts', 'Compte Instagram'], ['media', 'Médias'], ['compose', 'Nouvelle publication'], ['posts', 'Publications'], ['calendar', 'Calendrier']];
  function layout(content) {
    main.innerHTML = `<div class="social-page">
      <div class="main-head"><div><h1>Social Automation</h1><p>Importe tes photos, rédige les légendes avec l’IA et programme tes publications Instagram.</p></div></div>
      ${S.banner ? `<div class="social-banner ${S.banner.err ? 'is-error' : 'is-ok'}" role="status">${p(S.banner.msg)}<button type="button" class="btn-ghost btn-sm" data-close-banner aria-label="Fermer">×</button></div>` : ''}
      <section class="panel social-toolbar"><label for="social-creator">Créateur</label>
        <select id="social-creator">${S.creators.length ? '' : '<option value="">Aucun</option>'}${S.creators.map((c) => `<option value="${p(c.id)}" ${c.id === S.creatorId ? 'selected' : ''}>${p(c.name)}</option>`).join('')}</select>
        <button type="button" id="social-new-creator" class="btn-sm">+ Nouveau créateur</button>
        <span class="social-toolbar-status">${igBadge()}</span></section>
      <nav class="social-tabs" role="tablist" aria-label="Social Automation">${TABS.map(([id, label]) => `<button type="button" role="tab" class="btn-sm ${S.tab === id ? 'social-selected' : ''}" data-tab="${id}" aria-selected="${S.tab === id}">${label}</button>`).join('')}</nav>
      ${content}</div>`;
    $('#social-creator').onchange = async (e) => { S.creatorId = e.target.value; S.selected.clear(); S.composer = { ...S.composer, mediaId: '', postId: '', caption: '', variants: [] }; try { await refresh(); } catch (err) { fail(err); } };
    $('#social-new-creator').onclick = async () => { const name = prompt('Nom du créateur (ex : Elyna Moreau)'); if (!name?.trim()) return; try { const r = await call('create_creator', { name: name.trim() }); S.creators.push(r.creator); S.creatorId = r.creator.id; await refresh(); toast('Créateur créé'); } catch (e) { fail(e); } };
    $$('[data-tab]').forEach((b) => b.onclick = () => { S.tab = b.dataset.tab; draw(); });
    $('[data-close-banner]')?.addEventListener('click', () => { S.banner = null; draw(); });
  }
  function igBadge() {
    const a = account();
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
  function composeView() {
    const c = S.composer, eligible = S.media.filter((m) => m.state === 'ready'), m = mediaById(c.mediaId), prob = m ? igProblem(m) : null, a = account();
    const editing = c.postId ? S.posts.find((x) => x.id === c.postId) : null;
    return `<div class="social-compose">
      <section class="panel"><h2>${editing ? 'Modifier le brouillon' : '1. Choisis une photo'}</h2>
        ${editing ? '' : eligible.length ? `<div class="social-picker">${eligible.map((x) => `<button type="button" class="social-pick ${x.id === c.mediaId ? 'is-selected' : ''}" data-pick-media="${p(x.id)}" aria-pressed="${x.id === c.mediaId}" title="${p(x.filename)}${igProblem(x) ? ' — ' + p(igProblem(x)) : ''}">${thumb(x.id)}${igProblem(x) ? '<span class="social-pick-warn">!</span>' : ''}</button>`).join('')}</div>` : '<p class="muted">Importe d’abord des photos dans l’onglet Médias.</p>'}
        ${prob ? `<p class="small social-err">Cette photo ne pourra pas être programmée : ${p(prob)}. Réimporte-la avec l’option de compatibilité Instagram.</p>` : ''}
        <h2 class="social-h2">2. Génère des légendes avec l’IA</h2>
        <div class="social-form">
          <label>Décris la photo (ce que l’IA ne voit pas) <input id="social-description" maxlength="500" value="${p(c.description || '')}" placeholder="Ex : portrait en robe bordeaux, lumière de fin de journée, terrasse"></label>
          <label>Style <select id="social-style">${STYLES.map(([k, l]) => `<option value="${k}" ${k === c.style ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label class="social-inline"><input id="social-question" type="checkbox" ${c.question === false ? '' : 'checked'}> Ajouter une question pour susciter des commentaires</label>
          <div class="social-actions"><button type="button" id="social-generate" class="btn-sm" ${!S.ai ? 'disabled' : ''}>${c.variants.length ? 'Régénérer' : 'Générer 3 légendes'}</button>${!S.ai ? '<span class="small muted">NoTrack non configuré</span>' : ''}</div>
          <div id="social-variants">${c.variants.map((v, i) => `<div class="social-variant"><p>${p(assemble(v))}</p><div class="social-actions"><button type="button" class="btn-sm" data-use="${i}">Utiliser</button><button type="button" class="btn-sm btn-ghost" data-copy="${i}">Copier</button></div></div>`).join('')}</div>
        </div></section>
      <section class="panel"><h2>3. Valide la légende</h2>
        <div class="social-form"><label>Légende finale (modifiable) <textarea id="social-caption" maxlength="2200" rows="8" placeholder="Légende, question et hashtags…">${p(c.caption)}</textarea></label>
          <p class="small muted"><span id="social-count">${c.caption.length}</span>/2200 · ${(c.caption.match(/#[\p{L}\p{N}_]+/gu) || []).length}/30 hashtags${m?.is_synthetic ? ' · la mention #CréatriceVirtuelle sera ajoutée si absente' : ''}</p>
          <div class="social-preview">${m ? thumb(m.id, 'is-preview') : '<span class="social-thumb social-thumb-empty is-preview"></span>'}<div><strong>@${p(a?.username || 'compte')}</strong><p id="social-preview-text" class="small">${p(c.caption || 'Ta légende apparaîtra ici.')}</p></div></div>
          <div class="social-actions">
            <button type="button" id="social-save" class="btn-sm" ${!m ? 'disabled' : ''}>${editing ? 'Enregistrer les modifications' : 'Valider en brouillon'}</button>
            <button type="button" id="social-save-schedule" class="btn-primary" ${!m || prob ? 'disabled' : ''}>Valider et programmer…</button>
            ${editing ? '<button type="button" id="social-new" class="btn-sm btn-ghost">Nouvelle publication</button>' : ''}
          </div></div></section></div>`;
  }
  const assemble = (v) => [v.text, v.question, (v.hashtags || []).join(' ')].filter(Boolean).join('\n\n');
  function readComposer() { const c = S.composer; c.caption = $('#social-caption')?.value ?? c.caption; c.description = $('#social-description')?.value ?? c.description; c.style = $('#social-style')?.value ?? c.style; c.question = $('#social-question')?.checked ?? c.question; }
  async function saveComposer() {
    readComposer(); const c = S.composer;
    if (!c.caption.trim()) throw Error('La légende est vide');
    const r = c.postId ? await call('update_post', { creator_id: S.creatorId, post_id: c.postId, caption: c.caption }) : await call('create_post', { creator_id: S.creatorId, media_id: c.mediaId, caption: c.caption, caption_style: c.style });
    c.postId = r.post.id; c.caption = r.post.caption;
    return r.post;
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
      const at = new Date(v); if (!(at.getTime() > Date.now() + 2 * 60_000)) { err.textContent = 'Choisis une heure au moins 5 minutes dans le futur.'; return; }
      busy(go, true);
      const send = (allow) => call('schedule_post', { creator_id: S.creatorId, post_id: post.id, account_id: a.id, scheduled_at: at.toISOString(), approved_non_explicit: true, allow_repost: allow });
      try {
        let r; try { r = await send(false); } catch (e) { if (e.data?.needs_repost_confirmation && confirm(e.message)) r = await send(true); else throw e; }
        d.close(); S.composer = { ...S.composer, mediaId: '', postId: '', caption: '', variants: [] };
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
    return `<article class="social-entry">${thumb(x.media_id, 'is-md')}<div class="social-entry-body"><div class="social-entry-top">${pill(x.state)}<strong>${dateLine}</strong></div>
      <p class="small social-caption">${p(x.caption || '(sans légende)')}</p>
      ${x.last_error && x.state !== 'published' ? `<p class="small ${['failed', 'unknown'].includes(x.state) ? 'social-err' : 'muted'}">${p(x.last_error)}</p>` : ''}
      ${x.state === 'unknown' ? '<p class="small muted">Relais IA vérifie automatiquement le compte. Ne republie pas manuellement avant d’avoir vérifié sur Instagram.</p>' : ''}
      <div class="social-actions">${act.join('')}</div><ol class="social-events" id="ev-${p(x.id)}" hidden></ol></div></article>`;
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
    const views = { overview, accounts: accountsView, media: mediaView, compose: composeView, posts: postsView, calendar: calendarView };
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
      on('#social-compose-selected', () => { const id = [...S.selected][0]; S.composer = { ...S.composer, mediaId: id, postId: '', variants: [] }; S.tab = 'compose'; draw(); if (S.selected.size > 1) toast('Une publication = une photo : la première sélection est utilisée'); });
      on('#social-archive-selected', act(async () => { if (!confirm(`Archiver ${S.selected.size} photo(s) ? Elles restent stockées en privé.`)) throw Error('Annulé'); const r = await call('archive_media', { creator_id: S.creatorId, media_ids: [...S.selected] }); S.selected.clear(); toast(`${r.archived} archivée(s)${r.blocked ? `, ${r.blocked} bloquée(s) car programmée(s)` : ''}`); }));
    }
    if (S.tab === 'compose') {
      on('[data-pick-media]', (b) => { readComposer(); S.composer.mediaId = b.dataset.pickMedia; draw(); });
      const cap = $('#social-caption'); if (cap) cap.oninput = () => { S.composer.caption = cap.value; $('#social-count').textContent = cap.value.length; $('#social-preview-text').textContent = cap.value || 'Ta légende apparaîtra ici.'; };
      on('#social-generate', async (b) => {
        readComposer(); const c = S.composer;
        if ((c.description || '').trim().length < 3) { toast('Décris la photo en quelques mots', true); return; }
        busy(b, true); b.textContent = 'Génération…';
        try { const r = await call('generate_captions', { creator_id: S.creatorId, description: c.description, style: c.style, include_question: c.question !== false, regenerate: c.variants.length > 0 }); c.variants = r.variants; draw(); }
        catch (e) { fail(e); busy(b, false); b.textContent = c.variants.length ? 'Régénérer' : 'Générer 3 légendes'; }
      });
      on('[data-use]', (b) => { readComposer(); S.composer.caption = assemble(S.composer.variants[Number(b.dataset.use)]); draw(); $('#social-caption')?.focus(); });
      on('[data-copy]', async (b) => { try { await navigator.clipboard.writeText(assemble(S.composer.variants[Number(b.dataset.copy)])); toast('Copié'); } catch { toast('Copie impossible', true); } });
      on('#social-save', async (b) => { busy(b, true); try { await saveComposer(); toast('Brouillon enregistré'); S.composer = { ...S.composer, mediaId: '', postId: '', caption: '', variants: [] }; S.tab = 'posts'; S.filter = 'draft'; await refresh(); } catch (e) { fail(e); } finally { busy(b, false); } });
      on('#social-save-schedule', async (b) => { busy(b, true); try { const post = await saveComposer(); await loadData(); draw(); scheduleDialog(post); } catch (e) { fail(e); } finally { busy(b, false); } });
      on('#social-new', () => { S.composer = { ...S.composer, mediaId: '', postId: '', caption: '', variants: [] }; draw(); });
    }
    if (S.tab === 'posts') {
      on('[data-filter]', (b) => { S.filter = b.dataset.filter; draw(); });
      on('#social-reload', act(async () => { }));
      on('[data-edit]', (b) => { const x = S.posts.find((y) => y.id === b.dataset.edit); S.composer = { ...S.composer, mediaId: x.media_id, postId: x.id, caption: x.caption, variants: [], style: x.caption_style || S.composer.style }; S.tab = 'compose'; draw(); });
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
    if (S.tab === 'calendar') on('[data-month]', (b) => { const n = Number(b.dataset.month); S.month = n === 0 ? monthStart(new Date()) : new Date(S.month.getFullYear(), S.month.getMonth() + n, 1); draw(); });
  }

  try { await loadStatus(); await loadData(); draw(); }
  catch (e) { main.innerHTML = '<section class="panel"><h2>Social Automation</h2><p>Le service Social Automation est inaccessible. Vérifie le déploiement de la fonction Supabase <code>social-api</code>.</p></section>'; fail(e); }
  // Live refresh while posts are in flight (only while this view is mounted)
  const timer = setInterval(async () => {
    if (!main.isConnected || !main.querySelector('.social-page')) { clearInterval(timer); return; }
    if (document.hidden || !S.posts.some((x) => ['processing', 'unknown'].includes(x.state) || (x.state === 'scheduled' && Date.parse(x.scheduled_at) < Date.now() + 120_000))) return;
    if (['posts', 'overview', 'calendar'].includes(S.tab)) { try { await refresh(); } catch { } }
  }, 30_000);
}
