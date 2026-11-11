// Reconstructs a canonical BTC 15m trade list from real account history:
// orders (placement + fill lifecycle), fills (exact fill time/price/fee),
// and settlements (final result for anything held to expiry). Read-only —
// pulls nothing live, just joins the already-pulled JSON dumps.
//
// Exit mechanics, reverse-engineered from real order/fill data: this bot
// does NOT sell the held side directly. "scalpexyes*" closes a YES-entry
// leg by buying NO cheap; "scalpexno*" closes a NO-entry leg by buying YES
// cheap — 1 YES + 1 NO always settles for a guaranteed $1, so this is a
// lock-in, not a literal sell. That's mathematically equivalent to selling
// the held side at (100 - opposite price), which is exactly the held
// side's own price column on that same exit fill. Any quantity never
// covered by a lock-in fill rides to settlement for its own $1-or-$0
// payout.
//
// A window where both sides got entered (a deliberate straddle — buy both
// cheap, sell whichever wins) produces two independent legs here, each
// scoped to its own matching exit fills (scalpexyes* only ever closes the
// yes leg, scalpexno* only the no leg), so there's no ambiguity in
// attributing exits even when both sides are live at once.
import { readFileSync, writeFileSync } from "node:fs";
import { config } from "../server/config.ts";
import { accountExportPath, accountReportPath } from "./privateData.ts";

type Order = {
  ticker: string;
  client_order_id: string;
  order_id: string;
  action: string;
  side: string;
  outcome_side?: string;
  status: string;
  created_time: string;
  last_update_time: string;
  yes_price_dollars: string;
  no_price_dollars: string;
  fill_count_fp: string;
};

type Fill = {
  ticker: string;
  order_id: string;
  action: string;
  side: string;
  outcome_side: string;
  yes_price_dollars: string;
  no_price_dollars: string;
  count_fp: string;
  fee_cost: string;
  created_time: string;
};

type Settlement = {
  ticker: string;
  market_result: "yes" | "no" | "";
  yes_count_fp: string;
  no_count_fp: string;
  fee_cost?: string;
  settled_time: string;
};

function loadJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

async function getJson(path: string, query = ""): Promise<any> {
  const res = await fetch(`${config.restBaseUrl}${path}${query}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} ${res.status} ${text}`);
  return JSON.parse(text);
}

async function fetchMarketMeta(tickers: string[]): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  const CHUNK = 40;
  for (let i = 0; i < tickers.length; i += CHUNK) {
    const chunk = tickers.slice(i, i + CHUNK);
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const body = await getJson("/trade-api/v2/markets", `?tickers=${chunk.join(",")}`);
        for (const m of body.markets ?? []) out.set(m.ticker, m);
        break;
      } catch (e: any) {
        if (attempt === 4) throw e;
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    if (i % 400 === 0) console.log(`  market meta: ${Math.min(i + CHUNK, tickers.length)}/${tickers.length}`);
  }
  return out;
}

