import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { normalizeQuickTrade, quickAction, quickOrder } from '../src/lib/quickTrade.ts';
import { validateQuickOrder, postQuickOrder } from './quickTrade.ts';
import { fetchBotEvents } from './botControl.ts';
import { config } from './config.ts';
const entry = { ticker: 'BTC-current', quick: { next_action: 'buy', buy_complete: false, filled_cost: '1.25', budget: '5.00', held_side: 'yes', position_id: 'position-1', error: null } };

test('version gate, partial buys, completed sells and stale position validation', () => {
  assert.equal(quickAction(normalizeQuickTrade(entry, undefined)), null);
  assert.equal(quickAction(normalizeQuickTrade(entry, 2)), null);
  const partial = normalizeQuickTrade(entry, 1);
  assert.equal(partial.quick?.filled_cost, 1.25);
  const buy = quickOrder(partial, randomUUID());
  assert.deepEqual(buy, { ticker: entry.ticker, request_id: buy.request_id, action: 'buy', side: 'yes' });
  assert.deepEqual(validateQuickOrder(partial, buy), buy);
  const premature = normalizeQuickTrade({ ...entry, quick: { ...entry.quick, next_action: 'sell' } }, 1);
  assert.equal(quickAction(premature), null);
  const complete = normalizeQuickTrade({ ...entry, quick: { ...entry.quick, next_action: 'sell', buy_complete: true, held_side: 'no' } }, 1);
  const sell = quickOrder(complete, randomUUID());
  assert.equal(sell.side, 'no'); assert.equal(sell.position_id, 'position-1');
  assert.throws(() => validateQuickOrder(complete, buy));
  assert.throws(() => validateQuickOrder(complete, { ...sell, ticker: 'old-window' }));
  assert.throws(() => validateQuickOrder(complete, { ...sell, position_id: 'old-position' }));
  assert.throws(() => validateQuickOrder(complete, { ...sell, request_id: 'bad' }));
});

test('resting feedback uses actual working order price and keeps zero-fill progress', () => {
  const status = normalizeQuickTrade({ ...entry, quick: {
    ...entry.quick, active: true, status: 'resting', action: 'buy', filled_cost: '0',
    orders: [
      { action: 'buy', price: '0.3300', remaining_quantity: '15.15', status: 'resting' },
      { action: 'buy', price: '0.3000', remaining_quantity: '0', status: 'canceled' },
    ],
  } }, 1);
  assert.equal(status.quick?.filled_cost, 0);
  assert.equal(status.quick?.action, 'buy');
  assert.deepEqual(status.quick?.orders, [{ action: 'buy', price: .33, remaining: 15.15 }]);
  const cancel = quickOrder(status, randomUUID());
  assert.equal(cancel.action, 'buy'); // Existing endpoint toggles the resting BUY.
  assert.deepEqual(validateQuickOrder(status, cancel, true), cancel);
  assert.throws(() => validateQuickOrder(status, cancel, false), /resting order changed/);
  const cleared = normalizeQuickTrade(entry, 1);
  assert.throws(() => validateQuickOrder(cleared, cancel, true), /resting order changed/);
});

test('authenticated quick POST retries identical body and UUID; 202 is only queued', async () => {
  const originalFetch = globalThis.fetch, token = config.controlToken;
  config.controlToken = 'test-token';
  try {
    const calls: string[] = [];
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), `${config.multibotApiUrl}/v1/bots/KXBTC15M/quick`);
      assert.equal(init?.method, 'POST');
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer test-token');
      calls.push(String(init?.body));
      if (calls.length === 1) throw new Error('response lost');
      return Response.json({ queued: true }, { status: 202 });
    };
    const buy = quickOrder(normalizeQuickTrade(entry, 1), randomUUID());
    assert.deepEqual(await postQuickOrder('KXBTC15M', buy), { queued: true });
    assert.equal(calls.length, 2); assert.equal(calls[0], calls[1]);
    assert.deepEqual(JSON.parse(calls[0]), buy);
    let failures = 0;
    globalThis.fetch = async () => { failures++; return Response.json({ quick: { error: 'Maker order rejected' } }, { status: 409 }); };
    await assert.rejects(postQuickOrder('KXBTC15M', buy), /Maker order rejected/);
    assert.equal(failures, 1);
  } finally { globalThis.fetch = originalFetch; config.controlToken = token; }
});

test('existing bot polling forwards version, ticker, partial fills and errors', async () => {
  const originalFetch = globalThis.fetch, token = config.controlToken;
  config.controlToken = 'test-token';
  try {
    globalThis.fetch = async () => Response.json({ quick_trade_version: 1, bots: [{ series: 'KXBTC15M', ...entry, quick: { ...entry.quick, error: 'Insufficient balance' } }] });
    const status = (await fetchBotEvents())?.get('KXBTC15M')?.quickTrade;
    assert.equal(status?.version, 1); assert.equal(status?.ticker, entry.ticker);
    assert.equal(status?.quick?.error, 'Insufficient balance');
    assert.equal(status?.quick?.budget, 5);
  } finally { globalThis.fetch = originalFetch; config.controlToken = token; }
});
