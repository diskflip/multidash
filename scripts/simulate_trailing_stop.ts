// Backtests a trailing-stop exit against real closed BTC trades:
// after the held side's bid crosses ARM_CENTS, track its peak; if the bid
// falls DRAWDOWN_CENTS below that peak, exit immediately at the fallen
// price, as long as it's still above MIN_EXIT_CENTS.
//
// Data limitation: Kalshi's public candle history is 1-minute bars, with
// each bar's bid high/low (not just close). There is no public sub-minute
// history, so "falls 15c for 1 second" is approximated as "the bid's low
// within a minute touches peak-15c" — a real 1-second dip anywhere in that
// minute would satisfy this, but so would a implausibly brief wick that
// might not have actually been executable for a full second. Treat the
// results as directional, not exact.
import { readFileSync } from "node:fs";
import { accountReportPath } from "./privateData.ts";

const ARM_CENTS = 30;
const DRAWDOWN_CENTS = 15;
const MIN_EXIT_CENTS = 10;

type Trade = {
  ticker: string;
  side: "yes" | "no";
  entryFillTime: string;
  entryPriceCents: number;
  entryCountContracts: number;
  entryFeeDollars: number;
  outcome: "win" | "loss";
  pnlDollars: number;
};

type Candle = {
  t: number;
  yesBidHigh: number;
  yesBidLow: number;
  yesBidClose: number;
  yesAskHigh: number;
  yesAskLow: number;
  yesAskClose: number;
};

function heldSideBid(c: Candle, side: "yes" | "no") {
  if (side === "yes") return { high: c.yesBidHigh, low: c.yesBidLow };
  // NO bid = 100 - YES ask; high/low invert under that subtraction.
  return { high: 100 - c.yesAskLow, low: 100 - c.yesAskHigh };
}

type SimResult =
  | { fired: false; reason: "never_armed" | "no_trigger" | "trigger_below_min" }
  | { fired: true; exitPriceCents: number; peakCents: number };

function simulate(trade: Trade, candles: Candle[]): SimResult {
  const entryTs = new Date(trade.entryFillTime).getTime() / 1000;
  const relevant = candles.filter((c) => c.t >= entryTs).sort((a, b) => a.t - b.t);

  let armed = false;
  let peak = 0;

  for (const c of relevant) {
    const { high, low } = heldSideBid(c, trade.side);
    if (!Number.isFinite(high) || !Number.isFinite(low)) continue;

    if (!armed) {
      if (high >= ARM_CENTS) {
        armed = true;
        peak = high;
      } else {
        continue;
      }
    } else {
      peak = Math.max(peak, high);
    }

    const triggerLevel = peak - DRAWDOWN_CENTS;
    if (low <= triggerLevel) {
      if (triggerLevel > MIN_EXIT_CENTS) {
        return { fired: true, exitPriceCents: triggerLevel, peakCents: peak };
      }
      return { fired: false, reason: "trigger_below_min" };
    }
  }

  return { fired: false, reason: armed ? "no_trigger" : "never_armed" };
}

async function main() {
  const tradesFile = process.argv[2] ?? accountReportPath("btc_trades_clean.json");
  const candlesFile = process.argv[3] ?? accountReportPath("btc_full_life_candles.json");
  const daysBack = Number(process.argv[4] ?? 5);

  const allTrades: Trade[] = JSON.parse(readFileSync(tradesFile, "utf8"));
  const candlesByTicker: Record<string, Candle[]> = JSON.parse(readFileSync(candlesFile, "utf8"));

  const cutoff = Date.now() - daysBack * 24 * 60 * 60 * 1000;
  const trades = allTrades.filter((t) => new Date(t.entryFillTime).getTime() >= cutoff);
  const losses = trades.filter((t) => t.outcome === "loss");

  console.log(`Trades in last ${daysBack} days: ${trades.length} (${losses.length} losses, ${trades.length - losses.length} wins)`);

  let neverArmed = 0;
  let noTrigger = 0;
  let triggerBelowMin = 0;
  let rescued = 0;
  let totalRescuedGainDollars = 0;
  const rescuedRows: any[] = [];

  for (const t of losses) {
    const candles = candlesByTicker[t.ticker];
    if (!candles || candles.length === 0) continue;

    const result = simulate(t, candles);
    if (!result.fired) {
      if (result.reason === "never_armed") neverArmed++;
      else if (result.reason === "no_trigger") noTrigger++;
      else triggerBelowMin++;
      continue;
    }

    const entryCostDollars = (t.entryPriceCents / 100) * t.entryCountContracts;
    const grossProceeds = (result.exitPriceCents / 100) * t.entryCountContracts;
    const simPnl = grossProceeds - entryCostDollars - t.entryFeeDollars;
    const actualPnl = t.pnlDollars;
    const gain = simPnl - actualPnl;

    rescued++;
    totalRescuedGainDollars += gain;
    rescuedRows.push({
      ticker: t.ticker,
      side: t.side,
      entryPriceCents: t.entryPriceCents,
      peakCents: Math.round(result.peakCents * 10) / 10,
      exitPriceCents: Math.round(result.exitPriceCents * 10) / 10,
      actualPnl: Math.round(actualPnl * 100) / 100,
      simPnl: Math.round(simPnl * 100) / 100,
      gain: Math.round(gain * 100) / 100,
    });
  }

  console.log(`\nOf ${losses.length} losing trades:`);
  console.log(`  never crossed ${ARM_CENTS}c (rule never armed): ${neverArmed}`);
  console.log(`  armed but bid never fell ${DRAWDOWN_CENTS}c from peak: ${noTrigger}`);
  console.log(`  would have triggered, but fallen price was <= ${MIN_EXIT_CENTS}c (skipped): ${triggerBelowMin}`);
  console.log(`  rescued by the new rule: ${rescued}`);
  console.log(`\nTotal $ gained across rescued trades: $${totalRescuedGainDollars.toFixed(2)}`);
  console.log(`Average gain per rescued trade: $${(totalRescuedGainDollars / (rescued || 1)).toFixed(2)}`);

  console.log(`\nRescued trade detail:`);
  for (const r of rescuedRows.sort((a, b) => b.gain - a.gain)) {
    console.log(
      `  ${r.ticker} (${r.side}) entry ${r.entryPriceCents}c -> peak ${r.peakCents}c -> exit ${r.exitPriceCents}c | actual $${r.actualPnl} -> sim $${r.simPnl} (+$${r.gain})`
    );
  }
}

main();