async function main() {
  const orders: Order[] = loadJson(accountExportPath("btc-orders-full.json")).filter((o: Order) =>
    o.ticker?.startsWith("KXBTC15M")
  );
  const fills: Fill[] = loadJson(accountExportPath("all-fills.json")).filter((f: Fill) =>
    f.ticker?.startsWith("KXBTC15M")
  );
  const settlements: Settlement[] = loadJson(accountExportPath("all-settlements.json")).filter((s: Settlement) =>
    s.ticker?.startsWith("KXBTC15M")
  );
  console.log(`orders: ${orders.length}, fills: ${fills.length}, settlements: ${settlements.length}`);

  const fillsByOrderId = new Map<string, Fill[]>();
  for (const f of fills) {
    if (!fillsByOrderId.has(f.order_id)) fillsByOrderId.set(f.order_id, []);
    fillsByOrderId.get(f.order_id)!.push(f);
  }
  const settlementByTicker = new Map<string, Settlement>();
  for (const s of settlements) settlementByTicker.set(s.ticker, s);

  const entryOrders = orders.filter(
    (o) => o.status === "executed" && /^(scalpyes|scalpno)-/.test(o.client_order_id ?? "")
  );
  const exitOrders = orders.filter(
    (o) => o.status === "executed" && /^scalpex(yes|no)\d/.test(o.client_order_id ?? "")
  );
  console.log(`executed entry legs: ${entryOrders.length}, executed exit/hedge legs: ${exitOrders.length}`);

  // ticker -> side -> entry order legs (usually 1, occasionally split across
  // a couple of orders if the fill happened in pieces)
  const entryLegsByTicker = new Map<string, Map<"yes" | "no", Order[]>>();
  for (const o of entryOrders) {
    const side: "yes" | "no" = o.client_order_id!.startsWith("scalpyes") ? "yes" : "no";
    if (!entryLegsByTicker.has(o.ticker)) entryLegsByTicker.set(o.ticker, new Map());
    const bySide = entryLegsByTicker.get(o.ticker)!;
    if (!bySide.has(side)) bySide.set(side, []);
    bySide.get(side)!.push(o);
  }

  // "scalpexyes*" closes a YES-entry leg (it acquires NO to pair against the
  // held YES; the fill's own yes_price_dollars is the effective sale price
  // of that held YES). "scalpexno*" closes a NO-entry leg the same way,
  // using no_price_dollars. A window where both sides were entered (a
  // deliberate straddle — buy both cheap, sell whichever wins) has BOTH
  // kinds of exit fills present; keying by ticker+closingSide instead of
  // just ticker keeps each leg's exits scoped to that leg only, so this
  // case doesn't need to be thrown out.
  const exitFillsByKey = new Map<
    string,
    Array<{ time: string; priceCents: number; qty: number; fee: number }>
  >();
  for (const o of exitOrders) {
    const closingSide: "yes" | "no" = o.client_order_id!.startsWith("scalpexyes") ? "yes" : "no";
    const key = `${o.ticker}|${closingSide}`;
    const fillsForOrder = fillsByOrderId.get(o.order_id) ?? [];
    const priceOf = (yesPrice: string, noPrice: string) =>
      Math.round(parseFloat(closingSide === "yes" ? yesPrice : noPrice) * 10000) / 100;
    const rows = fillsForOrder.length > 0
      ? fillsForOrder.map((f) => ({
          time: f.created_time,
          priceCents: priceOf(f.yes_price_dollars, f.no_price_dollars),
          qty: parseFloat(f.count_fp),
          fee: parseFloat(f.fee_cost || "0"),
        }))
      : [
          {
            time: o.last_update_time,
            priceCents: priceOf(o.yes_price_dollars, o.no_price_dollars),
            qty: parseFloat(o.fill_count_fp),
            fee: 0,
          },
        ];
    if (!exitFillsByKey.has(key)) exitFillsByKey.set(key, []);
    exitFillsByKey.get(key)!.push(...rows);
  }
  for (const rows of exitFillsByKey.values()) rows.sort((a, b) => a.time.localeCompare(b.time));

  const uniqueTickers = [...entryLegsByTicker.keys()];
  console.log(`unique tickers with an entry: ${uniqueTickers.length}. Fetching market metadata...`);
  const meta = await fetchMarketMeta(uniqueTickers);
  console.log(`got metadata for ${meta.size} tickers`);

  const trades: any[] = [];

  for (const [ticker, bySide] of entryLegsByTicker) {
    const m = meta.get(ticker);
    if (!m) {
      console.warn(`  no market metadata for ${ticker}, skipping`);
      continue;
    }
    const strike = m.floor_strike ?? m.cap_strike ?? null;
    const closeTime = m.close_time;
    const openTime = m.open_time;
    const settlement = settlementByTicker.get(ticker);
    const isDual = bySide.size > 1;

    for (const [side, legs] of bySide) {
      legs.sort((a, b) => a.created_time.localeCompare(b.created_time));
      const fillsForLegs = legs.flatMap((l) => fillsByOrderId.get(l.order_id) ?? []);
      const totalCount = fillsForLegs.length > 0
        ? fillsForLegs.reduce((s, f) => s + parseFloat(f.count_fp), 0)
        : legs.reduce((s, l) => s + parseFloat(l.fill_count_fp), 0);
      const entryFeeDollars = fillsForLegs.reduce((s, f) => s + parseFloat(f.fee_cost || "0"), 0);
      const weightedPriceCents = fillsForLegs.length > 0
        ? fillsForLegs.reduce(
            (s, f) => s + parseFloat(side === "yes" ? f.yes_price_dollars : f.no_price_dollars) * 100 * parseFloat(f.count_fp),
            0
          ) / totalCount
        : parseFloat(side === "yes" ? legs[0].yes_price_dollars : legs[0].no_price_dollars) * 100;
      const allFillTimes = fillsForLegs.map((f) => f.created_time).sort();
      const firstOrderPlacedTime = legs[0].created_time;
      const entryFillTime = allFillTimes[allFillTimes.length - 1] ?? legs[legs.length - 1].last_update_time;
      const entryCostDollars = (weightedPriceCents / 100) * totalCount;

      // Consume ladder/hedge fills sequentially against this leg's size —
      // scoped to exits that close *this* side specifically, so a straddle
      // (both sides entered) doesn't double-count an exit fill against
      // both legs.
      const rungs = exitFillsByKey.get(`${ticker}|${side}`) ?? [];
      let remaining = totalCount;
      let lockedProceeds = 0;
      let exitFeeDollars = 0;
      let lastLockTime: string | null = null;
      let anyLockFills = false;
      for (const r of rungs) {
        if (remaining <= 1e-6) break;
        const take = Math.min(r.qty, remaining);
        lockedProceeds += (r.priceCents / 100) * take;
        // Attribute fee proportionally to the portion of this fill consumed.
        exitFeeDollars += r.fee * (take / r.qty);
        remaining -= take;
        lastLockTime = r.time;
        anyLockFills = true;
      }

      let exitReason: "take_profit_exit" | "partial_exit_plus_settlement" | "settlement";
      let remainderPayout = 0;
      let settlementFeeDollars = 0;
      if (remaining > 1e-6) {
        if (!settlement) {
          // Position not fully locked in and no settlement record found —
          // most likely the window hasn't settled yet (still open/recent).
          continue;
        }
        const won = settlement.market_result === side;
        remainderPayout = won ? remaining * 1.0 : 0;
        settlementFeeDollars = parseFloat(settlement.fee_cost ?? "0");
        exitReason = anyLockFills ? "partial_exit_plus_settlement" : "settlement";
      } else {
        exitReason = "take_profit_exit";
      }

      const pnlDollars =
        lockedProceeds + remainderPayout - entryCostDollars - entryFeeDollars - exitFeeDollars - settlementFeeDollars;
      const outcome: "win" | "loss" = pnlDollars > 0 ? "win" : "loss";

      const closeTs = new Date(closeTime).getTime();
      const openTs = new Date(openTime).getTime();
      const entryTs = new Date(entryFillTime).getTime();

      const row = {
        ticker,
        side,
        strike,
        strikeType: m.strike_type,
        openTime,
        closeTime,
        orderPlacedTime: firstOrderPlacedTime,
        entryFillTime,
        entryPriceCents: Math.round(weightedPriceCents * 100) / 100,
        entryCountContracts: totalCount,
        entryFeeDollars: Math.round(entryFeeDollars * 1e6) / 1e6,
        exitReason,
        exitedQtyLocked: Math.round((totalCount - remaining) * 100) / 100,
        remainderQty: Math.round(remaining * 100) / 100,
        lockedProceedsDollars: Math.round(lockedProceeds * 1e6) / 1e6,
        exitFeeDollars: Math.round(exitFeeDollars * 1e6) / 1e6,
        lastLockTime,
        remainderPayoutDollars: Math.round(remainderPayout * 1e6) / 1e6,
        settlementFeeDollars: Math.round(settlementFeeDollars * 1e6) / 1e6,
        minutesRemainingAtEntry: (closeTs - entryTs) / 60000,
        minutesElapsedAtEntry: (entryTs - openTs) / 60000,
        outcome,
        pnlDollars: Math.round(pnlDollars * 1e6) / 1e6,
        numEntryOrderLegs: legs.length,
        // Both yes and no were entered in this window (a deliberate
        // straddle) — each leg is still its own independent trade here.
        dualSided: isDual,
      };

      trades.push(row);
    }
  }

  trades.sort((a, b) => a.entryFillTime.localeCompare(b.entryFillTime));

  const wins = trades.filter((t) => t.outcome === "win");
  const losses = trades.filter((t) => t.outcome === "loss");
  const dualLegs = trades.filter((t) => t.dualSided).length;
  console.log(`\nTrades (one row per entry leg): ${trades.length}`);
  console.log(`Wins: ${wins.length}, Losses: ${losses.length}`);
  console.log(`Net P&L: $${trades.reduce((s, t) => s + t.pnlDollars, 0).toFixed(2)}`);
  console.log(`Legs from a dual-sided (straddle) window: ${dualLegs}`);
  const byReason: Record<string, number> = {};
  for (const t of trades) byReason[t.exitReason] = (byReason[t.exitReason] ?? 0) + 1;
  console.log("By exit reason:", byReason);
  const entryPrices = trades.map((t) => t.entryPriceCents).sort((a, b) => a - b);
  console.log(
    `Entry price range: min=${entryPrices[0]}c, median=${entryPrices[Math.floor(entryPrices.length / 2)]}c, max=${entryPrices[entryPrices.length - 1]}c`
  );

  writeFileSync(accountReportPath("btc_trades_clean.json"), JSON.stringify(trades, null, 2));
  console.log("Saved private BTC trade report");
}

main();
