import test from 'node:test';
import assert from 'node:assert/strict';
import { BotCommandLane } from './botCommandLane.ts';

test('polls started before or during a write cannot overwrite its result', async () => {
  const lane = new BotCommandLane();
  const before = lane.revision('BTC');
  let finish!: () => void;
  const command = lane.run('BTC', () => new Promise<void>(resolve => { finish = resolve; }));
  await Promise.resolve();
  await Promise.resolve();
  const during = lane.revision('BTC');
  assert.equal(lane.canApplyPoll('BTC', before), false);
  assert.equal(lane.canApplyPoll('BTC', during), false);
  finish(); await command;
  assert.equal(lane.canApplyPoll('BTC', before), false);
  assert.equal(lane.canApplyPoll('BTC', during), false);
  assert.equal(lane.canApplyPoll('BTC', lane.revision('BTC')), true);
});

test('same-bot writes execute in order; a failure does not block later commands', async () => {
  const lane = new BotCommandLane();
  const state = {enabled:false,budget:1};
  const first=lane.run('BTC',async()=>{await new Promise(resolve=>setTimeout(resolve,5));state.enabled=true;});
  const second=lane.run('BTC',async()=>{assert.equal(state.enabled,true);state.budget=5;});
  await Promise.all([first,second]);
  assert.deepEqual(state,{enabled:true,budget:5});
  await assert.rejects(lane.run('BTC',async()=>{throw new Error('failed');}));
  assert.equal(await lane.run('BTC',async()=>true),true);
});
