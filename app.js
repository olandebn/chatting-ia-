import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---------- Configuration ----------
const SUPABASE_URL = "https://owbcnkcuxcgsawjqkssk.supabase.co";
const SUPABASE_KEY = "sb_publishable_8vsVUoNdH8ga_LzWX6OynQ_HO2QRPIE";
const BRAND = "Relais IA";

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { flowType: "pkce", detectSessionInUrl: true, persistSession: true } });

// ---------- Utilitaires ----------
const root = document.getElementById("root");
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nf = new Intl.NumberFormat("fr-FR");

function toast(msg, error = false) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.toggle("error", !!error);
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 3200);
}
function fail(e) { console.error(e); toast(e?.message ?? String(e), true); }

function fmtDate(iso, withTime = true) {
  if (!iso) return "";
  const d = new Date(iso);
  const today = new Date();
  if (withTime && d.toDateString() === today.toDateString())
    return d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleString("fr-FR", withTime
    ? { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }
    : { day: "numeric", month: "long", year: "numeric" });
}
function initials(name) {
  return String(name ?? "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";
}
const AV_COLORS = ["#3654e8", "#16895c", "#b5531f", "#7a45c9", "#0f7c8c", "#c23b6e", "#4a5272"];
function avColor(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return AV_COLORS[Math.abs(h) % AV_COLORS.length]; }

async function api(action, body = {}) {
  const { data, error } = await sb.functions.invoke("api", { body: { action, ...body } });
  if (error) {
    let msg = error.message;
    try { const j = await error.context.json(); msg = j.error || msg; } catch (_) { /* rien */ }
    throw new Error(msg);
  }
  return data;
}
async function q(promise) {
  const { data, error } = await promise;
  if (error) throw new Error(error.message);
  return data;
}

const MODES = {
  observation: { label: "Observation", short: "Aucune réponse envoyée", color: "var(--obs)",
    banner: "L'assistant lit tes discussions et prépare ses statistiques, mais n'envoie rien. Idéal pour commencer." },
  validation: { label: "Validation", short: "Tu valides chaque brouillon", color: "var(--val)",
    banner: "Chaque réponse est préparée en brouillon. Tu la reçois dans ton Telegram (boutons Envoyer / Ignorer) et sur l'accueil du tableau de bord." },
  auto: { label: "Automatique", short: "Réponses après le délai choisi", color: "var(--auto)",
    banner: "L'assistant répond seul, après un délai tiré au hasard dans la plage choisie. Dès que tu réponds toi-même, il se met en pause dans cette discussion." },
};
const MODE_KEYS = ["observation", "validation", "auto"];
const DELAYS = [
  [60, 300, "1–5 min"], [300, 900, "5–15 min"], [900, 1800, "15–30 min"], [1800, 3600, "30–60 min"],
  [3600, 7200, "1–2 h"], [7200, 14400, "2–4 h"], [14400, 28800, "4–8 h"], [28800, 43200, "8–12 h"],
];

function setMode(mode) { document.body.dataset.mode = mode || "observation"; }

function lever(current, id = "lever") {
  const pos = Math.max(0, MODE_KEYS.indexOf(current));
  return `<div class="lever" id="${id}" data-pos="${pos}" role="radiogroup" aria-label="Mode de réponse">
    <div class="lever-knob" aria-hidden="true"></div>
    ${MODE_KEYS.map((k) => `<button type="button" role="radio" aria-checked="${k === current}" data-mode="${k}">
      <strong><i style="background:${MODES[k].color}"></i>${MODES[k].label}</strong><span>${MODES[k].short}</span></button>`).join("")}
  </div>`;
}
function bindLever(el, onChange) {
  $$("button", el).forEach((b) => b.addEventListener("click", () => {
    const m = b.dataset.mode;
    el.dataset.pos = MODE_KEYS.indexOf(m);
    $$("button", el).forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    onChange(m);
  }));
}

// ---------- État ----------
const state = { session: null, overview: null, settings: null, selectedChat: null, statsRange: "7d" };

async function loadAccount() {
  const [overview, settings] = await Promise.all([
    q(sb.rpc("my_overview")),
    q(sb.from("bot_settings").select("*").maybeSingle()),
  ]);
  state.overview = overview;
  state.settings = settings;
  setMode(settings?.mode);
}

// ---------- Routeur ----------
function route() {
  const h = location.hash.replace(/^#/, "") || "/";
  const parts = h.split("/").filter(Boolean);
  return parts;
}
async function render() {
  const [a, b] = route();
  window.scrollTo(0, 0);
  try {
    if (!a) return renderLanding();
    if (a === "connexion") return renderAuth("login");
    if (a === "inscription") return renderAuth("signup");
    if (a === "nouveau-mot-de-passe") return renderNewPassword();
    if (a === "guide") return renderGuide();
    if (a === "app") {
      if (!state.session) { location.hash = "#/connexion"; return; }
      return renderApp(b || "accueil");
    }
    location.hash = "#/";
  } catch (e) { fail(e); }
}
window.addEventListener("hashchange", render);

// ---------- Éléments communs ----------
const brand = (href = "#/") => `<a class="brand" href="${href}"><span class="brand-mark"><span></span></span>${BRAND}</a>`;

function siteNav() {
  return `<nav class="site-nav">${brand()}
    <div class="row">
      <a class="btn btn-ghost" href="#/guide">Guide</a>
      ${state.session
        ? `<a class="btn btn-primary" href="#/app/accueil">Mon tableau de bord</a>`
        : `<a class="btn btn-ghost" href="#/connexion">Se connecter</a><a class="btn btn-primary" href="#/inscription">Créer un compte</a>`}
    </div></nav>`;
}
function siteFoot() {
  return `<footer class="site-foot"><div><a href="#/guide">Guide</a><a href="#/connexion">Espace client</a></div>
    <div>© ${new Date().getFullYear()} ${BRAND}. Les contacts peuvent écrire /stopai à tout moment.</div></footer>`;
}

// ---------- Page d'accueil ----------
const DEMO = {
  observation: { bubbles: [["in", "coucou, t'es dispo ce soir ?"], ["ghost", "L'assistant lit, rien n'est envoyé"]],
    caption: "Observation : tu vois tout passer dans le tableau de bord, sans aucun envoi." },
  validation: { bubbles: [["in", "coucou, t'es dispo ce soir ?"], ["draft", "Hello ! Ce soir ça va être compliqué, demain plutôt ? 😊"]],
    caption: "Validation : le brouillon arrive dans ton Telegram, tu l'envoies ou tu l'ignores d'un tap." },
  auto: { bubbles: [["in", "coucou, t'es dispo ce soir ?"], ["out", "Hello ! Ce soir ça va être compliqué, demain plutôt ? 😊"]],
    caption: "Automatique : la réponse part après le délai choisi. Tu réponds toi-même ? L'assistant se met en pause." },
};
function demoChat(mode) {
  const d = DEMO[mode];
  return d.bubbles.map(([k, t]) => `<div class="bubble ${k}">${esc(t)}</div>`).join("");
}

async function renderLanding() {
  setMode("validation");
  const plans = await q(sb.from("plans").select("*").order("sort")).catch(() => []);
  root.innerHTML = `${siteNav()}
  <main>
    <section class="hero">
      <div>
        <h1>Tes discussions Telegram, tenues même quand tu n'es pas là.</h1>
        <p class="lead">${BRAND} répond dans tes conversations Telegram Business avec ton ton, tes règles et tes liens. Tu choisis s'il observe, s'il te propose des brouillons ou s'il répond seul.</p>
        <div class="row"><a class="btn btn-primary" href="#/inscription">Créer un compte</a><a class="btn" href="#/guide">Lire le guide</a></div>
        <p class="small muted" style="margin-top:16px">7 jours d'essai, 50 messages offerts. Fonctionne avec un compte Telegram Premium (Telegram Business).</p>
      </div>
      <div class="hero-demo">
        ${lever("validation", "demo-lever")}
        <div class="demo-chat" id="demo-chat" aria-live="polite">${demoChat("validation")}</div>
        <p class="demo-caption" id="demo-caption">${DEMO.validation.caption}</p>
      </div>
    </section>

    <section class="section">
      <h2>Ce que fait l'assistant, et ce qu'il ne fera jamais sans toi</h2>
      <div class="features">
        ${[
          ["var(--val)", "Trois modes de réponse", "Observation, validation avant envoi ou automatique. Tu changes de mode en un clic, pour tout le compte ou pour une seule discussion."],
          ["var(--signal)", "Des délais que tu choisis", "De 1–5 minutes à 8–12 heures. Chaque réponse part à un instant tiré au hasard dans la plage, pour espacer les envois."],
          ["var(--auto)", "Tu restes prioritaire", "Dès que tu écris toi-même dans une discussion, l'assistant attend la durée de reprise que tu as fixée avant de reprendre."],
          ["#7a45c9", "Il apprend ton style", "Consignes écrites, commande /learn dans Telegram, et tes vraies réponses que tu valides comme exemples. Jamais ses propres messages."],
          ["#b5531f", "Tes liens de vente", "Ajoute tes offres et tes liens : il les propose quand la conversation s'y prête, n'invente aucun prix et n'insiste pas après un refus."],
          ["var(--ink-2)", "Une mémoire par discussion", "Chaque contact a sa propre mémoire, conservée 30 jours. Un contact peut écrire /stopai pour arrêter l'IA et effacer sa mémoire."],
        ].map(([c, t, d]) => `<div class="feature"><div class="dot" style="background:${c}"></div><h3>${t}</h3><p>${d}</p></div>`).join("")}
      </div>
    </section>

    <section class="section">
      <h2>Prêt en quatre étapes</h2>
      <ol class="steps panel" style="max-width:760px">
        <li><div><strong>Crée ton compte</strong><p>Adresse e-mail et mot de passe, rien d'autre.</p></div></li>
        <li><div><strong>Lie ton Telegram</strong><p>Un bouton dans ton tableau de bord ouvre le bot avec ton code personnel.</p></div></li>
        <li><div><strong>Ajoute le bot dans Telegram Business</strong><p>Réglages → Telegram Business → Chatbots, puis autorise-le à répondre.</p></div></li>
        <li><div><strong>Choisis ton mode</strong><p>Commence en observation, passe en validation, puis en automatique quand le ton te plaît.</p></div></li>
      </ol>
    </section>

    ${plans.length ? `<section class="section" id="offres"><h2>Les abonnements</h2><div class="plans">${plans.map(planCard).join("")}</div></section>` : ""}
  </main>${siteFoot()}`;

  bindLever($("#demo-lever"), (m) => {
    setMode(m);
    $("#demo-chat").innerHTML = demoChat(m);
    $("#demo-caption").textContent = DEMO[m].caption;
  });
}

function planCard(p, current) {
  const feats = [`${nf.format(p.msg_quota)} réponses IA par période`, "Modes, délais et pause automatique", "Statistiques et conversations"];
  if (p.learning) feats.push("Apprentissage du style");
  if (p.buy) feats.push("Liens de vente");
  return `<div class="plan ${current === p.id ? "current" : ""}">
    <div class="row" style="justify-content:space-between"><h3>${esc(p.name)}</h3>${current === p.id ? `<span class="tag ok">Ton abonnement</span>` : ""}</div>
    <div class="price">${esc(p.price_label ?? "")}</div>
    <p class="muted small" style="margin:0">${esc(p.description ?? "")}</p>
    <ul>${feats.map((f) => `<li>${f}</li>`).join("")}</ul></div>`;
}

// ---------- Connexion / inscription ----------
function renderAuth(tab) {
  setMode("observation");
  root.innerHTML = `${siteNav()}<div class="auth-wrap"><div class="auth-card panel">
    <h1>${tab === "login" ? "Content de te revoir" : "Crée ton espace"}</h1>
    <p class="muted">${tab === "login" ? "Connecte-toi pour piloter ton assistant." : "7 jours d'essai et 50 messages offerts, sans carte bancaire."}</p>
    <div class="tabs" role="tablist">
      <button role="tab" aria-selected="${tab === "login"}" data-go="connexion">Connexion</button>
      <button role="tab" aria-selected="${tab === "signup"}" data-go="inscription">Créer un compte</button>
    </div>
    <form id="auth-form">
      ${tab === "signup" ? `<div class="field"><label for="name">Ton prénom ou ton pseudo</label><input id="name" type="text" autocomplete="nickname" required maxlength="60"></div>` : ""}
      <div class="field"><label for="email">Adresse e-mail</label><input id="email" type="email" autocomplete="email" required></div>
      <div class="field"><label for="pw">Mot de passe</label><input id="pw" type="password" autocomplete="${tab === "login" ? "current-password" : "new-password"}" minlength="8" required>
        ${tab === "signup" ? `<p class="hint">8 caractères minimum.</p>` : ""}</div>
      <button class="btn-primary" style="width:100%" type="submit">${tab === "login" ? "Se connecter" : "Créer mon compte"}</button>
    </form>
    ${tab === "login" ? `<p class="small" style="margin-top:14px"><a href="#" id="forgot">Mot de passe oublié ?</a></p>` : ""}
    <p class="small muted" id="auth-msg" style="margin-top:12px"></p>
  </div></div>`;
  $$("[data-go]").forEach((b) => b.addEventListener("click", () => (location.hash = "#/" + b.dataset.go)));
  $("#auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#email").value.trim(), password = $("#pw").value;
    const btn = $("#auth-form button[type=submit]"); btn.disabled = true;
    try {
      if (tab === "login") {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw new Error(error.message === "Invalid login credentials" ? "E-mail ou mot de passe incorrect." : error.message);
        location.hash = "#/app/accueil";
      } else {
        const { data, error } = await sb.auth.signUp({
          email, password,
          options: { data: { display_name: $("#name").value.trim() }, emailRedirectTo: location.origin + location.pathname },
        });
        if (error) throw error;
        if (data.session) location.hash = "#/app/accueil";
        else $("#auth-msg").textContent = "Compte créé. Ouvre l'e-mail de confirmation que tu viens de recevoir pour activer ton espace.";
      }
    } catch (err) { fail(err); } finally { btn.disabled = false; }
  });
  $("#forgot")?.addEventListener("click", async (e) => {
    e.preventDefault();
    const email = $("#email").value.trim();
    if (!email) return toast("Saisis d'abord ton adresse e-mail.", true);
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    if (error) return fail(error);
    $("#auth-msg").textContent = "Si un compte existe pour cette adresse, un lien de réinitialisation vient d'être envoyé.";
  });
}

