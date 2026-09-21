import express from "express";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";
import { classify, route, redact, restore, log, recent, MODELS, DEFAULT_POLICY, allowedModels } from "./gateway.js";
import { AGENTS, listAgents } from "./agents/index.js";
import { checkQuota, estimateCost, noteMem, clientIp, isAdmin, LIMITS } from "./quota.js";

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "2mb" }));
const origins = (process.env.CORS_ORIGINS || "*").split(",").map((s) => s.trim());
app.use(cors({ origin: origins.includes("*") ? true : origins }));

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

/* ---------- providers ---------- */
function anthropicRequest({ modelId, system, messages, tools }) {
  const req = { model: modelId, max_tokens: 4000, system, messages };
  if (tools.includes("web_search")) req.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }];
  return req;
}
// Streaming variant: calls onText(delta) as tokens arrive, resolves with the same shape as runAnthropic.
async function streamAnthropic({ modelId, system, messages, tools }, onText) {
  const stream = anthropic.messages.stream(anthropicRequest({ modelId, system, messages, tools }));
  stream.on("text", (t) => onText(t));
  const res = await stream.finalMessage();
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  const searches = res.content.filter((b) => b.type === "server_tool_use").length;
  return { text, searches, usage: res.usage };
}
async function runAnthropic({ modelId, system, messages, tools }) {
  const res = await anthropic.messages.create(anthropicRequest({ modelId, system, messages, tools }));
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  const searches = res.content.filter((b) => b.type === "server_tool_use").length;
  return { text, searches, usage: res.usage };
}
// Placeholders until keys exist: the router never selects a disabled provider.
const PROVIDERS = { anthropic: runAnthropic };
const STREAMERS = { anthropic: streamAnthropic };


/* ---------- shared request preparation: quota → classify → policy → route ---------- */
async function prepare(req) {
  const t0 = Date.now();
  const { agent: agentId = "chat", model: requested = "auto", task = "", history = [], tenant = "public" } = req.body || {};
  const agent = AGENTS[agentId];
  if (!agent) return { reject: { status: 400, body: { error: `Unknown agent: ${agentId}` } } };
  if (!task.trim()) return { reject: { status: 400, body: { error: "task is required" } } };
  const ip = clientIp(req), admin = isAdmin(req);
  const isResearch = agent.tools.includes("web_search");
  const quota = await checkQuota({ ip, isAdmin: admin, isResearch });
  if (quota && !quota.ok) return { reject: { status: quota.status, body: { error: quota.error, code: quota.code, limit: "demo" } } };
  const tags = classify(task);
  const r = route(requested, tags, undefined, agent.tier ?? "quality");
  const base = { tenant: admin ? "admin" : tenant, agent: agentId, tags, requested, input_chars: task.length, ip };
  if (r.error) {
    await log({ ...base, routed: null, reason: null, model_id: null, redacted: false, output_chars: 0, latency_ms: Date.now() - t0, status: "blocked", error: r.error });
    return { reject: { status: 403, body: { error: r.error, tags, allowed: allowedModels(tags) } } };
  }
  const m = MODELS[r.key];
  const mustRedact = tags.some((t) => DEFAULT_POLICY[t]?.redact);
  const red = mustRedact ? redact(task) : { text: task, map: new Map() };
  const system = mustRedact
    ? agent.system + "\nGateway notice: personal data in this request has been pseudonymised by policy. Identifiers such as EMAIL_1, PHONE_1 or CARD_1 are stand-ins for real values the user already supplied; the gateway restores them after you answer. Use these identifiers exactly as written wherever the real value belongs, and complete the task fully. Do not ask the user for the underlying values."
    : agent.system;
  const messages = [...history.slice(-10), { role: "user", content: red.text }];
  return { t0, agentId, agent, ip, admin, isResearch, quota, tags, r, m, base, mustRedact, red, system, messages };
}
function finish(ctx, out, text) {
  const cost = estimateCost(ctx.m.id(), out.usage, out.searches);
  noteMem(ctx.ip, cost, ctx.isResearch);
  return { cost, row: { ...ctx.base, routed: ctx.r.key, reason: ctx.r.reason, model_id: ctx.m.id(), redacted: ctx.mustRedact,
    output_chars: text.length, latency_ms: Date.now() - ctx.t0, status: "ok",
    input_tokens: out.usage?.input_tokens ?? null, output_tokens: out.usage?.output_tokens ?? null, searches: out.searches ?? 0, cost_usd: cost } };
}
function gatewayMeta(ctx, extra = {}) {
  return { tags: ctx.tags, routed: ctx.r.key, model: ctx.m.id(), region: ctx.m.region, reason: ctx.r.reason, redacted: ctx.mustRedact,
    demo: ctx.admin ? null : { remaining: Math.max(0, (ctx.quota?.remaining ?? LIMITS.perIp()) - 1), researchRemaining: Math.max(0, (ctx.quota?.researchRemaining ?? LIMITS.researchPerIp()) - (ctx.isResearch ? 1 : 0)) },
    ...extra };
}

