import type {IndexPoint} from './recovery.ts';
import WebSocket from 'ws';
import {config} from '../config.ts';
import {signRequest} from '../kalshiAuth.ts';
import {fetchStrikeMetadata} from '../findMarket.ts';

export const INDEX_IDS:Record<string,string>={BTC:'BRTI',ETH:'ETHUSD_RTI',DOGE:'DOGEUSD_RTI',SOL:'SOLUSD_RTI',XRP:'XRPUSD_RTI',BNB:'BNBUSD_RTI',ZEC:'ZECUSD_RTI',NEAR:'NEARUSD_RTI',HYPE:'HYPEUSD_RTI'};
const SYMBOL_BY_INDEX_ID=new Map(Object.entries(INDEX_IDS).map(([symbol,id])=>[id,symbol]));
export const symbolForIndexId=(indexId:string):string|null=>SYMBOL_BY_INDEX_ID.get(indexId)??null;
export type Average={value:number;count:number;start:number;end:number};
export type IndexTick={indexId:string;sourceTime:number;value:number;trailing:Average|null;finalMinute:Average|null};
export type SettlementInput={history?:IndexPoint[];tick:IndexTick|null;strike:number|null;strikeType:string|null;roundDigits:number|null};
// Kalshi's final-minute average is provisional until the contract closes.
// Only accept a reading attached to this contract's exact final-minute
// window, with timestamps and sample coverage consistent with the tick.
export function matchingFinalMinuteAverage(tick:IndexTick|null|undefined,closeTime:number):{average:Average;expected:number}|null {
 const final=tick?.finalMinute;
 if(!tick||!final)return null;
 const start=closeTime-60000;
 const expected=Math.max(0,Math.floor((tick.sourceTime-start)/1000));
 if(final.start!==start||tick.sourceTime<=start||tick.sourceTime>closeTime||
  final.end<tick.sourceTime||final.end>tick.sourceTime+1000||final.count<=0||final.count>expected)return null;
 return {average:final,expected};
}
const numeric=(v:unknown):number|null=>{
 if(typeof v!=='number'&&typeof v!=='string'||v==='')return null;
 const n=Number(v);return Number.isFinite(n)?n:null;
};
function average(raw:any):Average|null {
 const value=numeric(raw?.value),count=raw?.window_size,start=raw?.window_start_ts_ms,end=raw?.window_end_ts_exclusive;
 if(value===null||value<=0||!Number.isInteger(count)||count<0||count>60||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||end<=start)return null;
 return {value,count,start,end};
}
// Kalshi stamps each value on an exact second boundary, so ordinary
// delivery jitter alone (confirmed: up to ~50ms either side in practice)
// puts sourceTime on the "future" side of a receiver's clock about half
// the time — rejecting that outright as from the future discarded roughly
// half of every real tick. FUTURE_TOLERANCE_MS absorbs that jitter while
// still catching a genuinely bogus timestamp (minutes/hours ahead).
const FUTURE_TOLERANCE_MS=2000;
export function parseIndexTick(raw:unknown,now:number):IndexTick|null {
 const frame=raw as any,m=frame?.msg;
 if(frame?.type!=='cfbenchmarks_value'||!Object.values(INDEX_IDS).includes(m?.index_id)||typeof m.data!=='string')return null;
 let data:any;try{data=JSON.parse(m.data);}catch{return null;}
 const value=numeric(data?.value),sourceTime=data?.time;
 if(data?.type!=='value'||data.id!==m.index_id||value===null||value<=0||!Number.isSafeInteger(sourceTime)||
  sourceTime-now>FUTURE_TOLERANCE_MS||now-sourceTime>5000)return null;
 return {indexId:m.index_id,sourceTime,value,trailing:average(m.avg_60s_data),finalMinute:average(m.last_60s_windowed_average_15min)};
}

