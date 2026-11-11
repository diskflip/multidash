import { config } from "../server/config.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { accountExportPath, accountReportPath } from "./privateData.ts";

async function getJson(path: string, query = ""): Promise<any> {
  const res = await fetch(`${config.restBaseUrl}${path}${query}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} ${res.status} ${text}`);
  return JSON.parse(text);
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function getWithRetry(path: string, query: string, retries = 6): Promise<any> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await getJson(path, query);
    } catch (e: any) {
      if (e.message.includes("429") && attempt < retries - 1) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
}

type Settlement = { ticker: string; settled_time: string; market_result: string };
const settlements: Settlement[] = JSON.parse(readFileSync(accountExportPath("raw-settlements.json"), "utf8"))
  .filter((s: Settlement) => s.ticker.startsWith("KXSILVER15M"));

let existing: any[] = [];
try {
  existing = JSON.parse(readFileSync(accountReportPath("silver-candles.json"), "utf8"));
} catch {}
const haveTickers = new Set(existing.map((r) => r.ticker));
const todo = settlements.filter((s) => !haveTickers.has(s.ticker));
console.log(`Have ${existing.length}, fetching remaining ${todo.length}...`);

const results: any[] = [...existing];
let i = 0;
for (const s of todo) {
  i++;
  const closeTs = Math.floor(new Date(s.settled_time).getTime() / 1000);
  const startTs = closeTs - 16 * 60;
  try {
    const body = await getWithRetry(
      `/trade-api/v2/series/KXSILVER15M/markets/${s.ticker}/candlesticks`,
      `?start_ts=${startTs}&end_ts=${closeTs}&period_interval=1`
    );
    results.push({ ticker: s.ticker, result: s.market_result, candles: body.candlesticks });
  } catch (e: any) {
    console.error(`  fail ${s.ticker}: ${e.message}`);
  }
  await sleep(600);
  if (i % 10 === 0) console.log(`  ${i}/${todo.length}`);
}

writeFileSync(accountReportPath("silver-candles.json"), JSON.stringify(results));
console.log(`Done. Got candles for ${results.length}/${settlements.length} windows.`);
