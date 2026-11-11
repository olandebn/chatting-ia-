// Relais IA — actions du tableau de bord qui passent par Telegram ou le service role
import { authUser, CORS, db, json, loadAccount, sendBusiness, tg, cfg, setCfg, SUPABASE_URL } from "./core.ts";

const ALLOWED_UPDATES = [
  "message", "callback_query", "business_connection", "business_message",
  "edited_business_message", "deleted_business_messages",
];

async function isAdmin(uid: string) {
  const { data } = await db.from("profiles").select("is_admin").eq("id", uid).maybeSingle();
  return !!data?.is_admin;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const user = await authUser(req);
  if (!user) return json({ error: "Non connecté" }, 401);
  const body = await req.json().catch(() => ({}));
  const action = body.action as string;
  const uid = user.id;

  try {
    switch (action) {
      // ----- Brouillons -----
      case "send_draft": {
        const { data: r } = await db.from("replies").select("*").eq("id", body.reply_id).eq("user_id", uid).maybeSingle();
        if (!r || r.status !== "draft") return json({ error: "Brouillon introuvable" }, 404);
        const text = String(body.text ?? r.draft_text ?? "").trim();
        if (!text) return json({ error: "Message vide" }, 400);
        const a = await loadAccount(uid);
        const { data: chat } = await db.from("chats").select("*").eq("id", r.chat_id).maybeSingle();
        if (!a || !chat) return json({ error: "Discussion introuvable" }, 404);
        if (a.quota_used >= a.plan.msg_quota) return json({ error: "Quota de messages atteint" }, 402);
        if (!a.connection?.can_reply) return json({ error: "Telegram Business non connecté ou sans droit de réponse" }, 400);
        await sendBusiness(a, chat, text, r.id);
        return json({ ok: true });
      }
      case "discard_draft": {
        await db.from("replies").update({ status: "cancelled" }).eq("id", body.reply_id).eq("user_id", uid).eq("status", "draft");
        return json({ ok: true });
      }

      // ----- Discussions -----
      case "clear_chat_memory": {
        const { data: chat } = await db.from("chats").select("id").eq("id", body.chat_id).eq("user_id", uid).maybeSingle();
        if (!chat) return json({ error: "Discussion introuvable" }, 404);
        await db.from("messages").delete().eq("chat_id", chat.id);
        await db.from("replies").update({ status: "cancelled" }).eq("chat_id", chat.id).in("status", ["scheduled", "draft"]);
        return json({ ok: true });
      }
      case "cancel_scheduled": {
        await db.from("replies").update({ status: "cancelled", error: "Annulée depuis le tableau de bord" })
          .eq("chat_id", body.chat_id).eq("user_id", uid).eq("status", "scheduled");
        return json({ ok: true });
      }

      // ----- Telegram -----
      case "refresh_rights": {
        const a = await loadAccount(uid);
        if (!a?.connection) return json({ error: "Aucune connexion Telegram Business reçue pour l'instant" }, 404);
        const bc = await tg("getBusinessConnection", { business_connection_id: a.connection.id });
        const can_reply = bc.rights ? !!bc.rights.can_reply : !!bc.can_reply;
        await db.from("business_connections").update({ can_reply, is_enabled: !!bc.is_enabled, updated_at: new Date().toISOString() })
          .eq("id", a.connection.id);
        return json({ ok: true, can_reply, is_enabled: !!bc.is_enabled });
      }
      case "unlink_telegram": {
        await db.from("telegram_links").update({
          telegram_user_id: null, telegram_username: null, telegram_name: null, linked_at: null,
          link_code: crypto.randomUUID().replaceAll("-", "").slice(0, 20),
        }).eq("user_id", uid);
        return json({ ok: true });
      }

      // ----- RGPD -----
      case "delete_my_data": {
        await db.from("chats").delete().eq("user_id", uid); // cascade : messages, réponses
        await db.from("examples").delete().eq("user_id", uid);
        await db.from("instructions").delete().eq("user_id", uid);
        await db.from("links").delete().eq("user_id", uid);
        return json({ ok: true });
      }
      case "delete_account": {
        await db.auth.admin.deleteUser(uid); // cascade sur toutes les tables
        return json({ ok: true });
      }

      // ----- Admin -----
      case "admin_status": {
        if (!(await isAdmin(uid))) return json({ error: "Accès refusé" }, 403);
        const token = await cfg("telegram_bot_token");
        let webhook: any = null;
        if (token) webhook = await tg("getWebhookInfo", {}).catch((e) => ({ error: String(e.message) }));
        return json({
          bot_username: await cfg("bot_username"),
          has_token: !!token,
          has_anthropic_key: !!(await cfg("anthropic_api_key")),
          model: await cfg("anthropic_model"),
          webhook,
        });
      }
      case "admin_save": {
        if (!(await isAdmin(uid))) return json({ error: "Accès refusé" }, 403);
        const out: any = {};
        if (body.anthropic_api_key) {
          const key = String(body.anthropic_api_key).trim();
          const model = String(body.anthropic_model || (await cfg("anthropic_model")) || "claude-haiku-5-5");
          const r = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
            body: JSON.stringify({ model, max_tokens: 5, messages: [{ role: "user", content: "Réponds OK" }] }),
          });
          if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            return json({ error: `Clé ou modèle Anthropic refusé : ${j?.error?.message ?? r.status}` }, 400);
          }
          await setCfg("anthropic_api_key", key);
          out.anthropic = "ok";
        }
        if (body.anthropic_model) { await setCfg("anthropic_model", String(body.anthropic_model).trim()); out.model = "ok"; }
        if (body.telegram_bot_token) {
          const token = String(body.telegram_bot_token).trim();
          const me = await tg("getMe", {}, token);
          if (!me.can_connect_to_business) {
            return json({ error: "Ce bot n'a pas le mode Business activé. Dans @BotFather : Bot Settings → Business Mode → Turn on." }, 400);
          }
          await tg("setWebhook", {
            url: `${SUPABASE_URL}/functions/v1/telegram-webhook`,
            secret_token: await cfg("webhook_secret"),
            allowed_updates: ALLOWED_UPDATES,
            drop_pending_updates: true,
          }, token);
          await tg("setMyCommands", {
            commands: [
              { command: "learn", description: "Enseigner une consigne de style" },
              { command: "status", description: "État de ton assistant" },
            ],
          }, token).catch(() => {});
          await setCfg("telegram_bot_token", token);
          await setCfg("bot_username", me.username);
          out.bot_username = me.username;
        }
        return json({ ok: true, ...out });
      }
      default:
        return json({ error: "Action inconnue" }, 400);
    }
  } catch (e) {
    console.error(action, e);
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
