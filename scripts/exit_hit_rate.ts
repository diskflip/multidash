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

async function main() {
  const all: any[] = [];
  let cursor: string | undefined;
  // pull as far back as pagination gives us (no date filter this time)
  for (let page = 0; page < 30; page++) {
    const q = `?limit=1000${cursor ? `&cursor=${cursor}` : ""}`;
    const body = await getJson("/trade-api/v2/portfolio/orders", q);
    const batch = body.orders ?? [];
    all.push(...batch);
    console.log(`page ${page}: ${batch.length}, oldest: ${batch[batch.length - 1]?.created_time}`);
    cursor = body.cursor;
    if (!cursor || batch.length === 0) break;
  }
  writeFileSync(accountExportPath("btc-orders-full.json"), JSON.stringify(all));
  const btc = all.filter((o: any) => o.ticker?.startsWith("KXBTC15M"));

  // entries: scalpyes / scalpno orders, executed
  const entries = btc.filter(
    (o: any) => o.status === "executed" && /^(scalpyes|scalpno)-/.test(o.client_order_id ?? "")
  );
  // exits: scalpexyes1 / scalpexno1 orders, executed
  const exits = btc.filter(
    (o: any) => o.status === "executed" && /^(scalpexyes1|scalpexno1)-/.test(o.client_order_id ?? "")
  );

  const entryByDay: Record<string, number> = {};
  for (const o of entries) {
    const day = o.created_time.slice(0, 10);
    entryByDay[day] = (entryByDay[day] ?? 0) + 1;
  }
  const exitByDay: Record<string, number> = {};
  for (const o of exits) {
    const day = o.created_time.slice(0, 10);
    exitByDay[day] = (exitByDay[day] ?? 0) + 1;
  }

  const days = [...new Set([...Object.keys(entryByDay), ...Object.keys(exitByDay)])].sort();
  console.log("\nDay         EntryOrders  ExitOrders");
  for (const day of days) {
    console.log(day.padEnd(12), String(entryByDay[day] ?? 0).padStart(11), String(exitByDay[day] ?? 0).padStart(11));
  }
  console.log(`\nTotal executed entry orders: ${entries.length}, executed exit orders: ${exits.length}`);
}
main();
