import type {Book,Features,ModelAnswer} from './types.ts';
import type {JevDecision} from '../../src/types/decision.ts';
type Trial={ticker:string;side:'yes'|'no';entry:number;recommended:boolean;start:number;close:number;filled:boolean;hit:boolean;last:number;gap:boolean};
export type EvaluationEvent={type:'observation';book:Book}|{type:'decision';features:Features;decision:JevDecision;answer:ModelAnswer;modelLatencyMs:number}|{type:'inference';answer:ModelAnswer;latencyMs:number};
// Forward-only observational comparison, one trial per side/contract. This does
// not assume queue fills or infer a missed target between sampled book reads.
export class DecisionEvaluation {
 private trials=new Map<string,Trial>();private latency:number[]=[];private tokens=0;private count=0;
 ingest(event:EvaluationEvent) {
  if(event.type==='inference') {
   this.count++;this.tokens+=event.answer.inputTokens;this.latency.push(event.latencyMs);
  } else if(event.type==='decision') {
   if(event.features.version!==2&&event.features.version!==3)return;
   for(const side of event.features.eligibleSides) {
    const key=`${event.features.ticker}:${side}`;
    if(!this.trials.has(key))this.trials.set(key,{ticker:event.features.ticker,side,entry:event.features.candidateAsk,
      recommended:event.decision.choice===(side==='yes'?'ENTER_YES':'ENTER_NO'),start:event.decision.observedAt,
      close:event.features.closeTime,filled:false,hit:false,last:event.decision.observedAt,gap:false});
   }
  } else if(event.type==='observation') {
   const book=event.book;
   for(const trial of this.trials.values()) {
    if(trial.ticker!==book.ticker||book.observedAt<=trial.start||book.observedAt>=trial.close||trial.hit)continue;
    if(book.observedAt-trial.last>10000)trial.gap=true;
    trial.last=book.observedAt;
    const ask=trial.side==='yes'?book.yesAsk:book.noAsk;
    const bid=trial.side==='yes'?book.yesBid:book.noBid;
    if(!trial.filled) {if(ask!==null&&ask<=trial.entry&&ask>0)trial.filled=true;}
    else if(bid!==null&&bid>=94)trial.hit=true;
   }
  }
 }
 report(now=Date.now()) {
  const latency=this.latency.toSorted((a,b)=>a-b);
  const percentile=(p:number)=>latency.length?latency[Math.min(latency.length-1,Math.floor(latency.length*p))]:null;
  const group=(recommended:boolean)=>{
   const trials=[...this.trials.values()].filter(t=>t.recommended===recommended);
   return {contractsAndSides:trials.length,observedEntryTouches:trials.filter(t=>t.filled).length,
    observedEntryTo94Paths:trials.filter(t=>t.hit).length,
    closedWithoutObservedTarget:trials.filter(t=>!t.hit&&t.filled&&now>=t.close).length,
    pending:trials.filter(t=>!t.hit&&now<t.close).length,
    incompleteCoverage:trials.filter(t=>t.gap||(!t.hit&&now>=t.close&&t.close-t.last>10000)).length};
  };
  return {decisions:this.count,inputTokens:this.tokens,modelLatencyMs:{p50:percentile(.5),p95:percentile(.95)},
   recommended:group(true),waited:group(false),
   limitation:'Sampled quote paths, not executed trades or validated accuracy. First recommendation per side/contract; no assumed maker fills, fees, or P&L. A missing target observation is not a confirmed loss.'};
 }
}
