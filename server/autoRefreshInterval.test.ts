import test from 'node:test';
import assert from 'node:assert/strict';
import { autoRefreshSeconds } from '../src/lib/autoRefreshInterval.ts';

test('AUTO accelerates at 3:00, 2:00 and 1:00, resets after rollover', () => {
  assert.equal(autoRefreshSeconds(900, 719), 30);
  assert.equal(autoRefreshSeconds(900, 720), 20);
  assert.equal(autoRefreshSeconds(900, 779), 20);
  assert.equal(autoRefreshSeconds(900, 780), 10);
  assert.equal(autoRefreshSeconds(900, 839), 10);
  assert.equal(autoRefreshSeconds(900, 840), 5);
  assert.equal(autoRefreshSeconds(900, 899), 5);
  assert.equal(autoRefreshSeconds(1800, 900), 30);
  assert.equal(autoRefreshSeconds(900, 901), 30);
  assert.equal(autoRefreshSeconds(null, 900), 30);
});
