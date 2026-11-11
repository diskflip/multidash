import { MARKET_GROUPS } from "../lib/marketGroups";
import { memo, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { LeaderboardRow } from "../types/market";
import type { MarketState } from "../hooks/useMarket";
import { heatColor } from "../lib/heatColor";
import { groupHeatLevel, marketActivity15m } from "../lib/marketHeat";
import { marketNow } from "../lib/marketClock";
import { SYMBOL_COLOR } from "../lib/symbolColor";
import "./MarketSummary.css";

export type SummaryStats = Pick<MarketState, "connected" | "currentYes" | "history" | "sim30mTally" | "sim1hTally" | "resting" | "holding" | "positionFp"> & {
  score: number | null;
  hot?: boolean;
  enabled: boolean;
  ticker: string | null;
};

type Props = {
  symbols: string[];
  leaderboard: LeaderboardRow[];
  stats: Record<string, SummaryStats>;
  visible: Record<string, boolean>;
  onToggle: (symbol: string) => void;
};

export const MarketSummary = memo(function MarketSummary({ symbols, stats, visible, onToggle, leaderboard }: Props) {
  const [, refreshActivity] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => refreshActivity(value => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const leaderboardBySymbol = new Map(leaderboard.map(row => [row.symbol, row]));
  const simWinners = new Set(leaderboard.filter(row => row.wins > 0).map(row => row.symbol));
  return (
    <aside className="market-summary" aria-label="All markets summary" style={{ "--summary-count": symbols.length } as CSSProperties}>
      {MARKET_GROUPS.map(group => ({...group, symbols: group.symbols.filter(symbol => symbols.includes(symbol))})).filter(group => group.symbols.length).map(group => {
        const activityRows = group.symbols
          .map(symbol => stats[symbol])
          .filter((row): row is SummaryStats => !!row)
          .map(row => marketActivity15m(row.history, marketNow()))
          .filter(row => row.available);
        const activity = activityRows.length ? activityRows.reduce((sum, row) => sum + row.movement, 0) / activityRows.length : 0;
        const simRows = group.symbols.map(symbol => leaderboardBySymbol.get(symbol)).filter(row => row !== undefined);
        const simWins30m = simRows.reduce((sum, row) => sum + row.wins, 0);
        const simProfit30m = simRows.reduce((sum, row) => sum + row.profitDollars, 0);
        const level = groupHeatLevel(activity, simWins30m, simProfit30m);
        const simProfitLabel = simProfit30m < 0 ? `-$${Math.abs(simProfit30m).toFixed(2)}` : `+$${simProfit30m.toFixed(2)}`;
        return (
          <section className="summary-section" key={group.name} aria-label={group.name}>
            <h3 className={`summary-section-title summary-section-title--${group.name.toLowerCase()}`}>
              {group.name}
              <span className={`summary-section-heat summary-section-heat--${level}`} role="img"
                aria-label={`${group.name} activity: ${level.replaceAll("-", " ")}, ${simWins30m} 30-minute sim wins, ${simProfitLabel} sim profit`} />
            </h3>
            <div className="summary-rows">
              {group.symbols.map((symbol) => {
                const row = stats[symbol];
                const price = row?.connected ? row.currentYes : null;
                const score = row?.connected ? row.score : null;
                const display = symbol;
                return (
                  <button type="button" className={`summary-row ${row?.hot ? `is-hot ${simWinners.has(symbol) ? "is-legendary" : ""}` : ""} ${visible[symbol] ? "" : "is-hidden"}`}
                    key={symbol} data-summary-symbol={symbol} aria-pressed={visible[symbol]}
                    aria-label={`${visible[symbol] ? "Hide" : "Show"} ${display} chart`}
                    onClick={() => onToggle(symbol)}>
                    <span className="summary-main">
                      <span className="summary-symbol" style={{ color: SYMBOL_COLOR[symbol] }}>{display}</span>
                      <span className={`summary-score ${score != null && score > 5 ? "is-high-score" : ""}`} aria-label="Flip potential, 1–10" style={score == null ? undefined : { color: heatColor((score - 1) / 9) }}>{score == null ? "—" : Math.round(score)}</span>
                    </span>
                    <span className="summary-bottom">
                      <span className="summary-price" aria-label="YES and NO prices in cents">
                        <span className="summary-yes">{price == null ? "—" : Math.round(price)}</span>
                        <span className="summary-divider">/</span>
                        <span className="summary-no">{price == null ? "—" : Math.round(100 - price)}</span>
                      </span>
                      <span className="summary-flips" aria-label="30-minute / 1-hour flips">
                        <span className="summary-flips-30m" style={row ? { color: heatColor(row.sim30mTally / 3) } : undefined}>{row?.sim30mTally ?? "—"}</span>
                        <span className="summary-divider">/</span>
                        <span className="summary-flips-1h" style={row ? { color: heatColor(row.sim1hTally / 6) } : undefined}>{row?.sim1hTally ?? "—"}</span>
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
    </aside>
  );
});
