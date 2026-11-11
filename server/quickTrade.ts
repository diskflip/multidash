import { config } from './config.ts';
import { hasRestingQuickBuy, quickOrder, type QuickOrder, type QuickTradeStatus } from '../src/lib/quickTrade.ts';

export function validateQuickOrder(status: QuickTradeStatus | null | undefined, body: QuickOrder, cancelRestingBuy = false): QuickOrder {
  if (!status || typeof body?.request_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.request_id)) {
    throw new Error('Invalid quick-trade request.');
  }
  const expected = quickOrder(status, body.request_id);
  // The backend now toggles a repeated BUY into cancellation. Reject stale UI
  // intent so a CANCEL click cannot become a fresh BUY (or vice versa).
  if ((expected.action === 'buy' && hasRestingQuickBuy(status)) !== cancelRestingBuy) {
    throw new Error('The resting order changed. Check the updated button before trying again.');
  }
  if (body.ticker !== expected.ticker || body.action !== expected.action || body.side !== expected.side || body.position_id !== expected.position_id) {
    throw new Error('The market or position changed. Check the updated button before trying again.');
  }
  return expected;
}

export async function postQuickOrder(series: string, body: QuickOrder): Promise<{ queued: boolean }> {
  if (!config.controlToken) throw new Error('Trading connection is unavailable.');
  const serialized = JSON.stringify(body);
  // An uncertain transport outcome retries the exact same idempotent request.
  for (let attempt = 0; attempt < 2; attempt++) {
    let response: Response;
    try {
      response = await fetch(`${config.multibotApiUrl}/v1/bots/${encodeURIComponent(series)}/quick`, {
        method: 'POST', headers: { Authorization: `Bearer ${config.controlToken}`, 'Content-Type': 'application/json' },
        body: serialized, signal: AbortSignal.timeout(4000),
      });
    } catch {
      if (attempt === 0) continue;
      throw new Error('Request confirmation unavailable. Check the bot status before placing another order.');
    }
    if (response.ok) return { queued: response.status === 202 };
    if (response.status >= 500 && attempt === 0) continue;
    const result = await response.json().catch(() => null) as { quick?: { error?: unknown }; error?: unknown; detail?: unknown } | null;
    const error = result?.quick?.error ?? result?.error ?? result?.detail;
    throw new Error(typeof error === 'string' ? error : `Quick trade failed (${response.status}).`);
  }
  throw new Error('Quick trade unavailable.');
}
