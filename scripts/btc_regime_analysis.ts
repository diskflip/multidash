import { readFileSync, writeFileSync } from "node:fs";
import { accountExportPath, accountReportPath } from "./privateData.ts";

type Fill = {
  ticker: string;
  action: string;
  side: string;
  yes_price_dollars: string;
  no_price_dollars: string;
  count_fp: string;
  created_time: string;
  ts: number;
};

type Settlement = {
  ticker: string;
  market_result: "yes" | "no" | "";
  yes_count_fp: string;
  yes_total_cost_dollars: string;
  no_count_fp: string;
  no_total_cost_dollars: string;
  fee_cost?: string;
  settled_time: string;
};

function realizedPnl(s: Settlement): number {
  const yesCount = parseFloat(s.yes_count_fp);
  const noCount = parseFloat(s.no_count_fp);
  const yesCost = parseFloat(s.yes_total_cost_dollars);
  const noCost = parseFloat(s.no_total_cost_dollars);
  const fee = parseFloat(s.fee_cost ?? "0");
  const payout =
    (s.market_result === "yes" ? yesCount : 0) + (s.market_result === "no" ? noCount : 0);
  return payout - yesCost - noCost - fee;
}

async function getCandles(ticker: string, startTs: number, endTs: number): Promise<any[]> {
  const url = `https://external-api.kalshi.com/trade-api/v2/series/KXBTC15M/markets/${ticker}/candlesticks?start_ts=${startTs}&end_ts=${endTs}&period_interval=1`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url);
    const text = await res.text();
    if (res.ok) return JSON.parse(text).candlesticks ?? [];
    if (res.status === 429 && attempt < 4) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    throw new Error(`${ticker} ${res.status} ${text}`);
  }
  return [];
}

async function main() {
  const fills: Fill[] = JSON.parse(readFileSync(accountExportPath("btc-fills.json"), "utf8")).filter(
    (f: Fill) => f.ticker.startsWith("KXBTC15M")
  );
  const settlements: Settlement[] = JSON.parse(
    readFileSync(accountExportPath("btc-settlements.json"), "utf8")
  ).filter((s: Settlement) => s.ticker.startsWith("KXBTC15M"));

  // Entries show up two ways in this account's fills: a YES-side dip buy
  // (action=buy, side=yes) or a NO-side dip buy, which the exchange logs as
  // action=sell, side=no but always at a fixed cheap no_price (~6c) — not a
  // variable high-price exit. Treat both as entries, keyed by which side.
  const buysByTicker = new Map<string, Fill[]>();
  for (const f of fills) {
    const isYesEntry = f.action === "buy" && f.side === "yes";
    const isNoEntry = f.action === "sell" && f.side === "no";
    if (!isYesEntry && !isNoEntry) continue;
    if (!buysByTicker.has(f.ticker)) buysByTicker.set(f.ticker, []);
    buysByTicker.get(f.ticker)!.push(f);
  }

  const settlementByTicker = new Map<string, Settlement>();
  for (const s of settlements) settlementByTicker.set(s.ticker, s);

  console.log(`Windows with a settlement: ${settlements.length}`);
  console.log(`Windows with an entry buy fill: ${buysByTicker.size}`);

  const trades: Array<{
    ticker: string;
    entryTime: string;
    entrySide: string;
    entryPriceCents: number;
    entryCount: number;
    win: boolean;
    pnlDollars: number;
    preEntryRangeCents: number | null;
    candleCount: number;
  }> = [];

  let i = 0;
  for (const [ticker, buys] of buysByTicker) {
    i++;
    const settlement = settlementByTicker.get(ticker);
    if (!settlement) {
      console.log(`  skip ${ticker}: no settlement found`);
      continue;
    }
    buys.sort((a, b) => a.ts - b.ts);
    const entry = buys[0];
    const entryCount = buys.reduce((sum, b) => sum + parseFloat(b.count_fp), 0);
    const entrySide = entry.side; // "yes" or "no"
    const entryPriceCents = Math.round(
      parseFloat(entrySide === "yes" ? entry.yes_price_dollars : entry.no_price_dollars) * 100
    );
    const entryTs = entry.ts;
    const pnlDollars = realizedPnl(settlement);
    const win = pnlDollars > 0;

    let preEntryRangeCents: number | null = null;
    let candleCount = 0;
    try {
      const candles = await getCandles(ticker, entryTs - 5 * 60, entryTs);
      candleCount = candles.length;
      if (candles.length > 0) {
        const highs = candles.map((c) => parseFloat(c.price.high_dollars));
        const lows = candles.map((c) => parseFloat(c.price.low_dollars));
        preEntryRangeCents = Math.round((Math.max(...highs) - Math.min(...lows)) * 100);
      }
    } catch (e: any) {
      console.error(`  candle fetch fail ${ticker}: ${e.message}`);
    }

    trades.push({
      ticker,
      entryTime: entry.created_time,
      entrySide,
      entryPriceCents,
      entryCount,
      win,
      pnlDollars,
      preEntryRangeCents,
      candleCount,
    });

    await new Promise((r) => setTimeout(r, 400));
    if (i % 10 === 0) console.log(`  ${i}/${buysByTicker.size}`);
  }

  writeFileSync(accountReportPath("btc-regime-trades.json"), JSON.stringify(trades, null, 2));
  console.log(`Done. Wrote ${trades.length} trades to the private report directory`);
}

main();
