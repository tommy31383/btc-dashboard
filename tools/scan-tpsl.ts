/**
 * scan-tpsl.ts
 *
 * For ONE timeframe, scans many TP/SL combos × conditions to find the
 * (condition, TP, SL) that MAXIMIZES NET PnL (after fees).
 *
 * Bigger TP/SL = fee is smaller % of move = better fee tolerance.
 * Smaller TP/SL = trade more often but fee eats profit.
 *
 * Output: ranked grid showing top combos by NET PnL.
 *
 * Usage:
 *   npx tsx tools/scan-tpsl.ts                  # 15m default
 *   npx tsx tools/scan-tpsl.ts --tf=1h --lev=20
 *   npx tsx tools/scan-tpsl.ts --candles=20000  # bigger window
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { Candle, EntryConditions } from "../utils/backtester";
import { calcRSI, calcStochRSI, calcMACD, calcBollinger, detectDivergence } from "../utils/indicators";

const BINANCE_REST = "https://api.binance.com/api/v3";

const args = process.argv.slice(2);
const argTF = args.find((a) => a.startsWith("--tf="))?.replace("--tf=", "") || "15m";
const argBars = parseInt(args.find((a) => a.startsWith("--bars="))?.replace("--bars=", "") || "100", 10);
const argCandles = parseInt(args.find((a) => a.startsWith("--candles="))?.replace("--candles=", "") || "10000", 10);
const argLeverage = parseInt(args.find((a) => a.startsWith("--lev="))?.replace("--lev=", "") || "100", 10);
const argFeePerSide = parseFloat(args.find((a) => a.startsWith("--fee="))?.replace("--fee=", "") || "0.05");

const FEE_ROUND_TRIP = argFeePerSide * 2;
const FEE_PNL_PER_TRADE = FEE_ROUND_TRIP * argLeverage;

// Grid of TP/SL combos to scan (R:R between 1.5 and 4)
const TPSL_COMBOS: [number, number][] = [
  [1, 0.5],   [2, 1],     [3, 1.5],  [3, 1],     [5, 2],
  [5, 2.5],   [5, 3],     [8, 3],    [8, 4],     [10, 3],
  [10, 5],    [15, 5],    [15, 7],   [20, 8],    [20, 10],
];

const COND_LABELS: Record<string, string> = {
  stochExtreme: "Stoch", rsiExtreme: "RSI", divergence: "Div",
  bollingerTouch: "BB", macdCross: "MACD",
};
// NOTE: stochExtreme đã loại (K>95/K<5 hiếm)
// NOTE: rsiExtreme cũng loại (phân tích top 100 rule profit: chỉ 6% xuất hiện trên 15m, 0 single-profit)
// Chỉ còn 3 cond: divergence + bollingerTouch + macdCross → banner fire thường xuyên hơn, giữ chất lượng rule
const COND_KEYS: (keyof EntryConditions)[] = ["divergence", "bollingerTouch", "macdCross"];

console.log(`=== scan-tpsl ===`);
console.log(`TF: ${argTF} · candles: ${argCandles} · max bars: ${argBars} · lev: x${argLeverage} · fee: ${argFeePerSide}%/side (${FEE_PNL_PER_TRADE.toFixed(1)}% PnL/trade)`);
console.log(`Scanning ${TPSL_COMBOS.length} TP/SL combos × ${COND_KEYS.length} singles + ${COND_KEYS.length * (COND_KEYS.length - 1) / 2} pairs × 2 sides`);
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

const MIN_LOOKBACK = 50;

function computeAllConditions(candles: Candle[]): { longConds: EntryConditions; shortConds: EntryConditions }[] {
  const result: { longConds: EntryConditions; shortConds: EntryConditions }[] = [];
  const empty: EntryConditions = { stochExtreme: false, rsiExtreme: false, divergence: false, bollingerTouch: false, macdCross: false };
  for (let idx = 0; idx < candles.length; idx++) {
    if (idx < MIN_LOOKBACK) { result.push({ longConds: { ...empty }, shortConds: { ...empty } }); continue; }
    const closes = candles.slice(0, idx + 1).map((c) => c.close);
    const price = candles[idx].close;
    const rsi = calcRSI(closes);
    if (rsi === null) { result.push({ longConds: { ...empty }, shortConds: { ...empty } }); continue; }
    const stoch = calcStochRSI(closes);
    const macd = calcMACD(closes);
    const bb = calcBollinger(closes);
    const div = closes.length >= 44 ? detectDivergence(closes) : null;
    const prevCloses = candles.slice(0, idx).map((c) => c.close);
    const prevMacd = prevCloses.length >= 35 ? calcMACD(prevCloses) : null;
    const longConds: EntryConditions = {
      stochExtreme: stoch.k !== null && stoch.k < 5,
      rsiExtreme: rsi < 25,
      divergence: div === "BULLISH_DIV",
      bollingerTouch: bb.lower !== null && price <= bb.lower,
      macdCross: macd.histogram !== null && prevMacd !== null && prevMacd.histogram !== null && (
        (prevMacd.histogram < 0 && macd.histogram >= 0) || (macd.histogram > prevMacd.histogram)
      ),
    };
    const shortConds: EntryConditions = {
      stochExtreme: stoch.k !== null && stoch.k > 95,
      rsiExtreme: rsi > 75,
      divergence: div === "BEARISH_DIV",
      bollingerTouch: bb.upper !== null && price >= bb.upper,
      macdCross: macd.histogram !== null && prevMacd !== null && prevMacd.histogram !== null && (
        (prevMacd.histogram > 0 && macd.histogram <= 0) || (macd.histogram < prevMacd.histogram)
      ),
    };
    result.push({ longConds, shortConds });
    if (idx % 1000 === 0) process.stdout.write(`  conds ${idx}/${candles.length}\r`);
  }
  return result;
}

interface SimResult {
  outcome: "WIN" | "LOSS" | "TIMEOUT";
  holdBars: number; // number of bars between entry and exit (1 for next-bar exits)
}

function simulateOutcome(idx: number, candles: Candle[], type: "LONG" | "SHORT", tp: number, sl: number, maxBars: number): SimResult {
  const entry = candles[idx].close;
  const maxIdx = Math.min(idx + maxBars, candles.length - 1);
  for (let i = idx + 1; i <= maxIdx; i++) {
    const c = candles[i];
    const highPct = ((c.high - entry) / entry) * 100;
    const lowPct = ((c.low - entry) / entry) * 100;
    if (type === "LONG") {
      if (lowPct <= -sl) return { outcome: "LOSS", holdBars: i - idx };
      if (highPct >= tp) return { outcome: "WIN", holdBars: i - idx };
    } else {
      if (highPct >= sl) return { outcome: "LOSS", holdBars: i - idx };
      if (-lowPct >= tp) return { outcome: "WIN", holdBars: i - idx };
    }
  }
  return { outcome: "TIMEOUT", holdBars: maxIdx - idx };
}

interface ScanResult {
  type: "LONG" | "SHORT";
  conditionLabel: string;
  conditionKeys: string[];
  tp: number;
  sl: number;
  fires: number;
  wins: number;
  losses: number;
  timeouts: number;
  realWR: number;
  grossPnL: number;
  feeCost: number;
  netPnL: number;
  avgHoldBars: number;
}

async function main() {
  console.log(`Fetching ${argCandles} ${argTF} candles...`);
  const candles = await fetchKlines(argTF, argCandles);
  console.log(`Got ${candles.length} candles · ${new Date(candles[0].time).toISOString()} → ${new Date(candles[candles.length - 1].time).toISOString()}`);
  console.log("");

  console.log("Computing conditions...");
  const t0 = Date.now();
  const conds = computeAllConditions(candles);
  console.log(`\nDone conditions in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // For efficiency, precompute outcomes for each (entry candle, TP, SL) — too many combos.
  // Instead, for each TP/SL, compute outcomes on the fly per candle.
  // 9950 candles × 15 TP/SL × 2 sides × 16 condition_groups = ~5M sim ops, fast.

  const allResults: ScanResult[] = [];

  // Build condition groups: 5 singles + 10 pairs
  type CondGroup = { label: string; keys: (keyof EntryConditions)[] };
  const groups: CondGroup[] = [];
  for (const c of COND_KEYS) groups.push({ label: COND_LABELS[c], keys: [c] });
  for (let i = 0; i < COND_KEYS.length; i++) {
    for (let j = i + 1; j < COND_KEYS.length; j++) {
      groups.push({
        label: `${COND_LABELS[COND_KEYS[i]]}+${COND_LABELS[COND_KEYS[j]]}`,
        keys: [COND_KEYS[i], COND_KEYS[j]],
      });
    }
  }

  for (const [tp, sl] of TPSL_COMBOS) {
    const t1 = Date.now();
    process.stdout.write(`\nScanning TP+${tp}%/SL-${sl}%...`);
    // For each group × side, find indices that fire and simulate
    for (const grp of groups) {
      for (const side of ["LONG", "SHORT"] as const) {
        const indices: number[] = [];
        for (let i = 0; i < candles.length - argBars; i++) {
          const c = side === "LONG" ? conds[i].longConds : conds[i].shortConds;
          if (grp.keys.every((k) => c[k])) indices.push(i);
        }
        if (indices.length < 5) continue;

        let wins = 0, losses = 0, timeouts = 0, sumHold = 0;
        for (const i of indices) {
          const sim = simulateOutcome(i, candles, side, tp, sl, argBars);
          if (sim.outcome === "WIN") wins++;
          else if (sim.outcome === "LOSS") losses++;
          else timeouts++;
          sumHold += sim.holdBars;
        }
        const total = wins + losses + timeouts;
        const wlOnly = wins + losses;
        const realWR = wlOnly > 0 ? (wins / wlOnly) * 100 : 0;
        const grossPnL = (wins * tp - losses * sl) * argLeverage;
        const feeCost = total * FEE_PNL_PER_TRADE;
        const netPnL = grossPnL - feeCost;
        const avgHoldBars = total > 0 ? sumHold / total : 0;

        allResults.push({
          type: side, conditionLabel: grp.label, conditionKeys: grp.keys,
          tp, sl, fires: total, wins, losses, timeouts,
          realWR: Math.round(realWR * 10) / 10,
          grossPnL: Math.round(grossPnL),
          feeCost: Math.round(feeCost),
          netPnL: Math.round(netPnL),
          avgHoldBars: Math.round(avgHoldBars * 10) / 10,
        });
      }
    }
    process.stdout.write(` done in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  }
  console.log("\n");

  // Show top 30 by NET PnL
  allResults.sort((a, b) => b.netPnL - a.netPnL);
  console.log("===========================================");
  console.log(`🏆 TOP 30 COMBO theo NET PnL (${argTF}, lev x${argLeverage}, fee ${argFeePerSide}%)`);
  console.log("===========================================");
  console.log("Side    Condition             TP    SL    R:R   Fires  WR     Gross    Fee      NET");
  console.log("─".repeat(100));
  for (const r of allResults.slice(0, 30)) {
    if (r.netPnL <= 0) break;
    const rr = (r.tp / r.sl).toFixed(1);
    console.log(
      `${r.type.padEnd(7)} ${r.conditionLabel.padEnd(20)} +${String(r.tp).padStart(3)}%  -${String(r.sl).padStart(3)}%  1:${rr.padStart(3)}  ${String(r.fires).padStart(5)}  ${String(r.realWR).padStart(5)}%  ${(r.grossPnL >= 0 ? "+" : "") + r.grossPnL.toString().padStart(6)}%  -${String(r.feeCost).padStart(5)}%   ${(r.netPnL >= 0 ? "+" : "") + r.netPnL.toString().padStart(6)}% 🟢`
    );
  }

  const profitable = allResults.filter((r) => r.netPnL > 0);
  console.log("");
  console.log(`Tổng combo lời (NET > 0): ${profitable.length}/${allResults.length}`);

  // Best per side+type
  console.log("");
  console.log("===========================================");
  console.log(`💡 BEST RULE PER SIDE`);
  console.log("===========================================");
  const bestLong = allResults.filter((r) => r.type === "LONG" && r.netPnL > 0)[0];
  const bestShort = allResults.filter((r) => r.type === "SHORT" && r.netPnL > 0)[0];
  if (bestLong) {
    console.log(`🟢 BEST LONG : ${bestLong.conditionLabel} TP+${bestLong.tp}% SL-${bestLong.sl}%`);
    console.log(`   ${bestLong.fires}L · WR ${bestLong.realWR}% · Gross +${bestLong.grossPnL}% · Fee -${bestLong.feeCost}% · NET +${bestLong.netPnL}%`);
  }
  if (bestShort) {
    console.log(`🔴 BEST SHORT: ${bestShort.conditionLabel} TP+${bestShort.tp}% SL-${bestShort.sl}%`);
    console.log(`   ${bestShort.fires}L · WR ${bestShort.realWR}% · Gross +${bestShort.grossPnL}% · Fee -${bestShort.feeCost}% · NET +${bestShort.netPnL}%`);
  }

  // Output JSON
  const outDir = join(__dirname, "..", "assets");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `scan_tpsl_${argTF}.json`);
  writeFileSync(outPath, JSON.stringify({
    tf: argTF, leverage: argLeverage, feePerSide: argFeePerSide,
    candlesAnalyzed: candles.length,
    period: { from: new Date(candles[0].time).toISOString(), to: new Date(candles[candles.length - 1].time).toISOString() },
    profitable: profitable.length,
    total: allResults.length,
    topResults: allResults.slice(0, 100),
  }, null, 2));
  console.log("");
  console.log(`✅ Wrote ${outPath}`);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
