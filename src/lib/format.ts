export function formatPnl(dollars: number): string {
  const sign = dollars > 0 ? "+" : dollars < 0 ? "-" : "";
  return `${sign}$${Math.abs(dollars).toFixed(2)}`;
}

export function pnlClass(dollars: number): string {
  if (dollars > 0) return "positive";
  if (dollars < 0) return "negative";
  return "";
}
