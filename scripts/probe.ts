import { signRequest } from "../server/kalshiAuth.ts";
import { config } from "../server/config.ts";

async function getJson(path: string, query = ""): Promise<any> {
  const headers = { ...signRequest("GET", path), Accept: "application/json" };
  const res = await fetch(`${config.restBaseUrl}${path}${query}`, { headers });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${path} ${res.status} ${text}`);
  }
  return JSON.parse(text);
}

async function main() {
  const fills = await getJson("/trade-api/v2/portfolio/fills", "?limit=5");
  console.log("FILLS SAMPLE:", JSON.stringify(fills, null, 2));

  const settlements = await getJson("/trade-api/v2/portfolio/settlements", "?limit=5");
  console.log("SETTLEMENTS SAMPLE:", JSON.stringify(settlements, null, 2));
}

main();
