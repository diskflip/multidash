// Live BTC/USD spot price from Coinbase's public endpoint — Kalshi's ticker
// feed only gives the YES contract's probability, not the underlying price.
const SPOT_URL = "https://api.coinbase.com/v2/prices/BTC-USD/spot";
const SPOT_POLL_MS = 5_000;

export function startBtcSpotFeed(onPrice: (dollars: number) => void) {
  async function poll() {
    try {
      const res = await fetch(SPOT_URL);
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      const body = (await res.json()) as { data: { amount: string } };
      const dollars = parseFloat(body.data.amount);
      if (!Number.isNaN(dollars)) onPrice(dollars);
    } catch (err) {
      console.error("[spot-price] BTC lookup failed:", (err as Error).message);
    }
  }
  poll();
  setInterval(poll, SPOT_POLL_MS);
}
