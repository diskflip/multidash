import { readFileSync } from "node:fs";
import { accountExportPath } from "./privateData.ts";

type Settlement = {
  ticker: string;
  event_ticker: string;
  market_result: string;
  yes_count_fp: string;
  yes_total_cost_dollars: string;
  no_count_fp: string;
  no_total_cost_dollars: string;
  fee_cost?: string;
  settled_time: string;
  revenue: number;
  value: number;
};

type Fill = {
  ticker: string;
  action: string;
  side: string;
  outcome_side: string;
  count_fp: string;
  yes_price_dollars: string;
  no_price_dollars: string;
  fee_cost: string;
  ts: number;
  created_time: string;
  is_taker: boolean;
  order_id: string;
};

const settlements: Settlement[] = JSON.parse(
  readFileSync(accountExportPath("raw-settlements.json"), "utf8")
).filter((s: Settlement) => !s.ticker.startsWith("KXSOL"));
const fills: Fill[] = JSON.parse(
  readFileSync(accountExportPath("raw-fills.json"), "utf8")
).filter((f: Fill) => !f.ticker.startsWith("KXSOL"));

function symbolOf(ticker: string): string {
  const m = ticker.match(/^(.+?)-\d{2}[A-Z]{3}\d{2}/);
  return m ? m[1] : ticker;
}

function pnlOf(s: Settlement) {
  const yesCount = parseFloat(s.yes_count_fp);
  const noCount = parseFloat(s.no_count_fp);
  const yesCost = parseFloat(s.yes_total_cost_dollars);
  const noCost = parseFloat(s.no_total_cost_dollars);
  const fee = parseFloat(s.fee_cost ?? "0");

  const yesCostPerContract = yesCount > 0 ? yesCost / yesCount : 0;
  const noCostPerContract = noCount > 0 ? noCost / noCount : 0;
  const hedgedPairs = Math.min(yesCount, noCount);

  const hedgedGain = hedgedPairs * 1 - hedgedPairs * (yesCostPerContract + noCostPerContract);
  const leftoverLoss =
    (yesCount - hedgedPairs) * yesCostPerContract + (noCount - hedgedPairs) * noCostPerContract;

  const net = hedgedGain - leftoverLoss - fee;
  const unhedgedSide: "yes" | "no" | "none" =
    yesCount > noCount ? "yes" : noCount > yesCount ? "no" : "none";
  const fullyUnhedged = hedgedPairs === 0 && (yesCount > 0 || noCount > 0);
  const totalCost = yesCost + noCost;
  const totalCount = yesCount + noCount;

  return {
    net,
    hedgedPairs,
    leftoverLoss,
    hedgedGain,
    fee,
    yesCount,
    noCount,
    yesCostPerContract,
    noCostPerContract,
    unhedgedSide,
    fullyUnhedged,
    totalCost,
    totalCount,
  };
}

type Row = ReturnType<typeof pnlOf> & { s: Settlement; symbol: string; day: string; hour: number };

const rows: Row[] = settlements.map((s) => {
  const p = pnlOf(s);
  const d = new Date(s.settled_time);
  return {
    ...p,
    s,
    symbol: symbolOf(s.ticker),
    day: d.toISOString().slice(0, 10),
    hour: d.getUTCHours(),
  };
});

rows.sort((a, b) => new Date(a.s.settled_time).getTime() - new Date(b.s.settled_time).getTime());

function fmt(n: number) {
  return (n >= 0 ? "+" : "") + n.toFixed(2);
}

// ---------- Overall ----------
const totalNet = rows.reduce((a, r) => a + r.net, 0);
const totalFees = rows.reduce((a, r) => a + r.fee, 0);
console.log("=".repeat(70));
console.log(`OVERALL (last ${rows.length} settled windows)`);
console.log("=".repeat(70));
console.log(`Total net P&L: $${fmt(totalNet)}  (fees: $${totalFees.toFixed(2)})`);
console.log(`Windows: ${rows.length}, winners: ${rows.filter((r) => r.net > 0).length}, losers: ${rows.filter((r) => r.net < 0).length}, flat: ${rows.filter((r) => r.net === 0).length}`);

