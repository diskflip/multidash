import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LeaderboardSim } from './leaderboardSim.ts';
import { LeaderboardStore } from './leaderboardStore.ts';
const point=(time:number,yes:number,ticker='A',openTime=0,closeTime=900)=>({time,yes,ticker,openTime,closeTime});

test('platinum opening quote spike cannot produce a phantom 7-to-94 win',()=>{
  const sim=new LeaderboardSim();
  sim.onPrice(point(.018,4));
  sim.onPrice(point(.235,48));
  sim.onPrice(point(2.048,48));
  sim.onPrice(point(6.035,51));
  sim.onPrice(point(582.006,94));
  assert.equal(sim.snapshot(583).wins,0);
  assert.equal(sim.snapshot(583).profitDollars,0);
});

test('a genuine entry after the opening guard still wins and has an audit record',()=>{
  const sim=new LeaderboardSim();
  sim.onPrice(point(5,7));sim.onPrice(point(20,94));
  assert.equal(sim.snapshot(20).wins,1);
  assert.deepEqual(sim.state.trades[0],{ticker:'A',side:'yes',entryTime:5,time:20,profit:5*(94/7-1)});
});

test('7c then 94c resolves one $5 win, not repeated wins at the target',()=>{
  const sim=new LeaderboardSim();
  sim.onPrice(point(10,7));sim.onPrice(point(20,93));
  assert.equal(sim.snapshot(20).wins,0);
  sim.onPrice(point(21,94));sim.onPrice(point(22,95));
  assert.deepEqual(sim.snapshot(22),{profitDollars:62.14,wins:1,losses:0});
});
test('NO side works, zero quotes cannot enter, and only one stake is open',()=>{
  const sim=new LeaderboardSim();sim.onPrice(point(10,100));assert.equal(sim.state.side,null);
  sim.onPrice(point(11,93));sim.onPrice(point(12,7));assert.equal(sim.state.side,'no');
  sim.onPrice(point(13,6));assert.equal(sim.snapshot(13).wins,1);
});
test('rollover charges unfinished trades once and does not connect markets',()=>{
  const sim=new LeaderboardSim();sim.onPrice(point(10,7));
  assert.equal(sim.snapshot(900).profitDollars,-5);
  assert.equal(sim.snapshot(901).losses,1);
  sim.onPrice(point(899,94));assert.equal(sim.snapshot(901).wins,0);
  sim.onPrice(point(902,94,'B',900,1800));assert.equal(sim.snapshot(902).wins,0);
});
test('profit uses exit time in the rolling window, including entries before its start',()=>{
  const sim=new LeaderboardSim();sim.onPrice(point(100,7,'A',0,3600));sim.onPrice(point(1850,94,'A',0,3600));
  assert.equal(sim.snapshot(1901).wins,1);assert.equal(sim.snapshot(3650).wins,0);
});
test('stored state backfills history once and survives restart without duplicate wins',()=>{
  const dir=mkdtempSync(join(tmpdir(),'leaderboard-'));try{
    const file=join(dir,'state.json');const history=[point(10,7),point(20,94)];
    const first=new LeaderboardStore(file,['BTC'],()=>history);assert.equal(first.message(20).rows[0].wins,1);first.save();
    const restored=new LeaderboardStore(file,['BTC'],()=>history);assert.deepEqual(restored.message(20),first.message(20));
  }finally{rmSync(dir,{recursive:true,force:true});}
});
