import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoMarkets } from '../src/lib/autoMarkets.ts';
const row=(score:number|null,extra={})=>({score,connected:true,currentYes:99,ticker:'current',sim30mTally:0,sim1hTally:0,...extra});
const active=(result:ReturnType<AutoMarkets['select']>)=>result.order.filter(s=>result.visible[s]);

test('ten old cards collapse to capacity, keeping active candidates over six dead markets',()=>{
 const state=new AutoMarkets();const order=Array.from({length:10},(_,i)=>String(i));
 const stats=Object.fromEntries(order.map((s,i)=>[s,row(i<6?1:8)]));
 const result=state.select(order,Object.fromEntries(order.map(s=>[s,true])),stats,850,900,4);
 assert.deepEqual(active(result),['6','7','8','9']);
});
test('an inspected quiet card does not block cleanup of other dead cards',()=>{
 const state=new AutoMarkets();const order=['a','b','c'];const stats={a:row(1),b:row(1),c:row(9)};
 let result=state.select(order,{a:true,b:true,c:true},stats,850,900,3,new Set(['a']));
 result=state.select(result.order,result.visible,stats,870,900,3,new Set(['a']));
 assert.deepEqual(active(result),['a','c']);
});
test('reviving markets replace weaker candidates at capacity and append, without ranking survivors',()=>{
 const state=new AutoMarkets();let stats={a:row(5),b:row(6),c:row(1)};
 let result=state.select(['a','b','c'],{a:true,b:true,c:false},stats,600,900,2);
 stats={...stats,c:row(10)};
 result=state.select(result.order,result.visible,stats,630,900,2);
 assert.deepEqual(active(result),['b','c']);
 stats={a:row(1),b:row(10),c:row(5)};
 result=state.select(result.order,result.visible,stats,660,900,2);
 assert.deepEqual(active(result),['b','c']);
});
test('short score dips do not remove a new card, sustained quiet does',()=>{
 const state=new AutoMarkets();let result=state.select(['a'],{a:false},{a:row(8)},845,900,3);
 result=state.select(result.order,result.visible,{a:row(1)},850,900,3);assert.deepEqual(active(result),['a']);
 result=state.select(result.order,result.visible,{a:row(1)},855,900,3);assert.deepEqual(active(result),['a']);
 result=state.select(result.order,result.visible,{a:row(1)},860,900,3);assert.deepEqual(active(result),[]);
});
test('20–80c late comeback remains eligible despite low score; exposure always overrides capacity',()=>{
 const state=new AutoMarkets();const stats={a:row(1,{currentYes:25}),b:row(null,{resting:true}),c:row(1,{positionFp:2})};
 let result=state.select(['a','b','c'],{},stats,790,900,3);assert.deepEqual(active(result),['b','c','a']);
 result=state.select(result.order,result.visible,stats,850,900,1);assert.deepEqual(active(result),['b','c']);
});

test('pinned trades consume the available slots before optional strong markets',()=>{
 const state=new AutoMarkets();
 const result=state.select(['a','b','c','d'],{}, {
  a:row(1,{resting:true}),b:row(1,{holding:true}),c:row(1,{resting:true}),d:row(10),
 },850,900,2);
 assert.deepEqual(active(result),['a','b','c']);
});

test('strongest low-score late movement takes the remaining slot beside a pinned order',()=>{
 const state=new AutoMarkets();
 const stats={pinned:row(1,{resting:true}),quiet:row(5,{currentYes:99}),fx:row(2,{currentYes:8}),copper:row(2,{currentYes:30})};
 state.observe('fx',stats.fx,840);state.observe('copper',stats.copper,840);
 const moving={...stats,fx:row(2,{currentYes:16}),copper:row(2,{currentYes:42})};
 const result=state.select(['pinned','quiet','fx','copper'],{pinned:true,quiet:true},moving,850,900,2);
 assert.deepEqual(new Set(active(result)),new Set(['pinned','copper']));
 assert.equal(result.visible.quiet,false);
});

test('a collapsed price does not qualify from old movement, and rollover clears previous activity',()=>{
 const state=new AutoMarkets();
 state.observe('a',row(1,{currentYes:40,ticker:'old'}),840);
 let result=state.select(['a'],{}, {a:row(1,{currentYes:1,ticker:'old'})},850,900,3);
 assert.deepEqual(active(result),[]);
 state.observe('a',row(1,{currentYes:40,ticker:'old'}),851);
 result=state.select(['a'],{}, {a:row(1,{currentYes:10,ticker:'new'})},852,900,3);
 assert.deepEqual(active(result),[]);
});


test('strong crypto markets compete within capacity without reordering survivors',()=>{
 for(const capacity of [2,3]) {
  const state=new AutoMarkets();
  const order=['BTC','ETH','DOGE','XRP'];
  const stats={BTC:row(8),ETH:row(9),DOGE:row(7),XRP:row(6)};
  const result=state.select(order,{BTC:true,ETH:true,DOGE:true,XRP:false},stats,600,900,capacity);
  assert.deepEqual(active(result),order.slice(0,capacity));
 }
});

