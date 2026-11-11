import { config } from "../server/config.ts";

async function getJson(path: string, query = ""): Promise<any> {
  const res = await fetch(`${config.restBaseUrl}${path}${query}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} ${res.status} ${text}`);
  return JSON.parse(text);
}

async function main() {
  const markets = await getJson("/trade-api/v2/markets", "?series_ticker=KXSILVER15M&status=open&limit=5");
  console.log("ticker field:", markets.markets[0].ticker, "event:", markets.markets[0].event_ticker);

  const ticker = markets.markets[0].ticker;

  const trades = await getJson("/trade-api/v2/markets/trades", `?ticker=${ticker}&limit=50`);
  console.log("TRADES n=", trades.trades.length, JSON.stringify(trades.trades[0]));

  const now = Math.floor(Date.now()/1000);
  const candles = await getJson(
    `/trade-api/v2/series/KXSILVER15M/markets/${ticker}/candlesticks`,
    `?start_ts=${now-1200}&end_ts=${now}&period_interval=1`
  ).catch((e) => ({ error: e.message }));
  console.log("\nCANDLES:", JSON.stringify(candles).slice(0, 2000));
}
main();
