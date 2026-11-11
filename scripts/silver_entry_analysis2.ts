import { readFileSync } from "node:fs";
import { accountReportPath } from "./privateData.ts";

type Candle = {
  end_period_ts: number;
  price: { close_dollars: string; high_dollars: string; low_dollars: string; open_dollars: string };
};
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

const thresholds = [3, 4, 5, 6, 7, 8, 10, 12, 15, 20];
const exitTargets = [40, 50, 60, 70, 85, 95];

for (const t of thresholds) {
  let n = 0, wins = 0, sumEV = 0;
  const exitHits = new Map<number, number>();
  for (const e of exitTargets) exitHits.set(e, 0);

  for (const w of windows) {
    const minutes = buildMinutes(w);
    if (minutes.length === 0) continue;
    const resolvesYes = w.result === "yes";

    for (const side of ["yes", "no"] as const) {
      let entryIdx = -1;
      for (let i = 0; i < minutes.length; i++) {
        const lo = side === "yes" ? minutes[i].yesLow : minutes[i].noLow;
        if (lo <= t) { entryIdx = i; break; }
      }
      if (entryIdx === -1) continue;
      n++;
      const won = (side === "yes" && resolvesYes) || (side === "no" && !resolvesYes);
      if (won) wins++;
      sumEV += won ? (100 - t) : -t;

      let maxAfter = t;
      for (let j = entryIdx; j < minutes.length; j++) {
        const h = side === "yes" ? minutes[j].yesHigh : minutes[j].noHigh;
        if (h > maxAfter) maxAfter = h;
      }
      for (const e of exitTargets) {
        if (maxAfter >= e) exitHits.set(e, exitHits.get(e)! + 1);
      }
    }
  }

  console.log(`\n=== entry <= ${t}c ===  n=${n}  win-rate=${((wins / n) * 100).toFixed(1)}%  hold-to-expiry EV=${(sumEV / n).toFixed(2)}c/contract`);
  for (const e of exitTargets) {
    const hitRate = (exitHits.get(e)! / n) * 100;
    // EV if you took profit at e cents whenever it was reached, otherwise held to expiry
    console.log(`   reaches >=${e}c afterward: ${hitRate.toFixed(1)}% of the time`);
  }
}
