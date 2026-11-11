import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { HistoryPoint } from "../src/types/market.ts";
import { HISTORY_SECONDS, restoreHistory, validPoint } from "../src/lib/chartTimeline.ts";

// Independent of browser connections, including when all chart tabs are closed.
export class PriceHistory {
  private points = new Map<string, HistoryPoint[]>();

  constructor(private path?: string) {
    if (!path) return;
    try {
      const saved = JSON.parse(readFileSync(path, "utf8"));
      for (const [symbol, points] of Object.entries(saved)) {
        if (Array.isArray(points)) this.points.set(symbol, restoreHistory([], points, Date.now() / 1000));
      }
    } catch { /* A new installation starts collecting immediately. */ }
  }

  add(symbol: string, point: HistoryPoint) {
    if (!validPoint(point)) return;
    const history = this.points.get(symbol) ?? [];
    if (point.time < (history.at(-1)?.time ?? -Infinity)) return;
    history.push(point);
    this.points.set(symbol, history);
    this.trim(history, point.time);
  }

  private trim(history: HistoryPoint[], now: number) {
    let count = 0;
    while (count < history.length && history[count].time < now - HISTORY_SECONDS) count++;
    if (count) history.splice(0, count);
    return history;
  }

  get(symbol: string, now = Date.now() / 1000) {
    return this.trim(this.points.get(symbol) ?? [], now);
  }

  save() {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const snapshot = Object.fromEntries([...this.points.keys()].map(symbol => [symbol, this.get(symbol)]));
      writeFileSync(`${this.path}.tmp`, JSON.stringify(snapshot));
      renameSync(`${this.path}.tmp`, this.path);
    } catch (error) { console.warn("[history] Could not save chart history", error); }
  }
}
