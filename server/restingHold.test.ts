import test from 'node:test';
import assert from 'node:assert/strict';
import { RestingHold } from '../src/lib/restingHold.ts';

test('resting display stays for 30 seconds despite alternating updates', () => {
  const hold = new RestingHold();
  assert.equal(hold.update(false, 0), false);
  assert.equal(hold.update(true, 1), true);
  assert.equal(hold.update(false, 2), true);
  assert.equal(hold.update(true, 10), true);
  assert.equal(hold.update(false, 20), true);
  assert.equal(hold.value(30.99), true);
  assert.equal(hold.value(31), false);
});

test('a still-resting order remains visible after the hold; a new appearance gets its own hold', () => {
  const hold = new RestingHold();
  hold.update(true, 0);
  assert.equal(hold.value(60), true);
  assert.equal(hold.update(false, 61), false);
  assert.equal(hold.update(true, 62), true);
  assert.equal(hold.update(false, 63), true);
  assert.equal(hold.value(92), false);
});

test('LIVE off releases presentation grace but never hides a still-resting order', () => {
  const hold = new RestingHold();
  assert.equal(hold.update(true, 0), true);
  assert.equal(hold.releaseGrace(), true);
  assert.equal(hold.update(false, 1, false), false);
  assert.equal(hold.update(true, 2, false), true);
  assert.equal(hold.update(false, 3, false), false);
});

test('cancellation arriving before LIVE off also clears immediately once off is confirmed', () => {
  const hold = new RestingHold();
  hold.update(true, 0);
  assert.equal(hold.update(false, 1), true);
  assert.equal(hold.releaseGrace(), false);
  assert.equal(hold.value(2), false);
});
