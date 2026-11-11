import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildFeatures} from './features.ts';
import {parseBook} from './book.ts';
import {JevProvider,parseAnswer} from './jev.ts';
import {DecisionService,requestedLate,type DecisionSettings} from './service.ts';
import {RequestBudget} from './budget.ts';
import {DecisionEvaluation} from './evaluation.ts';
import type {Book,DecisionInput,Features,ModelAnswer} from './types.ts';
const now=1000000;
const input=():DecisionInput=>({symbol:'BTC',market:{ticker:'t',title:'test',openTime:900000,closeTime:1080000},
 history:[990,995,1000].map(time=>({ticker:'t',time,openTime:900,closeTime:1080,yes:6})),score:6,flips30m:1,flips1h:2,exposed:false,requested:true});
const book:Book={ticker:'t',observedAt:now,yesBid:6,noBid:93,yesAsk:7,noAsk:94,yesBidDepth:20,noBidDepth:30};
const answer:ModelAnswer={choice:'ENTER_YES',confidence:.9,reason:'recovering',model:'jev-test',probabilities:{ENTER_YES:.8,ENTER_NO:.1,WAIT:.1},inputTokens:100,outputTokens:5};
const raw={model:'jev-test',answers:{entry:{type:'choice',choice:'YES',confidence:.9,probabilities:{YES:.8,NO:.2}}},usage:{input_tokens:100,output_tokens:5}};
const settings:DecisionSettings={enabled:true,symbols:['BTC'],intervalMs:5000,lateIntervalMs:2000,maxCallsPerMinute:600};
const flush=()=>new Promise<void>(r=>setImmediate(r));

test('features stay contract-scoped, exclude future points, and reject stale or gapped input',()=>{
 const row=input();row.history.push({...row.history[0],time:1001,yes:99});
 const features=buildFeatures(row,book,now) as Features;
 assert.equal(features.recentYesBids.at(-1)?.cents,6);assert.deepEqual(features.eligibleSides,['yes']);
 assert.equal((buildFeatures({...row,exposed:true},book,now) as Features).candidateSide,'yes');
 assert.equal(buildFeatures(input(),{...book,observedAt:now-3000},now),'stale_book');
 assert.equal(buildFeatures({...input(),history:input().history.map((p,i)=>({...p,breakBefore:i===1}))},book,now),'history_gap');
 assert.equal(buildFeatures({...input(),market:{...input().market!,ticker:'other'}},book,now),'market_closed');
 assert.equal(buildFeatures(input(),{...book,noBid:null},now),'incomplete_book');
});
test('book derives actual complementary asks, not NO from the YES bid',()=>{
 const parsed=parseBook({orderbook_fp:{yes_dollars:[['0.06','20']],no_dollars:[['0.93','30']]}},'t',now);
 assert.equal(parsed.noBid,93);assert.equal(parsed.yesAsk,7);assert.equal(parsed.noAsk,94);
 assert.equal(parseBook({},'t',now).yesAsk,null);
});
test('official provider request is typed and malformed confidence/choices are rejected',async()=>{
 let body:any;
 const provider=new JevProvider('test-secret','jev-latest',async(url,init)=>{
  assert.equal(url,'https://api.typesafe.ai/v1/systemone');body=JSON.parse(String(init?.body));
  assert.equal((init?.headers as Record<string,string>).Authorization,'Bearer test-secret');return Response.json(raw);
 });
 assert.equal((await provider.decide(buildFeatures(input(),book,now) as Features)).choice,'ENTER_YES');
 assert.equal(body.questions.entry.type,'choice');assert.equal(body.state.candidate.side,'yes');
 assert.throws(()=>parseAnswer({...raw,answers:{entry:{...raw.answers.entry,choice:'BUY_EVERYTHING'}}}));
 assert.throws(()=>parseAnswer({...raw,answers:{entry:{...raw.answers.entry,confidence:2}}}));
});
test('service is inert without configuration, single-flight when enabled, and rejects rollover responses',async()=>{
 let calls=0,resolve!:(a:ModelAnswer)=>void;let row=input();
 const deps={inputs:()=>[row],provider:{decide:()=>{calls++;return new Promise<ModelAnswer>(r=>resolve=r);}},book:async()=>book,publish:()=>{},log:()=>{},now:()=>now};
 const disabled=new DecisionService({...settings,enabled:false},deps);disabled.tick();await flush();assert.equal(calls,0);
 const service=new DecisionService(settings,deps);service.tick();await flush();service.tick();assert.equal(calls,1);
 row={...row,market:{...row.market!,ticker:'new'}};resolve(answer);await flush();
 assert.notEqual(service.latest.get('BTC')?.choice,'ENTER_YES');
});
test('model confidence is reported without hiding its answer; ineligible sides wait; failures are unavailable',async()=>{
 for(const result of [{...answer,confidence:.2},{...answer,choice:'ENTER_NO' as const}]) {
  const service=new DecisionService(settings,{inputs:()=>[input()],provider:{decide:async()=>result},book:async()=>book,publish:()=>{},log:()=>{},now:()=>now});
  service.tick();await flush();assert.equal(service.latest.get('BTC')?.choice,result.choice==='ENTER_YES'?'ENTER_YES':'WAIT');
 }
 const service=new DecisionService(settings,{inputs:()=>[input()],provider:{decide:async()=>{throw new Error('timeout')}},book:async()=>book,publish:()=>{},log:()=>{},now:()=>now});
 service.tick();await flush();assert.equal(service.latest.get('BTC')?.status,'unavailable');
});
test('recommendations expire, removing a chart clears them, and the request budget survives restart',async()=>{
 let clock=now,row=input();
 const service=new DecisionService(settings,{inputs:()=>[row],provider:{decide:async()=>answer},book:async()=>book,publish:()=>{},log:()=>{},now:()=>clock});
 service.tick();await flush();assert.equal(service.latest.get('BTC')?.choice,'ENTER_YES');
 row={...row,requested:false};service.tick();assert.equal(service.latest.get('BTC')?.choice,'WAIT');
 clock+=6000;service.tick();await flush();assert.equal(service.latest.get('BTC')?.choice,'WAIT');
 const dir=mkdtempSync(join(tmpdir(),'jev-test-'));
 try{const path=join(dir,'budget.json');assert.equal(new RequestBudget(path,1,()=>now).take(),true);assert.equal(new RequestBudget(path,1,()=>now).take(),false);}finally{rmSync(dir,{recursive:true});}
});
test('evaluation cannot count a target before entry, or use another contract',()=>{
 const evaluation=new DecisionEvaluation(),features=buildFeatures(input(),book,now) as Features;
 evaluation.ingest({type:'decision',features,answer,modelLatencyMs:40,decision:{symbol:'BTC',ticker:'t',mode:'shadow',status:'ready',choice:'ENTER_YES',reason:'recovering',confidence:.9,observedAt:now,expiresAt:now+5000,latencyMs:40,model:'test'}});
 evaluation.ingest({type:'observation',book:{...book,observedAt:now-1,yesBid:99}});
 evaluation.ingest({type:'observation',book:{...book,ticker:'other',observedAt:now+1000,yesBid:99}});
 assert.equal(evaluation.report(now).recommended.observedEntryTo94Paths,0);
 evaluation.ingest({type:'observation',book:{...book,observedAt:now+2000}});
 evaluation.ingest({type:'observation',book:{...book,yesAsk:95,yesBid:94,observedAt:now+3000}});
 assert.equal(evaluation.report(now+4000).recommended.observedEntryTo94Paths,1);
 assert.equal(evaluation.report(now+4000).recommended.contractsAndSides,1);
});


