import { config } from "../server/config.ts";

async function getJson(path: string, query = ""): Promise<any> {
  const res = await fetch(`${config.restBaseUrl}${path}${query}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} ${res.status} ${text}`);
  return JSON.parse(text);
}

async function fetchAllTrades(ticker: string) {
  const all: any[] = [];
  let cursor = "";
  for (let i = 0; i < 20; i++) {
    const q = `?ticker=${ticker}&limit=1000${cursor ? `&cursor=${cursor}` : ""}`;
    const body = await getJson("/trade-api/v2/markets/trades", q);
    all.push(...body.trades);
    if (!body.cursor || body.trades.length === 0) break;
    cursor = body.cursor;
  }
  return all;
}

async function main() {
  const ticker = "KXSILVER15M-26AUG181130-30";
  const trades = await fetchAllTrades(ticker);
  trades.sort((a, b) => new Date(a.created_time).getTime() - new Date(b.created_time).getTime());
  console.log(`Total trades: ${trades.length}`);
  console.log(`Window: ${trades[0]?.created_time} to ${trades[trades.length-1]?.created_time}`);

  // print every trade where yes_price crosses interesting levels, with timestamp
  let lastPrinted = -1;
  for (const t of trades) {
    const yp = Math.round(parseFloat(t.yes_price_dollars) * 100);
    if (Math.abs(yp - lastPrinted) >= 3 || lastPrinted === -1) {
      console.log(`${t.created_time}  yes=${yp}c  count=${t.count_fp}`);
      lastPrinted = yp;
    }
  }
}
main();
