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

function run(entry: number, tp: number | null, excludeEntryMinuteHigh: boolean) {
  let n = 0, sumEV = 0, tpHits = 0;
  for (const w of windows) {
    const minutes = buildMinutes(w);
    if (minutes.length === 0) continue;
    const resolvesYes = w.result === "yes";
    for (const side of ["yes", "no"] as const) {
      let entryIdx = -1;
      for (let i = 0; i < minutes.length; i++) {
        const lo = side === "yes" ? minutes[i].yesLow : minutes[i].noLow;
        if (lo <= entry) { entryIdx = i; break; }
      }
      if (entryIdx === -1) continue;
      n++;
      const searchStart = excludeEntryMinuteHigh ? entryIdx + 1 : entryIdx;
      let hitTp = false;
      if (tp !== null) {
        for (let j = searchStart; j < minutes.length; j++) {
          const h = side === "yes" ? minutes[j].yesHigh : minutes[j].noHigh;
          if (h >= tp) { hitTp = true; break; }
        }
      }
      if (hitTp) { sumEV += (tp! - entry); tpHits++; }
      else {
        const won = (side === "yes" && resolvesYes) || (side === "no" && !resolvesYes);
        sumEV += won ? (100 - entry) : -entry;
      }
    }
  }
  return { n, ev: sumEV / n, tpHitRate: tpHits / n };
}

console.log("Comparing WITH vs WITHOUT same-minute lookahead, entry=6c:\n");
for (const tp of [null, 40, 50, 60, 70, 80, 85, 90]) {
  const withLookahead = run(6, tp, false);
  const fixed = run(6, tp, true);
  const label = tp === null ? "hold-to-expiry" : `take-profit@${tp}c`;
  console.log(
    `${label.padEnd(18)} biased(same-min)=+${withLookahead.ev.toFixed(2)}c  ` +
    `corrected(next-min+)=+${fixed.ev.toFixed(2)}c  (tp-hit-rate ${(fixed.tpHitRate*100).toFixed(0)}%)`
  );
}
