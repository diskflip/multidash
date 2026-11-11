import type {DecisionProvider,Features,ModelAnswer} from './types.ts';
import type {EntryChoice} from '../../src/types/decision.ts';
import {PROMPT_VERSION,decisionState,questions} from './prompt.ts';
const choices=['YES','NO'];
export class JevHttpError extends Error {
  constructor(readonly status:number){super(`TypeSafe HTTP ${status}`);}
}
export function parseAnswer(raw:unknown,side:'yes'|'no'='yes'):ModelAnswer {
  const b=raw as {model?:unknown;answers?:Record<string,any>;usage?:Record<string,unknown>};
  const answer=b?.answers?.entry;
  const probability=(n:unknown)=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1;
  if(typeof b?.model!=='string'||answer?.type!=='choice'||!choices.includes(answer.choice)||!probability(answer.confidence)||
    !choices.every(c=>probability(answer.probabilities?.[c]))||Math.abs(choices.reduce((n,c)=>n+answer.probabilities[c],0)-1)>.02) throw new Error('Invalid TypeSafe decision');
  const input=b.usage?.input_tokens,output=b.usage?.output_tokens;
  if(typeof input!=='number'||!Number.isInteger(input)||input<0||typeof output!=='number'||!Number.isInteger(output)||output<0) throw new Error('Invalid TypeSafe usage');
  const reason=b.answers?.condition;
  const allowed=['recovering','collapsing','flat','insufficient_evidence'];
  const choice:EntryChoice=answer.choice==='YES'?(side==='yes'?'ENTER_YES':'ENTER_NO'):'WAIT';
  return {choice,confidence:answer.confidence,probabilities:{ENTER_YES:side==='yes'?answer.probabilities.YES:0,ENTER_NO:side==='no'?answer.probabilities.YES:0,WAIT:answer.probabilities.NO},
    reason:reason?.type==='choice'&&allowed.includes(reason.choice)?reason.choice:'insufficient_evidence',
    model:b.model,inputTokens:input,outputTokens:output};
}
export class JevProvider implements DecisionProvider {
  constructor(private key:string,private model='jev-latest',private request:typeof fetch=fetch) {}
  async decide(features:Features):Promise<ModelAnswer> {
    const response=await this.request('https://api.typesafe.ai/v1/systemone',{
      method:'POST',headers:{Authorization:`Bearer ${this.key}`,'Content-Type':'application/json'},
      signal:AbortSignal.timeout(1500),
      body:JSON.stringify({model:this.model,state:decisionState(features),questions})});
    if(!response.ok)throw new JevHttpError(response.status);
    return {...parseAnswer(await response.json(),features.candidateSide),promptVersion:PROMPT_VERSION};
  }
}
