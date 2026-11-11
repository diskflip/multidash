import { focusRank, hasActiveOrder, isLateContested, type FocusStats } from './focusMarkets';

// useMarket clears currentYes after ten seconds without a quote or at close.
// A live WebSocket alone does not mean this individual market is still live.
function hasLiveFeed(stats: FocusStats | undefined): boolean {
  return !!stats?.connected && stats.currentYes != null && stats.ticker != null;
}

export function isStrongMarket(stats: FocusStats | undefined): boolean {
  return hasLiveFeed(stats) && (stats?.score ?? 0) >= 6;
}

// Selection changes; the order of surviving cards never does.
export class AutoMarkets {
  private allowedSymbols?: ReadonlySet<string>;
  constructor(allowedSymbols?: ReadonlySet<string>) { this.allowedSymbols = allowedSymbols; }
  private eligible(symbol: string) { return !this.allowedSymbols || this.allowedSymbols.has(symbol); }
  private closeTime: number | null = null;
  private shownAt = new Map<string, number>();
  private quietSince = new Map<string, number>();
  private prices = new Map<string, { ticker: string | null | undefined; points: { time: number; yes: number }[] }>();

  private movement(symbol: string, stats: FocusStats | undefined, now: number) {
    const yes = stats?.currentYes;
    const points = this.prices.get(symbol)?.points.filter(point => point.time >= now - 20) ?? [];
    if (!stats?.connected || yes == null || points.length < 2) return { active: false, strength: 0 };
    const range = Math.max(...points.map(p => p.yes)) - Math.min(...points.map(p => p.yes));
    const cheap = Math.min(yes, 100 - yes);
    const recovery = cheap - Math.min(...points.map(p => Math.min(p.yes, 100 - p.yes)));
    return { active: cheap >= 5 && range >= 2, strength: Math.min(range / 20, 1) + Math.min(recovery / 10, 1) };
  }

  needsAdmission(order: string[], visible: Record<string, boolean>, stats: Record<string, FocusStats>, now: number, closeTime: number | null): boolean {
    const remaining = closeTime === null ? Infinity : closeTime - now;
    const late = remaining > 0 && remaining <= 120;
    return order.some(symbol => this.eligible(symbol) && !visible[symbol] && hasLiveFeed(stats[symbol]) && (isStrongMarket(stats[symbol]) ||
      (late && (isLateContested(stats[symbol], remaining) || this.movement(symbol, stats[symbol], now).active))));
  }

  needsRemoval(order: string[], visible: Record<string, boolean>, stats: Record<string, FocusStats>): boolean {
    return order.some(symbol => visible[symbol] && symbol !== 'BTC' &&
      !hasActiveOrder(stats[symbol]) && !hasLiveFeed(stats[symbol]));
  }

  observe(symbol: string, stats: FocusStats, now: number) {
    let history = this.prices.get(symbol);
    if (!history || history.ticker !== stats.ticker) {
      history = { ticker: stats.ticker, points: [] };
      this.prices.set(symbol, history);
    }
    history.points = history.points.filter(point => point.time >= now - 20);
    const yes = stats.currentYes;
    if (!stats.connected || yes == null) history.points = [];
    else {
      const last = history.points.at(-1);
      if (!last || last.yes !== yes || now - last.time >= 1) history.points.push({ time: now, yes });
    }
    const remaining = this.closeTime === null ? Infinity : this.closeTime - now;
    const movingLate = remaining > 0 && remaining <= 120 && this.movement(symbol, stats, now).active;
    if (stats.connected && (stats.score == null || stats.score < 4) &&
        !hasActiveOrder(stats) && !isLateContested(stats, remaining) && !movingLate) {
      if (!this.quietSince.has(symbol)) this.quietSince.set(symbol, now);
    } else this.quietSince.delete(symbol);
  }

  select(order: string[], visible: Record<string, boolean>, stats: Record<string, FocusStats>,
    now: number, closeTime: number | null, capacity: number, interacting = new Set<string>()) {
    this.closeTime = closeTime;
    const remaining = closeTime === null ? Infinity : closeTime - now;
    const ending = remaining > 0 && remaining <= 60;
    const late = remaining > 0 && remaining <= 120;
    const minimumStay = ending ? 15 : 20;
    const quietGrace = ending ? 8 : 15;
    const pinned = new Set<string>();
    const candidates: { symbol: string; rank: number; opportunity: boolean }[] = [];
    for (const symbol of order) {
      const row = stats[symbol];
      if (!this.eligible(symbol) && !hasActiveOrder(row)) continue;
      if (row) this.observe(symbol, row, now);
      if (visible[symbol] && !this.shownAt.has(symbol)) this.shownAt.set(symbol, now);
      if (!visible[symbol]) this.shownAt.delete(symbol);
      if (symbol === 'BTC' || hasActiveOrder(row)) {
        pinned.add(symbol); continue;
      }
      if (!row || !hasLiveFeed(row)) continue;
      if (visible[symbol] && interacting.has(symbol)) { pinned.add(symbol); continue; }
      const contested = isLateContested(row, remaining);
      const movement = this.movement(symbol, row, now);
      const moving = late && movement.active;
      const opportunity = moving || contested;
      const qualifies = opportunity || (row.score ?? 0) >= 4.5 || (visible[symbol] && (row.score ?? 0) >= 4);
      const age = now - (this.shownAt.get(symbol) ?? now);
      const quietAge = now - (this.quietSince.get(symbol) ?? now);
      const settling = visible[symbol] && age < minimumStay;
      if (!qualifies && !(visible[symbol] && (settling || quietAge < quietGrace))) continue;
      // Current score leads; old flip counts are only supporting evidence.
      // Late two-sided markets remain eligible even when the score is low.
      const score = row.score == null ? 0 : (row.score - 1) / 9;
      const rank = late
        ? (moving ? 2 + movement.strength : contested ? 1 : 0) + .4 * score
        : .75 * score + .25 * Math.max(0, focusRank(row));
      // Brief dwell plus a small incumbent advantage prevents constant swaps.
      candidates.push({ symbol, opportunity, rank: rank + (settling && !late ? 2 : visible[symbol] ? .12 : 0) });
    }
    candidates.sort((a,b) => b.rank - a.rank);
    const selected = new Set([...pinned, ...candidates.slice(0, Math.max(0, capacity - pinned.size)).map(row => row.symbol)]);
    // Strong scores and late contenders compete for the same bounded slots.
    // Only BTC, real exposure, and a card being inspected bypass that limit.
    const next = Object.fromEntries(order.map(symbol => [symbol, selected.has(symbol)]));
    const survivors = order.filter(symbol => visible[symbol] && next[symbol]);
    const added = [...selected].filter(symbol => !visible[symbol]);
    for (const symbol of added) this.shownAt.set(symbol, now);
    for (const symbol of order) if (!next[symbol]) this.shownAt.delete(symbol);
    const nextOrder = [...survivors, ...added, ...order.filter(symbol => !next[symbol])];
    return { visible: next, order: order.includes('BTC') ? ['BTC', ...nextOrder.filter(symbol => symbol !== 'BTC')] : nextOrder };
  }
}
