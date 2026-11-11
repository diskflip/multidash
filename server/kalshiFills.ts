import WebSocket from "ws";
import { signRequest } from "./kalshiAuth.ts";
import { config } from "./config.ts";

const WS_PATH = "/trade-api/ws/v2";
const RECONNECT_DELAY_MS = 3000;

// Kalshi's own `action` field ("buy"/"sell") doesn't reliably distinguish
// entry from exit — a sell of yes and a buy of no can be the same trade.
// Intent instead comes from this bot's own client_order_id convention:
// entries look like "scalpyes-<ticker>-yes-t0600-...", exits look like
// "scalpexyes1-<ticker>-yes-95-...-e0600".
export type FillEvent = {
  ticker: string;
  intent?: "entry" | "exit";
  side?: "yes" | "no";
  priceCents?: number;
  postPositionFp?: number;
};

export type PositionUpdate = {
  ticker: string;
  positionFp: number;
  costDollars: number;
  realizedPnlDollars: number;
};
export type OrderUpdate = { orderId: string; ticker: string; resting: boolean; status?: string; yes?: number; time?: number };

export function parseOrderUpdate(order: any): OrderUpdate | null {
  if (typeof order?.order_id !== 'string' || typeof order?.ticker !== 'string' ||
      !['resting', 'canceled', 'executed'].includes(order.status)) return null;
  const yes = typeof order.yes_price_dollars === 'string' ? Number(order.yes_price_dollars) * 100 : NaN;
  const time = typeof order.created_ts_ms === 'number' ? order.created_ts_ms / 1000 : Date.parse(order.created_time) / 1000;
  return { orderId: order.order_id, ticker: order.ticker, status: order.status,
    resting: order.status === 'resting' && Number(order.remaining_count_fp ?? 1) > 0,
    yes: Number.isFinite(yes) && yes >= 0 && yes <= 100 ? yes : undefined,
    time: Number.isFinite(time) ? time : undefined };
}

function intentFromClientOrderId(clientOrderId: unknown): "entry" | "exit" | undefined {
  if (typeof clientOrderId !== "string") return undefined;
  if (clientOrderId.startsWith("scalpex")) return "exit";
  if (clientOrderId.startsWith("scalpyes") || clientOrderId.startsWith("scalpno")) return "entry";
  return undefined;
}

// Strips the random 8-hex-char per-order suffix from a client_order_id, so
// the same logical entry/exit attempt (which can span multiple partial
// fills across different order ids) collapses to one key.
function stableActionKey(clientOrderId: string): string {
  return clientOrderId
    .split("-")
    .filter((segment) => !/^[0-9a-f]{8}$/.test(segment))
    .join("-");
}

// Account-wide connection to Kalshi's private `fill` and `market_positions`
// channels — both push instantly, faster than the portfolio poll.
export class KalshiFillsFeed {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private onSignal: (event: FillEvent) => void;
  private onPosition: (update: PositionUpdate) => void;
  private onConnect: () => void;
  private closedByCaller = false;
  // Only the first fill for a given stableActionKey signals — later partial
  // fills for the same attempt don't re-trigger.
  private seenActionKeys = new Set<string>();

  constructor(
    onSignal: (event: FillEvent) => void,
    onPosition: (update: PositionUpdate) => void,
    onConnect: () => void,
    private onOrder: (update: OrderUpdate) => void = () => {}
  ) {
    this.onSignal = onSignal;
    this.onPosition = onPosition;
    this.onConnect = onConnect;
  }

  start() {
    this.connect();
  }

  stop() {
    this.closedByCaller = true;
    this.ws?.close();
  }

  private connect() {
    const headers = signRequest("GET", WS_PATH);
    const ws = new WebSocket(`${config.wsUrl}`, { headers });
    this.ws = ws;

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          id: this.nextId++,
          cmd: "subscribe",
          params: { channels: ["fill", "market_positions"] },
        })
      );
      ws.send(JSON.stringify({ id: this.nextId++, cmd: "subscribe", params: { channels: ["user_orders"] } }));
      this.onConnect();
    });

    ws.on("message", (raw) => this.handleMessage(raw.toString()));

    ws.on("close", () => {
      if (!this.closedByCaller) {
        setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
      }
    });

    ws.on("error", (err) => {
      console.error("[kalshi-fills-ws] error:", err.message);
    });
  }

  private handleMessage(raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "error") {
      console.error("[kalshi-fills-ws] server error:", msg.msg);
      return;
    }
    if (msg.type === "subscribed") {
      console.log("[kalshi-fills-ws] subscribed:", raw);
      return;
    }
    if (msg.type === "user_order") {
      const update = parseOrderUpdate(msg.msg);
      if (update) this.onOrder(update);
      return;
    }
    if (msg.type !== "fill" && msg.type !== "market_position" && msg.type !== "market_positions") {
      console.log("[kalshi-fills-ws] unhandled message type:", raw);
      return;
    }

    console.log("[kalshi-fills-ws] signal received:", raw);

    const ticker = msg.msg?.market_ticker ?? msg.msg?.ticker;
    if (typeof ticker !== "string") {
      console.warn("[kalshi-fills-ws] message missing ticker:", raw);
      return;
    }
    if (msg.type === "market_position" || msg.type === "market_positions") {
      const positionFp = parseFloat(msg.msg?.position_fp);
      const costDollars = parseFloat(msg.msg?.position_cost_dollars);
      const realizedPnlDollars = parseFloat(msg.msg?.realized_pnl_dollars);
      if (!Number.isNaN(positionFp) && !Number.isNaN(costDollars)) {
        this.onPosition({
          ticker,
          positionFp,
          costDollars,
          realizedPnlDollars: Number.isNaN(realizedPnlDollars) ? 0 : realizedPnlDollars,
        });
      }
      return;
    }

    const clientOrderId = msg.msg?.client_order_id;
    let intent = intentFromClientOrderId(clientOrderId);
    if (intent !== undefined && typeof clientOrderId === "string") {
      const key = stableActionKey(clientOrderId);
      if (this.seenActionKeys.has(key)) {
        intent = undefined;
      } else {
        this.seenActionKeys.add(key);
      }
    }

    const side: "yes" | "no" | undefined =
      msg.msg?.purchased_side === "yes" || msg.msg?.purchased_side === "no"
        ? msg.msg.purchased_side
        : undefined;
    const yesPriceCents = Math.round(parseFloat(msg.msg?.yes_price_dollars) * 100);
    const priceCents = Number.isFinite(yesPriceCents)
      ? side === "no"
        ? 100 - yesPriceCents
        : yesPriceCents
      : undefined;

    const postPositionFp = parseFloat(msg.msg?.post_position_fp);
    this.onSignal({ ticker, intent, side, priceCents,
      postPositionFp: Number.isFinite(postPositionFp) ? postPositionFp : undefined });
  }
}
