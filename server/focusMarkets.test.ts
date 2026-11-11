import test from 'node:test';
import assert from 'node:assert/strict';
import { focusMarkets, focusRank, isLateContested } from '../src/lib/focusMarkets.ts';
const row = (score: number | null, sim30mTally = 0, sim1hTally = 0) => ({ connected: true, score, sim30mTally, sim1hTally });

test('15–85c overrides low or missing scores only in the final two minutes', () => {
  for (const currentYes of [15,20,50,80,85]) {
    const stats={BTC:{...row(1),currentYes}};
    assert.equal(focusMarkets(['BTC'],{},stats,120).visible.BTC,true);
    assert.equal(focusMarkets(['BTC'],{},stats,121).visible.BTC,false);
    assert.equal(isLateContested(stats.BTC,0),false);
  }
  for (const currentYes of [0,14,86,100,null]) assert.equal(isLateContested({...row(1),currentYes},60),false);
  assert.equal(isLateContested({...row(null),currentYes:40},60),true);
});

test('Focus thresholds preserve exactly 3, hide unknowns and keep disconnected choices', () => {
  const order = ['low','high','threeOn','threeOff','unknown','offline'];
  const before = {low:true, high:false, threeOn:true, threeOff:false, unknown:true, offline:true};
  const result = focusMarkets(order, before, {low:row(2),high:row(4),threeOn:row(3),threeOff:row(3),unknown:row(null),offline:{...row(1),connected:false}});
  assert.deepEqual(result.visible, {...before,low:false,high:true,unknown:false});
  assert.deepEqual(result.order, ['threeOn','offline','high','low','threeOff','unknown']);
});

test('ranking blends score and flips and preserves ties', () => {
  assert.ok(focusRank(row(6,3,6)) > focusRank(row(10)));
  const result = focusMarkets(['a','b','c'], {}, {a:row(10),b:row(6,3,6),c:row(6,3,6)});
  assert.deepEqual(result.order,['b','c','a']);
});

test('score changes never reorder survivors and returning markets append at the end', () => {
  let result = focusMarkets(['a','b','c'], {a:true,b:true,c:false}, {a:row(4),b:row(10),c:row(9)});
  assert.deepEqual(result.order, ['a','b','c']);
  result = focusMarkets(result.order,result.visible,{a:row(1),b:row(4),c:row(10)});
  assert.deepEqual(result.order.filter(s=>result.visible[s]), ['b','c']);
  result = focusMarkets(result.order,result.visible,{a:row(10),b:row(4),c:row(5)});
  assert.deepEqual(result.order, ['b','c','a']);
});

test('resting orders and positions stay visible regardless of score or connection', () => {
  const stats = { resting: {...row(1),resting:true}, holding:{...row(null),holding:true}, position:{...row(2),positionFp:-3,connected:false}, idle:row(2) };
  const result=focusMarkets(Object.keys(stats), {}, stats);
  assert.deepEqual(result.visible,{resting:true,holding:true,position:true,idle:false});
});
