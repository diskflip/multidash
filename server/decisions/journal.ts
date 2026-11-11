import {mkdir,appendFile} from 'node:fs/promises';
import {join} from 'node:path';
// Append in order off the quote/WS hot path. Never log headers, tokens, or accounts.
export class DecisionJournal {
  private queue:Promise<void>=Promise.resolve();
  constructor(private directory:string) {}
  append(event:object) {
    const day=new Date().toISOString().slice(0,10);
    this.queue=this.queue.then(async()=>{
      await mkdir(this.directory,{recursive:true});
      await appendFile(join(this.directory,`${day}.jsonl`),JSON.stringify(event)+'\n');
    }).catch(()=>{console.warn('[jev] Could not save evaluation record');});
  }
}