// ---------- By day ----------
console.log("\n" + "=".repeat(70));
console.log("BY DAY");
console.log("=".repeat(70));
const byDay = new Map<string, Row[]>();
for (const r of rows) {
  if (!byDay.has(r.day)) byDay.set(r.day, []);
  byDay.get(r.day)!.push(r);
}
for (const [day, rs] of [...byDay.entries()].sort()) {
  const net = rs.reduce((a, r) => a + r.net, 0);
  const fullyUnhedged = rs.filter((r) => r.fullyUnhedged);
  const unhedgedLoss = fullyUnhedged.reduce((a, r) => a + r.net, 0);
  const wins = rs.filter((r) => r.net > 0).length;
  console.log(
    `${day}  windows=${String(rs.length).padStart(3)}  net=$${fmt(net).padStart(8)}  ` +
      `wins=${wins}/${rs.length}  fully-unhedged=${fullyUnhedged.length} (lost $${Math.abs(unhedgedLoss).toFixed(2)})`
  );
}

// ---------- By symbol ----------
console.log("\n" + "=".repeat(70));
console.log("BY MARKET SYMBOL");
console.log("=".repeat(70));
const bySymbol = new Map<string, Row[]>();
for (const r of rows) {
  if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, []);
  bySymbol.get(r.symbol)!.push(r);
}
for (const [sym, rs] of [...bySymbol.entries()].sort((a, b) => {
  const na = a[1].reduce((x, r) => x + r.net, 0);
  const nb = b[1].reduce((x, r) => x + r.net, 0);
  return na - nb;
})) {
  const net = rs.reduce((a, r) => a + r.net, 0);
  const fullyUnhedged = rs.filter((r) => r.fullyUnhedged).length;
  const avgCost = rs.reduce((a, r) => a + r.totalCost, 0) / rs.length;
  console.log(
    `${sym.padEnd(8)} windows=${String(rs.length).padStart(3)}  net=$${fmt(net).padStart(8)}  ` +
      `fully-unhedged=${fullyUnhedged}/${rs.length}  avg-stake=$${avgCost.toFixed(2)}`
  );
}

// ---------- Hedge ratio impact ----------
console.log("\n" + "=".repeat(70));
console.log("HEDGE OUTCOME BREAKDOWN");
console.log("=".repeat(70));
const fullyUnhedgedRows = rows.filter((r) => r.fullyUnhedged);
const partialRows = rows.filter((r) => !r.fullyUnhedged && r.hedgedPairs > 0 && r.leftoverLoss > 0.001);
const fullyHedgedRows = rows.filter((r) => r.hedgedPairs > 0 && r.leftoverLoss <= 0.001);
for (const [label, rs] of [
  ["Fully unhedged (one side only, total loss of stake)", fullyUnhedgedRows],
  ["Partially hedged (some leftover loss)", partialRows],
  ["Fully hedged (both sides matched)", fullyHedgedRows],
] as const) {
  const net = rs.reduce((a, r) => a + r.net, 0);
  console.log(`${label}: ${rs.length} windows, net $${fmt(net)}`);
}

// ---------- Entry price analysis from fills (opening fills only, first fill per order-side) ----------
console.log("\n" + "=".repeat(70));
console.log("ENTRY PRICE DISTRIBUTION (all fills, by effective entry price)");
console.log("=".repeat(70));
const buckets = new Map<string, number>();
for (const f of fills) {
  const price = f.side === "yes" ? parseFloat(f.yes_price_dollars) : parseFloat(f.no_price_dollars);
  const cents = Math.round(price * 100);
  const bucket = cents <= 6 ? "<=6c" : cents <= 10 ? "7-10c" : cents <= 15 ? "11-15c" : cents <= 25 ? "16-25c" : cents <= 50 ? "26-50c" : ">50c";
  buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
}
for (const [b, c] of [...buckets.entries()]) {
  console.log(`${b.padEnd(8)} ${c} fills`);
}

