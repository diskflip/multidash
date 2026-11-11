import { fetchTickerRealizedPnl } from "../server/portfolio.ts";
const result = await fetchTickerRealizedPnl("KXSILVER15M-26AUG182100-00");
console.log("Computed realized P&L for KXSILVER15M-26AUG182100-00:", result);
