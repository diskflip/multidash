import { signRequest } from "./kalshiAuth.ts";
import { config } from "./config.ts";
import { verifyMissingRestingOrders } from "./restingOrders.ts";
import { parseOrderUpdate, type OrderUpdate } from "./kalshiFills.ts";

const BALANCE_PATH = "/trade-api/v2/portfolio/balance";
const ORDERS_PATH = "/trade-api/v2/portfolio/orders";
const POSITIONS_PATH = "/trade-api/v2/portfolio/positions";

// Read-only account snapshot: wallet balance plus which market tickers
// currently have a resting order or an open position. Only ever GETs —
// never places, cancels, or modifies anything.
export type PortfolioSnapshot = {
  balanceCents: number;
  restingTickers: Set<string>;
  holdingTickers: Set<string>;
  restingOrders: Map<string, string>;
  positionBaselines: Map<string, { positionFp: number; realizedPnlDollars: number }>;
};

async function getJson(path: string, query = ""): Promise<any> {
  const headers = { ...signRequest("GET", path), Accept: "application/json" };
  const res = await fetch(`${config.restBaseUrl}${path}${query}`, { headers, signal: AbortSignal.timeout(4000) });
  if (!res.ok) {
    throw new Error(
      `Kalshi portfolio request failed: ${path} ${res.status} ${await res.text()}`
    );
  }
  return res.json();
}

export async function fetchPortfolioSnapshot(previousOrders: ReadonlyMap<string, string> = new Map(), onOrder?: (order: OrderUpdate) => void): Promise<PortfolioSnapshot> {
  const knownOrders = new Map(previousOrders);
  const [balanceBody, ordersBody, positionsBody] = await Promise.all([
    getJson(BALANCE_PATH),
    getJson(ORDERS_PATH, "?status=resting&limit=1000").then(body => {
      // Orders need not wait for wallet, positions, or missing-order lookups.
      for (const order of body.orders ?? []) {
        const update = parseOrderUpdate(order);
        if (update) onOrder?.(update);
      }
      return body;
    }),
    getJson(POSITIONS_PATH, "?limit=1000"),
  ]);

  const restingOrders = await verifyMissingRestingOrders(
    new Map((ordersBody.orders ?? []).map((order: { order_id: string; ticker: string }) => [order.order_id, order.ticker])),
    knownOrders,
    async id => {
      const order = (await getJson(`${ORDERS_PATH}/${encodeURIComponent(id)}`)).order;
      const update = parseOrderUpdate(order);
      if (update && !update.resting) onOrder?.(update);
      return order;
    },
  );
  const restingTickers = new Set(restingOrders.values());

  const holdingTickers = new Set<string>(
    (positionsBody.market_positions ?? [])
      .filter((p: { position_fp: string }) => parseFloat(p.position_fp) !== 0)
      .map((p: { ticker: string }) => p.ticker)
  );

  return {
    balanceCents: balanceBody.balance as number,
    restingTickers,
    holdingTickers,
    restingOrders,
    positionBaselines: new Map((positionsBody.market_positions ?? []).map((position: { ticker: string; position_fp: string; realized_pnl_dollars: string }) =>
      [position.ticker, { positionFp: Number(position.position_fp), realizedPnlDollars: Number(position.realized_pnl_dollars) }])),
  };
}

const SETTLEMENTS_PATH = "/trade-api/v2/portfolio/settlements";

type Settlement = {
  ticker: string;
  yes_count_fp: string;
  yes_total_cost_dollars: string;
  no_count_fp: string;
  no_total_cost_dollars: string;
  fee_cost?: string;
  market_result: "yes" | "no" | "";
  settled_time: string;
};

// Realized P&L for one settled ticker: each held contract pays out $1 if
// its side matches market_result, $0 otherwise.
function realizedPnlFromSettlement(s: Settlement): number {
  const yesCount = parseFloat(s.yes_count_fp);
  const noCount = parseFloat(s.no_count_fp);
  const yesCost = parseFloat(s.yes_total_cost_dollars);
  const noCost = parseFloat(s.no_total_cost_dollars);
  const fee = parseFloat(s.fee_cost ?? "0");

  const payout =
    (s.market_result === "yes" ? yesCount : 0) + (s.market_result === "no" ? noCount : 0);

  return payout - yesCost - noCost - fee;
}

// Returns null if the ticker hasn't settled yet (Kalshi posts settlements a
// few seconds after a market closes — caller should retry shortly after).
export async function fetchTickerRealizedPnl(ticker: string): Promise<number | null> {
  const body = await getJson(SETTLEMENTS_PATH, "?limit=200");
  const settlement = (body.settlements ?? []).find((s: Settlement) => s.ticker === ticker);
  return settlement ? realizedPnlFromSettlement(settlement) : null;
}

function seriesTickerOf(ticker: string): string {
  const m = ticker.match(/^(.+?)-\d{2}[A-Z]{3}\d{2}/);
  return m ? m[1] : ticker;
}

// Every settlement since `since`, regardless of series — unlike the
// per-series map below (which only credits currently-enabled series), this
// matches the real number shown in the Kalshi app/wallet.
export async function fetchTodaysRealizedPnlTotal(since: Date): Promise<number> {
  let total = 0;
  let cursor: string | undefined;

  paging: for (let page = 0; page < 50; page++) {
    const query = `?limit=1000${cursor ? `&cursor=${cursor}` : ""}`;
    const body = await getJson(SETTLEMENTS_PATH, query);
    const batch: Settlement[] = body.settlements ?? [];
    if (batch.length === 0) break;

    for (const s of batch) {
      if (new Date(s.settled_time) < since) break paging;
      total += realizedPnlFromSettlement(s);
    }

    cursor = body.cursor;
    if (!cursor) break;
  }

  return total;
}

// Seeds session P&L on startup from everything settled since `since` (see
// pnlReset.ts), so a process restart doesn't wipe the total to zero.
// Settlements come back newest-first, so paging stops as soon as it walks
// past `since`.
export async function fetchTodaysRealizedPnlBySeries(since: Date): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  let cursor: string | undefined;

  paging: for (let page = 0; page < 50; page++) {
    const query = `?limit=1000${cursor ? `&cursor=${cursor}` : ""}`;
    const body = await getJson(SETTLEMENTS_PATH, query);
    const batch: Settlement[] = body.settlements ?? [];
    if (batch.length === 0) break;

    for (const s of batch) {
      if (new Date(s.settled_time) < since) break paging;
      const series = seriesTickerOf(s.ticker);
      result.set(series, (result.get(series) ?? 0) + realizedPnlFromSettlement(s));
    }

    cursor = body.cursor;
    if (!cursor) break;
  }

  return result;
}
