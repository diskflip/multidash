export type QuickState = {
  active: boolean;
  status: string | null;
  action: 'buy' | 'sell' | null;
  orders: { action: 'buy' | 'sell'; price: number; remaining: number }[];
  next_action: 'buy' | 'sell' | null;
  buy_complete: boolean;
  held_side: 'yes' | 'no' | null;
  position_id: string | null;
  filled_cost: number | null;
  budget: number | null;
  error: string | null;
};
export type QuickTradeStatus = { version: number | null; ticker: string | null; quick: QuickState | null };
export type QuickOrder = { ticker: string; request_id: string; action: 'buy' | 'sell'; side: 'yes' | 'no'; position_id?: string };

export function hasRestingQuickBuy(status: QuickTradeStatus | null | undefined): boolean {
  return status?.quick?.orders?.some(order => order.action === 'buy' && order.remaining > 0) === true;
}

export function quickAction(status: QuickTradeStatus | null | undefined): 'buy' | 'sell' | null {
  if (status?.version !== 1 || !status.ticker || !status.quick) return null;
  const q = status.quick;
  if (q.next_action === 'buy') return 'buy';
  if (q.next_action === 'sell' && q.buy_complete && q.position_id && q.held_side) return 'sell';
  return null;
}

export function quickOrder(status: QuickTradeStatus, requestId: string): QuickOrder {
  const action = quickAction(status);
  if (!action || !status.ticker) throw new Error('Quick trading is not ready. Waiting for the bot status.');
  return action === 'buy'
    ? { ticker: status.ticker, request_id: requestId, action, side: 'yes' }
    : { ticker: status.ticker, request_id: requestId, action, side: status.quick!.held_side!, position_id: status.quick!.position_id! };
}

export function normalizeQuickTrade(entry: any, version: unknown): QuickTradeStatus {
  const raw = entry?.quick;
  const money = (value: unknown) => (typeof value === 'number' || typeof value === 'string') && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
  return {
    version: typeof version === 'number' ? version : null,
    ticker: typeof entry?.ticker === 'string' ? entry.ticker : null,
    quick: raw && typeof raw === 'object' ? {
      active: raw.active === true,
      status: typeof raw.status === 'string' ? raw.status : null,
      action: raw.action === 'buy' || raw.action === 'sell' ? raw.action : null,
      orders: Array.isArray(raw.orders) ? raw.orders.flatMap((order: any) => {
        const price = money(order.price), remaining = money(order.remaining_quantity);
        return order.status === 'resting' && (order.action === 'buy' || order.action === 'sell') &&
          price !== null && remaining !== null && remaining > 0
          ? [{ action: order.action, price, remaining }] : [];
      }) : [],
      next_action: raw.next_action === 'buy' || raw.next_action === 'sell' ? raw.next_action : null,
      buy_complete: raw.buy_complete === true,
      held_side: raw.held_side === 'yes' || raw.held_side === 'no' ? raw.held_side : null,
      position_id: typeof raw.position_id === 'string' ? raw.position_id : null,
      filled_cost: money(raw.filled_cost), budget: money(raw.budget),
      error: typeof raw.error === 'string' && raw.error ? raw.error : null,
    } : null,
  };
}
