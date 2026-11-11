import { WebSocketServer, WebSocket } from "ws";
import { PriceHistory } from "./priceHistory.ts";
import { startJev } from "./decisions/index.ts";
import { StrikeDistance, DISTANCE_SYMBOLS } from "./strikeDistance.ts";
import { symbolForIndexId, type IndexTick } from "./decisions/settlement.ts";
import { QuoteRecovery } from "./quoteRecovery.ts";
import type { HistoryPoint } from "../src/types/market.ts";
import { BotCommandLane } from "./botCommandLane.ts";
import { postQuickOrder, validateQuickOrder } from "./quickTrade.ts";
import type { QuickOrder } from "../src/lib/quickTrade.ts";
import { LivePortfolio } from "./livePortfolio.ts";
import { LeaderboardStore } from "./leaderboardStore.ts";
import { createDashboardServer } from "./dashboardServer.ts";
import { config } from "./config.ts";
import { findCurrentMarket, findNextMarket, fetchStrikeMetadata, type CurrentMarket } from "./findMarket.ts";
import { KalshiFeed } from "./kalshiSocket.ts";
import { KalshiFillsFeed, type PositionUpdate, type OrderUpdate } from "./kalshiFills.ts";
import { FlipTracker } from "./flipTracker.ts";
import { PnlTracker } from "./pnlTracker.ts";
import { SimTracker } from "./simTracker.ts";
import { startBtcSpotFeed } from "./spotPrice.ts";
import {
  fetchPortfolioSnapshot,
  fetchTickerRealizedPnl,
  fetchTodaysRealizedPnlBySeries,
  fetchTodaysRealizedPnlTotal,
  type PortfolioSnapshot,
} from "./portfolio.ts";
import { getPnlSince, resetPnlNow, startOfLocalDay } from "./pnlReset.ts";
import { fetchBotEvents, putBotConfig, putBotSwing, BUDGET_MIN, BUDGET_MAX, type BotStatus } from "./botControl.ts";

const wss = process.env.NODE_ENV === "production"
  ? createDashboardServer(config.localWsPort, process.env.DASHBOARD_ACCESS_TOKEN ?? "")
  : new WebSocketServer({ port: config.localWsPort, host: "127.0.0.1" });
const FLIPS_REBROADCAST_MS = 10_000;
const PORTFOLIO_POLL_MS = 5_000;
const BOT_POLL_MS = 1_000;
const priceHistory = new PriceHistory(".runtime/price-history.json");
const strikeDistance = new StrikeDistance(".runtime/strike-distance.json");
const quoteRecovery = new QuoteRecovery();
const leaderboard = new LeaderboardStore(".runtime/leaderboard-v2.json", config.markets.map(m => m.symbol), symbol => priceHistory.get(symbol));
setInterval(() => priceHistory.save(), 5000);
setInterval(() => strikeDistance.save(), 5000);
setInterval(() => { broadcast(leaderboard.message()); leaderboard.save(); }, 1000);

let lastPortfolio: PortfolioSnapshot | null = null;
const livePortfolio = new LivePortfolio();
const orderDetails = new Map<string, OrderUpdate>();
const jevInterests = new Map<WebSocket, Set<string>>();

function orderEvents(symbol: string, ticker: string | undefined) {
  return [...orderDetails.values()].filter(order => order.ticker === ticker)
    .map(order => ({ type: "orderEvent" as const, symbol, ...order }));
}
let lastBtcSpotDollars: number | null = null;

// Neither "entry" nor "exit" in a fill's order tag reliably says which way
// the position moved (confirmed: NATGAS/COPPER "exit"-tagged fills that
// grew the position; a HYPE "entry"-tagged fill that was really a sell).
// |positionFp| growing vs. shrinking is what's authoritative.
const lastPositionMagnitudeByTicker = new Map<string, number>();

// realized_pnl_dollars is scoped per-ticker, not global (confirmed: two
// tickers' messages never echo each other's running totals in the same
// burst). Tracking one global total instead of per-ticker would mangle two
// real wins landing close together into one.
const lastRealizedPnlByTicker = new Map<string, number>();

// One logical closing trade often lands as several partial fills a fraction
// of a second to ~2s apart, each nudging realized_pnl_dollars — coalesce
// them so one trade doesn't fire the win celebration 2-3 times. Accumulate
// for DEBOUNCE_MS of quiet after the last bump, capped at MAX_WAIT_MS total.
const WIN_DEBOUNCE_MS = 400;
const WIN_MAX_WAIT_MS = 2000;
type PendingWin = { total: number; firstAt: number; timer: ReturnType<typeof setTimeout> };
const pendingWins = new Map<string, PendingWin>();

// In-memory maps above are wiped on restart/reconnect, so an already-open
// position's next update would look like a fresh entry (delta off a false
// $0 baseline). Cleared on every (re)connect; the first observation per
// ticker after that re-seeds the baseline silently instead of firing.
const seenTickersThisConnection = new Set<string>();

function queueWin(ticker: string, symbol: string, delta: number) {
  const now = Date.now();
  const existing = pendingWins.get(ticker);
  // Notify on the leading edge, then coalesce subsequent partial-fill profits.
  if (!existing) broadcast({ type: "fillEvent", symbol, intent: "win" });
  const total = (existing?.total ?? 0) + delta;
  const firstAt = existing?.firstAt ?? now;
  if (existing) clearTimeout(existing.timer);

  const remainingMaxWait = WIN_MAX_WAIT_MS - (now - firstAt);
  const wait = Math.max(0, Math.min(WIN_DEBOUNCE_MS, remainingMaxWait));

  const timer = setTimeout(() => {
    pendingWins.delete(ticker);
  }, wait);

  pendingWins.set(ticker, { total, firstAt, timer });
}

function broadcast(message: unknown) {
  const data = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  }
}

