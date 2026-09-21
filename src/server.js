import express from "express";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";
import { classify, route, redact, restore, log, recent, MODELS, DEFAULT_POLICY, allowedModels } from "./gateway.js";
import { AGENTS, listAgents } from "./agents/index.js";

const app = express();
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

/* ---------- endpoints ---------- */
app.get("/health", (_, res) => res.json({ ok: true, version: "0.4.0", ts: new Date().toISOString() }));

app.get("/api/agents", (_, res) => res.json(listAgents()));

app.get("/api/models", (_, res) =>
  res.json(Object.entries(MODELS).map(([key, m]) => ({ key, id: m.id(), provider: m.provider, region: m.region, enabled: m.enabled() })))
);

app.get("/api/policy", (_, res) => res.json(DEFAULT_POLICY));

app.get("/api/audit", async (req, res) => res.json(await recent(Number(req.query.limit) || 50)));

app.post("/api/chat", async (req, res) => {
  const t0 = Date.now();
  const { agent: agentId = "chat", model: requested = "auto", task = "", history = [], tenant = "public" } = req.body || {};
  const agent = AGENTS[agentId];
  if (!agent) return res.status(400).json({ error: `Unknown agent: ${agentId}` });
  if (!task.trim()) return res.status(400).json({ error: "task is required" });

  // 1. classify
  const tags = classify(task);
  // 2 + 3. policy + route
  const r = route(requested, tags);
  const base = { tenant, agent: agentId, tags, requested, input_chars: task.length };
  if (r.error) {
    await log({ ...base, routed: null, reason: null, model_id: null, redacted: false, output_chars: 0, latency_ms: Date.now() - t0, status: "blocked", error: r.error });
    return res.status(403).json({ error: r.error, tags, allowed: allowedModels(tags) });
  }
  const m = MODELS[r.key];
  const mustRedact = tags.some((t) => DEFAULT_POLICY[t]?.redact);
  const red = mustRedact ? redact(task) : { text: task, map: new Map() };
  const input = red.text;

  try {
    // 4. run agent
    const messages = [...history.slice(-10), { role: "user", content: input }];
    const system = mustRedact
      ? agent.system + "\nGateway notice: personal data in this request has been pseudonymised by policy. Identifiers such as EMAIL_1, PHONE_1 or CARD_1 are stand-ins for real values the user already supplied; the gateway restores them after you answer. Use these identifiers exactly as written wherever the real value belongs, and complete the task fully. Do not ask the user for the underlying values."
      : agent.system;
    const out = await PROVIDERS[m.provider]({ modelId: m.id(), system, messages, tools: agent.tools });
    if (mustRedact) out.text = restore(out.text, red.map);
    // 5. log
    const entry = await log({ ...base, routed: r.key, reason: r.reason, model_id: m.id(), redacted: mustRedact, output_chars: out.text.length, latency_ms: Date.now() - t0, status: "ok" });
    res.json({
      agent: agentId, text: out.text,
      gateway: { tags, routed: r.key, model: m.id(), region: m.region, reason: r.reason, redacted: mustRedact, searches: out.searches, latency_ms: entry.latency_ms },
      approval: agent.approval ?? null,
    });
  } catch (e) {
    await log({ ...base, routed: r.key, reason: r.reason, model_id: m.id(), redacted: mustRedact, output_chars: 0, latency_ms: Date.now() - t0, status: "error", error: String(e.message || e) });
    res.status(502).json({ error: "Model call failed: " + (e.message || e) });
  }
});


/* ---------- streaming (SSE) ----------
   Same pipeline as /api/chat, but tokens are pushed as they arrive.
   Events: meta (gateway decision, sent first) · delta (text chunk) · done (final) · error
*/
const HOLDBACK = 10; // longest pseudonym token is ~8 chars; never emit a partial one
app.post("/api/chat/stream", async (req, res) => {
  const t0 = Date.now();
  const { agent: agentId = "chat", model: requested = "auto", task = "", history = [], tenant = "public" } = req.body || {};
  const agent = AGENTS[agentId];
  if (!agent) return res.status(400).json({ error: `Unknown agent: ${agentId}` });
  if (!task.trim()) return res.status(400).json({ error: "task is required" });

  const tags = classify(task);
  const r = route(requested, tags);
  const base = { tenant, agent: agentId, tags, requested, input_chars: task.length };
  if (r.error) {
    await log({ ...base, routed: null, reason: null, model_id: null, redacted: false, output_chars: 0, latency_ms: Date.now() - t0, status: "blocked", error: r.error });
    return res.status(403).json({ error: r.error, tags, allowed: allowedModels(tags) });
  }
  const m = MODELS[r.key];
  const mustRedact = tags.some((t) => DEFAULT_POLICY[t]?.redact);
  const red = mustRedact ? redact(task) : { text: task, map: new Map() };

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("meta", { agent: agentId, tags, routed: r.key, model: m.id(), region: m.region, reason: r.reason, redacted: mustRedact, approval: agent.approval ?? null });
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);

  // Restore pseudonyms on the fly while holding back a small tail so a token is never split.
  let raw = "", sent = 0;
  const flush = (final) => {
    const restored = mustRedact ? restore(raw, red.map) : raw;
    const upto = final ? restored.length : Math.max(sent, restored.length - HOLDBACK);
    if (upto > sent) { send("delta", { text: restored.slice(sent, upto) }); sent = upto; }
  };

  try {
    const messages = [...history.slice(-10), { role: "user", content: red.text }];
    const system = mustRedact
      ? agent.system + "\nGateway notice: personal data in this request has been pseudonymised by policy. Identifiers such as EMAIL_1, PHONE_1 or CARD_1 are stand-ins for real values the user already supplied; the gateway restores them after you answer. Use these identifiers exactly as written wherever the real value belongs, and complete the task fully. Do not ask the user for the underlying values."
      : agent.system;
    const out = await STREAMERS[m.provider]({ modelId: m.id(), system, messages, tools: agent.tools }, (t) => { raw += t; flush(false); });
    raw = out.text; flush(true);
    const text = mustRedact ? restore(out.text, red.map) : out.text;
    const entry = await log({ ...base, routed: r.key, reason: r.reason, model_id: m.id(), redacted: mustRedact, output_chars: text.length, latency_ms: Date.now() - t0, status: "ok" });
    send("done", { text, searches: out.searches, latency_ms: entry.latency_ms });
  } catch (e) {
    await log({ ...base, routed: r.key, reason: r.reason, model_id: m.id(), redacted: mustRedact, output_chars: 0, latency_ms: Date.now() - t0, status: "error", error: String(e.message || e) });
    send("error", { error: "Model call failed: " + (e.message || e) });
  } finally {
    clearInterval(ping); res.end();
  }
});

// Railway injects PORT; bind to 0.0.0.0 so the container is reachable.
const port = Number(process.env.PORT) || 8080;
app.listen(port, "0.0.0.0", () => console.log(`exBots agents-api :${port} | anthropic:${!!anthropic} | db:${!!process.env.DATABASE_URL}`));
