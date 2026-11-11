import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyMissingRestingOrders } from './restingOrders.ts';

test('a lagging portfolio list cannot erase a confirmed resting order', async () => {
  const result = await verifyMissingRestingOrders(new Map(), new Map([['one', 'BTC']]), async () => ({ status: 'resting' }));
  assert.equal(result.get('one'), 'BTC');
});

test('only confirmed terminal orders lose protection; failed lookups retain it', async () => {
  const previous = new Map(['resting', 'canceled', 'executed', 'unavailable', 'unknown'].map(id => [id, 'BTC']));
  const result = await verifyMissingRestingOrders(new Map(), previous, async id => {
    if (id === 'unavailable') throw Error('network failure');
    return { status: id };
  });
  assert.deepEqual([...result.keys()].sort(), ['resting', 'unavailable', 'unknown'].sort());
});

test('orders present in the list do not need extra requests', async () => {
  const orders = new Map([['one', 'BTC'], ['two', 'BTC']]);
  let calls = 0;
  const result = await verifyMissingRestingOrders(orders, orders, async () => { calls++; return { status: 'executed' }; });
  assert.deepEqual(result, orders);
  assert.equal(calls, 0);
});