function marketMessage(symbol: string, market: CurrentMarket | null) {
  return {
    type: "market",
    symbol,
    market:
      market === null
        ? null
        : {
            symbol,
            ticker: market.ticker,
            title: market.title,
            openTime: Math.floor(market.openTime / 1000),
            closeTime: Math.floor(market.closeTime / 1000),
          },
  };
}

function flipsMessage(symbol: string, flips: FlipTracker) {
  return {
    type: "flips",
    symbol,
    lastHour: flips.countLastHour(),
    lastWindow: flips.countLastCompletedWindow(),
  };
}

function walletMessage(balanceCents: number) {
  return { type: "wallet", balanceCents };
}

function orderStatusMessage(
  symbol: string,
  ticker: string | undefined,
  snapshot: PortfolioSnapshot
) {
  return {
    type: "orderStatus",
    symbol,
    ticker: ticker ?? null,
    resting: ticker !== undefined && snapshot.restingTickers.has(ticker),
    holding: ticker !== undefined && snapshot.holdingTickers.has(ticker),
  };
}

// pendingRealizedDollars folds in confirmed-but-not-yet-settled wins from
// the current window (see TrackedMarket) so a win shows up immediately
// instead of waiting for the window to roll over.
function pnlMessage(symbol: string, pnl: PnlTracker, pendingRealizedDollars: number) {
  return { type: "pnl", symbol, dollars: pnl.total() + pendingRealizedDollars };
}

// Each window runs two paper strategies side by side — 6c-in/50c-out and
// 20c-in/80c-out — and the two combine into one tally: 1 point per
// winning flip, from either strategy, within the rolling window. lastTrade
// is whichever of the two most recently resolved, so a win from either
// still triggers the frontend's flash/sound.
function simMessage(
  type: "sim1h" | "sim30m",
  symbol: string,
  simA: SimTracker,
  simB: SimTracker,
) {
  const a = simA.snapshot();
  const b = simB.snapshot();
  const lastTrade =
    a.lastTrade && (!b.lastTrade || a.lastTrade.time >= b.lastTrade.time) ? a.lastTrade : b.lastTrade;
  return {
    type,
    symbol,
    tally: a.windowWins + b.windowWins,
    wins: a.wins + b.wins,
    losses: a.losses + b.losses,
    lastTrade,
  };
}

function spotMessage(symbol: string, priceDollars: number) {
  return { type: "spot", symbol, priceDollars };
}

function positionMessage(symbol: string, position: OpenPosition | null, ticker: string | null) {
  return {
    type: "position",
    symbol,
    ticker,
    positionFp: position?.positionFp ?? 0,
    costDollars: position?.costDollars ?? 0,
  };
}

function botStatusMessage(symbol: string, status: BotStatus) {
  return {
    type: "botStatus",
    quickTrade: status.quickTrade ?? null,
    symbol,
    swingSupported: status.swingSupported,
    swingEnabled: status.swingEnabled,
    enabled: status.enabled,
    budget: status.budget,
    allocation: status.allocation,
    flipPotential: status.flipPotential,
  };
}

function flipPotentialEqual(a: BotStatus["flipPotential"], b: BotStatus["flipPotential"]): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  // Components/blockers change alongside these — enough to decide whether
  // to broadcast without a full deep-equal every poll tick.
  return a.score === b.score && a.status === b.status && a.restOrderCandidate === b.restOrderCandidate;
}

type TrackedMarket = {
  symbol: string;
  seriesTicker: string;
  active: CurrentMarket | null;
  previousTicker: string | null;
  nextKnown: CurrentMarket | null;
  feed: KalshiFeed;
  flips: FlipTracker;
  pnl: PnlTracker;
  // Two paper strategies per window, combined into one tally by simMessage.
  sim1h: SimTracker;
  sim1hAlt: SimTracker;
  sim30m: SimTracker;
  sim30mAlt: SimTracker;
  position: OpenPosition | null;
  // Confirmed wins in the current, still-open window — shown immediately
  // instead of waiting for settleClosedWindow's rollover-triggered lookup.
  // Reset to 0 on rollover, once settleClosedWindow's authoritative figure
  // lands in market.pnl instead, so it's never double-counted.
  pendingRealizedDollars: number;
};

type OpenPosition = { positionFp: number; costDollars: number };

const SIM_ENTRY_CENTS = 6;
const SIM_EXIT_CENTS = 50;
const SIM_ALT_ENTRY_CENTS = 20;
const SIM_ALT_EXIT_CENTS = 80;

const trackedMarkets: TrackedMarket[] = config.markets.map(({ symbol, seriesTicker }) => {
  const flips = new FlipTracker();
  const sim1h = new SimTracker(SIM_ENTRY_CENTS, SIM_EXIT_CENTS, 1, 3600);
  const sim1hAlt = new SimTracker(SIM_ALT_ENTRY_CENTS, SIM_ALT_EXIT_CENTS, 1, 3600);
  const sim30m = new SimTracker(SIM_ENTRY_CENTS, SIM_EXIT_CENTS, 1, 30 * 60);
  const sim30mAlt = new SimTracker(SIM_ALT_ENTRY_CENTS, SIM_ALT_EXIT_CENTS, 1, 30 * 60);
  const feed = new KalshiFeed(({ yes, ticker, time, breakBefore }) => {
    const active = trackedMarkets.find((m) => m.symbol === symbol)?.active;
    if (!active || ticker !== active.ticker || time < active.openTime / 1000 ||
        time >= active.closeTime / 1000 || Date.now() >= active.closeTime) return;
    // A REST observation can be newer than a delayed exchange tick.
    if (time < (priceHistory.get(symbol).at(-1)?.time ?? -Infinity)) return;
    const point = { time, yes, ticker, breakBefore, openTime: active.openTime / 1000, closeTime: active.closeTime / 1000 };
    publishPrice(symbol, point);
  }, symbol);
  feed.start();
  return {
    symbol,
    seriesTicker,
    active: null,
    previousTicker: null,
    nextKnown: null,
    feed,
    flips,
    pnl: new PnlTracker(),
    sim1h,
    sim1hAlt,
    sim30m,
    sim30mAlt,
    position: null,
    pendingRealizedDollars: 0,
  };
});