function renderNewPassword() {
  root.innerHTML = `${siteNav()}<div class="auth-wrap"><form class="auth-card panel" id="np">
    <h1>Nouveau mot de passe</h1><p class="muted">Choisis un mot de passe d'au moins 8 caractères.</p>
    <div class="field"><label for="pw">Mot de passe</label><input id="pw" type="password" minlength="8" required autocomplete="new-password"></div>
    <button class="btn-primary" type="submit" style="width:100%">Enregistrer le mot de passe</button></form></div>`;
  $("#np").addEventListener("submit", async (e) => {
    e.preventDefault();
    const { error } = await sb.auth.updateUser({ password: $("#pw").value });
    if (error) return fail(error);
    toast("Mot de passe enregistré");
    location.hash = "#/app/accueil";
  });
}

// ---------- Tableau de bord : coquille ----------
const SECTIONS = [
  ["accueil", "Accueil"], ["controle", "Contrôle IA"], ["conversations", "Conversations"], ["stats", "Statistiques"],
  ["apprentissage", "Apprentissage"], ["liens", "Liens de vente"], ["photos", "Photos privées"], ["compte", "Mon compte"],
];

async function renderApp(section) {
  if (!state.overview || section === "accueil") await loadAccount();
  const ov = state.overview;
  const sections = ov?.profile?.is_admin ? [...SECTIONS, ["admin", "Administration"]] : SECTIONS;
  if (!sections.some(([k]) => k === section)) { location.hash = "#/app/accueil"; return; }
  const drafts = ov?.pending_drafts ?? 0, ex = ov?.pending_examples ?? 0;
  root.innerHTML = `<div class="mobile-bar">${brand("#/app/accueil")}<button class="btn-sm" id="menu-btn" aria-expanded="false" aria-controls="sidebar">Menu</button></div>
  <div class="app">
    <aside class="sidebar" id="sidebar">${brand("#/app/accueil")}
      ${sections.map(([k, l]) => {
        const n = k === "accueil" ? drafts : k === "apprentissage" ? ex : 0;
        return `<a class="side-link" href="#/app/${k}" ${k === section ? 'aria-current="page"' : ""}>${l}${n ? `<span class="count">${n}</span>` : ""}</a>`;
      }).join("")}
      <a class="side-link" href="#/guide">Guide</a>
      <div class="side-foot"><span class="mode-pill"><i></i>${MODES[state.settings?.mode ?? "observation"].label}</span><br>
        ${esc(ov?.profile?.email ?? "")}</div>
    </aside>
    <main class="main" id="main"></main>
  </div>`;
  $("#menu-btn").addEventListener("click", () => {
    const s = $("#sidebar"); s.classList.toggle("open");
    $("#menu-btn").setAttribute("aria-expanded", String(s.classList.contains("open")));
  });
  const main = $("#main");
  const views = { accueil: viewHome, controle: viewControl, conversations: viewConvos, stats: viewStats,
    apprentissage: viewLearn, liens: viewLinks, photos: viewPhotos, compte: viewAccount, admin: viewAdmin };
  await views[section](main);
}

function head(title, sub, actions = "") {
  return `<div class="main-head"><div><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ""}</div><div class="row">${actions}</div></div>`;
}
function tgLink() {
  const ov = state.overview;
  if (!ov?.bot_username || !ov?.telegram?.link_code) return null;
  return `https://t.me/${encodeURIComponent(ov.bot_username)}?start=${encodeURIComponent(ov.telegram.link_code)}`;
}

// ---------- Accueil ----------
async function viewHome(main) {
  const ov = state.overview, s = state.settings;
  const plan = ov.plan, used = ov.quota_used ?? 0, quota = plan?.msg_quota ?? 0;
  const pct = quota ? Math.min(100, Math.round((used / quota) * 100)) : 0;
  const expired = new Date(ov.profile.period_end) < new Date();
  const linked = !!ov.telegram?.telegram_user_id;
  const connected = !!ov.connection?.present && ov.connection?.is_enabled;
  const canReply = connected && ov.connection?.can_reply;
  const link = tgLink();
  const drafts = await q(sb.from("replies").select("id, draft_text, created_at, chat_id, chats(title)").eq("status", "draft").order("created_at", { ascending: false }).limit(20));

  main.innerHTML = `${head(`Bonjour ${esc(ov.profile.display_name ?? "")}`, "Voici où en est ton assistant.", `<button class="btn-sm" id="refresh">Actualiser</button>`)}
  <div class="grid-2">
    <section class="panel">
      <div class="panel-head"><div><h2>Ton abonnement</h2><p>${esc(plan?.name ?? "")} · ${expired ? "expiré le" : "jusqu'au"} ${fmtDate(ov.profile.period_end, false)}</p></div>
        <span class="tag ${expired ? "bad" : "ok"}">${expired ? "Expiré" : "Actif"}</span></div>
      <div class="big-num">${nf.format(used)} <span class="muted" style="font-size:1rem;font-weight:500">/ ${nf.format(quota)} réponses</span></div>
      <div class="meter" aria-label="${pct}% utilisé"><div style="width:${pct}%"></div></div>
      <p class="small muted">${nf.format(Math.max(0, quota - used))} restantes sur la période · ${pct}% utilisé</p>
    </section>
    <section class="panel">
      <div class="panel-head"><div><h2>Mode actuel</h2><p>Appliqué à toutes les discussions sans réglage particulier.</p></div></div>
      <div class="row"><span class="tag" style="background:var(--mode-soft);color:var(--ink)"><i style="width:9px;height:9px;border-radius:50%;background:var(--mode);display:inline-block"></i>${MODES[s.mode].label}</span>
        <span class="muted small">Délai : ${esc(DELAYS.find((d) => d[0] === s.delay_min_s && d[1] === s.delay_max_s)?.[2] ?? "personnalisé")}</span></div>
      <p class="small muted" style="margin-top:12px">${MODES[s.mode].banner}</p>
      <a class="btn btn-sm" href="#/app/controle">Changer de mode</a>
    </section>
  </div>

  <section class="panel">
    <div class="panel-head"><div><h2>Mise en route</h2><p>Quatre étapes pour que l'assistant puisse répondre.</p></div>
      ${canReply ? `<span class="tag ok">Tout est prêt</span>` : ""}</div>
    <ol class="steps">
      <li class="${linked ? "done" : ""}"><div><strong>Lier ton compte Telegram</strong>
        <p>${linked ? `Lié à ${esc(ov.telegram.telegram_name ?? "")}${ov.telegram.telegram_username ? " (@" + esc(ov.telegram.telegram_username) + ")" : ""}.` : link ? "Ouvre le bot et appuie sur Démarrer : ton compte se lie automatiquement." : "Le bot n'est pas encore configuré par l'administrateur."}</p></div>
        ${link && !linked ? `<a class="btn btn-signal btn-sm" href="${esc(link)}" target="_blank" rel="noopener">Lier Telegram</a>` : "<span></span>"}</li>
      <li class="${connected ? "done" : ""}"><div><strong>Ajouter le bot dans Telegram Business</strong>
        <p>Dans Telegram : Réglages → Telegram Business → Chatbots, puis saisis ${ov.bot_username ? "@" + esc(ov.bot_username) : "le nom du bot"}. Nécessite Telegram Premium.</p></div>
        ${linked ? `<button class="btn-sm" id="rights">Actualiser les droits</button>` : "<span></span>"}</li>
      <li class="${canReply ? "done" : ""}"><div><strong>Autoriser les réponses</strong>
        <p>${connected && !canReply ? "Le bot est ajouté mais ne peut pas répondre : active « Répondre aux messages » dans ses réglages." : "Dans les réglages du chatbot, coche l'autorisation de répondre aux messages."}</p></div><span></span></li>
      <li class="${s.mode !== "observation" ? "done" : ""}"><div><strong>Choisir un mode de réponse</strong>
        <p>Commence en validation pour vérifier le ton avant de passer en automatique.</p></div>
        <a class="btn btn-sm" href="#/app/controle">Choisir</a></li>
    </ol>
  </section>

  <section class="panel">
    <div class="panel-head"><div><h2>Brouillons à valider</h2><p>Modifie le texte si besoin avant de l'envoyer. Tu peux aussi valider depuis Telegram.</p></div>
      <span class="tag ${drafts.length ? "warn" : ""}">${drafts.length}</span></div>
    ${drafts.length ? drafts.map((d) => `<div class="draft" data-id="${d.id}">
        <div class="row" style="justify-content:space-between"><strong>${esc(d.chats?.title ?? "Contact")}</strong><span class="small muted">${fmtDate(d.created_at)}</span></div>
        <textarea aria-label="Texte du brouillon">${esc(d.draft_text)}</textarea>
        <div class="row"><button class="btn-primary btn-sm" data-act="send">Envoyer</button><button class="btn-ghost btn-sm" data-act="discard">Ignorer</button>
          <a class="btn btn-ghost btn-sm" href="#/app/conversations" data-chat="${d.chat_id}">Voir la discussion</a></div></div>`).join("")
      : `<div class="empty">Aucun brouillon en attente. En mode Validation, les réponses préparées apparaîtront ici.</div>`}
  </section>`;

  $("#refresh").addEventListener("click", () => render());
  $("#rights")?.addEventListener("click", async () => {
    try { const r = await api("refresh_rights"); toast(r.can_reply ? "Droits à jour : le bot peut répondre" : "Le bot n'a pas encore le droit de répondre"); render(); }
    catch (e) { fail(e); }
  });
  $$(".draft").forEach((el) => {
    const id = Number(el.dataset.id);
    $("[data-act=send]", el).addEventListener("click", async (ev) => {
      ev.target.disabled = true;
      try { await api("send_draft", { reply_id: id, text: $("textarea", el).value }); toast("Brouillon envoyé"); render(); }
      catch (e) { fail(e); ev.target.disabled = false; }
    });
    $("[data-act=discard]", el).addEventListener("click", async () => {
      try { await api("discard_draft", { reply_id: id }); toast("Brouillon ignoré"); el.remove(); state.overview = null; }
      catch (e) { fail(e); }
    });
    $("[data-chat]", el).addEventListener("click", (e) => { state.selectedChat = Number(e.currentTarget.dataset.chat); });
  });
}

// ---------- Contrôle IA ----------
async function saveSettings(patch, msg = "Réglages enregistrés") {
  const data = await q(sb.from("bot_settings").update({ ...patch, updated_at: new Date().toISOString() }).eq("user_id", state.overview.profile.id).select().single());
  state.settings = data;
  toast(msg);
  return data;
}

