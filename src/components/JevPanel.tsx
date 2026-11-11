import type {JevDecision} from '../types/decision';
import {useMarketClock} from '../lib/marketClock';
import {SYMBOL_COLOR} from '../lib/symbolColor';
import type {SummaryStats} from './MarketSummary';
import './JevPanel.css';
export function JevPanel({symbols,decisions,stats,auto,closeTime,className=''}:{symbols:string[];decisions:Record<string,JevDecision>;stats:Record<string,SummaryStats>;auto:boolean;closeTime:number|null;className?:string}) {
 const now=useMarketClock();
 const late=closeTime!==null&&closeTime-now>0&&closeTime-now<=120;
 return <section className={`jev-panel ${className}`} aria-label="Jev cheap-side flip recommendations">
  <h2 className="sidebar-panel-title">JEV</h2>
  {auto&&late&&symbols.length>0&&<>
  <div className="jev-columns"><span>MARKET / SIDE</span><span>FLIP?</span><span>CONF.</span></div>
  <div className="jev-rows">{symbols.map(symbol=>{
    const d=decisions[symbol];
    const fresh=stats[symbol]?.connected&&d?.ticker===stats[symbol]?.ticker&&d?.status==='ready'&&d.expiresAt>now*1000;
    const limited=d?.ticker===stats[symbol]?.ticker&&d?.reason==='trial_limit_reached';
    return <div key={symbol} className="jev-row" data-jev-symbol={symbol}>
      <span className="jev-market" style={{color:SYMBOL_COLOR[symbol]}}>{symbol}<small>{fresh?d.side?.toUpperCase():'—'}</small></span>
      <strong className={fresh?(d.recommendation==='YES'?'jev-yes':'jev-no'):''}>{fresh?d.recommendation:limited?'LIMIT':'—'}</strong>
      <span className="jev-confidence">{fresh&&d.confidence!==null?`${Math.round(d.confidence*100)}%`:'—'}</span>
    </div>;
  })}</div></>}
 </section>;
}
