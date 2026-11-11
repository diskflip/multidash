import {config} from '../config.ts';
import {signRequest} from '../kalshiAuth.ts';
import type {Book} from './types.ts';
export function parseBook(body: unknown, ticker: string, observedAt: number): Book {
  const raw = (body as {orderbook_fp?:{yes_dollars?:unknown;no_dollars?:unknown}})?.orderbook_fp;
  function side(levels: unknown) {
    if (!Array.isArray(levels)) return {bid:null,depth:0};
    const valid = levels.filter(p => Array.isArray(p) && typeof p[0]==='string' && typeof p[1]==='string')
      .map(p=>({price:Number(p[0])*100,size:Number(p[1])}))
      .filter(p=>Number.isFinite(p.price)&&p.price>=0&&p.price<=100&&Number.isFinite(p.size)&&p.size>0);
    return {bid:valid.length ? Math.max(...valid.map(p=>p.price)) : null,depth:valid.reduce((n,p)=>n+p.size,0)};
  }
  const yes=side(raw?.yes_dollars),no=side(raw?.no_dollars);
  return {ticker,observedAt,yesBid:yes.bid,noBid:no.bid,yesAsk:no.bid===null?null:100-no.bid,
    noAsk:yes.bid===null?null:100-yes.bid,yesBidDepth:yes.depth,noBidDepth:no.depth};
}
export async function readDecisionBook(ticker:string):Promise<Book> {
  const observedAt=Date.now();
  const path=`/trade-api/v2/markets/${encodeURIComponent(ticker)}/orderbook`;
  const response=await fetch(`${config.restBaseUrl}${path}?depth=3`,{headers:signRequest('GET',path),signal:AbortSignal.timeout(1500),cache:'no-store'});
  if(!response.ok)throw new Error(`Book HTTP ${response.status}`);
  return parseBook(await response.json(),ticker,observedAt);
}
