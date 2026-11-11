import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StrikeDistance } from './strikeDistance.ts';
import type { IndexTick } from './decisions/settlement.ts';
import type { CurrentMarket } from './findMarket.ts';
import type { DistancePoint } from '../src/types/market.ts';
import {
  MAX_INDEX_GAP_SECONDS,
  MIN_PEAK_FRACTION,
  PEAK_WINDOW_SECONDS,
  distanceDirection,
  distancePeak,
  distanceSegments,
  distanceToCents,
  formatDistance,
  latestVisibleDistance,
  signedDistance,
} from '../src/lib/strikeDistance.ts';

const STRIKE = 120_000;
// findMarket reports open/close in ms; the window below is 10:00-10:15.
const market = (overrides: Partial<CurrentMarket> = {}): CurrentMarket => ({
  ticker: 'KXBTC15M-A',
  title: 'A',
  openTime: 600_000,
  closeTime: 1_500_000,
  strike: STRIKE,
  strikeType: 'greater_or_equal',
  ...overrides,
});
const tick = (sourceTime: number, value: number): IndexTick =>
  ({ indexId: 'BRTI', sourceTime, value, trailing: null, finalMinute: null });
const point = (time: number, distance: number, ticker = 'A'): DistancePoint =>
  ({ time, ticker, value: STRIKE + distance, strike: STRIKE, distance });

test('distance is signed toward whichever side pays YES', () => {
  assert.equal(distanceDirection('greater_or_equal'), 1);
  assert.equal(distanceDirection('greater'), 1);
  assert.equal(distanceDirection('less'), -1);
  assert.equal(distanceDirection('less_or_equal'), -1);
  // Above an "above" strike favors YES; above a "below" strike opposes it.
  assert.equal(signedDistance(120_300, STRIKE, 'greater_or_equal'), 300);
  assert.equal(signedDistance(120_300, STRIKE, 'less'), -300);
  assert.equal(signedDistance(119_700, STRIKE, 'greater_or_equal'), -300);
  // Two-sided and unreadable strikes get no line rather than a guess.
  for (const type of ['between', 'custom', null]) {
    assert.equal(distanceDirection(type), null);
    assert.equal(signedDistance(120_300, STRIKE, type), null);
  }
});

test('50c is the strike and the ends are the window peak', () => {
  const peak = 400;
  assert.equal(distanceToCents(0, peak), 50);
  assert.equal(distanceToCents(peak, peak), 100);
  assert.equal(distanceToCents(-peak, peak), 0);
  assert.equal(distanceToCents(200, peak), 75);
  // Nothing can exceed the peak by construction, but clamp regardless.
  assert.equal(distanceToCents(peak * 3, peak), 100);
  assert.equal(distanceToCents(-peak * 3, peak), 0);
  // No scale yet, or a degenerate one, parks the line on the strike.
  assert.equal(distanceToCents(500, null), 50);
  assert.equal(distanceToCents(500, 0), 50);
});

test('an excursion earlier in the peak window still sets the scale', () => {
  const now = 3000;
  // The big move happened a few minutes ago, within PEAK_WINDOW_SECONDS;
  // the last minute is quiet.
  const points = [point(now - 5 * 60, 800), point(now - 60, 100), point(now, 50)];
  assert.equal(distancePeak(points, now), 800);
  // Which is the whole point: a quiet close-up reads against the same
  // scale as the 30m view, so toggling the chart window never rescales.
  assert.equal(distanceToCents(50, distancePeak(points, now)), 53.125);
});

test('the peak only looks at the trailing PEAK_WINDOW_SECONDS ending at viewEnd', () => {
  const now = 4000;
  const points = [point(now - PEAK_WINDOW_SECONDS - 60, 5000), point(now - 60, 200), point(now + 30, 9000)];
  assert.equal(distancePeak(points, now), 200);
  assert.equal(distancePeak([], now), null);
  assert.equal(distancePeak([point(now, NaN)], now), null);
});

