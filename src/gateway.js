// exBots Agent Gateway v0 — classify → policy → route → log
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

/* ---------- 1. classify ---------- */
const PATTERNS = {
  pii: [
    /\b\d{3}[- ]?\d{3}[- ]?\d{3}\b/,                       // CA SIN
    /\b\d{3}-\d{2}-\d{4}\b/,                               // US SSN
    /\b[A-Z][a-zA-Z]+ [A-Z][a-zA-Z]+\b.*\b(dob|date of birth|born)\b/i,
    /\b[\w.+-]+@[\w-]+\.[\w.]+\b/,                         // email
    /\b(\+?1[ -]?)?\(?\d{3}\)?[ -]?\d{3}[ -]?\d{4}\b/,      // phone
  ],
  financial: [
    /\b(?:\d[ -]*?){13,19}\b/,                              // card-like
    /\b(iban|swift|routing|account (no|number)|transit)\b/i,
    /\$\s?\d{1,3}(,\d{3})+(\.\d+)?/,
  ],
  confidential: [
    /\b(confidential|internal only|do not distribute|nda|privileged)\b/i,
    /\b(term sheet|cap table|payroll|salary|salaries)\b/i,
  ],
};
export function classify(text) {
  const tags = [];
  for (const [tag, res] of Object.entries(PATTERNS)) {
    if (res.some((r) => r.test(text))) tags.push(tag);
  }
  return tags.length ? tags : ["general"];
}

/* ---------- 2. policy ---------- */
// Each provider declares where data goes. Policy says which classes may go where.
export const MODELS = {
  haiku:   { id: () => process.env.MODEL_HAIKU || "claude-haiku-4-5", provider: "anthropic", region: "us", cost: 1, tier: "fast", enabled: () => !!process.env.ANTHROPIC_API_KEY },
  claude:  { id: () => process.env.MODEL_CLAUDE || "claude-sonnet-4-6", provider: "anthropic", region: "us", cost: 3, enabled: () => !!process.env.ANTHROPIC_API_KEY },
  gpt:     { id: () => process.env.MODEL_GPT || "gpt-5", provider: "openai", region: "us", cost: 3, enabled: () => !!process.env.OPENAI_API_KEY },
  gemini:  { id: () => process.env.MODEL_GEMINI || "gemini-2.5-pro", provider: "google", region: "us", cost: 2, enabled: () => !!process.env.GOOGLE_API_KEY },
  mistral: { id: () => process.env.MODEL_MISTRAL || "mistral-large-latest", provider: "mistral", region: "eu", cost: 1, enabled: () => !!process.env.MISTRAL_API_KEY },
  onprem:  { id: () => process.env.MODEL_ONPREM || "llama-3.3-70b", provider: "onprem", region: "tenant", cost: 0, enabled: () => !!process.env.ONPREM_URL },
};

// Default tenant policy (v0). Later this comes from the tenant's config.
export const DEFAULT_POLICY = {
  general:      { allow: ["haiku", "claude", "gpt", "gemini", "mistral", "onprem"] },
  confidential: { allow: ["haiku", "claude", "gpt", "mistral", "onprem"] },
  financial:    { allow: ["haiku", "claude", "mistral", "onprem"] },
  pii:          { allow: ["haiku", "claude", "onprem"], redact: true },
};

export function allowedModels(tags, policy = DEFAULT_POLICY) {
  // A request must satisfy every tag it carries: intersect the allow lists.
  return tags
    .map((t) => new Set(policy[t]?.allow ?? policy.general.allow))
    .reduce((acc, s) => acc.filter((m) => s.has(m)), Object.keys(MODELS));
}

/* ---------- 3. route ---------- */
export function route(requested, tags, policy = DEFAULT_POLICY, tier = "quality") {
  const allowed = allowedModels(tags, policy).filter((m) => MODELS[m].enabled());
  if (!allowed.length) return { error: "No enabled model satisfies policy for tags: " + tags.join(", ") };
  if (requested && requested !== "auto") {
    if (!allowed.includes(requested)) {
      return { error: `Policy blocks ${requested} for ${tags.join(", ")} data. Allowed: ${allowed.join(", ")}` };
    }
    return { key: requested, reason: "requested" };
  }
  // auto = cheapest allowed within the agent's tier: "fast" agents may use fast models,
  // "quality" agents never drop to a fast model.
  const pool_ = tier === "fast" ? allowed : allowed.filter((m) => MODELS[m].tier !== "fast");
  const candidates = pool_.length ? pool_ : allowed;
  const key = candidates.sort((a, b) => MODELS[a].cost - MODELS[b].cost)[0];
  return { key, reason: `auto: lowest-cost allowed (${tier})` };
}

