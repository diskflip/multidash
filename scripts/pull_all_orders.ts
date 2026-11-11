import { signRequest } from "../server/kalshiAuth.ts";
import { config } from "../server/config.ts";
import { writeFileSync } from "node:fs";
import { accountExportPath } from "./privateData.ts";

async function getJson(path: string, query = ""): Promise<any> {
  const headers = { ...signRequest("GET", path), Accept: "application/json" };
  const res = await fetch(`${config.restBaseUrl}${path}${query}`, { headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} ${res.status} ${text}`);
  return JSON.parse(text);
}

const ORDERS_PATH = "/trade-api/v2/portfolio/orders";

async function main() {
  const all: any[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 200; page++) {
    const query = `?limit=1000&status=${cursor ? `&cursor=${cursor}` : ""}`;
    const body = await getJson(ORDERS_PATH, query);
    const batch = body.orders ?? [];
    all.push(...batch);
    console.log(`page ${page}: got ${batch.length}, total ${all.length}, oldest so far ${batch[batch.length - 1]?.created_time}`);
    cursor = body.cursor;
    if (!cursor || batch.length === 0) break;
  }
  writeFileSync(accountExportPath("btc-orders-full.json"), JSON.stringify(all));
  const btc = all.filter((o) => o.ticker?.startsWith("KXBTC15M"));
  console.log(`Total orders (unbounded): ${all.length}, BTC 15m: ${btc.length}`);
}
main();
