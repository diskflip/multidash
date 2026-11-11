import { MAX_QUOTE_AGE_SECONDS, validPoint } from "./chartTimeline";
import type { HistoryPoint } from "../types/market";

// The outline follows the rolling 30-minute flip tally shown in the summary.
// Live scores and quote movement cannot toggle it; only the tally or connection can.
export function isMarketHot(flips30m: number, connected: boolean): boolean {
  return connected && Number.isFinite(flips30m) && flips30m >= 3;
}

// Total absolute YES-price movement over the rolling 15-minute window.
// Gaps and contract changes are excluded so reconnects and rollovers don't invent activity.
export function marketActivity15m(history: HistoryPoint[], now: number): { movement: number; available: boolean } {
  const cutoff = now - 15 * 60;
  let previous: HistoryPoint | null = null;
  let movement = 0;
  let available = false;
  for (const point of history) {
    if (!validPoint(point) || point.time < cutoff || point.time > now) {
      previous = null;
      continue;
    }
    available = true;
    if (previous && point.ticker === previous.ticker && !point.breakBefore && point.time - previous.time <= MAX_QUOTE_AGE_SECONDS) {
      movement += Math.abs(point.yes - previous.yes);
    }
    previous = point;
  }
  return { movement, available };
}

export type GroupActivityLevel = "dead" | "mediocre" | "hot" | "extremely-hot";

// Average total price movement per available market over the rolling 15 minutes.
export function groupActivityLevel(activityPerMarketCents: number): GroupActivityLevel {
  if (activityPerMarketCents < 100) return "dead";
  if (activityPerMarketCents < 300) return "mediocre";
  if (activityPerMarketCents < 650) return "hot";
  return "extremely-hot";
}

// Movement can raise heat only when the rolling 30-minute sim supports it.
// No completed wins caps an unproven group at mediocre; a net sim loss cools it to dead.
export function groupHeatLevel(activityPerMarketCents: number, wins30m: number, simProfit30m: number): GroupActivityLevel {
  const movement = groupActivityLevel(activityPerMarketCents);
  const result: GroupActivityLevel = simProfit30m < 0
    ? "dead"
    : wins30m === 0
      ? "mediocre"
      : wins30m >= 3 && simProfit30m >= 50
        ? "extremely-hot"
        : wins30m >= 2 && simProfit30m > 0
          ? "hot"
          : "mediocre";
  const levels: GroupActivityLevel[] = ["dead", "mediocre", "hot", "extremely-hot"];
  return levels[Math.min(levels.indexOf(movement), levels.indexOf(result))];
}
