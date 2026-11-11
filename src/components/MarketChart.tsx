import { useMarketClock } from "../lib/marketClock";
import { chartSegments, latestVisiblePoint, MAX_QUOTE_AGE_SECONDS } from "../lib/chartTimeline";
import { useEffect, useRef, useState } from "react";
import type { MouseEvent, TouchEvent } from "react";
import type { ChartEvent, DistancePoint, HistoryPoint, MarketInfo } from "../types/market";
import {
  MAX_INDEX_GAP_SECONDS,
  distanceValue,
  distancePeak,
  distanceSegments,
  distanceToCents,
  formatDistance,
  latestVisibleDistance,
} from "../lib/strikeDistance";
import { formatPnl, pnlClass } from "../lib/format";
import { heatColor } from "../lib/heatColor";
import { useHoverSync } from "../hooks/useHoverSync";
import { SYMBOL_COLOR, DEFAULT_SYMBOL_COLOR as DEFAULT_COLOR, pastelSymbolColorRgb } from "../lib/symbolColor";
import "./MarketChart.css";

function formatCountdown(secondsLeft: number): string {
  const clamped = Math.max(0, Math.round(secondsLeft));
  const m = Math.floor(clamped / 60);
  const s = clamped % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const WINDOW_OPTIONS = [3, 30] as const;
type WindowMinutes = 3 | 30;

// Breathing room so the line/dot at 0 or 100 doesn't get clipped by
// chart-plot's overflow:hidden.
const MARGIN = 2;
const inset = (frac01: number) => MARGIN + frac01 * (100 - 2 * MARGIN);

// Asymmetric time-axis inset — the newest-time edge carries the live dot +
// label and needs more clearance than the oldest-time edge.
const MARGIN_TIME_START = 0;
const MARGIN_TIME_END_VERTICAL = 4;
// Fallback before the plot's real width is measured (see plotWidthPx) — a
// fixed pixel budget scales badly as a flat percentage on a wide card.
const MARGIN_TIME_END_HORIZONTAL = 14;
// Reserved pixels for the current-price label (gap + up to 3 digits + margin).
const HORIZONTAL_LABEL_SPACE_PX = 52;
const MARGIN_TIME_END_HORIZONTAL_MIN = 4;
const MARGIN_TIME_END_HORIZONTAL_MAX = 20;

// Binary search since a 30m window can hold thousands of points.
function nearestPoint<T extends { time: number }>(points: T[], time: number): T {
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].time < time) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(points[lo - 1].time - time) <= Math.abs(points[lo].time - time)) {
    return points[lo - 1];
  }
  return points[lo];
}

type Orientation = "vertical" | "horizontal";

type MarketChartProps = {
  symbol: string;
  history: HistoryPoint[];
  // Underlying-vs-strike observations, drawn as a second line on the same
  // 0-100 axis. Empty for symbols the server publishes no distance for.
  distanceHistory: DistancePoint[];
  events: ChartEvent[];
  currentYes: number | null;
  market: MarketInfo | null;
  unrealizedDollars: number | null;
  score: number | null;
  heldContracts: string | null;
  // "vertical" (default): price horizontal, time top-to-bottom (desktop).
  // "horizontal": traditional price-over-time (mobile).
  orientation?: Orientation;
};

