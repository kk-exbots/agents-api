// Demo quota + daily spend ceiling. Everything is configurable by env; sane defaults below.
// Anonymous callers (no admin key) are capped per IP per UTC day, and the whole service
// stops serving anonymous traffic once today's estimated spend crosses DAILY_SPEND_USD.
import { pool } from "./gateway.js";

const num = (k, d) => (process.env[k] != null && process.env[k] !== "" ? Number(process.env[k]) : d);
export const LIMITS = {
  perIp: () => num("DEMO_PER_IP", 5),                 // tasks per IP per day
  researchPerIp: () => num("DEMO_RESEARCH_PER_IP", 2), // of which may be web-search agents
  dailySpend: () => num("DAILY_SPEND_USD", 25),        // whole-service ceiling for anonymous use
  adminKey: () => process.env.ADMIN_KEY || "",
};

/* ---------- cost estimate (USD) from provider usage ---------- */
// Per-million-token list prices; override via env if they change. Web search billed per call.
const PRICE = {
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-4-5":  { in: 1, out: 5 },
};
const SEARCH_USD = num("SEARCH_USD", 0.01);
export function estimateCost(modelId, usage = {}, searches = 0) {
  const p = PRICE[modelId] || PRICE["claude-sonnet-4-6"];
  const inTok = usage.input_tokens || 0, outTok = usage.output_tokens || 0;
  return +((inTok * p.in + outTok * p.out) / 1e6 + searches * SEARCH_USD).toFixed(5);
}

/* ---------- counters (Postgres when available, memory otherwise) ---------- */
const mem = { day: "", byIp: new Map(), spend: 0 };
function today() { return new Date().toISOString().slice(0, 10); }
function rollMem() { const d = today(); if (mem.day !== d) { mem.day = d; mem.byIp.clear(); mem.spend = 0; } }

async function usageFor(ip) {
  if (pool) {
    const q = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE ip=$1) AS n,
              COUNT(*) FILTER (WHERE ip=$1 AND searches>0) AS r,
              COALESCE(SUM(cost_usd),0) AS spend
       FROM audit WHERE ts::date = (now() at time zone 'utc')::date AND status IN ('ok','error') AND tenant='public'`, [ip]);
    const row = q.rows[0];
    return { n: Number(row.n), r: Number(row.r), spend: Number(row.spend) };
  }
  rollMem();
  const e = mem.byIp.get(ip) || { n: 0, r: 0 };
  return { n: e.n, r: e.r, spend: mem.spend };
}

// Called after a completed call when there is no DB (DB path is covered by the audit row itself).
export function noteMem(ip, cost, isResearch) {
  if (pool) return;
  rollMem();
  const e = mem.byIp.get(ip) || { n: 0, r: 0 };
  e.n++; if (isResearch) e.r++; mem.byIp.set(ip, e); mem.spend += cost;
}

/* ---------- gate ---------- */
// Returns null when allowed, or { status, error, code } when the call must be refused.
export async function checkQuota({ ip, isAdmin, isResearch }) {
  if (isAdmin) return null;
  const u = await usageFor(ip);
  if (u.spend >= LIMITS.dailySpend())
    return { status: 429, code: "daily_ceiling", error: "The public demo has reached today's usage ceiling. Request access for a dedicated workspace." };
  if (u.n >= LIMITS.perIp())
    return { status: 429, code: "per_ip", error: `Demo allowance is ${LIMITS.perIp()} tasks a day. Request access for more.` };
  if (isResearch && u.r >= LIMITS.researchPerIp())
    return { status: 429, code: "research_per_ip", error: `Demo allowance includes ${LIMITS.researchPerIp()} research runs a day. Request access for more.` };
  return { remaining: LIMITS.perIp() - u.n, researchRemaining: LIMITS.researchPerIp() - u.r, ok: true };
}

export function clientIp(req) {
  const xf = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xf || req.socket?.remoteAddress || "unknown";
}
export function isAdmin(req) {
  const k = LIMITS.adminKey();
  return !!k && (req.headers["x-exbots-key"] === k || req.query?.key === k);
}
