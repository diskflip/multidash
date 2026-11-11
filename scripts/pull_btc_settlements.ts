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

const SETTLEMENTS_PATH = "/trade-api/v2/portfolio/settlements";
const cutoff = new Date(Date.now() - 16 * 24 * 60 * 60 * 1000); // last 16 days

async function main() {
  const all: any[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < 100; page++) {
    const query = `?limit=1000${cursor ? `&cursor=${cursor}` : ""}`;
    const body = await getJson(SETTLEMENTS_PATH, query);
    const batch = body.settlements ?? [];
    if (batch.length === 0) break;

    let hitCutoff = false;
    for (const s of batch) {
      if (new Date(s.settled_time) < cutoff) { hitCutoff = true; break; }
      all.push(s);
    }
    console.log(`page ${page}: got ${batch.length}, total kept ${all.length}, oldest so far ${batch[batch.length-1]?.settled_time}`);
    if (hitCutoff) break;
    cursor = body.cursor;
    if (!cursor) break;
  }

  const btc = all.filter((s) => s.ticker.startsWith("KXBTC15M") || s.ticker.startsWith("KXBTCD"));
  console.log(`Total settlements last 5 days: ${all.length}, BTC 15m: ${btc.length}`);
  writeFileSync(accountExportPath("btc-settlements.json"), JSON.stringify(all));
  console.log("Saved private BTC settlement export");
}

main();
