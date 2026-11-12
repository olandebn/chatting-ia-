// Relais IA — webhook Telegram (Business + messages privés au bot)
import { cfg, db, effectiveMode, loadAccount, randomDelaySeconds, sendBusiness, tg } from "./core.ts";

const HELP =
  "Bonjour 👋 Je suis l'assistant Relais IA.\n\n" +
  "• Lie ton compte depuis ton tableau de bord (bouton « Lier Telegram »).\n" +
  "• Puis ajoute-moi dans Telegram : Réglages → Telegram Business → Chatbots.\n\n" +
  "Commandes :\n/learn ta consigne — enseigner une préférence de style\n/status — état de ton assistant";

function msgText(m: any): string {
  if (m.text) return m.text;
  if (m.caption) return m.caption;
  if (m.photo) return "[photo]";
  if (m.video) return "[vidéo]";
  if (m.voice) return "[message vocal]";
  if (m.video_note) return "[vidéo ronde]";
  if (m.sticker) return `[sticker ${m.sticker.emoji ?? ""}]`;
  if (m.document) return "[fichier]";
  if (m.audio) return "[audio]";
  if (m.location) return "[position]";
  return "[message]";
}

async function userByTelegramId(tgId: number): Promise<string | null> {
  const { data } = await db.from("telegram_links").select("user_id").eq("telegram_user_id", tgId).maybeSingle();
  return data?.user_id ?? null;
}

// ---------- Messages privés envoyés au bot ----------
async function handlePrivate(m: any) {
  const from = m.from;
  const text: string = (m.text ?? "").trim();
  const reply = (t: string) => tg("sendMessage", { chat_id: m.chat.id, text: t });

  const linkMatch = text.match(/^\/(?:start|link)\s+([A-Za-z0-9_-]{8,64})$/);
  if (linkMatch) {
    const code = linkMatch[1];
    const { data: link } = await db.from("telegram_links").select("user_id").eq("link_code", code).maybeSingle();
    if (!link) return reply("❌ Code invalide ou expiré. Génère un nouveau lien depuis ton tableau de bord.");
    // un compte Telegram ne peut être lié qu'à un seul compte Relais
    await db.from("telegram_links").update({ telegram_user_id: null, telegram_username: null, telegram_name: null, linked_at: null })
      .eq("telegram_user_id", from.id).neq("user_id", link.user_id);
    await db.from("telegram_links").update({
      telegram_user_id: from.id,
      telegram_username: from.username ?? null,
      telegram_name: [from.first_name, from.last_name].filter(Boolean).join(" "),
      linked_at: new Date().toISOString(),
      link_code: crypto.randomUUID().replaceAll("-", "").slice(0, 20),
    }).eq("user_id", link.user_id);
    return reply(
      "✅ Ton compte est lié !\n\nDernière étape : dans Telegram, ouvre Réglages → Telegram Business → Chatbots, " +
        "ajoute ce bot et autorise-le à répondre aux messages. Ensuite, reviens sur ton tableau de bord.",
    );
  }

  const uid = await userByTelegramId(from.id);
  if (text.startsWith("/learn")) {
    if (!uid) return reply("Lie d'abord ton compte depuis ton tableau de bord.");
    const a = await loadAccount(uid);
    if (!a?.plan.learning) return reply("L'apprentissage est réservé aux abonnements Pro et Scale.");
    const consigne = text.replace(/^\/learn(@\w+)?/, "").trim();
    if (consigne.length < 3) return reply("Exemple : /learn Je tutoie mes contacts et je réponds en 1 à 3 phrases.");
    await db.from("instructions").insert({ user_id: uid, text: consigne.slice(0, 1000), source: "telegram" });
    return reply("🧠 Consigne enregistrée. Elle s'applique dès la prochaine réponse.");
  }
  if (text.startsWith("/status")) {
    if (!uid) return reply("Aucun compte lié. Utilise le bouton « Lier Telegram » de ton tableau de bord.");
    const a = await loadAccount(uid);
    if (!a) return reply("Compte introuvable.");
    const modes: Record<string, string> = { observation: "Observation", validation: "Validation avant envoi", auto: "Automatique" };
    return reply(
      `Mode : ${modes[a.settings?.mode] ?? a.settings?.mode}\nMessages : ${a.quota_used} / ${a.plan.msg_quota}\n` +
        `Telegram Business : ${a.connection ? (a.connection.can_reply ? "connecté ✅" : "connecté, sans droit de réponse ⚠️") : "non connecté ❌"}`,
    );
  }
  return reply(HELP);
}

