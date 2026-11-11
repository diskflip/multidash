import { useMarketClock } from "../lib/marketClock";

export type CountdownState = {
  text: string;
  remainingSeconds: number | null;
};

// Ticks once a second so the countdown reads live without waiting on a
// server push — we already know closeTime, no need to round-trip for it.
export function useCountdown(closeTime: number | null): CountdownState {
  const now = useMarketClock();

  if (closeTime === null) return { text: "—:—", remainingSeconds: null };
  const remaining = Math.max(0, Math.floor(closeTime - now));
  return { text: formatRemaining(remaining), remainingSeconds: remaining };
}

export function formatRemaining(remainingSeconds: number): string {
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
