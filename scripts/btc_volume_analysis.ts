import { readFileSync, writeFileSync } from "node:fs";
import { accountReportPath } from "./privateData.ts";

type Trade = {
  ticker: string;
  entryTime: string;
  entrySide: string;
  entryPriceCents: number;
  entryCount: number;
  win: boolean;
  pnlDollars: number;
  preEntryRangeCents: number | null;
  candleCount: number;
};

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
  const trades: Trade[] = JSON.parse(readFileSync(accountReportPath("btc-regime-trades.json"), "utf8"));

  const enriched: any[] = [];
  let i = 0;
  for (const t of trades) {
    i++;
    const entryTs = Math.floor(new Date(t.entryTime).getTime() / 1000);
    let preEntryVolume: number | null = null;
    let choppiness: number | null = null;
    let oiChangePct: number | null = null;
    let oiStart: number | null = null;
    try {
      const candles = await getCandles(t.ticker, entryTs - 5 * 60, entryTs);
      if (candles.length > 0) {
        preEntryVolume = candles.reduce((s, c) => s + parseFloat(c.volume_fp), 0);

        // "choppiness": total absolute per-minute travel (sum of each minute's own
        // high-low) divided by the net high-low across the whole pre-entry window.
        // Ratio near 1 = one smooth directional move. Ratio >> 1 = lots of back-and-forth.
        const perMinuteRange = candles.reduce(
          (s, c) => s + (parseFloat(c.price.high_dollars) - parseFloat(c.price.low_dollars)),
          0
        );
        const highs = candles.map((c) => parseFloat(c.price.high_dollars));
        const lows = candles.map((c) => parseFloat(c.price.low_dollars));
        const netRange = Math.max(...highs) - Math.min(...lows);
        choppiness = netRange > 0 ? perMinuteRange / netRange : null;

        const oiVals = candles.map((c) => parseFloat(c.open_interest_fp));
        oiStart = oiVals[0];
        const oiEnd = oiVals[oiVals.length - 1];
        oiChangePct = oiStart > 0 ? ((oiEnd - oiStart) / oiStart) * 100 : null;
      }
    } catch (e: any) {
      console.error(`  fail ${t.ticker}: ${e.message}`);
    }

    enriched.push({ ...t, preEntryVolume, choppiness, oiChangePct, oiStart });
    await new Promise((r) => setTimeout(r, 400));
    if (i % 20 === 0) console.log(`${i}/${trades.length}`);
  }

  writeFileSync(accountReportPath("btc-volume-trades.json"), JSON.stringify(enriched, null, 2));
  console.log(`Done. Wrote ${enriched.length} enriched trades.`);
}

main();
