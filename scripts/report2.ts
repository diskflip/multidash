import { readFileSync } from "node:fs";
import { accountExportPath } from "./privateData.ts";

type Settlement = {
  ticker: string; event_ticker: string; market_result: string;
  yes_count_fp: string; yes_total_cost_dollars: string;
  no_count_fp: string; no_total_cost_dollars: string;
  fee_cost?: string; settled_time: string; revenue: number; value: number;
};
type Fill = {
  ticker: string; action: string; side: string; outcome_side: string;
  count_fp: string; yes_price_dollars: string; no_price_dollars: string;
  fee_cost: string; ts: number; created_time: string; is_taker: boolean; order_id: string;
};

const settlements: Settlement[] = JSON.parse(readFileSync(accountExportPath("raw-settlements.json"), "utf8"));
const fills: Fill[] = JSON.parse(readFileSync(accountExportPath("raw-fills.json"), "utf8"));

function symbolOf(t: string) { const m = t.match(/^(.+?)-\d{2}[A-Z]{3}\d{2}/); return m ? m[1] : t; }
function pnlOf(s: Settlement) {
  const yesCount = parseFloat(s.yes_count_fp), noCount = parseFloat(s.no_count_fp);
  const yesCost = parseFloat(s.yes_total_cost_dollars), noCost = parseFloat(s.no_total_cost_dollars);
  const fee = parseFloat(s.fee_cost ?? "0");
  const yc = yesCount > 0 ? yesCost / yesCount : 0, nc = noCount > 0 ? noCost / noCount : 0;
  const hedgedPairs = Math.min(yesCount, noCount);
  const net = hedgedPairs * 1 - hedgedPairs * (yc + nc) - ((yesCount - hedgedPairs) * yc + (noCount - hedgedPairs) * nc) - fee;
  const fullyUnhedged = hedgedPairs === 0 && (yesCount > 0 || noCount > 0);
  return { net, hedgedPairs, fullyUnhedged, yesCount, noCount };
}

// group fills by ticker
const fillsByTicker = new Map<string, Fill[]>();
for (const f of fills) {
  if (!fillsByTicker.has(f.ticker)) fillsByTicker.set(f.ticker, []);
  fillsByTicker.get(f.ticker)!.push(f);
}
for (const arr of fillsByTicker.values()) arr.sort((a, b) => a.ts - b.ts);

// Time-to-close analysis: for each settlement, find last fill ts vs settled_time (window close)
console.log("=".repeat(70));
console.log("TIME OF LAST FILL BEFORE WINDOW CLOSE, BY HEDGE OUTCOME");
console.log("=".repeat(70));
const buckets = new Map<string, { n: number; net: number }>();
for (const s of settlements) {
  const p = pnlOf(s);
  const tfills = fillsByTicker.get(s.ticker);
  if (!tfills || tfills.length === 0) continue;
  const lastFillTs = tfills[tfills.length - 1].ts;
  const closeTs = new Date(s.settled_time).getTime() / 1000;
  const secsBeforeClose = closeTs - lastFillTs;
  const label = p.fullyUnhedged ? "unhedged" : p.hedgedPairs > 0 ? "hedged" : "other";
  const bucket = secsBeforeClose <= 30 ? "<=30s" : secsBeforeClose <= 60 ? "30-60s" : secsBeforeClose <= 180 ? "1-3min" : secsBeforeClose <= 300 ? "3-5min" : ">5min";
  const key = `${label} / last-fill ${bucket} before close`;
  if (!buckets.has(key)) buckets.set(key, { n: 0, net: 0 });
  const b = buckets.get(key)!;
  b.n++; b.net += p.net;
}
for (const [k, v] of [...buckets.entries()].sort()) {
  console.log(`${k.padEnd(40)} n=${String(v.n).padStart(3)} net=$${v.net.toFixed(2)}`);
}

console.log("\n" + "=".repeat(70));
console.log("TIME OF *FIRST* FILL RELATIVE TO WINDOW CLOSE (entry timing), BY HEDGE OUTCOME");
console.log("=".repeat(70));
const buckets2 = new Map<string, { n: number; net: number }>();
for (const s of settlements) {
  const p = pnlOf(s);
  const tfills = fillsByTicker.get(s.ticker);
  if (!tfills || tfills.length === 0) continue;
  const firstFillTs = tfills[0].ts;
  const closeTs = new Date(s.settled_time).getTime() / 1000;
  const secsBeforeClose = closeTs - firstFillTs;
  const label = p.fullyUnhedged ? "unhedged" : p.hedgedPairs > 0 ? "hedged" : "other";
  const bucket = secsBeforeClose <= 60 ? "<=1min left" : secsBeforeClose <= 180 ? "1-3min left" : secsBeforeClose <= 300 ? "3-5min left" : secsBeforeClose <= 600 ? "5-10min left" : ">10min left";
  const key = `${label} / first-fill ${bucket}`;
  if (!buckets2.has(key)) buckets2.set(key, { n: 0, net: 0 });
  const b = buckets2.get(key)!;
  b.n++; b.net += p.net;
}
for (const [k, v] of [...buckets2.entries()].sort()) {
  console.log(`${k.padEnd(40)} n=${String(v.n).padStart(3)} net=$${v.net.toFixed(2)}`);
}

console.log("\n" + "=".repeat(70));
console.log("NUMBER OF FILLS PER WINDOW, BY HEDGE OUTCOME (proxy for chasing/re-entries)");
console.log("=".repeat(70));
const buckets3 = new Map<string, { n: number; net: number }>();
for (const s of settlements) {
  const p = pnlOf(s);
  const tfills = fillsByTicker.get(s.ticker) ?? [];
  const label = p.fullyUnhedged ? "unhedged" : p.hedgedPairs > 0 ? "hedged" : "other";
  const bucket = tfills.length <= 2 ? "1-2 fills" : tfills.length <= 5 ? "3-5 fills" : tfills.length <= 10 ? "6-10 fills" : ">10 fills";
  const key = `${label} / ${bucket}`;
  if (!buckets3.has(key)) buckets3.set(key, { n: 0, net: 0 });
  const b = buckets3.get(key)!;
  b.n++; b.net += p.net;
}
for (const [k, v] of [...buckets3.entries()].sort()) {
  console.log(`${k.padEnd(30)} n=${String(v.n).padStart(3)} net=$${v.net.toFixed(2)}`);
}

console.log("\n" + "=".repeat(70));
console.log("ENTRY PRICE (first fill price) BY SYMBOL");
console.log("=".repeat(70));
const priceBySym = new Map<string, number[]>();
for (const f of fills) {
  const sym = symbolOf(f.ticker);
  const price = f.side === "yes" ? parseFloat(f.yes_price_dollars) : parseFloat(f.no_price_dollars);
  if (!priceBySym.has(sym)) priceBySym.set(sym, []);
  priceBySym.get(sym)!.push(price * 100);
}
for (const [sym, prices] of priceBySym) {
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  const pctAt6 = (prices.filter((p) => p <= 6).length / prices.length) * 100;
  console.log(`${sym.padEnd(8)} avg-entry=${avg.toFixed(2)}c  %-at-<=6c=${pctAt6.toFixed(0)}%  n-fills=${prices.length}`);
}