function publishPrice(symbol: string, point: HistoryPoint) {
  const market = trackedMarkets.find(m => m.symbol === symbol);
  if (!market || point.time < (priceHistory.get(symbol).at(-1)?.time ?? -Infinity)) return;
  const { flips, sim1h, sim1hAlt, sim30m, sim30mAlt } = market;
  const { yes } = point;
  priceHistory.add(symbol, point);
  leaderboard.onPrice(symbol, point);
  broadcast({
    type: "price",
    symbol,
    point,
  });
  if (flips.onPrice(yes)) {
    broadcast(flipsMessage(symbol, flips));
  }
  const sim1hResolved = sim1h.onPrice(yes);
  const sim1hAltResolved = sim1hAlt.onPrice(yes);
  if (sim1hResolved || sim1hAltResolved) {
    broadcast(simMessage("sim1h", symbol, sim1h, sim1hAlt));
  }
  const sim30mResolved = sim30m.onPrice(yes);
  const sim30mAltResolved = sim30mAlt.onPrice(yes);
  if (sim30mResolved || sim30mAltResolved) {
    broadcast(simMessage("sim30m", symbol, sim30m, sim30mAlt));
  }
}

// The settlement index ticks about once a second, independently of the
// quote feed, so the distance line keeps moving through a flat quote —
// which is exactly when it has the most to say.
function publishDistance(tick: IndexTick) {
  const symbol = symbolForIndexId(tick.indexId);
  if (symbol === null) return;
  const market = trackedMarkets.find(m => m.symbol === symbol);
  const point = strikeDistance.observe(symbol, market?.active ?? null, tick);
  if (point) broadcast({ type: "distance", symbol, point });
}

// Spreads N per-market checks evenly across an interval window instead of
// firing all of them in the same tick. Kalshi's REST rate limit reacts to
// bursts, not just average rate — 19 markets' worth of recovery/refresh
// calls landing in the same millisecond trips it even when the same total
// volume spread over the window would not, and a 429 on the recovery path
// specifically is what leaves a real feed gap unhealed (confirmed in
// .runtime logs: "[quote-recovery] SYMBOL: Orderbook 429" during the exact
// outages this is meant to patch over).
function stagger<T>(items: T[], intervalMs: number, action: (item: T) => void): void {
  const step = items.length > 0 ? intervalMs / items.length : intervalMs;
  items.forEach((item, index) => setTimeout(() => action(item), index * step));
}

function recoverMarketQuote(market: TrackedMarket) {
  void quoteRecovery.refresh(market.symbol, () => market.active,
    () => priceHistory.get(market.symbol).at(-1), point => {
      publishPrice(market.symbol, point);
    });
}
setInterval(() => stagger(trackedMarkets, 1000, recoverMarketQuote), 1000);

// A freshly rolled-over window often reports no strike yet ("Target Price:
// TBD") — Kalshi sets it from the opening print a few seconds in. Without
// this, publishDistance's observe() would reject every tick for the new
// contract forever, since the market object fetched at rollover time never
// gets a second look otherwise. Scoped to DISTANCE_SYMBOLS so this is a
// no-op for every market the chart line isn't published for.
const refreshingStrike = new Set<string>();
function refreshMissingStrike(market: TrackedMarket) {
  const active = market.active;
  if (!active || active.strike !== null || !DISTANCE_SYMBOLS.has(market.symbol)) return;
  if (refreshingStrike.has(active.ticker)) return;
  refreshingStrike.add(active.ticker);
  void fetchStrikeMetadata(active.ticker)
    .then(({ strike, strikeType }) => {
      // The window may have already rolled over again while this was in flight.
      if (strike !== null && market.active?.ticker === active.ticker) {
        market.active = { ...market.active, strike, strikeType };
      }
    })
    .finally(() => refreshingStrike.delete(active.ticker));
}
setInterval(() => stagger(trackedMarkets, 3000, refreshMissingStrike), 3000);

function resetTodaysPnl() {
  resetPnlNow();
  for (const market of trackedMarkets) {
    market.pnl.reset();
    market.pendingRealizedDollars = 0;
    broadcast(pnlMessage(market.symbol, market.pnl, market.pendingRealizedDollars));
  }
  accountPnlEpoch++;
  void pollAccountPnl();
  console.log("[pnl] reset for the day");
}

function resetTodaysSim() {
  for (const market of trackedMarkets) {
    market.sim1h.reset();
    market.sim1hAlt.reset();
    market.sim30m.reset();
    market.sim30mAlt.reset();
    broadcast(simMessage("sim1h", market.symbol, market.sim1h, market.sim1hAlt));
    broadcast(simMessage("sim30m", market.symbol, market.sim30m, market.sim30mAlt));
  }
  console.log("[sim] reset for the day");
}

