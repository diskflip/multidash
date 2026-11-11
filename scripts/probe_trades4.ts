import { config } from "../server/config.ts";
async function getJson(path: string, query = ""): Promise<any> {
  const res = await fetch(`${config.restBaseUrl}${path}${query}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} ${res.status} ${text}`);
  return JSON.parse(text);
}
async function main() {
  // pick a recent CLOSED silver ticker from our settlement data
  const ticker = "KXSILVER15M-26AUG181430-30";
  const t1 = await getJson("/trade-api/v2/markets/trades", `?ticker=${ticker}&limit=1000`);
  console.log("count with just ticker+limit:", t1.trades.length, "cursor:", t1.cursor);
  console.log("first:", t1.trades[0]?.created_time, "last:", t1.trades[t1.trades.length-1]?.created_time);
}
main();
