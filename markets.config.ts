export type Market = {
  symbol: string;
  seriesTicker: string;
  enabled: boolean; // Default chart visibility; all markets remain available in the summary.
};

// Add, remove, or toggle markets here. Both the backend (server/config.ts)
// and frontend (src/App.tsx) read from this one list, in this order — the
// frontend renders it as-is, with no further sorting or reordering.
export const MARKETS: Market[] = [
  { symbol: "BTC", seriesTicker: "KXBTC15M", enabled: true },
  { symbol: "DOGE", seriesTicker: "KXDOGE15M", enabled: true },
  // Hidden by default; selectable in the summary.
  { symbol: "ETH", seriesTicker: "KXETH15M", enabled: false },
  { symbol: "SOL", seriesTicker: "KXSOL15M", enabled: false },
  { symbol: "ZEC", seriesTicker: "KXZEC15M", enabled: false },
  { symbol: "NEAR", seriesTicker: "KXNEAR15M", enabled: false },
  { symbol: "GOLD", seriesTicker: "KXGOLD15M", enabled: true },
  { symbol: "SILVER", seriesTicker: "KXSILVER15M", enabled: true },
  { symbol: "COPPER", seriesTicker: "KXCOPPER15M", enabled: true },
  { symbol: "PLATINUM", seriesTicker: "KXPLATINUM15M", enabled: true },
  { symbol: "PALLADIUM", seriesTicker: "KXPALLADIUM15M", enabled: true },
  { symbol: "OIL", seriesTicker: "KXWTI15M", enabled: true },
  { symbol: "NATGAS", seriesTicker: "KXNATGAS15M", enabled: true },
];
