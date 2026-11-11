import { signRequest } from "../server/kalshiAuth.ts";
import { config } from "../server/config.ts";
import { writeFileSync } from "node:fs";
import { accountExportPath } from "./privateData.ts";

const DAYS = 7;
const cutoffMs = Date.now() - DAYS * 24 * 3600 * 1000;

async function getJson(path: string, query = ""): Promise<any> {
  const headers = { ...signRequest("GET", path), Accept: "application/json" };
  const res = await fetch(`${config.restBaseUrl}${path}${query}`, { headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} ${res.status} ${text}`);
  return JSON.parse(text);
}

type Settlement = {
  ticker: string;
  event_ticker: string;
  market_result: string;
  yes_count_fp: string;
  yes_total_cost_dollars: string;
  no_count_fp: string;
  no_total_cost_dollars: string;
  fee_cost?: string;
  settled_time: string;
  revenue: number;
  value: number;
};

type Fill = {
  ticker: string;
  action: string;
  side: string;
  outcome_side: string;
  count_fp: string;
  yes_price_dollars: string;
  no_price_dollars: string;
  fee_cost: string;
  ts: number;
  created_time: string;
  is_taker: boolean;
  order_id: string;
};

async function fetchAllSettlements(): Promise<Settlement[]> {
  const all: Settlement[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 200; page++) {
    const q = `?limit=1000${cursor ? `&cursor=${cursor}` : ""}`;
    const body = await getJson("/trade-api/v2/portfolio/settlements", q);
    const batch: Settlement[] = body.settlements ?? [];
    if (batch.length === 0) break;
    all.push(...batch);
    const oldest = new Date(batch[batch.length - 1].settled_time).getTime();
    cursor = body.cursor;
    if (!cursor || oldest < cutoffMs) break;
  }
  return all.filter((s) => new Date(s.settled_time).getTime() >= cutoffMs);
}

async function fetchAllFills(): Promise<Fill[]> {
  const all: Fill[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 400; page++) {
    const q = `?limit=1000${cursor ? `&cursor=${cursor}` : ""}`;
    const body = await getJson("/trade-api/v2/portfolio/fills", q);
    const batch: Fill[] = body.fills ?? [];
    if (batch.length === 0) break;
    all.push(...batch);
    const oldest = batch[batch.length - 1].ts * 1000;
    cursor = body.cursor;
    if (!cursor || oldest < cutoffMs) break;
  }
  return all.filter((f) => f.ts * 1000 >= cutoffMs);
}

console.log(`Fetching settlements + fills for last ${DAYS} days...`);
const [settlements, fills] = await Promise.all([fetchAllSettlements(), fetchAllFills()]);
console.log(`Got ${settlements.length} settlements, ${fills.length} fills`);

writeFileSync(accountExportPath("raw-settlements.json"), JSON.stringify(settlements, null, 2));
writeFileSync(accountExportPath("raw-fills.json"), JSON.stringify(fills, null, 2));
console.log("Raw account data written to the private export directory");
