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
  for (let page = 0; page < 10; page++) {
    const q = `?limit=1000${cursor ? `&cursor=${cursor}` : ""}`;
    const body = await getJson("/trade-api/v2/portfolio/orders", q);
    const batch = body.orders ?? [];
    all.push(...batch);
    cursor = body.cursor;
    if (!cursor || batch.length === 0) break;
    if ((batch[batch.length - 1]?.created_time ?? "") < "2026-08-22T19:00:00Z") break;
  }
  const orders = all.filter((o: any) => o.ticker === "KXBTC15M-26AUG221615-15");
  console.log("ALL orders for KXBTC15M-26AUG221615-15:");
  for (const o of orders) {
    console.log(JSON.stringify({
      order_id: o.order_id, client_order_id: o.client_order_id, action: o.action, side: o.side,
      yes_price: o.yes_price_dollars, no_price: o.no_price_dollars, status: o.status, fill_count: o.fill_count_fp
    }));
  }
}
main();
