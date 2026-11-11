import { signRequest } from "./kalshiAuth.ts";
import { config } from "./config.ts";

type KalshiMarket = {
  ticker: string;
  yes_sub_title?: string;
  status: string;
  open_time: string;
  close_time: string;
  floor_strike?: number | string;
  cap_strike?: number | string;
  strike_type?: string;
  custom_strike?: { round_digits?: number | string };
};

export type CurrentMarket = {
  ticker: string;
  title: string;
  openTime: number;
  closeTime: number;
  // The contract's own settlement target, read from the exchange and never
  // inferred from a spot quote. null when the series doesn't expose one.
  strike: number | null;
  strikeType: string | null;
};

const numeric = (value: unknown): number | null => {
  if ((typeof value !== "number" && typeof value !== "string") || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const MARKETS_PATH = "/trade-api/v2/markets";

async function fetchMarkets(
  seriesTicker: string,
  status: "open" | "unopened",
  limit: number
): Promise<CurrentMarket[]> {
  const query = `?series_ticker=${seriesTicker}&status=${status}&limit=${limit}`;
  const headers = {
    ...signRequest("GET", MARKETS_PATH),
    Accept: "application/json",
  };

  const res = await fetch(`${config.restBaseUrl}${MARKETS_PATH}${query}`, {
    headers,
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    throw new Error(
      `Kalshi markets lookup failed: ${res.status} ${await res.text()}`
    );
  }

  const body = (await res.json()) as { markets: KalshiMarket[] };
  return body.markets.map((m) => ({
    ticker: m.ticker,
    title: m.yes_sub_title ?? m.ticker,
    openTime: Date.parse(m.open_time),
    closeTime: Date.parse(m.close_time),
    strike: numeric(m.floor_strike) ?? numeric(m.cap_strike),
    strikeType: typeof m.strike_type === "string" ? m.strike_type : null,
  }));
}

export async function findCurrentMarket(
  seriesTicker: string
): Promise<CurrentMarket | null> {
  const markets = await fetchMarkets(seriesTicker, "open", 50);
  const now = Date.now();
  const candidates = markets
    .filter((m) => m.openTime <= now && now < m.closeTime)
    .sort((a, b) => a.closeTime - b.closeTime);
  return candidates[0] ?? null;
}

// Kalshi pre-creates a day's worth of windows in advance, so the next one
// is knowable before the current window closes.
export async function findNextMarket(
  seriesTicker: string,
  afterMs: number
): Promise<CurrentMarket | null> {
  // A response may cross the boundary, when the successor moves from
  // unopened to open. Search both so classification cannot hide it.
  const results = await Promise.allSettled([
    fetchMarkets(seriesTicker, "unopened", 200),
    fetchMarkets(seriesTicker, "open", 50),
  ]);
  const markets = results.flatMap(result => result.status === "fulfilled" ? result.value : []);
  if (results.every(result => result.status === "rejected")) throw (results[0] as PromiseRejectedResult).reason;
  const candidates = markets
    .filter((m) => m.openTime >= afterMs)
    .sort((a, b) => a.openTime - b.openTime);
  return candidates[0] ?? null;
}

export type StrikeMetadata = { strike: number | null; strikeType: string | null; roundDigits: number | null };

// A freshly opened window often reports no strike yet ("Target Price: TBD")
// — Kalshi sets it from the opening print a few seconds in. Callers that
// got strike: null from the lookups above should retry with this rather
// than treat it as permanent. Single-ticker, not the list endpoint above.
export async function fetchStrikeMetadata(
  ticker: string,
  request: typeof fetch = fetch
): Promise<StrikeMetadata> {
  const path = `/trade-api/v2/markets/${encodeURIComponent(ticker)}`;
  try {
    const res = await request(`${config.restBaseUrl}${path}`, {
      headers: signRequest("GET", path),
      signal: AbortSignal.timeout(1200),
      cache: "no-store",
    });
    if (!res.ok) throw new Error("metadata unavailable");
    const { market: m } = (await res.json()) as { market: KalshiMarket };
    if (m?.ticker !== ticker) throw new Error("wrong contract");
    const digits = numeric(m.custom_strike?.round_digits);
    return {
      strike: numeric(m.floor_strike) ?? numeric(m.cap_strike),
      strikeType: typeof m.strike_type === "string" ? m.strike_type : null,
      roundDigits: digits !== null && Number.isInteger(digits) && digits >= 0 && digits <= 12 ? digits : null,
    };
  } catch {
    return { strike: null, strikeType: null, roundDigits: null };
  }
}
