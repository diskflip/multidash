import { readFileSync } from "node:fs";
import { config as loadEnv } from "dotenv";
import { MARKETS } from "../markets.config.ts";

loadEnv();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required env var ${name}. Copy server/.env.example to .env and fill it in.`
    );
  }
  return value;
}

export const config = {
  restBaseUrl: process.env.KALSHI_REST_BASE_URL ?? "https://external-api.kalshi.com",
  wsUrl: process.env.KALSHI_WS_URL ?? "wss://external-api-ws.kalshi.com/trade-api/ws/v2",

  apiKeyId: required("KALSHI_API_KEY_ID"),
  privateKeyPem: readFileSync(required("KALSHI_PRIVATE_KEY_PATH"), "utf8"),

  // Keep every summary market live; enabled controls default chart visibility only.
  markets: MARKETS,

  marketPollIntervalMs: Number(process.env.MARKET_POLL_INTERVAL_MS ?? 15_000),
  localWsPort: Number(process.env.LOCAL_WS_PORT ?? 4001),

  // The live trading bot's own control API (see server/botControl.ts) —
  // optional. Without CONTROL_TOKEN set, bot control just stays disabled
  // (logs once, no-ops) rather than crashing the whole backend, since
  // everything else here works fine without it. MULTIBOT_API_URL is
  // multibot's own Cloudflare quick tunnel, which changes on every multibot
  // restart — the fallback below is just a placeholder, not a real default.
  multibotApiUrl: process.env.MULTIBOT_API_URL ?? "http://127.0.0.1:8765",
  controlToken: process.env.CONTROL_TOKEN,
};
