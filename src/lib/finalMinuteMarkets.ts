import { focusRank, hasActiveOrder, isLateContested, type FocusStats } from "./focusMarkets";

// Hold the existing layout during the final minute; admit new candidates only
// into free slots. Active trades always remain visible, even above the limit.
export class FinalMinuteMarkets {
  private closeTime: number | null = null;
  private shownAt = new Map<string, number>();
  private lowSince = new Map<string, number>();

  reset() { this.closeTime = null; this.shownAt.clear(); this.lowSince.clear(); }

  observe(symbol: string, stats: FocusStats, now: number) {
    if (this.closeTime === null) return;
    if (stats.connected && stats.score !== null && stats.score < 3 && !hasActiveOrder(stats) && !isLateContested(stats, this.closeTime - now)) {
      if (!this.lowSince.has(symbol)) this.lowSince.set(symbol, now);
    } else this.lowSince.delete(symbol);
  }

  select(order: string[], visible: Record<string, boolean>, stats: Record<string, FocusStats>, now: number, closeTime: number, capacity: number) {
    if (closeTime !== this.closeTime) {
      this.reset();
      this.closeTime = closeTime;
    }
    const next = { ...visible };
    for (const symbol of order) {
      const row = stats[symbol];
      if (row) this.observe(symbol, row, now);
      if (hasActiveOrder(row)) next[symbol] = true;
      if (!next[symbol]) { this.shownAt.delete(symbol); continue; }
      if (!this.shownAt.has(symbol)) this.shownAt.set(symbol, now);
      if (hasActiveOrder(row)) continue;
      const lowSince = this.lowSince.get(symbol);
      if (now - this.shownAt.get(symbol)! >= 30 && lowSince !== undefined && now - lowSince >= 20) {
        next[symbol] = false;
        this.shownAt.delete(symbol);
      }
    }
    let available = Math.max(0, capacity - order.filter(symbol => next[symbol]).length);
    const contested = (symbol: string) => isLateContested(stats[symbol], closeTime - now);
    const candidates = order.filter(symbol => !next[symbol] && stats[symbol]?.connected && ((stats[symbol]?.score ?? 0) > 3 || contested(symbol)))
      .sort((a, b) => Number(contested(b)) - Number(contested(a)) || focusRank(stats[b]) - focusRank(stats[a]));
    const added: string[] = [];
    for (const symbol of candidates) {
      if (available <= 0) break;
      next[symbol] = true;
      this.shownAt.set(symbol, now);
      added.push(symbol);
      available--;
    }
    // Append newcomers after surviving charts; never rearrange those survivors.
    const survivors = order.filter(symbol => next[symbol] && visible[symbol]);
    const revealedTrades = order.filter(symbol => next[symbol] && !visible[symbol] && !added.includes(symbol));
    const hidden = order.filter(symbol => !next[symbol]);
    return { visible: next, order: [...survivors, ...revealedTrades, ...added, ...hidden] };
  }
}
