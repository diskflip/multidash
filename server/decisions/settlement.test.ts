import test from 'node:test';
import assert from 'node:assert/strict';
import {SettlementFeed,parseIndexTick,createSettlementReader} from './settlement.ts';
import {buildFeatures} from './features.ts';
import type {Book,DecisionInput,Features} from './types.ts';
const close=1800000,now=close-30000;
const average={value:'100.25',window_size:30,window_start_ts_ms:close-60000,window_end_ts_exclusive:now};
const frame=(time=now)=>({type:'cfbenchmarks_value',msg:{index_id:'BRTI',data:JSON.stringify({type:'value',id:'BRTI',time,value:'101.5'}),
 avg_60s_data:{...average,value:'99',window_size:60,window_start_ts_ms:time-60000,window_end_ts_exclusive:time},last_60s_windowed_average_15min:average}});
const book:Book={ticker:'t',observedAt:now,yesBid:6,noBid:93,yesAsk:7,noAsk:94,yesBidDepth:2,noBidDepth:2};
const input=():DecisionInput=>({symbol:'BTC',market:{ticker:'t',title:'t',openTime:close-900000,closeTime:close},
 history:[now-10000,now-5000,now].map(time=>({ticker:'t',time:time/1000,openTime:(close-900000)/1000,closeTime:close/1000,yes:6})),
 score:6,flips30m:1,flips1h:1,exposed:false,settlementInput:{tick:parseIndexTick(frame(),now),strike:100,strikeType:'greater_or_equal',roundDigits:2}});
const features=(row=input())=>buildFeatures(row,book,now) as Features;

test('actual final-minute average stays distinct from the trailing average and carries strike and coverage',()=>{
 const f=features();assert.equal(f.settlement.runningAverage,100.25);assert.equal(f.settlement.trailing60SecondAverage,99);
 assert.equal(f.settlement.underlyingPrice,101.5);assert.equal(f.settlement.finalMinuteSampleCount,30);
 assert.equal(f.settlement.finalMinuteCoverageComplete,true);assert.equal(f.settlement.strike,100);assert.equal(f.settlement.roundDigits,2);
});
test('missing, stale, partial and previous-contract averages cannot masquerade as a complete current average',()=>{
 for(const change of ['missing','stale','previous','partial','future'] as const){
  const row=input(),tick=row.settlementInput!.tick!;
  if(change==='missing')tick.finalMinute=null;
  if(change==='stale')tick.sourceTime=now-5001;
  if(change==='future')tick.sourceTime=now+1;
  if(change==='previous')tick.finalMinute!.start-=900000;
  if(change==='partial')tick.finalMinute!.count=10;
  const f=features(row);assert.equal(f.settlement.finalMinuteCoverageComplete,false);
  assert.equal(f.settlement.runningAverage,change==='partial'?100.25:null);
  if(change==='stale'||change==='future')assert.equal(f.settlement.underlyingPrice,null);
 }
});
test('start boundary is excluded and previous close average is not reused before the next final minute',()=>{
 const row=input();row.market!.closeTime=now+60000;
 assert.equal(features(row).settlement.runningAverage,null);
 assert.equal(features(row).settlement.averageStatus,'outside_window');
 row.market!.closeTime=close+900000;
 assert.equal(features(row).settlement.runningAverage,null);
});
test('index parser tolerates ordinary delivery jitter but rejects stale and bogus-future timestamps; duplicate and out-of-order ticks are ignored',()=>{
 // Kalshi stamps each value on an exact second boundary, so plain network
 // jitter routinely puts sourceTime a few ms ahead of the receiver's
 // clock — confirmed in production: up to ~50ms either side. Rejecting
 // that outright as "from the future" discarded roughly half of every
 // real tick, which is why there's a tolerance rather than a hard >now.
 assert.equal(parseIndexTick(frame(now+50),now)?.sourceTime,now+50);
 assert.equal(parseIndexTick(frame(now+2001),now),null);assert.equal(parseIndexTick(frame(now-5001),now),null);
 const bad=frame();bad.msg.data='{"value":null}';assert.equal(parseIndexTick(bad,now),null);
 const feed=new SettlementFeed();feed.ingest(frame(),now);feed.ingest(frame(now-1000),now);
 assert.equal(feed.get('BTC')?.sourceTime,now);assert.equal(feed.history('BTC').length,1);assert.equal(feed.get('ETH'),null);feed.stop();assert.equal(feed.get('BTC'),null);assert.equal(feed.history('BTC').length,0);
});
test('metadata is cached per contract, validates ticker and does not retain old strikes across rollover',async()=>{
 let calls=0;const feed=new SettlementFeed();const read=createSettlementReader(feed,async(url)=>{
  calls++;return Response.json({market:{ticker:String(url).split('/').at(-1)==='old'?'old':'wrong',floor_strike:100,strike_type:'greater_or_equal',custom_strike:{round_digits:'2'}}});
 });
 assert.equal((await read('BTC','old')).strike,100);await read('BTC','old');assert.equal(calls,1);
 assert.equal((await read('BTC','new')).strike,null);assert.equal(calls,2);
});
