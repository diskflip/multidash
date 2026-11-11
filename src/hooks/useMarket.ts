import { OrderMarkers, addFillMarker } from "../lib/orderMarkers";
import { appendPrice, restoreHistory, validPoint, MAX_QUOTE_AGE_SECONDS } from "../lib/chartTimeline";
import { marketNow, subscribeMarketClock } from "../lib/marketClock";
import { RestingHold } from "../lib/restingHold";
import type { QuickTradeStatus } from "../lib/quickTrade";
import { useEffect, useRef, useState } from "react";
import { connectToBackend } from "../data/kalshi";
import { trimDistance, validDistancePoint } from "../lib/strikeDistance";
import type { ChartEvent, DistancePoint, FlipPotential, HistoryPoint, MarketInfo } from "../types/market";

export type MarketState = {
  quickTrade: QuickTradeStatus | null;
  connected: boolean;
  market: MarketInfo | null;
  history: HistoryPoint[];
  // Underlying-vs-strike observations for the chart's second line. Empty
  // for every symbol the server doesn't publish a distance for — see
  // DISTANCE_SYMBOLS in server/strikeDistance.ts.
  distanceHistory: DistancePoint[];
  events: ChartEvent[];
  currentYes: number | null;
  flipsLastHour: number;
  flipsLastWindow: number;
  resting: boolean;
  holding: boolean;
  pnlDollars: number;
  // See server/simTracker.ts — combines two strategies into one tally.
  sim1hTally: number;
  sim1hWins: number;
  sim1hLosses: number;
  sim1hFlash: { time: number; result: "win" | "loss" } | null;
  sim30mTally: number;
  sim30mWins: number;
  sim30mLosses: number;
  sim30mFlash: { time: number; result: "win" | "loss" } | null;
  // Signed: positive = net YES contracts, negative = net NO.
  positionFp: number;
  costDollars: number;
  winFlash: { time: number; side?: "yes" | "no"; priceCents?: number } | null;
  buyInFlash: number | null;
  saleFlash: number | null;
  spotPriceDollars: number | null;
  // Sum of every 1c+ tick-to-tick move since the window opened.
  rangeCents: number;
  // null until the first botStatus message arrives — see server/botControl.ts.
  swingSupported: boolean;
  swingEnabled: boolean;
  botEnabled: boolean | null;
  botBudget: number | null;
  botAllocation: number | null;
  flipPotential: FlipPotential | null;
};

const HISTORY_WINDOW_MS = 30 * 60 * 1000;

