// For each clean BTC trade, pulls tick-level BTC/USD trades from Kraken's
// public API covering [entryTime - 920s, entryTime] (real trade prints with
// sub-second timestamps — independent of Kalshi, no auth needed). Binance's
// API returns 451 (geo-blocked) from this environment, so Kraken is the
// source for the underlying-BTC signal. Read-only, no orders of any kind.
import { readFileSync, writeFileSync } from "node:fs";
import { accountReportPath } from "./privateData.ts";

type Trade = {
  ticker: string;
  side: string;
  entryFillTime: string;
  entryPriceCents: number;
};

async function fetchTradesPage(sinceNs: bigint): Promise<{ price: number; time: number }[]> {
  const url = `https://api.kraken.com/0/public/Trades?pair=XBTUSD&since=${sinceNs.toString()}&count=1000`;
  for (let attempt = 0; attempt < 10; attempt++) {
    const res = await fetch(url);
    if (res.status === 429 || res.status === 520) {
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      continue;
    }
    const body = await res.json();
    if (body.error?.some((e: string) => /too many requests/i.test(e))) {
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      continue;
    }
    if (body.error?.length) throw new Error(JSON.stringify(body.error));
    const rows = (body.result?.XXBTZUSD ?? []) as [string, string, number, string, string, string, number][];
    return rows.map((r) => ({ price: parseFloat(r[0]), time: r[2] }));
  }
  throw new Error("kraken: exhausted retries");
}

const LOOKBACK_SECONDS = 920;

async function main() {
  const trades: Trade[] = JSON.parse(readFileSync(accountReportPath("btc_trades_clean.json"), "utf8")).filter(
    (t: Trade) => t.entryPriceCents <= 10
  );
  console.log(`Fetching Kraken tick history for ${trades.length} trades...`);

  const out: Record<string, { t: number; p: number }[]> = {};
  let done = 0;
  for (const trade of trades) {
    const key = `${trade.ticker}|${trade.side}`;
    const entryS = new Date(trade.entryFillTime).getTime() / 1000;
    const startS = entryS - LOOKBACK_SECONDS;
    let sinceNs = BigInt(Math.floor(startS)) * 1_000_000_000n;
    const collected: { t: number; p: number }[] = [];
    try {
      for (let page = 0; page < 4; page++) {
        const rows = await fetchTradesPage(sinceNs);
        if (rows.length === 0) break;
        for (const r of rows) {
          if (r.time <= entryS) collected.push({ t: r.time, p: r.price });
        }
        const lastTime = rows[rows.length - 1].time;
        if (lastTime >= entryS) break; // covered the whole window
        sinceNs = BigInt(Math.floor(lastTime * 1e9)) + 1n;
        await new Promise((r) => setTimeout(r, 900));
      }
      out[key] = collected;
    } catch (e: any) {
      console.error(`  fail ${key}: ${e.message}`);
      out[key] = [];
    }
    done++;
    if (done % 25 === 0) {
      console.log(`  ${done}/${trades.length}`);
      writeFileSync(accountReportPath("btc_kraken_history.json"), JSON.stringify(out));
    }
    await new Promise((r) => setTimeout(r, 900));
  }

  writeFileSync(accountReportPath("btc_kraken_history.json"), JSON.stringify(out));
  const withData = Object.values(out).filter((v) => v.length > 0).length;
  console.log(`Done. ${withData}/${trades.length} trades got price history.`);
}

main();
