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
  // Recent orders (any status), BTC 15m only, to see if high-price sell/exit
  // orders were ever placed (filled or not) — not just look at fills.
  const body = await getJson("/trade-api/v2/portfolio/orders", "?limit=1000&status=");
  const orders = (body.orders ?? []).filter((o: any) => o.ticker?.startsWith("KXBTC15M"));
  console.log(`Total orders returned: ${(body.orders ?? []).length}, BTC15M: ${orders.length}`);

  const statusCounts: Record<string, number> = {};
  for (const o of orders) statusCounts[o.status] = (statusCounts[o.status] ?? 0) + 1;
  console.log("status counts:", statusCounts);

  const actionSideCounts: Record<string, number> = {};
  for (const o of orders) {
    const k = `${o.action}/${o.side}`;
    actionSideCounts[k] = (actionSideCounts[k] ?? 0) + 1;
  }
  console.log("action/side counts:", actionSideCounts);

  // Any order with a high yes or no price on the matching side
  const highPriceOrders = orders.filter((o: any) => {
    const p = o.side === "yes" ? o.yes_price : o.no_price;
    return p != null && p >= 50;
  });
  console.log(`orders with matching-side price >= 50c: ${highPriceOrders.length}`);
  console.log(JSON.stringify(highPriceOrders.slice(0, 5), null, 2));

  console.log("\nSample order (raw shape):");
  console.log(JSON.stringify(orders[0], null, 2));
}

main();

async function main2() {
  const body = await getJson("/trade-api/v2/portfolio/orders", "?limit=1000&status=");
  const orders = (body.orders ?? []).filter((o: any) => o.ticker?.startsWith("KXBTC15M"));
  const sellYes = orders.filter((o: any) => o.action === "sell" && o.side === "yes");
  console.log(`\nsell/yes orders: ${sellYes.length}`);
  console.log(JSON.stringify(sellYes.slice(0, 5), null, 2));
  const executed = orders.filter((o: any) => o.status === "executed");
  console.log(`\nexecuted orders: ${executed.length}`);
  console.log(JSON.stringify(executed, null, 2));
}
main2();
