import test from 'node:test';
import assert from 'node:assert/strict';
import {OrderMarkers,addFillMarker} from '../src/lib/orderMarkers.ts';
import type {ChartEvent,ServerMessage} from '../src/types/market.ts';
const market={symbol:'GBPUSD',ticker:'new',title:'new',openTime:900,closeTime:1800};
const event:Extract<ServerMessage,{type:'orderEvent'}>={type:'orderEvent',symbol:'GBPUSD',ticker:'new',orderId:'a',resting:true,status:'resting',yes:7,time:900.001};
test('multiple resting orders and repeated partial-fill updates render one line',()=>{
 const state=new OrderMarkers(),events:ChartEvent[]=[];
 state.apply(events,event,market);
 state.apply(events,{...event,orderId:'b',yes:93},market);
 state.apply(events,event,market);
 assert.equal(events.length,1);assert.equal(events[0].time,900.001);
 state.apply(events,{...event,resting:false,status:'canceled'},market);
 assert.equal(events.length,1);assert.equal(events[0].orderId,'b');
 state.apply(events,{...event,orderId:'b',resting:false,status:'canceled'},market);
 assert.equal(events.length,0);
});
test('filled rest remains historical; buys and sells each have a single marker per market',()=>{
 const state=new OrderMarkers(),events:ChartEvent[]=[];
 state.apply(events,event,market);
 state.apply(events,{...event,resting:false,status:'executed'},market);
 for(let i=0;i<4;i++)for(const type of ['buy','sell'] as const) addFillMarker(events,{type,time:901+i,yes:50,ticker:'new'});
 assert.deepEqual(events.map(e=>e.type),['rest','buy','sell']);
 assert.equal(state.apply(events,{...event,ticker:'old'},market),false);
 addFillMarker(events,{type:'buy',time:1801,yes:7,ticker:'next'});
 assert.equal(events.length,4);
});
