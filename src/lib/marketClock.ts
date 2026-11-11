import { useSyncExternalStore } from "react";

let anchor = Date.now() / 1000;
let anchorAt = performance.now();
let snapshot = anchor;
let synchronized = false;
const listeners = new Set<() => void>();
let frame: number | undefined;
export const marketNow = () => anchor + (performance.now() - anchorAt) / 1000;
export function syncMarketClock(serverTime: number) {
  if (!Number.isFinite(serverTime)) return;
  // Correct the device clock on first contact. Later delayed heartbeats
  // must not wind the shared chart axis backward.
  anchor = synchronized ? Math.max(serverTime, marketNow()) : serverTime;
  anchorAt = performance.now();
  synchronized = true;
}
function tick() {
  snapshot = marketNow();
  for (const listener of listeners) listener();
  frame = requestAnimationFrame(tick);
}
export function subscribeMarketClock(listener: () => void) {
  listeners.add(listener);
  if (frame === undefined) frame = requestAnimationFrame(tick);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && frame !== undefined) { cancelAnimationFrame(frame); frame = undefined; }
  };
}
export const useMarketClock = () => useSyncExternalStore(subscribeMarketClock, () => snapshot);
