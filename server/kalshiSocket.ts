import WebSocket from "ws";
import { signRequest } from "./kalshiAuth.ts";
import { config } from "./config.ts";

type PriceCallback = (prices: { yes: number; ticker: string; time: number; breakBefore: boolean }) => void;

const WS_PATH = "/trade-api/ws/v2";
const RECONNECT_DELAY_MS = 3000;
// Kalshi has no per-ticker unsubscribe, so once a feed accumulates this many
// warm (subscribed-but-not-active) tickers, drop the whole subscription and
// re-subscribe to just the active one.
const PRUNE_THRESHOLD = 4;

function dollarsToCents(dollars: string): number {
  return Math.round(parseFloat(dollars) * 100);
}

// One WebSocket per market, subscribed to Kalshi's public `ticker` channel,
// reporting the YES bid for whichever ticker is currently "active" via
// promote(). ensureSubscribed() can be called before a market even opens,
// so the caller pre-subscribes the next window ahead of time and calls
// promote() right at the close boundary, with no subscribe round-trip on
// the critical path.
//
// `orderbook_delta` (genuine tick-by-tick) was tried twice — only the first
// ~5 subscribed tickers ever received data regardless of connection count,
// likely an account-wide subscription cap. Reverted to `ticker` for
// reliability across all tracked markets.
export class KalshiFeed {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private onPrice: PriceCallback;
  private closedByCaller = false;
  private subscribedTickers = new Set<string>();
  private activeTicker: string | null = null;
  private lastTickTime = 0;
  private linkBroken = true;
  private warmTicks = new Map<string, Array<{ yes: number; time: number }>>();
  // Kalshi's unsubscribe takes subscription IDs, not channel names — sids
  // returned by each "subscribed" ack, tracked so prune() can actually
  // unsubscribe instead of sending a request the server rejects.
  private subscriptionSids = new Set<number>();

  // label is for diagnostic logging only (which market this socket is for)
  // — never read to decide behavior.
  constructor(onPrice: PriceCallback, private label = "?") {
    this.onPrice = onPrice;
  }

  start() {
    this.connect();
  }

  stop() {
    this.closedByCaller = true;
    this.ws?.close();
  }

  ensureSubscribed(ticker: string) {
    if (this.subscribedTickers.has(ticker)) return;
    // Prune while preparing the next window, never on its opening tick.
    if (this.subscribedTickers.size >= PRUNE_THRESHOLD) this.prune();
    this.subscribedTickers.add(ticker);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({
        id: this.nextId++,
        cmd: "subscribe",
        params: { channels: ["ticker"], market_tickers: [ticker] },
      });
    }
  }

  // Keep opening ticks received before the boundary sweep, but never replay
  // pre-open quotes as if they were trades in the new window.
  promote(ticker: string, openTime = Infinity) {
    this.ensureSubscribed(ticker);
    if (this.activeTicker !== ticker) this.lastTickTime = 0;
    this.activeTicker = ticker;
    const buffered = this.warmTicks.get(ticker) ?? [];
    this.warmTicks.delete(ticker);
    for (const tick of buffered) {
      if (tick.time < openTime || tick.time < this.lastTickTime) continue;
      this.lastTickTime = tick.time;
      this.onPrice({ ...tick, ticker, breakBefore: this.linkBroken });
      this.linkBroken = false;
    }
  }

  // Call when a series has no current/upcoming window — stops forwarding
  // the last closed ticker's late ticks (which swing hard as it settles)
  // as if they were live data.
  pause() {
    this.activeTicker = null;
  }

  private prune() {
    const keep = this.activeTicker ? [this.activeTicker] : [];
    this.subscribedTickers = new Set();
    this.warmTicks.clear();
    if (this.ws?.readyState === WebSocket.OPEN && this.subscriptionSids.size > 0) {
      this.send({ id: this.nextId++, cmd: "unsubscribe", params: { sids: [...this.subscriptionSids] } });
    }
    this.subscriptionSids = new Set();
    for (const ticker of keep) this.ensureSubscribed(ticker);
  }

  private connect() {
    const headers = signRequest("GET", WS_PATH);
    const ws = new WebSocket(`${config.wsUrl}`, { headers });
    this.ws = ws;
    const connectStartedAt = Date.now();

    ws.on("open", () => {
      // sids from the old connection are gone with it — this connection's
      // resubscribes will populate fresh ones.
      this.subscriptionSids = new Set();
      for (const ticker of this.subscribedTickers) {
        this.send({
          id: this.nextId++,
          cmd: "subscribe",
          params: { channels: ["ticker"], market_tickers: [ticker] },
        });
      }
    });

    ws.on("message", (raw) => this.handleMessage(raw.toString()));

    // Previously silent — a dropped connection here means this symbol's
    // chart freezes for however long the reconnect takes, with no log
    // trail to confirm or measure it. Logged so "feed cutting out" reports
    // can be checked against actual reconnect frequency instead of guessed at.
    ws.on("close", () => {
      this.linkBroken = true;
      console.warn(`[kalshi-ws] ${this.label} closed after ${Date.now() - connectStartedAt}ms, reconnecting in ${RECONNECT_DELAY_MS}ms`);
      if (!this.closedByCaller) {
        setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
      }
    });

    ws.on("error", (err) => {
      console.error("[kalshi-ws] error:", err.message);
    });
  }

  private send(payload: unknown) {
    this.ws?.send(JSON.stringify(payload));
  }

  private handleMessage(raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case "ticker": {
        const ticker = msg.msg?.market_ticker;
        if (!this.subscribedTickers.has(ticker)) return;
        if (typeof msg.msg.yes_bid_dollars !== "string") return;
        const yes = dollarsToCents(msg.msg.yes_bid_dollars);
        const time = typeof msg.msg.ts_ms === "number" ? msg.msg.ts_ms / 1000
          : typeof msg.msg.ts === "number" ? msg.msg.ts : NaN;
        if (!Number.isFinite(yes) || yes < 0 || yes > 100 || !Number.isFinite(time) ||
            time > Date.now() / 1000 + 5) return;
        if (ticker !== this.activeTicker) {
          const ticks = this.warmTicks.get(ticker) ?? [];
          if (ticks.length && time < ticks[ticks.length - 1]!.time) return;
          ticks.push({ yes, time });
          this.warmTicks.set(ticker, ticks.filter(t => t.time >= time - 5).slice(-256));
          return;
        }
        if (time < this.lastTickTime) return;
        this.lastTickTime = time;
        this.onPrice({ yes, ticker: this.activeTicker!, time, breakBefore: this.linkBroken });
        this.linkBroken = false;
        break;
      }
      case "subscribed": {
        if (typeof msg.msg?.sid === "number") this.subscriptionSids.add(msg.msg.sid);
        break;
      }
      case "error": {
        console.error("[kalshi-ws] server error:", msg.msg);
        break;
      }
    }
  }
}