// Filled area chart of YES price, 0-100 fixed, with a close-up/30m toggle.
export function MarketChart({
  symbol,
  history,
  distanceHistory,
  events,
  currentYes,
  market,
  unrealizedDollars,
  heldContracts,
  score,
  orientation = "vertical",
}: MarketChartProps) {
  const isVertical = orientation === "vertical";
  const windowOptions = WINDOW_OPTIONS;
  const [windowMinutes, setWindowMinutes] = useState<WindowMinutes>(3);
  const [hoverPoint, setHoverPoint] = useState<HistoryPoint | null>(null);
  const plotRef = useRef<HTMLDivElement | null>(null);
  const touchPanPosition = useRef<{ x: number; y: number } | null>(null);
  const color = SYMBOL_COLOR[symbol] ?? DEFAULT_COLOR;
  // A pale tint of this market's own color for the distance line, rather
  // than plain white — distinguishes one market's chart from another's at
  // a glance without competing with the full-saturation YES line.
  const distanceRgb = pastelSymbolColorRgb(symbol);
  const { hoverTime, setHoverTime, shiftHeld } = useHoverSync();

  // Lets horizontal's end-margin reserve a fixed pixel amount for the label
  // instead of a flat percentage; vertical doesn't need this.
  const [plotSize, setPlotSize] = useState<{width: number; height: number} | null>(null);
  const plotWidthPx = plotSize?.width ?? null;
  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect?.width && rect.height) setPlotSize({width: rect.width, height: rect.height});
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [isVertical]);

  const marginTimeEnd = isVertical
    ? MARGIN_TIME_END_VERTICAL
    : plotWidthPx
      ? Math.min(
          MARGIN_TIME_END_HORIZONTAL_MAX,
          Math.max(MARGIN_TIME_END_HORIZONTAL_MIN, (HORIZONTAL_LABEL_SPACE_PX / plotWidthPx) * 100)
        )
      : MARGIN_TIME_END_HORIZONTAL;
  const insetTime = (frac01: number) =>
    MARGIN_TIME_START + frac01 * (100 - MARGIN_TIME_START - marginTimeEnd);

  // Every market uses the same server-synchronized time axis.
  const effectiveNow = useMarketClock();

  // Scroll-to-pan: null means "live" (tracking effectiveNow); a number is
  // the absolute time the view is paused at. History keeps recording either
  // way — only the view is paused.
  const [pausedAtTime, setPausedAtTime] = useState<number | null>(null);
  const isLive = pausedAtTime === null;
  const oldestAvailable = history.length > 0 ? history[0].time : effectiveNow;
  const viewEnd = pausedAtTime ?? effectiveNow;

  // Kept fresh every render so the wheel handler below can clamp against
  // current data without needing to re-attach on every tick.
  const scrollBoundsRef = useRef({ effectiveNow, oldestAvailable });
  scrollBoundsRef.current = { effectiveNow, oldestAvailable };

  const SCROLL_SECONDS_PER_100_DELTA = 15;
  const TOUCH_SECONDS_PER_100_PIXELS = SCROLL_SECONDS_PER_100_DELTA * 3;
  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    function handleWheel(e: WheelEvent) {
      // A trackpad's left/right swipe needs to reach past this chart to
      // the market row's own horizontal scroll (overflow-x on
      // .market-grid) — only claim a wheel event that's actually vertical
      // (pan-history); let a predominantly horizontal one fall through
      // un-prevented. A plain mouse wheel's deltaX is 0, so it's
      // unaffected and still pans history as before.
      if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      e.preventDefault();
      const { effectiveNow: latest, oldestAvailable: oldest } = scrollBoundsRef.current;
      const shift = (e.deltaY / 100) * SCROLL_SECONDS_PER_100_DELTA;
      setPausedAtTime((prev) => {
        const current = prev ?? latest;
        const next = Math.min(latest, Math.max(oldest, current + shift));
        return next >= latest ? null : next;
      });
    }
    // passive:false so preventDefault can stop page scroll underneath —
    // React's onWheel attaches passively and can't do this.
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, []);

  // Always the full selected window (fixed span), not a domain that grows
  // into that size as data accumulates — a growing domain rescales every
  // already-plotted point on every tick instead of just leaving unfilled
  // space. Do not change this back to a growing domain.
  const domainStart = viewEnd - windowMinutes * 60;
  const domainSpan = Math.max(viewEnd - domainStart, 1);

  const points = history.filter((p) => p.time >= domainStart && p.time <= viewEnd);
  // The line/fill also start from the last point *before* the window,
  // clipped by the plot's edge — otherwise they start at the first in-window
  // point, so the oldest edge sits short of the plot edge and jumps each
  // time a point scrolls out (visible wherever points are sparse: thinned
  // old history, backfilled background stretches).
  const leadIdx = history.indexOf(points[0]) - 1;
  const drawPoints = leadIdx >= 0 ? [history[leadIdx], ...points] : points;
  const visibleEvents = events.filter((e) => e.time >= domainStart && e.time <= viewEnd);

  // Price position along whichever axis carries price: YES=100 at the
  // start of that axis, YES=0/NO=100 at the end.
  const toPricePos = (yes: number) => inset(1 - Math.min(100, Math.max(0, yes)) / 100);
  // Time position along whichever axis carries time: oldest at the start,
  // newest (with extra clearance) at the end.
  const toTimePos = (time: number) => insetTime((time - domainStart) / domainSpan);

  // Vertical: price on X, time on Y (oldest top). Horizontal: time on X
  // (oldest left), price on Y.
  const project = (yes: number, time: number) => {
    const p = toPricePos(yes);
    const t = toTimePos(time);
    return isVertical ? { x: p, y: t } : { x: t, y: p };
  };
  // A reference line at a fixed price, spanning the full time axis.
  const priceLine = (yes: number) => {
    const p = toPricePos(yes);
    return isVertical ? { x1: p, x2: p, y1: 0, y2: 100 } : { x1: 0, x2: 100, y1: p, y2: p };
  };
  // A reference line at a fixed time, spanning the full price axis.
  const timeLine = (time: number) => {
    const t = toTimePos(time);
    return isVertical ? { x1: 0, x2: 100, y1: t, y2: t } : { x1: t, x2: t, y1: 0, y2: 100 };
  };
  // The fill closes against the chart's true 0/100 boundary, not the
  // MARGIN-inset position the line/dot use (that inset is only needed so
  // the dot's circular marker doesn't get clipped).
  const toFillEdge = (time: number) => {
    const t = toTimePos(time);
    return isVertical ? { x: 100, y: t } : { x: t, y: 100 };
  };

  const segments = chartSegments(drawPoints, viewEnd);

  const linePieces: string[] = [];
  const areaPieces: string[] = [];
  for (const seg of segments) {
    if (seg.length < 2) continue;
    const segLine = seg
      .map((p, i) => {
        const { x, y } = project(p.yes, p.time);
        return `${i === 0 ? "M" : "L"} ${x.toFixed(4)} ${y.toFixed(4)}`;
      })
      .join(" ");
    linePieces.push(segLine);
    const last = toFillEdge(seg[seg.length - 1].time);
    const first = toFillEdge(seg[0].time);
    areaPieces.push(
      `${segLine} L ${last.x.toFixed(4)} ${last.y.toFixed(4)} L ${first.x.toFixed(4)} ${first.y.toFixed(4)} Z`
    );
  }
  const lineD = linePieces.join(" ");
  const areaD = areaPieces.join(" ");

  // Second line: how far the underlying sits from the current contract's
  // strike, mapped onto the same 0-100 axis. 50 is the strike exactly —
  // which is where chart-mid-line already sits, so the two coincide and no
  // extra reference line is needed. The ends are the widest distance reached
  // in the trailing 30 minutes, so the scale tracks whatever range is
  // currently relevant rather than a fixed band.
  //
  // The peak deliberately ignores windowMinutes: the 3m and 30m views share
  // one scale, so toggling between them doesn't rescale the line.
  const distancePoints = distanceHistory.filter((p) => p.time >= domainStart && p.time <= viewEnd);
  // Same lead-point trick as the price line, for the same reason.
  const distanceLeadIdx = distanceHistory.indexOf(distancePoints[0]) - 1;
  const distanceDrawPoints =
    distanceLeadIdx >= 0 ? [distanceHistory[distanceLeadIdx], ...distancePoints] : distancePoints;
  const peak = distancePeak(distanceHistory, viewEnd);
  const distanceSegs = distanceSegments(distanceDrawPoints, viewEnd);
  const distanceD = distanceSegs
    .filter((seg) => seg.length >= 2)
    .map((seg) =>
      seg
        .map((p, i) => {
          const { x, y } = project(distanceToCents(distanceValue(p), peak), p.time);
          return `${i === 0 ? "M" : "L"} ${x.toFixed(4)} ${y.toFixed(4)}`;
        })
        .join(" ")
    )
    .join(" ");

  const boundaries = new Set<number>();
  for (const point of drawPoints) {
    boundaries.add(point.openTime);
    boundaries.add(point.closeTime);
  }
  if (market) { boundaries.add(market.openTime); boundaries.add(market.closeTime); }
  const boundaryLines = [...boundaries].filter((time) => time >= domainStart && time <= viewEnd).map(timeLine);

  const gradientId = `chart-fill-${symbol}`;
  const lastPoint = segments.at(-1)?.at(-1) ?? null;
  // No live dot/price while paused — reappears once scrolled back to live.
  // A received tick can be slightly ahead of the shared render clock. Keep
  // showing the preceding plotted quote until that tick enters the chart.
  const latestObservation = latestVisiblePoint(history, effectiveNow);
  const quoteIsLive = market && latestObservation?.ticker === market.ticker && currentYes !== null &&
    lastPoint?.ticker === market.ticker && effectiveNow >= latestObservation.time &&
    effectiveNow < market.closeTime && effectiveNow - latestObservation.time <= MAX_QUOTE_AGE_SECONDS;
  const dot = isLive && lastPoint && quoteIsLive ? project(lastPoint.yes, lastPoint.time) : null;

  // End-cap for the distance line, on the same terms as the price dot: live
  // view only, current contract only, and not a stale observation. Taken
  // from the segmented (extended-to-now) endpoint, not the raw last tick —
  // same reason lastPoint above comes from `segments`, not `drawPoints`:
  // otherwise this dot only moves once a second, on each real observation,
  // instead of tracking the clock every frame like the price dot does,
  // which reads as lagging behind it even at the same update rate.
  // project() already swaps x/y for orientation, same as the price dot
  // above, so this needs no separate handling for the horizontal layout.
  const distanceLast = distanceSegs.at(-1)?.at(-1) ?? null;
  const latestDistanceObservation = latestVisibleDistance(distanceHistory, effectiveNow);
  const distanceIsLive = market && latestDistanceObservation?.ticker === market.ticker &&
    distanceLast?.ticker === market.ticker &&
    effectiveNow - latestDistanceObservation.time <= MAX_INDEX_GAP_SECONDS;
  const distanceDot =
    isLive && distanceLast && distanceIsLive
      ? project(distanceToCents(distanceValue(distanceLast), peak), distanceLast.time)
      : null;

  // Vertical's centered label clips against the card edge near 0/100 —
  // shift it inward instead. Horizontal doesn't need this (fixed-side label).
  const EDGE_THRESHOLD = 12;
  const currentLabelEdge =
    isVertical && dot
      ? dot.x < EDGE_THRESHOLD
        ? "near-start"
        : dot.x > 100 - EDGE_THRESHOLD
          ? "near-end"
          : null
      : null;

  // Shared by mouse and touch.
  function updateHoverFromClientPos(clientX: number, clientY: number) {
    if (points.length === 0) return;
    const rect = plotRef.current?.getBoundingClientRect();
    if (!rect) return;
    const dimSize = isVertical ? rect.height : rect.width;
    if (dimSize === 0) return;
    const posPx = isVertical ? clientY - rect.top : clientX - rect.left;
    const percent = (posPx / dimSize) * 100;
    const frac01 = (percent - MARGIN_TIME_START) / (100 - MARGIN_TIME_START - marginTimeEnd);
    const time = domainStart + frac01 * domainSpan;
    setHoverPoint(nearestPoint(points, time));
    // Publishes to every other chart while Shift is held, for synced hover.
    if (shiftHeld) setHoverTime(time);
  }

  function handleHoverMove(e: MouseEvent<HTMLDivElement>) {
    updateHoverFromClientPos(e.clientX, e.clientY);
  }

  function handleTouchStart(e: TouchEvent<HTMLDivElement>) {
    if (e.touches.length !== 1) {
      touchPanPosition.current = null;
      return;
    }
    const touch = e.touches[0];
    if (!touch) return;
    e.preventDefault();
    touchPanPosition.current = { x: touch.clientX, y: touch.clientY };
    updateHoverFromClientPos(touch.clientX, touch.clientY);
  }

  function handleTouchMove(e: TouchEvent<HTMLDivElement>) {
    if (e.touches.length !== 1) {
      touchPanPosition.current = null;
      return;
    }
    const touch = e.touches[0];
    if (!touch) return;
    e.preventDefault();

    const previous = touchPanPosition.current;
    const position = { x: touch.clientX, y: touch.clientY };
    touchPanPosition.current = position;
    if (previous) {
      // Move through time along its on-screen axis. Dragging toward older
      // points moves the window back; dragging toward newer points advances it.
      const delta = isVertical ? position.y - previous.y : position.x - previous.x;
      const shift = (-delta / 100) * TOUCH_SECONDS_PER_100_PIXELS;
      const { effectiveNow: latest, oldestAvailable: oldest } = scrollBoundsRef.current;
      setPausedAtTime((prev) => {
        const next = Math.min(latest, Math.max(oldest, (prev ?? latest) + shift));
        return next >= latest ? null : next;
      });
    }
    updateHoverFromClientPos(touch.clientX, touch.clientY);
  }

  function handleTouchEnd() {
    touchPanPosition.current = null;
    handleHoverLeave();
  }

  function handleHoverLeave() {
    setHoverPoint(null);
    setHoverTime(null);
  }

  // Shift-hovering another chart published a time in range — match it here too.
  const hoverTimeInRange =
    hoverTime !== null && hoverTime >= domainStart && hoverTime <= effectiveNow;
  const syncedHoverPoint =
    !hoverPoint && shiftHeld && hoverTimeInRange && points.length > 0
      ? nearestPoint(points, hoverTime!)
      : null;
  const effectiveHoverPoint = hoverPoint ?? syncedHoverPoint;

  const hoverPos = effectiveHoverPoint ? project(effectiveHoverPoint.yes, effectiveHoverPoint.time) : null;
  const hoverX = hoverPos?.x ?? null;
  const hoverY = hoverPos?.y ?? null;
  const hoverLine = effectiveHoverPoint ? timeLine(effectiveHoverPoint.time) : null;
  const hoverColor =
    effectiveHoverPoint && effectiveHoverPoint.ticker !== lastPoint?.ticker ? DEFAULT_COLOR : color;
  // Saved points carry their own contract boundaries, including prior windows.
  const hoverCountdown = effectiveHoverPoint
    ? formatCountdown(effectiveHoverPoint.closeTime - effectiveHoverPoint.time)
    : null;
  // The same hovered moment on the distance series. Matched by contract and
  // proximity so a feed gap or a rollover can't pair the price with a
  // reading measured against a different strike.
  const hoverDistanceCandidate =
    effectiveHoverPoint && distancePoints.length > 0
      ? nearestPoint(distancePoints, effectiveHoverPoint.time)
      : null;
  const hoverDistance =
    hoverDistanceCandidate && effectiveHoverPoint &&
    hoverDistanceCandidate.ticker === effectiveHoverPoint.ticker &&
    Math.abs(hoverDistanceCandidate.time - effectiveHoverPoint.time) <= MAX_INDEX_GAP_SECONDS
      ? hoverDistanceCandidate
      : null;
  const tooltipBelow = hoverY !== null && hoverY < 20;
  const historicalWindow = !isLive
    ? history.find(point => point.openTime <= viewEnd && point.closeTime > viewEnd)
    : undefined;
  const midLine = priceLine(50);

  return (
    <div className={`chart chart--${orientation}`}>
      <div
        className="chart-plot"
        ref={plotRef}
        onMouseMove={handleHoverMove}
        onMouseLeave={handleHoverLeave}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
      >
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="chart-svg">
          <defs>
            {/* Flat fill color, with a short taper only in the last 15%
                near the live edge to soften the cutoff there. */}
            <linearGradient
              id={gradientId}
              gradientUnits="userSpaceOnUse"
              x1={isVertical ? 0 : 0}
              y1={isVertical ? 0 : 0}
              x2={isVertical ? 0 : 100}
              y2={isVertical ? 100 : 0}
            >
              <stop offset="0%" stopColor={color} stopOpacity={0.3} />
              <stop offset="85%" stopColor={color} stopOpacity={0.3} />
              <stop offset="100%" stopColor={color} stopOpacity={0.05} />
            </linearGradient>
          </defs>
          {areaD && <path d={areaD} fill={`url(#${gradientId})`} stroke="none" />}
          <line {...midLine} className="chart-mid-line" vectorEffect="non-scaling-stroke" />
          {boundaryLines.map((l, i) => (
            <line key={i} {...l} className="chart-boundary-line" vectorEffect="non-scaling-stroke" />
          ))}
          {distanceD && (
            <>
              {/* Dimmer, wider edge stroke underneath a brighter, narrower
                  core — a beveled look instead of a flat line, without the
                  per-frame filter blur that was flickering as this path's
                  live edge redraws every tick. */}
              <path
                d={distanceD}
                fill="none"
                stroke={`rgba(${distanceRgb}, 0.18)`}
                className="chart-distance-line-edge"
                vectorEffect="non-scaling-stroke"
              />
              <path
                d={distanceD}
                fill="none"
                stroke={`rgba(${distanceRgb}, 0.6)`}
                className="chart-distance-line-core"
                vectorEffect="non-scaling-stroke"
              />
            </>
          )}
          {lineD && (
            <path
              d={lineD}
              fill="none"
              stroke={color}
              strokeWidth={1}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {hoverLine && (
            <line {...hoverLine} className="chart-hover-line" vectorEffect="non-scaling-stroke" />
          )}
        </svg>
        {/* Rasterize the thin marker once, then composite its movement. Use the
            graph's exact projection without pixel snapping or a separate tween. */}
        {plotSize && visibleEvents.map(event => {
          const position = toTimePos(event.time) / 100;
          const offset = position * (isVertical ? plotSize.height : plotSize.width) - 0.5;
          return <span
            key={`${event.ticker ?? event.time}-${event.type}`}
            className={`chart-order-line chart-order-line--${event.type}`}
            style={{
              width: isVertical ? '100%' : '1px',
              height: isVertical ? '1px' : '100%',
              transform: isVertical ? `translate3d(0, ${offset}px, 0)` : `translate3d(${offset}px, 0, 0)`,
            }}
            aria-hidden="true"
          />;
        })}
        {/* HTML, not SVG, for the dot/label — preserveAspectRatio="none"
            would squash a true circle into an ellipse. */}
        {dot && (
          <span
            className="chart-dot"
            style={{ left: `${dot.x}%`, top: `${dot.y}%`, background: color }}
          />
        )}
        {distanceDot && (
          <span
            className="chart-distance-dot"
            style={{
              left: `${distanceDot.x}%`,
              top: `${distanceDot.y}%`,
              background: `rgba(${distanceRgb}, 0.8)`,
            }}
            aria-hidden="true"
          />
        )}
        {currentYes !== null && dot && (
          <span
            className={`chart-current-label ${
              currentLabelEdge === "near-start"
                ? "align-start"
                : currentLabelEdge === "near-end"
                  ? "align-end"
                  : ""
            }`}
            style={{ left: `${dot.x}%`, top: `${dot.y}%`, color }}
          >
            {Math.round(latestObservation!.yes)}
          </span>
        )}
        {heldContracts && <span className="chart-held-contracts" aria-label={`Held contracts: ${heldContracts}`}>
          {heldContracts}
        </span>}
        {effectiveHoverPoint && hoverX !== null && hoverY !== null && (
          <>
            <span
              className="chart-hover-dot"
              style={{ left: `${hoverX}%`, top: `${hoverY}%`, background: hoverColor }}
            />
            <div
              className={`chart-hover-tooltip ${hoverX > 50 ? "align-right" : "align-left"} ${tooltipBelow ? "align-below" : "align-above"}`}
              style={{ left: `${hoverX}%`, top: `${hoverY}%` }}
              data-market-ticker={effectiveHoverPoint.ticker}
            >
              <span className="chart-hover-time">{hoverCountdown}</span>
              <span className="chart-hover-yes">YES {Math.round(effectiveHoverPoint.yes)}</span>
              <span className="chart-hover-no">NO {Math.round(100 - effectiveHoverPoint.yes)}</span>
              {hoverDistance && (
                <span className="chart-hover-distance">
                  Δ {formatDistance(distanceValue(hoverDistance), peak)}
                </span>
              )}
            </div>
          </>
        )}
      </div>
      <div className="chart-axis">
        <span className="chart-visible-score" aria-label={score == null ? "Score unavailable" : `Score ${Math.round(score)} out of 10`}
          style={score == null ? undefined : { color: heatColor((score - 1) / 9) }}>
          {score == null ? "—" : Math.round(score)}
        </span>
        {historicalWindow && <span className="chart-history-countdown" aria-label="Time remaining in the historical market">
          {formatCountdown(historicalWindow.closeTime - viewEnd)}
        </span>}
        {unrealizedDollars !== null && (
          <span className={`chart-unrealized-center ${pnlClass(unrealizedDollars)}`}>
            {formatPnl(unrealizedDollars)}
          </span>
        )}
        {!isLive && (
          <button
            type="button"
            className="chart-scroll-indicator"
            aria-label="Paused in history — click to jump back to live"
            onClick={(e) => {
              e.stopPropagation();
              setPausedAtTime(null);
            }}
          >
            −{formatCountdown(effectiveNow - viewEnd)}
          </button>
        )}
        <div className="chart-window-toggle">
          {windowOptions.map((m) => (
            <button
              key={m}
              type="button"
              className={`chart-window-btn ${m === windowMinutes ? "active" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                setWindowMinutes(m);
                setPausedAtTime(null);
              }}
            >
              {m}m
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
