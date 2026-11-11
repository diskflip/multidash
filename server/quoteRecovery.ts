import { config } from './config.ts';
import { signRequest } from './kalshiAuth.ts';
import type { CurrentMarket } from './findMarket.ts';
import type { HistoryPoint } from '../src/types/market.ts';

export async function readYesBid(ticker: string): Promise<number | null> {
  const path = `/trade-api/v2/markets/${encodeURIComponent(ticker)}/orderbook`;
  const response = await fetch(`${config.restBaseUrl}${path}?depth=1`, {
    headers: signRequest('GET', path), signal: AbortSignal.timeout(2000), cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Orderbook ${response.status}`);
  const body = await response.json() as { orderbook_fp?: { yes_dollars?: [string, string][] } };
  const levels = body.orderbook_fp?.yes_dollars;
  if (!Array.isArray(levels)) return null;
  const bids = levels.filter(([price, size]) => Number.isFinite(Number(price)) && Number(size) > 0)
    .map(([price]) => Math.round(Number(price) * 100)).filter(price => price >= 0 && price <= 100);
  // An empty book is not a confirmed zero-cent bid.
  return bids.length ? Math.max(...bids) : null;
}

// Supplement quiet ticker streams with actual book observations, not invented
// repeated prices. A slow response must never overwrite a newer WS observation.
export class QuoteRecovery {
  private pending = new Set<string>();
  constructor(private read = readYesBid, private now = Date.now) {}

  async refresh(symbol: string, current: () => CurrentMarket | null,
    latest: () => HistoryPoint | undefined, emit: (point: HistoryPoint) => void) {
    const market = current();
    const start = this.now();
    if (!market || start < market.openTime || start >= market.closeTime || this.pending.has(market.ticker)) return;
    const previous = latest();
    if (previous?.ticker === market.ticker && start / 1000 - previous.time < 3) return;
    this.pending.add(market.ticker);
    try {
      const yes = await this.read(market.ticker);
      if (yes === null || current()?.ticker !== market.ticker || this.now() >= market.closeTime) return;
      const recent = latest();
      if (recent?.ticker === market.ticker && recent !== previous) return;
      emit({ yes, time: start / 1000, ticker: market.ticker,
        openTime: market.openTime / 1000, closeTime: market.closeTime / 1000,
        source: 'snapshot' });
    } catch (error) {
      console.warn(`[quote-recovery] ${symbol}: ${(error as Error).message}`);
    } finally { this.pending.delete(market.ticker); }
  }
}
