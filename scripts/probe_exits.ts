import { signRequest } from "../server/kalshiAuth.ts";
import { config } from "../server/config.ts";

async function getJson(path: string, query = ""): Promise<any> {
  const headers = { ...signRequest("GET", path), Accept: "application/json" };
  const res = await fetch(`${config.restBaseUrl}${path}${query}`, { headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} ${res.status} ${text}`);
  return JSON.parse(text);
}

async function main() {
  const all: any[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const q = `?limit=1000${cursor ? `&cursor=${cursor}`:''}`;
    const body = await getJson("/trade-api/v2/portfolio/orders", q);
    const batch = body.orders ?? [];
    all.push(...batch);
    console.log(`page ${page}: ${batch.length}, oldest: ${batch[batch.length-1]?.created_time}`);
    cursor = body.cursor;
    if (!cursor || batch.length === 0) break;
    if (batch[batch.length-1]?.created_time < "2026-08-19") break;
  }
  const btc = all.filter((o:any) => o.ticker?.startsWith("KXBTC15M"));
  console.log(`total orders: ${all.length}, BTC15M: ${btc.length}`);

  const exits = btc.filter((o:any) => (o.client_order_id||"").startsWith("scalpex"));
  console.log(`scalpex* orders: ${exits.length}`);
  const exitStatus: Record<string,number> = {};
  for (const o of exits) exitStatus[o.status] = (exitStatus[o.status]||0)+1;
  console.log("exit order status counts:", exitStatus);

  const executedExits = exits.filter((o:any) => o.status === 'executed');
  console.log(`executed exits: ${executedExits.length}`);
  for (const o of executedExits) {
    console.log(o.client_order_id, '| yes_price:', o.yes_price_dollars, '| no_price:', o.no_price_dollars, '| fill_count:', o.fill_count_fp, '| created:', o.created_time);
  }

  // distinct target prices used in scalpex client_order_ids
  const targets = new Set(exits.map((o:any) => (o.client_order_id||'').match(/-(\d{2,3})-/)?.[1]));
  console.log('distinct exit target tokens seen in ids:', [...targets]);
}
main();