test('late contested markets remain eligible but cannot bypass capacity',()=>{
 const state=new AutoMarkets();
 const stats=Object.fromEntries([15,25,50,75,85].map(yes=>[String(yes),row(1,{currentYes:yes})]));
 const order=Object.keys(stats);
 assert.equal(state.needsAdmission(order,{},stats,779,900),false);
 assert.equal(state.needsAdmission(order,{},stats,780,900),true);
 assert.deepEqual(new Set(active(state.select(order,{},stats,780,900,2))),new Set(order.slice(0,2)));
});

test('late movement of two cents admits a low-score market promptly while flat and collapsed markets stay hidden',()=>{
 const state=new AutoMarkets();
 const stats={moving:row(1,{currentYes:8}),flat:row(1,{currentYes:8}),dead:row(1,{currentYes:1})};
 state.observe('moving',row(1,{currentYes:6}),830);
 state.observe('moving',stats.moving,840);
 state.observe('flat',stats.flat,830);state.observe('dead',stats.dead,830);
 assert.equal(state.needsAdmission(Object.keys(stats),{},stats,840,900),true);
 assert.deepEqual(active(state.select(Object.keys(stats),{},stats,840,900,1)),['moving']);
 assert.equal(state.needsAdmission(Object.keys(stats),{},stats,861,900),false);
});

test('BTC is always visible and first, even flat, disconnected, or previously hidden',()=>{
 for(const btc of [row(1,{currentYes:1}),row(null,{connected:false})]) {
  const state=new AutoMarkets();
  const stats={ETH:row(8),XRP:row(6),BTC:btc};
  let result=state.select(['ETH','XRP','BTC'],{ETH:true,XRP:true,BTC:false},stats,600,900,2);
  assert.deepEqual(active(result),['BTC','ETH']);
  result=state.select(result.order,result.visible,stats,850,900,2);
  assert.deepEqual(active(result),['BTC','ETH']);
 }
});

test('restricted AUTO excludes strong and late crypto contenders but preserves exposure and BTC',()=>{
 const state=new AutoMarkets(new Set(['BTC','GOLD','EURUSD']));
 const order=['BTC','ETH','XRP','GOLD','EURUSD'];
 const stats={BTC:row(1),ETH:row(10,{currentYes:45}),XRP:row(10,{resting:true}),GOLD:row(8),EURUSD:row(7)};
 const result=state.select(order,Object.fromEntries(order.map(s=>[s,true])),stats,850,900,3,new Set(['ETH']));
 assert.deepEqual(active(result),['BTC','XRP','GOLD']);
 assert.equal(state.needsAdmission(['ETH'],{ETH:false},stats,850,900),false);
 const cleared=state.select(result.order,result.visible,{...stats,XRP:row(10)},851,900,3);
 assert.equal(cleared.visible.XRP,false);
});


test('all categories compete for five total slots, with BTC first and no strong-score overflow',()=>{
 const state=new AutoMarkets();
 const order=['BTC','ETH','XRP','GOLD','SILVER','EURUSD','GBPUSD','OIL','NATGAS'];
 const stats=Object.fromEntries(order.map(symbol=>[symbol,row(8,{currentYes:40})]));
 const result=state.select(order,{},stats,850,900,5);
 assert.equal(active(result).length,5);assert.equal(active(result)[0],'BTC');
});

test('ordinary low-score markets need 4.5 to enter; late low-score contenders remain eligible',()=>{
 const state=new AutoMarkets();const stats={quiet:row(4),active:row(4.5),late:row(1,{currentYes:25})};
 assert.deepEqual(active(state.select(Object.keys(stats),{},stats,600,900,5)),['active']);
 assert.ok(active(state.select(Object.keys(stats),{},stats,850,900,5)).includes('late'));
});

test('stopped market feeds are removed despite stale high scores, dwell time, and hover',()=>{
 const state=new AutoMarkets();const order=['BTC','GOLD','SILVER'];
 let stats={BTC:row(8),GOLD:row(9),SILVER:row(10)};
 let result=state.select(order,{},stats,600,900,6);
 stats={...stats,GOLD:row(9,{currentYes:null}),SILVER:row(10,{ticker:null,currentYes:null})};
 assert.equal(state.needsRemoval(order,result.visible,stats),true);
 result=state.select(order,result.visible,stats,601,900,6,new Set(['GOLD','SILVER']));
 assert.deepEqual(active(result),['BTC']);
 assert.equal(state.needsAdmission(order,result.visible,stats,850,900),false);
 const resumed=state.select(order,result.visible,{...stats,GOLD:row(9)},602,900,6);
 assert.deepEqual(active(resumed),['BTC','GOLD']);
});

test('stale feeds preserve resting orders and held positions, but not disconnected empty cards',()=>{
 const state=new AutoMarkets();const stats={GOLD:row(9,{currentYes:null,resting:true}),
  SILVER:row(9,{connected:false,holding:true}),OIL:row(10,{connected:false})};
 const result=state.select(Object.keys(stats),{GOLD:true,SILVER:true,OIL:true},stats,600,900,6);
 assert.deepEqual(active(result),['GOLD','SILVER']);
});
