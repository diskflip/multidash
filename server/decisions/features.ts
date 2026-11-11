import {recoveryFeatures} from './recovery.ts';
import {INDEX_IDS,matchingFinalMinuteAverage} from './settlement.ts';
import {validPoint} from '../../src/lib/chartTimeline.ts';
import type {Book, DecisionInput, Features} from './types.ts';
export function buildFeatures(input: DecisionInput, book: Book, now: number): Features | string {
  const {market} = input;
  if (!market || book.ticker !== market.ticker || now < market.openTime || now >= market.closeTime) return 'market_closed';
  if (now - book.observedAt > 2000 || book.observedAt > now) return 'stale_book';
  if (book.yesBid === null || book.noBid === null || book.yesBid + book.noBid > 100) return 'incomplete_book';
  const history = input.history.filter(p => validPoint(p) && p.ticker === market.ticker && p.time <= now / 1000 && p.time >= now / 1000 - 60);
  const last = history.at(-1);
  if (!last || now / 1000 - last.time > 5) return 'stale_quotes';
  if (history.length < 3 || last.time - history[0].time < 5) return 'warming_up';
  const gaps = history.filter((p,i) => i > 0 && (p.breakBefore || p.time - history[i-1].time > 5));
  if (gaps.some(p => p.time >= now / 1000 - 5)) return 'history_gap';
  if (book.yesAsk === null || book.noAsk === null) return 'incomplete_book';
  const candidateSide = book.yesAsk <= book.noAsk ? 'yes' : 'no';
  const candidateAsk = candidateSide === 'yes' ? book.yesAsk : book.noAsk;
  if (candidateAsk <= 0 || candidateAsk >= 100) return 'incomplete_book';
  const eligibleSides: ('yes' | 'no')[] = [candidateSide];
  const movement = [10,20,60].map(seconds => {
    const points = history.filter(p => p.time >= now / 1000 - seconds);
    const prices = points.map(p => p.yes);
    return {seconds, range: prices.length ? Math.max(...prices)-Math.min(...prices) : 0,
      net: prices.length ? prices.at(-1)!-prices[0] : 0,
      travel: prices.reduce((n,p,i)=>n+(i ? Math.abs(p-prices[i-1]) : 0),0),
      changes: prices.reduce((n,p,i)=>n+Number(i>0 && p!==prices[i-1]),0)};
  });
  const bins = new Map<number, {secondsAgo:number;cents:number}>();
  for (const p of history) bins.set(Math.floor(p.time),{secondsAgo:Math.round(now/1000-p.time),cents:p.yes});
  const crypto = !!INDEX_IDS[input.symbol];
  const supplied=input.settlementInput;
  const tick=supplied?.tick;
  const fresh=!!tick&&tick.indexId===INDEX_IDS[input.symbol]&&tick.sourceTime<=now&&now-tick.sourceTime<=5000;
  const inWindow=now>market.closeTime-60000;
  const expected=fresh&&inWindow?Math.max(0,Math.floor((tick.sourceTime-(market.closeTime-60000))/1000)):null;
  const finalMatch=fresh&&inWindow?matchingFinalMinuteAverage(tick,market.closeTime):null;
  const averageMatches=!!finalMatch;
  const complete=!!finalMatch&&finalMatch.average.count===finalMatch.expected;
  const trailing=fresh&&tick.trailing&&tick.trailing.end===tick.sourceTime&&tick.trailing.start===tick.sourceTime-60000?tick.trailing:null;
  const intervals = history.slice(1).map((p,i)=>(p.time-history[i].time)*1000);
  const recovery=recoveryFeatures({now,openTime:market.openTime,closeTime:market.closeTime,candidateSide,
    underlyingPrice:fresh?tick.value:null,sourceTime:fresh?tick.sourceTime:null,history:supplied?.history??[],
    strike:supplied?.strike??null,strikeType:supplied?.strikeType??null,roundDigits:supplied?.roundDigits??null,
    runningAverage:finalMatch?.average.value??null,sampleCount:finalMatch?.average.count??null,coverageComplete:complete});
  return {version:3,recovery,
    candidateMovement:movement.map(m=>({seconds:m.seconds,netCents:m.net*(candidateSide==='yes'?1:-1),rangeCents:m.range})),symbol:input.symbol,ticker:market.ticker,observedAt:now,closeTime:market.closeTime,
    secondsLeft:Math.floor((market.closeTime-now)/1000),score:input.score,
    freshness:{bookAgeMs:now-book.observedAt,quoteAgeMs:now-last.time*1000,
      recentMaxQuoteIntervalMs:Math.max(0,...intervals),scoreSourceAgeMs:null,scoreFreshness:'unknown',
      flipCountersMeaning:'historical_rolling_counts_not_live_signals'},
    settlement:{rule:crypto?'final_60_second_index_average':'unknown',
      averagingWindowSeconds:crypto?60:null,
      elapsedWindowSeconds:crypto?Math.min(60,Math.max(0,(now-(market.closeTime-60000))/1000)):null,
      source:crypto?'CF_Benchmarks_RTI':null,
      underlyingPrice:fresh?tick.value:null,runningAverage:finalMatch?.average.value??null,
      strike:supplied?.strike??null,strikeType:supplied?.strikeType??null,roundDigits:supplied?.roundDigits??null,
      sourceTime:fresh?tick.sourceTime:null,sourceAgeMs:tick?now-tick.sourceTime:null,
      trailing60SecondAverage:trailing?.value??null,trailingSampleCount:trailing?.count??null,
      finalMinuteSampleCount:finalMatch?.average.count??null,expectedFinalMinuteSamples:expected,
      finalMinuteCoverageComplete:complete,
      averageStatus:!inWindow?'outside_window':!averageMatches?'missing_or_stale':complete?'available':'partial',
      dataAvailable:fresh},
    flips30m:input.flips30m,flips1h:input.flips1h,book,movement,recentYesBids:[...bins.values()],eligibleSides,candidateSide,candidateAsk,historyHasGap:gaps.length>0};
}
