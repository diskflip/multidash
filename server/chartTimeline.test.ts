import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendPrice, chartSegments, latestVisiblePoint, validPoint } from '../src/lib/chartTimeline.ts';
import type { HistoryPoint, MarketInfo } from '../src/types/market.ts';
const market = (ticker = 'old', openTime = 0, closeTime = 900): MarketInfo => ({ symbol: 'BTC', ticker, title: ticker, openTime, closeTime });
const point = (time: number, yes: number, ticker = 'old', openTime = 0, closeTime = 900): HistoryPoint => ({time, yes, ticker, openTime, closeTime});

test('a tick ahead of the render clock keeps the previous plotted price visible', () => {
  const history = [point(100, 40), point(101.05, 60)];
  assert.equal(latestVisiblePoint(history, 101)?.yes, 40);
  assert.equal(chartSegments(history, 101).at(-1)?.at(-1)?.yes, 40);
  assert.equal(latestVisiblePoint(history, 101.06)?.yes, 60);
  assert.equal(latestVisiblePoint(history, 99), undefined);
});

test('last tick stops at exact close; next contract starts a separate path', () => {
  const history: HistoryPoint[] = [];
  assert.ok(appendPrice(history, point(899.95, 99), market()));
  assert.ok(appendPrice(history, point(900.3, 2, 'new', 900, 1800), market('new',900,1800)));
  const segments = chartSegments(history, 901);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].at(-1)?.time, 900);
  assert.equal(segments[1][0].time, 900.3);
  assert.deepEqual(segments.map(s=>new Set(s.map(p=>p.ticker)).size), [1,1]);
});

test('missing next market cannot extend the expired price', () => {
  assert.equal(chartSegments([point(899.95,99)], 940)[0].at(-1)?.time,900);
});

test('reject late old-market, at-close, pre-open, invalid and out-of-order ticks', () => {
  const history: HistoryPoint[] = [point(901,30,'new',900,1800)];
  const current=market('new',900,1800);
  for(const p of [point(899,99),point(1800,99,'new',900,1800),point(899,99,'new',900,1800),
    point(900.5,70,'new',900,1800),point(902,NaN,'new',900,1800),point(902,101,'new',900,1800)]) {
    assert.equal(appendPrice(history,p,current),false);
  }
  assert.equal(history.length,1);
  assert.equal(validPoint({time:1,yes:1,ticker:null} as unknown as HistoryPoint),false);
});

test('lag preserves source time and draws a step, never a diagonal ramp', () => {
  const history: HistoryPoint[]=[];
  appendPrice(history,point(880,10),market());
  appendPrice(history,point(883,90),market());
  const segment=chartSegments(history,885)[0];
  assert.deepEqual(segment.map(p=>[p.time,p.yes]),[[880,10],[883,10],[883,90],[885,90]]);
});

test('short reconnect and long data gaps both break the path', () => {
  const history: HistoryPoint[]=[];
  appendPrice(history,point(850,10),market());
  appendPrice(history,point(852,90),market(),true);
  appendPrice(history,point(880,40),market());
  const segments=chartSegments(history,885);
  assert.equal(segments.length,3);
  assert.equal(segments[0].at(-1)?.time,850);
  // Silence only expires the quote after ten seconds; it must not erase
  // the already-rendered valid tail when the next tick finally arrives.
  assert.equal(segments[1].at(-1)?.time,862);
});

test('different first-tick delays do not move the market cutoff', () => {
  for(const delay of [0,0.4,2,8]) {
    const segments=chartSegments([point(899.9,90),point(900+delay,20,'new',900,1800)],910);
    assert.equal(segments[0].at(-1)?.time,900);
    assert.equal(segments[1][0].openTime,900);
  }
});
