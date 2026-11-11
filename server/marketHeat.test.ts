import test from 'node:test';
import assert from 'node:assert/strict';
import { isMarketHot } from '../src/lib/marketHeat.ts';

test('three or more flips in the rolling 30-minute tally qualify', () => {
  for (const count of [0, 1, 2]) assert.equal(isMarketHot(count, true), false);
  for (const count of [3, 4, 10]) assert.equal(isMarketHot(count, true), true);
});
test('aged-out flips, disconnection, and invalid tallies clear heat', () => {
  assert.equal(isMarketHot(3, true), true);
  assert.equal(isMarketHot(2, true), false);
  assert.equal(isMarketHot(3, false), false);
  assert.equal(isMarketHot(NaN, true), false);
  assert.equal(isMarketHot(Infinity, true), false);
});
