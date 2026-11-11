// Core "painted area" feature engine — shared by the backtest and (via the
// same math, reimplemented as a tiny live-safe function) the entry-gate
// module. Given a chronological price series and a reference line
// (strike, or 50c), computes the filled area above/below the reference
// over a lookback window ending at the entry decision, splitting any
// segment that crosses the reference so the two areas are geometrically
// exact (linear interpolation between samples).
//
// Units: `d(t) = price(t) - reference` is expected to already be in
// whatever consistent unit the caller wants comparable across trades — for
// BTC-vs-strike that's basis points of the strike (see toBps below), for
// YES-vs-50 it's already cents on a fixed 0-100 scale, no normalization
// needed.
export type PricePoint = { t: number; price: number };

export type PaintedAreaFeatures = {
  lookbackSeconds: number;
  coverageSeconds: number; // actual span covered by data in this window — can be < lookbackSeconds if history runs out
  areaAbove: number;
  areaBelow: number;
  totalActivity: number; // (areaAbove+areaBelow) / lookbackSeconds
  balance: number; // 2*min/max sum-normalized, 0 (one-sided) to 1 (perfectly balanced)
  twoSidedAreaScore: number; // 2*min(areaAbove,areaBelow) / lookbackSeconds
  crossingCount: number;
  completedLobes: number;
  deepCrossingCount: number;
  timeAbove: number;
  timeBelow: number;
  maxExcursionAbove: number;
  maxExcursionBelow: number;
  secondsSinceLastCrossing: number | null; // null = no crossing observed in this window
  currentRunSide: "above" | "below" | null;
  currentRunSeconds: number;
  imbalance: number; // (timeAbove - timeBelow) / coverageSeconds, signed -1..1
};

export function toBps(price: number, strike: number): number {
  return ((price - strike) / strike) * 10000;
}

/**
 * points: chronological (t ascending) samples of `d(t)` already computed
 * (price relative to reference, in the caller's chosen consistent unit).
 * entryTs/lookbackSeconds define the window: (entryTs - lookbackSeconds, entryTs].
 * deepThreshold: absolute |d| value that counts as a "deep" excursion for
 * the hysteresis deep-crossing count (e.g. 30 cents either side of 50c for
 * YES, or a chosen bps threshold for BTC).
 */
