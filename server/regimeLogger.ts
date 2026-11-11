// Standalone tick-level data logger for backtesting — read-only, never
// places or modifies an order. Run with `npx tsx server/regimeLogger.ts`,
// appends JSONL rows to logs/regime-YYYY-MM-DD.jsonl.
import { appendFileSync, mkdirSync } from "node:fs";
import WebSocket from "ws";
import { signRequest } from "./kalshiAuth.ts";
import { config } from "./config.ts";
import { findCurrentMarket, findNextMarket, type CurrentMarket } from "./findMarket.ts";

const LOG_DIR = "logs";
mkdirSync(LOG_DIR, { recursive: true });

function logRow(row: Record<string, unknown>) {
  const day = new Date().toISOString().slice(0, 10);
  appendFileSync(`${LOG_DIR}/regime-${day}.jsonl`, JSON.stringify({ ts: Date.now() / 1000, ...row }) + "\n");
}

// ---- Kalshi ticker feed (public, per-market YES bid ticks) ----
const seriesTicker = process.env.BTC_SERIES_TICKER ?? "KXBTC15M";
let activeTicker: string | null = null;
let activeMarket: CurrentMarket | null = null;

function connectKalshiTicker() {
  const ws = new WebSocket(config.wsUrl, { headers: signRequest("GET", "/trade-api/ws/v2") });
  let nextId = 1;
  const subscribed = new Set<string>();

  function subscribe(ticker: string) {
    if (subscribed.has(ticker)) return;
    subscribed.add(ticker);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ id: nextId++, cmd: "subscribe", params: { channels: ["ticker"], market_tickers: [ticker] } }));
    }
  }

  ws.on("open", () => {
    if (activeTicker) subscribe(activeTicker);
  });
  ws.on("message", (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type !== "ticker") return;
    if (msg.msg?.market_ticker !== activeTicker) return;
    if (typeof msg.msg.yes_bid_dollars !== "string") return;
    logRow({ type: "kalshi_tick", ticker: activeTicker, yesBidCents: Math.round(parseFloat(msg.msg.yes_bid_dollars) * 100) });
  });
  ws.on("close", () => setTimeout(connectKalshiTicker, 3000));
  ws.on("error", (e) => console.error("[regime-logger] kalshi ticker ws error:", e.message));

  (globalThis as any).__kalshiTickerSubscribe = subscribe;
}

async function pollMarketRollover() {
  try {
    const found = await findCurrentMarket(seriesTicker);
    if (found && found.ticker !== activeTicker) {
      activeTicker = found.ticker;
      activeMarket = found;
      (globalThis as any).__kalshiTickerSubscribe?.(found.ticker);
      const meta = await fetch(`${config.restBaseUrl}/trade-api/v2/markets?tickers=${found.ticker}`).then((r) => r.json());
      const m = meta.markets?.[0];
      logRow({
        type: "market",
        ticker: found.ticker,
        strike: m?.floor_strike ?? m?.cap_strike ?? null,
        strikeType: m?.strike_type ?? null,
        openTime: found.openTime,
        closeTime: found.closeTime,
      });
      console.log(`[regime-logger] rolled over to ${found.ticker}`);
    }
  } catch (e: any) {
    console.error("[regime-logger] rollover poll failed:", e.message);
  }
}

// ---- Kraken public WS: tick-level BTC/USD trades ----
function connectKraken() {
  const ws = new WebSocket("wss://ws.kraken.com/v2");
  ws.on("open", () => {
    ws.send(JSON.stringify({ method: "subscribe", params: { channel: "trade", symbol: ["BTC/USD"] } }));
  });
  ws.on("message", (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.channel !== "trade" || !Array.isArray(msg.data)) return;
    for (const t of msg.data) {
      if (typeof t.price === "number") logRow({ type: "btc_tick", price: t.price });
    }
  });
  ws.on("close", () => setTimeout(connectKraken, 3000));
  ws.on("error", (e) => console.error("[regime-logger] kraken ws error:", e.message));
}

// ---- Kalshi private fill feed (raw, undeduped — every fill logged) ----
function connectKalshiFills() {
  const ws = new WebSocket(config.wsUrl, { headers: signRequest("GET", "/trade-api/ws/v2") });
  let nextId = 1;
  ws.on("open", () => {
    ws.send(JSON.stringify({ id: nextId++, cmd: "subscribe", params: { channels: ["fill"] } }));
  });
  ws.on("message", (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type !== "fill") return;
    const ticker = msg.msg?.market_ticker;
    if (typeof ticker !== "string" || !ticker.startsWith(seriesTicker)) return;
    const side = msg.msg?.purchased_side;
    const yesPriceCents = Math.round(parseFloat(msg.msg?.yes_price_dollars) * 100);
    logRow({
      type: "fill",
      ticker,
      clientOrderId: msg.msg?.client_order_id,
      side,
      priceCents: side === "no" ? 100 - yesPriceCents : yesPriceCents,
      countFp: msg.msg?.count,
      isTaker: msg.msg?.is_taker,
    });
  });
  ws.on("close", () => setTimeout(connectKalshiFills, 3000));
  ws.on("error", (e) => console.error("[regime-logger] kalshi fills ws error:", e.message));
}

// ---- Order placements: no push channel exists, so poll and log anything new ----
const seenOrderIds = new Set<string>();
async function pollNewOrders() {
  try {
    const headers = { ...signRequest("GET", "/trade-api/v2/portfolio/orders"), Accept: "application/json" };
    const res = await fetch(`${config.restBaseUrl}/trade-api/v2/portfolio/orders?limit=50`, { headers });
    const body = await res.json();
    for (const o of body.orders ?? []) {
      if (!o.ticker?.startsWith(seriesTicker)) continue;
      if (seenOrderIds.has(o.order_id)) continue;
      seenOrderIds.add(o.order_id);
      logRow({
        type: "order_placed",
        ticker: o.ticker,
        clientOrderId: o.client_order_id,
        side: o.side,
        priceCents: Math.round(parseFloat(o.side === "no" ? o.no_price_dollars : o.yes_price_dollars) * 100),
      });
    }
    if (seenOrderIds.size > 5000) seenOrderIds.clear();
  } catch (e: any) {
    console.error("[regime-logger] order poll failed:", e.message);
  }
}

connectKalshiTicker();
connectKraken();
connectKalshiFills();
pollMarketRollover();
setInterval(pollMarketRollover, 15_000);
setInterval(pollNewOrders, 5_000);

console.log("[regime-logger] running — logging to logs/regime-*.jsonl, no orders ever placed or modified");