test('a strike-pinned window falls back to the noise floor, not a divide by zero', () => {
  const now = 1000;
  assert.equal(distancePeak([point(now, 0)], now), STRIKE * MIN_PEAK_FRACTION);
  // Without the floor this would swing the full axis on a $1 wiggle.
  assert.ok(distanceToCents(1, distancePeak([point(now, 0), point(now + 1, 1)], now + 1)) < 60);
});

test('the peak is a plain time window, not scoped to the current contract', () => {
  const now = 1000;
  // A rollover mid-window: the peak still reflects the bigger pre-rollover
  // swing as long as it's within PEAK_WINDOW_SECONDS — deliberately not
  // ticker-scoped. See PEAK_WINDOW_SECONDS' own comment for why: scoping
  // to the current contract alone read as just as wrong, in the other
  // direction, once seen live (the latest tick is very often tied for
  // that contract's own tiny, just-started range).
  const points = [
    point(now - 300, 2000, 'old'),
    point(now - 60, 10, 'new'),
    point(now, 20, 'new'),
  ];
  assert.equal(distancePeak(points, now), 2000);
  assert.equal(distanceToCents(20, distancePeak(points, now)), 50.5);
});

test('the line breaks at a contract change and at a feed gap', () => {
  const now = 1000;
  const points = [
    point(now - 30, 100),
    point(now - 29, 120),
    // Gap longer than the feed's own cadence — a real outage, not a flat index.
    point(now - 29 + MAX_INDEX_GAP_SECONDS + 1, 140),
    point(now - 10, 160, 'B'),
    point(now, 180, 'B'),
  ];
  const segments = distanceSegments(points, now);
  assert.equal(segments.length, 3);
  // now === the last real point's own time here, so there's nothing to
  // extend — see the dedicated live-edge test below for that case. Each
  // joined pair also picks up one held-flat step point (100→120, 160→180),
  // so 2 real points per segment reads as 3 drawn points.
  assert.deepEqual(segments.map(s => s.length), [3, 1, 3]);
  assert.deepEqual(segments.map(s => new Set(s.map(p => p.ticker)).size), [1, 1, 1]);
  // A step, not a diagonal: the value holds flat right up to the next
  // tick's own time, then jumps — never a smooth ramp between two values.
  assert.deepEqual(segments[0].map(p => p.distance), [100, 100, 120]);
  assert.equal(segments.at(-1)!.at(-1)!.time, now);
  assert.equal(distanceSegments([point(now, 100), point(now + 5, 200)], now).flat().length, 1);
  assert.equal(distanceSegments([point(now, 100), point(now - 5, 200)], now).flat().length, 1);
});

test('the live edge holds the last reading up to now, without papering over a real gap', () => {
  const now = 1000;
  // now is 7s past the last real tick — within MAX_INDEX_GAP_SECONDS, so
  // the final segment's dot/line should track the clock up to now, the
  // same way the price line's own quote holds between ticks. Without
  // this, the dot only moves once a second, on each real observation,
  // instead of every frame — which reads as lagging the price line even
  // at the same update rate.
  const held = distanceSegments([point(now - 8, 100), point(now - 7, 140)], now);
  assert.equal(held.length, 1);
  assert.deepEqual(held[0].at(-1), { ...point(now - 7, 140), time: now });

  // now is 20s past the last real tick — a genuine outage, not jitter —
  // so the line must not stretch a stale reading all the way to now.
  const stale = distanceSegments([point(now - 30, 100), point(now - 20, 140)], now);
  assert.equal(stale[0].at(-1)!.time, now - 20 + MAX_INDEX_GAP_SECONDS);

  // An earlier, non-final segment never extends — only the live edge
  // holds. Extending a finished segment would visually paper over the
  // real gap that split it from the one that follows.
  const withGap = distanceSegments(
    [point(now - 30, 100), point(now - 29, 120), point(now - 10, 160, 'B')],
    now
  );
  assert.equal(withGap.length, 2);
  assert.equal(withGap[0].at(-1)!.time, now - 29);
});

