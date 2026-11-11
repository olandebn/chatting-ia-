// Relais IA — traite les réponses arrivées à échéance (appelé chaque minute par pg_cron)
import { cfg, db, processReply } from "./core.ts";

Deno.serve(async (req) => {
  const secret = await cfg("cron_secret");
  if (!secret || req.headers.get("x-cron-secret") !== secret) return new Response("forbidden", { status: 403 });

  const started = Date.now();
  const results: Record<string, number> = {};
  // On boucle tant qu'il reste des réponses dues, dans la limite de ~50 s
  while (Date.now() - started < 50_000) {
    const { data, error } = await db.rpc("claim_due_replies", { p_limit: 10 });
    if (error) { console.error(error); break; }
    if (!data?.length) break;
    const out = await Promise.all(data.map((r: any) => processReply(r).catch((e) => { console.error(e); return "error"; })));
    for (const o of out) results[o] = (results[o] ?? 0) + 1;
  }
  return new Response(JSON.stringify(results), { headers: { "Content-Type": "application/json" } });
});
