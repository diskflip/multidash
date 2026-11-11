import { config } from "../server/config.ts";

async function getJson(path: string, query = ""): Promise<any> {
  const res = await fetch(`${config.restBaseUrl}${path}${query}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} ${res.status} ${text}`);
  return JSON.parse(text);
}

async function main() {
  // public trades endpoint - no auth needed
  const trades = await getJson("/trade-api/v2/markets/trades", "?ticker=KXSILVER15M-26AUG151700-00&limit=50");
  console.log("TRADES SAMPLE:", JSON.stringify(trades, null, 2).slice(0, 3000));

  const candles = await getJson(
    "/trade-api/v2/series/KXSILVER15M/markets/KXSILVER15M-26AUG151700-00/candlesticks",
    "?start_ts=1786000000&end_ts=1786010000&period_interval=1"
  ).catch((e) => ({ error: e.message }));
  console.log("\nCANDLES SAMPLE:", JSON.stringify(candles, null, 2).slice(0, 2000));
}
main();
