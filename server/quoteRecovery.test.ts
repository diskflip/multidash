import {test} from 'node:test';
import assert from 'node:assert/strict';
import {QuoteRecovery, readYesBid} from './quoteRecovery.ts';
import type {HistoryPoint} from '../src/types/market.ts';

test('quiet forex gets fresh observations before the ten-second cutoff, never fabricated backfill', async()=>{
 let now=900000, reads=0;
 const market={ticker:'new',title:'new',openTime:900000,closeTime:1800000};
 const points:HistoryPoint[]=[];
 const recovery=new QuoteRecovery(async()=>{reads++;return 7;},()=>now);
 const refresh=()=>recovery.refresh('EURUSD',()=>market,()=>points.at(-1),p=>points.push(p));
 await refresh(); now+=1000; await refresh(); assert.equal(reads,1);
 now+=2000; await refresh(); assert.equal(reads,2);
 assert.deepEqual(points.map(p=>[p.time,p.yes,p.source]),[[900,7,'snapshot'],[903,7,'snapshot']]);
});

test('late REST cannot overwrite a live tick, another contract, or an expired window', async()=>{
 for(const change of ['tick','roll','close']) {
  let now=900000;
  let market={ticker:'new',title:'new',openTime:900000,closeTime:1800000};
  let latest:HistoryPoint|undefined;
  let resolve!:(n:number)=>void;
  const recovery=new QuoteRecovery(()=>new Promise(r=>{resolve=r}),()=>now);
  const output:HistoryPoint[]=[];
  const result=recovery.refresh('EURUSD',()=>market,()=>latest,p=>output.push(p));
  if(change==='tick') latest={ticker:'new',time:900.01,yes:60,openTime:900,closeTime:1800};
  if(change==='roll') market={...market,ticker:'later'};
  if(change==='close') now=1800000;
  resolve(7); await result; assert.equal(output.length,0,change);
 }
});

test('missing/empty book and failed requests do not create zero-price points', async()=>{
 const original=globalThis.fetch;
 try {
  globalThis.fetch=async()=>Response.json({orderbook_fp:{yes_dollars:[]}});
  assert.equal(await readYesBid('test'),null);
  globalThis.fetch=async()=>Response.json({orderbook_fp:{yes_dollars:[['0.23','2'],['0.90','0'],['0.17','10']]}});
  assert.equal(await readYesBid('test'),23);
  globalThis.fetch=async()=>new Response('',{status:429});
  await assert.rejects(readYesBid('test'),/429/);
 } finally {globalThis.fetch=original;}
});
