import { config } from "../server/config.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { accountExportPath, accountReportPath } from "./privateData.ts";

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function getJson(path: string, query = ""): Promise<any> {
  const res = await fetch(`${config.restBaseUrl}${path}${query}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} ${res.status} ${text}`);
  return JSON.parse(text);
}
async function getWithRetry(path: string, query: string, retries = 6): Promise<any> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try { return await getJson(path, query); }
    catch (e: any) {
      if (e.message.includes("429") && attempt < retries - 1) { await sleep(1500 * (attempt + 1)); continue; }
      throw e;
    }
  }
}

type Settlement = { ticker: string; settled_time: string; market_result: string };
const all: Settlement[] = JSON.parse(readFileSync(accountExportPath("raw-settlements.json"), "utf8"))
  .filter((s: Settlement) => s.ticker.startsWith("KXSILVER15M"));

// systematic sample: every 3rd window, spread across the whole week (not cherry-picked)
const sample = all.filter((_, i) => i % 3 === 0);
console.log(`Sampling ${sample.length} of ${all.length} SILVER windows for tick-level backtest`);

async function fetchAllTrades(ticker: string) {
  const trades: any[] = [];
  let cursor = "";
  for (let i = 0; i < 10; i++) {
    const q = `?ticker=${ticker}&limit=1000${cursor ? `&cursor=${cursor}` : ""}`;
    const body = await getWithRetry("/trade-api/v2/markets/trades", q);
    trades.push(...body.trades);
    if (!body.cursor || body.trades.length === 0) break;
    cursor = body.cursor;
    await sleep(400);
  }
  return trades;
}

let existing: any[] = [];
try { existing = JSON.parse(readFileSync(accountReportPath("silver-ticks.json"), "utf8")); } catch {}
const have = new Set(existing.map((r: any) => r.ticker));
const todo = sample.filter((s) => !have.has(s.ticker));

const results: any[] = existing;
let i = 0;
for (const s of todo) {
  i++;
  try {
    const trades = await fetchAllTrades(s.ticker);
    trades.sort((a, b) => new Date(a.created_time).getTime() - new Date(b.created_time).getTime());
    results.push({
      ticker: s.ticker,
      result: s.market_result,
      trades: trades.map((t) => ({ t: t.created_time, yes: parseFloat(t.yes_price_dollars) * 100 })),
    });
  } catch (e: any) {
    console.error(`fail ${s.ticker}: ${e.message}`);
  }
  await sleep(500);
  if (i % 5 === 0) {
    console.log(`${i}/${todo.length}`);
    writeFileSync(accountReportPath("silver-ticks.json"), JSON.stringify(results));
  }
}
writeFileSync(accountReportPath("silver-ticks.json"), JSON.stringify(results));
console.log(`Done. ${results.length}/${sample.length} windows with tick data.`);