export function computePaintedArea(
  dPoints: PricePoint[],
  entryTs: number,
  lookbackSeconds: number,
  deepThreshold: number
): PaintedAreaFeatures {
  const windowStart = entryTs - lookbackSeconds;
  // Points strictly needed: everything in (windowStart, entryTs], plus the
  // single latest point at or before windowStart (to anchor the first
  // segment) if available.
  const sorted = dPoints.filter((p) => p.t <= entryTs).sort((a, b) => a.t - b.t);
  let startIdx = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].t <= windowStart) {
      startIdx = i;
      break;
    }
  }
  const usable = sorted.slice(startIdx);
  if (usable.length < 2) {
    return {
      lookbackSeconds,
      coverageSeconds: 0,
      areaAbove: 0,
      areaBelow: 0,
      totalActivity: 0,
      balance: 0,
      twoSidedAreaScore: 0,
      crossingCount: 0,
      completedLobes: 0,
      deepCrossingCount: 0,
      timeAbove: 0,
      timeBelow: 0,
      maxExcursionAbove: 0,
      maxExcursionBelow: 0,
      secondsSinceLastCrossing: null,
      currentRunSide: null,
      currentRunSeconds: 0,
      imbalance: 0,
    };
  }

  let areaAbove = 0;
  let areaBelow = 0;
  let timeAbove = 0;
  let timeBelow = 0;
  let crossingCount = 0;
  let maxExcursionAbove = 0;
  let maxExcursionBelow = 0;
  let lastCrossingTs: number | null = null;
  // Hysteresis deep-crossing: track which extreme was most recently armed.
  let armed: "low" | "high" | null = null;
  let deepCrossingCount = 0;

  const clampedFirstT = Math.max(usable[0].t, windowStart);

  function visitDeep(d: number, t: number) {
    if (d <= -deepThreshold) {
      if (armed === "high") {
        deepCrossingCount++;
      }
      armed = "low";
    } else if (d >= deepThreshold) {
      if (armed === "low") {
        deepCrossingCount++;
      }
      armed = "high";
    }
  }

  for (let i = 0; i < usable.length - 1; i++) {
    const a = usable[i];
    const b = usable[i + 1];
    const segStart = Math.max(a.t, windowStart);
    const segEnd = Math.min(b.t, entryTs);
    if (segEnd <= segStart) continue;

    // Interpolate d() at the clipped segment boundaries if we trimmed.
    const span = b.t - a.t;
    const dAtStart = span > 0 ? a.price + (b.price - a.price) * ((segStart - a.t) / span) : a.price;
    const dAtEnd = span > 0 ? a.price + (b.price - a.price) * ((segEnd - a.t) / span) : b.price;

    maxExcursionAbove = Math.max(maxExcursionAbove, Math.max(dAtStart, 0), Math.max(dAtEnd, 0));
    maxExcursionBelow = Math.max(maxExcursionBelow, Math.max(-dAtStart, 0), Math.max(-dAtEnd, 0));

    if (dAtStart * dAtEnd >= 0 || dAtStart === 0 || dAtEnd === 0) {
      // No sign change within this segment (or touches zero exactly).
      const dt = segEnd - segStart;
      const avg = (dAtStart + dAtEnd) / 2;
      if (avg >= 0) {
        areaAbove += ((Math.max(dAtStart, 0) + Math.max(dAtEnd, 0)) / 2) * dt;
        timeAbove += dt;
      } else {
        areaBelow += ((Math.max(-dAtStart, 0) + Math.max(-dAtEnd, 0)) / 2) * dt;
        timeBelow += dt;
      }
    } else {
      // Sign change: interpolate the exact crossing time and split.
      const frac = Math.abs(dAtStart) / (Math.abs(dAtStart) + Math.abs(dAtEnd));
      const tCross = segStart + (segEnd - segStart) * frac;
      const dt1 = tCross - segStart;
      const dt2 = segEnd - tCross;
      if (dAtStart > 0) {
        areaAbove += 0.5 * dAtStart * dt1;
        areaBelow += 0.5 * Math.abs(dAtEnd) * dt2;
        timeAbove += dt1;
        timeBelow += dt2;
      } else {
        areaBelow += 0.5 * Math.abs(dAtStart) * dt1;
        areaAbove += 0.5 * dAtEnd * dt2;
        timeBelow += dt1;
        timeAbove += dt2;
      }
      crossingCount++;
      lastCrossingTs = tCross;
    }

    // Deep-crossing hysteresis, sampled at both boundary values (dense
    // enough for real tick/candle data; a crossing that jumps clean over
    // the deep band between two samples without pausing in it is rare and
    // would need next-finer data to catch anyway).
    visitDeep(dAtStart, segStart);
    visitDeep(dAtEnd, segEnd);
  }

  const coverageSeconds = Math.min(entryTs, usable[usable.length - 1].t) - clampedFirstT;
  const lastD = usable[usable.length - 1].price;
  const currentRunSide: "above" | "below" | null = lastD === 0 ? null : lastD > 0 ? "above" : "below";
  const currentRunSeconds = lastCrossingTs !== null ? entryTs - lastCrossingTs : coverageSeconds;

  const areaSum = areaAbove + areaBelow;
  const balance = areaSum > 0 ? (2 * Math.min(areaAbove, areaBelow)) / areaSum : 0;
  const totalActivity = lookbackSeconds > 0 ? areaSum / lookbackSeconds : 0;
  const twoSidedAreaScore = lookbackSeconds > 0 ? (2 * Math.min(areaAbove, areaBelow)) / lookbackSeconds : 0;
  const timeSum = timeAbove + timeBelow;
  const imbalance = timeSum > 0 ? (timeAbove - timeBelow) / timeSum : 0;

  return {
    lookbackSeconds,
    coverageSeconds,
    areaAbove,
    areaBelow,
    totalActivity,
    balance,
    twoSidedAreaScore,
    crossingCount,
    completedLobes: crossingCount,
    deepCrossingCount,
    timeAbove,
    timeBelow,
    maxExcursionAbove,
    maxExcursionBelow,
    secondsSinceLastCrossing: lastCrossingTs !== null ? entryTs - lastCrossingTs : null,
    currentRunSide,
    currentRunSeconds,
    imbalance,
  };
}