wss.on("connection", (client) => {
  client.on("close", () => jevInterests.delete(client));
  // Public controls are intentional: every dashboard visitor can operate bots.
  const canControl = true;
  client.on("message", (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg?.cmd === "setJevMarkets" && Array.isArray(msg.symbols)) {
      jevInterests.set(client, new Set(msg.symbols.filter((symbol: unknown): symbol is string =>
        typeof symbol === "string" && config.markets.some(m => m.symbol === symbol)).slice(0, config.markets.length)));
      return;
    }
    if (msg?.cmd === "setBotSwing" && typeof msg.symbol === "string" && typeof msg.enabled === "boolean" && typeof msg.requestId === "string") {
      void handleSwingCommand(client, msg.symbol, msg.enabled, msg.requestId);
    }
    if (msg?.cmd === "quickTrade" && typeof msg.symbol === "string" && typeof msg.order?.request_id === "string") {
      void handleQuickTrade(client, msg.symbol, msg.order, msg.cancelRestingBuy === true);
    }
    if (msg?.cmd === "resetPnl") resetTodaysPnl();
    if (msg?.cmd === "resetSim") resetTodaysSim();
    if (msg?.cmd === "setBotEnabled" && typeof msg.symbol === "string" && typeof msg.enabled === "boolean") {
      void handleBotCommand(msg.symbol, { enabled: msg.enabled }, client, typeof msg.requestId === "string" ? msg.requestId : undefined);
    }
    if (msg?.cmd === "setBotBudget" && typeof msg.symbol === "string" && typeof msg.budget === "number") {
      void handleBotCommand(msg.symbol, { budget: msg.budget });
    }
  });

  client.send(JSON.stringify({ type: "status", connected: true, canControl, serverTime: Date.now() / 1000 }));
  client.send(JSON.stringify({ type: "accountPnl", dollars: accountPnlDollars }));
  client.send(JSON.stringify(leaderboard.message()));
  for (const decision of jev.latest.values()) client.send(JSON.stringify({ type: "jevDecision", decision }));
  for (const market of trackedMarkets) {
    client.send(JSON.stringify(marketMessage(market.symbol, market.active)));
    client.send(JSON.stringify({ type: "history", symbol: market.symbol, points: priceHistory.get(market.symbol) }));
    const distancePoints = strikeDistance.get(market.symbol);
    if (distancePoints.length > 0) {
      client.send(JSON.stringify({ type: "distanceHistory", symbol: market.symbol, points: distancePoints }));
    }
    client.send(JSON.stringify(flipsMessage(market.symbol, market.flips)));
    client.send(JSON.stringify(pnlMessage(market.symbol, market.pnl, market.pendingRealizedDollars)));
    client.send(JSON.stringify(simMessage("sim1h", market.symbol, market.sim1h, market.sim1hAlt)));
    client.send(JSON.stringify(simMessage("sim30m", market.symbol, market.sim30m, market.sim30mAlt)));
    client.send(JSON.stringify(positionMessage(market.symbol, market.active ? market.position : null, market.active?.ticker ?? null)));
    for (const event of orderEvents(market.symbol, market.active?.ticker)) client.send(JSON.stringify(event));
    const botStatus = lastBotStatusBySymbol.get(market.symbol);
    if (botStatus) {
      client.send(JSON.stringify(botStatusMessage(market.symbol, botStatus)));
    }
  }
  if (lastPortfolio) {
    client.send(JSON.stringify(walletMessage(lastPortfolio.balanceCents)));
    for (const market of trackedMarkets) {
      client.send(
        JSON.stringify(orderStatusMessage(market.symbol, market.active?.ticker, lastPortfolio))
      );
    }
  }
  if (lastBtcSpotDollars !== null) {
    client.send(JSON.stringify(spotMessage("BTC", lastBtcSpotDollars)));
  }
});

function applyMarketSwitch(market: TrackedMarket, found: CurrentMarket) {
  const now = Date.now();
  if (found.openTime > now || found.closeTime <= now ||
      (market.active && found.openTime < market.active.openTime)) return;
  if (market.active?.ticker === found.ticker) return;
  market.nextKnown = null;
  console.log(`[market-poll] ${market.symbol} switching to ${found.ticker}`);
  const closingTicker = market.active?.ticker;
  market.previousTicker = closingTicker ?? null;
  market.active = found;
  market.position = null;
  market.flips.onMarketChange(found.ticker, found.closeTime);
  market.sim1h.onMarketChange(found.ticker, found.closeTime);
  market.sim1hAlt.onMarketChange(found.ticker, found.closeTime);
  market.sim30m.onMarketChange(found.ticker, found.closeTime);
  market.sim30mAlt.onMarketChange(found.ticker, found.closeTime);
  if (closingTicker) settleClosedWindow(market, closingTicker);
  // settleClosedWindow above will fold the just-closed window's real total
  // into market.pnl once its REST lookup lands, so clearing this can't lose
  // or double-count anything.
  market.pendingRealizedDollars = 0;
  broadcast(pnlMessage(market.symbol, market.pnl, market.pendingRealizedDollars));
  broadcast(marketMessage(market.symbol, found));
  for (const event of orderEvents(market.symbol, found.ticker)) broadcast(event);
  broadcast(flipsMessage(market.symbol, market.flips));
  broadcast(simMessage("sim1h", market.symbol, market.sim1h, market.sim1hAlt));
  broadcast(simMessage("sim30m", market.symbol, market.sim30m, market.sim30mAlt));
  broadcast(positionMessage(market.symbol, null, found.ticker));
  if (lastPortfolio) {
    broadcast(orderStatusMessage(market.symbol, found.ticker, lastPortfolio));
  }
  // Announce the contract before replaying ticks received in the boundary race.
  market.feed.promote(found.ticker, found.openTime / 1000);
  recoverMarketQuote(market);
  void pollPortfolio();
  void pollBotStatus();
}

// Kalshi pre-creates a day's worth of windows in advance, so the next one
// is fetched and pre-subscribed ahead of the actual rollover.
const preparingNext = new Set<string>();
async function prepareNextMarket(market: TrackedMarket) {
  const active = market.active;
  if (!active || preparingNext.has(market.symbol)) return;
  preparingNext.add(market.symbol);
  try {
    const next = await findNextMarket(market.seriesTicker, active.closeTime);
    // A lookup started in the old interval must never replace the new
    // interval's successor after a delayed REST response.
    if (market.active?.ticker !== active.ticker || !next) return;
    market.nextKnown = next;
    market.feed.ensureSubscribed(next.ticker);
  } catch (err) {
    console.error(`[market-poll] ${market.symbol} next-market lookup failed:`, (err as Error).message);
  } finally {
    preparingNext.delete(market.symbol);
  }
}

