import { readFileSync } from "node:fs";
import { accountExportPath } from "./privateData.ts";

type Settlement = {
  ticker: string; market_result: string;
  yes_count_fp: string; yes_total_cost_dollars: string;
  no_count_fp: string; no_total_cost_dollars: string;
  fee_cost?: string; settled_time: string;
};

const settlements: Settlement[] = JSON.parse(readFileSync(accountExportPath("raw-settlements.json"), "utf8"));
function symbolOf(t: string) { const m = t.match(/^(.+?)-\d{2}[A-Z]{3}\d{2}/); return m ? m[1] : t; }
function pnlOf(s: Settlement) {
  const yesCount = parseFloat(s.yes_count_fp), noCount = parseFloat(s.no_count_fp);
  const yesCost = parseFloat(s.yes_total_cost_dollars), noCost = parseFloat(s.no_total_cost_dollars);
  const fee = parseFloat(s.fee_cost ?? "0");
  const yc = yesCount > 0 ? yesCost / yesCount : 0, nc = noCount > 0 ? noCost / noCount : 0;
  const hedgedPairs = Math.min(yesCount, noCount);
  const net = hedgedPairs * 1 - hedgedPairs * (yc + nc) - ((yesCount - hedgedPairs) * yc + (noCount - hedgedPairs) * nc) - fee;
  const fullyUnhedged = hedgedPairs === 0 && (yesCount > 0 || noCount > 0);
  const totalCost = yesCost + noCost;
  return { net, hedgedPairs, fullyUnhedged, totalCost };
}

console.log("=".repeat(70));
console.log("DOGE + SILVER ONLY, BY DAY (the two profitable markets)");
console.log("=".repeat(70));
const byDaySym = new Map<string, Map<string, { n: number; net: number; stake: number; unhedged: number }>>();
for (const s of settlements) {
  const sym = symbolOf(s.ticker);
  if (sym !== "DOGE" && sym !== "SILVER") continue;
  const day = s.settled_time.slice(0, 10);
  const p = pnlOf(s);
  if (!byDaySym.has(day)) byDaySym.set(day, new Map());
  const m = byDaySym.get(day)!;
  if (!m.has(sym)) m.set(sym, { n: 0, net: 0, stake: 0, unhedged: 0 });
  const e = m.get(sym)!;
  e.n++; e.net += p.net; e.stake += p.totalCost; e.unhedged += p.fullyUnhedged ? 1 : 0;
}
for (const [day, m] of [...byDaySym.entries()].sort()) {
  for (const [sym, e] of m) {
    console.log(`${day} ${sym.padEnd(7)} n=${String(e.n).padStart(3)} net=$${e.net.toFixed(2).padStart(8)} avg-stake=$${(e.stake / e.n).toFixed(2)} unhedged=${e.unhedged}/${e.n}`);
  }
}

console.log("\n" + "=".repeat(70));
console.log("EVERYTHING EXCEPT DOGE/SILVER, BY DAY");
console.log("=".repeat(70));
const others = new Map<string, { n: number; net: number }>();
for (const s of settlements) {
  const sym = symbolOf(s.ticker);
  if (sym === "DOGE" || sym === "SILVER") continue;
  const day = s.settled_time.slice(0, 10);
  const p = pnlOf(s);
  if (!others.has(day)) others.set(day, { n: 0, net: 0 });
  const e = others.get(day)!;
  e.n++; e.net += p.net;
}
for (const [day, e] of [...others.entries()].sort()) {
  console.log(`${day} n=${String(e.n).padStart(3)} net=$${e.net.toFixed(2)}`);
}

console.log("\n" + "=".repeat(70));
console.log("COUNTERFACTUAL: DOGE+SILVER ONLY vs ACTUAL (all markets)");
console.log("=".repeat(70));
let dogeSilverTotal = 0, allTotal = 0;
for (const s of settlements) {
  const p = pnlOf(s);
  allTotal += p.net;
  const sym = symbolOf(s.ticker);
  if (sym === "DOGE" || sym === "SILVER") dogeSilverTotal += p.net;
}
console.log(`Actual (all 6 markets): $${allTotal.toFixed(2)}`);
console.log(`DOGE+SILVER only:       $${dogeSilverTotal.toFixed(2)}`);
console.log(`Everything else:        $${(allTotal - dogeSilverTotal).toFixed(2)}`);
