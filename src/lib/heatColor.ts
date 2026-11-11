// Shared low -> high ramp for the flip score (1-10) and the sim flip
// tallies, so "how good is this market right now" reads the same color
// everywhere: dim grey (nothing) -> amber -> green (#2fd996, the app's win green).
const STOPS: [number, number, number][] = [
  [120, 126, 134],
  [240, 190, 60],
  [47, 217, 150],
];

export function heatColor(frac01: number): string {
  const t = Math.max(0, Math.min(1, frac01)) * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(t));
  const f = t - i;
  const [r0, g0, b0] = STOPS[i];
  const [r1, g1, b1] = STOPS[i + 1];
  return `rgb(${Math.round(r0 + (r1 - r0) * f)}, ${Math.round(g0 + (g1 - g0) * f)}, ${Math.round(b0 + (b1 - b0) * f)})`;
}
