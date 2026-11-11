import { syncMarketClock } from "../lib/marketClock";
import { useSyncExternalStore } from "react";
import type { ServerMessage } from "../types/market";

// Talks only to our local backend proxy (see server/index.ts) — the
// browser never sees Kalshi credentials. Same-origin "/ws", proxied by Vite.
function defaultBackendWsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}

const BACKEND_WS_URL =
  (import.meta.env.VITE_BACKEND_WS_URL as string | undefined) ??
  defaultBackendWsUrl();

let canControl = false;
const permissionListeners = new Set<() => void>();
function updatePermission(value: boolean) {
  canControl = value;
  for (const listener of permissionListeners) listener();
}
const subscribePermission = (listener: () => void) => {
  permissionListeners.add(listener);
  return () => { permissionListeners.delete(listener); };
};
export function useCanControl() {
  return useSyncExternalStore(subscribePermission, () => canControl);
}

const RECONNECT_DELAY_MS = 2000;
// Vite's dev-server WS proxy occasionally leaves a connection stuck in
// CONNECTING forever with no open/error/close event — force a retry.
const CONNECT_TIMEOUT_MS = 5000;
// A backgrounded/locked mobile tab can silently kill the TCP connection
// without ever firing close — readyState still reports OPEN but nothing
// arrives again (a real gap, not "less accurate" data). The backend
// rebroadcasts at least every 10s (see FLIPS_REBROADCAST_MS in
// server/index.ts), so silence past just over that means a zombie socket.
const STALE_THRESHOLD_MS = 12_000;
const STALE_CHECK_INTERVAL_MS = 2_000;

type Listener = {
  onMessage: (msg: ServerMessage) => void;
  onStatusChange: (connected: boolean) => void;
};

// One shared WebSocket for the whole app, ref-counted via `listeners`.
let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let lastKnownConnected = false;
let lastMessageAt = Date.now();
const listeners = new Set<Listener>();

function checkStale() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (Date.now() - lastMessageAt > STALE_THRESHOLD_MS) {
    socket.close();
  }
}

if (typeof document !== "undefined") {
  setInterval(checkStale, STALE_CHECK_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkStale();
  });
}

function ensureSocket() {
  if (socket) return;

  const ws = new WebSocket(BACKEND_WS_URL);
  socket = ws;

  const connectTimeout = setTimeout(() => {
    if (ws.readyState === WebSocket.CONNECTING) ws.close();
  }, CONNECT_TIMEOUT_MS);

  ws.onopen = () => {
    clearTimeout(connectTimeout);
    lastKnownConnected = true;
    lastMessageAt = Date.now();
    for (const l of listeners) l.onStatusChange(true);
  };

  ws.onmessage = (event) => {
    lastMessageAt = Date.now();
    let msg: ServerMessage;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === "clock" || msg.type === "status") syncMarketClock(msg.serverTime);
    if (msg.type === "status") updatePermission(msg.canControl === true);
    for (const l of listeners) l.onMessage(msg);
  };

  ws.onclose = () => {
    updatePermission(false);
    clearTimeout(connectTimeout);
    socket = null;
    lastKnownConnected = false;
    for (const l of listeners) l.onStatusChange(false);
    if (listeners.size > 0) {
      reconnectTimer = setTimeout(ensureSocket, RECONNECT_DELAY_MS);
    }
  };

  ws.onerror = () => {
    ws.close();
  };
}

export function connectToBackend(
  onMessage: (msg: ServerMessage) => void,
  onStatusChange: (connected: boolean) => void
): () => void {
  const listener: Listener = { onMessage, onStatusChange };
  listeners.add(listener);
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  ensureSocket();
  onStatusChange(lastKnownConnected);

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      socket?.close();
      socket = null;
    }
  };
}

export function sendToBackend(message: unknown) {
  if (canControl && socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
    return true;
  }
  return false;
}
