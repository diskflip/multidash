export type FocusStats = {
  connected: boolean;
  score: number | null;
  sim30mTally: number;
  sim1hTally: number;
  resting?: boolean;
  holding?: boolean;
  positionFp?: number;
  currentYes?: number | null;
  ticker?: string | null;
};

export function isLateContested(stats: FocusStats | undefined, remainingSeconds: number): boolean {
  const yes = stats?.currentYes;
  return !!stats?.connected && remainingSeconds > 0 && remainingSeconds <= 120 &&
    yes != null && yes >= 15 && yes <= 85;
}

export function hasActiveOrder(stats?: Pick<FocusStats, "resting" | "holding" | "positionFp">): boolean {
  return !!(stats?.resting || stats?.holding || (stats?.positionFp ?? 0) !== 0);
}

// Equal weight for score and recent flips; favor the more recent flip window.
export function focusRank(stats?: FocusStats): number {
  if (!stats?.connected || stats.score == null) return -1;
  const flips = .7 * Math.min(stats.sim30mTally / 3, 1) + .3 * Math.min(stats.sim1hTally / 6, 1);
  return .5 * ((stats.score - 1) / 9) + .5 * flips;
}

export function focusMarkets(order: string[], visible: Record<string, boolean>, stats: Record<string, FocusStats>, remainingSeconds = Infinity) {
  const next = { ...visible };
  for (const symbol of order) {
    const row = stats[symbol];
    if (hasActiveOrder(row) || isLateContested(row, remainingSeconds)) { next[symbol] = true; continue; }
    // A connection interruption must not reshuffle the dashboard.
    if (!row?.connected) continue;
    if (row.score == null || row.score < 3) next[symbol] = false;
    else if (row.score > 3) next[symbol] = true;
    // Exactly 3 holds its previous visibility to avoid threshold churn.
  }
  const survivors = order.filter(symbol => visible[symbol] && next[symbol]);
  const added = order.filter(symbol => !visible[symbol] && next[symbol]);
  added.sort((a, b) => focusRank(stats[b]) - focusRank(stats[a]));
  const hidden = order.filter(symbol => !next[symbol]);
  return { visible: next, order: [...survivors, ...added, ...hidden] };
}
