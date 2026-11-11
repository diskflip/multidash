import { config } from "./config.ts";
import { normalizeQuickTrade, type QuickTradeStatus } from "../src/lib/quickTrade.ts";

// Talks to the live trading bot's control API (multibot) via its Cloudflare
// quick tunnel (MULTIBOT_API_URL) — changes on every multibot restart,
// update it in .env when that happens.

export const BUDGET_MIN = 1;
export const BUDGET_MAX = 50;

// The quick-tunnel URL can go dead (multibot restarted, tunnel dropped)
// without ever refusing the connection — a bare fetch() to a dead
// Cloudflare tunnel can hang far longer than the 1s poll interval instead
// of failing fast. Without a timeout, every poll tick fires off another
// fetch on top of whatever's still hanging, and they pile up indefinitely.
const FETCH_TIMEOUT_MS = 4_000;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

// Analysis-only score from multibot's scoring model — not a win
// probability, never used here to control any bot.
export type FlipPotential = {
  score: number | null;
  // e.g. "warming_up" — score stays null the whole time, so the UI needs
  // this to show *something* instead of looking missing.
  status: string | null;
  restOrderCandidate: boolean;
  components: Record<string, number> | null;
  blockers: string[] | null;
};

export type BotStatus = {
  quickTrade?: QuickTradeStatus;
  swingSupported: boolean;
  swingEnabled: boolean;
  enabled: boolean;
  budget: number | null;
  allocation: number | null;
  flipPotential: FlipPotential | null;
};

// The exact key names for the nested object/fields aren't nailed down any
// more firmly than seriesIdOf's below — tries the couple of reasonable
// spellings instead of assuming one and silently showing nothing.
function flipPotentialOf(entry: any): FlipPotential | null {
  const fp = entry?.flip_potential ?? entry?.flipPotential;
  if (!fp || typeof fp !== "object") return null;
  const score = typeof fp.score === "number" ? fp.score : null;
  const status = typeof fp.status === "string" ? fp.status : null;
  const restOrderCandidate = Boolean(fp.rest_order_candidate ?? fp.restOrderCandidate);
  const rawComponents = fp.components;
  const components =
    rawComponents && typeof rawComponents === "object" && !Array.isArray(rawComponents)
      ? Object.fromEntries(
          Object.entries(rawComponents).filter((entry): entry is [string, number] => typeof entry[1] === "number")
        )
      : null;
  const rawBlockers = fp.blockers;
  const blockers = Array.isArray(rawBlockers) ? rawBlockers.map(String) : null;
  return { score, status, restOrderCandidate, components, blockers };
}

function authHeaders(): Record<string, string> | null {
  if (!config.controlToken) return null;
  return { Authorization: `Bearer ${config.controlToken}` };
}

let warnedMissingToken = false;
function warnOnceIfNoToken() {
  if (config.controlToken || warnedMissingToken) return;
  warnedMissingToken = true;
  console.warn(
    "[bot-control] CONTROL_TOKEN not set — bot on/off and bet-size controls will no-op. See server/.env.example."
  );
}

// Normalizes one bot entry from GET /v1/bots — the exact key name for the
// series ID isn't nailed down, so this tries the couple of reasonable names
// instead of assuming one and silently dropping every bot if it's wrong.
function seriesIdOf(entry: any): string | undefined {
  return entry?.series ?? entry?.seriesId ?? entry?.series_id ?? entry?.id;
}

let loggedFirstSuccess = false;

// GET /v1/bots — live status for every bot, polled once a second (see
// BOT_POLL_MS in server/index.ts). Returns null on any failure (no token
// configured, tunnel down, bad response) so the caller can just skip the
// tick rather than crash anything.
export async function fetchBotEvents(): Promise<Map<string, BotStatus> | null> {
  const headers = authHeaders();
  if (!headers) {
    warnOnceIfNoToken();
    return null;
  }
  let res: Response;
  try {
    res = await fetchWithTimeout(`${config.multibotApiUrl}/v1/bots`, { headers });
  } catch (err) {
    console.warn("[bot-control] failed to reach multibot API:", (err as Error).message);
    return null;
  }
  if (!res.ok) {
    console.warn(`[bot-control] GET /v1/bots failed: ${res.status} ${res.statusText}`);
    return null;
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    console.warn("[bot-control] GET /v1/bots returned non-JSON");
    return null;
  }
  // The response is an object with top-level status fields (timestamp,
  // online, budget_min/max/step, ...) plus the actual per-bot list nested
  // under "bots" — confirmed directly against the live API, not a guess.
  const entries: any[] = Array.isArray(body)
    ? body
    : Array.isArray((body as any)?.bots)
      ? (body as any).bots
      : [];
  const bySeriesId = new Map<string, BotStatus>();
  for (const entry of entries) {
    const seriesId = seriesIdOf(entry);
    if (typeof seriesId !== "string") continue;
    bySeriesId.set(seriesId, {
      quickTrade: normalizeQuickTrade(entry, entry.quick_trade_version ?? (body as any)?.quick_trade_version),
      swingSupported: entry.swing_supported === true,
      swingEnabled: entry.swing_enabled === true,
      enabled: Boolean(entry.enabled),
      budget: typeof entry.budget === "number" ? entry.budget : null,
      allocation: typeof entry.allocation === "number" ? entry.allocation : null,
      flipPotential: flipPotentialOf(entry),
    });
  }
  if (!loggedFirstSuccess) {
    loggedFirstSuccess = true;
    console.log(`[bot-control] connected — ${bySeriesId.size} bot(s) reported by multibot`);
  }
  return bySeriesId;
}

// PUT /v1/bots/:seriesId — both fields required together (the API isn't a
// partial-patch), so callers merge in whatever isn't changing from the
// last-known status before calling this. Returns whether it actually went
// through.
export async function putBotConfig(
  seriesId: string,
  desired: { enabled: boolean; budget: number }
): Promise<boolean> {
  const headers = authHeaders();
  if (!headers) {
    warnOnceIfNoToken();
    return false;
  }
  const clampedBudget = Math.min(BUDGET_MAX, Math.max(BUDGET_MIN, Math.round(desired.budget)));
  try {
    const res = await fetchWithTimeout(`${config.multibotApiUrl}/v1/bots/${seriesId}`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: desired.enabled, budget: clampedBudget }),
    });
    if (!res.ok) {
      console.warn(`[bot-control] PUT /v1/bots/${seriesId} failed: ${res.status} ${res.statusText}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[bot-control] failed to reach multibot API:`, (err as Error).message);
    return false;
  }
}

// Swing is a partial update: never send enabled/budget with this command.
export async function putBotSwing(seriesId: string, enabled: boolean): Promise<boolean> {
  const headers = authHeaders();
  if (!headers) return false;
  try {
    const response = await fetchWithTimeout(`${config.multibotApiUrl}/v1/bots/${encodeURIComponent(seriesId)}`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ swing_enabled: enabled }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