// One shared WebSocket (see data/kalshi.ts) carries every market's
// messages; this hook filters for one symbol. `enabled: false` pauses it
// entirely and resets state.
export function useMarket(symbol: string, enabled: boolean = true): MarketState {
  const [quickTrade, setQuickTrade] = useState<QuickTradeStatus | null>(null);
  const [connected, setConnected] = useState(false);
  const [market, setMarket] = useState<MarketInfo | null>(null);
  // Mutated in place (push + splice), not React state.
  const historyRef = useRef<HistoryPoint[]>([]);
  const [historyVersion, setHistoryVersion] = useState(0);
  // Same in-place array + version pattern as historyRef.
  const distanceRef = useRef<DistancePoint[]>([]);
  const [distanceVersion, setDistanceVersion] = useState(0);
  // Buy/sell/rest chart markers — same in-place array pattern as historyRef.
  const eventsRef = useRef<ChartEvent[]>([]);
  const [eventsVersion, setEventsVersion] = useState(0);
  const [currentYes, setCurrentYes] = useState<number | null>(null);
  const [flipsLastHour, setFlipsLastHour] = useState(0);
  const [flipsLastWindow, setFlipsLastWindow] = useState(0);
  const [resting, setResting] = useState(false);
  const [holding, setHolding] = useState(false);
  const [pnlDollars, setPnlDollars] = useState(0);
  const [sim1hTally, setSim1hTally] = useState(0);
  const [sim1hWins, setSim1hWins] = useState(0);
  const [sim1hLosses, setSim1hLosses] = useState(0);
  const [sim1hFlash, setSim1hFlash] = useState<{ time: number; result: "win" | "loss" } | null>(null);
  const [sim30mTally, setSim30mTally] = useState(0);
  const [sim30mWins, setSim30mWins] = useState(0);
  const [sim30mLosses, setSim30mLosses] = useState(0);
  const [sim30mFlash, setSim30mFlash] = useState<{ time: number; result: "win" | "loss" } | null>(null);
  const [positionFp, setPositionFp] = useState(0);
  const [costDollars, setCostDollars] = useState(0);
  const [winFlash, setWinFlash] = useState<{ time: number; side?: "yes" | "no"; priceCents?: number } | null>(
    null
  );
  const [buyInFlash, setBuyInFlash] = useState<number | null>(null);
  const [saleFlash, setSaleFlash] = useState<number | null>(null);
  const [spotPriceDollars, setSpotPriceDollars] = useState<number | null>(null);
  const [rangeCents, setRangeCents] = useState(0);
  const [swingSupported, setSwingSupported] = useState(false);
  const [swingEnabled, setSwingEnabled] = useState(false);
  const [botEnabled, setBotEnabled] = useState<boolean | null>(null);
  const [botBudget, setBotBudget] = useState<number | null>(null);
  const [botAllocation, setBotAllocation] = useState<number | null>(null);
  const [flipPotential, setFlipPotential] = useState<FlipPotential | null>(null);

  // Raw tick-to-tick tracking for rangeCents.
  const rangeAccumRef = useRef(0);
  const lastTickYesRef = useRef<number | null>(null);

  const activeMarketRef = useRef<MarketInfo | null>(null);
  const currentTickerRef = useRef<string | null>(null);
  // Captured when the price arrives, not read fresh at commit time — a
  // market switch landing between a tick and its commit would otherwise
  // mistag a pre-switch price with the new ticker, drawing a spurious line
  // across the rollover instead of a clean break.
  const lastPriceRef = useRef<HistoryPoint | null>(null);
  // Sim messages replay the tracker's full snapshot on every reconnect —
  // dedupe against the last-seen trade time before flashing.
  const lastSim1hTradeTimeRef = useRef<number | null>(null);
  const lastSim30mTradeTimeRef = useRef<number | null>(null);
  // One "buy" chart marker per open position — see the position/fillEvent handlers below.
  const hasMarkedBuyRef = useRef(false);

  // 30-minute chart lookback, kept across a 15m rollover and a page reload
  // (see localStorage below); only pausing (enabled: false) clears it.

  useEffect(() => {
    if (!enabled) {
      setQuickTrade(null);
      setConnected(false);
      setMarket(null);
      historyRef.current = [];
      setHistoryVersion((v) => v + 1);
      distanceRef.current = [];
      setDistanceVersion((v) => v + 1);
      eventsRef.current = [];
      setEventsVersion((v) => v + 1);
      try {
        localStorage.removeItem(`flip-monitor-history-v2-${symbol}`);
        localStorage.removeItem(`flip-monitor-events-${symbol}`);
      } catch {
        // Ignore.
      }
      setCurrentYes(null);
      setFlipsLastHour(0);
      setFlipsLastWindow(0);
      setResting(false);
      setHolding(false);
      setPnlDollars(0);
      setSim1hTally(0);
      setSim1hWins(0);
      setSim1hLosses(0);
      setSim1hFlash(null);
      setSim30mTally(0);
      setSim30mWins(0);
      setSim30mLosses(0);
      setSim30mFlash(null);
      setPositionFp(0);
      setCostDollars(0);
      setWinFlash(null);
      setBuyInFlash(null);
      setSpotPriceDollars(null);
      setRangeCents(0);
      setBotEnabled(null);
      setBotBudget(null);
      setBotAllocation(null);
      setFlipPotential(null);
      activeMarketRef.current = null;
      currentTickerRef.current = null;
      lastPriceRef.current = null;
      rangeAccumRef.current = 0;
      lastTickYesRef.current = null;
      lastSim1hTradeTimeRef.current = null;
      lastSim30mTradeTimeRef.current = null;
      hasMarkedBuyRef.current = false;
      return;
    }

    // Persist history across a page reload (restored here, kept fresh by
    // the periodic/unload save below). Restore only validated source ticks.
    const storageKey = `flip-monitor-history-v2-${symbol}`;
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as HistoryPoint[];
        const cutoff = (Date.now() - HISTORY_WINDOW_MS) / 1000;
        historyRef.current = parsed.filter(
          (p) => p && validPoint(p) && p.time >= cutoff && p.time <= marketNow()
        );
        if (historyRef.current.length > 0) {
          setHistoryVersion((v) => v + 1);
        }
      }
    } catch {
      // Corrupt/old-shape entry — ignore and start empty.
    }

    const orderMarkers = new OrderMarkers();
    const eventsStorageKey = `flip-monitor-events-${symbol}`;
    try {
      const raw = localStorage.getItem(eventsStorageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as ChartEvent[];
        const cutoff = (Date.now() - HISTORY_WINDOW_MS) / 1000;
        eventsRef.current = parsed.filter(
          (e) => e && typeof e.time === "number" && typeof e.yes === "number" && e.time >= cutoff
        ).map(e => ({...e, ticker: e.ticker ?? historyRef.current.find(p => e.time >= p.openTime && e.time < p.closeTime)?.ticker}))
          .filter((e, index, all) => e.ticker && (e.type !== "rest" || e.orderId) &&
            all.findIndex(other => other.ticker === e.ticker && other.type === e.type) === index);
        if (eventsRef.current.length > 0) setEventsVersion((v) => v + 1);
      }
    } catch {
      // Corrupt/old-shape entry — ignore and start empty.
    }

    function persistHistory() {
      try {
        localStorage.setItem(storageKey, JSON.stringify(historyRef.current));
        localStorage.setItem(eventsStorageKey, JSON.stringify(eventsRef.current));
      } catch {
        // Storage full/unavailable — persistence is best-effort only.
      }
    }
    const PERSIST_INTERVAL_MS = 5_000;
    const persistIntervalId = setInterval(persistHistory, PERSIST_INTERVAL_MS);
    window.addEventListener("beforeunload", persistHistory);
    window.addEventListener("pagehide", persistHistory);

    // Never place a new-market marker using the old contract's final price.
    function currentPriceGuess(): number | null {
      if (lastPriceRef.current) return lastPriceRef.current.yes;
      const arr = historyRef.current;
      const last = arr.at(-1);
      return last?.ticker === currentTickerRef.current && marketNow() < last.closeTime ? last.yes : null;
    }

    // Fill markers use the best currently known quote. Resting markers arrive
    // separately with the confirmed order's own price, timestamp, and ID.
    function pushEvent(type: ChartEvent["type"], yes: number): ChartEvent {
      const now = marketNow() * 1000;
      const event: ChartEvent = { time: now / 1000, type, yes, ticker: currentTickerRef.current ?? undefined };
      const arr = eventsRef.current;
      if (!addFillMarker(arr, event)) return event;
      const cutoff = (now - HISTORY_WINDOW_MS) / 1000;
      let staleCount = 0;
      while (staleCount < arr.length && arr[staleCount].time < cutoff) staleCount++;
      if (staleCount > 0) arr.splice(0, staleCount);
      setEventsVersion((v) => v + 1);
      return event;
    }
    let wasResting: boolean | null = null;
    let restingHold = new RestingHold();
    let liveEnabled: boolean | null = null;
    function showResting(next: boolean) {
      if (next === wasResting) return;
      wasResting = next;
      setResting(next);
    }
    // Same first-reading problem as wasResting, for hasMarkedBuyRef.
    let hasSeenPosition = false;
    // Reconnects must break the path even when the interruption is brief.
    let linkBroken = true;
    function commitPoint(point: HistoryPoint) {
      if (!appendPrice(historyRef.current, point, activeMarketRef.current, linkBroken)) return false;
      linkBroken = false;
      setCurrentYes(point.yes);
      setHistoryVersion((v) => v + 1);
      return true;
    }

    // Background cleanup only — never changes tick timestamps. Runs on its own timer, collapsing redundant
    // middle points out of flat runs only in the *old* part of the buffer
    // (older than DEDUPE_SAFE_AGE_MS, safely past any close-up window), so
    // it can never touch a point the live view depends on.
    const DEDUPE_INTERVAL_MS = 15_000;
    const DEDUPE_SAFE_AGE_MS = 3 * 60 * 1000;
    // MarketChart breaks the line at any gap over MAX_GAP_SECONDS (10s) —
    // collapsing a long flat run down to just its two endpoints made that
    // run read as an outage, punching gaps into older history. Keep at
    // least one point this often so a thinned flat run stays connected.
    const DEDUPE_MAX_SPACING_SECONDS = 5;

    function dedupeOldHistory() {
      const arr = historyRef.current;
      const cutoff = (Date.now() - DEDUPE_SAFE_AGE_MS) / 1000;
      let boundary = 0;
      while (boundary < arr.length && arr[boundary].time < cutoff) boundary++;
      if (boundary < 3) return;

      const deduped: HistoryPoint[] = [];
      for (let i = 0; i < boundary; i++) {
        const p = arr[i];
        // Compared against the true original neighbors, not deduped's own
        // last kept entry — comparing against an already-thinned reference
        // can wrongly call a real value change "not a corner" and flatten
        // real data.
        const prev = i > 0 ? arr[i - 1] : null;
        const next = i + 1 < boundary ? arr[i + 1] : null;
        // Keep the first point, the boundary-adjacent point, and any real
        // corner (value or ticker differs from a neighbor).
        const isRealCorner =
          !prev ||
          !next ||
          p.breakBefore || next.breakBefore ||
          p.yes !== prev.yes ||
          p.ticker !== prev.ticker ||
          p.yes !== next.yes ||
          p.ticker !== next.ticker;
        const lastKept = deduped[deduped.length - 1];
        const spacingDue = !lastKept || p.time - lastKept.time >= DEDUPE_MAX_SPACING_SECONDS;
        if (isRealCorner || spacingDue) deduped.push(p);
      }
      if (deduped.length < boundary) {
        arr.splice(0, boundary, ...deduped);
        setHistoryVersion((v) => v + 1);
      }
    }
    const dedupeIntervalId = setInterval(dedupeOldHistory, DEDUPE_INTERVAL_MS);

    // Expire the displayed quote at its own contract's close even when the
    // next market lookup or first tick is delayed. Never synthesize saved ticks.
    const stopClock = subscribeMarketClock(() => {
      if (wasResting !== null) showResting(restingHold.value(performance.now() / 1000));
      const last = lastPriceRef.current;
      if (last && (marketNow() >= last.closeTime || marketNow() - last.time > MAX_QUOTE_AGE_SECONDS)) {
        lastPriceRef.current = null;
        setCurrentYes(null);
      }
    });

    const disconnect = connectToBackend(
      (msg) => {
        if (msg.type === "market") {
          if (msg.symbol !== symbol) return;
          if (msg.market && activeMarketRef.current && msg.market.openTime < activeMarketRef.current.openTime) return;
          const nextTicker = msg.market?.ticker ?? null;
          if (nextTicker !== currentTickerRef.current) {
            lastPriceRef.current = null;
            setCurrentYes(null);
            linkBroken = true;
            wasResting = null;
            restingHold = new RestingHold();
            setResting(false);
            setHolding(false);
            setPositionFp(0);
            setCostDollars(0);
            // New 15m window — start the range count over.
            rangeAccumRef.current = 0;
            lastTickYesRef.current = null;
            setRangeCents(0);
          }
          activeMarketRef.current = msg.market;
          currentTickerRef.current = nextTicker;
          setMarket(msg.market);
        } else if (msg.type === "history") {
          if (msg.symbol !== symbol) return;
          historyRef.current = restoreHistory(historyRef.current, msg.points, marketNow());
          // Replay contains source-feed breaks. A browser reconnect alone
          // must not cut the recovered continuous observations into pieces.
          if (msg.points.length > 0) linkBroken = false;
          const last = historyRef.current.at(-1);
          if (last && last.ticker === activeMarketRef.current?.ticker &&
              marketNow() < last.closeTime && marketNow() - last.time <= MAX_QUOTE_AGE_SECONDS) {
            lastPriceRef.current = last;
            setCurrentYes(last.yes);
          }
          setHistoryVersion(v => v + 1);
        } else if (msg.type === "distanceHistory") {
          if (msg.symbol !== symbol) return;
          // The server's buffer is the continuous one and survives this
          // tab, so a replay replaces rather than merges.
          distanceRef.current = msg.points
            .filter(p => validDistancePoint(p) && p.time <= marketNow())
            .sort((a, b) => a.time - b.time);
          setDistanceVersion(v => v + 1);
        } else if (msg.type === "distance") {
          if (msg.symbol !== symbol) return;
          const points = distanceRef.current;
          if (!validDistancePoint(msg.point) || msg.point.time <= (points.at(-1)?.time ?? -Infinity)) return;
          points.push(msg.point);
          trimDistance(points, msg.point.time);
          setDistanceVersion(v => v + 1);
        } else if (msg.type === "price") {
          if (msg.symbol !== symbol) return;
          // Re-enabling a card joins an already-open shared socket. Each
          // tick includes enough metadata to recover without waiting for
          // the next rollover announcement.
          if (!activeMarketRef.current && validPoint(msg.point)) {
            const recovered = { symbol, ticker: msg.point.ticker, title: msg.point.ticker,
              openTime: msg.point.openTime, closeTime: msg.point.closeTime };
            activeMarketRef.current = recovered;
            currentTickerRef.current = recovered.ticker;
            setMarket(recovered);
          }
          if (!commitPoint(msg.point)) return;
          lastPriceRef.current = msg.point;
          if (lastTickYesRef.current !== null) {
            const delta = Math.abs(msg.point.yes - lastTickYesRef.current);
            if (delta > 0) {
              rangeAccumRef.current += delta;
              setRangeCents(rangeAccumRef.current);
            }
          }
          lastTickYesRef.current = msg.point.yes;
        } else if (msg.type === "flips") {
          if (msg.symbol !== symbol) return;
          setFlipsLastHour(msg.lastHour);
          setFlipsLastWindow(msg.lastWindow);
        } else if (msg.type === "orderEvent") {
          if (msg.symbol !== symbol || msg.ticker !== currentTickerRef.current) return;
          if (orderMarkers.apply(eventsRef.current, msg, activeMarketRef.current)) setEventsVersion(v => v + 1);
          if (msg.resting) showResting(restingHold.update(true, performance.now() / 1000, liveEnabled !== false));
        } else if (msg.type === "orderStatus") {
          if (msg.symbol !== symbol) return;
          if (msg.ticker !== undefined && msg.ticker !== currentTickerRef.current) return;
          showResting(restingHold.update(msg.resting, performance.now() / 1000, liveEnabled !== false));
          setHolding(msg.holding);
        } else if (msg.type === "pnl") {
          if (msg.symbol !== symbol) return;
          setPnlDollars(msg.dollars);
        } else if (msg.type === "sim1h") {
          if (msg.symbol !== symbol) return;
          setSim1hTally(msg.tally);
          setSim1hWins(msg.wins);
          setSim1hLosses(msg.losses);
          if (msg.lastTrade && msg.lastTrade.time !== lastSim1hTradeTimeRef.current) {
            lastSim1hTradeTimeRef.current = msg.lastTrade.time;
            setSim1hFlash({ time: Date.now(), result: msg.lastTrade.result });
          }
        } else if (msg.type === "sim30m") {
          if (msg.symbol !== symbol) return;
          setSim30mTally(msg.tally);
          setSim30mWins(msg.wins);
          setSim30mLosses(msg.losses);
          if (msg.lastTrade && msg.lastTrade.time !== lastSim30mTradeTimeRef.current) {
            lastSim30mTradeTimeRef.current = msg.lastTrade.time;
            setSim30mFlash({ time: Date.now(), result: msg.lastTrade.result });
          }
        } else if (msg.type === "spot") {
          if (msg.symbol !== symbol) return;
          setSpotPriceDollars(msg.priceDollars);
        } else if (msg.type === "position") {
          if (msg.symbol !== symbol) return;
          if (msg.ticker !== undefined && msg.ticker !== currentTickerRef.current) return;
          if (msg.positionFp !== 0 && !activeMarketRef.current) return;
          if (!hasSeenPosition) {
            hasSeenPosition = true;
            // Already holding on first read — treat as already marked so a
            // later add-on fill doesn't draw a fresh buy marker.
            if (msg.positionFp !== 0) hasMarkedBuyRef.current = true;
          } else if (msg.positionFp === 0) {
            hasMarkedBuyRef.current = false;
          }
          setPositionFp(msg.positionFp);
          setCostDollars(msg.costDollars);
          setHolding(msg.positionFp !== 0);
        } else if (msg.type === "fillEvent") {
          if (msg.symbol !== symbol) return;
          if (msg.ticker !== undefined && msg.ticker !== currentTickerRef.current) return;
          if (msg.intent === "entry") {
            setBuyInFlash(Date.now());
            // Persistent ref, not the message's own transient state —
            // allows only one marker between going flat and buying again.
            if (!hasMarkedBuyRef.current) {
              const p = currentPriceGuess();
              if (p !== null) {
                hasMarkedBuyRef.current = true;
                pushEvent("buy", p);
              }
            }
          } else if (msg.intent === "exit") {
            setSaleFlash(Date.now());
            const p = currentPriceGuess();
            if (p !== null) pushEvent("sell", p);
          } else if (msg.intent === "win") {
            setWinFlash({ time: Date.now(), side: msg.side, priceCents: msg.priceCents });
          }
        } else if (msg.type === "status") {
          if (!msg.connected) linkBroken = true;
          setConnected(msg.connected);
        } else if (msg.type === "botStatus") {
          if (msg.symbol !== symbol) return;
          liveEnabled = msg.enabled;
          if (!liveEnabled && wasResting !== null) showResting(restingHold.releaseGrace());
          setQuickTrade(msg.quickTrade ?? null);
          setSwingSupported(msg.swingSupported);
          setSwingEnabled(msg.swingEnabled);
          setBotEnabled(msg.enabled);
          setBotBudget(msg.budget);
          setBotAllocation(msg.allocation);
          setFlipPotential(msg.flipPotential);
        }
      },
      (connected) => {
        if (!connected) {
          linkBroken = true;
          // The pre-disconnect quote is no longer a live price.
          lastPriceRef.current = null;
          setCurrentYes(null);
        }
        setConnected(connected);
      }
    );

    return () => {
      stopClock();
      clearInterval(dedupeIntervalId);
      clearInterval(persistIntervalId);
      window.removeEventListener("beforeunload", persistHistory);
      window.removeEventListener("pagehide", persistHistory);
      persistHistory();
      disconnect();
    };
  }, [symbol, enabled]);

  // Triggers a re-render for the in-place mutations above; values unused.
  void historyVersion;
  void distanceVersion;
  void eventsVersion;

  return {
    quickTrade,
    connected,
    market,
    history: historyRef.current,
    distanceHistory: distanceRef.current,
    events: eventsRef.current,
    currentYes,
    flipsLastHour,
    flipsLastWindow,
    resting,
    holding,
    pnlDollars,
    sim1hTally,
    sim1hWins,
    sim1hLosses,
    sim1hFlash,
    sim30mTally,
    sim30mWins,
    sim30mLosses,
    sim30mFlash,
    positionFp,
    costDollars,
    winFlash,
    buyInFlash,
    saleFlash,
    spotPriceDollars,
    rangeCents,
    swingSupported,
    swingEnabled,
    botEnabled,
    botBudget,
    botAllocation,
    flipPotential,
  };
}
