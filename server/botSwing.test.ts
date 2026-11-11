import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchBotEvents, putBotSwing } from "./botControl.ts";
import { config } from "./config.ts";

test("Swing updates contain only the requested flag, for both ON and OFF", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = config.controlToken;
  config.controlToken = "test-token";
  try {
    for (const enabled of [true, false]) {
      let calls = 0;
      globalThis.fetch = async (url, init) => {
        calls++;
        assert.equal(String(url), `${config.multibotApiUrl}/v1/bots/KXEURUSD15M`);
        assert.equal(init?.method, "PUT");
        assert.deepEqual(JSON.parse(String(init?.body)), { swing_enabled: enabled });
        assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer test-token");
        return new Response(null, { status: 204 });
      };
      assert.equal(await putBotSwing("KXEURUSD15M", enabled), true);
      assert.equal(calls, 1);
    }
    globalThis.fetch = async () => new Response(null, { status: 502 });
    assert.equal(await putBotSwing("KXEURUSD15M", true), false);
    globalThis.fetch = async () => { throw new Error("Offline"); };
    assert.equal(await putBotSwing("KXEURUSD15M", true), false);
    config.controlToken = undefined;
    globalThis.fetch = async () => { assert.fail("Must not send without credentials"); };
    assert.equal(await putBotSwing("KXEURUSD15M", true), false);
  } finally {
    globalThis.fetch = originalFetch;
    config.controlToken = originalToken;
  }
});

test("Bot polling reads Swing flags and defaults missing support to false", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = config.controlToken;
  config.controlToken = "test-token";
  try {
    globalThis.fetch = async () => Response.json({ bots: [
      { series: "KXEURUSD15M", swing_supported: true, swing_enabled: true },
      { series: "KXGBPUSD15M", swing_supported: true, swing_enabled: false },
      { series: "KXBTC15M" },
    ] });
    const bots = await fetchBotEvents();
    assert.equal(bots?.get("KXEURUSD15M")?.swingEnabled, true);
    assert.equal(bots?.get("KXGBPUSD15M")?.swingSupported, true);
    assert.equal(bots?.get("KXGBPUSD15M")?.swingEnabled, false);
    assert.equal(bots?.get("KXBTC15M")?.swingSupported, false);
  } finally {
    globalThis.fetch = originalFetch;
    config.controlToken = originalToken;
  }
});