// One boundary sweep promotes all ready contracts together. A missing
// successor cannot keep streaming the expired contract while REST catches up.
const lastRolloverLookup = new Map<string, number>();
setInterval(() => {
  const now = Date.now();
  for (const market of trackedMarkets) {
    if (!market.active || market.active.closeTime > now) continue;
    const next = market.nextKnown;
    if (next && next.openTime <= now && next.closeTime > now) {
      applyMarketSwitch(market, next);
      void prepareNextMarket(market);
    } else {
      market.feed.pause();
      if (now - (lastRolloverLookup.get(market.symbol) ?? 0) >= 1000) {
        lastRolloverLookup.set(market.symbol, now);
        void pollForCurrentMarket(market);
      }
    }
  }
}, 50);
setInterval(() => broadcast({ type: "clock", serverTime: Date.now() / 1000 }), 5000);

// Only called once the last-known window has actually closed. Left
// unhandled, a genuinely-closed market (e.g. weekend) would keep pinning
// the shared countdown at 0:00 and leave trackers pointed at a dead ticker,
// reading its late settlement swing as live data with no way to exit.
function pauseMarket(market: TrackedMarket) {
  market.position = null;
  market.active = null;
  market.nextKnown = null;
  market.feed.pause();
  market.flips.onMarketChange(null);
  market.sim1h.onMarketChange(null);
  market.sim1hAlt.onMarketChange(null);
  market.sim30m.onMarketChange(null);
  market.sim30mAlt.onMarketChange(null);
  broadcast(marketMessage(market.symbol, null));
  broadcast(positionMessage(market.symbol, null, null));
  broadcast({ type: "orderStatus", symbol: market.symbol, ticker: null, resting: false, holding: false });
  broadcast(flipsMessage(market.symbol, market.flips));
  broadcast(simMessage("sim1h", market.symbol, market.sim1h, market.sim1hAlt));
  broadcast(simMessage("sim30m", market.symbol, market.sim30m, market.sim30mAlt));
}

const marketPolls = new Set<string>();
async function pollForCurrentMarket(market: TrackedMarket, attempt = 0) {
  if (marketPolls.has(market.symbol)) return;
  marketPolls.add(market.symbol);
  try {
    const found = await findCurrentMarket(market.seriesTicker);
    if (!found) {
      console.warn(`[market-poll] no open ${market.symbol} 15m market found`);
      const expired = market.active && market.active.closeTime <= Date.now();
      if (expired) pauseMarket(market);
      if ((expired || attempt > 0) && attempt < 5) {
        setTimeout(() => { if (!market.active) void pollForCurrentMarket(market, attempt + 1); }, 1000);
      }
      return;
    }
    if (found.ticker !== market.active?.ticker) {
      applyMarketSwitch(market, found);
    }
    if (!market.nextKnown) prepareNextMarket(market);
  } catch (err) {
    console.error(`[market-poll] ${market.symbol} lookup failed:`, (err as Error).message);
  } finally {
    marketPolls.delete(market.symbol);
  }
}

// The immediate poll stays unstaggered — a one-time startup burst across
// 19 markets is a much smaller concern than the same burst repeating in
// lockstep every marketPollIntervalMs forever. Only the recurring
// interval's start is staggered, which keeps each market's own cadence
// unchanged (still marketPollIntervalMs apart from itself) while spreading
// the 19 markets' calls across the window instead of firing them all in
// the same tick — see stagger()'s comment above for why that matters.
trackedMarkets.forEach((market, index) => {
  pollForCurrentMarket(market);
  setTimeout(() => {
    setInterval(() => pollForCurrentMarket(market), config.marketPollIntervalMs);
  }, (index * config.marketPollIntervalMs) / trackedMarkets.length);
});

setInterval(() => {
  for (const market of trackedMarkets) {
    broadcast(flipsMessage(market.symbol, market.flips));
  }
}, FLIPS_REBROADCAST_MS);

let portfolioPollInFlight = false;
async function pollPortfolio() {
  if (portfolioPollInFlight) return;
  portfolioPollInFlight = true;
  const revision = livePortfolio.revision;
  let acceptOrderSnapshot: boolean | undefined;
  try {
    const snapshot = livePortfolio.reconcile(await fetchPortfolioSnapshot(livePortfolio.snapshot.restingOrders, order => {
      acceptOrderSnapshot ??= livePortfolio.revision === revision;
      if (acceptOrderSnapshot) publishOrderUpdate(order);
    }), revision);
    lastPortfolio = snapshot;
    broadcast(walletMessage(snapshot.balanceCents));
    for (const market of trackedMarkets) {
      const ticker = market.active?.ticker;
      if (ticker && !seenTickersThisConnection.has(ticker)) {
        const baseline = snapshot.positionBaselines.get(ticker);
        if (!baseline || (Number.isFinite(baseline.positionFp) && Number.isFinite(baseline.realizedPnlDollars))) {
          seenTickersThisConnection.add(ticker);
          lastPositionMagnitudeByTicker.set(ticker, Math.abs(baseline?.positionFp ?? 0));
          lastRealizedPnlByTicker.set(ticker, baseline?.realizedPnlDollars ?? 0);
        }
      }
      broadcast(orderStatusMessage(market.symbol, market.active?.ticker, snapshot));
    }
  } catch (err) {
    console.error("[portfolio-poll] failed:", (err as Error).message);
  } finally {
    portfolioPollInFlight = false;
  }
}

const SETTLEMENT_RETRY_MS = 2_000;
const SETTLEMENT_MAX_ATTEMPTS = 10;

