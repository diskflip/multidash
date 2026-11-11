import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { LeaderboardSim, type LeaderboardState } from "./leaderboardSim.ts";
import type { HistoryPoint } from "../src/types/market.ts";

export class LeaderboardStore {
  private sims = new Map<string, LeaderboardSim>();
  constructor(private path: string, symbols: string[], history: (symbol: string) => HistoryPoint[]) {
    let saved: Record<string, LeaderboardState> = {};
    try { saved = JSON.parse(readFileSync(path, "utf8")); } catch { /* First run. */ }
    for (const symbol of symbols) {
      const sim = new LeaderboardSim(saved?.[symbol]);
      for (const point of history(symbol)) sim.onPrice(point);
      this.sims.set(symbol, sim);
    }
  }
  onPrice(symbol: string, point: HistoryPoint) { this.sims.get(symbol)?.onPrice(point); }
  message(now = Date.now() / 1000) {
    return { type: "leaderboard" as const, rows: [...this.sims].map(([symbol, sim]) => ({ symbol, ...sim.snapshot(now) })) };
  }
  save() {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(`${this.path}.tmp`, JSON.stringify(Object.fromEntries([...this.sims].map(([symbol, sim]) => [symbol, sim.state]))));
      renameSync(`${this.path}.tmp`, this.path);
    } catch (error) { console.warn("[leaderboard] Could not save paper history", error); }
  }
}
