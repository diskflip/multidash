import { readFileSync } from "node:fs";
import { accountReportPath } from "./privateData.ts";

type Candle = { end_period_ts: number; price: { high_dollars: string; low_dollars: string } };
type WindowData = { ticker: string; result: string; candles: Candle[] };
const windows: WindowData[] = JSON.parse(readFileSync(accountReportPath("silver-candles.json"), "utf8"));

type MinuteData = { yesLow: number; yesHigh: number; noLow: number; noHigh: number; minutesLeft: number };
function buildMinutes(w: WindowData): MinuteData[] {
  const sorted = [...w.candles].sort((a, b) => a.end_period_ts - b.end_period_ts);
  const lastTs = sorted[sorted.length - 1]?.end_period_ts ?? 0;
  return sorted.map((c) => {
    const lo = parseFloat(c.price.low_dollars) * 100;
    const hi = parseFloat(c.price.high_dollars) * 100;
    return { yesLow: lo, yesHigh: hi, noLow: 100 - hi, noHigh: 100 - lo, minutesLeft: (lastTs - c.end_period_ts) / 60 };
  });
}

// ============ STRATEGY A: momentum / breakout — buy the side that's ALREADY winning big ============
console.log("=".repeat(70));
console.log("STRATEGY A: buy momentum (side already trading >= T), not the cheap dip");
console.log("=".repeat(70));
for (const T of [70, 75, 80, 85, 90, 95]) {
  let n = 0, wins = 0, sumEV = 0;
  for (const w of windows) {
    const minutes = buildMinutes(w);
    const resolvesYes = w.result === "yes";
    for (const side of ["yes", "no"] as const) {
      let idx = -1;
      for (let i = 0; i < minutes.length; i++) {
        const hi = side === "yes" ? minutes[i].yesHigh : minutes[i].noHigh;
        if (hi >= T) { idx = i; break; }
      }
      if (idx === -1) continue;
      n++;
      const won = (side === "yes" && resolvesYes) || (side === "no" && !resolvesYes);
      if (won) wins++;
      sumEV += won ? (100 - T) : -T;
    }
  }
  console.log(`entry when price first hits >=${T}c: n=${n}  win-rate=${((wins/n)*100).toFixed(1)}%  EV=${(sumEV/n)>=0?"+":""}${(sumEV/n).toFixed(2)}c/contract  trades/day~${(n/7).toFixed(1)}`);
}

// ============ STRATEGY B: time-remaining filter on the existing 6c dip entry ============
console.log("\n" + "=".repeat(70));
console.log("STRATEGY B: same 6c dip entry, but filtered by time remaining in window at entry");
console.log("=".repeat(70));
const buckets = [[10,15],[5,10],[2,5],[0,2]] as const;
for (const [lo, hi] of buckets) {
  let n = 0, wins = 0, sumEV = 0;
  for (const w of windows) {
    const minutes = buildMinutes(w);
    const resolvesYes = w.result === "yes";
    for (const side of ["yes", "no"] as const) {
      let idx = -1;
      for (let i = 0; i < minutes.length; i++) {
        const p = side === "yes" ? minutes[i].yesLow : minutes[i].noLow;
        if (p <= 6) { idx = i; break; }
      }
      if (idx === -1) continue;
      const minutesLeft = minutes[idx].minutesLeft;
      if (!(minutesLeft > lo && minutesLeft <= hi)) continue;
      n++;
      const won = (side === "yes" && resolvesYes) || (side === "no" && !resolvesYes);
      if (won) wins++;
      sumEV += won ? 94 : -6;
    }
  }
  if (n === 0) { console.log(`${lo}-${hi}min left: no opportunities`); continue; }
  console.log(`entry with ${lo}-${hi}min left: n=${n}  win-rate=${((wins/n)*100).toFixed(1)}%  EV=${(sumEV/n)>=0?"+":""}${(sumEV/n).toFixed(2)}c/contract`);
}

// ============ STRATEGY C: multi-touch — does the SAME window offer repeat entries? ============
console.log("\n" + "=".repeat(70));
console.log("STRATEGY C: how often does a window offer MULTIPLE separate <=6c touches (scalp potential)?");
console.log("=".repeat(70));
const touchCounts = new Map<number, number>();
for (const w of windows) {
  const minutes = buildMinutes(w);
  let touches = 0;
  let wasBelow = false;
  for (const m of minutes) {
    const below = m.yesLow <= 6 || m.noLow <= 6;
    if (below && !wasBelow) touches++;
    wasBelow = below;
  }
  touchCounts.set(touches, (touchCounts.get(touches) ?? 0) + 1);
}
for (const [touches, count] of [...touchCounts.entries()].sort((a,b)=>a[0]-b[0])) {
  console.log(`${touches} separate touches: ${count} windows (${((count/windows.length)*100).toFixed(0)}%)`);
}

// ============ STRATEGY D: fade the spike — sell into a >=90c spike, buy the other side cheap immediately after ============
console.log("\n" + "=".repeat(70));
console.log("STRATEGY D: does a >=90c spike often reverse hard (fade opportunity)?");
console.log("=".repeat(70));
{
  let n = 0, reversedToUnder50 = 0, reversedToUnder20 = 0, wins = 0, sumEV = 0;
  for (const w of windows) {
    const minutes = buildMinutes(w);
    const resolvesYes = w.result === "yes";
    for (const side of ["yes", "no"] as const) {
      let idx = -1;
      for (let i = 0; i < minutes.length; i++) {
        const hi = side === "yes" ? minutes[i].yesHigh : minutes[i].noHigh;
        if (hi >= 90) { idx = i; break; }
      }
      if (idx === -1 || idx === minutes.length - 1) continue;
      n++;
      let minAfter = 100;
      for (let j = idx + 1; j < minutes.length; j++) {
        const lo = side === "yes" ? minutes[j].yesLow : minutes[j].noLow;
        if (lo < minAfter) minAfter = lo;
      }
      if (minAfter < 50) reversedToUnder50++;
      if (minAfter < 20) reversedToUnder20++;
      const won = (side === "yes" && resolvesYes) || (side === "no" && !resolvesYes);
      if (won) wins++;
    }
  }
  console.log(`spikes to >=90c: n=${n}, then later drop back under 50c: ${reversedToUnder50} (${((reversedToUnder50/n)*100).toFixed(0)}%), under 20c: ${reversedToUnder20} (${((reversedToUnder20/n)*100).toFixed(0)}%)`);
  console.log(`of those spikes, side that spiked to 90c+ still WON at expiry: ${((wins/n)*100).toFixed(1)}% of the time`);
}
