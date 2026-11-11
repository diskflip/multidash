import type { QuickTradeStatus } from "../lib/quickTrade.ts";
import type { JevDecision } from "./decision.ts";

export type PricePoint = {
  time: number;
  yes: number; // YES side's best bid, in cents (0-100). NO = 100 - yes.
};

// Tagged with which 15m contract it belongs to, so the chart can break the
// line at rollovers instead of connecting across them.
export type HistoryPoint = PricePoint & { ticker: string; openTime: number; closeTime: number; breakBefore?: boolean; source?: 'snapshot' };

// One observation of the settlement index against the current contract's
// strike. distance is signed so positive always means the side that pays
// YES, which is what lets the chart draw it against the YES price.
export type DistancePoint = {
  time: number;
  ticker: string;
  value: number;  // The settlement index itself (BRTI for BTC).
  strike: number; // The contract's own strike, in the same units.
  distance: number;
  // Chart-only distance, faded toward Kalshi's final-minute average as it
  // accumulates. Older saved points omit this and render using distance.
  displayDistance?: number;
};

export type MarketInfo = {
  symbol: string;
  ticker: string;
  title: string;
  openTime: number;
  closeTime: number;
};

// A discrete trading moment to mark on the chart. yes is the best price
// known at that moment, not necessarily the exact fill price.
export type ChartEvent = {
  orderId?: string;
  ticker?: string;
  time: number;
  type: "buy" | "sell" | "rest";
  yes: number;
};

// Analysis-only score from multibot's scoring model (server/botControl.ts)
// — not a win probability, never drives bot behavior. 7+ is its own
// provisional-review threshold, nothing enforced here.
export type FlipPotential = {
  score: number | null;
  // e.g. "warming_up" — score stays null while this is set.
  status: string | null;
  restOrderCandidate: boolean;
  components: Record<string, number> | null;
  blockers: string[] | null;
};

// Messages sent from the local backend proxy to the browser over WebSocket.
export type LeaderboardRow = { symbol: string; profitDollars: number; wins: number; losses: number };
export type ServerMessage =
  | { type: "jevDecision"; decision: JevDecision }
  | { type: "orderEvent"; symbol: string; ticker: string; orderId: string; resting: boolean; status?: string; yes?: number; time?: number }
  | { type: "leaderboard"; rows: LeaderboardRow[] }
  // market is null when the symbol has no currently open window (e.g. a
  // weekend-closed series like GOLD/OIL/SILVER) — see server/index.ts.
  | { type: "market"; symbol: string; market: MarketInfo | null }
  | { type: "price"; symbol: string; point: HistoryPoint }
  | { type: "history"; symbol: string; points: HistoryPoint[] }
  // Underlying-vs-strike line on the chart — see server/strikeDistance.ts.
  // Only sent for symbols with a readable single-sided strike and a
  // settlement index feed.
  | { type: "distance"; symbol: string; point: DistancePoint }
  | { type: "distanceHistory"; symbol: string; points: DistancePoint[] }
  | { type: "flips"; symbol: string; lastHour: number; lastWindow: number }
  | { type: "wallet"; balanceCents: number }
  // Real, account-wide realized P&L for today — see
  // fetchTodaysRealizedPnlTotal in server/portfolio.ts.
  | { type: "accountPnl"; dollars: number }
  | { type: "orderStatus"; symbol: string; ticker?: string | null; resting: boolean; holding: boolean }
  | { type: "pnl"; symbol: string; dollars: number }
  // Paper-trading simulation — see server/simTracker.ts. sim1h and sim30m
  // each combine two strategies (6c-in/50c-out and 20c-in/80c-out) into
  // one tally: 1 point per winning flip, from either, within the window.
  | {
      type: "sim1h" | "sim30m";
      symbol: string;
      tally: number;
      wins: number;
      losses: number;
      lastTrade: {
        side: "yes" | "no";
        result: "win" | "loss";
        entryCents: number;
        profitDollars: number;
        time: number;
      } | null;
    }
  | { type: "spot"; symbol: string; priceDollars: number }
  | { type: "position"; symbol: string; ticker?: string | null; positionFp: number; costDollars: number }
  | { type: "swingResult"; requestId: string; symbol: string; ok: boolean; error?: string }
  | { type: "botCommandResult"; requestId: string; symbol: string; ok: boolean; error?: string }
  | { type: "quickTradeResult"; requestId: string; symbol: string; ok: boolean; queued: boolean; error?: string }
  | { type: "clock"; serverTime: number }
  | { type: "status"; connected: boolean; canControl: boolean; serverTime: number }
  | {
      type: "fillEvent";
      symbol: string;
      ticker?: string;
      intent: "entry" | "exit" | "win";
      side?: "yes" | "no";
      priceCents?: number;
    }
  // Live trading bot on/off + budget, from the multibot control API — see
  // server/botControl.ts. budget/allocation are dollars; allocation is
  // multibot's own actual live sizing, shown in place of budget when known.
  | {
      type: "botStatus";
      quickTrade?: QuickTradeStatus | null;
      swingSupported: boolean;
      swingEnabled: boolean;
      symbol: string;
      enabled: boolean;
      budget: number | null;
      allocation: number | null;
      flipPotential: FlipPotential | null;
    };
