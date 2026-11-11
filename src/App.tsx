import { MarketSummary, type SummaryStats } from "./components/MarketSummary";
import { SimLeaderboard } from "./components/SimLeaderboard";
import { JevPanel } from "./components/JevPanel";
import { useJev } from "./hooks/useJev";
import type { LeaderboardRow } from "./types/market";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { MarketCard } from "./components/MarketCard";
import { Countdown } from "./components/Countdown";
import { HoverSyncProvider } from "./hooks/useHoverSync";
import { isMuted, setMuted, playWinSound, isAudioUnlocked, onAudioUnlock } from "./lib/sounds";
import { connectToBackend, sendToBackend, useCanControl } from "./data/kalshi";
import { MARKETS as ALL_MARKETS } from "../markets.config";
import { hasActiveOrder } from "./lib/focusMarkets";
import { LayoutGroup, motion } from "motion/react";
import { autoRefreshSeconds } from "./lib/autoRefreshInterval";
import { marketNow } from "./lib/marketClock";
import { AutoMarkets } from "./lib/autoMarkets";
import "./App.css";

import { SUMMARY_SYMBOLS, AUTO_SYMBOLS } from "./lib/marketGroups";
const MARKETS = ALL_MARKETS.filter(market => SUMMARY_SYMBOLS.includes(market.symbol));
const FOCUS_KEY = "flip-monitor:focus";
const VISIBLE_MARKETS_KEY = "flip-monitor:visible-markets";
function loadVisibleMarkets(): Record<string, boolean> {
  const defaults = Object.fromEntries(MARKETS.map((market) => [market.symbol, market.enabled]));
  try {
    const saved = JSON.parse(localStorage.getItem(VISIBLE_MARKETS_KEY) ?? "null");
    if (saved && typeof saved === "object") {
      for (const symbol of SUMMARY_SYMBOLS) if (typeof saved[symbol] === "boolean") defaults[symbol] = saved[symbol];
    }
  } catch { /* Use defaults when storage is unavailable. */ }
  return defaults;
}

function formatPnl(dollars: number): string {
  const sign = dollars > 0 ? "+" : dollars < 0 ? "-" : "";
  return `${sign}$${Math.abs(dollars).toFixed(2)}`;
}

function pnlClass(dollars: number): string {
  if (dollars > 0) return "positive";
  if (dollars < 0) return "negative";
  return "";
}

