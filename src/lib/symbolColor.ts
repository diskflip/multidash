// Each market's own brand or Kalshi series-art color, shared by its graph
// line and market labels.
export const SYMBOL_COLOR: Record<string, string> = {
  BTC: "#f7931a", // Bitcoin orange
  ETH: "#627eea", // Ethereum indigo
  DOGE: "#c2a633", // Dogecoin gold
  NEAR: "#00ec97", // NEAR green
  GOLD: "#e6bf46",
  SILVER: "#9da8b0",
  COPPER: "#b8763b",
  PLATINUM: "#b9c2cb",
  PALLADIUM: "#748696",
};
export const DEFAULT_SYMBOL_COLOR = "#f4f6f8";

const hexToRgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

// Cached per symbol — called every render for the chart's distance line.
const pastelCache = new Map<string, string>();

// "r, g, b" (no wrapping rgb()/alpha) so a caller can drop it straight
// into `rgba(${…}, alpha)` at whatever opacity it needs. Blended most of
// the way to white: a pale tint of the market's own color, distinct from
// the full-saturation line it's drawn alongside without competing with it.
export function pastelSymbolColorRgb(symbol: string, whiteMix = 0.72): string {
  const cacheKey = `${symbol}:${whiteMix}`;
  const cached = pastelCache.get(cacheKey);
  if (cached) return cached;
  const [r, g, b] = hexToRgb(SYMBOL_COLOR[symbol] ?? DEFAULT_SYMBOL_COLOR);
  const mix = (c: number) => Math.round(c * (1 - whiteMix) + 255 * whiteMix);
  const result = `${mix(r)}, ${mix(g)}, ${mix(b)}`;
  pastelCache.set(cacheKey, result);
  return result;
}
