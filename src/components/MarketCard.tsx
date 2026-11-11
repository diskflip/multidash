import type { SummaryStats } from "./MarketSummary";
import { AnimatePresence } from "motion/react";
import { AnimatedMarketCard } from "./AnimatedMarketCard";
import { useCanControl } from "../data/kalshi";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent, MouseEvent } from "react";
import { useMarket } from "../hooks/useMarket";
import { useQuickSell } from "../hooks/useQuickSell";
import { useCountdown } from "../hooks/useCountdown";
import { isMarketHot } from "../lib/marketHeat";
import { MarketChart } from "./MarketChart";
import { heatColor } from "../lib/heatColor";
import { playBuyInSound, playWinSound, playCountdownWarnSound } from "../lib/sounds";
import { formatPnl, pnlClass } from "../lib/format";
import { setBotBudget, setBotEnabled, BUDGET_MIN, BUDGET_MAX } from "../lib/botControl";
import { SYMBOL_COLOR } from "../lib/symbolColor";
import "./MarketCard.css";

function formatPrice(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)}`;
}

// Sign of positionFp says which side is held; magnitude is the contract count.
function formatContracts(positionFp: number): string {
  return `${Math.abs(positionFp).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${positionFp > 0 ? "YES" : "NO"}`;
}

// Tally counts that read as "full" green on the heat ramp — roughly the top
// of what a busy market scores in each rolling window. The 30m window is
// half as long, so half the count.
const SIM_1H_HEAT_MAX = 6;
const SIM_30M_HEAT_MAX = 3;

type MarketCardProps = {
  layoutKey: string;
  symbol: string;
  enabled: boolean;
  onToggle: (symbol: string) => void;
  onCloseTimeChange: (symbol: string, time: number | null) => void;
  onSummaryChange: (symbol: string, stats: SummaryStats) => void;
};

// Keep collecting data for the summary while the chart is hidden.
export const MarketCard = memo(function MarketCard({
  layoutKey,
  symbol,
  enabled,
  onToggle,
  onCloseTimeChange,
  onSummaryChange,
}: MarketCardProps) {
  const canControl = useCanControl();
  const [winning, setWinning] = useState(false);
  const [sim1hWinning, setSim1hWinning] = useState(false);
  const [sim30mWinning, setSim30mWinning] = useState(false);

  // Below 900px, cards start collapsed to bars-only (still tappable open).
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia("(min-width: 900px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 900px)");
    const onChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const [expanded, setExpanded] = useState(isDesktop);
  const {
    quickTrade,
    connected,
    currentYes,
    market,
    history,
    distanceHistory,
    events,
    resting,
    holding,
    pnlDollars,
    sim1hTally,
    sim1hFlash,
    sim30mTally,
    sim30mFlash,
    positionFp,
    costDollars,
    winFlash,
    buyInFlash,
    saleFlash,
    botEnabled,
    botBudget,
    botAllocation,
    flipPotential,
  } = useMarket(symbol);

  const hasPosition = holding || positionFp !== 0;
  const quickControl = useQuickSell(symbol, quickTrade, hasPosition && canControl && connected && !!market && market.ticker === quickTrade?.ticker);

  const score = flipPotential?.score ?? null;
  const hot = isMarketHot(sim30mTally, connected);
  useLayoutEffect(() => {
    onSummaryChange(symbol, { connected, enabled, currentYes, history, score, hot, sim30mTally, sim1hTally, resting, holding, positionFp, ticker: market?.ticker ?? null });
  }, [symbol, connected, enabled, currentYes, history, score, hot, sim30mTally, sim1hTally, resting, holding, positionFp, market?.ticker, onSummaryChange]);

  const visibleRef = useRef(enabled);
  visibleRef.current = enabled;

  const [pendingLive, setPendingLive] = useState<boolean | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const liveShown = pendingLive ?? botEnabled;
  const handleBotToggle = async (e: MouseEvent) => {
    e.stopPropagation();
    if (pendingLive !== null || botEnabled === null) return;
    const desired = !botEnabled;
    setPendingLive(desired);
    setLiveError(null);
    try { await setBotEnabled(symbol, desired); }
    catch (error) { setLiveError((error as Error).message); }
    finally { setPendingLive(null); }
  };

  // multibot's own live sizing when known, else the configured budget.
  const botDisplaySize = botAllocation ?? botBudget;

  // Click-to-edit bet size — tap to turn into a number input, Enter/blur
  // commits. cancelledEditRef stops Escape's unmount-triggered blur from
  // also committing.
  const [editingBudget, setEditingBudget] = useState(false);
  const [budgetInputValue, setBudgetInputValue] = useState("");
  const cancelledEditRef = useRef(false);

  const startEditingBudget = (e: MouseEvent) => {
    e.stopPropagation();
    if (!canControl) return;
    setBudgetInputValue(String(botDisplaySize ?? BUDGET_MIN));
    setEditingBudget(true);
  };

  const commitBudgetEdit = () => {
    setEditingBudget(false);
    if (cancelledEditRef.current) {
      cancelledEditRef.current = false;
      return;
    }
    const parsed = Math.round(Number(budgetInputValue));
    if (!Number.isFinite(parsed)) return;
    setBotBudget(symbol, Math.min(BUDGET_MAX, Math.max(BUDGET_MIN, parsed)));
  };

  const handleBudgetInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.currentTarget.blur();
    } else if (e.key === "Escape") {
      cancelledEditRef.current = true;
      e.currentTarget.blur();
    }
  };

  useEffect(() => {
    if (winFlash === null) return;
    setWinning(true);
    if (visibleRef.current) playWinSound();
    const t = setTimeout(() => setWinning(false), 2200);
    return () => clearTimeout(t);
  }, [winFlash]);

  useEffect(() => {
    if (saleFlash === null) return;
    setWinning(true);
    const timer = setTimeout(() => setWinning(false), 2200);
    return () => clearTimeout(timer);
  }, [saleFlash]);

  // Held separately from `winning` so the SOLD badge still has detail to
  // show for the full 2.2s even after winFlash moves on.
  const [soldDetail, setSoldDetail] = useState<{ side?: "yes" | "no"; priceCents?: number } | null>(null);
  useEffect(() => {
    if (winFlash === null) return;
    setSoldDetail({ side: winFlash.side, priceCents: winFlash.priceCents });
  }, [winFlash]);

  // Only flash on a win — losses happen far more often and would make the
  // badge flicker constantly.
  useEffect(() => {
    if (sim1hFlash === null || sim1hFlash.result !== "win") return;
    setSim1hWinning(true);
    const t = setTimeout(() => setSim1hWinning(false), 1400);
    return () => clearTimeout(t);
  }, [sim1hFlash]);

  useEffect(() => {
    if (sim30mFlash === null || sim30mFlash.result !== "win") return;
    setSim30mWinning(true);
    const t = setTimeout(() => setSim30mWinning(false), 1400);
    return () => clearTimeout(t);
  }, [sim30mFlash]);

  // A real fill expands the chart on desktop only — on mobile this yanked
  // whatever card you were looking at out from under you.
  //
  // isDesktop read from a ref, not a dependency — buyInFlash stays set for
  // as long as you're holding, so listing isDesktop replayed this sound on
  // any unrelated isDesktop flip with no new fill.
  const isDesktopRef = useRef(isDesktop);
  isDesktopRef.current = isDesktop;
  useEffect(() => {
    if (buyInFlash === null) return;
    if (visibleRef.current) playBuyInSound();
    if (isDesktopRef.current) setExpanded(true);
  }, [buyInFlash]);

  // Heads-up that this market's window is closing while holding — per-market
  // and gated on actually holding, not the shared header clock.
  const { remainingSeconds } = useCountdown(enabled ? market?.closeTime ?? null : null);
  const warnFiredRef = useRef<Set<number>>(new Set());
  const warnCloseTimeRef = useRef<number | null>(null);
  if (warnCloseTimeRef.current !== (market?.closeTime ?? null)) {
    warnCloseTimeRef.current = market?.closeTime ?? null;
    warnFiredRef.current = new Set();
  }
  useEffect(() => {
    if (!holding || remainingSeconds === null) return;
    for (const threshold of [180, 120, 60]) {
      if (remainingSeconds <= threshold && !warnFiredRef.current.has(threshold)) {
        warnFiredRef.current.add(threshold);
        playCountdownWarnSound();
      }
    }
  }, [holding, remainingSeconds]);

  useEffect(() => {
    onCloseTimeChange(symbol, market?.closeTime ?? null);
  }, [symbol, market?.closeTime, onCloseTimeChange]);

  const currentNo = currentYes === null ? null : 100 - currentYes;

  // Mark-to-market against the live price.
  const unrealizedDollars =
    positionFp !== 0 && currentYes !== null && currentNo !== null
      ? (positionFp > 0 ? positionFp * (currentYes / 100) : -positionFp * (currentNo / 100)) -
        costDollars
      : null;

  return (
    <AnimatePresence initial={false} mode="popLayout">
    {enabled && <AnimatedMarketCard
      key={symbol}
      symbol={symbol}
      layoutKey={layoutKey}
      horizontal={isDesktop}
      className={`market-bar ${enabled ? "" : "disabled"} ${
        enabled && winning
          ? "state-sold"
          : enabled && holding
            ? "state-holding"
            : enabled && resting
              ? "state-resting"
              : ""
      }`}
      onClick={() => {
        if (enabled) setExpanded((e) => !e);
      }}
    >
      <div className="bar-row">
        <div className="bar-identity">
          <div className="bar-symbol-row">
            <span className="market-symbol" style={{ color: SYMBOL_COLOR[symbol] }}>{symbol}</span>
          </div>
          {enabled && (
            <div className="bar-yesno">
              <span className="bar-yesno-price yes">{formatPrice(currentYes)}</span>
              <span className="bar-yesno-slash">/</span>
              <span className="bar-yesno-price no">{formatPrice(currentNo)}</span>
            </div>
          )}
          {!enabled && <span className="bar-paused">Paused</span>}
        </div>
        <div className="bar-row-right">
          {/* Always rendered (reserved min-width, see .order-badges) —
              popping in/out changed how much room this row needed. */}
          {enabled && (
            <div className="order-badges">
              {winning ? (
                <span className="order-badge sold">
                  SOLD{soldDetail?.side ? ` ${soldDetail.side.toUpperCase()}` : ""}
                  {soldDetail?.priceCents !== undefined ? ` @ ${soldDetail.priceCents}c` : ""}
                </span>
              ) : hasPosition ? (
                <span className="order-badge holding" aria-label="Held contracts">
                  {positionFp !== 0 ? formatContracts(positionFp) : "HOLDING"}
                </span>
              ) : resting ? (
                <span className="order-badge resting">RESTING</span>
              ) : null}
            </div>
          )}
          {/* Stacked below the badge, not beside it, so the badge only ever
              adds height here, never width. */}
          <div className="bar-row-right-bottom">
            {enabled && (
              <span className={`bar-pnl ${pnlClass(pnlDollars)}`}>{formatPnl(pnlDollars)}</span>
            )}
            <button
              type="button"
              className={`toggle-switch ${enabled ? "on" : ""}`}
              role="switch"
              aria-checked={enabled}
              aria-label={`${enabled ? "Pause" : "Resume"} ${symbol}`}
              onClick={(e) => {
                e.stopPropagation();
                onToggle(symbol);
              }}
            >
              <span className="toggle-knob" />
            </button>
          </div>
        </div>
      </div>

      {enabled && expanded && (
        <MarketChart
          symbol={symbol}
          history={history}
          distanceHistory={distanceHistory}
          events={events}
          currentYes={currentYes}
          market={market}
          unrealizedDollars={holding ? unrealizedDollars : null}
          heldContracts={hasPosition ? (positionFp !== 0 ? formatContracts(positionFp) : "HOLDING") : null}
          score={connected ? score : null}
          orientation={isDesktop ? "vertical" : "horizontal"}
        />
      )}

      {enabled && (
        <div className="bar-footer">
          {/* Controls the live bot — see ../lib/botControl. */}
          <div className="bar-bot-controls">
            <button
              type="button"
              className={`toggle-switch live-bot-switch ${liveShown === true ? "on" : ""}`}
              disabled={!canControl || botEnabled === null || pendingLive !== null}
              role="switch"
              aria-label={`Automated betting for ${symbol}`}
              aria-checked={liveShown === true}
              aria-busy={pendingLive !== null}
              onClick={handleBotToggle}
            >
              <span className="toggle-knob" />
            </button>
            {hasPosition && <button
              type="button"
              className="bot-toggle-btn manual-trade-btn sell"
              disabled={quickControl.disabled}
              aria-label={`${symbol} SELL`}
              aria-description={quickControl.error ?? undefined}
              aria-busy={quickControl.pending}
              onClick={(e) => { e.stopPropagation(); void quickControl.submit(); }}
            >
              {quickControl.error ? "RETRY" : "SELL"}
            </button>}
            {editingBudget ? (
              <input
                type="number"
                className="bot-size-input"
                value={budgetInputValue}
                min={BUDGET_MIN}
                max={BUDGET_MAX}
                autoFocus
                onFocus={(e) => e.target.select()}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setBudgetInputValue(e.target.value)}
                onKeyDown={handleBudgetInputKeyDown}
                onBlur={commitBudgetEdit}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span
                className="bot-size-value"
                onClick={canControl ? startEditingBudget : undefined}
              >
                {botDisplaySize !== null ? `$${botDisplaySize}` : "—"}
              </span>
            )}
          </div>
          {/* 1 point per winning flip (6c->50c or 20c->80c), two rolling windows. */}
          <span className="bar-pnl-sim-row">
            <span className="bar-pnl-sim-item">
              <span className="bar-pnl-sim-label">1hr</span>
              <span
                className={`bar-pnl-sim-value tally ${sim1hWinning ? "flash" : ""}`}
                style={sim1hWinning ? undefined : { color: heatColor(sim1hTally / SIM_1H_HEAT_MAX) }}
              >
                {sim1hTally}
              </span>
            </span>
            <span className="bar-pnl-sim-item">
              <span className="bar-pnl-sim-label">30m</span>
              <span
                className={`bar-pnl-sim-value tally ${sim30mWinning ? "flash" : ""}`}
                style={sim30mWinning ? undefined : { color: heatColor(sim30mTally / SIM_30M_HEAT_MAX) }}
              >
                {sim30mTally}
              </span>
            </span>
          </span>
          {liveError && <span className="live-control-error" role="alert">{liveError}</span>}
        </div>
      )}
    </AnimatedMarketCard>}
    </AnimatePresence>
  );
});