test('only displayed AUTO markets in their final two minutes are requested',()=>{
 assert.equal(requestedLate({...input(),requested:false},now),false);
 assert.equal(requestedLate(input(),1080000-120001),false);
 assert.equal(requestedLate(input(),1080000-120000),true);
 assert.equal(requestedLate(input(),1080000-1),true);
 assert.equal(requestedLate(input(),1080000),false);
});

test('all displayed markets receive one decision per second; hidden markets and early windows make no calls',async()=>{
 let clock=now,calls=0;
 const symbols=['BTC','ETH','XRP','SOL','DOGE','BNB','NEAR','HYPE','ZEC'];
 let rows=symbols.map(symbol=>({...input(),symbol}));
 const service=new DecisionService({...settings,symbols,intervalMs:1000,lateIntervalMs:1000},
  {inputs:()=>rows,provider:{decide:async()=>{calls++;return answer;}},book:async()=>({...book,observedAt:clock}),publish:()=>{},log:()=>{},now:()=>clock});
 service.tick();await flush();assert.equal(calls,9);
 clock+=999;service.tick();await flush();assert.equal(calls,9);
 clock++;service.tick();await flush();assert.equal(calls,18);
 rows=rows.map(row=>({...row,requested:false}));clock+=1000;service.tick();await flush();assert.equal(calls,18);
 rows=rows.map(row=>({...row,requested:true,market:{...row.market!,closeTime:clock+121000}}));clock+=100;service.tick();await flush();assert.equal(calls,18);
});

