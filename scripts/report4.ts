import { readFileSync } from "node:fs";
import { accountExportPath } from "./privateData.ts";

type Settlement = {
  ticker: string; market_result: string;
  yes_count_fp: string; yes_total_cost_dollars: string;
  no_count_fp: string; no_total_cost_dollars: string;
  fee_cost?: string; settled_time: string;
};

const settlements: Settlement[] = JSON.parse(readFileSync(accountExportPath("raw-settlements.json"), "utf8"))
  .filter((s: Settlement) => !s.ticker.startsWith("KXSOL"));

function symbolOf(t: string) { const m = t.match(/^(.+?)-\d{2}[A-Z]{3}\d{2}/); return m ? m[1] : t; }
function pnlOf(s: Settlement) {
  const yesCount = parseFloat(s.yes_count_fp), noCount = parseFloat(s.no_count_fp);
  const yesCost = parseFloat(s.yes_total_cost_dollars), noCost = parseFloat(s.no_total_cost_dollars);
  const fee = parseFloat(s.fee_cost ?? "0");
  const yc = yesCount > 0 ? yesCost / yesCount : 0, nc = noCount > 0 ? noCost / noCount : 0;
  const hedgedPairs = Math.min(yesCount, noCount);
  const net = hedgedPairs * 1 - hedgedPairs * (yc + nc) - ((yesCount - hedgedPairs) * yc + (noCount - hedgedPairs) * nc) - fee;
  const fullyUnhedged = hedgedPairs === 0 && (yesCount > 0 || noCount > 0);
  return { net, fullyUnhedged };
}

const symbols = ["KXBTC15M", "KXDOGE15M", "KXSILVER15M", "KXWTI15M", "KXETH15M", "KXGOLD15M", "KXBTCD"];
console.log("day        " + symbols.map(s => s.replace("KX","").replace("15M","").padStart(9)).join(""));
const byDay = new Map<string, Map<string, { net: number; n: number; unh: number }>>();
for (const s of settlements) {
  const day = s.settled_time.slice(0, 10);
  const sym = symbolOf(s.ticker);
  if (!symbols.includes(sym)) continue;
  const p = pnlOf(s);
  if (!byDay.has(day)) byDay.set(day, new Map());
  const m = byDay.get(day)!;
  if (!m.has(sym)) m.set(sym, { net: 0, n: 0, unh: 0 });
  const e = m.get(sym)!;
  e.net += p.net; e.n++; e.unh += p.fullyUnhedged ? 1 : 0;
}
for (const [day, m] of [...byDay.entries()].sort()) {
  const row = symbols.map(sym => {
    const e = m.get(sym);
    return e ? e.net.toFixed(0).padStart(9) : "".padStart(9);
  }).join("");
  console.log(day + "  " + row);
}

console.log("\nWeek totals:");
for (const sym of symbols) {
  let net = 0, n = 0, unh = 0;
  for (const m of byDay.values()) {
    const e = m.get(sym);
    if (e) { net += e.net; n += e.n; unh += e.unh; }
  }
  console.log(`${sym.padEnd(12)} net=$${net.toFixed(2).padStart(9)}  n=${n}  unhedged=${unh}/${n} (${((unh/n)*100).toFixed(0)}%)`);
}

// BTC excluding the single 08-12 22:00 outlier window
console.log("\nBTC15M excluding the single $760.79 08-12 22:00 window:");
let btcNet = 0, btcN = 0;
for (const s of settlements) {
  if (symbolOf(s.ticker) !== "KXBTC15M") continue;
  if (s.ticker === "KXBTC15M-26AUG121800-00") continue;
  const p = pnlOf(s);
  btcNet += p.net; btcN++;
}
console.log(`net=$${btcNet.toFixed(2)}  n=${btcN}`);
