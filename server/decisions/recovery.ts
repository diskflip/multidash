export type IndexPoint={sourceTime:number;value:number};
export type RecoveryInput={now:number;openTime:number;closeTime:number;candidateSide:'yes'|'no';
 underlyingPrice:number|null;sourceTime:number|null;history:IndexPoint[];
 strike:number|null;strikeType:string|null;roundDigits:number|null;
 runningAverage:number|null;sampleCount:number|null;coverageComplete:boolean};
const rounded=(n:number)=>Number(n.toPrecision(10));
export function recoveryFeatures(input:RecoveryInput) {
 const {underlyingPrice:price,sourceTime,strike}=input;
 const direction=input.strikeType==='greater_or_equal'||input.strikeType==='greater'
  ?(input.candidateSide==='yes'?1:-1):null;
 // No interpolation, future observations, or ticks from a prior contract.
 const points=[...new Map(input.history.filter(p=>Number.isFinite(p.value)&&p.value>0&&
  Number.isSafeInteger(p.sourceTime)&&p.sourceTime>=Math.max(input.openTime,input.now-60000)&&
  p.sourceTime<=input.now&&sourceTime!==null&&p.sourceTime<=sourceTime).map(p=>[p.sourceTime,p])).values()]
  .sort((a,b)=>a.sourceTime-b.sourceTime);
 const fresh=price!==null&&sourceTime!==null&&sourceTime<=input.now&&input.now-sourceTime<=5000;
 const movement=[5,10,20,60].map(seconds=>{
  const window=fresh?points.filter(p=>p.sourceTime>=input.now-seconds*1000):[];
  const first=window[0],last=window.at(-1);
  const maxGapMs=window.length>1?Math.max(...window.slice(1).map((p,i)=>p.sourceTime-window[i].sourceTime)):null;
  const usable=window.length>=3&&last!.sourceTime-first.sourceTime>=Math.min(2000,seconds*500)&&
   last!.sourceTime===sourceTime&&maxGapMs!==null&&maxGapMs<=5000;
  const netBps=usable?rounded((last!.value-first.value)/first.value*10000):null;
  return {seconds,samples:window.length,spanSeconds:first&&last?(last.sourceTime-first.sourceTime)/1000:0,maxGapMs,
   netBps,candidateNetBps:netBps!==null&&direction!==null?rounded(netBps*direction):null,
   rangeBps:usable?rounded((Math.max(...window.map(p=>p.value))-Math.min(...window.map(p=>p.value)))/first.value*10000):null};
 });
 const averagingStarted=input.now>input.closeTime-60000;
 const remaining=input.coverageComplete&&input.sampleCount!==null?60-input.sampleCount:averagingStarted?null:60;
 const required=fresh&&strike!==null&&strike>0&&direction!==null&&remaining!==null&&remaining>0
  ?!averagingStarted?strike:input.runningAverage!==null&&input.sampleCount!==null
    ?(60*strike-input.sampleCount*input.runningAverage)/remaining:null:null;
 const roundingTolerance=required!==null&&remaining!==null&&input.roundDigits!==null
  ?.5*10**(-input.roundDigits)*60/remaining:null;
 return {underlyingMovement:movement,
  candidateDirection:direction===null?null:direction===1?'higher_underlying':'lower_underlying',
  candidateDistanceToStrikeBps:fresh&&strike!==null&&strike>0&&direction!==null?rounded((price!-strike)/strike*10000*direction):null,
  remainingAverage:{remainingSamples:remaining,requiredAverageAtUnroundedStrike:required===null?null:rounded(required),
   candidateNeeds:direction===null?null:direction===1?'above_boundary':'below_boundary',
   requiredMoveFromCurrentBps:required!==null&&price!==null?rounded((required-price)/price*10000):null,
   candidateCushionBps:required!==null&&price!==null&&direction!==null?rounded((price-required)/price*10000*direction):null,
   roundingToleranceInRequiredAverage:roundingTolerance===null?null:rounded(roundingTolerance),
   asOfSourceTime:fresh?sourceTime:null,
   interpretation:'Arithmetic boundary, not a forecast. Positive candidate cushion favors the candidate at the current index; negative means further recovery is needed. Final rounding and strictness affect equality. Missing or incomplete final-minute samples disable this calculation.'}};
}
