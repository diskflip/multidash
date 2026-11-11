import type {JevDecision} from '../../src/types/decision.ts';
import type {Book,DecisionInput,DecisionProvider} from './types.ts';
import {buildFeatures} from './features.ts';
import type {SettlementInput} from './settlement.ts';
import {JevHttpError} from './jev.ts';
export type DecisionSettings={enabled:boolean;symbols:string[];intervalMs:number;lateIntervalMs:number;maxCallsPerMinute:number};
export function requestedLate(input:DecisionInput,now:number):boolean {
  const remaining=(input.market?.closeTime??0)-now;
  return input.requested===true&&remaining>0&&remaining<=120000;
}
type Dependencies={inputs:()=>DecisionInput[];provider:DecisionProvider;book:(ticker:string)=>Promise<Book>;
 settlement?:(symbol:string,ticker:string)=>Promise<SettlementInput>;
 publish:(decision:JevDecision)=>void;log:(event:object)=>void;takeBudget?:()=>boolean;hasBudget?:()=>boolean;now?:()=>number};
export class DecisionService {
  readonly latest=new Map<string,JevDecision>();
  private pending=new Set<string>();
  private due=new Map<string,number>();
  private calls:number[]=[];
  private cooldown=0;
  private now:()=>number;
  constructor(private settings:DecisionSettings,private dependencies:Dependencies){this.now=dependencies.now??Date.now;}
  private emit(symbol:string,ticker:string|null,status:JevDecision['status'],reason:string) {
    const now=this.now();
    const value:JevDecision={symbol,ticker,mode:'shadow',status,choice:'WAIT',reason,confidence:null,observedAt:now,expiresAt:now,latencyMs:null,model:null};
    const old=this.latest.get(symbol);
    if(old?.ticker===ticker&&old.status===status&&old.reason===reason&&old.choice==='WAIT')return;
    this.latest.set(symbol,value);this.dependencies.publish(value);
  }
  tick() {
    const now=this.now();
    const inputs=this.dependencies.inputs().filter(row=>this.settings.symbols.includes(row.symbol));
    this.calls=this.calls.filter(time=>now-time<60000);
    for(const input of inputs) {
      const previous=this.latest.get(input.symbol);
      if(previous?.ticker!==(input.market?.ticker??null) || (previous?.status==='ready'&&now>=previous.expiresAt)) this.emit(input.symbol,input.market?.ticker??null,'waiting','refreshing');
      if(!this.settings.enabled)this.emit(input.symbol,input.market?.ticker??null,'disabled','not_configured');
      else if(!requestedLate(input,now))this.emit(input.symbol,input.market?.ticker??null,'waiting','outside_auto_window');
    }
    if(!this.settings.enabled)return;
    const ready=inputs.filter(row=>requestedLate(row,now)&&!this.pending.has(row.symbol)&&(this.due.get(row.symbol)??0)<=now)
      .sort((a,b)=>(this.due.get(a.symbol)??0)-(this.due.get(b.symbol)??0));
    for(const input of ready) {
      if(this.pending.size>=12)break;
      this.pending.add(input.symbol);
      const remaining=(input.market?.closeTime??0)-now;
      this.due.set(input.symbol,now+(remaining>0&&remaining<=120000?this.settings.lateIntervalMs:this.settings.intervalMs));
      void this.evaluate(input).finally(()=>this.pending.delete(input.symbol));
    }
  }
  private async evaluate(input:DecisionInput) {
    const {symbol,market}=input;
    const current=()=>this.dependencies.inputs().find(row=>row.symbol===symbol);
    if(!market||!requestedLate(input,this.now())){this.emit(symbol,market?.ticker??null,'waiting','market_closed');return;}
    if(this.dependencies.hasBudget&&!this.dependencies.hasBudget()) {
      this.emit(symbol,market.ticker,'waiting','trial_limit_reached');return;
    }
    const start=this.now();
    try {
      const [book,settlementInput]=await Promise.all([
        this.dependencies.book(market.ticker),this.dependencies.settlement?.(symbol,market.ticker)]);
      this.dependencies.log({type:'observation',symbol,book});
      const latest=current();
      if(!latest||latest.market?.ticker!==market.ticker||!requestedLate(latest,this.now()))return;
      const features=buildFeatures({...latest,settlementInput},book,this.now());
      if(typeof features==='string'){this.emit(symbol,market.ticker,'waiting',features);return;}
      if(this.now()<this.cooldown||this.calls.filter(t=>this.now()-t<60000).length>=this.settings.maxCallsPerMinute) {
        this.emit(symbol,market.ticker,'waiting','rate_limited');return;
      }
      this.calls.push(this.now());
      if(this.dependencies.takeBudget&&!this.dependencies.takeBudget()) {this.emit(symbol,market.ticker,'waiting','trial_limit_reached');return;}
      const modelStart=this.now();
      const answer=await this.dependencies.provider.decide(features);
      const after=current(),now=this.now();
      this.dependencies.log({type:'inference',symbol,ticker:market.ticker,time:now,answer,latencyMs:now-modelStart});
      if(!after||after.market?.ticker!==market.ticker||!requestedLate(after,now))return;
      const last=after.history.at(-1);
      // Results expire with their inputs, not after a slow response.
      const expiresAt=Math.min(features.observedAt+5000,(features.settlement.sourceTime??Infinity)+5000,book.observedAt+5000,features.observedAt-features.freshness.quoteAgeMs+5000,market.closeTime);
      if(now>=expiresAt||!last||now/1000-last.time>5||(last.time>book.observedAt/1000&&Math.abs(last.yes-features.book.yesBid!)>2)) {
        this.emit(symbol,market.ticker,'waiting','market_changed');return;
      }
      const side=answer.choice==='ENTER_YES'?'yes':answer.choice==='ENTER_NO'?'no':null;
      const accepted=side!==null&&features.eligibleSides.includes(side);
      const decision:JevDecision={symbol,ticker:market.ticker,mode:'shadow',status:'ready',choice:accepted?answer.choice:'WAIT',
        side:features.candidateSide,recommendation:accepted?'YES':'NO',
        reason:side!==null&&!accepted?'ineligible':answer.reason,confidence:answer.confidence,
        observedAt:now,expiresAt,latencyMs:now-start,model:answer.model};
      this.latest.set(symbol,decision);this.dependencies.publish(decision);
      this.dependencies.log({type:'decision',decision,features,answer,modelLatencyMs:now-modelStart});
    } catch(error) {
      if(error instanceof JevHttpError&&[401,403,429].includes(error.status))this.cooldown=this.now()+60000;
      else this.cooldown=Math.max(this.cooldown,this.now()+5000);
      if(current()?.market?.ticker===market.ticker)this.emit(symbol,market.ticker,'unavailable','service_unavailable');
      this.dependencies.log({type:'error',symbol,ticker:market.ticker,time:this.now(),code:error instanceof JevHttpError?error.status:'request_failed'});
    }
  }
}
