/**
 * deep-analyze-tf.ts
 *
 * For ONE timeframe, computes "feature importance" for every entry condition
 * by simulating outcomes when that condition (or pair of conditions) fires.
 *
 * Output: ranked tables answering:
 *   - Which SINGLE condition gives best WR + total PnL?
 *   - Which PAIR of conditions gives best result?
 *   - Which conditions are predictive vs noise?
 *   - LONG vs SHORT performance differences
 *
 * Usage:
 *   npx tsx tools/deep-analyze-tf.ts                           # 15m default
 *   npx tsx tools/deep-analyze-tf.ts --tf=1h --tp=3 --sl=1.5
 *   npx tsx tools/deep-analyze-tf.ts --tf=15m --candles=3000   # more data
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { Candle, EntryConditions } from "../utils/backtester";
import { calcRSI, calcStochRSI, calcMACD, calcBollinger, detectDivergence } from "../utils/indicators";

const BINANCE_REST = "https://api.binance.com/api/v3";

const args = process.argv.slice(2);
const argTF = args.find((a) => a.startsWith("--tf="))?.replace("--tf=", "") || "15m";
const argTP = parseFloat(args.find((a) => a.startsWith("--tp="))?.replace("--tp=", "") || "2");
const argSL = parseFloat(args.find((a) => a.startsWith("--sl="))?.replace("--sl=", "") || "1");
const argBars = parseInt(args.find((a) => a.startsWith("--bars="))?.replace("--bars=", "") || "50", 10);
const argCandles = parseInt(args.find((a) => a.startsWith("--candles="))?.replace("--candles=", "") || "1500", 10);
const argLeverage = parseInt(args.find((a) => a.startsWith("--lev="))?.replace("--lev=", "") || "100", 10);
// Phí mỗi side (Binance Futures: maker 0.02%, taker 0.05%). Round-trip = 2×.
const argFeePerSide = parseFloat(args.find((a) => a.startsWith("--fee="))?.replace("--fee=", "") || "0.05");
const FEE_ROUND_TRIP = argFeePerSide * 2;
const FEE_PNL_PER_TRADE = FEE_ROUND_TRIP * argLeverage; // raw % × leverage = PnL%

console.log(`=== deep-analyze-tf ===`);
console.log(`TF: ${argTF} · TP: +${argTP}% · SL: -${argSL}% · max bars: ${argBars} · candles: ${argCandles} · lev: x${argLeverage}`);
console.log(`Fee: ${argFeePerSide}% per side (round trip ${FEE_ROUND_TRIP}% raw = -${FEE_PNL_PER_TRADE.toFixed(2)}% PnL per trade)`);
console.log("");

const MIN_LOOKBACK = 50;

const COND_LABELS: Record<string, string> = {
  stochExtreme: "Stoch cực trị",
  rsiExtreme: "RSI cực trị",
  divergence: "Phân kỳ",
  bollingerTouch: "Bollinger touch",
  macdCross: "MACD đổi chiều",
};

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

interface CandleAnalysis {
  index: number;
  time: number;
  price: number;
  // Conditions for LONG (oversold / bullish setup)
  longConds: EntryConditions;
  // Conditions for SHORT (overbought / bearish setup)
  shortConds: EntryConditions;
  // Outcomes if entered LONG/SHORT here
  longOutcome: "WIN" | "LOSS" | "TIMEOUT";
  shortOutcome: "WIN" | "LOSS" | "TIMEOUT";
  longBars: number;
  shortBars: number;
}

function analyzeCondition(idx: number, candles: Candle[]): { longConds: EntryConditions; shortConds: EntryConditions } {
  // Default: nothing fires
  const empty: EntryConditions = { stochExtreme: false, rsiExtreme: false, divergence: false, bollingerTouch: false, macdCross: false };
  if (idx < MIN_LOOKBACK) return { longConds: { ...empty }, shortConds: { ...empty } };

  const closes = candles.slice(0, idx + 1).map((c) => c.close);
  const price = candles[idx].close;
  const rsi = calcRSI(closes);
  if (rsi === null) return { longConds: { ...empty }, shortConds: { ...empty } };
  const stoch = calcStochRSI(closes);
  const macd = calcMACD(closes);
  const bb = calcBollinger(closes);
  const div = closes.length >= 44 ? detectDivergence(closes) : null;
  const prevCloses = candles.slice(0, idx).map((c) => c.close);
  const prevMacd = prevCloses.length >= 35 ? calcMACD(prevCloses) : null;

  // LONG (oversold)
  const longConds: EntryConditions = {
    stochExtreme: stoch.k !== null && stoch.k < 5,
    rsiExtreme: rsi < 25,
    divergence: div === "BULLISH_DIV",
    bollingerTouch: bb.lower !== null && price <= bb.lower,
    macdCross: macd.histogram !== null && prevMacd !== null && prevMacd.histogram !== null && (
      (prevMacd.histogram < 0 && macd.histogram >= 0) || (macd.histogram > prevMacd.histogram)
    ),
  };
  // SHORT (overbought) — symmetric
  const shortConds: EntryConditions = {
    stochExtreme: stoch.k !== null && stoch.k > 95,
    rsiExtreme: rsi > 75,
    divergence: div === "BEARISH_DIV",
    bollingerTouch: bb.upper !== null && price >= bb.upper,
    macdCross: macd.histogram !== null && prevMacd !== null && prevMacd.histogram !== null && (
      (prevMacd.histogram > 0 && macd.histogram <= 0) || (macd.histogram < prevMacd.histogram)
    ),
  };
  return { longConds, shortConds };
}

function simulateOutcome(idx: number, candles: Candle[], type: "LONG" | "SHORT", tp: number, sl: number, maxBars: number): { outcome: "WIN" | "LOSS" | "TIMEOUT"; bars: number } {
  const entry = candles[idx].close;
  const maxIdx = Math.min(idx + maxBars, candles.length - 1);
  for (let i = idx + 1; i <= maxIdx; i++) {
    const c = candles[i];
    const highPct = ((c.high - entry) / entry) * 100;
    const lowPct = ((c.low - entry) / entry) * 100;
    if (type === "LONG") {
      if (lowPct <= -sl) return { outcome: "LOSS", bars: i - idx };
      if (highPct >= tp) return { outcome: "WIN", bars: i - idx };
    } else {
      if (highPct >= sl) return { outcome: "LOSS", bars: i - idx };
      if (-lowPct >= tp) return { outcome: "WIN", bars: i - idx };
    }
  }
  return { outcome: "TIMEOUT", bars: maxIdx - idx };
}

interface ConditionStats {
  label: string;
  fires: number;       // how many times this condition (or combo) fired
  wins: number;
  losses: number;
  timeouts: number;
  winRate: number;     // wins / (wins + losses + timeouts)
  realWinRate: number; // wins / (wins + losses) — excluding timeouts
  grossPnL: number;    // PnL trước fee (lý thuyết)
  feeCost: number;     // Tổng phí (fires × fee per trade)
  netPnL: number;      // grossPnL - feeCost (THỰC TẾ kiếm được)
  totalPnL: number;    // alias cho grossPnL (compat)
  avgBars: number;
}

function computeStats(label: string, indices: number[], analyses: CandleAnalysis[], type: "LONG" | "SHORT"): ConditionStats {
  let wins = 0, losses = 0, timeouts = 0, totalBars = 0;
  for (const i of indices) {
    const a = analyses[i];
    const outcome = type === "LONG" ? a.longOutcome : a.shortOutcome;
    const bars = type === "LONG" ? a.longBars : a.shortBars;
    if (outcome === "WIN") { wins++; totalBars += bars; }
    else if (outcome === "LOSS") { losses++; totalBars += bars; }
    else { timeouts++; totalBars += bars; }
  }
  const total = wins + losses + timeouts;
  const wlOnly = wins + losses;
  const winRate = total > 0 ? (wins / total) * 100 : 0;
  const realWinRate = wlOnly > 0 ? (wins / wlOnly) * 100 : 0;
  // Gross PnL = wins×TP - losses×SL (raw price %), then × leverage. Timeouts assumed flat.
  const grossPnL = (wins * argTP - losses * argSL) * argLeverage;
  // Fee cost: every fired trade pays round-trip fee, win/loss/timeout doesn't matter
  const feeCost = total * FEE_PNL_PER_TRADE;
  const netPnL = grossPnL - feeCost;
  return {
    label, fires: total, wins, losses, timeouts,
    winRate: Math.round(winRate * 10) / 10,
    realWinRate: Math.round(realWinRate * 10) / 10,
    grossPnL: Math.round(grossPnL),
    feeCost: Math.round(feeCost),
    netPnL: Math.round(netPnL),
    totalPnL: Math.round(grossPnL),
    avgBars: total > 0 ? Math.round(totalBars / total * 10) / 10 : 0,
  };
}

const COND_KEYS: (keyof EntryConditions)[] = ["stochExtreme", "rsiExtreme", "divergence", "bollingerTouch", "macdCross"];

async function main() {
  console.log(`Fetching ${argCandles} ${argTF} candles...`);
  const candles = await fetchKlines(argTF, argCandles);
  console.log(`Got ${candles.length} candles · ${new Date(candles[0].time).toISOString()} → ${new Date(candles[candles.length - 1].time).toISOString()}`);
  console.log("");

  console.log("Computing conditions + simulating outcomes for each candle...");
  const t0 = Date.now();
  const analyses: CandleAnalysis[] = [];
  for (let i = 0; i < candles.length - argBars; i++) {
    const { longConds, shortConds } = analyzeCondition(i, candles);
    const longSim = simulateOutcome(i, candles, "LONG", argTP, argSL, argBars);
    const shortSim = simulateOutcome(i, candles, "SHORT", argTP, argSL, argBars);
    analyses.push({
      index: i, time: candles[i].time, price: candles[i].close,
      longConds, shortConds,
      longOutcome: longSim.outcome, shortOutcome: shortSim.outcome,
      longBars: longSim.bars, shortBars: shortSim.bars,
    });
    if (i % 200 === 0) process.stdout.write(`  ${i}/${candles.length - argBars}\r`);
  }
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s. Analyzed ${analyses.length} candles.`);
  console.log("");

  // ---- BASELINE: random entry ----
  const allIndices = analyses.map((a) => a.index);
  const baseLong = computeStats("[BASELINE: vào LONG mọi nến]", allIndices, analyses, "LONG");
  const baseShort = computeStats("[BASELINE: vào SHORT mọi nến]", allIndices, analyses, "SHORT");

  console.log("===========================================");
  console.log(`📊 BASELINE — vào MỌI nến (random)`);
  console.log("===========================================");
  console.log(`LONG  : ${baseLong.fires}L · WR ${baseLong.realWinRate}% · Gross ${baseLong.grossPnL >= 0 ? "+" : ""}${baseLong.grossPnL}% · Fee -${baseLong.feeCost}% · NET ${baseLong.netPnL >= 0 ? "+" : ""}${baseLong.netPnL}%`);
  console.log(`SHORT : ${baseShort.fires}L · WR ${baseShort.realWinRate}% · Gross ${baseShort.grossPnL >= 0 ? "+" : ""}${baseShort.grossPnL}% · Fee -${baseShort.feeCost}% · NET ${baseShort.netPnL >= 0 ? "+" : ""}${baseShort.netPnL}%`);
  console.log("");

  // ---- SINGLE CONDITION ANALYSIS ----
  console.log("===========================================");
  console.log(`📊 TỪNG ĐIỀU KIỆN RIÊNG LẺ`);
  console.log("===========================================");

  const singleResults: { type: "LONG" | "SHORT"; cond: string; stats: ConditionStats }[] = [];
  for (const cond of COND_KEYS) {
    const longIdx = analyses.filter((a) => a.longConds[cond]).map((a) => a.index);
    const shortIdx = analyses.filter((a) => a.shortConds[cond]).map((a) => a.index);
    if (longIdx.length > 0) singleResults.push({ type: "LONG", cond, stats: computeStats(`LONG ${COND_LABELS[cond]}`, longIdx, analyses, "LONG") });
    if (shortIdx.length > 0) singleResults.push({ type: "SHORT", cond, stats: computeStats(`SHORT ${COND_LABELS[cond]}`, shortIdx, analyses, "SHORT") });
  }
  // Sort by NET PnL (after fees) — that's what user actually keeps
  singleResults.sort((a, b) => b.stats.netPnL - a.stats.netPnL);
  console.log("Sort theo NET PnL% (sau fee Binance):");
  console.log("");
  console.log("Type    Condition              Fires  realWR   Gross PnL    Fee     NET PnL");
  console.log("─".repeat(90));
  for (const r of singleResults) {
    const profitMark = r.stats.netPnL > 0 ? "🟢" : "🔴";
    console.log(
      `${r.type.padEnd(7)} ${COND_LABELS[r.cond].padEnd(22)} ${String(r.stats.fires).padStart(5)}  ${String(r.stats.realWinRate).padStart(5)}%   ${(r.stats.grossPnL >= 0 ? "+" : "") + r.stats.grossPnL.toString().padStart(7)}%   -${String(r.stats.feeCost).padStart(6)}%   ${(r.stats.netPnL >= 0 ? "+" : "") + r.stats.netPnL.toString().padStart(7)}% ${profitMark}`
    );
  }
  console.log("");

  // ---- PAIRWISE COMBINATIONS ----
  console.log("===========================================");
  console.log(`📊 CẶP 2 ĐIỀU KIỆN (yêu cầu CẢ HAI fire)`);
  console.log("===========================================");
  const pairResults: { type: "LONG" | "SHORT"; conds: [string, string]; stats: ConditionStats }[] = [];
  for (let i = 0; i < COND_KEYS.length; i++) {
    for (let j = i + 1; j < COND_KEYS.length; j++) {
      const ci = COND_KEYS[i], cj = COND_KEYS[j];
      const longIdx = analyses.filter((a) => a.longConds[ci] && a.longConds[cj]).map((a) => a.index);
      const shortIdx = analyses.filter((a) => a.shortConds[ci] && a.shortConds[cj]).map((a) => a.index);
      if (longIdx.length >= 3) pairResults.push({ type: "LONG", conds: [ci, cj], stats: computeStats(`LONG ${COND_LABELS[ci]} + ${COND_LABELS[cj]}`, longIdx, analyses, "LONG") });
      if (shortIdx.length >= 3) pairResults.push({ type: "SHORT", conds: [ci, cj], stats: computeStats(`SHORT ${COND_LABELS[ci]} + ${COND_LABELS[cj]}`, shortIdx, analyses, "SHORT") });
    }
  }
  pairResults.sort((a, b) => b.stats.netPnL - a.stats.netPnL);
  console.log("Sort theo NET PnL% sau fee (chỉ show pairs có ≥3 lệnh):");
  console.log("");
  console.log("Type    Pair                                          Fires  realWR   Gross     Fee      NET");
  console.log("─".repeat(105));
  for (const r of pairResults.slice(0, 20)) {
    const pairLabel = `${COND_LABELS[r.conds[0]]} + ${COND_LABELS[r.conds[1]]}`;
    const profitMark = r.stats.netPnL > 0 ? "🟢" : "🔴";
    console.log(
      `${r.type.padEnd(7)} ${pairLabel.padEnd(45)} ${String(r.stats.fires).padStart(5)}  ${String(r.stats.realWinRate).padStart(5)}%   ${(r.stats.grossPnL >= 0 ? "+" : "") + r.stats.grossPnL.toString().padStart(6)}%  -${String(r.stats.feeCost).padStart(5)}%   ${(r.stats.netPnL >= 0 ? "+" : "") + r.stats.netPnL.toString().padStart(6)}% ${profitMark}`
    );
  }
  console.log("");

  // ---- RECOMMENDATIONS ----
  console.log("===========================================");
  console.log(`💡 GỢI Ý`);
  console.log("===========================================");

  const bestLong = singleResults.filter((r) => r.type === "LONG" && r.stats.netPnL > 0).slice(0, 3);
  const bestShort = singleResults.filter((r) => r.type === "SHORT" && r.stats.netPnL > 0).slice(0, 3);
  console.log("");
  console.log(`🟢 TOP 3 LONG conditions (NET PnL+ sau fee):`);
  if (bestLong.length === 0) console.log("  (Không có rule LONG nào lời sau fee)");
  bestLong.forEach((r, i) => console.log(`  ${i+1}. ${COND_LABELS[r.cond]} — ${r.stats.fires}L · realWR ${r.stats.realWinRate}% · NET +${r.stats.netPnL}% (gross +${r.stats.grossPnL}%, fee -${r.stats.feeCost}%)`));
  console.log("");
  console.log(`🔴 TOP 3 SHORT conditions (NET PnL+ sau fee):`);
  if (bestShort.length === 0) console.log("  (Không có rule SHORT nào lời sau fee)");
  bestShort.forEach((r, i) => console.log(`  ${i+1}. ${COND_LABELS[r.cond]} — ${r.stats.fires}L · realWR ${r.stats.realWinRate}% · NET +${r.stats.netPnL}% (gross +${r.stats.grossPnL}%, fee -${r.stats.feeCost}%)`));
  console.log("");

  const bestPair = pairResults.filter((r) => r.stats.netPnL > 0).slice(0, 5);
  console.log(`🏆 TOP 5 PAIRS (NET PnL+ sau fee):`);
  if (bestPair.length === 0) console.log("  (Không có pair nào lời sau fee — fee giết hết!)");
  bestPair.forEach((r, i) => {
    const pairLabel = `${COND_LABELS[r.conds[0]]} + ${COND_LABELS[r.conds[1]]}`;
    console.log(`  ${i+1}. ${r.type} ${pairLabel} — ${r.stats.fires}L · realWR ${r.stats.realWinRate}% · NET +${r.stats.netPnL}% (gross +${r.stats.grossPnL}%, fee -${r.stats.feeCost}%)`);
  });
  console.log("");
  console.log(`💡 Recommendation:`);
  if (FEE_PNL_PER_TRADE > 5) {
    console.log(`  Fee/trade = ${FEE_PNL_PER_TRADE}% PnL → quá cao với leverage x${argLeverage}.`);
    console.log(`  - Hạ leverage xuống x10-20 để giảm fee impact: --lev=10 → fee chỉ ${(FEE_ROUND_TRIP * 10).toFixed(2)}%/lệnh`);
    console.log(`  - Hoặc dùng MAKER (limit order): --fee=0.02 → fee ${(0.02 * 2 * argLeverage).toFixed(2)}%/lệnh`);
  }

  // Write JSON
  const outDir = join(__dirname, "..", "assets");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `deep_analysis_${argTF}.json`);
  writeFileSync(outPath, JSON.stringify({
    tf: argTF, tp: argTP, sl: argSL, maxBars: argBars, leverage: argLeverage,
    candlesAnalyzed: analyses.length,
    period: { from: new Date(candles[0].time).toISOString(), to: new Date(candles[candles.length - 1].time).toISOString() },
    baseline: { long: baseLong, short: baseShort },
    singles: singleResults.map((r) => ({ type: r.type, condition: r.cond, ...r.stats })),
    pairs: pairResults.map((r) => ({ type: r.type, conditions: r.conds, ...r.stats })),
  }, null, 2));
  console.log("");
  console.log(`✅ Wrote ${outPath}`);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