/* ---------- endpoints ---------- */
app.get("/health", (_, res) => res.json({ ok: true, version: "0.5.0", ts: new Date().toISOString() }));

app.get("/api/agents", (_, res) => res.json(listAgents()));

app.get("/api/models", (_, res) =>
  res.json(Object.entries(MODELS).map(([key, m]) => ({ key, id: m.id(), provider: m.provider, region: m.region, enabled: m.enabled() })))
);

app.get("/api/policy", (_, res) => res.json(DEFAULT_POLICY));

app.get("/api/audit", async (req, res) => res.json(await recent(Number(req.query.limit) || 50)));

app.post("/api/chat", async (req, res) => {
  const ctx = await prepare(req);
  if (ctx.reject) return res.status(ctx.reject.status).json(ctx.reject.body);
  try {
    const out = await PROVIDERS[ctx.m.provider]({ modelId: ctx.m.id(), system: ctx.system, messages: ctx.messages, tools: ctx.agent.tools });
    const text = ctx.mustRedact ? restore(out.text, ctx.red.map) : out.text;
    const { row } = finish(ctx, out, text);
    const entry = await log(row);
    res.json({ agent: ctx.agentId, text, gateway: gatewayMeta(ctx, { searches: out.searches, latency_ms: entry.latency_ms }), approval: ctx.agent.approval ?? null });
  } catch (e) {
    noteMem(ctx.ip, 0, ctx.isResearch);
    await log({ ...ctx.base, routed: ctx.r.key, reason: ctx.r.reason, model_id: ctx.m.id(), redacted: ctx.mustRedact, output_chars: 0, latency_ms: Date.now() - ctx.t0, status: "error", error: String(e.message || e) });
    res.status(502).json({ error: "Model call failed: " + (e.message || e) });
  }
});


/* ---------- streaming (SSE) ----------
   Same pipeline as /api/chat, but tokens are pushed as they arrive.
   Events: meta (gateway decision, sent first) · delta (text chunk) · done (final) · error
*/
const HOLDBACK = 10; // longest pseudonym token is ~8 chars; never emit a partial one
app.post("/api/chat/stream", async (req, res) => {
  const ctx = await prepare(req);
  if (ctx.reject) return res.status(ctx.reject.status).json(ctx.reject.body);

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("meta", { agent: ctx.agentId, ...gatewayMeta(ctx), approval: ctx.agent.approval ?? null });
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);

  // Restore pseudonyms on the fly while holding back a small tail so a token is never split.
  let raw = "", sent = 0;
  const flush = (final) => {
    const restored = ctx.mustRedact ? restore(raw, ctx.red.map) : raw;
    const upto = final ? restored.length : Math.max(sent, restored.length - HOLDBACK);
    if (upto > sent) { send("delta", { text: restored.slice(sent, upto) }); sent = upto; }
  };

  try {
    const out = await STREAMERS[ctx.m.provider]({ modelId: ctx.m.id(), system: ctx.system, messages: ctx.messages, tools: ctx.agent.tools }, (t) => { raw += t; flush(false); });
    raw = out.text; flush(true);
    const text = ctx.mustRedact ? restore(out.text, ctx.red.map) : out.text;
    const { row } = finish(ctx, out, text);
    const entry = await log(row);
    send("done", { text, searches: out.searches, latency_ms: entry.latency_ms });
  } catch (e) {
    noteMem(ctx.ip, 0, ctx.isResearch);
    await log({ ...ctx.base, routed: ctx.r.key, reason: ctx.r.reason, model_id: ctx.m.id(), redacted: ctx.mustRedact, output_chars: 0, latency_ms: Date.now() - ctx.t0, status: "error", error: String(e.message || e) });
    send("error", { error: "Model call failed: " + (e.message || e) });
  } finally {
    clearInterval(ping); res.end();
  }
});

// Today's spend and counts, admin only.
app.get("/api/usage", async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: "admin key required" });
  const rows = await recent(500);
  const today = new Date().toISOString().slice(0, 10);
  const t = rows.filter((r) => String(r.ts).slice(0, 10) === today);
  const spend = t.reduce((a, r) => a + Number(r.cost_usd || 0), 0);
  res.json({ date: today, calls: t.length, spend_usd: +spend.toFixed(4), ceiling_usd: LIMITS.dailySpend(), per_ip: LIMITS.perIp(), research_per_ip: LIMITS.researchPerIp(),
    by_agent: Object.fromEntries(Object.entries(t.reduce((m, r) => ((m[r.agent] = (m[r.agent] || 0) + 1), m), {}))) });
});

// Railway injects PORT; bind to 0.0.0.0 so the container is reachable.
const port = Number(process.env.PORT) || 8080;
app.listen(port, "0.0.0.0", () => console.log(`exBots agents-api :${port} | anthropic:${!!anthropic} | db:${!!process.env.DATABASE_URL}`));
