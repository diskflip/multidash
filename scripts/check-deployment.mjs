import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import dotenv from 'dotenv';
import WebSocket from 'ws';

const base = process.argv[2];
if (!base) throw new Error('Usage: node scripts/check-deployment.mjs https://your-host');
const env = dotenv.parse(readFileSync('.env'));
const token = env.DASHBOARD_ACCESS_TOKEN;
const headers = { Cookie: `dashboard_session=${token}` };
const get = (path, options = {}) => fetch(new URL(path, base), {
  signal: AbortSignal.timeout(15000), ...options,
});
assert.equal((await get('/')).status, 200);
assert.equal((await get('/login?access=invalid')).status, 401);
const login = await get(`/login?access=${token}`, { redirect: 'manual' });
assert.equal(login.status, 303);
assert.match(login.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Strict/);
const page = await get('/');
assert.equal(page.status, 200);
const html = await page.text();
assert.match(html, /id="root"/);
for (const asset of html.matchAll(/(?:src|href)="(\/[^"]+)"/g)) {
  assert.equal((await get(asset[1])).status, 200, asset[1]);
}
for (const path of ['/.env', '/server/kalshi-private-key.pem', '/server/config.ts']) {
  assert.equal((await get(path)).status, 404);
}
const wsUrl = new URL('/ws', base);
wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
async function rejectSocket(extraHeaders) {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: extraHeaders, handshakeTimeout: 10000 });
    ws.on('open', () => { ws.close(); reject(new Error('Unauthorized socket accepted')); });
    ws.on('unexpected-response', (_req, res) => {
      res.resume(); ws.terminate();
      if (res.statusCode === 401) resolve(); else reject(new Error(`Unexpected status ${res.statusCode}`));
    });
    ws.on('error', () => {});
  });
}
await rejectSocket({ ...headers, Origin: 'https://untrusted.example' });
const counts = {};
const prices = new Set();
const bots = new Set();
await new Promise((resolve, reject) => {
  const ws = new WebSocket(wsUrl, { headers: { Origin: new URL(base).origin }, handshakeTimeout: 10000 });
  const timer = setTimeout(() => { ws.close(); resolve(); }, 20000);
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'status') {
      assert.equal(msg.canControl, true);
    }
    counts[msg.type] = (counts[msg.type] ?? 0) + 1;
    if (msg.type === 'price') prices.add(msg.symbol);
    if (msg.type === 'botStatus') bots.add(msg.symbol);
  });
  ws.on('error', (error) => { clearTimeout(timer); reject(error); });
});
for (const type of ['status', 'market', 'price', 'wallet', 'accountPnl', 'botStatus', 'spot']) {
  assert.ok(counts[type] > 0, `Missing live message: ${type}`);
}
console.log(JSON.stringify({ httpAndAccessChecks: 'passed', messages: counts,
  livePriceSymbols: [...prices].sort(), botSymbols: [...bots].sort() }, null, 2));
