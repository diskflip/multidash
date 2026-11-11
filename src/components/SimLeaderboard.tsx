import { SYMBOL_COLOR } from "../lib/symbolColor";
import type { LeaderboardRow } from "../types/market";
import "./SimLeaderboard.css";

export function SimLeaderboard({ symbols, rows, className = "" }: { symbols: string[]; rows: LeaderboardRow[]; className?: string }) {
  const bySymbol = new Map(rows.map(row => [row.symbol, row]));
  const ranked = symbols.map(symbol => ({ symbol, profitDollars: bySymbol.get(symbol)?.profitDollars ?? null }))
    .filter(row => row.profitDollars !== null && row.profitDollars > 0)
    .sort((a, b) => (b.profitDollars ?? -Infinity) - (a.profitDollars ?? -Infinity));
  return <section className={`sim-leaderboard ${className}`} aria-label="Simulated profit leaderboard, last 30 minutes">
    <h2 className="sidebar-panel-title">SIM</h2>
    <ol className="leaderboard-rows">
      {ranked.map(row => <li key={row.symbol} data-leaderboard-symbol={row.symbol}>
        <span style={{ color: SYMBOL_COLOR[row.symbol] }}>{row.symbol}</span>
        <strong className={row.profitDollars == null || row.profitDollars === 0 ? "" : row.profitDollars > 0 ? "positive" : "negative"}>
          {row.profitDollars == null ? "—" : `${Math.round(row.profitDollars) > 0 ? "+" : Math.round(row.profitDollars) < 0 ? "−" : ""}${Math.abs(Math.round(row.profitDollars))}`}
        </strong>
      </li>)}
    </ol>
  </section>;
}