// ---------- Position sizing over time ----------
console.log("\n" + "=".repeat(70));
console.log("AVG STAKE SIZE PER WINDOW, BY DAY");
console.log("=".repeat(70));
for (const [day, rs] of [...byDay.entries()].sort()) {
  const avgStake = rs.reduce((a, r) => a + r.totalCost, 0) / rs.length;
  const maxStake = Math.max(...rs.map((r) => r.totalCost));
  console.log(`${day}  avg-stake=$${avgStake.toFixed(2)}  max-stake=$${maxStake.toFixed(2)}`);
}

// ---------- Worst windows ----------
console.log("\n" + "=".repeat(70));
console.log("10 WORST WINDOWS");
console.log("=".repeat(70));
for (const r of [...rows].sort((a, b) => a.net - b.net).slice(0, 10)) {
  console.log(
    `${r.s.settled_time.slice(0, 16)} ${r.symbol.padEnd(7)} ${r.s.ticker.padEnd(30)} net=$${fmt(r.net).padStart(8)} ` +
      `yes=${r.yesCount}@${(r.yesCostPerContract * 100).toFixed(1)}c no=${r.noCount}@${(r.noCostPerContract * 100).toFixed(1)}c result=${r.s.market_result}`
  );
}

// ---------- Best windows ----------
console.log("\n" + "=".repeat(70));
console.log("10 BEST WINDOWS");
console.log("=".repeat(70));
for (const r of [...rows].sort((a, b) => b.net - a.net).slice(0, 10)) {
  console.log(
    `${r.s.settled_time.slice(0, 16)} ${r.symbol.padEnd(7)} ${r.s.ticker.padEnd(30)} net=$${fmt(r.net).padStart(8)} ` +
      `yes=${r.yesCount}@${(r.yesCostPerContract * 100).toFixed(1)}c no=${r.noCount}@${(r.noCostPerContract * 100).toFixed(1)}c result=${r.s.market_result}`
  );
}

// ---------- Stake size vs outcome correlation ----------
console.log("\n" + "=".repeat(70));
console.log("STAKE SIZE BUCKETS vs OUTCOME");
console.log("=".repeat(70));
const stakeBuckets = new Map<string, Row[]>();
for (const r of rows) {
  const b = r.totalCost <= 2 ? "$0-2" : r.totalCost <= 5 ? "$2-5" : r.totalCost <= 10 ? "$5-10" : r.totalCost <= 20 ? "$10-20" : ">$20";
  if (!stakeBuckets.has(b)) stakeBuckets.set(b, []);
  stakeBuckets.get(b)!.push(r);
}
for (const [b, rs] of [...stakeBuckets.entries()]) {
  const net = rs.reduce((a, r) => a + r.net, 0);
  const fullyUnhedged = rs.filter((r) => r.fullyUnhedged).length;
  console.log(`${b.padEnd(8)} n=${String(rs.length).padStart(3)} net=$${fmt(net).padStart(8)} fully-unhedged=${fullyUnhedged}`);
}

// ---------- Fill count per window (how many partial fills / chasing) ----------
console.log("\n" + "=".repeat(70));
console.log("HOUR-OF-DAY (UTC) BREAKDOWN");
console.log("=".repeat(70));
const byHour = new Map<number, Row[]>();
for (const r of rows) {
  if (!byHour.has(r.hour)) byHour.set(r.hour, []);
  byHour.get(r.hour)!.push(r);
}
for (const [h, rs] of [...byHour.entries()].sort((a, b) => a[0] - b[0])) {
  const net = rs.reduce((a, r) => a + r.net, 0);
  console.log(`${String(h).padStart(2, "0")}:00 UTC  n=${String(rs.length).padStart(3)} net=$${fmt(net).padStart(8)}`);
}
