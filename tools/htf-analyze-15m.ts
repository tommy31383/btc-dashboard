/**
 * htf-analyze-15m.ts
 *
 * Test if Higher-Timeframe trend filter improves 15m signals.
 *
 * Specifically: when "Stoch cực trị" fires on 15m, does adding "1H trend
 * agrees" (or 4H trend agrees) make the trade more reliable?
 *
 * Methodology:
 *  - Fetch 15m candles + 1H candles + 4H candles (same period)
 *  - For each 15m signal, look up the 1H/4H trend AT THAT MOMENT
 *  - Test scenarios:
 *      A. Stoch alone (baseline)
 *      B. Stoch + 1H trend agrees
 *      C. Stoch + 4H trend agrees
 *      D. Stoch + BOTH 1H and 4H agree (strongest filter)
 *  - Show WR / count / PnL / fee-adjusted for each
 *
 * Trend definition: "UP" if close > EMA50, "DOWN" if close < EMA50, "FLAT" otherwise.
 *
 * Usage:
 *   npx tsx tools/htf-analyze-15m.ts
 *   npx tsx tools/htf-analyze-15m.ts --candles=5000 --tp=2 --sl=1 --lev=100 --fee=0.05
 */

import { Candle } from "../utils/backtester";
import { calcStochRSI } from "../utils/indicators";

const BINANCE_REST = "https://api.binance.com/api/v3";

const args = process.argv.slice(2);
const argCandles = parseInt(args.find((a) => a.startsWith("--candles="))?.replace("--candles=", "") || "5000", 10);
const argTP = parseFloat(args.find((a) => a.startsWith("--tp="))?.replace("--tp=", "") || "2");
const argSL = parseFloat(args.find((a) => a.startsWith("--sl="))?.replace("--sl=", "") || "1");
const argBars = parseInt(args.find((a) => a.startsWith("--bars="))?.replace("--bars=", "") || "50", 10);
const argLeverage = parseInt(args.find((a) => a.startsWith("--lev="))?.replace("--lev=", "") || "100", 10);
const argFee = parseFloat(args.find((a) => a.startsWith("--fee="))?.replace("--fee=", "") || "0.05");

const FEE_PNL_PER_TRADE = argFee * 2 * argLeverage;

console.log(`=== htf-analyze-15m ===`);
console.log(`Candles: ${argCandles} 15m · TP+${argTP}% / SL-${argSL}% · max ${argBars} bars · lev x${argLeverage} · fee ${argFee}%/side (${FEE_PNL_PER_TRADE}% PnL/trade)`);
console.log("");