// ---------- Boutons des brouillons ----------
async function handleCallback(q: any) {
  const m = String(q.data ?? "").match(/^d:(\d+):(s|x)$/);
  const answer = (t: string) => tg("answerCallbackQuery", { callback_query_id: q.id, text: t }).catch(() => {});
  if (!m) return answer("Action inconnue");
  const uid = await userByTelegramId(q.from.id);
  const { data: r } = await db.from("replies").select("*").eq("id", Number(m[1])).maybeSingle();
  if (!uid || !r || r.user_id !== uid) return answer("Brouillon introuvable");
  if (r.status !== "draft") return answer("Ce brouillon a déjà été traité");
  const editMsg = (t: string) =>
    q.message ? tg("editMessageText", { chat_id: q.message.chat.id, message_id: q.message.message_id, text: t.slice(0, 4000) }).catch(() => {}) : null;

  if (m[2] === "x") {
    await db.from("replies").update({ status: "cancelled" }).eq("id", r.id);
    await editMsg(`🗑 Brouillon ignoré.\n\n${r.draft_text}`);
    return answer("Ignoré");
  }
  const a = await loadAccount(uid);
  const { data: chat } = await db.from("chats").select("*").eq("id", r.chat_id).maybeSingle();
  if (!a || !chat) return answer("Discussion introuvable");
  if (a.quota_used >= a.plan.msg_quota) return answer("Quota de messages atteint");
  try {
    await sendBusiness(a, chat, r.draft_text, r.id);
    await editMsg(`✅ Envoyé à ${chat.title ?? "ton contact"} :\n\n${r.draft_text}`);
    return answer("Envoyé");
  } catch (e) {
    await db.from("replies").update({ error: String((e as Error).message) }).eq("id", r.id);
    return answer("Échec de l'envoi : " + String((e as Error).message).slice(0, 150));
  }
}

// ---------- Connexion Business ----------
async function handleConnection(bc: any) {
  const can_reply = bc.rights ? !!bc.rights.can_reply : !!bc.can_reply;
  await db.from("business_connections").upsert({
    id: bc.id,
    telegram_user_id: bc.user.id,
    user_chat_id: bc.user_chat_id,
    can_reply,
    is_enabled: !!bc.is_enabled,
    updated_at: new Date().toISOString(),
  });
  const uid = await userByTelegramId(bc.user.id);
  if (!bc.is_enabled) return;
  await tg("sendMessage", {
    chat_id: bc.user_chat_id,
    text: uid
      ? (can_reply
        ? "✅ Telegram Business connecté. Ton assistant peut maintenant répondre selon le mode choisi dans ton tableau de bord."
        : "⚠️ Connecté, mais le bot n'a pas le droit de répondre. Active « Répondre aux messages » dans les réglages du chatbot.")
      : "Connexion reçue, mais ce compte Telegram n'est lié à aucun compte Relais. Clique sur « Lier Telegram » depuis ton tableau de bord.",
  }).catch(() => {});
}

