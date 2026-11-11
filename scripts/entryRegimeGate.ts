// Portable entry-regime gate for the 6c-in/95c-out BTC 15m scalp. Pure
// functions only, one external import (the painted-area math), so this
// file can be copied into the live bot's codebase as-is.
//
// FEATURE-FLAGGED OFF BY DEFAULT. See GateConfig.enabled — until a human
// flips it on, evaluateEntryGate() always returns {allow: true}, i.e. a
// pure pass-through with zero behavior change. This reflects the backtest
// finding as of 2026-08-25 (see PAINTED_AREA_FINDINGS.md): no gate tested
// survived the chronological holdout split with a durable, meaningful
// dollar improvement over the current 6c/95c baseline. Turning this on
// live should wait for either (a) a gate that DOES hold up once more BTC
// history accumulates via the forward logger, or (b) an explicit decision
// to test one of the "close but not holdout-proven" candidates live in a
// controlled way.
//
// Integration sketch (pseudocode — the exact call site depends on your
// bot's structure):
//
//   import { evaluateEntryGate, defaultGateConfig } from "./entryRegimeGate";
//
//   const recentBtcTicks: {t: number, price: number}[] = /* your rolling
//     BTC/USD tick buffer, e.g. last 920s, wall-clock seconds + $ price */;
//   const strike = currentMarket.floorStrike; // or capStrike
//
//   function shouldPlaceEntry(side: "yes" | "no", nowUnixSeconds: number): boolean {
//     const gate = evaluateEntryGate(recentBtcTicks, strike, nowUnixSeconds, defaultGateConfig);
//     if (!gate.allow) {
//       log(`[entry-gate] skipped ${side} entry: ${gate.reason}`);
//       return false;
//     }
//     return true; // fall through to the existing 6c-touch placement logic
//   }
//
// Call shouldPlaceEntry() right before placing (or re-placing) the resting
// 6c order, and again before letting an already-resting order continue —
// if the gate would now say no, cancel the resting order. That "continuous
// re-check" is what fill-time gating assumes; see the backtest notes on
// placement-time vs fill-time realism before trusting a live fill-time gate.
import { computePaintedArea, toBps, type PricePoint } from "./paintedArea.ts";

export type GateConfig = {
  enabled: boolean;
  lookbackSeconds: number;
  feature:
    | "totalActivity"
    | "balance"
    | "twoSidedAreaScore"
    | "crossingCount"
    | "deepCrossingCount"
    | "maxExcursionAbove"
    | "maxExcursionBelow"
    | "imbalance"
    | "currentRunSeconds";
  direction: "min" | "max"; // "min": require feature >= threshold; "max": require feature <= threshold
  threshold: number;
  deepThresholdBps: number;
};

// Mirrors the "Conservative" gate from the 2026-08-25 backtest (see
// PAINTED_AREA_FINDINGS.md): require at least one BTC-vs-strike crossing in
// the last 10 minutes. Kept 82% of real winners while removing 24% of real
// losers, and — unlike the flashier-looking percentile-fit candidates — the
// improvement held up on a chronological holdout split and didn't depend on
// a single outlier day. Still: it makes BTC lose LESS, not turn profitable —
// see the findings doc before expecting more than that. enabled stays false
// until a human deliberately turns this on.
export const defaultGateConfig: GateConfig = {
  enabled: false,
  lookbackSeconds: 600,
  feature: "crossingCount",
  direction: "min",
  threshold: 1,
  deepThresholdBps: 8,
};

export type GateResult = {
  allow: boolean;
  reason: string;
  value: number | null;
};

export function evaluateEntryGate(
  recentBtcTicks: PricePoint[], // price already in $ (not bps) — converted below
  strike: number,
  nowUnixSeconds: number,
  config: GateConfig
): GateResult {
  if (!config.enabled) {
    return { allow: true, reason: "gate disabled (pass-through)", value: null };
  }
  const dPoints = recentBtcTicks.map((p) => ({ t: p.t, price: toBps(p.price, strike) }));
  const features = computePaintedArea(dPoints, nowUnixSeconds, config.lookbackSeconds, config.deepThresholdBps);
  if (features.coverageSeconds < config.lookbackSeconds * 0.5) {
    // Not enough tick history yet (e.g. just after process start) — fail
    // open rather than silently trading on a near-empty window.
    return { allow: true, reason: "insufficient tick history, passing through", value: null };
  }
  const value = features[config.feature];
  const passes = config.direction === "min" ? value >= config.threshold : value <= config.threshold;
  return {
    allow: passes,
    reason: passes
      ? `${config.feature}=${value.toFixed(3)} ${config.direction === "min" ? ">=" : "<="} ${config.threshold}`
      : `${config.feature}=${value.toFixed(3)} fails ${config.direction === "min" ? ">=" : "<="} ${config.threshold}`,
    value,
  };
}