async function settleClosedWindow(market: TrackedMarket, ticker: string, attempt = 0) {
  try {
    const dollars = await fetchTickerRealizedPnl(ticker);
    if (dollars === null) {
      if (attempt < SETTLEMENT_MAX_ATTEMPTS) {
        setTimeout(() => settleClosedWindow(market, ticker, attempt + 1), SETTLEMENT_RETRY_MS);
      } else {
        console.warn(`[pnl] ${market.symbol} ${ticker} never showed up as settled`);
      }
      return;
    }
    market.pnl.add(dollars);
    broadcast(pnlMessage(market.symbol, market.pnl, market.pendingRealizedDollars));
  } catch (err) {
    console.error(`[pnl] ${market.symbol} settlement lookup failed:`, (err as Error).message);
  }
}

pollPortfolio();
setInterval(pollPortfolio, PORTFOLIO_POLL_MS);
// User-order pushes remain immediate; cover missed pushes during rollover
// without waiting for the ordinary five-second account poll.
setInterval(() => {
  const now = Date.now();
  if (trackedMarkets.some(m => m.active && now >= m.active.openTime && now - m.active.openTime < 5000)) {
    void pollPortfolio();
  }
}, 500);

// Cached per symbol so a fresh client connection has something to send
// immediately, and so the 1s poll only broadcasts on actual change.
const lastBotStatusBySymbol = new Map<string, BotStatus>();
const jev = startJev(() => trackedMarkets.map(market => ({
  requested: [...jevInterests.values()].some(symbols => symbols.has(market.symbol)),
  symbol: market.symbol, market: market.active, history: priceHistory.get(market.symbol),
  score: lastBotStatusBySymbol.get(market.symbol)?.flipPotential?.score ?? null,
  flips30m: market.sim30m.snapshot().windowWins + market.sim30mAlt.snapshot().windowWins,
  flips1h: market.sim1h.snapshot().windowWins + market.sim1hAlt.snapshot().windowWins,
  exposed: !!market.position || (!!market.active && (livePortfolio.snapshot.restingTickers.has(market.active.ticker) || livePortfolio.snapshot.holdingTickers.has(market.active.ticker))),
})), decision => broadcast({ type: "jevDecision", decision }), publishDistance);
const botCommands = new BotCommandLane();

// Cheap insurance against the 1s interval getting ahead of a still-pending
// request (fetchBotEvents has its own timeout too).
let botPollInFlight = false;

async function pollBotStatus() {
  if (botPollInFlight) return;
  botPollInFlight = true;
  const revisions = new Map(trackedMarkets.map(market => [market.symbol, botCommands.revision(market.symbol)]));
  try {
    const events = await fetchBotEvents();
    if (!events) return;
    for (const market of trackedMarkets) {
      if (!botCommands.canApplyPoll(market.symbol, revisions.get(market.symbol)!)) continue;
      const status = events.get(market.seriesTicker);
      if (!status) continue;
      const prev = lastBotStatusBySymbol.get(market.symbol);
      if (
        prev &&
        prev.swingSupported === status.swingSupported &&
        prev.swingEnabled === status.swingEnabled &&
        prev.enabled === status.enabled &&
        prev.budget === status.budget &&
        prev.allocation === status.allocation &&
        JSON.stringify(prev.quickTrade) === JSON.stringify(status.quickTrade) &&
        flipPotentialEqual(prev.flipPotential, status.flipPotential)
      ) {
        continue;
      }
      lastBotStatusBySymbol.set(market.symbol, status);
      broadcast(botStatusMessage(market.symbol, status));
    }
  } finally {
    botPollInFlight = false;
  }
}
pollBotStatus();
setInterval(pollBotStatus, BOT_POLL_MS);

// PUT /v1/bots/:seriesId takes enabled+budget together, so this merges in
// whichever is not changing. Acknowledge immediately after a successful PUT;
// only polls started after the command may reconcile its result.
async function handleBotCommand(symbol: string, patch: { enabled?: boolean; budget?: number }, client?: WebSocket, requestId?: string) {
  let ok = false;
  try {
    ok = await botCommands.run(symbol, async () => {
      const market = trackedMarkets.find((m) => m.symbol === symbol);
      if (!market) return false;
      const prev = lastBotStatusBySymbol.get(symbol);
      const desired = {
        enabled: patch.enabled ?? prev?.enabled ?? false,
        budget: patch.budget ?? prev?.budget ?? BUDGET_MIN,
      };
      const ok = await putBotConfig(market.seriesTicker, desired);
      if (!ok) return false;
      const next: BotStatus = {
        quickTrade: prev?.quickTrade,
        swingSupported: prev?.swingSupported ?? false,
        swingEnabled: prev?.swingEnabled ?? false,
        enabled: desired.enabled,
        budget: Math.min(BUDGET_MAX, Math.max(BUDGET_MIN, Math.round(desired.budget))),
        allocation: prev?.allocation ?? null,
        flipPotential: prev?.flipPotential ?? null,
      };
      lastBotStatusBySymbol.set(symbol, next);
      broadcast(botStatusMessage(symbol, next));
      // Confirm order removal promptly after a manual stop; never infer it
      // merely from the config acknowledgement.
      if (patch.enabled === false) void pollPortfolio();
      return true;
    });
  } catch (error) { console.warn("[bot-control] Command failed", error); }
  if (requestId && client?.readyState === WebSocket.OPEN) {
    client.send(JSON.stringify({ type: "botCommandResult", symbol, requestId, ok,
      error: ok ? undefined : "LIVE change was not confirmed. Check the bot state before retrying." }));
  }
}

