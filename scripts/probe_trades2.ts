import { config } from "../server/config.ts";

async function getJson(path: string, query = ""): Promise<any> {
  const res = await fetch(`${config.restBaseUrl}${path}${query}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} ${res.status} ${text}`);
  return JSON.parse(text);
}

async function main() {
  const events = await getJson("/trade-api/v2/events", "?series_ticker=KXSILVER15M&status=open&limit=5");
  console.log("EVENTS:", JSON.stringify(events, null, 2).slice(0, 2000));

  const markets = await getJson("/trade-api/v2/markets", "?series_ticker=KXSILVER15M&status=open&limit=5");
  console.log("\nMARKETS:", JSON.stringify(markets, null, 2).slice(0, 2000));
}
main();
