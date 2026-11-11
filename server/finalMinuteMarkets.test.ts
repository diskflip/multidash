import test from 'node:test';
import assert from 'node:assert/strict';
import { FinalMinuteMarkets } from '../src/lib/finalMinuteMarkets.ts';
const row=(score:number|null)=>({connected:true,score,sim30mTally:0,sim1hTally:0});

test('contested markets survive low scores and get priority for free slots',()=>{
  const state=new FinalMinuteMarkets();
  const stats={a:{...row(1),currentYes:30},b:row(10),c:{...row(1),currentYes:70}};
  let result=state.select(['a','b','c'],{a:true,b:false,c:false},stats,840,900,2);
  assert.deepEqual(result.visible,{a:true,b:false,c:true});
  result=state.select(result.order,result.visible,stats,885,900,2);
  assert.deepEqual(result.visible,{a:true,b:false,c:true});
});

test('visible cards stay for 30s and need 20 uninterrupted seconds below 3',()=>{
  const state=new FinalMinuteMarkets();
  const order=['BTC','ETH'];let visible={BTC:true,ETH:false};
  let result=state.select(order,visible,{BTC:row(2),ETH:row(8)},840,900,1);
  assert.equal(result.visible.BTC,true);assert.equal(result.visible.ETH,false);
  result=state.select(order,result.visible,{BTC:row(2),ETH:row(8)},860,900,1);
  assert.equal(result.visible.BTC,true);
  state.observe('BTC',row(4),861); // Brief recovery between checks resets the timer.
  state.observe('BTC',row(2),865);
  result=state.select(order,result.visible,{BTC:row(2),ETH:row(8)},880,900,1);
  assert.equal(result.visible.BTC,true);
  result=state.select(order,result.visible,{BTC:row(2),ETH:row(8)},885,900,1);
  assert.equal(result.visible.BTC,false);assert.equal(result.visible.ETH,true);
});

test('survivors keep order; newcomers fill capacity in score order',()=>{
  const state=new FinalMinuteMarkets();const stats={a:row(4),b:row(5),c:row(9),d:row(8)};
  const result=state.select(['a','b','c','d'],{a:true,b:true,c:false,d:false},stats,840,900,3);
  assert.deepEqual(result.order,['a','b','c','d']);assert.equal(result.visible.c,true);assert.equal(result.visible.d,false);
  const later=state.select(result.order,result.visible,{...stats,a:row(10),c:row(4)},850,900,3);
  assert.deepEqual(later.order,result.order);
});

test('open trades override capacity; unavailable scores do not cause disappearance',()=>{
  const state=new FinalMinuteMarkets();const stats={a:row(null),b:{...row(1),resting:true},c:row(10)};
  let result=state.select(['a','b','c'],{a:true,b:false,c:false},stats,840,900,1);
  result=state.select(result.order,result.visible,stats,880,900,1);
  assert.deepEqual(result.visible,{a:true,b:true,c:false});
});

test('new market resets old retention times',()=>{
  const state=new FinalMinuteMarkets();state.select(['a'],{a:true},{a:row(1)},840,900,1);
  const result=state.select(['a'],{a:true},{a:row(1)},1740,1800,1);
  assert.equal(result.visible.a,true);
});

test('newly resting trades append after survivors even if originally earlier in the list',()=>{
  const state=new FinalMinuteMarkets();
  const result=state.select(['a','b','c'],{a:false,b:true,c:true},{a:{...row(1),resting:true},b:row(5),c:row(5)},850,900,2);
  assert.deepEqual(result.order,['b','c','a']);
});