const swingUpdates = new Set<string>();
const quickUpdates = new Set<string>();
async function handleQuickTrade(client: WebSocket, symbol: string, order: QuickOrder, cancelRestingBuy: boolean) {
  const reply = (ok: boolean, queued = false, error?: string) => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: "quickTradeResult", symbol, requestId: order.request_id, ok, queued, error }));
  };
  if (quickUpdates.has(symbol)) { reply(false, false, "A quick-trade request is already being sent."); return; }
  quickUpdates.add(symbol);
  try {
    if (order.action !== "sell") throw new Error("Manual buying is disabled. Use LIVE for entries.");
    const market = trackedMarkets.find(m => m.symbol === symbol);
    if (!market) throw new Error("Unknown market.");
    const status = (await fetchBotEvents())?.get(market.seriesTicker);
    const validated = validateQuickOrder(status?.quickTrade, order, cancelRestingBuy);
    const result = await postQuickOrder(market.seriesTicker, validated);
    reply(true, result.queued);
    void pollBotStatus();
  } catch (error) {
    console.warn("[quick-trade] request failed", { symbol, requestId: order.request_id, action: order.action, error: (error as Error).message });
    reply(false, false, (error as Error).message);
  } finally { quickUpdates.delete(symbol); }
}

async function handleSwingCommand(client: WebSocket, symbol: string, enabled: boolean, requestId: string) {
  const reply = (error?: string) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: "swingResult", requestId, symbol, ok: !error, error }));
    }
  };
  const market = trackedMarkets.find((m) => m.symbol === symbol);
  if (!market || !["USDJPY", "GBPUSD", "EURUSD"].includes(symbol)) {
    reply("FX Swing is only available for forex markets.");
    return;
  }
  if (swingUpdates.has(symbol)) { reply("A Swing update is already in progress."); return; }
  swingUpdates.add(symbol);
  try {
    const current = (await fetchBotEvents())?.get(market.seriesTicker);
    if (!current?.swingSupported) { reply("FX Swing is unavailable. Try again shortly."); return; }
    if (!await putBotSwing(market.seriesTicker, enabled)) {
      reply("Could not update FX Swing. Please try again.");
      return;
    }
    const confirmed = (await fetchBotEvents())?.get(market.seriesTicker);
    if (!confirmed) { reply("Update sent; waiting for the bot to confirm its state."); return; }
    lastBotStatusBySymbol.set(symbol, confirmed);
    broadcast(botStatusMessage(symbol, confirmed));
    reply(confirmed.swingEnabled === enabled ? undefined : "The bot has not confirmed the requested Swing mode yet.");
  } finally {
    swingUpdates.delete(symbol);
  }
}

async function seedTodaysPnl() {
  try {
    const since = getPnlSince();
    const bySeries = await fetchTodaysRealizedPnlBySeries(since);
    for (const market of trackedMarkets) {
      const seed = bySeries.get(market.seriesTicker);
      if (seed) {
        market.pnl.add(seed);
        broadcast(pnlMessage(market.symbol, market.pnl, market.pendingRealizedDollars));
      }
    }
    console.log(`[pnl] seeded realized P&L since ${since.toISOString()}:`, Object.fromEntries(bySeries));
  } catch (err) {
    console.error("[pnl] failed to seed today's P&L:", (err as Error).message);
  }
}
seedTodaysPnl();

// Every settlement since whichever is more recent: local midnight, or the
// last manual reset — so a reset actually zeroes this (not just each card's
// own total), but it still auto-resets on a new calendar day even if never
// manually reset.
let accountPnlDollars = 0;
const ACCOUNT_PNL_POLL_MS = 30_000;

function accountPnlSince(): Date {
  const manual = getPnlSince().getTime();
  const midnight = startOfLocalDay(new Date()).getTime();
  return new Date(Math.max(manual, midnight));
}

// A manual reset triggers this out of band from its own 30s interval tick.
// A plain in-flight guard wasn't enough: if a call was already in flight
// (started with the pre-reset boundary) when reset fired, the guard just
// skipped the reset's own call entirely, and the stale in-flight one still
// won once it resolved. accountPnlEpoch discards a result computed with a
// boundary that's since been superseded; accountPnlRerunRequested makes
// sure a fresh call actually runs immediately once the stale one clears,
// instead of waiting up to 30s for the next scheduled tick.
let accountPnlPollInFlight = false;
let accountPnlEpoch = 0;
let accountPnlRerunRequested = false;

async function pollAccountPnl() {
  if (accountPnlPollInFlight) {
    accountPnlRerunRequested = true;
    return;
  }
  accountPnlPollInFlight = true;
  const epoch = accountPnlEpoch;
  try {
    const total = await fetchTodaysRealizedPnlTotal(accountPnlSince());
    if (epoch === accountPnlEpoch && total !== accountPnlDollars) {
      accountPnlDollars = total;
      broadcast({ type: "accountPnl", dollars: accountPnlDollars });
    }
  } catch (err) {
    console.error("[pnl] failed to poll account-wide P&L:", (err as Error).message);
  } finally {
    accountPnlPollInFlight = false;
    if (accountPnlRerunRequested) {
      accountPnlRerunRequested = false;
      void pollAccountPnl();
    }
  }
}
pollAccountPnl();
setInterval(pollAccountPnl, ACCOUNT_PNL_POLL_MS);

function promoteForAccountEvent(ticker: string) {
  const upcoming = trackedMarkets.find(m => m.nextKnown?.ticker === ticker);
  if (upcoming?.nextKnown && upcoming.nextKnown.openTime <= Date.now()) {
    applyMarketSwitch(upcoming, upcoming.nextKnown);
    void prepareNextMarket(upcoming);
  }
}

function publishOrderUpdate(update: OrderUpdate) {
  const previous = orderDetails.get(update.orderId);
  if (previous && ["canceled", "executed"].includes(previous.status ?? "") && update.resting) return;
  const order = { ...update, yes: update.yes ?? previous?.yes, time: update.time ?? previous?.time };
  if (JSON.stringify(previous) === JSON.stringify(order)) return;
  orderDetails.set(order.orderId, order);
  for (const [id, old] of orderDetails) {
    if (!old.resting && (old.time ?? 0) < Date.now() / 1000 - 1800) orderDetails.delete(id);
  }
  livePortfolio.order(order.orderId, order.ticker, order.resting);
  lastPortfolio = livePortfolio.snapshot;
  promoteForAccountEvent(order.ticker);
  const market = trackedMarkets.find(m => m.active?.ticker === order.ticker);
  if (market) {
    broadcast({ type: "orderEvent", symbol: market.symbol, ...order });
    broadcast(orderStatusMessage(market.symbol, order.ticker, lastPortfolio));
  }
}

