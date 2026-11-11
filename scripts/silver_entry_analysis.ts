import { readFileSync } from "node:fs";
import { accountReportPath } from "./privateData.ts";

type Candle = {
  end_period_ts: number;
  price: { close_dollars: string; high_dollars: string; low_dollars: string; open_dollars: string };
  yes_ask?: { close_dollars: string; high_dollars: string; low_dollars: string; open_dollars: string };
  yes_bid?: { close_dollars: string; high_dollars: string; low_dollars: string; open_dollars: string };
};
type WindowData = { ticker: string; result: string; candles: Candle[] };

const windows: WindowData[] = JSON.parse(readFileSync(accountReportPath("silver-candles.json"), "utf8"));
console.log(`Loaded ${windows.length} SILVER windows\n`);

// For each window, build per-minute low/high for YES price (in cents), and NO price = 100 - yes.
type MinuteData = { yesLow: number; yesHigh: number; noLow: number; noHigh: number; minutesFromClose: number };

function buildMinutes(w: WindowData): MinuteData[] {
  const sorted = [...w.candles].sort((a, b) => a.end_period_ts - b.end_period_ts);
  const lastTs = sorted[sorted.length - 1]?.end_period_ts ?? 0;
  return sorted.map((c) => {
    const lo = parseFloat(c.price.low_dollars) * 100;
    const hi = parseFloat(c.price.high_dollars) * 100;
    return {
      yesLow: lo,
      yesHigh: hi,
      noLow: 100 - hi,
      noHigh: 100 - lo,
      minutesFromClose: (lastTs - c.end_period_ts) / 60,
    };
  });
}

// For a given entry threshold E cents: does yesLow or noLow touch <= E at any minute?
// If so, take the FIRST such minute, then look at the max high (on that same side) in all
// minutes from that point to close, as the best subsequent exit opportunity.
// Also record the actual settlement outcome (100 or 0) for a hold-to-expiry comparison.
const thresholds = [3, 4, 5, 6, 7, 8, 10, 12, 15, 20];

type Stat = { opportunities: number; sumMaxAfter: number; sumEntry: number; expiryWinCents: number; expiryLossCents: number; n: number };
const stats = new Map<number, Stat>();
for (const t of thresholds) stats.set(t, { opportunities: 0, sumMaxAfter: 0, sumEntry: 0, expiryWinCents: 0, expiryLossCents: 0, n: 0 });

for (const w of windows) {
  const minutes = buildMinutes(w);
  if (minutes.length === 0) continue;
  const resolvesYes = w.result === "yes";

  for (const t of thresholds) {
    const s = stats.get(t)!;
    // check YES side touching <= t
    let yesEntryIdx = -1;
    for (let i = 0; i < minutes.length; i++) {
      if (minutes[i].yesLow <= t) { yesEntryIdx = i; break; }
    }
    let noEntryIdx = -1;
    for (let i = 0; i < minutes.length; i++) {
      if (minutes[i].noLow <= t) { noEntryIdx = i; break; }
    }

    for (const [entryIdx, side] of [[yesEntryIdx, "yes"], [noEntryIdx, "no"]] as const) {
      if (entryIdx === -1) continue;
      s.n++;
      s.opportunities++;
      // entryPrice = the limit price itself (t) — what a resting limit order there would
      // actually fill at, not the minute's observed low (which can overshoot well below t).
      const entryPrice = t;
      s.sumEntry += entryPrice;
      let maxAfter = entryPrice;
      for (let j = entryIdx; j < minutes.length; j++) {
        const h = side === "yes" ? minutes[j].yesHigh : minutes[j].noHigh;
        if (h > maxAfter) maxAfter = h;
      }
      s.sumMaxAfter += maxAfter;
      const wonAtExpiry = (side === "yes" && resolvesYes) || (side === "no" && !resolvesYes);
      if (wonAtExpiry) s.expiryWinCents += (100 - entryPrice);
      else s.expiryLossCents += entryPrice;
    }
  }
}

console.log("Entry threshold sweep across all 51 SILVER windows this week (both YES-side and NO-side dips counted):");
console.log("threshold | opportunities | avg entry | avg MAX price reached after entry | avg hold-to-expiry EV (cents/contract)");
for (const t of thresholds) {
  const s = stats.get(t)!;
  if (s.n === 0) { console.log(`${t}c: no opportunities`); continue; }
  const avgEntry = s.sumEntry / s.n;
  const avgMaxAfter = s.sumMaxAfter / s.n;
  const evPerContract = (s.expiryWinCents - s.expiryLossCents) / s.n;
  console.log(
    `${String(t).padStart(3)}c | opp=${String(s.opportunities).padStart(3)} | avgEntry=${avgEntry.toFixed(2)}c | avgMaxAfterEntry=${avgMaxAfter.toFixed(2)}c | holdToExpiryEV=${evPerContract >= 0 ? "+" : ""}${evPerContract.toFixed(2)}c/contract`
  );
}