test('latestVisibleDistance finds the newest observation the clock has actually reached', () => {
  const now = 1000;
  // A received tick can be slightly ahead of the shared render clock —
  // mirrors chartTimeline's latestVisiblePoint for the same reason.
  const points = [point(now - 2, 100), point(now + 1, 200)];
  assert.equal(latestVisibleDistance(points, now)?.distance, 100);
  assert.equal(latestVisibleDistance(points, now + 1)?.distance, 200);
  assert.equal(latestVisibleDistance([], now), undefined);
});

test('observe records a tick against the open contract and rejects the rest', () => {
  const store = new StrikeDistance();
  const recorded = store.observe('BTC', market(), tick(900_000, 120_250));
  assert.deepEqual(recorded, { time: 900, ticker: 'KXBTC15M-A', value: 120_250, strike: STRIKE, distance: 250 });
  assert.deepEqual(store.get('BTC', 900), [recorded]);

  // Every crypto symbol with a settlement index feed gets a line, not
  // just BTC.
  assert.ok(store.observe('ETH', market({ ticker: 'KXETH15M-A' }), tick(901_000, 120_250)));
  // Only symbols with a settlement index feed (FX/commodities have none),
  // and only with a readable one-sided strike.
  assert.equal(store.observe('USDJPY', market(), tick(901_000, 120_250)), null);
  assert.equal(store.observe('BTC', null, tick(901_000, 120_250)), null);
  assert.equal(store.observe('BTC', market({ strike: null }), tick(901_000, 120_250)), null);
  assert.equal(store.observe('BTC', market({ strikeType: 'between' }), tick(901_000, 120_250)), null);
  // The strike belongs to one window, so observations outside it measure nothing.
  assert.equal(store.observe('BTC', market(), tick(599_000, 120_250)), null);
  assert.equal(store.observe('BTC', market(), tick(1_500_000, 120_250)), null);
  // Not newer than what is stored.
  assert.equal(store.observe('BTC', market(), tick(900_000, 120_999)), null);
  assert.equal(store.observe('BTC', market(), tick(899_000, 120_999)), null);
  assert.deepEqual(store.get('BTC', 900), [recorded]);
});

test('the stored buffer holds 30 minutes and breaks cleanly across a rollover', () => {
  const store = new StrikeDistance();
  const first = market({ ticker: 'A', openTime: 0, closeTime: 900_000 });
  store.observe('BTC', first, tick(10_000, 120_100));
  store.observe('BTC', first, tick(890_000, 119_900));
  const next = market({ ticker: 'B', openTime: 900_000, closeTime: 1_800_000, strike: 119_800 });
  store.observe('BTC', next, tick(905_000, 119_900));
  assert.deepEqual(store.get('BTC', 905).map(p => [p.ticker, p.distance]), [['A', 100], ['A', -100], ['B', 100]]);
  // Two contracts, two strikes — the chart must not join them.
  assert.equal(distanceSegments(store.get('BTC', 905), 905).length, 3);

  // Eviction is at exactly 30 minutes: the oldest point (t=10) survives a
  // tick at t=1810 and is dropped by the next one past it.
  store.observe('BTC', market({ ticker: 'C', openTime: 1_800_000, closeTime: 2_700_000 }), tick(1_810_000, 120_200));
  assert.deepEqual(store.get('BTC', 1810).map(p => p.ticker), ['A', 'A', 'B', 'C']);
  store.observe('BTC', market({ ticker: 'D', openTime: 2_700_000, closeTime: 3_600_000 }), tick(2_700_001, 120_200));
  assert.deepEqual(store.get('BTC', 2700).map(p => p.ticker), ['B', 'C', 'D']);
});

test('the readout scales its decimals to the series, not to BTC', () => {
  assert.equal(formatDistance(0, 400), '0');
  assert.equal(formatDistance(-250.4, 400), '-250');
  assert.equal(formatDistance(2.5, 40), '+2.5');
  // A sub-cent FX or DOGE move would round away to zero as an integer.
  assert.equal(formatDistance(0.00042, 0.0009), '+0.000420');
});
