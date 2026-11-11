import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {DecisionEvaluation,type EvaluationEvent} from '../server/decisions/evaluation.ts';
const file=process.argv[2]??`.runtime/jev/${new Date().toISOString().slice(0,10)}.jsonl`;
const report=new DecisionEvaluation();
try {
 for await(const line of createInterface({input:createReadStream(file),crlfDelay:Infinity})) {
  try {const event=JSON.parse(line);if(['decision','observation','inference'].includes(event.type))report.ingest(event as EvaluationEvent);}catch{/* Ignore incomplete final line after a crash. */}
 }
 console.log(JSON.stringify(report.report(),null,2));
} catch {console.error('No Jev evaluation log found for this file/date.');process.exitCode=1;}