// ---------- Messages Business ----------
async function handleBusinessMessage(m: any) {
  if (m.sender_business_bot) return; // envoyé par un bot (nous-mêmes)
  const { data: bc } = await db.from("business_connections").select("*").eq("id", m.business_connection_id).maybeSingle();
  if (!bc) return;
  const uid = await userByTelegramId(bc.telegram_user_id);
  if (!uid) return;
  if (m.chat.type !== "private") return;

  const isOwner = m.from?.id === bc.telegram_user_id;
  const text = msgText(m);
  const now = new Date();
  const c = m.chat;
  const title = [c.first_name, c.last_name].filter(Boolean).join(" ") || c.title || c.username || String(c.id);

  const { data: chat } = await db.from("chats").upsert(
    { user_id: uid, tg_chat_id: c.id, title, username: c.username ?? null },
    { onConflict: "user_id,tg_chat_id" },
  ).select("*").single();
  if (!chat) return;

  const { data: settings } = await db.from("bot_settings").select("*").eq("user_id", uid).maybeSingle();

  if (isOwner) {
    // Le propriétaire répond lui-même : on garde un exemple de style, on met l'IA en pause
    const { data: lastOwnerOrAi } = await db.from("messages").select("created_at").eq("chat_id", chat.id)
      .in("role", ["owner", "ai"]).order("created_at", { ascending: false }).limit(1).maybeSingle();
    let q = db.from("messages").select("text").eq("chat_id", chat.id).eq("role", "contact").order("created_at", { ascending: true });
    if (lastOwnerOrAi) q = q.gt("created_at", lastOwnerOrAi.created_at);
    const { data: before } = await q.limit(10);

    await db.from("messages").insert({ user_id: uid, chat_id: chat.id, tg_message_id: m.message_id, role: "owner", text });
    const resume = settings?.resume_minutes ?? 30;
    await db.from("chats").update({
      paused_until: new Date(now.getTime() + resume * 60_000).toISOString(),
      last_message_at: now.toISOString(),
      last_message_preview: text.slice(0, 120),
      unread: 0,
    }).eq("id", chat.id);
    await db.from("replies").update({ status: "cancelled", error: "Vous avez répondu vous-même" })
      .eq("chat_id", chat.id).in("status", ["scheduled", "draft"]);
    await db.from("events").insert({ user_id: uid, chat_id: chat.id, kind: "owner" });
    if (m.text && (before ?? []).length && !m.text.startsWith("/")) {
      await db.from("examples").insert({
        user_id: uid, chat_id: chat.id,
        contact_text: (before ?? []).map((b: any) => b.text).join("\n").slice(0, 1500),
        reply_text: m.text.slice(0, 1500),
      });
    }
    return;
  }

  // Message du contact
  if ((m.text ?? "").trim().toLowerCase().startsWith("/stopai")) {
    await db.from('contact_memory').delete().eq('user_id',uid).eq('chat_id',chat.id);
    await db.from("messages").delete().eq("chat_id", chat.id);
    await db.from("examples").delete().eq("chat_id", chat.id);
    await db.from("replies").update({ status: "cancelled", error: "/stopai" }).eq("chat_id", chat.id).in("status", ["scheduled", "draft"]);
    await db.from("chats").update({ ai_stopped: true, last_message_preview: "/stopai", last_message_at: now.toISOString() }).eq("id", chat.id);
    if (bc.can_reply) {
      await tg("sendMessage", {
        business_connection_id: bc.id, chat_id: c.id,
        text: "C'est noté : l'assistant IA est désactivé pour cette discussion et sa mémoire a été effacée.",
      }).catch(() => {});
    }
    return;
  }

  await db.from("messages").insert({ user_id: uid, chat_id: chat.id, tg_message_id: m.message_id, role: "contact", text });
  await db.from("chats").update({
    last_message_at: now.toISOString(),
    last_message_preview: text.slice(0, 120),
    unread: (chat.unread ?? 0) + 1,
  }).eq("id", chat.id);
  await db.from("events").insert({ user_id: uid, chat_id: chat.id, kind: "received" });

  const mode = effectiveMode(chat, settings);
  if (mode !== "auto" && mode !== "validation") return;
  if (settings?.ai_paused_reason) return;

  // Une seule réponse programmée par discussion : celle qui existe garde son échéance
  const { data: open } = await db.from("replies").select("id").eq("chat_id", chat.id).in("status", ["scheduled", "generating"]).maybeSingle();
  if (open) return;
  let due = now.getTime() + randomDelaySeconds(settings) * 1000;
  if (chat.paused_until) due = Math.max(due, new Date(chat.paused_until).getTime());
  await db.from("replies").insert({ user_id: uid, chat_id: chat.id, due_at: new Date(due).toISOString() });
}

async function chatIdFor(connectionId: string, tgChatId: number): Promise<number | null> {
  const { data: bc } = await db.from("business_connections").select("telegram_user_id").eq("id", connectionId).maybeSingle();
  if (!bc) return null;
  const uid = await userByTelegramId(bc.telegram_user_id);
  if (!uid) return null;
  const { data: chat } = await db.from("chats").select("id").eq("user_id", uid).eq("tg_chat_id", tgChatId).maybeSingle();
  return chat?.id ?? null;
}

async function handleEdited(m: any) {
  const id = await chatIdFor(m.business_connection_id, m.chat.id);
  if (id) await db.from("messages").update({ text: msgText(m) }).eq("chat_id", id).eq("tg_message_id", m.message_id);
}

async function handleDeleted(d: any) {
  const id = await chatIdFor(d.business_connection_id, d.chat.id);
  if (id) await db.from("messages").delete().eq("chat_id", id).in("tg_message_id", d.message_ids ?? []);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  const secret = await cfg("webhook_secret");
  if (!secret || req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== secret) {
    return new Response("forbidden", { status: 403 });
  }
  const u = await req.json().catch(() => null);
  if (!u) return new Response("ok");
  // RELAIS_V2_20261112 : déduplication d'update_id à durée de vie 48 h.
  const updateId = u.update_id;
  if (Number.isSafeInteger(updateId)) {
    const {error} = await db.from('processed_updates').insert({update_id:updateId});
    if (error?.code === '23505') return new Response('duplicate');
    if (error) {console.error('idempotency insert',error.code);return new Response('retry',{status:500});}
  }
  try {
    if (u.business_connection) await handleConnection(u.business_connection);
    else if (u.business_message) await handleBusinessMessage(u.business_message);
    else if (u.edited_business_message) await handleEdited(u.edited_business_message);
    else if (u.deleted_business_messages) await handleDeleted(u.deleted_business_messages);
    else if (u.callback_query) await handleCallback(u.callback_query);
    else if (u.message && u.message.chat?.type === "private") await handlePrivate(u.message);
  } catch (e) {
    console.error("webhook error", e);
    if (Number.isSafeInteger(updateId)) await db.from('processed_updates').delete().eq('update_id',updateId);
    return new Response('retry',{status:500});
  }
  return new Response("ok"); // acknowledgement only after successful processing
});
