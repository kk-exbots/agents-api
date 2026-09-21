import express from "express";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";
import { classify, route, redact, log, recent, MODELS, DEFAULT_POLICY, allowedModels } from "./gateway.js";
import { AGENTS, listAgents } from "./agents/index.js";

const app = express();
app.use(express.json({ limit: "2mb" }));
const origins = (process.env.CORS_ORIGINS || "*").split(",").map((s) => s.trim());
app.use(cors({ origin: origins.includes("*") ? true : origins }));

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

/* ---------- providers ---------- */
async function runAnthropic({ modelId, system, messages, tools }) {
  const req = { model: modelId, max_tokens: 4000, system, messages };
  if (tools.includes("web_search")) req.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }];
  const res = await anthropic.messages.create(req);
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  const searches = res.content.filter((b) => b.type === "server_tool_use").length;
  return { text, searches, usage: res.usage };
}
// Placeholders until keys exist: the router never selects a disabled provider.
const PROVIDERS = { anthropic: runAnthropic };

/* ---------- endpoints ---------- */
app.get("/health", (_, res) => res.json({ ok: true, ts: new Date().toISOString() }));

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
  const input = mustRedact ? redact(task) : task;

  try {
    // 4. run agent
    const userContent = mustRedact
      ? "[Gateway: personal data in this message was masked by policy. [email], [phone] and [card] are real values the user supplied; keep the tokens verbatim and do not ask for them.]\n\n" + input
      : input;
    const messages = [...history.slice(-10), { role: "user", content: userContent }];
    const system = mustRedact
      ? agent.system + "\nGateway notice: this request was redacted by policy before reaching you. Tokens such as [email], [phone] and [card] stand in for real values the user did provide. Treat them as known, keep them verbatim in your output, and never ask the user to supply the underlying values."
      : agent.system;
    const out = await PROVIDERS[m.provider]({ modelId: m.id(), system, messages, tools: agent.tools });
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


// Railway injects PORT; bind to 0.0.0.0 so the container is reachable.
const port = Number(process.env.PORT) || 8080;
app.listen(port, "0.0.0.0", () => console.log(`exBots agents-api :${port} | anthropic:${!!anthropic} | db:${!!process.env.DATABASE_URL}`));
