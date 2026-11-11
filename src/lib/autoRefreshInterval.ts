export function autoRefreshSeconds(closeTime: number | null, now: number): number {
  if (closeTime === null || closeTime <= now) return 30;
  const remaining = closeTime - now;
  if (remaining <= 60) return 5;
  if (remaining <= 120) return 10;
  if (remaining <= 180) return 20;
  return 30;
}
