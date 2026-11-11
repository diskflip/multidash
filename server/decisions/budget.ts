import {mkdirSync,readFileSync,writeFileSync,renameSync,existsSync} from 'node:fs';
import {dirname} from 'node:path';
// Persist the request cap across restarts. This caps requests, not dollar spend.
export class RequestBudget {
  private day='';private count=0;
  constructor(private path:string,private limit:number,private now=Date.now) {
    try {const saved=JSON.parse(readFileSync(path,'utf8'));this.day=String(saved.day);this.count=Number.isInteger(saved.count)&&saved.count>=0?saved.count:limit;} catch {
      if(existsSync(path)){this.day=new Date(this.now()).toISOString().slice(0,10);this.count=limit;}
    }
  }
  available():boolean {
    const day=new Date(this.now()).toISOString().slice(0,10);
    if(day!==this.day){this.day=day;this.count=0;}
    return this.count<this.limit;
  }
  take():boolean {
    if(!this.available())return false;
    this.count++;
    try {
      mkdirSync(dirname(this.path),{recursive:true});
      writeFileSync(`${this.path}.tmp`,JSON.stringify({day:this.day,count:this.count}));
      renameSync(`${this.path}.tmp`,this.path);
      return true;
    } catch {return false;}
  }
}

// A session allowance independent of the old UTC-day trial counter.
// The window survives restarts and renews after its full duration.
export class SessionRequestBudget {
  private startedAt:number;
  private count=0;
  constructor(private path:string,private limit:number,private durationMs:number,private now=Date.now) {
    this.startedAt=now();
    try {
      const saved=JSON.parse(readFileSync(path,'utf8'));
      if(!Number.isFinite(saved.startedAt)||saved.startedAt>now()||!Number.isInteger(saved.count)||saved.count<0)throw new Error('invalid budget');
      this.startedAt=saved.startedAt;this.count=saved.count;
    }catch{if(existsSync(path))this.count=limit;}
  }
  available():boolean {
    if(this.now()-this.startedAt>=this.durationMs){this.startedAt=this.now();this.count=0;}
    return this.count<this.limit;
  }
  take():boolean {
    if(!this.available())return false;
    this.count++;
    try {
      mkdirSync(dirname(this.path),{recursive:true});
      writeFileSync(`${this.path}.tmp`,JSON.stringify({startedAt:this.startedAt,count:this.count}));
      renameSync(`${this.path}.tmp`,this.path);return true;
    }catch{this.count=this.limit;return false;}
  }
}
