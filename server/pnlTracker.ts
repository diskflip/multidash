// Session P&L for one market symbol, added once per settled window — see
// portfolio.ts's realizedPnlFromSettlement.
export class PnlTracker {
  private sessionDollars = 0;

  add(amount: number) {
    this.sessionDollars += amount;
  }

  reset() {
    this.sessionDollars = 0;
  }

  total(): number {
    return this.sessionDollars;
  }
}
