// Main entry-regime backtest: computes painted-area / crossing features at
// every lookback for every clean BTC trade, compares winners vs losers,
// sweeps single-feature gates for real-dollar improvement, and validates on
// a chronological holdout split. Read-only analysis — no orders, no live
// bot changes. Writes full detail to the private report directory and
// prints the headline tables to stdout.
import { readFileSync, writeFileSync } from "node:fs";
import { computePaintedArea, toBps, type PricePoint } from "./paintedArea.ts";
import { accountReportPath } from "./privateData.ts";

const LOOKBACKS = [5, 10, 15, 30, 60, 90, 120, 180, 300, 600, 900];
const YES50_MIN_LOOKBACK = 300; // below this, 1-min candles are too coarse — reported as unavailable
const DEEP_BPS = 8; // "deep" excursion threshold for BTC-vs-strike, in bps
const DEEP_YES_CENTS = 30; // matches the user's own example (20c/80c bands around 50)

type Trade = {
  ticker: string;
  side: "yes" | "no";
  strike: number;
  openTime: string;
  closeTime: string;
  orderPlacedTime: string;
  entryFillTime: string;
  entryPriceCents: number;
  entryCountContracts: number;
  minutesRemainingAtEntry: number;
  minutesElapsedAtEntry: number;
  outcome: "win" | "loss";
  pnlDollars: number;
};

function loadJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function buildBtcSeries(ticks: { t: number; p: number }[], strike: number): PricePoint[] {
  return ticks
    .map((k) => ({ t: k.t, price: toBps(k.p, strike) }))
    .sort((a, b) => a.t - b.t);
}

