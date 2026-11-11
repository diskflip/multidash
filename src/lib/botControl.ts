import { connectToBackend, sendToBackend } from "../data/kalshi";
import type { QuickOrder } from "./quickTrade";

export function submitQuickTrade(symbol: string, order: QuickOrder, cancelRestingBuy = false): Promise<{ queued: boolean }> {
  return new Promise((resolve, reject) => {
    const unsubscribe = connectToBackend(message => {
      if (message.type !== "quickTradeResult" || message.requestId !== order.request_id || message.symbol !== symbol) return;
      clearTimeout(timeout);
      unsubscribe();
      if (message.ok) resolve({ queued: message.queued });
      else reject(new Error(message.error ?? "Quick trade failed."));
    }, () => {});
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("Request confirmation unavailable. Check the bot status before placing another order."));
    }, 20000);
    if (!sendToBackend({ cmd: "quickTrade", symbol, order, cancelRestingBuy })) {
      clearTimeout(timeout);
      unsubscribe();
      reject(new Error("Disconnected. Order was not sent."));
    }
  });
}

// Sends bot on/off + bet-size commands over the existing backend WebSocket
// (same channel as resetPnl/resetSim in App.tsx) — the browser never talks
// to the live bot's control API directly, or sees its token. See
// server/botControl.ts and the "botStatus" case in server/index.ts for
// where these actually land.

export const BUDGET_MIN = 1;
export const BUDGET_MAX = 50;

export function setBotEnabled(symbol: string, enabled: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const unsubscribe = connectToBackend(message => {
      if (message.type !== "botCommandResult" || message.requestId !== requestId) return;
      clearTimeout(timeout);
      unsubscribe();
      if (message.ok) resolve();
      else reject(new Error(message.error ?? "LIVE change failed."));
    }, () => {});
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("LIVE change was not confirmed. Check the bot state before retrying."));
    }, 15000);
    if (!sendToBackend({ cmd: "setBotEnabled", symbol, enabled, requestId })) {
      clearTimeout(timeout);
      unsubscribe();
      reject(new Error("Disconnected. LIVE was not changed."));
    }
  });
}

export function setBotBudget(symbol: string, budget: number) {
  sendToBackend({ cmd: "setBotBudget", symbol, budget });
}

export function setBotSwing(symbol: string, enabled: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const unsubscribe = connectToBackend((message) => {
      if (message.type !== "swingResult" || message.requestId !== requestId) return;
      clearTimeout(timeout);
      unsubscribe();
      if (message.ok) resolve();
      else reject(new Error(message.error ?? "Unable to change FX Swing."));
    }, () => {});
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("No confirmation received. Check the displayed mode before retrying."));
    }, 15000);
    if (!sendToBackend({ cmd: "setBotSwing", symbol, enabled, requestId })) {
      clearTimeout(timeout);
      unsubscribe();
      reject(new Error("Reconnect with your private control link to change FX Swing."));
    }
  });
}