export class SettlementFeed {
 // onTick is for consumers that need every observation rather than the
 // latest on demand — the chart's underlying-vs-strike line keeps its own
 // 30-minute buffer, far longer than the 60s this feed retains.
 constructor(private onTick?:(tick:IndexTick)=>void){}
 private latest=new Map<string,IndexTick>();
 private histories=new Map<string,IndexPoint[]>();
 private ws:WebSocket|null=null;
 private timer:ReturnType<typeof setTimeout>|undefined;
 private heartbeat:ReturnType<typeof setInterval>|undefined;
 private stopped=false;
 start(){this.stopped=false;this.connect();}
 stop(){this.stopped=true;clearTimeout(this.timer);clearInterval(this.heartbeat);this.ws?.close();this.latest.clear();this.histories.clear();}
 get(symbol:string){return this.latest.get(INDEX_IDS[symbol])??null;}
 history(symbol:string){return [...(this.histories.get(INDEX_IDS[symbol])??[])];}
 ingest(raw:unknown,now=Date.now()) {
  const tick=parseIndexTick(raw,now);
  if(!tick||tick.sourceTime<=(this.latest.get(tick.indexId)?.sourceTime??0))return;
  this.latest.set(tick.indexId,tick);
  const history=this.histories.get(tick.indexId)??[];
  history.push({sourceTime:tick.sourceTime,value:tick.value});
  this.histories.set(tick.indexId,history.filter(p=>p.sourceTime>=tick.sourceTime-60000).slice(-61));
  this.onTick?.(tick);
 }
 private connect() {
  if(this.stopped)return;
  const ws=new WebSocket(config.wsUrl,{headers:signRequest('GET','/trade-api/ws/v2'),handshakeTimeout:5000});this.ws=ws;
  let alive=true;
  const connectStartedAt=Date.now();
  ws.on('open',()=>{
   ws.send(JSON.stringify({id:1,cmd:'subscribe',params:{channels:['cfbenchmarks_value'],index_ids:Object.values(INDEX_IDS)}}));
   this.heartbeat=setInterval(()=>{if(!alive){ws.terminate();return;}alive=false;ws.ping();},10000);
  });
  ws.on('pong',()=>{alive=true;});
  ws.on('message',raw=>{alive=true;try{const frame=JSON.parse(String(raw));this.ingest(frame);
   if(frame.type==='error')console.warn('[jev-settlement] subscription error',frame.msg?.code);
  }catch{/* Ignore malformed frames; existing ticks expire by source time. */}});
  // Previously both silent. This one connection feeds every crypto
  // symbol's distance line, so a drop here freezes all of them at once —
  // logged so that can be confirmed/measured instead of guessed at.
  ws.on('error',(err)=>{console.warn('[jev-settlement] ws error:',err.message);});
  ws.on('close',()=>{
   console.warn(`[jev-settlement] closed after ${Date.now()-connectStartedAt}ms, reconnecting in 3000ms`);
   clearInterval(this.heartbeat);this.latest.clear();this.histories.clear();if(!this.stopped)this.timer=setTimeout(()=>this.connect(),3000);});
 }
}

// Read the current contract's actual target, never infer it from a spot
// quote. Shares the single-ticker lookup with server/findMarket.ts's own
// strike refresh — one implementation of "ask Kalshi for this contract's
// strike" rather than two.
export function createSettlementReader(feed:SettlementFeed,request:typeof fetch=fetch) {
 const metadata=new Map<string,{expires:number;strike:number|null;strikeType:string|null;roundDigits:number|null}>();
 return async(symbol:string,ticker:string):Promise<SettlementInput>=>{
  let saved=metadata.get(ticker);
  if(INDEX_IDS[symbol]&&(!saved||saved.expires<=Date.now())) {
   const fetched=await fetchStrikeMetadata(ticker,request);
   saved={...fetched,expires:Date.now()+(fetched.strike===null?5000:60000)};
   metadata.set(ticker,saved);if(metadata.size>64)metadata.delete(metadata.keys().next().value!);
  }
  return {history:feed.history(symbol),tick:feed.get(symbol),strike:saved?.strike??null,strikeType:saved?.strikeType??null,roundDigits:saved?.roundDigits??null};
 };
}
