// Diagnostic replay: model sees only observations available at each recorded decision.
// Later sampled bids are attached AFTER inference and are not proof of fills or accuracy.
import {readFileSync,appendFileSync,mkdirSync} from 'node:fs';
import '../server/config.ts';
import {JevProvider} from '../server/decisions/jev.ts';
import {recoveryFeatures,type IndexPoint} from '../server/decisions/recovery.ts';
import {RequestBudget} from '../server/decisions/budget.ts';
import type {Features} from '../server/decisions/types.ts';
const path=process.argv[2];if(!path)throw new Error('Usage: node --import tsx scripts/replay-jev.ts <journal.jsonl>');
const offsets=process.argv[3]?process.argv[3].split(",").map(Number):[100,45,20];
if(offsets.some(n=>!Number.isFinite(n)||n<1||n>120))throw new Error('Offsets must be seconds remaining, from 1 to 120');
const events=readFileSync(path,'utf8').trim().split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
const decisions=events.filter(e=>e.type==='decision'&&e.features.settlement?.dataAvailable).sort((a,b)=>a.features.observedAt-b.features.observedAt);
const candidates:any[]=[];
for(const symbol of ['XRP','BNB','HYPE']){
 const rows=decisions.filter(e=>e.features.symbol===symbol);
 const tickers=[...new Set(rows.map(e=>e.features.ticker))].slice(-2);
 for(const ticker of tickers)for(const seconds of offsets){
  const r=rows.find(e=>e.features.ticker===ticker&&e.features.secondsLeft<=seconds);
  if(r&&!candidates.includes(r))candidates.push(r);
 }
}
const budget=new RequestBudget('.runtime/jev/replay-budget.json',40);
const provider=new JevProvider(process.env.TYPESAFE_API_KEY??'',process.env.JEV_MODEL??'jev-latest');
mkdirSync('.runtime/jev',{recursive:true});let count=0,yes=0,tokens=0;
for(const row of candidates){
 const f:Features=structuredClone(row.features),s=f.settlement;
 const history:IndexPoint[]=decisions.filter(e=>e.features.ticker===f.ticker&&e.features.observedAt<=f.observedAt&&
  e.features.observedAt>=f.observedAt-65000).flatMap(e=>{
   const v=e.features.settlement;return v.sourceTime!==null&&v.underlyingPrice!==null?[{sourceTime:v.sourceTime,value:v.underlyingPrice}]:[];
  });
 f.version=3;
 f.recovery=recoveryFeatures({now:f.observedAt,openTime:f.closeTime-900000,closeTime:f.closeTime,candidateSide:f.candidateSide,
  underlyingPrice:s.underlyingPrice,sourceTime:s.sourceTime,history,strike:s.strike,strikeType:s.strikeType,roundDigits:s.roundDigits,
  runningAverage:s.runningAverage,sampleCount:s.finalMinuteSampleCount,coverageComplete:s.finalMinuteCoverageComplete});
 f.candidateMovement=f.movement.map(m=>({seconds:m.seconds,netCents:m.net*(f.candidateSide==='yes'?1:-1),rangeCents:m.range}));
 if(!budget.take())break;
 try{
  const answer=await provider.decide(f);count++;tokens+=answer.inputTokens;if(answer.choice!=='WAIT')yes++;
  const future=events.filter(e=>e.type==='observation'&&e.book.ticker===f.ticker&&e.book.observedAt>f.observedAt&&e.book.observedAt<f.closeTime)
   .map(e=>f.candidateSide==='yes'?e.book.yesBid:e.book.noBid).filter((v:any)=>typeof v==='number');
  const result={symbol:f.symbol,ticker:f.ticker,secondsLeft:f.secondsLeft,side:f.candidateSide,ask:f.candidateAsk,
   previous:row.answer.choice,current:answer.choice,condition:answer.reason,
   candidateNet10Bps:f.recovery.underlyingMovement.find(m=>m.seconds===10)?.candidateNetBps,
   cushionBps:f.recovery.remainingAverage.candidateCushionBps,contractClosed:Date.now()>=f.closeTime,maxLaterSampledBid:future.length?Math.max(...future):null};
  appendFileSync('.runtime/jev/replay-results.jsonl',JSON.stringify({type:'replay',time:Date.now(),features:f,answer,result})+'\n');
  console.log(JSON.stringify(result));
 }catch{console.log(JSON.stringify({ticker:f.ticker,secondsLeft:f.secondsLeft,error:'inference_failed'}));}
}
console.log(JSON.stringify({count,yes,no:count-yes,inputTokens:tokens,estimatedUSD:tokens/1e6*.042,
 caveat:'Small diagnostic sample selected by symbol/window/time, not an accuracy estimate. Underlying history reconstructed only from earlier logged observations; missing coverage is preserved. Later bids are withheld from model; no assumed fills.'}));
