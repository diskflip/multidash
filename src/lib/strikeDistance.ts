import type { DistancePoint } from "../types/market.ts";

// How long observations are kept at all (hover/replay/history). Independent
// of PEAK_WINDOW_SECONDS below, which is what actually sets the scale.
export const DISTANCE_WINDOW_SECONDS = 30 * 60;

// How far back the normalizing peak looks. The chart's own view window
// (3m/30m) does not change this — the scale stays put when you toggle.
//
// Deliberately shorter than DISTANCE_WINDOW_SECONDS and not scoped to the
// current contract. Two things were tried and both read wrong once seen
// live, against the actual goal here: comparing this line's movement to
// the YES price line to spot lag between them.
//  - The full 30-minute window (the original version of this): a contract
//    two rollovers back can have a swing several times the current
//    contract's own range, and that lingers for the full 30 minutes,
//    pinning the line near center the whole time a real current move is
//    happening (confirmed live: $673 peak from 29 minutes ago parking a
//    real $7 current move at 50.5c).
//  - Scoping to only the current contract (the next thing tried): right
//    after a rollover there are only a handful of samples, so the single
//    latest tick is very often tied for that contract's own max — the
//    line pins to an edge on ordinary noise, not a real move, which reads
//    as just as uninformative in the other direction.
// A plain, shorter time window sidesteps both: short enough that an old
// contract's spike ages out in minutes rather than lingering for 30, but
// long enough (hundreds of samples at ~1/s) that the latest tick rarely
// is the window's own extreme, so a swing to the edge actually means
// something. This number is the tuning knob — if it's still off, say
// which direction and it's a one-line change.
export const PEAK_WINDOW_SECONDS = 10 * 60;

// The settlement index publishes about once a second. A longer silence is a
// real gap, not a flat underlying, so the line breaks instead of ramping.
export const MAX_INDEX_GAP_SECONDS = 10;

// Noise floor on the peak, as a fraction of the strike (1 basis point —
// ~$12 at a $120k strike). Without it, an underlying that sat on its strike
// for the whole window would divide by near-zero and amplify tick noise
// into a line swinging the full 0-100 range.
export const MIN_PEAK_FRACTION = 0.0001;

// Which way the underlying has to move for YES to pay. Only single-sided
// strikes are supported; anything else gets no line rather than a guess.
export function distanceDirection(strikeType: string | null): 1 | -1 | null {
  if (strikeType === "greater" || strikeType === "greater_or_equal") return 1;
  if (strikeType === "less" || strikeType === "less_or_equal") return -1;
  return null;
}

// Signed so positive always means "the side that pays YES", which is what
// lets this be read against the YES price on one shared axis.
export function signedDistance(value: number, strike: number, strikeType: string | null): number | null {
  const direction = distanceDirection(strikeType);
  if (direction === null || !Number.isFinite(value) || !Number.isFinite(strike) ||
      value <= 0 || strike <= 0) return null;
  return (value - strike) * direction;
}

// Mirrors chartTimeline's latestVisiblePoint — a received tick can be
// slightly ahead of the shared render clock, so this finds the newest
// observation that clock has actually reached yet.
export function latestVisibleDistance(points: DistancePoint[], now: number): DistancePoint | undefined {
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i].time <= now && validDistancePoint(points[i])) return points[i];
  }
}

export function validDistancePoint(point: DistancePoint): boolean {
  return !!point && typeof point.ticker === "string" && point.ticker.length > 0 &&
    [point.time, point.value, point.strike, point.distance].every(Number.isFinite) &&
    (point.displayDistance === undefined || Number.isFinite(point.displayDistance)) &&
    point.value > 0 && point.strike > 0;
}

// Older persisted points have no adjusted value and continue to use the raw
// index distance.
export function distanceValue(point: DistancePoint): number {
  return point.displayDistance ?? point.distance;
}

