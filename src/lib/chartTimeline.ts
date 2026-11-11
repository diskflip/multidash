import type { HistoryPoint, MarketInfo } from "../types/market.ts";

export const MAX_QUOTE_AGE_SECONDS = 10;
export const HISTORY_SECONDS = 30 * 60;

export function latestVisiblePoint(history: HistoryPoint[], now: number): HistoryPoint | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].time <= now && validPoint(history[i])) return history[i];
  }
}

// Server observations replace overlapping browser history, including artificial
// browser disconnect markers. Keep older local observations outside that range.
export function restoreHistory(local: HistoryPoint[], replay: HistoryPoint[], now: number): HistoryPoint[] {
  const valid = (p: HistoryPoint) => p && validPoint(p) && p.time >= now - HISTORY_SECONDS && p.time <= now;
  const server = replay.filter(valid).sort((a, b) => a.time - b.time);
  const start = server[0]?.time ?? Infinity;
  return [...local.filter(p => valid(p) && p.time < start), ...server].sort((a, b) => a.time - b.time);
}

export function validPoint(point: HistoryPoint): boolean {
  return typeof point.ticker === "string" && point.ticker.length > 0 &&
    [point.time, point.yes, point.openTime, point.closeTime].every(Number.isFinite) &&
    point.yes >= 0 && point.yes <= 100 && point.openTime < point.closeTime &&
    point.time >= point.openTime && point.time < point.closeTime;
}

export function appendPrice(history: HistoryPoint[], point: HistoryPoint, market: MarketInfo | null, breakBefore = false): boolean {
  if (!market || !validPoint(point) || point.ticker !== market.ticker ||
      point.openTime !== market.openTime || point.closeTime !== market.closeTime) return false;
  const previous = history.at(-1);
  if (previous && point.time < previous.time) return false;
  // A reconnect must remain a break even when it lasts less than ten seconds.
  history.push({ ...point, breakBefore: breakBefore || point.breakBefore === true });
  const cutoff = point.time - HISTORY_SECONDS;
  let stale = 0;
  while (stale < history.length && history[stale].time < cutoff) stale++;
  if (stale) history.splice(0, stale);
  return true;
}

// Hold each quote until the next observation, never interpolate across a
// contract change, outage, or close. These display points are not saved ticks.
export function chartSegments(history: HistoryPoint[], now: number): HistoryPoint[][] {
  const segments: HistoryPoint[][] = [];
  for (const point of history) {
    if (!validPoint(point) || point.time > now) continue;
    const segment = segments.at(-1);
    const previous = segment?.at(-1);
    if (previous && point.time < previous.time) continue;
    if (segment && previous && !point.breakBefore && point.ticker === previous.ticker &&
        point.time - previous.time <= MAX_QUOTE_AGE_SECONDS) {
      if (point.yes !== previous.yes) segment.push({ ...previous, time: point.time });
      segment.push(point);
    } else {
      segments.push([point]);
    }
  }
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const last = segment.at(-1)!;
    const next = segments[i + 1]?.[0];
    // Do not extend into a disconnected segment. A new contract is a hard
    // boundary regardless of how late its first tick arrives.
    const end = Math.min(now, last.closeTime, last.time + MAX_QUOTE_AGE_SECONDS,
      next?.ticker === last.ticker ? (next.breakBefore ? last.time : next.time) : next?.openTime ?? Infinity);
    if (end > last.time) segment.push({ ...last, time: end });
  }
  return segments;
}
