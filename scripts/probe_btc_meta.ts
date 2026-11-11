import { config } from "../server/config.ts";

async function getJson(path: string, query = ""): Promise<any> {
  const res = await fetch(`${config.restBaseUrl}${path}${query}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} ${res.status} ${text}`);
  return JSON.parse(text);
}

async function main() {
  const ticker = "KXBTC15M-26AUG231330-30"; // the window with the executed entry we found
  const market = await getJson("/trade-api/v2/markets", `?tickers=${ticker}`);
  console.log("MARKET META:", JSON.stringify(market, null, 2));

  const trades = await getJson("/trade-api/v2/markets/trades", `?ticker=${ticker}&limit=1000`);
  console.log(`\nTRADES: n=${trades.trades?.length}, cursor=${trades.cursor}`);
  console.log("first 3:", JSON.stringify(trades.trades?.slice(0, 3), null, 2));
  console.log("last 3:", JSON.stringify(trades.trades?.slice(-3), null, 2));
}
main();
