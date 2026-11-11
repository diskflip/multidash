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

function holdToExpiry(entry: number) {
  let n = 0, wins = 0, sumEV = 0;
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
      const won = (side === "yes" && resolvesYes) || (side === "no" && !resolvesYes);
      if (won) wins++;
      sumEV += won ? (100 - entry) : -entry;
    }
  }
  return { n, winRate: wins / n, ev: sumEV / n };
}

console.log("Clean win-rate/EV by entry threshold, hold-to-expiry (this is what's really driving the grid result):\n");
console.log("entry | n  | win-rate | implied fair-odds price | actual entry cost | edge");
for (const e of [1,2,3,4,5,6,7,8,10,12,15,20,25,30]) {
  const r = holdToExpiry(e);
  const fairPrice = r.winRate * 100; // if market were priced exactly at true win probability
  console.log(`${String(e).padStart(3)}c | ${String(r.n).padStart(3)} | ${(r.winRate*100).toFixed(1).padStart(5)}% | ${fairPrice.toFixed(1).padStart(5)}c | ${String(e).padStart(3)}c | edge=${(fairPrice-e)>=0?"+":""}${(fairPrice-e).toFixed(1)}c  EV=${r.ev>=0?"+":""}${r.ev.toFixed(2)}c`);
}

console.log("\nFull row for entry=15c across all exits (checking it's not one lucky cell):");
function backtest(entry: number, exit: number | null) {
  let n = 0, sumEV = 0;
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
      if (exit !== null) {
        for (let j = idx + 1; j < minutes.length; j++) {
          const h = side === "yes" ? minutes[j].yesHigh : minutes[j].noHigh;
          if (h >= exit) { hitExit = true; break; }
        }
      }
      if (hitExit) sumEV += (exit! - entry);
      else {
        const won = (side === "yes" && resolvesYes) || (side === "no" && !resolvesYes);
        sumEV += won ? (100 - entry) : -entry;
      }
    }
  }
  return { n, ev: sumEV / n };
}
for (const x of [null, 30, 40, 50, 60, 70, 80, 85, 90, 95]) {
  const r = backtest(15, x);
  console.log(`  exit=${x===null?"hold":x+"c"}: n=${r.n} EV=+${r.ev.toFixed(2)}c`);
}
