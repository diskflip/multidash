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
  const body = await getJson("/trade-api/v2/portfolio/orders", "?limit=1000&status=");
  const orders = (body.orders ?? []).filter((o: any) => o.ticker?.startsWith("KXBTC15M"));
  const sellYes = orders.filter((o: any) => o.action === "sell" && o.side === "yes");
  console.log(`sell/yes orders: ${sellYes.length}`);
  for (const o of sellYes.slice(0, 15)) {
    console.log(o.client_order_id, "| yes_price:", o.yes_price_dollars, "| status:", o.status, "| fill_count:", o.fill_count_fp, "| outcome_side:", o.outcome_side);
  }
  console.log("\nDistinct client_order_id prefixes:");
  const prefixes = new Set(orders.map((o:any) => (o.client_order_id||"").split("-")[0]));
  console.log([...prefixes]);
}
main();
