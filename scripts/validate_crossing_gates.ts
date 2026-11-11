// Focused walk-forward + day-by-day validation for the crossingCount family
// of gates, which looked like the most interpretable/stable candidates from
// the broad sweep (unlike the top-raw-improvement picks, which gutted 80%+
// of winners to get there — see analyze_painted_area.ts output). Integer
// thresholds need no percentile refitting, so train vs holdout is a direct
// apples-to-apples application of the same rule.
import { readFileSync } from "node:fs";
import { computePaintedArea, toBps, type PricePoint } from "./paintedArea.ts";
import { accountReportPath } from "./privateData.ts";

const DEEP_BPS = 8;

type Trade = {
  ticker: string;
  side: "yes" | "no";
  strike: number;
  entryFillTime: string;
  entryPriceCents: number;
  entryCountContracts: number;
  outcome: "win" | "loss";
  pnlDollars: number;
};

function loadJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function main() {
  const trades: Trade[] = loadJson(accountReportPath("btc_trades_clean.json")).filter((t: Trade) => t.entryPriceCents <= 10);
  const kraken: Record<string, { t: number; p: number }[]> = loadJson(accountReportPath("btc_kraken_history.json"));

  type Row = {
    day: string;
    outcome: "win" | "loss";
    pnlDollars: number;
    crossings: Record<number, number>;
    maxExcursionBelow: Record<number, number>;
  };
  const LOOKBACKS = [60, 90, 120, 180, 300, 600, 900];
  const rows: Row[] = [];

  for (const t of trades) {
    const key = `${t.ticker}|${t.side}`;
    const ticks = kraken[key] ?? [];
    if (ticks.length < 2) continue;
    const series: PricePoint[] = ticks.map((k) => ({ t: k.t, price: toBps(k.p, t.strike) })).sort((a, b) => a.t - b.t);
    const entryTs = new Date(t.entryFillTime).getTime() / 1000;
    const crossings: Record<number, number> = {};
    const maxExcursionBelow: Record<number, number> = {};
    for (const lb of LOOKBACKS) {
      const f = computePaintedArea(series, entryTs, lb, DEEP_BPS);
      crossings[lb] = f.crossingCount;
      maxExcursionBelow[lb] = f.maxExcursionBelow;
    }
    rows.push({ day: t.entryFillTime.slice(0, 10), outcome: t.outcome, pnlDollars: t.pnlDollars, crossings, maxExcursionBelow });
  }

  const sortedDays = [...new Set(rows.map((r) => r.day))].sort();
  const cutoffDay = sortedDays[Math.floor(sortedDays.length * 0.7)];
  const train = rows.filter((r) => r.day < cutoffDay);
  const holdout = rows.filter((r) => r.day >= cutoffDay);
  console.log(`train days < ${cutoffDay} (n=${train.length}), holdout >= ${cutoffDay} (n=${holdout.length})\n`);

  function evalOn(subset: Row[], passesFn: (r: Row) => boolean) {
    let wKept = 0, wRemoved = 0, lKept = 0, lRemoved = 0, base = 0, filtered = 0;
    for (const r of subset) {
      base += r.pnlDollars;
      if (passesFn(r)) {
        filtered += r.pnlDollars;
        r.outcome === "win" ? wKept++ : lKept++;
      } else {
        r.outcome === "win" ? wRemoved++ : lRemoved++;
      }
    }
    return { wKept, wRemoved, lKept, lRemoved, base, filtered, improvement: filtered - base };
  }

  function dayByDay(subset: Row[], passesFn: (r: Row) => boolean) {
    const byDay = new Map<string, { pnl: number; n: number }>();
    for (const r of subset) {
      if (!passesFn(r)) continue;
      const e = byDay.get(r.day) ?? { pnl: 0, n: 0 };
      e.pnl += r.pnlDollars;
      e.n++;
      byDay.set(r.day, e);
    }
    return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b));
  }

  function maxDrawdown(subset: Row[], passesFn: (r: Row) => boolean) {
    const kept = subset.filter(passesFn).sort((a, b) => a.day.localeCompare(b.day));
    let cum = 0, peak = 0, maxDd = 0;
    let worstStreak = 0, curStreak = 0;
    for (const r of kept) {
      cum += r.pnlDollars;
      peak = Math.max(peak, cum);
      maxDd = Math.max(maxDd, peak - cum);
      if (r.outcome === "loss") {
        curStreak++;
        worstStreak = Math.max(worstStreak, curStreak);
      } else {
        curStreak = 0;
      }
    }
    return { maxDrawdown: maxDd, worstLosingStreak: worstStreak, keptCount: kept.length };
  }

  const gates: Array<{ name: string; fn: (r: Row) => boolean }> = [
    { name: "crossingCount(600s) >= 1", fn: (r) => r.crossings[600] >= 1 },
    { name: "crossingCount(600s) >= 2", fn: (r) => r.crossings[600] >= 2 },
    { name: "crossingCount(300s) >= 1", fn: (r) => r.crossings[300] >= 1 },
    { name: "crossingCount(120s) >= 1", fn: (r) => r.crossings[120] >= 1 },
    { name: "crossingCount(900s) >= 1", fn: (r) => r.crossings[900] >= 1 },
    { name: "crossingCount(900s) >= 2", fn: (r) => r.crossings[900] >= 2 },
    { name: "crossingCount(900s) >= 3", fn: (r) => r.crossings[900] >= 3 },
    { name: "maxExcursionBelow(180s) >= 2.58 bps", fn: (r) => r.maxExcursionBelow[180] >= 2.58 },
  ];

  for (const g of gates) {
    const full = evalOn(rows, g.fn);
    const tr = evalOn(train, g.fn);
    const ho = evalOn(holdout, g.fn);
    const dd = maxDrawdown(rows, g.fn);
    console.log(`=== ${g.name} ===`);
    console.log(
      `  FULL:    win ${full.wKept}/${full.wKept + full.wRemoved}, loss removed ${full.lRemoved}/${full.lKept + full.lRemoved} | $${full.base.toFixed(0)} -> $${full.filtered.toFixed(0)} (${full.improvement >= 0 ? "+" : ""}${full.improvement.toFixed(0)})`
    );
    console.log(
      `  TRAIN:   win ${tr.wKept}/${tr.wKept + tr.wRemoved}, loss removed ${tr.lRemoved}/${tr.lKept + tr.lRemoved} | $${tr.base.toFixed(0)} -> $${tr.filtered.toFixed(0)} (${tr.improvement >= 0 ? "+" : ""}${tr.improvement.toFixed(0)})`
    );
    console.log(
      `  HOLDOUT: win ${ho.wKept}/${ho.wKept + ho.wRemoved}, loss removed ${ho.lRemoved}/${ho.lKept + ho.lRemoved} | $${ho.base.toFixed(0)} -> $${ho.filtered.toFixed(0)} (${ho.improvement >= 0 ? "+" : ""}${ho.improvement.toFixed(0)})`
    );
    console.log(`  Max drawdown (kept trades, chronological): $${dd.maxDrawdown.toFixed(0)}, worst losing streak: ${dd.worstLosingStreak}, kept n=${dd.keptCount}`);
    console.log();
  }

  // Day-by-day for the most promising conservative candidate
  console.log("Day-by-day for 'crossingCount(600s) >= 1':");
  for (const [day, { pnl, n }] of dayByDay(rows, (r) => r.crossings[600] >= 1)) {
    console.log(`  ${day}: n=${n}, pnl=$${pnl.toFixed(2)}`);
  }
}

main();
