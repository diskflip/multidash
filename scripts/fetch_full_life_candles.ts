// 1-minute candles (open through close) for every ticker in a trade list,
// keeping yes_bid/yes_ask high/low/close per bar (not just close) — needed
// to simulate a peak/drawdown exit rule against the held side's bid.
// Kalshi's finest public candle resolution is 1 minute; there is no public
// sub-minute history, so this cannot reproduce a literal "sustained for 1
// second" condition — see scripts/simulate_trailing_stop.ts for how it's
// approximated instead.
import { readFileSync, writeFileSync } from "node:fs";
import { config } from "../server/config.ts";
import { accountReportPath } from "./privateData.ts";

type Trade = { ticker: string; openTime: string; closeTime: string };

async function getCandles(ticker: string, startTs: number, endTs: number): Promise<any[]> {
  const url = `${config.restBaseUrl}/trade-api/v2/series/KXBTC15M/markets/${ticker}/candlesticks?start_ts=${startTs}&end_ts=${endTs}&period_interval=1`;
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url);
    const text = await res.text();
    if (res.ok) return JSON.parse(text).candlesticks ?? [];
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
      continue;
    }
    throw new Error(`${ticker} ${res.status} ${text}`);
  }
  return [];
}

async function main() {
  const inputFile = process.argv[2] ?? accountReportPath("btc_trades_clean.json");
  const daysBack = Number(process.argv[3] ?? 5);
  const outFile = process.argv[4] ?? accountReportPath("btc_full_life_candles.json");

  const trades: Trade[] = JSON.parse(readFileSync(inputFile, "utf8"));
  const cutoff = Date.now() - daysBack * 24 * 60 * 60 * 1000;
  const recent = trades.filter((t) => new Date((t as any).entryFillTime).getTime() >= cutoff);

  const byTicker = new Map<string, Trade>();
  for (const t of recent) if (!byTicker.has(t.ticker)) byTicker.set(t.ticker, t);
  console.log(`Fetching full-life 1-min candles for ${byTicker.size} tickers...`);

  const out: Record<string, any[]> = {};
  let done = 0;
  for (const [ticker, t] of byTicker) {
    const startTs = Math.floor(new Date(t.openTime).getTime() / 1000);
    const endTs = Math.floor(new Date(t.closeTime).getTime() / 1000) + 30;
    try {
      const candles = await getCandles(ticker, startTs, endTs);
      out[ticker] = candles.map((c) => ({
        t: c.end_period_ts,
        yesBidHigh: parseFloat(c.yes_bid?.high_dollars ?? "NaN") * 100,
        yesBidLow: parseFloat(c.yes_bid?.low_dollars ?? "NaN") * 100,
        yesBidClose: parseFloat(c.yes_bid?.close_dollars ?? "NaN") * 100,
        yesAskHigh: parseFloat(c.yes_ask?.high_dollars ?? "NaN") * 100,
        yesAskLow: parseFloat(c.yes_ask?.low_dollars ?? "NaN") * 100,
        yesAskClose: parseFloat(c.yes_ask?.close_dollars ?? "NaN") * 100,
      }));
    } catch (e: any) {
      console.error(`  fail ${ticker}: ${e.message}`);
      out[ticker] = [];
    }
    done++;
    if (done % 20 === 0) console.log(`  ${done}/${byTicker.size}`);
    await new Promise((r) => setTimeout(r, 300));
  }

  writeFileSync(outFile, JSON.stringify(out));
  console.log(`Saved ${outFile}`);
}

main();
