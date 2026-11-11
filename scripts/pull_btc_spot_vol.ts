import { writeFileSync } from "node:fs";

async function main() {
  // Real BTC-USD price, 1h candles, straight from Coinbase's public market data —
  // independent of Kalshi/our own trades, to test whether real BTC volatility
  // (not just our own noisy 5-min pre-entry snapshots) tracks the win-rate regime.
  // Coinbase caps each request at 300 candles, so page in ~250h chunks.
  const rangeStart = new Date("2026-08-07T00:00:00Z").getTime();
  const rangeEnd = new Date("2026-08-25T00:00:00Z").getTime();
  const chunkMs = 250 * 60 * 60 * 1000;

  const all: [number, number, number, number, number, number][] = [];
  for (let t = rangeStart; t < rangeEnd; t += chunkMs) {
    const chunkEnd = Math.min(t + chunkMs, rangeEnd);
    const url = `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=3600&start=${new Date(t).toISOString()}&end=${new Date(chunkEnd).toISOString()}`;
    const res = await fetch(url, { headers: { "User-Agent": "research-script" } });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text}`);
    all.push(...JSON.parse(text));
    await new Promise((r) => setTimeout(r, 300));
  }

  all.sort((a, b) => a[0] - b[0]);
  writeFileSync("scripts/btc-spot-hourly.json", JSON.stringify(all));
  console.log(`Got ${all.length} hourly candles, ${new Date(all[0][0] * 1000).toISOString()} to ${new Date(all[all.length - 1][0] * 1000).toISOString()}`);
}
main();
