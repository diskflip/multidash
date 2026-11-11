import {useEffect,useRef,useState} from 'react';
import {connectToBackend,sendToBackend} from '../data/kalshi';
import type {JevDecision} from '../types/decision';
export function useJev(symbols:string[]) {
 const [decisions,setDecisions]=useState<Record<string,JevDecision>>({});
 const key=symbols.join(',');
 const current=useRef(symbols);current.current=symbols;
 useEffect(()=>connectToBackend(msg=>{
  if(msg.type==='jevDecision')setDecisions(old=>({...old,[msg.decision.symbol]:msg.decision}));
  if(msg.type==='status'&&msg.connected)sendToBackend({cmd:'setJevMarkets',symbols:current.current});
 },()=>{}),[]);
 useEffect(()=>{sendToBackend({cmd:'setJevMarkets',symbols:current.current});},[key]);
 return decisions;
}
