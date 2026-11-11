import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SessionRequestBudget} from './budget.ts';
test('five-hour session budget persists across restarts and renews only when its window ends',()=>{
 const dir=mkdtempSync(join(tmpdir(),'jev-session-'));let now=1000000;const duration=5*3600000;
 try{
  const path=join(dir,'session.json');const first=new SessionRequestBudget(path,2,duration,()=>now);
  assert.equal(first.take(),true);
  const resumed=new SessionRequestBudget(path,2,duration,()=>now);assert.equal(resumed.take(),true);assert.equal(resumed.available(),false);
  now+=duration-1;assert.equal(resumed.available(),false);now++;assert.equal(resumed.take(),true);
  const again=new SessionRequestBudget(path,2,duration,()=>now);assert.equal(again.take(),true);assert.equal(again.available(),false);
 }finally{rmSync(dir,{recursive:true});}
});
