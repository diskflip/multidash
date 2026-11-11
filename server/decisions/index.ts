import {SettlementFeed,createSettlementReader,type IndexTick} from './settlement.ts';
import {JevProvider} from './jev.ts';
import {readDecisionBook} from './book.ts';
import {DecisionJournal} from './journal.ts';
import {SessionRequestBudget} from './budget.ts';
import {DecisionService} from './service.ts';
import type {DecisionInput} from './types.ts';
import type {JevDecision} from '../../src/types/decision.ts';
import {config} from '../config.ts';
const positive=(value:string|undefined,fallback:number,min:number,max:number)=>{
 const parsed=Number(value);return Number.isFinite(parsed)&&parsed>=min&&parsed<=max?parsed:fallback;
};
export function startJev(inputs:()=>DecisionInput[],publish:(decision:JevDecision)=>void,onIndexTick?:(tick:IndexTick)=>void) {
 const key=process.env.TYPESAFE_API_KEY??'';
 const settlementFeed=new SettlementFeed(onIndexTick);
 // Unconditional: the chart's underlying-vs-strike line reads this same
 // index feed, so it must keep running when shadow recommendations are off.
 settlementFeed.start();
 const journal=new DecisionJournal('.runtime/jev');
 const budget=new SessionRequestBudget('.runtime/jev/session-budget.json',positive(process.env.JEV_MAX_CALLS_PER_SESSION,7000,1,100000),5*60*60*1000);
 const service=new DecisionService({enabled:!!key&&process.env.JEV_ENABLED!=='false',
  symbols:(process.env.JEV_SYMBOLS??config.markets.map(market=>market.symbol).join(',')).split(',').map(s=>s.trim()).filter(Boolean),
  intervalMs:positive(process.env.JEV_INTERVAL_MS,5000,1000,60000),lateIntervalMs:positive(process.env.JEV_LATE_INTERVAL_MS,5000,1000,60000),
  maxCallsPerMinute:positive(process.env.JEV_MAX_CALLS_PER_MINUTE,600,1,1200)},
  {inputs,publish,settlement:createSettlementReader(settlementFeed),book:readDecisionBook,provider:new JevProvider(key,process.env.JEV_MODEL??'jev-latest'),log:e=>journal.append(e),hasBudget:()=>budget.available(),takeBudget:()=>budget.take()});
 setInterval(()=>service.tick(),500);
 console.log(`[jev] shadow recommendations ${key&&process.env.JEV_ENABLED!=='false'?'enabled':'disabled (key/config missing)'}`);
 return service;
}