function App() {
  const canControl = useCanControl();
  const [summaryVisible, setSummaryVisible] = useState(true);
  const [summaryStats, setSummaryStats] = useState<Record<string, SummaryStats>>({});
  const autoMarkets = useRef(new AutoMarkets(new Set(AUTO_SYMBOLS)));
  const handleSummaryChange = useCallback((symbol: string, stats: SummaryStats) => {
    autoMarkets.current.observe(symbol, stats, marketNow());
    setSummaryStats((previous) => ({ ...previous, [symbol]: stats }));
    // Keep a revealed trade card in the current selection after it closes,
    // so its sale feedback remains visible until the next AUTO review.
    if (hasActiveOrder(stats)) {
      if (!focusSnapshot.current.enabled[symbol]) setChartOrder(previous => [...previous.filter(item => item !== symbol), symbol]);
      setEnabled(previous => previous[symbol] ? previous : { ...previous, [symbol]: true });
    }
  }, []);
  const [enabled, setEnabled] = useState(loadVisibleMarkets);
  const [focus, setFocus] = useState(() => {
    try { return localStorage.getItem(FOCUS_KEY) !== "false"; } catch { return true; }
  });
  const [chartOrder, setChartOrder] = useState(SUMMARY_SYMBOLS);
  const focusSnapshot = useRef({ stats: summaryStats, enabled, order: chartOrder });
  focusSnapshot.current = { stats: summaryStats, enabled, order: chartOrder };
  // Order updates reveal their chart immediately, independent of the Focus timer.
  const visibleMarkets = Object.fromEntries(SUMMARY_SYMBOLS.map(symbol =>
    [symbol, (focus && symbol === "BTC") || (enabled[symbol] && (!focus || AUTO_SYMBOLS.includes(symbol))) || hasActiveOrder(summaryStats[symbol])]
  ));
  const displayedOrder = focus ? ["BTC", ...chartOrder.filter(symbol => symbol !== "BTC")] : chartOrder;
  const jevSymbols = focus ? displayedOrder.filter(symbol => visibleMarkets[symbol] && AUTO_SYMBOLS.includes(symbol)) : [];
  const jevDecisions = useJev(jevSymbols);
  const marketGridRef = useRef<HTMLDivElement>(null);
  const chartLayoutKey = displayedOrder.filter(symbol => visibleMarkets[symbol]).join(",");
  const statsReady = SUMMARY_SYMBOLS.every(symbol => summaryStats[symbol] !== undefined);
  const closeTimeRef = useRef<number | null>(null);
  const interactionUntil = useRef(0);
  const interactionSymbol = useRef<string | null>(null);
  const lastAutoReview = useRef(-Infinity);
  useEffect(() => {
    try { localStorage.setItem(FOCUS_KEY, String(focus)); } catch { /* Best effort. */ }
    // Pausing AUTO must not restart the final-minute retention rules.
    if (!focus || !statsReady) return;
    const refresh = () => {
      const snapshot = focusSnapshot.current;
      const now = marketNow();
      const close = closeTimeRef.current;
      const grid = marketGridRef.current;
      // Protect only the inspected card; the rest of AUTO must keep updating.
      const hovering = window.matchMedia("(hover: hover)").matches && grid?.querySelector(".market-bar:not(.market-exit-ghost):hover");
      const editing = grid?.querySelector("input:focus, .market-bar :focus-visible");
      const interacting = new Set<string>();
      for (const element of [hovering, editing]) {
        if (!element) continue;
        const symbol = element.closest<HTMLElement>(".market-bar")?.dataset.symbol;
        if (symbol) interacting.add(symbol);
      }
      if (now < interactionUntil.current && interactionSymbol.current) interacting.add(interactionSymbol.current);
      const capacity = window.innerWidth < 900 ? 3 : 6;
      const next = autoMarkets.current.select(snapshot.order, snapshot.enabled, snapshot.stats, now, close, capacity, interacting);
      lastAutoReview.current = now;
      if (next.order.every((symbol, index) => symbol === snapshot.order[index]) &&
          SUMMARY_SYMBOLS.every(symbol => next.visible[symbol] === snapshot.enabled[symbol])) return;
      setEnabled(next.visible);
      setChartOrder(next.order);
    };
    refresh();
    // Recheck cadence as the shared countdown crosses 3:00 and 2:00,
    // without restarting the schedule on every price/score update.
    const timer = window.setInterval(() => {
      const now = marketNow();
      const snapshot = focusSnapshot.current;
      const needsAdmission = autoMarkets.current.needsAdmission(SUMMARY_SYMBOLS, snapshot.enabled, snapshot.stats, now, closeTimeRef.current);
      const needsRemoval = autoMarkets.current.needsRemoval(SUMMARY_SYMBOLS, snapshot.enabled, snapshot.stats);
      const reviewInterval = needsRemoval ? 0 : needsAdmission ? 5 : autoRefreshSeconds(closeTimeRef.current, now);
      if (now - lastAutoReview.current < reviewInterval) return;
      refresh();
    }, 1000);
    return () => window.clearInterval(timer);
  }, [focus, statsReady]);
  useEffect(() => {
    try { localStorage.setItem(VISIBLE_MARKETS_KEY, JSON.stringify(enabled)); } catch { /* Best effort. */ }
  }, [enabled]);

  // Account-wide realized P&L for today, straight from Kalshi's settlements
  // (see fetchTodaysRealizedPnlTotal in server/portfolio.ts) — not summed
  // from each card's own pnlDollars, which only covers currently-tracked markets.
  const [totalPnl, setTotalPnl] = useState(0);
  const [leaderboard, setLeaderboard] = useState<LeaderboardRow[]>([]);
  useEffect(() => {
    return connectToBackend(
      (msg) => {
        if (msg.type === "accountPnl") setTotalPnl(msg.dollars);
        if (msg.type === "leaderboard") setLeaderboard(msg.rows);
      },
      () => {}
    );
  }, []);

  const [muted, setMutedState] = useState(() => isMuted());

  // Browser blocks audio until a real tap/click happens — surfaced in the
  // UI instead of silently dropping fill sounds.
  const [soundUnlocked, setSoundUnlocked] = useState(() => isAudioUnlocked());
  useEffect(() => {
    if (soundUnlocked) return;
    return onAudioUnlock(() => setSoundUnlocked(true));
  }, [soundUnlocked]);

  const toggleMuted = useCallback(() => {
    setMutedState((prev) => {
      const next = !prev;
      setMuted(next);
      // Confirmation beep so unmuting doubles as a quick speaker check.
      if (!next) playWinSound();
      return next;
    });
  }, []);

  // The shared market timer continues even when AUTO hides every chart.
  const [closeTimeBySymbol, setCloseTimeBySymbol] = useState<Record<string, number | null>>({});
  const closeTime = Object.values(closeTimeBySymbol).reduce<number | null>(
    (soonest, t) => (t === null ? soonest : soonest === null ? t : Math.min(soonest, t)),
    null
  );
  closeTimeRef.current = closeTime;

  const handleToggle = useCallback((symbol: string) => {
    if (hasActiveOrder(focusSnapshot.current.stats[symbol])) return;
    // A deliberate manual choice stays put until Focus is turned back on.
    setFocus(false);
    if (!focusSnapshot.current.enabled[symbol]) setChartOrder(previous => [...previous.filter(item => item !== symbol), symbol]);
    setEnabled((prev) => ({ ...prev, [symbol]: !prev[symbol] }));
  }, []);

  const handleCloseTimeChange = useCallback((symbol: string, time: number | null) => {
    setCloseTimeBySymbol((prev) => (prev[symbol] === time ? prev : { ...prev, [symbol]: time }));
  }, []);

  return (
    <div className="app">
      <div className="app-header">
        <div className="header-left">
          <button type="button" className={`summary-toggle ${summaryVisible ? "active" : ""}`}
            aria-label="Show market summary" aria-pressed={summaryVisible}
            onClick={() => setSummaryVisible((shown) => !shown)}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="1.5" y="2" width="13" height="12" rx="1" stroke="currentColor" />
              <path d="M6 2v12" stroke="currentColor" />
            </svg>
          </button>
          <button type="button" className={`focus-toggle ${focus ? "active" : ""}`}
            aria-pressed={focus} aria-label="Auto markets"
            onClick={() => setFocus(value => !value)}>AUTO</button>
          <button
            type="button"
            className={`icon-btn${!muted && !soundUnlocked ? " needs-unlock" : ""}`}
            aria-label={muted ? "Unmute win/buy-in sounds" : "Mute win/buy-in sounds"}
            onClick={toggleMuted}
          >
            {muted ? "🔇" : soundUnlocked ? "🔊" : "🔈"}
          </button>
        </div>
        <Countdown closeTime={closeTime} />
        <div className="header-right">
          <span className={`pnl-value ${pnlClass(totalPnl)}`}>{formatPnl(totalPnl)}</span>
          <button
            type="button"
            className="icon-btn"
            disabled={!canControl}
            aria-label="Clear today's real and paper P&L"
            onClick={() => {
              sendToBackend({ cmd: "resetPnl" });
              sendToBackend({ cmd: "resetSim" });
            }}
          >
            ↺
          </button>
        </div>
      </div>
      <HoverSyncProvider>
        <div className="dashboard-body">
        {summaryVisible && <div className="market-sidebar" style={{ "--summary-count": SUMMARY_SYMBOLS.length, "--sim-row-count": Math.ceil(SUMMARY_SYMBOLS.length / 2), "--jev-count": jevSymbols.length } as CSSProperties}>
          <MarketSummary leaderboard={leaderboard} symbols={SUMMARY_SYMBOLS} stats={summaryStats} visible={visibleMarkets} onToggle={handleToggle} />
          <SimLeaderboard symbols={SUMMARY_SYMBOLS} rows={leaderboard} className="sim-desktop" />
          <JevPanel symbols={jevSymbols} decisions={jevDecisions} stats={summaryStats} auto={focus} closeTime={closeTime} className="jev-desktop" />
        </div>}
        <LayoutGroup id="market-charts">
        <motion.div layoutScroll ref={marketGridRef} className="market-grid"
          onPointerDownCapture={(event) => {
            interactionUntil.current = marketNow() + 10;
            interactionSymbol.current = (event.target as Element).closest<HTMLElement>(".market-bar")?.dataset.symbol ?? null;
          }}
          >
          {displayedOrder.map((symbol) => (
            <MarketCard
              key={symbol}
              symbol={symbol}
              enabled={visibleMarkets[symbol]}
              layoutKey={chartLayoutKey}
              onToggle={handleToggle}
              onCloseTimeChange={handleCloseTimeChange}
              onSummaryChange={handleSummaryChange}
            />
          ))}
        </motion.div>
        </LayoutGroup>
        </div>
      </HoverSyncProvider>
      <SimLeaderboard symbols={SUMMARY_SYMBOLS} rows={leaderboard} className="sim-mobile" />
      <JevPanel symbols={jevSymbols} decisions={jevDecisions} stats={summaryStats} auto={focus} closeTime={closeTime} className="jev-mobile" />
    </div>
  );
}

export default App;
