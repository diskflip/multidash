import type {Features} from './types.ts';
export const PROMPT_VERSION='flip-path-v6';
export function decisionState(f:Features) {
 const r=f.recovery,s=f.settlement,yes=f.candidateSide==='yes';
 const cushion=r?.remainingAverage.candidateCushionBps??null;
 return {
  symbol:f.symbol,
  candidate:{side:f.candidateSide,askCents:f.candidateAsk,bidCents:yes?f.book.yesBid:f.book.noBid,
   secondsLeft:f.secondsLeft,scoreOutOf10:f.score},
  contractMovement:f.candidateMovement??f.movement.map(m=>({seconds:m.seconds,netCents:m.net*(yes?1:-1),rangeCents:m.range})),
  underlyingMovement:r?.underlyingMovement.map(m=>({seconds:m.seconds,samples:m.samples,spanSeconds:m.spanSeconds,
   candidateNetBps:m.candidateNetBps,rangeBps:m.rangeBps,
   recoveryNeededInObservedRanges:cushion!==null&&m.rangeBps!==null&&m.rangeBps>0
    ?Number((Math.max(0,-cushion)/m.rangeBps).toFixed(3)):null}))??[],
  settlement:{rule:s.rule,dataAvailable:s.dataAvailable,underlying:s.underlyingPrice,strike:s.strike,strikeType:s.strikeType,roundDigits:s.roundDigits,
   finalMinuteAverage:s.runningAverage,elapsedSeconds:s.elapsedWindowSeconds,
   samples:s.finalMinuteSampleCount,coverageComplete:s.finalMinuteCoverageComplete,
   ...(r?.remainingAverage??{})},
  freshness:{bookAgeMs:f.freshness.bookAgeMs,quoteAgeMs:f.freshness.quoteAgeMs,indexAgeMs:s.sourceAgeMs,
   historyHasGap:f.historyHasGap,scoreSourceAge:'unknown'},
 };
}
export const questions={
 entry:{type:'choice',instructions:'Evaluate the currently cheaper side as a potential flip toward 94 cents before close. Is there a supported live path, rather than just theoretical possibility? Judge the current setup, not whether a flip is more likely than not. A path can be supported by renewed movement toward the candidate, or by an actively contested boundary where ordinary recent movement can change the outcome even without established recovery. Distinguish that from a cheap side continuing to fade with no evidence of a turn, or stranded by the accumulated average and remaining time. Activity, a high score, proximity alone, and being an underdog are not sufficient evidence in either direction. Positive contract netCents and underlying candidateNetBps favor the candidate; negatives oppose it. When settlement data is available, compare the required remaining-average boundary with current underlying price and observed movement. When settlement rule is unknown, assess only Kalshi contract movement and the order book; do not infer an underlying price, strike, or settlement path. Positive cushion favors the candidate at the raw-strike boundary; negative cushion requires further recovery. Observed ranges are context, not a speed limit or a prediction. Weigh the most recent usable movement against longer-window movement so an earlier decline does not hide a new turn. Null is unknown, not zero. The final-minute average is absent before accumulation begins. Incomplete final-minute coverage disables the remaining-average calculation. Account for time, source ages, and rounding tolerance when those data are available. The score already incorporates averaging where applicable. Return a setup assessment, not an order instruction or calibrated win probability.',
  criteria:{YES:'Observable recovery or active contention supports a realistic remaining flip path; the required underlying movement is plausible in context.',NO:'There is no supported live path: fading without recovery or active contention, a stranded final-minute average, or insufficient usable evidence.'}},
 condition:{type:'choice',instructions:'Classify current candidate-direction movement. Positive net changes favor the candidate, negative oppose it. Use the shortest usable windows to recognize a new reversal; a longer earlier decline need not mean the candidate is still collapsing.',criteria:{recovering:'Recent movement favors the candidate.',collapsing:'Recent movement opposes the candidate.',flat:'Little meaningful movement.',insufficient_evidence:'Not enough usable observations.'}}
};
