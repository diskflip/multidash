import test from 'node:test';
import assert from 'node:assert/strict';
import { LivePortfolio } from './livePortfolio.ts';
import { KalshiFillsFeed, type OrderUpdate } from './kalshiFills.ts';

test('resting state counts every order, including partial fills and cancellations', () => {
  const state = new LivePortfolio();
  state.order('one','BTC',true);
  state.order('two','BTC',true);
  state.order('one','BTC',false);
  assert.equal(state.snapshot.restingTickers.has('BTC'),true);
  state.order('two','BTC',false);
  assert.equal(state.snapshot.restingTickers.has('BTC'),false);
});

test('a slow REST response cannot erase newer order, fill or close updates', () => {
  const state = new LivePortfolio();
  const revision = state.revision;
  state.order('new','BTC',true);
  state.order('canceled','ETH',false);
  state.position('BTC',true);
  state.position('ETH',false);
  const stale = new LivePortfolio().snapshot;
  stale.restingOrders.set('canceled','ETH');
  stale.holdingTickers.add('ETH');
  state.reconcile(stale,revision);
  assert.deepEqual([...state.snapshot.restingTickers],['BTC']);
  assert.deepEqual([...state.snapshot.holdingTickers],['BTC']);
});

test('order channel parsing immediately forwards resting, partial and terminal updates', () => {
  const updates: OrderUpdate[] = [];
  const feed = new KalshiFillsFeed(()=>{},()=>{},()=>{},update=>updates.push(update));
  const input = feed as unknown as {handleMessage(raw:string):void};
  for(const [status,remaining] of [['resting','10.00'],['resting','2.00'],['executed','0.00'],['canceled','0.00']]) {
    input.handleMessage(JSON.stringify({type:'user_order',msg:{order_id:'one',ticker:'BTC',status,remaining_count_fp:remaining}}));
  }
  assert.deepEqual(updates.map(update=>update.resting),[true,true,false,false]);
});
