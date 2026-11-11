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

const entry = 6;
const takeProfitLevels = [null, 30, 40, 50, 60, 70, 80, 85, 90];

for (const tp of takeProfitLevels) {
  let n = 0, sumEV = 0, tpHits = 0, expiryWins = 0, expiryLosses = 0;
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
      if (tp !== null) {
        for (let j = entryIdx; j < minutes.length; j++) {
          const h = side === "yes" ? minutes[j].yesHigh : minutes[j].noHigh;
          if (h >= tp) { hitTp = true; break; }
        }
      }

      if (hitTp) {
        sumEV += (tp! - entry);
        tpHits++;
      } else {
        const won = (side === "yes" && resolvesYes) || (side === "no" && !resolvesYes);
        if (won) { sumEV += (100 - entry); expiryWins++; }
        else { sumEV -= entry; expiryLosses++; }
      }
    }
  }
  const label = tp === null ? "hold-to-expiry (no take-profit)" : `take-profit @ ${tp}c`;
  console.log(`${label.padEnd(34)} EV=${(sumEV / n) >= 0 ? "+" : ""}${(sumEV / n).toFixed(2)}c/contract  n=${n}  tp-hits=${tpHits} (${((tpHits/n)*100).toFixed(0)}%)`);
}