const fillsFeed = new KalshiFillsFeed(
  ({ ticker, intent, side, priceCents, postPositionFp }) => {
    promoteForAccountEvent(ticker);
    const market = trackedMarkets.find(
      (m) => m.active?.ticker === ticker || m.previousTicker === ticker
    );
    broadcast({
      type: "debugFillSignal",
      ticker,
      symbol: market?.symbol ?? null,
      intent: intent ?? null,
      side: side ?? null,
      priceCents: priceCents ?? null,
    });
    if (!market) {
      console.warn(`[fills] ${ticker} doesn't match any tracked market's active ticker`);
      return;
    }
    if (postPositionFp !== undefined && market.active?.ticker === ticker) {
      livePortfolio.position(ticker, postPositionFp !== 0);
      lastPortfolio = livePortfolio.snapshot;
      broadcast(orderStatusMessage(market.symbol, ticker, lastPortfolio));
    }
    // Diagnostic only — buy-in UI treatment comes from the position-update
    // handler below instead (order tag isn't trustworthy, see above).
    console.log(`[fills] ${market.symbol} fill: tag=${intent ?? "?"} ${side ?? "?"} @ ${priceCents ?? "?"}c`);
  },
  (update: PositionUpdate) => {
    promoteForAccountEvent(update.ticker);
    const activeMarket = trackedMarkets.find((m) => m.active?.ticker === update.ticker);
    // A trade closing right at rollover can land after market.active has
    // already moved on — falling back to previousTicker still credits that
    // win. Never used to update the live position display, only to credit
    // a win — the new window's position must not be stomped.
    const market = activeMarket ?? trackedMarkets.find((m) => m.previousTicker === update.ticker);
    const isFirstThisConnection = !seenTickersThisConnection.has(update.ticker);
    seenTickersThisConnection.add(update.ticker);

    const prevRealized = lastRealizedPnlByTicker.get(update.ticker) ?? 0;
    const realizedDelta = update.realizedPnlDollars - prevRealized;
    lastRealizedPnlByTicker.set(update.ticker, update.realizedPnlDollars);
    const newMagnitude = Math.abs(update.positionFp);
    const prevMagnitude = lastPositionMagnitudeByTicker.get(update.ticker) ?? 0;
    const magnitudeDelta = newMagnitude - prevMagnitude;
    lastPositionMagnitudeByTicker.set(update.ticker, newMagnitude);
    broadcast({
      type: "debugFillTrace",
      ticker: update.ticker,
      symbol: market?.symbol ?? null,
      positionFp: update.positionFp,
      costDollars: update.costDollars,
      realizedPnlDollars: update.realizedPnlDollars,
      prevRealized,
      realizedDelta,
      prevMagnitude,
      magnitudeDelta,
      isFirstThisConnection,
    });
    if (!market) return;
    // Only the active-ticker match drives the live position display — a
    // previousTicker match is a late closeout that must not stomp the new window.
    if (activeMarket) {
      market.position =
        update.positionFp === 0
          ? null
          : { positionFp: update.positionFp, costDollars: update.costDollars };
      broadcast(positionMessage(market.symbol, market.active ? market.position : null, market.active?.ticker ?? null));
      livePortfolio.position(update.ticker, update.positionFp !== 0);
      lastPortfolio = livePortfolio.snapshot;
      broadcast(orderStatusMessage(market.symbol, update.ticker, lastPortfolio));
    }
    // First observation per ticker just seeds the baseline — see
    // seenTickersThisConnection above.
    if (isFirstThisConnection) return;
    // Position grew — a real entry, whatever the fill was tagged. Only
    // meaningful for the active window. The client (useMarket.ts) decides
    // whether this is a fresh position's first fill worth a chart marker.
    if (activeMarket && magnitudeDelta > 0.001) {
      console.log(`[fills] broadcasting fillEvent ${market.symbol} entry`);
      broadcast({ type: "fillEvent", symbol: market.symbol, ticker: update.ticker, intent: "entry" });
    }
    if (activeMarket && magnitudeDelta < -0.001) {
      broadcast({ type: "fillEvent", symbol: market.symbol, ticker: update.ticker, intent: "exit" });
    }
    // A mid-window flip that reopens a new position still counts as a win
    // here — the closed leg genuinely banked profit. realizedDelta alone
    // isn't enough of a guard — a stray realized_pnl republish can nudge
    // the number with no position ever open, which used to fire a false
    // win. Requiring prevMagnitude > 0 means a win only fires for an actual close.
    if (realizedDelta > 0.001) {
      if (prevMagnitude > 0.001) {
        queueWin(update.ticker, market.symbol, realizedDelta);
        // Only for the active window — a late close on an already-rolled-
        // over window is captured by that window's own settleClosedWindow
        // fetch instead, so adding it here too would double-count it.
        if (activeMarket) {
          market.pendingRealizedDollars += realizedDelta;
          broadcast(pnlMessage(market.symbol, market.pnl, market.pendingRealizedDollars));
        }
      } else {
        console.warn(
          `[fills] ${market.symbol} ${update.ticker} realized PnL bumped +$${realizedDelta.toFixed(4)} with no tracked open position — suppressing false win`
        );
      }
    }
  },
  () => {
    seenTickersThisConnection.clear();
    void pollPortfolio();
  },
  publishOrderUpdate
);
fillsFeed.start();

startBtcSpotFeed((dollars) => {
  lastBtcSpotDollars = dollars;
  broadcast(spotMessage("BTC", dollars));
});

console.log(`[multibot] local WS server listening on :${config.localWsPort}`);
