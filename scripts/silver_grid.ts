import { readFileSync } from "node:fs";
import { accountReportPath } from "./privateData.ts";

type Candle = { end_period_ts: number; price: { high_dollars: string; low_dollars: string } };
type WindowData = { ticker: string; result: string; candles: Candle[] };
const windows: WindowData[] = JSON.parse(readFileSync(accountReportPath("silver-candles.json"), "utf8"));

type MinuteData = { yesLow: number; yesHigh: number; noLow: number; noHigh: number };
function buildMinutes(w: WindowData): MinuteData[] {
  const sorted = [...w.candles].sort((a, b) => a.end_period_ts - b.end_period_ts);
  return sorted.map((c) => {
    const lo = parseFloat(c.price.low_dollars) * 100;
    const hi = parseFloat(c.price.high_dollars) * 100;
    return { yesLow: lo, yesHigh: hi, noLow: 100 - hi, noHigh: 100 - lo };
  });
}
const allMinutes = windows.map((w) => ({ result: w.result, minutes: buildMinutes(w) }));

// entry <= E cents, exit: either "hold to expiry" (exit=null) or take-profit at X cents,
// found starting from the NEXT minute after entry (no same-minute lookahead).
function backtest(entry: number, exit: number | null) {
  let n = 0, sumEV = 0, hits = 0;
  for (const { result, minutes } of allMinutes) {
    const resolvesYes = result === "yes";
    for (const side of ["yes", "no"] as const) {
      let idx = -1;
      for (let i = 0; i < minutes.length; i++) {
        const lo = side === "yes" ? minutes[i].yesLow : minutes[i].noLow;
        if (lo <= entry) { idx = i; break; }
      }
      if (idx === -1) continue;
      n++;
      let hitExit = false;
      if (exit !== null && exit > entry) {
        for (let j = idx + 1; j < minutes.length; j++) {
          const h = side === "yes" ? minutes[j].yesHigh : minutes[j].noHigh;
          if (h >= exit) { hitExit = true; break; }
        }
      }
      if (hitExit) { sumEV += (exit! - entry); hits++; }
      else {
        const won = (side === "yes" && resolvesYes) || (side === "no" && !resolvesYes);
        sumEV += won ? (100 - entry) : -entry;
      }
    }
  }
  return { n, ev: n ? sumEV / n : null, hitRate: n ? hits / n : null };
}

const entries = [1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20, 25, 30];
const exits: (number | null)[] = [null, 10, 15, 20, 25, 30, 40, 50, 60, 70, 80, 85, 90, 95];

const rows: { entry: number; exit: number | null; n: number; ev: number }[] = [];
for (const e of entries) {
  for (const x of exits) {
    if (x !== null && x <= e) continue;
    const r = backtest(e, x);
    if (r.n === null || r.n < 5) continue; // drop combos with too few samples to mean anything
    rows.push({ entry: e, exit: x, n: r.n, ev: r.ev! });
  }
}

rows.sort((a, b) => b.ev - a.ev);
console.log("TOP 25 combos by EV/contract (min n=5 to filter pure noise):\n");
console.log("entry  exit        n    EV/contract");
for (const r of rows.slice(0, 25)) {
  console.log(`${String(r.entry).padStart(3)}c   ${(r.exit === null ? "hold" : r.exit + "c").padEnd(8)}  ${String(r.n).padStart(3)}  ${r.ev >= 0 ? "+" : ""}${r.ev.toFixed(2)}c`);
}

console.log("\nBASELINE (your current setup, 6c entry / 85c exit):");
const baseline = backtest(6, 85);
console.log(`n=${baseline.n}  EV=+${baseline.ev!.toFixed(2)}c/contract`);

console.log("\nBASELINE (6c entry / hold to expiry):");
const baseline2 = backtest(6, null);
console.log(`n=${baseline2.n}  EV=+${baseline2.ev!.toFixed(2)}c/contract`);
