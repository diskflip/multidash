import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCurrentMarket } from './findMarket.ts';
import { KalshiFeed } from './kalshiSocket.ts';

test('lookup crossing the close boundary selects the market open after REST completes', async () => {
  const originalFetch=globalThis.fetch;
  const originalNow=Date.now;
  let now=899900;
  Date.now=()=>now;
  try {
    globalThis.fetch=async()=>{
      now=900100;
      return Response.json({markets:[
        {ticker:'old',open_time:new Date(0).toISOString(),close_time:new Date(900000).toISOString()},
        {ticker:'new',open_time:new Date(900000).toISOString(),close_time:new Date(1800000).toISOString()},
      ]});
    };
    assert.equal((await findCurrentMarket('test'))?.ticker,'new');
  } finally {globalThis.fetch=originalFetch;Date.now=originalNow;}
});

test('feed preserves exchange milliseconds and rejects old tickers and reordered ticks', () => {
  const seen: Array<{yes:number;ticker:string;time:number;breakBefore:boolean}>=[];
  const feed=new KalshiFeed(p=>seen.push(p));
  const ingest=(ticker:string,ts_ms:number,yes_bid_dollars='0.50')=>
    (feed as unknown as {handleMessage(raw:string):void}).handleMessage(JSON.stringify({type:'ticker',msg:{market_ticker:ticker,ts_ms,yes_bid_dollars}}));
  feed.promote('old');
  ingest('old',1000123);
  ingest('old',1000100); // late tick
  feed.promote('new');
  ingest('old',1001000); // old contract after promotion
  ingest('new',1001456,'0.02');
  ingest('new',1001500,'NaN');
  assert.deepEqual(seen.map(p=>[p.ticker,p.time,p.yes]),[['old',1000.123,50],['new',1001.456,2]]);
  assert.equal(seen[0].breakBefore,true);
  feed.pause();
  ingest('new',1002000);
  assert.equal(seen.length,2);
});

test('opening ticks racing the boundary are replayed exactly once with source timestamps', () => {
  const seen: Array<{yes:number;ticker:string;time:number;breakBefore:boolean}>=[];
  const feed=new KalshiFeed(p=>seen.push(p));
  const ingest=(time:number,yes:string)=>
    (feed as unknown as {handleMessage(raw:string):void}).handleMessage(JSON.stringify({type:'ticker',msg:{market_ticker:'new',ts_ms:time,yes_bid_dollars:yes}}));
  feed.promote('old');
  feed.ensureSubscribed('new');
  ingest(899999,'0.01');
  ingest(900001,'0.07');
  ingest(900030,'0.08');
  assert.equal(seen.length,0);
  feed.promote('new',900);
  feed.promote('new',900);
  ingest(900020,'0.03');
  ingest(900050,'0.09');
  assert.deepEqual(seen.map(p=>[p.time,p.yes]),[[900.001,7],[900.03,8],[900.05,9]]);
});

test('next-market lookup finds the successor after exchange status switches to open', async () => {
  const {findNextMarket}=await import('./findMarket.ts');
  const originalFetch=globalThis.fetch;
  try {
    globalThis.fetch=async input=>Response.json({markets:String(input).includes('status=open&') ? [
      {ticker:'new',open_time:new Date(900000).toISOString(),close_time:new Date(1800000).toISOString()},
    ]:[]});
    assert.equal((await findNextMarket('test',900000))?.ticker,'new');
  } finally {globalThis.fetch=originalFetch;}
});
