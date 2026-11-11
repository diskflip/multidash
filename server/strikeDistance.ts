import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DistancePoint } from "../src/types/market.ts";
import {
  DISTANCE_WINDOW_SECONDS,
  distanceDirection,
  signedDistance,
  trimDistance,
  validDistancePoint,
} from "../src/lib/strikeDistance.ts";
import { INDEX_IDS, matchingFinalMinuteAverage, type IndexTick } from "./decisions/settlement.ts";
import type { CurrentMarket } from "./findMarket.ts";

// Every symbol with a settlement index feed gets the chart's distance
// line — FX and commodity series have no such feed (see INDEX_IDS) and
// so get no line regardless of this set.
export const DISTANCE_SYMBOLS = new Set(Object.keys(INDEX_IDS));

// Rolling 30 minutes of "how far is the underlying from this contract's
// strike", so the chart's normalizing peak is ready the moment a browser
// connects instead of rebuilding from scratch. Independent of browser
// connections, and persisted across restarts for the same reason — a cold
// buffer would start with a tiny peak and slam the line to the axis ends
// until a representative range accumulated.
export class StrikeDistance {
  private points = new Map<string, DistancePoint[]>();

  constructor(private path?: string) {
    if (!path) return;
    try {
      const saved = JSON.parse(readFileSync(path, "utf8"));
      const now = Date.now() / 1000;
      for (const [symbol, points] of Object.entries(saved)) {
        if (!Array.isArray(points)) continue;
        const restored = (points as DistancePoint[])
          .filter(p => validDistancePoint(p) && p.time <= now && p.time >= now - DISTANCE_WINDOW_SECONDS)
          .sort((a, b) => a.time - b.time);
        if (restored.length) this.points.set(symbol, restored);
      }
    } catch { /* A new installation starts collecting immediately. */ }
  }

  // Returns the recorded point, or null when the tick can't be placed
  // against a strike — no open window, no readable strike, a two-sided
  // strike, or an observation that isn't newer than what's already stored.
  observe(symbol: string, market: CurrentMarket | null, tick: IndexTick): DistancePoint | null {
    if (!DISTANCE_SYMBOLS.has(symbol) || !market || market.strike === null) return null;
    if (distanceDirection(market.strikeType) === null) return null;
    const time = tick.sourceTime / 1000;
    // The strike belongs to this contract alone, so an observation outside
    // its window has nothing meaningful to measure against.
    if (time < market.openTime / 1000 || time >= market.closeTime / 1000) return null;
    const history = this.points.get(symbol) ?? [];
    if (time <= (history.at(-1)?.time ?? -Infinity)) return null;
    const distance = signedDistance(tick.value, market.strike, market.strikeType);
    if (distance === null) return null;
    const finalMinute = matchingFinalMinuteAverage(tick, market.closeTime);
    // Use the ordinary index for the first 14 minutes, then switch directly
    // to Kalshi's running final-minute average once that exact window has a
    // valid reading. A missing or mismatched window keeps the raw index until
    // Kalshi supplies a valid average.
    const averageDistance = finalMinute
      ? signedDistance(finalMinute.average.value, market.strike, market.strikeType)
      : null;
    const displayDistance = averageDistance ?? undefined;
    const point: DistancePoint = {
      time,
      ticker: market.ticker,
      value: tick.value,
      strike: market.strike,
      distance,
      ...(displayDistance === undefined ? {} : { displayDistance }),
    };
    history.push(point);
    this.points.set(symbol, history);
    trimDistance(history, time);
    return point;
  }

  get(symbol: string, now = Date.now() / 1000): DistancePoint[] {
    return trimDistance(this.points.get(symbol) ?? [], now);
  }

  save() {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const snapshot = Object.fromEntries([...this.points.keys()].map(symbol => [symbol, this.get(symbol)]));
      writeFileSync(`${this.path}.tmp`, JSON.stringify(snapshot));
      renameSync(`${this.path}.tmp`, this.path);
    } catch (error) { console.warn("[distance] Could not save strike-distance history", error); }
  }
}