async function fetchKlines(interval: string, total: number): Promise<Candle[]> {
  const all: Candle[] = [];
  let endTime: number | undefined;
  while (all.length < total) {
    const remaining = total - all.length;
    const limit = Math.min(1000, remaining);
    const params = new URLSearchParams({ symbol: "BTCUSDT", interval, limit: String(limit) });
    if (endTime) params.set("endTime", String(endTime));
    const res = await fetch(`${BINANCE_REST}/klines?${params.toString()}`);
    const data: any[] = await res.json();
    if (data.length === 0) break;
    const batch: Candle[] = data.map((k) => ({
      time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
      low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
    }));
    all.unshift(...batch);
    endTime = batch[0].time - 1;
    await new Promise((r) => setTimeout(r, 100));
  }
  const byTime = new Map<number, Candle>();
  for (const c of all) byTime.set(c.time, c);
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

// EMA calc — incremental for efficiency
function calcEMASeries(closes: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = ema;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

type Trend = "UP" | "DOWN" | "FLAT";

function trendAt(closes: number[], emaSeries: (number | null)[], idx: number): Trend {
  if (idx < 0 || idx >= closes.length) return "FLAT";
  const ema = emaSeries[idx];
  if (ema === null) return "FLAT";
  const price = closes[idx];
  const diffPct = ((price - ema) / ema) * 100;
  if (diffPct > 0.3) return "UP";    // > 0.3% above EMA = uptrend
  if (diffPct < -0.3) return "DOWN"; // < -0.3% below EMA = downtrend
  return "FLAT";
}

function simulateOutcome(idx: number, candles: Candle[], side: "LONG" | "SHORT"): "WIN" | "LOSS" | "TIMEOUT" {
  const entry = candles[idx].close;
  const maxIdx = Math.min(idx + argBars, candles.length - 1);
  for (let i = idx + 1; i <= maxIdx; i++) {
    const c = candles[i];
    const highPct = ((c.high - entry) / entry) * 100;
    const lowPct = ((c.low - entry) / entry) * 100;
    if (side === "LONG") {
      if (lowPct <= -argSL) return "LOSS";
      if (highPct >= argTP) return "WIN";
    } else {
      if (highPct >= argSL) return "LOSS";
      if (-lowPct >= argTP) return "WIN";
    }
  }
  return "TIMEOUT";
}

interface ScenarioResult {
  label: string;
  fires: number;
  wins: number;
  losses: number;
  timeouts: number;
  realWR: number;
  grossPnL: number;
  feeCost: number;
  netPnL: number;
}

function computeStats(label: string, indices: number[], side: "LONG" | "SHORT", candles: Candle[]): ScenarioResult {
  let wins = 0, losses = 0, timeouts = 0;
  for (const i of indices) {
    const o = simulateOutcome(i, candles, side);
    if (o === "WIN") wins++;
    else if (o === "LOSS") losses++;
    else timeouts++;
  }
  const total = wins + losses + timeouts;
  const wlOnly = wins + losses;
  const realWR = wlOnly > 0 ? Math.round((wins / wlOnly) * 1000) / 10 : 0;
  const grossPnL = (wins * argTP - losses * argSL) * argLeverage;
  const feeCost = total * FEE_PNL_PER_TRADE;
  return {
    label, fires: total, wins, losses, timeouts, realWR,
    grossPnL: Math.round(grossPnL),
    feeCost: Math.round(feeCost),
    netPnL: Math.round(grossPnL - feeCost),
  };
}

async function main() {
  console.log(`Fetching 15m candles...`);
  const c15 = await fetchKlines("15m", argCandles);
  const days = (argCandles * 15) / 60 / 24;
  console.log(`Got ${c15.length} 15m candles · ${days.toFixed(1)} ngày`);

  const c1h_count = Math.ceil(argCandles / 4) + 100;
  console.log(`Fetching ${c1h_count} 1H candles for HTF trend...`);
  const c1h = await fetchKlines("1h", c1h_count);
  console.log(`Got ${c1h.length} 1H candles`);

  const c4h_count = Math.ceil(argCandles / 16) + 50;
  console.log(`Fetching ${c4h_count} 4H candles for super-HTF trend...`);
  const c4h = await fetchKlines("4h", c4h_count);
  console.log(`Got ${c4h.length} 4H candles`);
  console.log("");

  console.log("Computing EMAs + trend series...");
  const closes15 = c15.map((c) => c.close);
  const closes1h = c1h.map((c) => c.close);
  const closes4h = c4h.map((c) => c.close);
  const ema50_1h = calcEMASeries(closes1h, 50);
  const ema50_4h = calcEMASeries(closes4h, 50);

  // For each 15m candle, find which 1H/4H candle "contains" it (i.e., last 1H/4H candle whose time ≤ 15m time)
  function findHTFIndex(htfCandles: Candle[], time15m: number): number {
    // Binary search for largest htfIndex where htfCandles[htfIndex].time <= time15m
    let lo = 0, hi = htfCandles.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (htfCandles[mid].time <= time15m) { best = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return best;
  }

  // Precompute trend at each 15m candle
  const trend1h: Trend[] = c15.map((c) => {
    const idx = findHTFIndex(c1h, c.time);
    return idx >= 0 ? trendAt(closes1h, ema50_1h, idx) : "FLAT";
  });
  const trend4h: Trend[] = c15.map((c) => {
    const idx = findHTFIndex(c4h, c.time);
    return idx >= 0 ? trendAt(closes4h, ema50_4h, idx) : "FLAT";
  });

  // Compute Stoch on 15m
  console.log("Computing 15m Stoch + scanning signals...");
  const stochOversold: boolean[] = new Array(c15.length).fill(false);
  const stochOverbought: boolean[] = new Array(c15.length).fill(false);
  const MIN_LOOKBACK = 50;
  for (let i = MIN_LOOKBACK; i < c15.length; i++) {
    const closes = closes15.slice(0, i + 1);
    const stoch = calcStochRSI(closes);
    if (stoch.k !== null) {
      stochOversold[i] = stoch.k < 5;
      stochOverbought[i] = stoch.k > 95;
    }
  }

  // Print trend distribution stats
  const trendDist1h = { UP: 0, DOWN: 0, FLAT: 0 };
  const trendDist4h = { UP: 0, DOWN: 0, FLAT: 0 };
  for (const t of trend1h) trendDist1h[t]++;
  for (const t of trend4h) trendDist4h[t]++;
  console.log("");
  console.log(`Phân bố trend trong ${days.toFixed(0)} ngày:`);
  console.log(`  1H: UP ${(trendDist1h.UP / c15.length * 100).toFixed(0)}% · DOWN ${(trendDist1h.DOWN / c15.length * 100).toFixed(0)}% · FLAT ${(trendDist1h.FLAT / c15.length * 100).toFixed(0)}%`);
  console.log(`  4H: UP ${(trendDist4h.UP / c15.length * 100).toFixed(0)}% · DOWN ${(trendDist4h.DOWN / c15.length * 100).toFixed(0)}% · FLAT ${(trendDist4h.FLAT / c15.length * 100).toFixed(0)}%`);
  console.log("");

  // ============ LONG scenarios ============
  console.log("===========================================");
  console.log(`🟢 LONG (Stoch < 5 = oversold)`);
  console.log("===========================================");

  const longBaseline: number[] = [];
  const long1hUp: number[] = [];        // LONG with 1H uptrend (wind in back)
  const long1hDown: number[] = [];      // LONG against 1H downtrend (wind in face)
  const long4hUp: number[] = [];
  const long4hDown: number[] = [];
  const longBothUp: number[] = [];      // 1H AND 4H both UP
  const longBothDown: number[] = [];    // both DOWN

  for (let i = MIN_LOOKBACK; i < c15.length - argBars; i++) {
    if (!stochOversold[i]) continue;
    longBaseline.push(i);
    if (trend1h[i] === "UP") long1hUp.push(i);
    if (trend1h[i] === "DOWN") long1hDown.push(i);
    if (trend4h[i] === "UP") long4hUp.push(i);
    if (trend4h[i] === "DOWN") long4hDown.push(i);
    if (trend1h[i] === "UP" && trend4h[i] === "UP") longBothUp.push(i);
    if (trend1h[i] === "DOWN" && trend4h[i] === "DOWN") longBothDown.push(i);
  }

  const longResults = [
    computeStats("Baseline (Stoch<5 alone)", longBaseline, "LONG", c15),
    computeStats("+ 1H trend UP (cùng chiều)", long1hUp, "LONG", c15),
    computeStats("+ 1H trend DOWN (ngược chiều)", long1hDown, "LONG", c15),
    computeStats("+ 4H trend UP (cùng chiều)", long4hUp, "LONG", c15),
    computeStats("+ 4H trend DOWN (ngược chiều)", long4hDown, "LONG", c15),
    computeStats("+ 1H UP & 4H UP (cả 2 cùng chiều)", longBothUp, "LONG", c15),
    computeStats("+ 1H DOWN & 4H DOWN (cả 2 ngược)", longBothDown, "LONG", c15),
  ];

  console.log("Scenario                                    Fires  realWR   Gross    Fee     NET");
  console.log("─".repeat(95));
  for (const r of longResults) {
    const mark = r.netPnL > 0 ? "🟢" : "🔴";
    console.log(
      `${r.label.padEnd(42)} ${String(r.fires).padStart(5)}  ${String(r.realWR).padStart(5)}%   ${(r.grossPnL >= 0 ? "+" : "") + r.grossPnL.toString().padStart(6)}%  -${String(r.feeCost).padStart(5)}%  ${(r.netPnL >= 0 ? "+" : "") + r.netPnL.toString().padStart(6)}% ${mark}`
    );
  }

  // ============ SHORT scenarios ============
  console.log("");
  console.log("===========================================");
  console.log(`🔴 SHORT (Stoch > 95 = overbought)`);
  console.log("===========================================");

  const shortBaseline: number[] = [];
  const short1hUp: number[] = [];
  const short1hDown: number[] = [];
  const short4hUp: number[] = [];
  const short4hDown: number[] = [];
  const shortBothUp: number[] = [];
  const shortBothDown: number[] = [];

  for (let i = MIN_LOOKBACK; i < c15.length - argBars; i++) {
    if (!stochOverbought[i]) continue;
    shortBaseline.push(i);
    if (trend1h[i] === "UP") short1hUp.push(i);
    if (trend1h[i] === "DOWN") short1hDown.push(i);
    if (trend4h[i] === "UP") short4hUp.push(i);
    if (trend4h[i] === "DOWN") short4hDown.push(i);
    if (trend1h[i] === "UP" && trend4h[i] === "UP") shortBothUp.push(i);
    if (trend1h[i] === "DOWN" && trend4h[i] === "DOWN") shortBothDown.push(i);
  }

  const shortResults = [
    computeStats("Baseline (Stoch>95 alone)", shortBaseline, "SHORT", c15),
    computeStats("+ 1H trend DOWN (cùng chiều)", short1hDown, "SHORT", c15),
    computeStats("+ 1H trend UP (ngược chiều)", short1hUp, "SHORT", c15),
    computeStats("+ 4H trend DOWN (cùng chiều)", short4hDown, "SHORT", c15),
    computeStats("+ 4H trend UP (ngược chiều)", short4hUp, "SHORT", c15),
    computeStats("+ 1H DOWN & 4H DOWN (cả 2 cùng chiều)", shortBothDown, "SHORT", c15),
    computeStats("+ 1H UP & 4H UP (cả 2 ngược)", shortBothUp, "SHORT", c15),
  ];

  console.log("Scenario                                    Fires  realWR   Gross    Fee     NET");
  console.log("─".repeat(95));
  for (const r of shortResults) {
    const mark = r.netPnL > 0 ? "🟢" : "🔴";
    console.log(
      `${r.label.padEnd(42)} ${String(r.fires).padStart(5)}  ${String(r.realWR).padStart(5)}%   ${(r.grossPnL >= 0 ? "+" : "") + r.grossPnL.toString().padStart(6)}%  -${String(r.feeCost).padStart(5)}%  ${(r.netPnL >= 0 ? "+" : "") + r.netPnL.toString().padStart(6)}% ${mark}`
    );
  }

  // ============ Summary insights ============
  console.log("");
  console.log("===========================================");
  console.log(`💡 INSIGHTS`);
  console.log("===========================================");

  const longBase = longResults[0];
  const long1hUpR = longResults[1];
  const longBothUpR = longResults[5];
  const shortBase = shortResults[0];
  const short1hDownR = shortResults[1];
  const shortBothDownR = shortResults[5];

  const liftLong1h = long1hUpR.realWR - longBase.realWR;
  const liftLongBoth = longBothUpR.realWR - longBase.realWR;
  const liftShort1h = short1hDownR.realWR - shortBase.realWR;
  const liftShortBoth = shortBothDownR.realWR - shortBase.realWR;

  console.log("");
  console.log(`LONG WR lift khi thêm filter:`);
  console.log(`  + 1H UP        : ${liftLong1h >= 0 ? "+" : ""}${liftLong1h.toFixed(1)}% (giữ ${long1hUpR.fires}/${longBase.fires} = ${(long1hUpR.fires / longBase.fires * 100).toFixed(0)}% lệnh)`);
  console.log(`  + 1H+4H UP     : ${liftLongBoth >= 0 ? "+" : ""}${liftLongBoth.toFixed(1)}% (giữ ${longBothUpR.fires}/${longBase.fires} = ${(longBothUpR.fires / longBase.fires * 100).toFixed(0)}% lệnh)`);
  console.log("");
  console.log(`SHORT WR lift khi thêm filter:`);
  console.log(`  + 1H DOWN      : ${liftShort1h >= 0 ? "+" : ""}${liftShort1h.toFixed(1)}% (giữ ${short1hDownR.fires}/${shortBase.fires} = ${(short1hDownR.fires / shortBase.fires * 100).toFixed(0)}% lệnh)`);
  console.log(`  + 1H+4H DOWN   : ${liftShortBoth >= 0 ? "+" : ""}${liftShortBoth.toFixed(1)}% (giữ ${shortBothDownR.fires}/${shortBase.fires} = ${(shortBothDownR.fires / shortBase.fires * 100).toFixed(0)}% lệnh)`);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
