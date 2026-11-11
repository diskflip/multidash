import type { PortfolioSnapshot } from "./portfolio.ts";

// Merge push events over REST reads that began before those events arrived.
export class LivePortfolio {
  revision = 0;
  snapshot: PortfolioSnapshot = { balanceCents: 0, restingTickers: new Set(), holdingTickers: new Set(), restingOrders: new Map(), positionBaselines: new Map() };
  private orders = new Map<string, { ticker: string; resting: boolean; revision: number }>();
  private positions = new Map<string, { holding: boolean; revision: number }>();

  order(id: string, ticker: string, resting: boolean) {
    this.orders.set(id, { ticker, resting, revision: ++this.revision });
    if (resting) this.snapshot.restingOrders.set(id, ticker);
    else this.snapshot.restingOrders.delete(id);
    this.snapshot.restingTickers = new Set(this.snapshot.restingOrders.values());
  }
  position(ticker: string, holding: boolean) {
    this.positions.set(ticker, { holding, revision: ++this.revision });
    if (holding) this.snapshot.holdingTickers.add(ticker);
    else this.snapshot.holdingTickers.delete(ticker);
  }
  reconcile(snapshot: PortfolioSnapshot, startedAt: number) {
    for (const [id, event] of this.orders) {
      if (event.revision <= startedAt) { this.orders.delete(id); continue; }
      if (event.resting) snapshot.restingOrders.set(id, event.ticker);
      else snapshot.restingOrders.delete(id);
    }
    for (const [ticker, event] of this.positions) {
      if (event.revision <= startedAt) { this.positions.delete(ticker); continue; }
      if (event.holding) snapshot.holdingTickers.add(ticker);
      else snapshot.holdingTickers.delete(ticker);
    }
    snapshot.restingTickers = new Set(snapshot.restingOrders.values());
    this.snapshot = snapshot;
    return snapshot;
  }
}
