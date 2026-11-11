async function getJson(path: string, query = ""): Promise<any> {
  const res = await fetch(`https://external-api.kalshi.com${path}${query}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} ${res.status} ${text}`);
  return JSON.parse(text);
}
async function main() {
  const ticker = "KXBTC15M-26AUG232045-45";
  const closeTs = Math.floor(new Date("2026-08-24T00:45:07.081142Z").getTime()/1000);
  const startTs = closeTs - 25*60;
  const body = await getJson(`/trade-api/v2/series/KXBTC15M/markets/${ticker}/candlesticks`, `?start_ts=${startTs}&end_ts=${closeTs}&period_interval=1`);
  console.log(JSON.stringify(body, null, 2));
}
main();
