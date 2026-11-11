import type { ChartEvent, MarketInfo, ServerMessage } from '../types/market.ts';
type OrderEvent = Extract<ServerMessage, {type: 'orderEvent'}>;

// Keep individual order state internally; render just one marker for the market.
export class OrderMarkers {
  private orders = new Map<string, OrderEvent>();
  apply(events: ChartEvent[], update: OrderEvent, market: MarketInfo | null): boolean {
    if (!market || update.ticker !== market.ticker) return false;
    this.orders.set(update.orderId, update);
    for (const [id, order] of this.orders) {
      if (order.ticker !== market.ticker) this.orders.delete(id);
    }
    const candidate = [...this.orders.values()].filter(order =>
      (order.resting || order.status === 'executed') && Number.isFinite(order.yes) &&
      Number.isFinite(order.time) && order.yes! >= 0 && order.yes! <= 100 && order.time! < market.closeTime)
      .sort((a, b) => a.time! - b.time! || a.orderId.localeCompare(b.orderId))[0];
    const previous = events.filter(event => event.ticker === market.ticker && event.type === 'rest');
    const marker: ChartEvent | undefined = candidate && {type: 'rest', ticker: market.ticker,
      orderId: candidate.orderId, yes: candidate.yes!, time: Math.max(market.openTime, candidate.time!)};
    if (JSON.stringify(previous) === JSON.stringify(marker ? [marker] : [])) return false;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].ticker === market.ticker && events[i].type === 'rest') events.splice(i, 1);
    }
    if (marker) events.push(marker);
    return true;
  }
}

export function addFillMarker(events: ChartEvent[], event: ChartEvent): boolean {
  if (events.some(previous => previous.ticker === event.ticker && previous.type === event.type)) return false;
  events.push(event);
  return true;
}