/* ---------- pseudonymisation: swap PII for stable tokens, restore on the way out ---------- */
const PII_PATTERNS = [
  ["EMAIL", /\b[\w.+-]+@[\w-]+\.[\w.]+\b/g],
  ["CARD",  /\b(?:\d[ -]*?){13,19}\b/g],
  ["PHONE", /\b(\+?1[ -]?)?\(?\d{3}\)?[ -]?\d{3}[ -]?\d{4}\b/g],
];
export function redact(text) {
  const map = new Map(); // token -> real value
  const seen = new Map(); // real value -> token
  let out = text;
  for (const [kind, re] of PII_PATTERNS) {
    let n = 0;
    out = out.replace(re, (m) => {
      if (seen.has(m)) return seen.get(m);
      const tok = `${kind}_${++n}`;
      seen.set(m, tok); map.set(tok, m);
      return tok;
    });
  }
  return { text: out, map };
}
export function restore(text, map) {
  let out = text;
  for (const [tok, real] of map) out = out.split(tok).join(real);
  return out;
}

/* ---------- 4. audit log ---------- */
export let pool = null;
if (process.env.DATABASE_URL) {
  const url = process.env.DATABASE_URL;
  const internal = /railway\.internal|localhost|127\.0\.0\.1/.test(url);
  pool = new pg.Pool({ connectionString: url, ssl: internal ? false : { rejectUnauthorized: false } });
  pool.on("error", (e) => console.error("pg pool error:", e.message));
  try {
  await pool.query(`CREATE TABLE IF NOT EXISTS audit (
    id BIGSERIAL PRIMARY KEY,
    ts TIMESTAMPTZ DEFAULT now(),
    tenant TEXT, agent TEXT, tags TEXT[], requested TEXT, routed TEXT, reason TEXT,
    model_id TEXT, redacted BOOLEAN, input_chars INT, output_chars INT,
    latency_ms INT, status TEXT, error TEXT
  )`);
  await pool.query(`ALTER TABLE audit
    ADD COLUMN IF NOT EXISTS ip TEXT,
    ADD COLUMN IF NOT EXISTS input_tokens INT,
    ADD COLUMN IF NOT EXISTS output_tokens INT,
    ADD COLUMN IF NOT EXISTS searches INT,
    ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(10,5)`);
  console.log("audit log: postgres");
  } catch (e) {
    console.error("postgres unavailable, falling back to file log:", e.message);
    pool = null;
  }
}
const FILE = path.join(process.cwd(), "data", "audit.jsonl");

export async function log(row) {
  const entry = { ts: new Date().toISOString(), ...row };
  if (pool) {
    await pool.query(
      `INSERT INTO audit (tenant,agent,tags,requested,routed,reason,model_id,redacted,input_chars,output_chars,latency_ms,status,error,ip,input_tokens,output_tokens,searches,cost_usd)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [entry.tenant, entry.agent, entry.tags, entry.requested, entry.routed, entry.reason, entry.model_id,
       entry.redacted, entry.input_chars, entry.output_chars, entry.latency_ms, entry.status, entry.error ?? null,
       entry.ip ?? null, entry.input_tokens ?? null, entry.output_tokens ?? null, entry.searches ?? 0, entry.cost_usd ?? 0]
    );
  } else {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.appendFileSync(FILE, JSON.stringify(entry) + "\n");
  }
  return entry;
}

export async function recent(limit = 50) {
  if (pool) return (await pool.query("SELECT * FROM audit ORDER BY id DESC LIMIT $1", [limit])).rows;
  if (!fs.existsSync(FILE)) return [];
  return fs.readFileSync(FILE, "utf8").trim().split("\n").filter(Boolean).slice(-limit).reverse().map((l) => JSON.parse(l));
}