// Drops points older than the window and anything in the future, in place.
export function trimDistance(points: DistancePoint[], now: number): DistancePoint[] {
  let stale = 0;
  while (stale < points.length && points[stale].time < now - DISTANCE_WINDOW_SECONDS) stale++;
  if (stale) points.splice(0, stale);
  return points;
}

// The widest distance reached in the trailing PEAK_WINDOW_SECONDS — what
// the 0c/100c ends of the axis stand for. Measured from viewEnd, not the
// live clock, so a view scrolled back into history scales by what was
// relevant then. A plain time window, deliberately not scoped to the
// current contract — see PEAK_WINDOW_SECONDS' comment for why. null means
// there is nothing to scale by and no line to draw.
export function distancePeak(points: DistancePoint[], viewEnd: number): number | null {
  let peak = 0;
  let strike: number | null = null;
  for (const point of points) {
    if (!validDistancePoint(point) || point.time > viewEnd ||
        point.time < viewEnd - PEAK_WINDOW_SECONDS) continue;
    peak = Math.max(peak, Math.abs(distanceValue(point)));
    strike = point.strike;
  }
  if (strike === null) return null;
  return Math.max(peak, strike * MIN_PEAK_FRACTION);
}

// 50 is the strike itself, which is also where the chart's existing mid
// line sits — the two coincide by design, so the strike needs no separate
// reference line.
export function distanceToCents(distance: number, peak: number | null): number {
  if (peak === null || !(peak > 0) || !Number.isFinite(distance)) return 50;
  return Math.min(100, Math.max(0, 50 + (distance / peak) * 50));
}

// A step, not a diagonal ramp — holds the prior reading flat until the
// next tick, exactly like the price line's own chartSegments. The
// underlying genuinely moves continuously between observations, but
// drawing it that way reads as mismatched next to the price line's own
// square, held-until-next-tick movement; matching that look mattered more
// here than the (sub-second, invisible at this scale) literal accuracy of
// a diagonal. Breaks at a contract change or a feed gap.
export function distanceSegments(points: DistancePoint[], now: number): DistancePoint[][] {
  const segments: DistancePoint[][] = [];
  for (const point of points) {
    if (!validDistancePoint(point) || point.time > now) continue;
    const segment = segments.at(-1);
    const previous = segment?.at(-1);
    if (previous && point.time < previous.time) continue;
    if (segment && previous && point.ticker === previous.ticker &&
        point.time - previous.time <= MAX_INDEX_GAP_SECONDS) {
      if (distanceValue(point) !== distanceValue(previous)) segment.push({ ...previous, time: point.time });
      segment.push(point);
    } else {
      segments.push([point]);
    }
  }
  // Hold the final segment's last reading up to the live edge, exactly
  // like the price line's own chartSegments — without this, the line's
  // trailing endpoint only moves once a second, on each real observation,
  // instead of tracking the clock every frame, which reads as lagging
  // behind the price line even though both update at the same rate. Only
  // the final segment: every earlier one already ends exactly where a
  // real gap or contract change began, and extending into that would
  // visually paper over a genuine outage.
  const finalSegment = segments.at(-1);
  const last = finalSegment?.at(-1);
  if (last) {
    const end = Math.min(now, last.time + MAX_INDEX_GAP_SECONDS);
    if (end > last.time) finalSegment!.push({ ...last, time: end });
  }
  return segments;
}

// Decimals follow the series' own magnitude: a few hundred dollars off a
// BTC strike reads fine as a whole number, a sub-cent FX move does not.
export function formatDistance(distance: number, peak: number | null): string {
  const scale = peak ?? Math.abs(distance);
  const decimals = scale >= 100 ? 0 : scale >= 10 ? 1 : scale >= 1 ? 2 : scale >= 0.01 ? 4 : 6;
  const sign = distance > 0 ? "+" : distance < 0 ? "-" : "";
  return `${sign}${Math.abs(distance).toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}
