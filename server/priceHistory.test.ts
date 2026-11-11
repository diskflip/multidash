import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PriceHistory } from "./priceHistory.ts";
import { restoreHistory, chartSegments } from "../src/lib/chartTimeline.ts";

const point = (time: number, ticker = "A", breakBefore = false) => ({
  time, yes: 50, ticker, openTime: 0, closeTime: 4000, breakBefore,
});

test("reopen fills missed ticks and removes browser-only breaks", () => {
  const local = [point(100), point(102), point(118, "A", true)];
  const replay = Array.from({ length: 11 }, (_, i) => point(100 + i * 2));
  const restored = restoreHistory(local, replay, 122);
  assert.deepEqual(restored, replay);
  assert.equal(chartSegments(restored, 122).length, 1);
});

test("replay preserves source outages and market boundaries", () => {
  const replay = [point(100), point(102, "A", true), point(104, "B")];
  const restored = restoreHistory([point(98)], replay, 106);
  assert.equal(restored[0].time, 98);
  assert.equal(chartSegments(restored, 106).length, 3);
});

test("server history is bounded, isolated by symbol, and restored from disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-history-"));
  try {
    const path = join(dir, "history.json");
    const history = new PriceHistory(path);
    const now = Date.now() / 1000;
    const fresh = { ...point(now - 1), openTime: now - 900, closeTime: now + 900 };
    history.add("BTC", { ...fresh, time: now - 2000, openTime: now - 3000 });
    history.add("BTC", fresh);
    history.add("BTC", { ...fresh, time: now - 2 }); // Reject out of order.
    assert.deepEqual(history.get("BTC"), [fresh]);
    assert.deepEqual(history.get("ETH"), []);
    history.save();
    assert.deepEqual(new PriceHistory(path).get("BTC"), [fresh]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