async function viewControl(main) {
  const s = state.settings;
  const canSetAiEngine = !!state.overview?.profile?.is_admin;
  const aiEngineStatus = canSetAiEngine
    ? await api("admin_status").catch((e) => ({ error: String(e?.message || e) }))
    : null;
  main.innerHTML = `${head("Contrôle IA", "Choisis comment et quand ton assistant intervient.")}
  ${canSetAiEngine ? `<section class="panel">
    <div class="panel-head"><div><h2>Moteur IA</h2><p>Choisis le fournisseur utilisé pour les réponses Telegram. Ce réglage est global.</p></div></div>
    ${aiEngineStatus?.error ? `<p class="hint">Impossible de charger la configuration : ${esc(aiEngineStatus.error)}</p>` : `
      <form id="ctrl-notrack-form" class="row" style="align-items:end;gap:12px">
        <div class="grow"><label for="ctrl-notrack-provider">Fournisseur IA</label>
          <select id="ctrl-notrack-provider">
            <option value="openai" ${aiEngineStatus?.ai_provider === "openai" ? "selected" : ""}>OpenAI — API payante</option>
            <option value="notrack" ${aiEngineStatus?.ai_provider === "notrack" ? "selected" : ""}>NoTrack — API avec crédit d’essai</option>
            <option value="anthropic" ${!aiEngineStatus?.ai_provider || aiEngineStatus.ai_provider === "anthropic" ? "selected" : ""}>Claude — API payante</option>
          </select>
        </div>
        <button type="submit" class="btn-primary">Enregistrer le moteur</button>
      </form>
      <p class="hint" style="margin-top:8px">Clé NoTrack : ${aiEngineStatus?.has_notrack_key ? "présente" : "absente"}. À enregistrer côté Supabase sous NOTRACK_API_KEY. Le chat Web gratuit NoTrack n'est pas l'API Telegram.</p>`}
  </section>` : ""}
  <section class="panel">
    <div class="panel-head"><div><h2>Mode de réponse</h2><p>Appliqué aux discussions en cours et aux nouvelles discussions.</p></div></div>
    ${lever(s.mode)}
    <div class="mode-banner" id="mode-banner">${MODES[s.mode].banner}</div>
  </section>

  <section class="panel">
    <div class="panel-head"><div><h2>Délai de réponse</h2><p>Pour chaque nouveau message, l'assistant choisit un instant au hasard dans la plage.</p></div></div>
    <div class="chips" id="delays">${DELAYS.map(([a, b, l]) => `<button class="chip" aria-pressed="${s.delay_min_s === a && s.delay_max_s === b}" data-a="${a}" data-b="${b}">${l}</button>`).join("")}</div>
    <p class="hint">Les réponses déjà programmées gardent leur échéance. Les pauses et les droits Telegram restent prioritaires.</p>
  </section>

  <!-- RELAIS_V2_20261112 -->
  <section class="panel"><div class="panel-head"><div><h2>Style des réponses</h2><p>NoTrack reste le moteur actif ; personnalise son style par compte.</p></div></div>
    <form id="style-v2-form">
      <div class="grid-2">
        <div class="field"><label for="v2-length">Longueur</label><select id="v2-length">
          <option value="short" ${s.reply_length === "short" ? "selected" : ""}>Courte (10–20 mots)</option>
          <option value="medium" ${!s.reply_length || s.reply_length === "medium" ? "selected" : ""}>Moyenne (20–35 mots)</option>
          <option value="long" ${s.reply_length === "long" ? "selected" : ""}>Longue (35–60 mots)</option>
        </select></div>
        <div class="field"><label for="v2-emoji">Emojis</label><select id="v2-emoji">
          <option value="none" ${s.emoji_level === "none" ? "selected" : ""}>Aucun</option>
          <option value="rare" ${!s.emoji_level || s.emoji_level === "rare" ? "selected" : ""}>Rares (0–1)</option>
          <option value="frequent" ${s.emoji_level === "frequent" ? "selected" : ""}>Fréquents (0–2)</option>
        </select></div>
        <div class="field"><label for="v2-tone">Ton</label><select id="v2-tone">
          <option value="warm" ${!s.reply_tone || s.reply_tone === "warm" ? "selected" : ""}>Chaleureux</option>
          <option value="neutral" ${s.reply_tone === "neutral" ? "selected" : ""}>Neutre</option>
          <option value="professional" ${s.reply_tone === "professional" ? "selected" : ""}>Professionnel</option>
        </select></div>
        <div class="field"><label for="v2-pronouns">Registre</label><select id="v2-pronouns">
          <option value="tu" ${!s.pronouns || s.pronouns === "tu" ? "selected" : ""}>Tutoiement</option>
          <option value="vous" ${s.pronouns === "vous" ? "selected" : ""}>Vouvoiement</option>
        </select></div>
      </div>
      <button type="submit" class="btn-primary">Enregistrer le style</button>
    </form>
  </section>
  ${s.ai_paused_reason ? `<section class="panel"><div class="mode-banner" style="background:#f8e1e1">NoTrack / API suspendue : ${esc(s.ai_paused_reason)}.
  <button class="btn-sm" id="v2-resume-ai">Reprendre après correction</button></div></section>` : ""}
  <div class="grid-2">
    <section class="panel">
      <div class="panel-head"><div><h2>Reprise après tes réponses</h2><p>Quand tu réponds toi-même, l'assistant attend avant de reprendre cette discussion.</p></div></div>
      <form class="row" id="resume-form"><div class="grow"><label for="resume">Durée de pause (minutes)</label>
        <input id="resume" type="number" min="0" max="1440" value="${s.resume_minutes}"></div>
        <button class="btn-primary" style="align-self:flex-end" type="submit">Enregistrer</button></form>
      <p class="hint">Par défaut : 30 min. S'applique à tes prochaines réponses, pas aux pauses déjà en cours.</p>
    </section>
    <section class="panel">
      <div class="panel-head"><div><h2>Mention de l'IA</h2><p>Ajoutée une seule fois, au premier message de l'assistant dans chaque discussion.</p></div></div>
      <label class="switch"><input type="checkbox" id="notice-on" ${s.ai_notice_enabled ? "checked" : ""}><span class="track"></span>Prévenir mes contacts</label>
      <div class="field" style="margin-top:12px"><label for="notice">Texte de la mention</label><textarea id="notice" maxlength="300">${esc(s.ai_notice_text)}</textarea></div>
      <button class="btn-sm" id="notice-save">Enregistrer la mention</button>
    </section>
  </div>

  <section class="panel">
    <div class="panel-head"><div><h2>Présentation</h2><p>Ce que l'assistant doit savoir sur toi pour répondre juste.</p></div></div>
    <textarea id="persona" rows="5" maxlength="3000" placeholder="Ex. : Je m'appelle Léa, je suis coach sportive à Lyon. Je propose des programmes en ligne. Je réponds de façon chaleureuse et directe.">${esc(s.persona)}</textarea>
    <p class="hint">N'écris pas ici d'informations privées sur tes contacts : chaque discussion a sa propre mémoire.</p>
    <button class="btn-primary" id="persona-save">Enregistrer la présentation</button>
  </section>`;

  if (canSetAiEngine && !aiEngineStatus?.error) {
    $("#ctrl-notrack-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const button = $("#ctrl-notrack-form button");
      const provider = $("#ctrl-notrack-provider").value;
      if (provider === (aiEngineStatus.ai_provider || "anthropic")) return toast("Moteur déjà enregistré");
      button.disabled = true;
      try { await api("admin_save", { ai_provider: provider }); toast("Moteur enregistré"); await render(); }
      catch (err) { fail(err); button.disabled = false; }
    });
  }
  // RELAIS_V2_20261112
  $("#style-v2-form").addEventListener("submit", async (e)=>{
    e.preventDefault();
    await saveSettings({reply_length:$("#v2-length").value,emoji_level:$("#v2-emoji").value,
      reply_tone:$("#v2-tone").value,pronouns:$("#v2-pronouns").value},"Style des réponses enregistré").catch(fail);
  });
  $("#v2-resume-ai")?.addEventListener("click",async()=>{
    try {await api("resume_ai",{});toast("IA réactivée");await render();}catch(e){fail(e);}
  });
  bindLever($("#lever"), async (m) => {
    setMode(m);
    $("#mode-banner").textContent = MODES[m].banner;
    try { await saveSettings({ mode: m }, `Mode ${MODES[m].label} activé`); $(".mode-pill").lastChild.textContent = MODES[m].label; }
    catch (e) { fail(e); }
  });
  $$("#delays .chip").forEach((c) => c.addEventListener("click", async () => {
    $$("#delays .chip").forEach((x) => x.setAttribute("aria-pressed", String(x === c)));
    try { await saveSettings({ delay_min_s: Number(c.dataset.a), delay_max_s: Number(c.dataset.b) }, `Délai ${c.textContent} enregistré`); } catch (e) { fail(e); }
  }));
  $("#resume-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = Math.max(0, Math.min(1440, Number($("#resume").value) || 0));
    try { await saveSettings({ resume_minutes: v }, `Pause de ${v} min enregistrée`); } catch (err) { fail(err); }
  });
  $("#notice-on").addEventListener("change", (e) => saveSettings({ ai_notice_enabled: e.target.checked }, e.target.checked ? "Mention activée" : "Mention désactivée").catch(fail));
  $("#notice-save").addEventListener("click", () => saveSettings({ ai_notice_text: $("#notice").value.trim() }, "Mention enregistrée").catch(fail));
  $("#persona-save").addEventListener("click", () => saveSettings({ persona: $("#persona").value.trim() }, "Présentation enregistrée").catch(fail));
}

// ---------- Conversations ----------
function chatStatus(c, s) {
  if (c.ai_stopped) return "IA arrêtée par le contact (/stopai)";
  if (c.paused_until && new Date(c.paused_until) > new Date()) return `En pause jusqu'à ${fmtDate(c.paused_until)}`;
  const m = c.mode_override ?? s.mode;
  return m === "off" ? "IA désactivée" : MODES[m]?.label ?? m;
}

