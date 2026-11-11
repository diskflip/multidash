// A "flip" is a side trading down to LOW_CENTS and later back up to
// HIGH_CENTS within the same 15m market window.
const LOW_CENTS = 6;
const HIGH_CENTS = 85;
const ONE_HOUR_SECONDS = 3600;
const RETENTION_SECONDS = ONE_HOUR_SECONDS * 2;
// A market's final ticks before its window actually closes often swing
// hard toward 0 or 100 as the outcome becomes certain and liquidity dries
// up (documented elsewhere in this codebase — see SimTracker's settleMs
// guard on the open side, and pauseMarket's comment on the same close-side
// behavior) — that settlement snap can round-trip through both LOW_CENTS
// and HIGH_CENTS in the space of one or two ticks and get counted as a
// real flip when it's really just the market resolving. Ticks in the
// final QUIET_BEFORE_CLOSE_MS before close are ignored entirely (armed
// state just freezes) rather than risk counting that noise.
const QUIET_BEFORE_CLOSE_MS = 3_000;

type FlipEvent = {
  side: "yes" | "no";
  time: number;
  ticker: string;
};

export class FlipTracker {
  private armedYes = false;
  private armedNo = false;
  private currentTicker: string | null = null;
  private previousTicker: string | null = null;
  private currentCloseTimeMs: number | null = null;
  private events: FlipEvent[] = [];

  // ticker is null when the series has no current or upcoming window (a
  // paused/closed market) — see SimTracker.onMarketChange for why that
  // needs to stop this tracker the same as a normal rollover would.
  // closeTimeMs drives the pre-close quiet window (see QUIET_BEFORE_CLOSE_MS
  // above); pass null when ticker is null.
  onMarketChange(ticker: string | null, closeTimeMs: number | null = null) {
    this.currentCloseTimeMs = closeTimeMs;
    if (ticker === this.currentTicker) return;
    this.previousTicker = this.currentTicker;
    this.currentTicker = ticker;
    this.armedYes = false;
    this.armedNo = false;
  }

  onPrice(yes: number): boolean {
    if (!this.currentTicker) return false;
    if (this.currentCloseTimeMs !== null && Date.now() >= this.currentCloseTimeMs - QUIET_BEFORE_CLOSE_MS) {
      return false;
    }
    const no = 100 - yes;
    let flipped = false;

    if (yes <= LOW_CENTS) this.armedYes = true;
    if (this.armedYes && yes >= HIGH_CENTS) {
      this.record("yes");
      this.armedYes = false;
      flipped = true;
    }

    if (no <= LOW_CENTS) this.armedNo = true;
    if (this.armedNo && no >= HIGH_CENTS) {
      this.record("no");
      this.armedNo = false;
      flipped = true;
    }

    return flipped;
  }

  private record(side: "yes" | "no") {
    if (!this.currentTicker) return;
    this.events.push({ side, time: Math.floor(Date.now() / 1000), ticker: this.currentTicker });
    const cutoff = Math.floor(Date.now() / 1000) - RETENTION_SECONDS;
    while (this.events.length > 0 && this.events[0].time < cutoff) {
      this.events.shift();
    }
  }

  countLastHour(): number {
    const cutoff = Math.floor(Date.now() / 1000) - ONE_HOUR_SECONDS;
    return this.events.filter((e) => e.time >= cutoff).length;
  }

  countLastCompletedWindow(): number {
    if (!this.previousTicker) return 0;
    const ticker = this.previousTicker;
    return this.events.filter((e) => e.ticker === ticker).length;
  }
}