function buildYesSeries(candles: { t: number; yesClose: number }[]): PricePoint[] {
  return candles
    .filter((c) => Number.isFinite(c.yesClose))
    .map((c) => ({ t: c.t, price: c.yesClose - 50 }))
    .sort((a, b) => a.t - b.t);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function summarize(values: number[]) {
  const s = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return {
    n: s.length,
    p10: percentile(s, 0.1),
    p25: percentile(s, 0.25),
    p50: percentile(s, 0.5),
    p75: percentile(s, 0.75),
    p90: percentile(s, 0.9),
    mean: s.length ? s.reduce((a, b) => a + b, 0) / s.length : NaN,
  };
}

async function main() {
  const trades: Trade[] = loadJson(accountReportPath("btc_trades_clean.json")).filter((t: Trade) => t.entryPriceCents <= 10);
  const kraken: Record<string, { t: number; p: number }[]> = loadJson(accountReportPath("btc_kraken_history.json"));
  const candles: Record<string, { t: number; yesClose: number }[]> = loadJson(accountReportPath("btc_kalshi_candles.json"));

  console.log(`Trades to analyze: ${trades.length}`);

  type Row = {
    ticker: string;
    side: string;
    day: string;
    outcome: "win" | "loss";
    pnlDollars: number;
    entryCountContracts: number;
    minutesRemainingAtEntry: number;
    minutesElapsedAtEntry: number;
    btc: Record<number, ReturnType<typeof computePaintedArea>>;
    yes: Record<number, ReturnType<typeof computePaintedArea> | null>;
  };

  const rows: Row[] = [];
  let missingBtc = 0;
  let missingYes = 0;

  for (const t of trades) {
    const key = `${t.ticker}|${t.side}`;
    const entryTs = new Date(t.entryFillTime).getTime() / 1000;
    const btcTicks = kraken[key] ?? [];
    if (btcTicks.length < 2) {
      missingBtc++;
      continue;
    }
    const btcSeries = buildBtcSeries(btcTicks, t.strike);

    const candleRows = candles[t.ticker] ?? [];
    const yesSeries = buildYesSeries(candleRows);
    if (yesSeries.length < 2) missingYes++;

    const secondsElapsed = t.minutesElapsedAtEntry * 60;

    const btcFeatures: Record<number, ReturnType<typeof computePaintedArea>> = {};
    const yesFeatures: Record<number, ReturnType<typeof computePaintedArea> | null> = {};
    for (const lb of LOOKBACKS) {
      btcFeatures[lb] = computePaintedArea(btcSeries, entryTs, lb, DEEP_BPS);
      if (lb >= YES50_MIN_LOOKBACK && secondsElapsed >= lb * 0.9 && yesSeries.length >= 2) {
        yesFeatures[lb] = computePaintedArea(yesSeries, entryTs, lb, DEEP_YES_CENTS);
      } else {
        yesFeatures[lb] = null;
      }
    }

    rows.push({
      ticker: t.ticker,
      side: t.side,
      day: t.entryFillTime.slice(0, 10),
      outcome: t.outcome,
      pnlDollars: t.pnlDollars,
      entryCountContracts: t.entryCountContracts,
      minutesRemainingAtEntry: t.minutesRemainingAtEntry,
      minutesElapsedAtEntry: t.minutesElapsedAtEntry,
      btc: btcFeatures,
      yes: yesFeatures,
    });
  }

  console.log(`Rows with usable BTC history: ${rows.length} (missing: ${missingBtc})`);
  console.log(`Rows with usable YES candle history: ${rows.length - missingYes} (missing: ${missingYes})`);

  const wins = rows.filter((r) => r.outcome === "win");
  const losses = rows.filter((r) => r.outcome === "loss");
  console.log(`Wins: ${wins.length}, Losses: ${losses.length}, baseline net P&L: $${rows.reduce((s, r) => s + r.pnlDollars, 0).toFixed(2)}`);

  // ---- 1. Winner vs loser distributions per feature per lookback ----
  const featureNames = [
    "totalActivity",
    "balance",
    "twoSidedAreaScore",
    "crossingCount",
    "deepCrossingCount",
    "maxExcursionAbove",
    "maxExcursionBelow",
    "imbalance",
    "currentRunSeconds",
  ] as const;

  const distributionReport: any = { btc: {}, yes: {} };
  for (const signal of ["btc", "yes"] as const) {
    for (const lb of LOOKBACKS) {
      if (signal === "yes" && lb < YES50_MIN_LOOKBACK) continue;
      const key = `${lb}s`;
      distributionReport[signal][key] = {};
      const winVals = wins.map((r) => (signal === "btc" ? r.btc[lb] : r.yes[lb])).filter((f) => f !== null && f !== undefined);
      const lossVals = losses.map((r) => (signal === "btc" ? r.btc[lb] : r.yes[lb])).filter((f) => f !== null && f !== undefined);
      distributionReport[signal][key].coverage = { wins: winVals.length, losses: lossVals.length };
      for (const feat of featureNames) {
        distributionReport[signal][key][feat] = {
          winners: summarize(winVals.map((f: any) => f[feat])),
          losers: summarize(lossVals.map((f: any) => f[feat])),
        };
      }
    }
  }

  // ---- 2. Single-feature threshold sweep, real-dollar filter_improvement ----
  type GateCandidate = {
    signal: "btc" | "yes";
    lookback: number;
    feature: string;
    direction: "min" | "max";
    threshold: number;
    winnersKept: number;
    winnersRemoved: number;
    lossesKept: number;
    lossesRemoved: number;
    baselinePnl: number;
    filteredPnl: number;
    improvement: number;
    trainImprovement?: number;
    holdoutImprovement?: number;
  };

  const sortedDays = [...new Set(rows.map((r) => r.day))].sort();
  const cutoffIdx = Math.floor(sortedDays.length * 0.7);
  const trainCutoffDay = sortedDays[cutoffIdx];
  console.log(`\nChronological split: train < ${trainCutoffDay}, holdout >= ${trainCutoffDay} (${cutoffIdx}/${sortedDays.length} days train)`);

  function evalGate(
    subset: Row[],
    signal: "btc" | "yes",
    lookback: number,
    feature: string,
    direction: "min" | "max",
    threshold: number
  ) {
    let winnersKept = 0, winnersRemoved = 0, lossesKept = 0, lossesRemoved = 0;
    let baselinePnl = 0, filteredPnl = 0;
    for (const r of subset) {
      const f = signal === "btc" ? r.btc[lookback] : r.yes[lookback];
      if (!f) continue; // no data for this lookback -> can't gate, excluded from this comparison
      baselinePnl += r.pnlDollars;
      const val = (f as any)[feature];
      const passes = direction === "min" ? val >= threshold : val <= threshold;
      if (passes) {
        filteredPnl += r.pnlDollars;
        if (r.outcome === "win") winnersKept++; else lossesKept++;
      } else {
        if (r.outcome === "win") winnersRemoved++; else lossesRemoved++;
      }
    }
    return { winnersKept, winnersRemoved, lossesKept, lossesRemoved, baselinePnl, filteredPnl };
  }

  const candidates: GateCandidate[] = [];
  const percentileGrid = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

  for (const signal of ["btc", "yes"] as const) {
    for (const lb of LOOKBACKS) {
      if (signal === "yes" && lb < YES50_MIN_LOOKBACK) continue;
      for (const feat of featureNames) {
        const allVals = rows
          .map((r) => (signal === "btc" ? r.btc[lb] : r.yes[lb]))
          .filter((f) => f)
          .map((f: any) => f[feat])
          .filter((v) => Number.isFinite(v))
          .sort((a, b) => a - b);
        if (allVals.length < 30) continue;
        for (const p of percentileGrid) {
          const threshold = percentile(allVals, p);
          for (const direction of ["min", "max"] as const) {
            const full = evalGate(rows, signal, lb, feat, direction, threshold);
            if (full.winnersKept + full.lossesKept < 20) continue; // too little left to matter
            const improvement = full.filteredPnl - full.baselinePnl;
            candidates.push({
              signal,
              lookback: lb,
              feature: feat,
              direction,
              threshold,
              ...full,
              improvement,
            } as GateCandidate);
          }
        }
      }
    }
  }

  candidates.sort((a, b) => b.improvement - a.improvement);
  console.log(`\nTop 15 single-feature gate candidates by real-dollar improvement (full sample):`);
  for (const c of candidates.slice(0, 15)) {
    console.log(
      `  ${c.signal}/${c.lookback}s ${c.feature} ${c.direction}>=${c.threshold.toFixed(3)} | ` +
        `win kept ${c.winnersKept}/${c.winnersKept + c.winnersRemoved}, loss removed ${c.lossesRemoved}/${c.lossesKept + c.lossesRemoved} | ` +
        `$${c.baselinePnl.toFixed(0)} -> $${c.filteredPnl.toFixed(0)} (${c.improvement >= 0 ? "+" : ""}${c.improvement.toFixed(0)})`
    );
  }

  console.log(`\nBest candidate at each winner-retention floor (so we don't just see gut-the-winners gates):`);
  for (const floor of [0.8, 0.65, 0.5, 0.35, 0.2]) {
    const inBand = candidates.filter((c) => c.winnersKept / (c.winnersKept + c.winnersRemoved) >= floor);
    if (inBand.length === 0) {
      console.log(`  >=${floor * 100}% winners kept: none found`);
      continue;
    }
    const best = inBand[0]; // already sorted by improvement desc
    console.log(
      `  >=${floor * 100}% winners kept: ${best.signal}/${best.lookback}s ${best.feature} ${best.direction}>=${best.threshold.toFixed(3)} | ` +
        `win kept ${best.winnersKept}/${best.winnersKept + best.winnersRemoved}, loss removed ${best.lossesRemoved}/${best.lossesKept + best.lossesRemoved} | ` +
        `$${best.baselinePnl.toFixed(0)} -> $${best.filteredPnl.toFixed(0)} (${best.improvement >= 0 ? "+" : ""}${best.improvement.toFixed(0)})`
    );
  }

  // Walk-forward check on the top candidates: does the SAME threshold
  // (fit on nothing — these are just percentile cuts over the whole
  // sample, so re-evaluate train vs holdout using train-only thresholds)
  console.log(`\nWalk-forward validation of top 10 (threshold refit on TRAIN days only, applied to HOLDOUT):`);
  const trainRows = rows.filter((r) => r.day < trainCutoffDay);
  const holdoutRows = rows.filter((r) => r.day >= trainCutoffDay);
  const walkForward: any[] = [];
  for (const c of candidates.slice(0, 10)) {
    const trainVals = trainRows
      .map((r) => (c.signal === "btc" ? r.btc[c.lookback] : r.yes[c.lookback]))
      .filter((f) => f)
      .map((f: any) => f[c.feature])
      .filter((v) => Number.isFinite(v))
      .sort((a, b) => a - b);
    if (trainVals.length < 15) continue;
    // Refit: use the same percentile rank the original threshold had in the full sample.
    const fullVals = rows
      .map((r) => (c.signal === "btc" ? r.btc[c.lookback] : r.yes[c.lookback]))
      .filter((f) => f)
      .map((f: any) => f[c.feature])
      .filter((v) => Number.isFinite(v))
      .sort((a, b) => a - b);
    const rank = fullVals.findIndex((v) => v >= c.threshold) / fullVals.length;
    const trainThreshold = percentile(trainVals, Math.min(Math.max(rank, 0), 1));

    const trainResult = evalGate(trainRows, c.signal, c.lookback, c.feature, c.direction, trainThreshold);
    const holdoutResult = evalGate(holdoutRows, c.signal, c.lookback, c.feature, c.direction, trainThreshold);
    const trainImprovement = trainResult.filteredPnl - trainResult.baselinePnl;
    const holdoutImprovement = holdoutResult.filteredPnl - holdoutResult.baselinePnl;
    walkForward.push({ ...c, trainThreshold, trainImprovement, holdoutImprovement, holdoutResult });
    console.log(
      `  ${c.signal}/${c.lookback}s ${c.feature} ${c.direction} (train-fit thresh=${trainThreshold.toFixed(3)}) | ` +
        `train: $${trainResult.baselinePnl.toFixed(0)}->$${trainResult.filteredPnl.toFixed(0)} (${trainImprovement >= 0 ? "+" : ""}${trainImprovement.toFixed(0)}) | ` +
        `holdout: $${holdoutResult.baselinePnl.toFixed(0)}->$${holdoutResult.filteredPnl.toFixed(0)} (${holdoutImprovement >= 0 ? "+" : ""}${holdoutImprovement.toFixed(0)}), ` +
        `win kept ${holdoutResult.winnersKept}/${holdoutResult.winnersKept + holdoutResult.winnersRemoved}, loss removed ${holdoutResult.lossesRemoved}/${holdoutResult.lossesKept + holdoutResult.lossesRemoved}`
    );
  }

  // ---- 3. The three combined rules the user specifically asked to test ----
  // All BTC-vs-strike only: the YES-vs-50 signal isn't available below 300s
  // (see YES50_MIN_LOOKBACK), and two of these three rules need a short
  // (15-60s) lookback where only the BTC signal has real data.
  function median(vals: number[]): number {
    const s = [...vals].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    return percentile(s, 0.5);
  }
  function btcVal(r: Row, lb: number, feat: string): number | null {
    const f = r.btc[lb];
    return f ? (f as any)[feat] : null;
  }
  function evalCombined(subset: Row[], name: string, passesFn: (r: Row) => boolean) {
    let winnersKept = 0, winnersRemoved = 0, lossesKept = 0, lossesRemoved = 0;
    let baselinePnl = 0, filteredPnl = 0;
    for (const r of subset) {
      baselinePnl += r.pnlDollars;
      if (passesFn(r)) {
        filteredPnl += r.pnlDollars;
        if (r.outcome === "win") winnersKept++; else lossesKept++;
      } else {
        if (r.outcome === "win") winnersRemoved++; else lossesRemoved++;
      }
    }
    return { name, winnersKept, winnersRemoved, lossesKept, lossesRemoved, baselinePnl, filteredPnl, improvement: filteredPnl - baselinePnl };
  }

  const med900TwoSided = median(rows.map((r) => btcVal(r, 900, "twoSidedAreaScore")).filter((v): v is number => v !== null));
  const med60Activity = median(rows.map((r) => btcVal(r, 60, "totalActivity")).filter((v): v is number => v !== null));
  const med90TwoSided = median(rows.map((r) => btcVal(r, 90, "twoSidedAreaScore")).filter((v): v is number => v !== null));
  const med300TwoSided = median(rows.map((r) => btcVal(r, 300, "twoSidedAreaScore")).filter((v): v is number => v !== null));

  const combinedRules = [
    evalCombined(rows, "healthy 900s two-sided background + strong last-60s activity", (r) => {
      const bg = btcVal(r, 900, "twoSidedAreaScore");
      const recent = btcVal(r, 60, "totalActivity");
      return bg !== null && recent !== null && bg >= med900TwoSided && recent >= med60Activity;
    }),
    evalCombined(rows, "strong 90s area score + >=1 recent deep crossing (120s)", (r) => {
      const areaScore = btcVal(r, 90, "twoSidedAreaScore");
      const deep = btcVal(r, 120, "deepCrossingCount");
      return areaScore !== null && deep !== null && areaScore >= med90TwoSided && deep >= 1;
    }),
    evalCombined(rows, "balanced 300s area BUT rejected if last 30s is one-directional (no crossing)", (r) => {
      const bg = btcVal(r, 300, "twoSidedAreaScore");
      const recentCrossings = btcVal(r, 30, "crossingCount");
      return bg !== null && recentCrossings !== null && bg >= med300TwoSided && recentCrossings >= 1;
    }),
  ];

  console.log(`\nCombined rules (BTC-vs-strike only — see caveats above):`);
  for (const c of combinedRules) {
    console.log(
      `  ${c.name} | win kept ${c.winnersKept}/${c.winnersKept + c.winnersRemoved}, loss removed ${c.lossesRemoved}/${c.lossesKept + c.lossesRemoved} | ` +
        `$${c.baselinePnl.toFixed(0)} -> $${c.filteredPnl.toFixed(0)} (${c.improvement >= 0 ? "+" : ""}${c.improvement.toFixed(0)})`
    );
  }

  writeFileSync(
    accountReportPath("painted_area_results.json"),
    JSON.stringify(
      {
        n: rows.length,
        wins: wins.length,
        losses: losses.length,
        baselineNetPnl: rows.reduce((s, r) => s + r.pnlDollars, 0),
        trainCutoffDay,
        combinedRules,
        distributionReport,
        topCandidates: candidates.slice(0, 60),
        allCandidates: candidates,
        walkForward,
      },
      null,
      2
    )
  );
  console.log("\nSaved private painted-area report");
}

main();
