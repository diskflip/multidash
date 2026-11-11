import { readFileSync } from "node:fs";
import { accountReportPath } from "./privateData.ts";

type Tick = { t: string; yes: number };
type WindowData = { ticker: string; result: string; trades: Tick[] };
const windows: WindowData[] = JSON.parse(readFileSync(accountReportPath("silver-ticks.json"), "utf8"));
console.log(`Loaded ${windows.length} windows, total ticks: ${windows.reduce((a,w)=>a+w.trades.length,0)}\n`);

function run(entry: number, tp: number | null) {
  let n = 0, sumEV = 0, tpHits = 0, wins = 0;
  const tpTimesSeconds: number[] = [];
  for (const w of windows) {
    const ticks = w.trades; // already time-sorted
    if (ticks.length === 0) continue;
    const resolvesYes = w.result === "yes";
    for (const side of ["yes", "no"] as const) {
      const priceOf = (yes: number) => (side === "yes" ? yes : 100 - yes);
      let entryIdx = -1;
      for (let i = 0; i < ticks.length; i++) {
        if (priceOf(ticks[i].yes) <= entry) { entryIdx = i; break; }
      }
      if (entryIdx === -1) continue;
      n++;
      let hitTp = false;
      if (tp !== null) {
        for (let j = entryIdx + 1; j < ticks.length; j++) { // strictly AFTER entry tick
          if (priceOf(ticks[j].yes) >= tp) {
            hitTp = true;
            const secs = (new Date(ticks[j].t).getTime() - new Date(ticks[entryIdx].t).getTime()) / 1000;
            tpTimesSeconds.push(secs);
            break;
          }
        }
      }
      if (hitTp) { sumEV += (tp! - entry); tpHits++; }
      else {
        const won = (side === "yes" && resolvesYes) || (side === "no" && !resolvesYes);
        if (won) wins++;
        sumEV += won ? (100 - entry) : -entry;
      }
    }
  }
  const avgTpSecs = tpTimesSeconds.length ? tpTimesSeconds.reduce((a,b)=>a+b,0)/tpTimesSeconds.length : null;
  return { n, ev: sumEV / n, tpHitRate: tpHits / n, avgTpSecs, winRate: wins / n };
}

console.log("=== TRUE TICK-LEVEL, entry=6c (no lookahead possible) ===\n");
for (const tp of [null, 30, 40, 50, 60, 70, 80, 85, 90]) {
  const r = run(6, tp);
  const label = tp === null ? "hold-to-expiry" : `take-profit@${tp}c`;
  console.log(
    `${label.padEnd(18)} n=${r.n}  EV=${r.ev>=0?"+":""}${r.ev.toFixed(2)}c/contract  ` +
    `tp-hit-rate=${(r.tpHitRate*100).toFixed(0)}%` +
    (r.avgTpSecs !== null ? `  avg-time-to-tp=${r.avgTpSecs.toFixed(0)}s` : "")
  );
}

console.log("\n=== entry threshold sweep, take-profit@70c, tick-level ===\n");
for (const entry of [4,5,6,7,8,10,12,15]) {
  const r = run(entry, 70);
  console.log(`entry<=${String(entry).padStart(2)}c  n=${String(r.n).padStart(3)}  EV=+${r.ev.toFixed(2)}c/contract`);
}
