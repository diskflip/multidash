// Paper-trades a configurable dip-buy/take-profit strategy against a
// market's live price feed — session-only, no real money or orders
// involved. A side touching entryCents arms it; touching exitCents while
// armed resolves it as a win.
type Side = {
  armed: boolean;
  entryCents: number | null;
};

// See currentCloseTimeMs above.
const QUIET_BEFORE_CLOSE_MS = 3_000;

export type SimTrade = {
  side: "yes" | "no";
  result: "win" | "loss";
  entryCents: number;
  profitDollars: number;
  time: number; // unix seconds
};

export class SimTracker {
  private yes: Side = { armed: false, entryCents: null };
  private no: Side = { armed: false, entryCents: null };
  private currentTicker: string | null = null;
  // Ticks before this timestamp are ignored — a freshly-opened market's
  // book is thin/empty for a moment, so its first prints can read as a
  // false 0 or 100 before real quotes arrive. See onMarketChange.
  private settledAtMs = 0;
  // Mirrors FlipTracker's close-side guard: a market's final ticks before
  // (and especially after, if the scheduled rollover straggles behind a
  // network hiccup) its actual close often swing hard toward 0 or 100 as
  // liquidity dries up and the outcome resolves. Ticks from
  // currentCloseTimeMs - QUIET_BEFORE_CLOSE_MS onward are ignored — and
  // since this only advances in onMarketChange, a rollover that's late by
  // even 15-30s (a real observed case: a burst of failed Kalshi REST
  // lookups left one market's ticker stale while its siblings switched on
  // time) stays fully guarded for the whole straggle, not just a fixed
  // window, instead of the stale ticker's settlement snap getting read as
  // a real win.
  private currentCloseTimeMs: number | null = null;
  private totalDollars = 0;
  private wins = 0;
  private losses = 0;
  private lastTrade: SimTrade | null = null;
  // Trimmed to the rolling window every time snapshot() is read.
  private trades: SimTrade[] = [];

  constructor(
    private readonly entryCents = 6,
    private readonly exitCents = 95,
    private readonly betDollars = 1,
    private readonly windowSeconds = 3600,
    private readonly settleMs = 5_000,
  ) {}

  // A position still armed at rollover never hit its exit — same as being
  // held to expiry without a take-profit: the bet is lost. The new
  // market's own ticks are then held back for settleMs so an empty/thin
  // opening book can't arm a position off a stale or one-sided print that
  // hasn't seen real quotes yet — that noise was resolving as false wins
  // once the book populated and the price snapped to its real level.
  //
  // ticker is null when the series has no current or upcoming window (a
  // paused/closed market, e.g. SILVER overnight or on weekends) — a
  // closing market's final ticks often swing hard toward 0 or 100 as the
  // outcome settles, and with no next ticker to roll into, those ticks
  // would otherwise keep being read as live trading data indefinitely.
  // closeTimeMs drives the pre-close guard (see QUIET_BEFORE_CLOSE_MS
  // above); pass null when ticker is null.
  onMarketChange(ticker: string | null, closeTimeMs: number | null = null) {
    this.currentCloseTimeMs = closeTimeMs;
    if (ticker === this.currentTicker) return;
    if (this.yes.armed) this.resolve("yes", "loss", this.yes.entryCents!);
    if (this.no.armed) this.resolve("no", "loss", this.no.entryCents!);
    this.currentTicker = ticker;
    this.settledAtMs = Date.now() + this.settleMs;
  }

  // Returns true if a trade just resolved, so the caller can rebroadcast.
  onPrice(yesCents: number): boolean {
    if (!this.currentTicker) return false;
    if (Date.now() < this.settledAtMs) return false;
    if (this.currentCloseTimeMs !== null && Date.now() >= this.currentCloseTimeMs - QUIET_BEFORE_CLOSE_MS) {
      return false;
    }
    const noCents = 100 - yesCents;
    let resolved = false;

    if (!this.yes.armed && yesCents > 0 && yesCents <= this.entryCents) {
      this.yes = { armed: true, entryCents: yesCents };
    } else if (this.yes.armed && yesCents >= this.exitCents) {
      this.resolve("yes", "win", this.yes.entryCents!);
      resolved = true;
    }

    // At exitCents <= 50, yesCents and noCents can both cross the exit
    // threshold on the same tick (they sum to 100) — `!resolved` caps it
    // to one win per tick instead of double-counting.
    if (!this.no.armed && noCents > 0 && noCents <= this.entryCents) {
      this.no = { armed: true, entryCents: noCents };
    } else if (!resolved && this.no.armed && noCents >= this.exitCents) {
      this.resolve("no", "win", this.no.entryCents!);
      resolved = true;
    }

    return resolved;
  }

  private resolve(side: "yes" | "no", result: "win" | "loss", entryCents: number) {
    const profitDollars =
      result === "win" ? this.betDollars * (this.exitCents / entryCents - 1) : -this.betDollars;
    this.totalDollars += profitDollars;
    if (result === "win") this.wins++;
    else this.losses++;
    this.lastTrade = {
      side,
      result,
      entryCents,
      profitDollars,
      time: Math.floor(Date.now() / 1000),
    };
    this.trades.push(this.lastTrade);
    if (side === "yes") this.yes = { armed: false, entryCents: null };
    else this.no = { armed: false, entryCents: null };
  }

  // Armed positions are left alone; only the tally resets.
  reset() {
    this.totalDollars = 0;
    this.wins = 0;
    this.losses = 0;
    this.lastTrade = null;
    this.trades = [];
  }

  snapshot() {
    const cutoff = Math.floor(Date.now() / 1000) - this.windowSeconds;
    this.trades = this.trades.filter((t) => t.time >= cutoff);
    const windowDollars = this.trades.reduce((sum, t) => sum + t.profitDollars, 0);
    const windowWins = this.trades.reduce((sum, t) => sum + (t.result === "win" ? 1 : 0), 0);
    return {
      totalDollars: this.totalDollars,
      windowDollars,
      windowWins,
      wins: this.wins,
      losses: this.losses,
      lastTrade: this.lastTrade,
    };
  }
}
