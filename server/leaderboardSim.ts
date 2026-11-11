import type { HistoryPoint } from "../src/types/market.ts";
import { validPoint } from "../src/lib/chartTimeline.ts";

type Trade = { time: number; profit: number; ticker: string | null; side: "yes" | "no" | null; entryTime: number | null };
export type LeaderboardState = {
  lastTime: number;
  ticker: string | null;
  closeTime: number;
  side: "yes" | "no" | null;
  entryTime: number | null;
  trades: Trade[];
};

// Independent paper strategy: fixed $5 stake, theoretical fills at 7c/94c,
// either side, one open position per market, no fees or compounding.
export class LeaderboardSim {
  state: LeaderboardState = { lastTime: 0, ticker: null, closeTime: 0, side: null, entryTime: null, trades: [] };

  constructor(saved?: LeaderboardState) {
    if (saved && Number.isFinite(saved.lastTime) && Number.isFinite(saved.closeTime) &&
        (saved.ticker === null || typeof saved.ticker === "string") &&
        [null, "yes", "no"].includes(saved.side) && Array.isArray(saved.trades) &&
        (saved.entryTime === null || Number.isFinite(saved.entryTime)) &&
        saved.trades.every(t => Number.isFinite(t.time) && Number.isFinite(t.profit))) this.state = saved;
  }

  onPrice(point: HistoryPoint) {
    if (!validPoint(point) || point.time <= this.state.lastTime) return;
    this.expire(point.time);
    if (point.ticker !== this.state.ticker) {
      // Never carry an entry into another contract.
      if (this.state.side) this.resolve(this.state.closeTime, -5);
      this.state.ticker = point.ticker;
      this.state.closeTime = point.closeTime;
    }
    this.state.lastTime = point.time;
    // Opening books can briefly show extreme quotes before normal liquidity
    // arrives. Match the existing paper trackers' five-second opening guard,
    // using source time so replay and live processing give identical results.
    if (point.time < point.openTime + 5) return;
    if (this.state.side) {
      const price = this.state.side === "yes" ? point.yes : 100 - point.yes;
      if (price >= 94) this.resolve(point.time, 5 * (94 / 7 - 1));
    }
    if (!this.state.side) {
      if (point.yes > 0 && point.yes <= 7) this.state.side = "yes";
      else if (point.yes < 100 && point.yes >= 93) this.state.side = "no";
      if (this.state.side) this.state.entryTime = point.time;
    }
  }

  expire(now: number) {
    if (this.state.side && now >= this.state.closeTime) {
      this.resolve(this.state.closeTime, -5);
      this.state.lastTime = Math.max(this.state.lastTime, this.state.closeTime);
    }
  }

  private resolve(time: number, profit: number) {
    this.state.trades.push({ time, profit, ticker: this.state.ticker, side: this.state.side, entryTime: this.state.entryTime });
    this.state.side = null;
    this.state.entryTime = null;
  }

  snapshot(now: number) {
    this.expire(now);
    this.state.trades = this.state.trades.filter(trade => trade.time > now - 1800);
    const trades = this.state.trades.filter(trade => trade.time <= now);
    return {
      profitDollars: Math.round(trades.reduce((sum, trade) => sum + trade.profit, 0) * 100) / 100,
      wins: trades.filter(trade => trade.profit > 0).length,
      losses: trades.filter(trade => trade.profit < 0).length,
    };
  }
}
