import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RESET_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), ".pnl-reset.json");

export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// The server's own local midnight, not UTC — Kalshi's settlement times are
// UTC, but "today" is a local-calendar concept. UTC midnight pulled in
// extra hours still the previous evening locally.
export function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// "Everything settled since this cutoff", normally local midnight.
// resetPnlNow() moves it forward on demand; persisted so it survives a restart.
export function getPnlSince(): Date {
  try {
    const { since } = JSON.parse(fs.readFileSync(RESET_FILE, "utf8"));
    return new Date(since);
  } catch {
    return startOfLocalDay(new Date());
  }
}

export function resetPnlNow(): Date {
  const now = new Date();
  fs.writeFileSync(RESET_FILE, JSON.stringify({ since: now.toISOString() }));
  return now;
}