async function viewConvos(main) {
  const s = state.settings;
  const chats = await q(sb.from("chats").select("*").order("pinned", { ascending: false }).order("last_message_at", { ascending: false, nullsFirst: false }).limit(200));
  await crmLoad(chats);
  main.innerHTML = `${head("Conversations", `${chats.length} discussion${chats.length > 1 ? "s" : ""}. Les épinglées s'affichent en premier.`,
    `<input type="text" id="search" placeholder="Nom, pseudo, etiquette" style="width:205px"><select id="crm-role-filter" aria-label="Filtrer par role"><option value="all">Tous les roles</option><option value="buyers">Acheteurs suivis</option><option value="none">Sans achat suivi</option><option value="bronze">Bronze</option><option value="silver">Argent</option><option value="gold">Or</option><option value="vip">VIP</option></select><select id="crm-sort" aria-label="Trier les discussions"><option value="recent">Plus recents</option><option value="spend">Plus gros acheteurs</option><option value="name">Par nom</option></select><button class="btn-sm" id="refresh">Actualiser</button>`)}
  <div class="convo-layout">
    <section class="panel" style="padding:10px">${chats.length ? `<ul class="convo-list" id="list" role="listbox" aria-label="Discussions">${chats.map((c) => `
      <li class="convo" role="option" tabindex="0" data-id="${c.id}" data-q="${esc((c.title + " " + (c.username ?? "") + " " + (crmAccountFor(c.id).profile.nickname ?? "") + " " + (crmAccountFor(c.id).profile.tags ?? []).join(" ")).toLowerCase())}" aria-selected="${c.id === state.selectedChat}">
        <span class="avatar" style="background:${avColor(c.title)}">${esc(initials(c.title))}</span>
        <div style="min-width:0"><div class="name">${c.pinned ? "📌 " : ""}${esc(c.title)}</div>${crmCardBadge(c)}
          <div class="sub">${esc(chatStatus(c, s))}${c.last_message_preview ? " · " + esc(c.last_message_preview) : ""}</div></div>
        <div class="side"><span class="small muted">${fmtDate(c.last_message_at)}</span>${c.unread ? `<span class="unread">${c.unread}</span>` : ""}</div>
      </li>`).join("")}</ul>`
      : `<div class="empty">Aucune discussion pour l'instant. Elles apparaîtront ici dès que tes contacts t'écriront, une fois Telegram Business connecté.</div>`}</section>
    <section class="panel" id="detail"><div class="empty">Choisis une discussion pour voir son historique et ses réglages.</div></section>
  </div>`;

  $("#refresh").addEventListener("click", () => render());
  crmListFilters(chats);
  $$(".convo").forEach((li) => {
    const open = () => { state.selectedChat = Number(li.dataset.id); $$(".convo").forEach((x) => x.setAttribute("aria-selected", String(x === li))); showChat(chats.find((c) => c.id === state.selectedChat)); };
    li.addEventListener("click", open);
    li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  });
  const sel = chats.find((c) => c.id === state.selectedChat);
  if (sel) showChat(sel);
}

async function showChat(c) {
  const d = $("#detail"), s = state.settings;
  d.innerHTML = `<div class="empty">Chargement…</div>`;
  const [msgs, open, memory] = await Promise.all([
    q(sb.from("messages").select("role, text, created_at").eq("chat_id", c.id).order("created_at", { ascending: false }).limit(80)),
    q(sb.from("replies").select("id, status, due_at, error").eq("chat_id", c.id).order("created_at", { ascending: false }).limit(1)),
    q(sb.from("contact_memory").select("summary").eq("chat_id",c.id).limit(1)),
  ]);
  const last = open[0];
  const paused = c.paused_until && new Date(c.paused_until) > new Date();
  d.innerHTML = `<div class="panel-head"><div><h2>${esc(c.title)}</h2><p>${c.username ? "@" + esc(c.username) + " · " : ""}${esc(chatStatus(c, s))}</p></div>
      <button class="btn-sm" id="pin">${c.pinned ? "Désépingler" : "Épingler"}</button></div>
    ${crmContactHtml(c)}
    <div class="row">
      <div class="grow" style="min-width:200px"><label for="mode-o">Mode pour cette discussion</label>
        <select id="mode-o">
          <option value="" ${!c.mode_override ? "selected" : ""}>Comme le compte (${MODES[s.mode].label})</option>
          ${MODE_KEYS.map((k) => `<option value="${k}" ${c.mode_override === k ? "selected" : ""}>${MODES[k].label}</option>`).join("")}
          <option value="off" ${c.mode_override === "off" ? "selected" : ""}>IA désactivée</option>
        </select></div>
      <div style="align-self:flex-end">${paused ? `<button class="btn-sm" id="resume">Reprendre maintenant</button>` : `<button class="btn-sm" id="pause">Pause 1 h</button>`}</div>
    </div>
    ${c.ai_stopped ? `<div class="mode-banner" style="background:#f8e1e1">Ce contact a écrit /stopai : l'IA est arrêtée et sa mémoire a été effacée.
      <button class="btn-sm" id="restart" style="margin-left:8px">Réactiver (s'il te l'a demandé)</button></div>` : ""}
    ${last?.status === "scheduled" ? `<div class="mode-banner">Réponse prévue vers ${fmtDate(last.due_at)}. <button class="btn-sm" id="cancel" style="margin-left:8px">Annuler cette réponse</button></div>` : ""}
    ${last?.status === "failed" ? `<div class="mode-banner" style="background:#f8e1e1">Dernière réponse non envoyée : ${esc(last.error)} <button class="btn-sm" id="v2-retry">Réessayer</button></div>` : ""}
    <section class="panel" style="padding:12px"><div class="row" style="justify-content:space-between;align-items:center">
      <strong>Mémoire du contact</strong><button class="btn-sm" id="v2-clear-memory">Effacer le résumé</button></div>
      <p class="small muted">${esc(memory?.[0]?.summary || "Aucune information mémorisée")}</p></section>
    <div class="thread" id="thread">${msgs.length ? msgs.reverse().map((m) => `<div class="bubble ${m.role === "contact" ? "in" : m.role}">${esc(m.text)}
        <div class="meta">${m.role === "ai" ? "Assistant" : m.role === "owner" ? "Toi" : esc(c.title)} · ${fmtDate(m.created_at)}</div></div>`).join("")
      : `<p class="muted small" style="margin:auto">Mémoire vide pour cette discussion.</p>`}</div>
    <div class="row" style="justify-content:space-between"><p class="small muted" style="margin:0">Messages conservés 30 jours, propres à cette discussion.</p>
      <button class="btn-sm btn-danger" id="clear">Effacer la mémoire</button></div>`;
  crmBindDetail(c);
  const th = $("#thread"); th.scrollTop = th.scrollHeight;

  const upd = async (patch, msg) => {
    try { await q(sb.from("chats").update(patch).eq("id", c.id)); toast(msg); Object.assign(c, patch); render(); } catch (e) { fail(e); }
  };
  $("#v2-clear-memory")?.addEventListener("click",async()=>{
    if(!confirm("Effacer le résumé de ce contact ?"))return;
    try{await q(sb.from("contact_memory").delete().eq("chat_id",c.id));toast("Résumé effacé");showChat(c);}catch(e){fail(e);}
  });
  $("#pin").addEventListener("click", () => upd({ pinned: !c.pinned }, c.pinned ? "Discussion désépinglée" : "Discussion épinglée"));
  $("#mode-o").addEventListener("change", (e) => upd({ mode_override: e.target.value || null }, "Mode de la discussion enregistré"));
  $("#pause")?.addEventListener("click", () => upd({ paused_until: new Date(Date.now() + 3600e3).toISOString() }, "Discussion en pause pendant 1 h"));
  $("#resume")?.addEventListener("click", () => upd({ paused_until: null }, "L'assistant reprend cette discussion"));
  $("#restart")?.addEventListener("click", () => { if (confirm("Réactiver l'IA pour ce contact ? Fais-le uniquement s'il te l'a demandé.")) upd({ ai_stopped: false }, "IA réactivée pour ce contact"); });
  $("#v2-retry")?.addEventListener("click",async()=>{
    try{await api("retry_failed",{reply_id:last.id});toast("Réponse reprogrammée");showChat(c);}catch(e){fail(e);}
  });
  $("#cancel")?.addEventListener("click", async () => { try { await api("cancel_scheduled", { chat_id: c.id }); toast("Réponse annulée"); showChat(c); } catch (e) { fail(e); } });
  $("#clear").addEventListener("click", async () => {
    if (!confirm(`Effacer la mémoire de la discussion avec ${c.title} ?`)) return;
    try { await api("clear_chat_memory", { chat_id: c.id }); toast("Mémoire effacée"); showChat(c); } catch (e) { fail(e); }
  });
}

// ---------- CRM Relais IA V1 : fiches contacts, achats suivis, roles ----------
// Les montants saisis a la main ne sont JAMAIS presentes comme des paiements verifies.
let crmState = null;
const CRM_LABELS = {none:'Nouveau',bronze:'Bronze',silver:'Argent',gold:'Or',vip:'VIP'};
const crmMoney = cents => new Intl.NumberFormat('fr-FR',{style:'currency',currency:'EUR'}).format((Number(cents)||0)/100);
const crmSafeCents = value => {
  const n=Number(String(value??'').trim().replace(',','.'));
  if(!Number.isFinite(n)||n<=0||n>100000) throw new Error('Montant invalide');
  return Math.round(n*100);
};
function crmAccountFor(chatId) {
  const c=crmState?.byChat?.get(String(chatId));
  return c??{verified:0,manual:0,verifiedCount:0,manualCount:0,profile:{},sales:[],realPayments:[]};
}
function crmThresholds() {
  return crmState?.thresholds??{silver_cents:5000,gold_cents:15000,vip_cents:30000};
}
function crmRole(c) {
  const v=crmAccountFor(c.id),total=v.verified+v.manual,t=crmThresholds();
  const automatic = total>=t.vip_cents?'vip':total>=t.gold_cents?'gold':total>=t.silver_cents?'silver':total>=100?'bronze':'none';
  const role = CRM_LABELS[v.profile.role_override] ? v.profile.role_override : automatic;
  return {role,automatic,overridden:role!==automatic};
}
async function crmLoad(chats) {
  const uid=state.session?.user?.id;
  if(!uid) throw new Error('Session requise pour les fiches contacts');
  const [manual,profiles,thresholds,payments]=await Promise.all([
    q(sb.from('crm_manual_sales').select('id,chat_id,amount_cents,note,created_at').order('created_at',{ascending:false}).limit(2000)),
    q(sb.from('crm_contact_profiles').select('chat_id,nickname,notes,tags,role_override').limit(2000)),
    q(sb.from('crm_tier_settings').select('silver_cents,gold_cents,vip_cents').maybeSingle()),
    q(sb.from('payments').select('id,chat_id,amount,currency,provider,confirmed_at').eq('status','confirmed').eq('currency','EUR').in('provider',['dropp','dropp.fans']).limit(2000)),
  ]);
  const byChat=new Map();
  for(const c of chats) byChat.set(String(c.id),{verified:0,manual:0,verifiedCount:0,manualCount:0,profile:{},sales:[],realPayments:[]});
  for(const p of profiles??[]) {const v=byChat.get(String(p.chat_id));if(v)v.profile=p;}
  for(const x of manual??[]) {const v=byChat.get(String(x.chat_id));if(v){v.manual+=Number(x.amount_cents)||0;v.manualCount++;v.sales.push(x);}}
  for(const x of payments??[]) {const v=byChat.get(String(x.chat_id));if(v){v.verified+=Math.round(Number(x.amount)*100)||0;v.verifiedCount++;v.realPayments.push(x);}}
  crmState={uid,byChat,thresholds:thresholds??{silver_cents:5000,gold_cents:15000,vip_cents:30000}};
  return crmState;
}
function crmCardBadge(c) {
  const v=crmAccountFor(c.id),r=crmRole(c),total=v.manual+v.verified;
  const display=total?`${crmMoney(total)} suivis`:'Aucun achat suivi';
  return `<div class="crm-card-meta"><span class="crm-role crm-role-${r.role}">${CRM_LABELS[r.role]}${r.overridden?' (manuel)':''}</span><span class="crm-card-spend">${esc(display)}</span></div>`;
}
function crmContactHtml(c) {
  const v=crmAccountFor(c.id),r=crmRole(c),p=v.profile,t=crmThresholds();
  const totals=v.verified+v.manual;
  const history=v.sales.slice(0,20).map(x=>`<li><span>${esc(x.note||'Achat saisi')} · ${fmtDate(x.created_at,false)}</span><strong>${crmMoney(x.amount_cents)}</strong> <button type="button" class="btn-sm crm-remove-sale" data-id="${esc(x.id)}">Supprimer</button></li>`).join('');
  const verified=v.realPayments.slice(0,8).map(x=>`<li><span>Paiement Dropp confirmé · ${fmtDate(x.confirmed_at,false)}</span><strong>${crmMoney(Math.round(Number(x.amount)*100))}</strong></li>`).join('');
  return `<section class="crm-wrap" aria-label="Fiche client"><div class="crm-heading"><h3>Fiche client</h3><span class="crm-role crm-role-${r.role}">${CRM_LABELS[r.role]}${r.overridden?' · rôle attribué':''}</span></div>
    <div class="crm-kpis">
      <div><small>Total suivi</small><strong>${crmMoney(totals)}</strong></div>
      <div><small>Achat(s) saisi(s)</small><strong>${crmMoney(v.manual)}</strong></div>
      <div><small>Vérifié par Dropp</small><strong>${crmMoney(v.verified)}</strong></div>
      <div><small>Nombre d'achats suivis</small><strong>${v.manualCount+v.verifiedCount}</strong></div>
    </div>
    <p class="crm-disclaimer">Les achats saisis manuellement ne sont pas des paiements vérifiés. La synchronisation automatique avec dropp.fans doit encore être configurée.</p>
    <details class="crm-fold" open><summary>Informations sur le contact</summary>
      <form id="crm-profile" class="crm-form">
        <label>Nom interne<input id="crm-nickname" maxlength="80" placeholder="Surnom pour retrouver ce contact" value="${esc(p.nickname||'')}"></label>
        <label>Étiquettes (séparées par des virgules)<input id="crm-tags" maxlength="250" placeholder="Fidèle, à relancer, prioritaire" value="${esc((p.tags||[]).join(', '))}"></label>
        <label>Rôle<select id="crm-override">
          <option value="" ${!p.role_override?'selected':''}>Automatique selon les achats</option>
          ${['none','bronze','silver','gold','vip'].map(x=>`<option value="${x}" ${p.role_override===x?'selected':''}>${CRM_LABELS[x]} (manuel)</option>`).join('')}
        </select></label>
        <label class="crm-wide">Notes privées<textarea id="crm-notes" maxlength="2000" rows="3" placeholder="Informations pratiques, sans données sensibles">${esc(p.notes||'')}</textarea></label>
        <div class="crm-wide"><button type="submit" class="btn-primary">Enregistrer la fiche</button></div>
      </form>
    </details>
    <details class="crm-fold"><summary>Achats et fidélité</summary>
      <form id="crm-sale" class="crm-form">
        <label>Montant saisi (€)<input id="crm-sale-amount" type="number" min="0.01" max="100000" step="0.01" placeholder="19.90" required></label>
        <label>Libellé<input id="crm-sale-note" maxlength="120" placeholder="Lien Dropp - Pack photo" required></label>
        <div class="crm-wide"><button type="submit" class="btn-primary">Enregistrer un achat manuel</button></div>
      </form>
      <h4>Historique saisi</h4><ul class="crm-history">${history||'<li>Aucun achat enregistré manuellement.</li>'}</ul>
      <h4>Paiements vérifiés</h4><ul class="crm-history">${verified||'<li>Aucun paiement Dropp synchronisé.</li>'}</ul>
    </details>
    <details class="crm-fold"><summary>Configurer les seuils des rôles</summary>
      <p class="small muted">Bronze à partir de 1 €. Les montants des rôles se basent sur le total suivi (vérifié + déclaré). Les changements concernent toutes tes discussions.</p>
      <form id="crm-thresholds" class="crm-form">
        <label>Argent, à partir de (€)<input id="crm-silver" type="number" step="0.01" min="1.01" max="999999" required value="${(t.silver_cents/100).toFixed(2)}"></label>
        <label>Or, à partir de (€)<input id="crm-gold" type="number" step="0.01" min="1.01" max="999999" required value="${(t.gold_cents/100).toFixed(2)}"></label>
        <label>VIP, à partir de (€)<input id="crm-vip" type="number" step="0.01" min="1.01" max="999999" required value="${(t.vip_cents/100).toFixed(2)}"></label>
        <div class="crm-wide"><button type="submit" class="btn-primary">Enregistrer les seuils</button></div>
      </form>
    </details>
  </section>`;
}
function crmBindDetail(c) {
  $('#crm-profile')?.addEventListener('submit',async e=>{
    e.preventDefault();const btn=$('#crm-profile button[type=submit]');btn.disabled=true;
    try {
      const nickname=$('#crm-nickname').value.trim().slice(0,80)||null;
      const notes=$('#crm-notes').value.trim().slice(0,2000)||null;
      const tags=[...new Set($('#crm-tags').value.split(',').map(s=>s.trim()).filter(Boolean))].slice(0,8);
      if(tags.some(t=>t.length>32))throw new Error('Étiquette limitée à 32 caractères');
      const override=$('#crm-override').value||null;
      await q(sb.from('crm_contact_profiles').upsert({user_id:state.session.user.id,chat_id:c.id,nickname,notes,tags,role_override:override},{onConflict:'chat_id'}));
      toast('Fiche client enregistrée');render();
    }catch(err){fail(err);}finally{btn.disabled=false;}
  });
  $('#crm-sale')?.addEventListener('submit',async e=>{
    e.preventDefault();const btn=$('#crm-sale button[type=submit]');btn.disabled=true;
    try{
      const cents=crmSafeCents($('#crm-sale-amount').value);
      const note=$('#crm-sale-note').value.trim().slice(0,120);
      if(!note)throw new Error('Indique un libellé pour cet achat');
      await q(sb.from('crm_manual_sales').insert({user_id:state.session.user.id,chat_id:c.id,amount_cents:cents,note}));
      toast('Achat manuel ajouté (non vérifié par Dropp)');render();
    }catch(err){fail(err);}finally{btn.disabled=false;}
  });
  $$('.crm-remove-sale').forEach(b=>b.addEventListener('click',async()=>{
    if(!confirm('Supprimer cet achat saisi manuellement ?'))return;
    try{await q(sb.from('crm_manual_sales').delete().eq('id',b.dataset.id).eq('chat_id',c.id));toast('Achat manuel supprimé');render();}catch(err){fail(err);}
  }));
  $('#crm-thresholds')?.addEventListener('submit',async e=>{
    e.preventDefault();const btn=$('#crm-thresholds button[type=submit]');btn.disabled=true;
    try{
      const silver=crmSafeCents($('#crm-silver').value),gold=crmSafeCents($('#crm-gold').value),vip=crmSafeCents($('#crm-vip').value);
      if(!(100<silver&&silver<gold&&gold<vip))throw new Error('Seuils requis : Bronze < Argent < Or < VIP');
      await q(sb.from('crm_tier_settings').upsert({user_id:state.session.user.id,silver_cents:silver,gold_cents:gold,vip_cents:vip}));
      toast('Seuils enregistrés');render();
    }catch(err){fail(err);}finally{btn.disabled=false;}
  });
}
function crmListFilters(chats) {
  const search=$('#search'),filter=$('#crm-role-filter'),sort=$('#crm-sort'),list=$('#list');
  if(!search||!filter||!sort||!list)return;
  const run=()=>{
    const query=search.value.trim().toLowerCase();
    let els=$$('.convo',list);
    els.sort((a,b)=>{
      const x=chats.find(c=>String(c.id)===a.dataset.id),y=chats.find(c=>String(c.id)===b.dataset.id);
      const pin=(Number(y?.pinned||0)-Number(x?.pinned||0));if(pin)return pin;
      if(sort.value==='spend')return (crmAccountFor(y.id).manual+crmAccountFor(y.id).verified)-(crmAccountFor(x.id).manual+crmAccountFor(x.id).verified);
      if(sort.value==='name')return String(x.title).localeCompare(String(y.title),'fr');
      return new Date(y.last_message_at||0)-new Date(x.last_message_at||0);
    });
    els.forEach(li=>list.appendChild(li));
    for(const li of els){
      const c=chats.find(c=>String(c.id)===li.dataset.id),a=crmAccountFor(c.id),role=crmRole(c).role;
      let ok=true;if(query&&!li.dataset.q.includes(query))ok=false;
      if(filter.value==='buyers' && a.manual+a.verified<=0)ok=false;
      if(filter.value==='none' && a.manual+a.verified>0)ok=false;
      if(['bronze','silver','gold','vip'].includes(filter.value)&&role!==filter.value)ok=false;
      li.classList.toggle('hidden',!ok);
    }
  };
  search.oninput=run;filter.addEventListener('change',run);sort.addEventListener('change',run);run();
}
// ---------- Fin CRM ----------

// ---------- Statistiques ----------
async function viewStats(main) {
  const ranges = [["24h", "24 h"], ["7d", "7 jours"], ["30d", "30 jours"], ["90d", "90 jours"], ["all", "Depuis le début"], ["custom", "Personnalisé"]];
  const today = new Date().toISOString().slice(0, 10);
  main.innerHTML = `${head("Statistiques", "Calculées à partir des échanges enregistrés.")}
    <section class="panel"><div class="chips" id="ranges">${ranges.map(([k, l]) => `<button class="chip" data-r="${k}" aria-pressed="${state.statsRange === k}">${l}</button>`).join("")}</div>
      <form class="row ${state.statsRange === "custom" ? "" : "hidden"}" id="custom" style="margin-top:14px">
        <div><label for="from">Du</label><input type="date" id="from" value="${state.statsFrom ?? new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10)}"></div>
        <div><label for="to">Au</label><input type="date" id="to" value="${state.statsTo ?? today}"></div>
        <button class="btn-primary" style="align-self:flex-end" type="submit">Appliquer</button></form></section>
    <div id="stats-body" style="margin-top:16px"></div>`;
  $$("#ranges .chip").forEach((c) => c.addEventListener("click", () => {
    state.statsRange = c.dataset.r;
    $$("#ranges .chip").forEach((x) => x.setAttribute("aria-pressed", String(x === c)));
    $("#custom").classList.toggle("hidden", c.dataset.r !== "custom");
    if (c.dataset.r !== "custom") loadStats();
  }));
  $("#custom").addEventListener("submit", (e) => { e.preventDefault(); state.statsFrom = $("#from").value; state.statsTo = $("#to").value; loadStats(); });
  loadStats();
}

async function loadStats() {
  const now = new Date();
  let from, to = now;
  const r = state.statsRange;
  if (r === "24h") from = new Date(now - 864e5);
  else if (r === "7d") from = new Date(now - 7 * 864e5);
  else if (r === "30d") from = new Date(now - 30 * 864e5);
  else if (r === "90d") from = new Date(now - 90 * 864e5);
  else if (r === "all") from = new Date(state.overview.profile.created_at ?? now - 365 * 864e5);
  else { from = new Date(state.statsFrom + "T00:00:00"); to = new Date(state.statsTo + "T23:59:59"); }
  if (r === "all" && !state.overview.profile.created_at) {
    const p = await q(sb.from("profiles").select("created_at").eq("id", state.overview.profile.id).single());
    from = new Date(p.created_at); state.overview.profile.created_at = p.created_at;
  }
  if (!(from < to)) return toast("La date de début doit précéder la date de fin.", true);
  const body = $("#stats-body");
  body.innerHTML = `<div class="empty">Calcul en cours…</div>`;
  try {
    const st = await q(sb.rpc("get_stats", { p_from: from.toISOString(), p_to: to.toISOString() }));
    const v2 = await q(sb.rpc("get_relais_v2_stats", {p_from:from.toISOString(),p_to:to.toISOString()}));
    const kpi = (n, l) => `<div class="kpi"><div class="big-num">${nf.format(n)}</div><div class="label">${l}</div></div>`;
    const series = st.series ?? [];
    const max = Math.max(1, ...series.map((d) => Math.max(d.received, d.ai_sent + d.owner)));
    body.innerHTML = `<div class="kpis">
      ${kpi(st.received, "Messages reçus")}${kpi(st.ai_sent, "Réponses de l'assistant")}${kpi(st.owner, "Tes propres réponses")}
      ${kpi(v2.failed_replies||0, "Réponses en échec")}${kpi(v2.confirmed_payments||0, "Paiements confirmés")}${kpi(st.drafts, "Brouillons préparés")}${kpi(st.link_sent, "Réponses avec un lien")}${kpi(st.active_chats, "Discussions actives")}</div>
      <section class="panel"><p class="hint">Coût NoTrack estimé : $${Number(v2.estimated_ai_cost_usd||0).toFixed(4)} · Entrée : ${nf.format(Number(v2.tokens_in||0))} tokens · Sortie : ${nf.format(Number(v2.tokens_out||0))} tokens · CA confirmé : ${Number(v2.confirmed_revenue_eur||0).toFixed(2)} €.</p></section>
      <section class="panel"><div class="panel-head"><div><h2>Activité par jour</h2></div>
        <div class="legend"><span style="--c:#c7cfe6">Reçus</span><span style="--c:var(--auto)">Assistant</span><span style="--c:var(--signal)">Toi</span></div></div>
        ${series.length > 0 ? `<div class="chart" role="img" aria-label="Activité par jour">${series.map((d) => `
          <div class="col" title="${esc(d.day)} : ${d.received} reçus, ${d.ai_sent} assistant, ${d.owner} toi">
            <i class="r" style="position:absolute;bottom:0;left:0;right:0;height:${(d.received / max) * 100}%;opacity:.7"></i>
            <i class="a" style="position:relative;height:${(d.ai_sent / max) * 100}%"></i>
            <i class="o" style="position:relative;height:${(d.owner / max) * 100}%"></i></div>`).join("")}</div>
          <div class="chart-axis"><span>${esc(series[0].day.split("-").reverse().join("/"))}</span><span>${esc(series[series.length - 1].day.split("-").reverse().join("/"))}</span></div>`
        : `<div class="empty">Pas encore de données sur cette période.</div>`}
        <p class="hint">Taux de prise en charge : ${st.received ? Math.round(((st.ai_sent + st.owner) / st.received) * 100) : 0}% des messages reçus ont eu une réponse.</p>
      </section>`;
  } catch (e) { fail(e); body.innerHTML = ""; }
}

// ---------- Apprentissage ----------
function lockedNote(feature) {
  return `<div class="locked-note"><div><strong>${feature} est réservé aux abonnements Pro et Scale.</strong>
    <p class="small muted" style="margin:4px 0 0">Ton abonnement actuel : ${esc(state.overview.plan?.name ?? "")}. Contacte-nous pour changer d'offre.</p></div>
    <a class="btn btn-sm" href="#/app/compte">Voir les abonnements</a></div>`;
}

async function viewLearn(main) {
  const ok = !!state.overview.plan?.learning;
  const [instr, pending, validated] = await Promise.all([
    q(sb.from("instructions").select("*").order("created_at", { ascending: false })),
    q(sb.from("examples").select("*").eq("status", "pending").order("created_at", { ascending: false }).limit(50)),
    q(sb.from("examples").select("*").eq("status", "validated").order("created_at", { ascending: false }).limit(100)),
  ]);
  const bot = state.overview.bot_username;
  main.innerHTML = `${head("Apprentissage", "Enseigne ton ton et tes préférences à l'assistant.", `<a class="btn btn-sm" href="#/guide">Guide d'apprentissage</a>`)}
  ${ok ? "" : lockedNote("L'apprentissage")}
  <div class="grid-2">
    <section class="panel">
      <div class="panel-head"><div><h2>Nouvelle consigne</h2><p>Une règle courte et vérifiable. Les consignes passent avant le style observé.</p></div></div>
      <form id="instr-form"><textarea id="instr" maxlength="1000" ${ok ? "" : "disabled"} placeholder="Ex. : Je tutoie mes contacts, je réponds en 1 à 3 phrases et j'utilise parfois « dsl » ou « mdr » quand le ton s'y prête."></textarea>
        <button class="btn-primary" type="submit" style="margin-top:10px" ${ok ? "" : "disabled"}>Enregistrer la consigne</button></form>
      <p class="hint">Depuis Telegram : envoie <b>/learn ta consigne</b> en privé à ${bot ? "@" + esc(bot) : "ton bot"}.</p>
    </section>
    <section class="panel">
      <div class="panel-head"><div><h2>Style observé</h2><p>Construit à partir de tes vraies réponses que tu as validées, jamais à partir des messages de l'assistant.</p></div></div>
      <div class="big-num">${validated.length}</div><p class="small muted">exemples validés${validated.length < 5 ? " · 5 minimum recommandés pour un style fiable" : ""}</p>
    </section>
  </div>

  <section class="panel">
    <div class="panel-head"><div><h2>Consignes</h2><p>Désactive une consigne pour la mettre de côté sans la supprimer.</p></div><span class="tag">${instr.length}</span></div>
    ${instr.length ? `<ul class="list">${instr.map((i) => `<li data-id="${i.id}"><div class="grow"><div>${esc(i.text)}</div>
        <div class="small muted">${i.source === "telegram" ? "Ajoutée via /learn" : "Ajoutée depuis le tableau de bord"} · ${fmtDate(i.created_at)}</div></div>
        <div class="row"><label class="switch"><input type="checkbox" data-act="toggle" ${i.active ? "checked" : ""}><span class="track"></span><span class="hidden">Active</span></label>
        <button class="btn-ghost btn-sm btn-danger" data-act="del">Supprimer</button></div></li>`).join("")}</ul>`
      : `<div class="empty">Aucune consigne. Commence par ton registre (tutoiement, longueur des réponses, expressions).</div>`}
  </section>

  <section class="panel">
    <div class="panel-head"><div><h2>Exemples à valider</h2><p>Tes réponses manuelles récentes. Valide celles qui te ressemblent, supprime celles qui contiennent une erreur, un secret ou une info personnelle.</p></div>
      <span class="tag ${pending.length ? "warn" : ""}">${pending.length}</span></div>
    ${pending.length ? `<ul class="list">${pending.map((e) => exampleItem(e, true)).join("")}</ul>`
      : `<div class="empty">Réponds toi-même à quelques discussions Telegram : tes réponses apparaîtront ici pour validation.</div>`}
  </section>

  ${validated.length ? `<section class="panel"><details><summary><strong>Exemples validés (${validated.length})</strong></summary>
    <ul class="list" style="margin-top:12px">${validated.map((e) => exampleItem(e, false)).join("")}</ul></details></section>` : ""}`;

  $("#instr-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = $("#instr").value.trim();
    if (text.length < 3) return toast("Écris une consigne d'au moins 3 caractères.", true);
    try { await q(sb.from("instructions").insert({ text })); toast("Consigne enregistrée"); render(); } catch (err) { fail(err); }
  });
  $$("li[data-id]").forEach((li) => {
    const id = Number(li.dataset.id);
    const isEx = li.dataset.kind === "ex";
    $("[data-act=toggle]", li)?.addEventListener("change", (e) =>
      q(sb.from("instructions").update({ active: e.target.checked }).eq("id", id)).then(() => toast(e.target.checked ? "Consigne activée" : "Consigne désactivée")).catch(fail));
    $("[data-act=del]", li)?.addEventListener("click", async () => {
      try { await q(sb.from(isEx ? "examples" : "instructions").delete().eq("id", id)); li.remove(); toast(isEx ? "Exemple supprimé" : "Consigne supprimée"); state.overview = null; } catch (e) { fail(e); }
    });
    $("[data-act=validate]", li)?.addEventListener("click", async () => {
      try { await q(sb.from("examples").update({ status: "validated", reply_text: $("textarea", li).value.trim() }).eq("id", id)); toast("Exemple validé"); state.overview = null; render(); } catch (e) { fail(e); }
    });
  });
}
function exampleItem(e, pending) {
  return `<li data-id="${e.id}" data-kind="ex"><div class="example grow"><div class="q">${esc(e.contact_text)}</div>
    ${pending ? `<textarea aria-label="Ta réponse" rows="2">${esc(e.reply_text)}</textarea>` : `<div class="a">${esc(e.reply_text)}</div>`}</div>
    <div class="row">${pending ? `<button class="btn-primary btn-sm" data-act="validate">Valider</button>` : ""}<button class="btn-ghost btn-sm btn-danger" data-act="del">Supprimer</button></div></li>`;
}

// ---------- Liens de vente ----------
async function viewLinks(main) {
  const ok = !!state.overview.plan?.buy;
  const links = await q(sb.from("links").select("*").order("created_at", { ascending: false }));
  const s = state.settings;
  main.innerHTML = `${head("Liens de vente", "Tes offres, proposées au bon moment dans la conversation.")}
  ${ok ? "" : lockedNote("Les liens de vente")}
  <section class="panel">
    <div class="panel-head"><div><h2>Proposer mes liens</h2><p>L'assistant n'utilise que les liens ci-dessous, n'invente aucun prix, ne prend aucun paiement et n'insiste pas après un refus.</p></div>
      <label class="switch"><input type="checkbox" id="buy-on" ${s.buy_enabled ? "checked" : ""} ${ok ? "" : "disabled"}><span class="track"></span>${s.buy_enabled ? "Activé" : "Désactivé"}</label></div>
  </section>
  <div class="grid-2" style="margin-top:16px">
    <section class="panel">
      <h2 style="margin-bottom:14px">Ajouter un lien</h2>
      <form id="link-form">
        <div class="field"><label for="l-title">Nom de l'offre</label><input id="l-title" type="text" required maxlength="120" placeholder="Ex. : Programme 4 semaines" ${ok ? "" : "disabled"}></div>
        <div class="field"><label for="l-url">Lien</label><input id="l-url" type="url" required placeholder="https://…" ${ok ? "" : "disabled"}></div>
        <div class="field"><label for="l-price">Prix affiché (facultatif)</label><input id="l-price" type="text" maxlength="40" placeholder="Ex. : 29 €" ${ok ? "" : "disabled"}></div>
        <div class="field"><label for="l-desc">Quand le proposer</label><textarea id="l-desc" maxlength="500" rows="3" placeholder="Ex. : Quand quelqu'un demande comment travailler avec moi ou parle de reprendre le sport." ${ok ? "" : "disabled"}></textarea></div>
        <label class="switch"><input type="checkbox" id="l-adult" ${ok ? "" : "disabled"}><span class="track"></span>Offre réservée aux adultes (18+)</label>
        <p class="hint">Les offres 18+ restent désactivées dans les réponses IA tant que la vérification d'âge n'est pas intégrée.</p>
        <button class="btn-primary" type="submit" ${ok ? "" : "disabled"}>Ajouter le lien</button>
      </form>
    </section>
    <section class="panel">
      <div class="panel-head"><div><h2>Mes liens</h2></div><span class="tag">${links.length}</span></div>
      ${links.length ? `<ul class="list">${links.map((l) => `<li data-id="${l.id}"><div class="grow" style="min-width:0">
          <strong>${esc(l.title)}</strong>${l.price_label ? ` <span class="tag">${esc(l.price_label)}</span>` : ""}
          <div class="small" style="overflow-wrap:anywhere"><a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.url)}</a></div>
          ${l.description ? `<div class="small muted">${esc(l.description)}</div>` : ""}</div>
          <div class="row"><label class="switch"><input type="checkbox" data-act="toggle" ${l.active ? "checked" : ""}><span class="track"></span><span class="hidden">Actif</span></label>
          <button class="btn-ghost btn-sm btn-danger" data-act="del">Supprimer</button></div></li>`).join("")}</ul>`
        : `<div class="empty">Aucun lien enregistré.</div>`}
    </section>
  </div>`;
  $("#buy-on").addEventListener("change", (e) => saveSettings({ buy_enabled: e.target.checked }, e.target.checked ? "Liens de vente activés" : "Liens de vente désactivés").then(() => render()).catch(fail));
  $("#link-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await q(sb.from("links").insert({ title: $("#l-title").value.trim(), url: $("#l-url").value.trim(), price_label: $("#l-price").value.trim() || null, description: $("#l-desc").value.trim() || null, adult_only: $("#l-adult").checked }));
      toast("Lien ajouté"); render();
    } catch (err) { fail(err); }
  });
  $$("li[data-id]").forEach((li) => {
    const id = Number(li.dataset.id);
    $("[data-act=toggle]", li).addEventListener("change", (e) => q(sb.from("links").update({ active: e.target.checked }).eq("id", id)).then(() => toast(e.target.checked ? "Lien activé" : "Lien désactivé")).catch(fail));
    $("[data-act=del]", li).addEventListener("click", async () => { try { await q(sb.from("links").delete().eq("id", id)); li.remove(); toast("Lien supprimé"); } catch (e) { fail(e); } });
  });
}

// ---------- Compte ----------
async function viewAccount(main) {
  await loadAccount();
  const ov = state.overview;
  const plans = await q(sb.from("plans").select("*").order("sort"));
  const link = tgLink();
  const linked = !!ov.telegram?.telegram_user_id;
  main.innerHTML = `${head("Mon compte")}
  <div class="grid-2">
    <section class="panel"><h2 style="margin-bottom:14px">Profil</h2>
      <form id="profile-form"><div class="field"><label for="dn">Nom affiché</label><input id="dn" type="text" maxlength="60" value="${esc(ov.profile.display_name)}"></div>
      <p class="small muted">E-mail : ${esc(ov.profile.email)}</p><button class="btn-primary btn-sm" type="submit">Enregistrer</button></form></section>
    <section class="panel"><div class="panel-head"><div><h2>Telegram</h2><p>${linked ? `Lié à ${esc(ov.telegram.telegram_name ?? "")}${ov.telegram.telegram_username ? " (@" + esc(ov.telegram.telegram_username) + ")" : ""}` : "Aucun compte Telegram lié."}</p></div>
        <span class="tag ${ov.connection?.can_reply ? "ok" : linked ? "warn" : ""}">${ov.connection?.can_reply ? "Telegram Business autorisé" : linked ? "Business non autorisé" : "Non lié"}</span></div>
      <div class="row">${link && !linked ? `<a class="btn btn-signal btn-sm" href="${esc(link)}" target="_blank" rel="noopener">Lier Telegram</a>` : ""}
        ${linked ? `<button class="btn-sm" id="rights">Actualiser les droits</button><button class="btn-ghost btn-sm btn-danger" id="unlink">Délier</button>` : ""}</div>
      <p class="hint">Pour couper l'assistant côté Telegram : Réglages → Telegram Business → Chatbots → retirer le bot.</p></section>
  </div>
  <section class="panel"><div class="panel-head"><div><h2>Abonnements</h2><p>Pour changer d'offre ou renouveler, contacte l'équipe ${BRAND}.</p></div></div>
    <div class="plans">${plans.map((p) => planCard(p, ov.profile.plan_id)).join("")}</div></section>
  <section class="panel"><h2 style="margin-bottom:8px">Données et confidentialité</h2>
    <p class="muted">Mémoires séparées par discussion, messages conservés 30 jours maximum. Un contact peut écrire /stopai pour arrêter l'IA et effacer la mémoire de sa discussion.</p>
    <div class="row"><button class="btn-sm" id="wipe">Effacer mes données</button><button class="btn-sm btn-danger" id="del-acc">Supprimer mon compte</button><button class="btn-ghost btn-sm" id="logout">Se déconnecter</button></div>
    ${ov.profile.is_admin ? "" : `<details style="margin-top:18px"><summary class="small muted">J'ai un code administrateur</summary>
      <form class="row" id="admin-form" style="margin-top:10px"><input id="admin-code" type="text" style="max-width:220px" placeholder="Code" autocomplete="off"><button class="btn-sm" type="submit">Valider le code</button></form></details>`}
  </section>`;

  $("#profile-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try { await q(sb.from("profiles").update({ display_name: $("#dn").value.trim() }).eq("id", ov.profile.id)); toast("Profil enregistré"); state.overview = null; } catch (err) { fail(err); }
  });
  $("#rights")?.addEventListener("click", async () => { try { const r = await api("refresh_rights"); toast(r.can_reply ? "Le bot peut répondre" : "Le bot n'a pas encore le droit de répondre"); render(); } catch (e) { fail(e); } });
  $("#unlink")?.addEventListener("click", async () => { if (!confirm("Délier ce compte Telegram ? L'assistant arrêtera de répondre.")) return; try { await api("unlink_telegram"); toast("Telegram délié"); render(); } catch (e) { fail(e); } });
  $("#wipe").addEventListener("click", async () => {
    if (!confirm("Effacer toutes tes discussions, consignes, exemples et liens ? Ton compte et tes réglages sont conservés.")) return;
    try { await api("delete_my_data"); toast("Données effacées"); state.overview = null; } catch (e) { fail(e); }
  });
  $("#del-acc").addEventListener("click", async () => {
    if (prompt("Pour supprimer définitivement ton compte, écris SUPPRIMER") !== "SUPPRIMER") return;
    try { await api("delete_account"); await sb.auth.signOut(); toast("Compte supprimé"); location.hash = "#/"; } catch (e) { fail(e); }
  });
  $("#logout").addEventListener("click", async () => { await sb.auth.signOut(); location.hash = "#/"; });
  $("#admin-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const ok = await q(sb.rpc("claim_admin", { p_code: $("#admin-code").value }));
      if (!ok) return toast("Code invalide.", true);
      toast("Tu es maintenant administrateur"); state.overview = null; location.hash = "#/app/admin";
    } catch (err) { fail(err); }
  });
}

// ---------- Administration ----------
async function viewAdmin(main) {
  main.innerHTML = `${head("Administration", "Configuration de la plateforme et gestion des clients.")}<div class="empty">Chargement…</div>`;
  const [st, users, plans] = await Promise.all([
    api("admin_status").catch((e) => ({ error: e.message })),
    q(sb.rpc("admin_list_users")),
    q(sb.from("plans").select("*").order("sort")),
  ]);
  const wh = st.webhook;
  const whOk = wh && !wh.error && wh.url && wh.url.includes("/functions/v1/telegram-webhook");
  main.innerHTML = `${head("Administration", "Configuration de la plateforme et gestion des clients.")}
  <section class="panel">
    <div class="panel-head"><div><h2>Configuration</h2><p>Le bot Telegram partagé, le fournisseur IA et son modèle.</p></div></div>
    <div class="row" style="margin-bottom:16px">
      <span class="tag ${st.has_token ? "ok" : "bad"}">Bot ${st.bot_username ? "@" + esc(st.bot_username) : "non configuré"}</span>
      <span class="tag ${whOk ? "ok" : "bad"}">Webhook ${whOk ? "actif" : "inactif"}</span>
      <span class="tag ${st.has_anthropic_key ? "ok" : "bad"}">Clé Claude ${st.has_anthropic_key ? "enregistrée" : "manquante"}</span>
      <span class="tag">Moteur ${st.ai_provider === "notrack" ? "NoTrack" : st.ai_provider === "openai" ? "OpenAI" : "Claude"}</span>
      <span class="tag ${st.has_openai_key ? "ok" : "warn"}">Clé OpenAI ${st.has_openai_key ? "présente" : "absente"}</span>
      <span class="tag ${st.has_notrack_key ? "ok" : "warn"}">Clé NoTrack ${st.has_notrack_key ? "présente" : "absente"}</span>
      <span class="tag">Modèle ${esc(st.ai_provider === "notrack" ? "notrack-uncensored" : st.ai_provider === "openai" ? st.openai_model : st.model)}</span>
      ${wh?.pending_update_count ? `<span class="tag warn">${wh.pending_update_count} mises à jour en attente</span>` : ""}
    </div>
    ${wh?.last_error_message ? `<div class="mode-banner" style="background:#f8e1e1;margin:0 0 16px">Dernière erreur Telegram : ${esc(wh.last_error_message)}</div>` : ""}
    <form id="cfg-form" class="grid-2" style="gap:14px">
      <div class="field"><label for="tok">Token du bot Telegram</label><input id="tok" type="password" autocomplete="off" placeholder="${st.has_token ? "Enregistré, laisse vide pour le garder" : "123456:ABC…"}">
        <p class="hint">Crée le bot avec @BotFather, puis Bot Settings → Business Mode → Turn on.</p></div>
      <div class="field"><label for="akey">Clé API Anthropic</label><input id="akey" type="password" autocomplete="off" placeholder="${st.has_anthropic_key ? "Enregistrée, laisse vide pour la garder" : "sk-ant-…"}">
        <p class="hint">À créer sur console.anthropic.com. Elle est testée avant d'être enregistrée.</p></div>
      <div class="field"><label for="model">Modèle Claude</label><input id="model" type="text" value="${esc(st.model ?? "claude-haiku-5-5")}">
      <p class="hint">Conservé comme alternative à OpenAI.</p></div>
      <div class="field"><label for="provider">Moteur IA actif</label><select id="provider">
      <option value="anthropic" ${(!st.ai_provider || st.ai_provider === "anthropic") ? "selected" : ""}>Claude — Anthropic</option>
      <option value="openai" ${st.ai_provider === "openai" ? "selected" : ""}>OpenAI — GPT</option>
      <option value="notrack" ${st.ai_provider === "notrack" ? "selected" : ""}>NoTrack — API</option>
      </select><p class="hint">Global : s'applique à tous les utilisateurs de Relais IA.</p></div>
      <div class="field"><label for="openai-model">Modèle OpenAI</label><select id="openai-model">
      <option value="gpt-5.4-mini" ${st.openai_model !== "gpt-5.4" ? "selected" : ""}>GPT-5.4 mini — économique</option>
      <option value="gpt-5.4" ${st.openai_model === "gpt-5.4" ? "selected" : ""}>GPT-5.4 — plus performant</option>
      </select><p class="hint">La clé OpenAI doit être ajoutée dans Supabase → Edge Functions → Secrets sous OPENAI_API_KEY. Ne la saisis jamais dans GitHub Pages.</p></div>
      <p class="hint">NoTrack : clé API dans Supabase → Edge Functions → Secrets sous NOTRACK_API_KEY. Pas dans GitHub. Le chat web NoTrack gratuit est distinct de son API.</p>
      <div style="align-self:end;margin-bottom:14px"><button class="btn-primary" type="submit">Enregistrer la configuration</button></div>
    </form>
  </section>

  <section class="panel">
    <div class="panel-head"><div><h2>Clients</h2><p>Attribue un abonnement et sa durée. La période et le quota repartent de zéro à l'enregistrement.</p></div><span class="tag">${users.length}</span></div>
    <div class="table-wrap"><table><thead><tr><th>Client</th><th>Telegram</th><th>Mode</th><th>Utilisé</th><th>Échéance</th><th>Abonnement</th><th>Durée</th><th></th></tr></thead><tbody>
    ${users.map((u) => { const p = plans.find((x) => x.id === u.plan_id); return `<tr data-id="${u.id}">
      <td><strong>${esc(u.display_name ?? "")}</strong>${u.is_admin ? ' <span class="tag signal">Admin</span>' : ""}<div class="small muted">${esc(u.email)}</div></td>
      <td class="small">${u.linked ? (u.telegram_username ? "@" + esc(u.telegram_username) : "Lié") : '<span class="muted">Non lié</span>'}</td>
      <td class="small">${esc(MODES[u.mode]?.label ?? u.mode ?? "")}</td>
      <td class="small">${nf.format(u.quota_used)} / ${nf.format(p?.msg_quota ?? 0)}</td>
      <td class="small ${new Date(u.period_end) < new Date() ? "btn-danger" : ""}">${fmtDate(u.period_end, false)}</td>
      <td><select data-f="plan">${plans.map((x) => `<option value="${x.id}" ${x.id === u.plan_id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></td>
      <td><select data-f="days"><option value="7">7 jours</option><option value="30" selected>30 jours</option><option value="90">90 jours</option><option value="365">1 an</option></select></td>
      <td><button class="btn-sm" data-act="save">Appliquer</button></td></tr>`; }).join("")}
    </tbody></table></div>
  </section>

  <section class="panel">
    <div class="panel-head"><div><h2>Offres</h2><p>Quotas, prix affichés et fonctions incluses.</p></div></div>
    <div class="table-wrap"><table><thead><tr><th>Offre</th><th>Quota</th><th>Prix affiché</th><th>Apprentissage</th><th>Liens de vente</th><th></th></tr></thead><tbody>
    ${plans.map((p) => `<tr data-plan="${p.id}"><td><input type="text" data-f="name" value="${esc(p.name)}" style="min-width:110px"></td>
      <td><input type="number" data-f="msg_quota" value="${p.msg_quota}" min="0" style="width:100px"></td>
      <td><input type="text" data-f="price_label" value="${esc(p.price_label ?? "")}" style="min-width:140px"></td>
      <td><label class="switch"><input type="checkbox" data-f="learning" ${p.learning ? "checked" : ""}><span class="track"></span><span class="hidden">Apprentissage</span></label></td>
      <td><label class="switch"><input type="checkbox" data-f="buy" ${p.buy ? "checked" : ""}><span class="track"></span><span class="hidden">Liens</span></label></td>
      <td><button class="btn-sm" data-act="save-plan">Enregistrer</button></td></tr>`).join("")}
    </tbody></table></div>
  </section>`;

  $("#cfg-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#cfg-form button"); btn.disabled = true;
    const body = {};
    if ($("#tok").value.trim()) body.telegram_bot_token = $("#tok").value.trim();
    if ($("#akey").value.trim()) body.anthropic_api_key = $("#akey").value.trim();
    if ($("#model").value.trim() && $("#model").value.trim() !== st.model) body.anthropic_model = $("#model").value.trim();
    if ($("#provider").value !== (st.ai_provider || "anthropic")) body.ai_provider = $("#provider").value;
    if ($("#openai-model").value !== (st.openai_model || "gpt-5.4-mini")) body.openai_model = $("#openai-model").value;
    if (!Object.keys(body).length) { btn.disabled = false; return toast("Rien à enregistrer."); }
    try { const r = await api("admin_save", body); toast(r.bot_username ? `Bot @${r.bot_username} connecté` : "Configuration enregistrée"); state.overview = null; render(); }
    catch (err) { fail(err); btn.disabled = false; }
  });
  $$("tr[data-id]").forEach((tr) => $("[data-act=save]", tr).addEventListener("click", async () => {
    try {
      await q(sb.rpc("admin_set_plan", { p_user: tr.dataset.id, p_plan: $("[data-f=plan]", tr).value, p_days: Number($("[data-f=days]", tr).value) }));
      toast("Abonnement appliqué"); render();
    } catch (e) { fail(e); }
  }));
  $$("tr[data-plan]").forEach((tr) => $("[data-act=save-plan]", tr).addEventListener("click", async () => {
    try {
      await q(sb.from("plans").update({
        name: $("[data-f=name]", tr).value.trim(), msg_quota: Number($("[data-f=msg_quota]", tr).value) || 0,
        price_label: $("[data-f=price_label]", tr).value.trim(), learning: $("[data-f=learning]", tr).checked, buy: $("[data-f=buy]", tr).checked,
      }).eq("id", tr.dataset.plan));
      toast("Offre enregistrée");
    } catch (e) { fail(e); }
  }));
}

// ---------- Guide ----------
function renderGuide() {
  setMode("auto");
  root.innerHTML = `${siteNav()}<article class="guide">
    <a class="btn btn-ghost btn-sm" href="${state.session ? "#/app/apprentissage" : "#/"}">Retour</a>
    <h1>Bien apprendre à ton assistant</h1>
    <p>Trois choses font un assistant qui te ressemble : des consignes claires, de vrais exemples validés, et une mémoire séparée pour chaque contact.</p>

    <h2>À quoi sert l'apprentissage</h2>
    <p>Tu y décris tes préférences : tutoiement ou vouvoiement, longueur des réponses, façon de saluer, vocabulaire, règles de ton activité et réponses aux questions fréquentes. L'assistant les combine avec la mémoire de chaque discussion, sans jamais réutiliser ce qu'un contact a dit dans la discussion d'un autre.</p>
    <p>Une consigne n'envoie rien à elle seule : seuls les modes Validation et Automatique préparent des réponses.</p>

    <h2>Écrire une bonne consigne</h2>
    <p>Une règle courte, précise et vérifiable vaut mieux qu'une longue biographie. Par exemple : « Dans les conversations détendues, je tutoie, je réponds en une à trois phrases et j'évite les formules commerciales. »</p>
    <p>Évite les consignes qui se contredisent, et relis régulièrement celles qui peuvent devenir fausses : prix, disponibilités, horaires. Tu peux en ajouter depuis le tableau de bord ou en envoyant <b>/learn ta consigne</b> en privé au bot.</p>

    <h2>Un langage naturel, pas forcé</h2>
    <p>Si tu écris souvent en abréviations, dis-le : « Quand mon contact parle de façon familière, je peux utiliser mdr, dsl, tkt ou jsp, seulement si ça sonne naturel. » L'assistant adapte le registre au message reçu : pas de « mdr » face à une réclamation sérieuse.</p>
    <ul class="abbr"><li><b>mdr</b> mort de rire</li><li><b>dsl</b> désolé</li><li><b>tkt</b> t'inquiète</li><li><b>stp</b> s'il te plaît</li><li><b>jsp</b> je sais pas</li><li><b>pk</b> pourquoi</li></ul>
    <p>Ne lui demande pas d'en mettre partout : un bon style dépend du contexte et de la relation.</p>

    <h2>Lui apprendre avec tes vraies réponses</h2>
    <p>Réponds toi-même à plusieurs discussions. Chacune de tes réponses arrive dans « Exemples à valider ». Garde celles qui te représentent bien, corrige-les si besoin, et supprime celles qui contiennent une erreur, un secret ou une information personnelle. Cinq exemples validés suffisent pour démarrer ; davantage et plus variés, c'est mieux.</p>
    <p>Les messages écrits par l'assistant ne deviennent jamais des exemples : ton style évolue uniquement à partir de ce que tu écris.</p>

    <h2>Tester avant d'automatiser</h2>
    <p>Commence en Observation pour ne rien envoyer, puis passe en Validation avec un délai court : tu reçois chaque brouillon dans Telegram et tu décides de l'envoyer. Teste une salutation, une demande d'information, un refus, une question sur tes offres et une conversation sérieuse.</p>
    <p>Trop familier ? Ajoute une consigne plus précise. Trop long ? Demande une ou deux phrases. Quand le ton te convient, passe en Automatique.</p>

    <div class="callout"><strong>Respecter tes contacts</strong>
      <p style="margin:6px 0 0">Laisse la mention de l'IA activée, ne partage pas de données privées sans accord, et ne laisse jamais une réponse automatique faire croire qu'un achat ou une action a déjà eu lieu. Si quelqu'un écrit /stopai, l'IA s'arrête dans sa discussion et sa mémoire est effacée.</p></div>
    <a class="btn btn-primary" href="${state.session ? "#/app/apprentissage" : "#/inscription"}">${state.session ? "Retourner à l'apprentissage" : "Créer un compte"}</a>
  </article>${siteFoot()}`;
}

// ---------- Galerie privee V2 : dossiers, noms, apercus masques ----------
// Les fichiers et le PIN restent sur Supabase ; aucune image n'est chargee avant de saisir le PIN.
let photoVaultPin = null;
let photoVaultOwner = null;
async function photoVaultRequest(action, pin = null, fields = {}, file = null) {
  let body;
  if (file) {
    body = new FormData();
    body.append('action', action);
    body.append('pin', pin);
    for (const [key,value] of Object.entries(fields)) body.append(key,value??'');
    body.append('file', file, file.name);
  } else body = {action, ...(pin !== null ? {pin} : {}), ...fields};
  const {data,error} = await sb.functions.invoke('photo-vault',{body});
  if(error) {
    let message=error.message;
    try {const detail=await error.context?.json();if(detail?.error)message=detail.error;}catch(_){}
    throw new Error(message||'Galerie indisponible');
  }
  if(data?.error)throw new Error(data.error);
  return data;
}
async function viewPhotos(main) {
  const uid=state.session?.user?.id;
  if(photoVaultOwner!==uid){photoVaultOwner=uid;photoVaultPin=null;}
  let currentFolder=null;
  let configured=false;
  main.innerHTML=`${head('Photos privées','Classe tes images par dossiers. Les aperçus sont floutés par défaut.')}
    <section class="panel"><div id="vault-content"><p class="muted">Chargement de la galerie…</p></div></section>`;
  const area=$('#vault-content');
  try{configured=!!(await photoVaultRequest('status')).configured;}
  catch(err){area.innerHTML='<p class="muted">La galerie n\'est pas encore disponible sur Supabase.</p>';fail(err);return;}
  function gate(){
    currentFolder=null;
    if(!configured){
      area.innerHTML=`<div class="vault-gate"><div class="vault-lock-icon">🔐</div><h2>Créer ton code privé</h2>
        <p class="muted">Choisis 4 chiffres différents des codes trop évidents. Le code est obligatoire pour accéder aux photos et dossiers.</p>
        <form id="vault-setup" class="vault-form"><label>Code à 4 chiffres
          <input id="vault-pin-new" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="new-password" required></label>
          <label>Confirmer le code<input id="vault-pin-confirm" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="new-password" required></label>
          <button class="btn-primary" type="submit">Protéger ma galerie</button></form></div>`;
      $('#vault-setup').addEventListener('submit',async(e)=>{
        e.preventDefault();const pin=$('#vault-pin-new').value;
        if(pin!==$('#vault-pin-confirm').value)return toast('Les codes ne correspondent pas',true);
        const btn=$('#vault-setup button');btn.disabled=true;
        try{await photoVaultRequest('setup',pin);photoVaultPin=pin;configured=true;await gallery();}
        catch(err){fail(err);btn.disabled=false;}
      });
    }else{
      area.innerHTML=`<div class="vault-gate"><div class="vault-lock-icon">🔒</div><h2>Galerie verrouillée</h2>
        <p class="muted">Tes photos et tes dossiers sont cachés. Saisis ton code pour y accéder.<br>Après 5 erreurs, le code est bloqué pendant 15 minutes.</p>
        <form id="vault-unlock" class="vault-form"><label>Code à 4 chiffres
          <input id="vault-pin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="off" required></label>
          <button class="btn-primary" type="submit">Déverrouiller</button></form></div>`;
      $('#vault-unlock').addEventListener('submit',async(e)=>{
        e.preventDefault();const btn=$('#vault-unlock button');btn.disabled=true;
        const pin=$('#vault-pin').value;
        try{await photoVaultRequest('unlock',pin);photoVaultPin=pin;await gallery();}
        catch(err){photoVaultPin=null;fail(err);btn.disabled=false;}
      });
    }
  }
  const pathLabel=(folder,all)=>{
    const names=[],seen=new Set();let x=folder;
    for(let n=0;x&&n<12;n++){
      if(seen.has(x.id))break;seen.add(x.id);names.unshift(x.name);
      x=all.find(z=>z.id===x.parent_id);
    }
    return names.join(' / ');
  };
  async function gallery(){
    let result;
    try{result=await photoVaultRequest('list',photoVaultPin,{folder_id:currentFolder});}
    catch(err){photoVaultPin=null;gate();fail(err);return;}
    const items=result.items??[],folders=result.folders??[],all=result.all_folders??[];
    const chain=[],used=new Set();let f=all.find(x=>x.id===currentFolder);
    for(let i=0;f&&i<12;i++){
      if(used.has(f.id))break;used.add(f.id);chain.unshift(f);f=all.find(x=>x.id===f.parent_id);
    }
    const foldersSelect=`<option value="">📁 Racine</option>${all.map(f=>
      `<option value="${esc(f.id)}">${esc(pathLabel(f,all))}</option>`).join('')}`;
    area.innerHTML=`<div class="vault-topbar">
        <div><h2>Ma galerie privée</h2><p class="muted">Photos masquées par défaut · ${items.length} photo(s) dans ce dossier</p></div>
        <div class="vault-top-actions"><button type="button" class="btn-sm" id="vault-new-folder">+ Nouveau dossier</button>
        <button type="button" class="btn-sm" id="vault-lock">🔒 Verrouiller</button></div>
      </div>
      <nav class="vault-breadcrumbs" aria-label="Emplacement"><button type="button" data-folder="">Mes fichiers</button>
      ${chain.map(c=>`<span>›</span><button type="button" data-folder="${esc(c.id)}">${esc(c.name)}</button>`).join('')}</nav>
      <div class="vault-search-wrap"><label for="vault-search">Rechercher dans ce dossier</label>
        <input id="vault-search" type="search" autocomplete="off" placeholder="Nom d'une photo ou d'un dossier…"></div>
      ${folders.length ? `<div class="vault-section-title">Dossiers <span>${folders.length}</span></div><div class="vault-folders">
        ${folders.map(f=>`<div class="vault-folder" data-search="${esc(f.name.toLocaleLowerCase('fr'))}">
          <button type="button" class="vault-folder-open" data-id="${esc(f.id)}"><span class="vault-folder-icon">📁</span><span class="vault-folder-name">${esc(f.name)}</span></button>
          <div class="vault-folder-actions"><button type="button" class="btn-sm vault-folder-rename" data-id="${esc(f.id)}" title="Renommer le dossier">Renommer</button>
          <button type="button" class="btn-sm vault-folder-delete" data-id="${esc(f.id)}" title="Supprimer le dossier vide">Supprimer</button></div>
        </div>`).join('')}</div>`:''}
      <form id="vault-upload" class="vault-upload"><div class="vault-upload-title"><strong>Ajouter une photo</strong><small>JPG, PNG, WebP · 5 Mo max</small></div>
        <label>Fichier<input type="file" id="vault-file" accept="image/jpeg,image/png,image/webp" required></label>
        <label>Nom de la photo<input type="text" id="vault-photo-name" maxlength="120" placeholder="Ex. Portrait soirée" required></label>
        <button class="btn-primary" type="submit">Importer</button></form>
      <div class="vault-section-title">Photos <span>${items.length}</span></div>
      <div class="vault-gallery">${items.length?items.map(item=>`
        <article class="vault-item vault-photo" data-search="${esc(String(item.name).toLocaleLowerCase('fr'))}">
          <div class="vault-image-wrap">
            ${item.signed_url?`<img class="vault-thumbnail" src="${esc(item.signed_url)}" loading="lazy" alt="Aperçu masqué">
              <div class="vault-blur-overlay"><span>🔒 Aperçu masqué</span></div>`:
              `<div class="vault-missing">Aperçu indisponible</div>`}
          </div>
          <div class="vault-item-body"><strong title="${esc(item.name)}">${esc(item.name)}</strong>
           <div class="vault-item-buttons"><button type="button" class="btn-sm vault-reveal" ${item.signed_url?'':'disabled'}>👁 Afficher</button>
             ${item.signed_url?`<a href="${esc(item.signed_url)}" target="_blank" rel="noopener noreferrer" class="vault-zoom" hidden>Agrandir</a>`:''}
             <button type="button" class="btn-sm vault-item-rename" data-id="${esc(item.id)}">Renommer</button>
             <button type="button" class="btn-sm vault-item-delete" data-id="${esc(item.id)}">Supprimer</button></div>
           <label class="vault-move-label">Déplacer vers
              <select class="vault-move" data-id="${esc(item.id)}">${foldersSelect}</select></label>
          </div>
        </article>`).join(''):'<p class="muted vault-no-items">Aucune photo ici. Importe une image ou ouvre un dossier.</p>'}</div>
      <p class="small muted vault-footnote">Tes fichiers restent privés. Déverrouiller donne accès à des liens temporaires ; le flou est une protection visuelle, pas un chiffrement.</p>`;
    $('#vault-lock').addEventListener('click',()=>{photoVaultPin=null;gate();});
    $$('.vault-breadcrumbs button',area).forEach(btn=>btn.addEventListener('click',()=>{
      currentFolder=btn.dataset.folder||null;gallery();
    }));
    $$('.vault-folder-open',area).forEach(btn=>btn.addEventListener('click',()=>{currentFolder=btn.dataset.id;gallery();}));
    $('#vault-search').addEventListener('input',(e)=>{
      const term=e.target.value.trim().toLocaleLowerCase('fr');
      $$('.vault-folder, .vault-photo',area).forEach(card=>{card.hidden=!!term&&!card.dataset.search.includes(term);});
    });
    $('#vault-new-folder').addEventListener('click',async()=>{
      const name=prompt('Nom du nouveau dossier :');if(name===null)return;
      if(!name.trim()||name.trim().length>80)return toast('Nom entre 1 et 80 caractères',true);
      try{await photoVaultRequest('create_folder',photoVaultPin,{name:name.trim(),parent_id:currentFolder});
        toast('Dossier créé');await gallery();}catch(err){fail(err);}
    });
    $$('.vault-folder-rename',area).forEach(btn=>btn.addEventListener('click',async()=>{
      const folder=all.find(f=>f.id===btn.dataset.id);if(!folder)return;
      const name=prompt('Nouveau nom du dossier :',folder.name);if(name===null)return;
      if(!name.trim()||name.trim().length>80)return toast('Nom entre 1 et 80 caractères',true);
      try{await photoVaultRequest('rename_folder',photoVaultPin,{id:folder.id,name:name.trim()});toast('Dossier renommé');await gallery();}
      catch(err){fail(err);}
    }));
    $$('.vault-folder-delete',area).forEach(btn=>btn.addEventListener('click',async()=>{
      if(!confirm('Supprimer ce dossier ? Il doit être vide.'))return;
      try{await photoVaultRequest('delete_folder',photoVaultPin,{id:btn.dataset.id});toast('Dossier supprimé');await gallery();}
      catch(err){fail(err);}
    }));
    $('#vault-file').addEventListener('change',()=>{
      const file=$('#vault-file').files?.[0];if(!file)return;
      if(!$('#vault-photo-name').value.trim())$('#vault-photo-name').value=file.name.replace(/\.[^.]+$/,'').slice(0,120)||'Photo';
    });
    $('#vault-upload').addEventListener('submit',async(e)=>{
      e.preventDefault();const file=$('#vault-file').files?.[0],name=$('#vault-photo-name').value.trim();
      if(!file)return;if(file.size>5*1024*1024)return toast('Photo supérieure à 5 Mo',true);
      if(!name||name.length>120)return toast('Nom entre 1 et 120 caractères',true);
      const btn=$('#vault-upload button[type=submit]');btn.disabled=true;
      try{await photoVaultRequest('upload',photoVaultPin,{name,folder_id:currentFolder},file);
        toast('Photo importée');await gallery();}catch(err){fail(err);btn.disabled=false;}
    });
    $$('.vault-reveal',area).forEach(btn=>btn.addEventListener('click',()=>{
      const card=btn.closest('.vault-photo');const revealed=card.classList.toggle('vault-revealed');
      btn.textContent=revealed?'🙈 Masquer':'👁 Afficher';
      const zoom=card.querySelector('.vault-zoom');if(zoom)zoom.hidden=!revealed;
    }));
    $$('.vault-item-rename',area).forEach(btn=>btn.addEventListener('click',async()=>{
      const item=items.find(x=>x.id===btn.dataset.id);if(!item)return;
      const name=prompt('Nouveau nom de la photo :',item.name);if(name===null)return;
      if(!name.trim()||name.trim().length>120)return toast('Nom entre 1 et 120 caractères',true);
      try{await photoVaultRequest('rename_item',photoVaultPin,{id:item.id,name:name.trim()});toast('Photo renommée');await gallery();}
      catch(err){fail(err);}
    }));
    $$('.vault-move',area).forEach(select=>{
      const item=items.find(x=>x.id===select.dataset.id);select.value=item?.folder_id??'';
      select.addEventListener('change',async()=>{
        select.disabled=true;
        try{await photoVaultRequest('move_item',photoVaultPin,{id:select.dataset.id,folder_id:select.value||null});
          toast('Photo déplacée');await gallery();}catch(err){fail(err);select.disabled=false;}
      });
    });
    $$('.vault-item-delete',area).forEach(btn=>btn.addEventListener('click',async()=>{
      if(!confirm('Supprimer définitivement cette photo ?'))return;
      btn.disabled=true;
      try{await photoVaultRequest('delete',photoVaultPin,{id:btn.dataset.id});toast('Photo supprimée');await gallery();}
      catch(err){fail(err);btn.disabled=false;}
    }));
  }
  if(photoVaultPin)await gallery();else gate();
}

// ---------- Démarrage ----------
sb.auth.onAuthStateChange((event, session) => {
  const had = !!state.session;
  state.session = session;
  if (!session) { state.overview = null; state.settings = null; photoVaultPin = null; photoVaultOwner = null; }
  if (event === "PASSWORD_RECOVERY") { location.hash = "#/nouveau-mot-de-passe"; return; }
  if (event === "SIGNED_IN" && !had && (!location.hash || location.hash === "#/" || location.hash.startsWith("#/connexion") || location.hash.startsWith("#/inscription"))) {
    location.hash = "#/app/accueil";
  }
});

(async () => {
  const { data } = await sb.auth.getSession();
  state.session = data.session;
  if (location.search.includes("code=")) history.replaceState(null, "", location.pathname + (state.session ? "#/app/accueil" : location.hash));
  render();
})();
