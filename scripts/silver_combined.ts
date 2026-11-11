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

const entries = [4, 5, 6, 7, 8, 10, 12, 15];
const tp = 70;

console.log(`Entry threshold sweep WITH take-profit @ ${tp}c (instead of pure hold-to-expiry):\n`);
for (const entry of entries) {
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
      let hitTp = false;
      for (let j = entryIdx; j < minutes.length; j++) {
        const h = side === "yes" ? minutes[j].yesHigh : minutes[j].noHigh;
        if (h >= tp) { hitTp = true; break; }
      }
      if (hitTp) { sumEV += (tp - entry); tpHits++; }
      else {
        const won = (side === "yes" && resolvesYes) || (side === "no" && !resolvesYes);
        sumEV += won ? (100 - entry) : -entry;
      }
    }
  }
  console.log(`entry<=${String(entry).padStart(2)}c  n=${String(n).padStart(3)}  tp-hit-rate=${((tpHits/n)*100).toFixed(0).padStart(3)}%  EV=+${(sumEV/n).toFixed(2)}c/contract`);
}
