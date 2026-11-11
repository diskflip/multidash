import test from 'node:test';
import assert from 'node:assert/strict';
import {recoveryFeatures,type RecoveryInput} from './recovery.ts';
const input=():RecoveryInput=>({now:970000,openTime:100000,closeTime:1000000,candidateSide:'yes',underlyingPrice:102,sourceTime:970000,
 history:[960000,965000,970000].map((sourceTime,i)=>({sourceTime,value:100+i})),strike:100,strikeType:'greater_or_equal',roundDigits:2,
 runningAverage:99,sampleCount:30,coverageComplete:true});
test('remaining average uses accumulated sum and unobserved samples; rounding uncertainty grows near close',()=>{
 const r=recoveryFeatures(input());assert.equal(r.remainingAverage.requiredAverageAtUnroundedStrike,101);
 assert.equal(r.remainingAverage.remainingSamples,30);assert.equal(r.remainingAverage.roundingToleranceInRequiredAverage,.01);
 assert.ok(r.remainingAverage.candidateCushionBps!>0);
 const last=recoveryFeatures({...input(),now:999000,sourceTime:999000,sampleCount:59,runningAverage:100});
 assert.equal(last.remainingAverage.requiredAverageAtUnroundedStrike,100);assert.equal(last.remainingAverage.roundingToleranceInRequiredAverage,.3);
});
test('YES and NO have opposite movement and remaining-average directions',()=>{
 const yes=recoveryFeatures(input()),no=recoveryFeatures({...input(),candidateSide:'no'});
 assert.equal(yes.underlyingMovement[1].candidateNetBps,200);
 assert.equal(no.underlyingMovement[1].candidateNetBps,-200);
 assert.equal(no.remainingAverage.candidateNeeds,'below_boundary');
 assert.equal(no.remainingAverage.candidateCushionBps,-yes.remainingAverage.candidateCushionBps!);
});
test('partial, stale, unknown-rule and completed windows do not produce a recovery requirement',()=>{
 for(const patch of [{coverageComplete:false},{sourceTime:964999},{strike:null},{strikeType:'unknown'},{sampleCount:60}] as Partial<RecoveryInput>[]){
  assert.equal(recoveryFeatures({...input(),...patch}).remainingAverage.requiredAverageAtUnroundedStrike,null);
 }
 const early=recoveryFeatures({...input(),now:930000,sourceTime:930000,sampleCount:null,runningAverage:null,coverageComplete:false});
 assert.equal(early.remainingAverage.requiredAverageAtUnroundedStrike,100);assert.equal(early.remainingAverage.remainingSamples,60);
});
test('underlying movement excludes future and previous-contract observations and flags gaps instead of interpolating',()=>{
 const row=input();row.history.push({sourceTime:970001,value:999},{sourceTime:99999,value:1});
 assert.equal(recoveryFeatures(row).underlyingMovement[1].netBps,200);
 row.history=[{sourceTime:960000,value:100},{sourceTime:969000,value:101},{sourceTime:970000,value:102}];
 assert.equal(recoveryFeatures(row).underlyingMovement[1].netBps,null);
 assert.equal(recoveryFeatures({...row,history:[]}).underlyingMovement[1].netBps,null);
});

test('remaining recovery gets harder as an unfavorable accumulated average becomes fixed',()=>{
 const early=recoveryFeatures({...input(),sampleCount:10,runningAverage:99,now:950000,sourceTime:950000});
 const late=recoveryFeatures({...input(),sampleCount:50,runningAverage:99,now:990000,sourceTime:990000});
 assert.equal(early.remainingAverage.requiredAverageAtUnroundedStrike,100.2);
 assert.equal(late.remainingAverage.requiredAverageAtUnroundedStrike,105);
 assert.ok(late.remainingAverage.candidateCushionBps!<early.remainingAverage.candidateCushionBps!);
});
