export const MARKET_GROUPS = [
  { name: 'Crypto', symbols: ['BTC', 'ETH', 'DOGE', 'SOL', 'ZEC', 'NEAR'] },
  { name: 'Metals', symbols: ['GOLD', 'SILVER', 'COPPER', 'PLATINUM', 'PALLADIUM'] },
  { name: 'Energy', symbols: ['OIL', 'NATGAS'] },
];
export const SUMMARY_SYMBOLS = MARKET_GROUPS.flatMap(group => group.symbols);
export const CRYPTO_SYMBOLS = MARKET_GROUPS[0].symbols;

export const AUTO_SYMBOLS = SUMMARY_SYMBOLS;