test('settlement context distinguishes the underlying average from contract prices and marks missing data',()=>{
 const row=input();row.market={...row.market!,closeTime:now+30000};
 const features=buildFeatures(row,book,now) as Features;
 assert.equal(features.settlement.rule,'final_60_second_index_average');
 assert.equal(features.settlement.elapsedWindowSeconds,30);
 assert.equal(features.settlement.runningAverage,null);
 assert.equal(features.settlement.dataAvailable,false);
 assert.equal(features.freshness.scoreFreshness,'unknown');
 assert.equal((buildFeatures(input(),book,now) as Features).settlement.elapsedWindowSeconds,0);
 assert.equal((buildFeatures({...row,symbol:'EURUSD'},book,now) as Features).settlement.rule,'unknown');
});

test('one-second observations are retained and quote ages cannot exceed five seconds',()=>{
 const row=input();row.history=[990,995,996,997,998,999].map(time=>({...row.history[0],time}));
 const features=buildFeatures(row,book,now) as Features;
 assert.equal(features.recentYesBids.length,6);
 assert.equal(features.freshness.quoteAgeMs,1000);
 assert.equal(features.freshness.recentMaxQuoteIntervalMs,5000);
 assert.equal(buildFeatures(row,{...book,observedAt:now+4001},now+4001),'stale_quotes');
});

test('slow inference cannot extend the lifetime of the original historical quote',async()=>{
 let clock=now;
 const row=input();row.history=row.history.map(p=>({...p,time:p.time-4.5}));
 const service=new DecisionService(settings,{inputs:()=>[row],provider:{decide:async()=>{clock+=600;return answer;}},
  book:async()=>book,publish:()=>{},log:()=>{},now:()=>clock});
 service.tick();await flush();assert.equal(service.latest.get('BTC')?.reason,'market_changed');
});

test('service forwards fresh settlement inputs and expires the decision with their source age',async()=>{
 let clock=now;let captured:Features|undefined;
 const service=new DecisionService(settings,{inputs:()=>[input()],book:async()=>book,
  settlement:async()=>({tick:{indexId:'BRTI',sourceTime:now-4500,value:101,trailing:null,finalMinute:null},strike:100,strikeType:'greater_or_equal',roundDigits:2}),
  provider:{decide:async f=>{captured=f;clock+=600;return answer;}},publish:()=>{},log:()=>{},now:()=>clock});
 service.tick();await flush();assert.equal(captured?.settlement.underlyingPrice,101);
 assert.equal(captured?.settlement.strike,100);assert.equal(service.latest.get('BTC')?.reason,'market_changed');
});

test('exhausted budget stops book traffic; increasing cap preserves counts and allows requests again',async()=>{
 let books=0,calls=0;
 const service=new DecisionService(settings,{inputs:()=>[input()],hasBudget:()=>false,
  book:async()=>{books++;return book;},provider:{decide:async()=>{calls++;return answer;}},publish:()=>{},log:()=>{},now:()=>now});
 service.tick();await flush();assert.equal(books,0);assert.equal(calls,0);
 assert.equal(service.latest.get('BTC')?.reason,'trial_limit_reached');
 const dir=mkdtempSync(join(tmpdir(),'jev-cap-'));
 try{
  const path=join(dir,'budget.json');const first=new RequestBudget(path,1,()=>now);
  assert.equal(first.available(),true);assert.equal(first.take(),true);assert.equal(first.available(),false);
  const raised=new RequestBudget(path,2,()=>now);assert.equal(raised.available(),true);assert.equal(raised.take(),true);assert.equal(raised.available(),false);
 }finally{rmSync(dir,{recursive:true});}
});

test('five-second cadence fits nine markets across twenty rounds below the session allowance',async()=>{
 let clock=now,calls=0;
 const symbols=['BTC','ETH','XRP','SOL','DOGE','BNB','NEAR','HYPE','ZEC'];
 const rows=()=>symbols.map(symbol=>({...input(),symbol,market:{...input().market!,openTime:Math.floor(clock/900000)*900000,closeTime:(Math.floor(clock/900000)+1)*900000},
  history:[clock-10000,clock-5000,clock].map(time=>({...input().history[0],time:time/1000,openTime:Math.floor(clock/900000)*900,closeTime:(Math.floor(clock/900000)+1)*900}))}));
 const service=new DecisionService({...settings,symbols,intervalMs:5000,lateIntervalMs:5000},
 {inputs:rows,provider:{decide:async()=>{calls++;return answer;}},book:async()=>({...book,observedAt:clock}),publish:()=>{},log:()=>{},now:()=>clock});
 for(let round=1;round<=20;round++)for(let elapsed=0;elapsed<120000;elapsed+=500){
  clock=round*900000-120000+elapsed;service.tick();await flush();
 }
 assert.equal(calls,9*24*20);assert.ok(calls<7000);
});
