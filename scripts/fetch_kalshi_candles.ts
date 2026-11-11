// 1-minute public candlesticks for every unique ticker in the clean trade
// set, from window open through entry time. This is Kalshi's finest public
// resolution for the YES-price signal (confirmed via probe_btc_candles.ts —
// period_interval only accepts 1/60/1440 minutes) — used ONLY for the
// longer lookbacks (>=180s) where 1-minute granularity is a defensible
// approximation; shorter YES-vs-50 lookbacks are reported as unavailable
// from history (see the forward logger instead).
import { readFileSync, writeFileSync } from "node:fs";
import { accountReportPath } from "./privateData.ts";

type Trade = { ticker: string; openTime: string; entryFillTime: string; entryPriceCents: number };

async function getCandles(ticker: string, startTs: number, endTs: number): Promise<any[]> {
  const url = `https://api.elections.kalshi.com/trade-api/v2/series/KXBTC15M/markets/${ticker}/candlesticks?start_ts=${startTs}&end_ts=${endTs}&period_interval=1`;
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url);
    const text = await res.text();
    if (res.ok) return JSON.parse(text).candlesticks ?? [];
    if (res.status === 429 && attempt < 5) {
      await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
      continue;
    }
    throw new Error(`${ticker} ${res.status} ${text}`);
  }
  return [];
}

async function main() {
  const trades: Trade[] = JSON.parse(readFileSync(accountReportPath("btc_trades_clean.json"), "utf8")).filter(
    (t: Trade) => t.entryPriceCents <= 10
  );
  const byTicker = new Map<string, Trade>();
  for (const t of trades) if (!byTicker.has(t.ticker)) byTicker.set(t.ticker, t);
  console.log(`Fetching 1-min candles for ${byTicker.size} unique tickers...`);

  const out: Record<string, { t: number; yesClose: number }[]> = {};
  let done = 0;
  for (const [ticker, t] of byTicker) {
    const startTs = Math.floor(new Date(t.openTime).getTime() / 1000);
    const endTs = Math.floor(new Date(t.entryFillTime).getTime() / 1000) + 5;
    try {
      const candles = await getCandles(ticker, startTs, endTs);
      out[ticker] = candles.map((c) => ({
        t: c.end_period_ts,
        yesClose: parseFloat(c.price?.close_dollars ?? c.price?.close ?? "NaN") * 100,
      }));
    } catch (e: any) {
      console.error(`  fail ${ticker}: ${e.message}`);
      out[ticker] = [];
    }
    done++;
    if (done % 50 === 0) {
      console.log(`  ${done}/${byTicker.size}`);
      writeFileSync(accountReportPath("btc_kalshi_candles.json"), JSON.stringify(out));
    }
    await new Promise((r) => setTimeout(r, 350));
  }

  writeFileSync(accountReportPath("btc_kalshi_candles.json"), JSON.stringify(out));
  console.log("Done.");
}

main();
