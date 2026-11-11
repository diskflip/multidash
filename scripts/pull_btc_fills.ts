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

const FILLS_PATH = "/trade-api/v2/portfolio/fills";
const cutoff = new Date(Date.now() - 16 * 24 * 60 * 60 * 1000);

async function main() {
  const all: any[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < 200; page++) {
    const query = `?limit=1000${cursor ? `&cursor=${cursor}` : ""}`;
    const body = await getJson(FILLS_PATH, query);
    const batch = body.fills ?? [];
    if (batch.length === 0) break;

    let hitCutoff = false;
    for (const f of batch) {
      if (new Date(f.created_time) < cutoff) { hitCutoff = true; break; }
      all.push(f);
    }
    console.log(`page ${page}: got ${batch.length}, total kept ${all.length}, oldest so far ${batch[batch.length-1]?.created_time}`);
    if (hitCutoff) break;
    cursor = body.cursor;
    if (!cursor) break;
  }

  const btc = all.filter((f) => f.ticker.startsWith("KXBTC15M") || f.ticker.startsWith("KXBTCD"));
  console.log(`Total fills last 5 days: ${all.length}, BTC 15m: ${btc.length}`);
  writeFileSync(accountExportPath("btc-fills.json"), JSON.stringify(all));
  console.log("Saved private BTC fill export");
}

main();
