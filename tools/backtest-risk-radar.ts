/**
 * backtest-risk-radar.ts
 *
 * Backtest strategy LONG khi Risk Radar cho tín hiệu:
 *   riskScore > 90  AND  longCheck = 5/5
 *   = tất cả 8 warnings (5 LONG + 3 SHORT) đều SAFE
 *
 * Entry condition intersect (theo logic useRiskRadar.ts):
 *   1. HTF 4h = FLAT                (|emaDist4h| ≤ 0.5%)
 *   2. |emaDist1h| < 2%             (giá không xa EMA50)
 *   3. 30 ≤ RSI 1h ≤ 70
 *   4. ATR% 15m ≥ 0.3%
 *   5. MACD 1h Hist ≥ -50
 *
 * Mega backtest (Phương án C):
 *   - 20K candles 1h BTCUSDT (~2.3Y)
 *   - Multi TP/SL sweep: 3/1, 5/2, 10/3, 15/5
 *   - Leverage sweep: 1x, 5x, 10x, 20x
 *   - Baseline comparison: LONG random cùng period (không filter)
 *   - Regime breakdown: signal theo HTF FLAT/UP/DOWN %
 *   - Output JSON: assets/backtest_risk90_long5_5.json
 *
 * Usage:
 *   npx tsx tools/backtest-risk-radar.ts
 *   npx tsx tools/backtest-risk-radar.ts --candles=20000 --fee=0.05
 */

import { writeFileSync } from "fs";
import { join } from "path";
import {
  calcRSISeriesAligned,
  calcMACDSeries,
  calcEMASeries,
} from "../utils/indicators";

const BINANCE = "https://api.binance.com/api/v3";
const args = process.argv.slice(2);
const getArg = (k: string, d: string) => {
  const a = args.find((x) => x.startsWith(`--${k}=`));
  return a ? a.split("=")[1] : d;
};

const CANDLES_1H = parseInt(getArg("candles", "20000"), 10);
const FEE_PCT = parseFloat(getArg("fee", "0.05")); // per side, roundtrip = 2x
const MAX_HOLD = parseInt(getArg("hold", "100"), 10); // 100h ~ 4 days
const OUT_PATH = join("assets", "backtest_risk90_long5_5.json");

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ── Fetch helpers ───────────────────────────────────────────────────────────
async function fetchKlines(interval: string, total: number): Promise<Candle[]> {
  const all: Candle[] = [];
  let endTime: number | undefined;
  while (all.length < total) {
    const limit = Math.min(1000, total - all.length);
    const params = new URLSearchParams({
      symbol: "BTCUSDT",
      interval,
      limit: String(limit),
    });
    if (endTime) params.set("endTime", String(endTime));
    const res = await fetch(`${BINANCE}/klines?${params}`);
    const data: any[] = await res.json();
    if (!data.length) break;
    const batch = data.map((k) => ({
      time: k[0],
      open: +k[1],
      high: +k[2],
      low: +k[3],
      close: +k[4],
      volume: +k[5],
    }));
    all.unshift(...batch);
    endTime = batch[0].time - 1;
    await new Promise((r) => setTimeout(r, 80));
  }
  const m = new Map<number, Candle>();
  for (const c of all) m.set(c.time, c);
  return [...m.values()].sort((a, b) => a.time - b.time);
}

// ── ATR% series ─────────────────────────────────────────────────────────────
function calcATRPctSeries(
  candles: Candle[],
  period = 14
): (number | null)[] {
  const n = candles.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (n < period + 1) return out;
  const trs: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i === 0) trs.push(candles[i].high - candles[i].low);
    else {
      const tr = Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low - candles[i - 1].close)
      );
      trs.push(tr);
    }
  }
  // Wilder smoothing
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = (atr / candles[period - 1].close) * 100;
  for (let i = period; i < n; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    out[i] = (atr / candles[i].close) * 100;
  }
  return out;
}

// ── Binary search: largest index in arr with arr[k].time ≤ t ───────────────
function findIndexAt(arr: Candle[], t: number): number {
  let lo = 0,
    hi = arr.length - 1,
    ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].time <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

// ── Trade simulator ─────────────────────────────────────────────────────────
interface Trade {
  entryIdx: number;
  entryTime: number;
  entryPrice: number;
  exitIdx: number;
  exitTime: number;
  exitPrice: number;
  rawPnlPct: number; // price % before leverage/fee
  outcome: "TP" | "SL" | "TIMEOUT";
  holdBars: number;
  // Context
  rsi1h: number;
  macdHist1h: number;
  atrPct1h: number;
  atrPct15m: number;
  emaDist1h: number;
  emaDist4h: number;
  htf4hState: "UP" | "DOWN" | "FLAT";
}

function simulateLong(
  candles: Candle[],
  entryIdx: number,
  tpPct: number,
  slPct: number,
  maxHold: number
): { exitIdx: number; rawPnlPct: number; outcome: "TP" | "SL" | "TIMEOUT" } {
  const entryPrice = candles[entryIdx].close;
  const tpPrice = entryPrice * (1 + tpPct / 100);
  const slPrice = entryPrice * (1 - slPct / 100);
  const endIdx = Math.min(entryIdx + maxHold, candles.length - 1);
  for (let j = entryIdx + 1; j <= endIdx; j++) {
    // Conservative: if both hit same candle, assume SL first (pessimistic)
    if (candles[j].low <= slPrice) {
      return { exitIdx: j, rawPnlPct: -slPct, outcome: "SL" };
    }
    if (candles[j].high >= tpPrice) {
      return { exitIdx: j, rawPnlPct: tpPct, outcome: "TP" };
    }
  }
  const exitPrice = candles[endIdx].close;
  return {
    exitIdx: endIdx,
    rawPnlPct: ((exitPrice - entryPrice) / entryPrice) * 100,
    outcome: "TIMEOUT",
  };
}

// ── Metrics ─────────────────────────────────────────────────────────────────
interface Metrics {
  total: number;
  wins: number;
  losses: number;
  timeouts: number;
  winRate: number;
  avgWinPct: number;
  avgLossPct: number;
  sumPnlPct: number;
  profitFactor: number;
  maxDDPct: number;
  avgHoldBars: number;
  expectancyPct: number;
}

function computeMetrics(trades: Trade[], lev: number, fee: number): Metrics {
  const FEE_ROUND = fee * 2 * lev;
  let wins = 0,
    losses = 0,
    timeouts = 0;
  let sumWin = 0,
    sumLoss = 0;
  let equity = 0,
    peak = 0,
    maxDD = 0;
  let sumHold = 0;
  const pnls: number[] = [];
  for (const t of trades) {
    const pnl = t.rawPnlPct * lev - FEE_ROUND;
    pnls.push(pnl);
    sumHold += t.holdBars;
    if (t.outcome === "TP") wins++;
    else if (t.outcome === "SL") losses++;
    else timeouts++;
    if (pnl > 0) sumWin += pnl;
    else sumLoss += pnl;
    equity += pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }
  const total = trades.length;
  const winCount = pnls.filter((p) => p > 0).length;
  const lossCount = pnls.filter((p) => p <= 0).length;
  const winRate = total ? (winCount / total) * 100 : 0;
  const avgWin = winCount ? sumWin / winCount : 0;
  const avgLoss = lossCount ? sumLoss / lossCount : 0;
  const sumPnl = pnls.reduce((a, b) => a + b, 0);
  const pf = sumLoss < 0 ? sumWin / Math.abs(sumLoss) : sumWin > 0 ? 99 : 0;
  const exp = total ? sumPnl / total : 0;
  return {
    total,
    wins,
    losses,
    timeouts,
    winRate: +winRate.toFixed(2),
    avgWinPct: +avgWin.toFixed(3),
    avgLossPct: +avgLoss.toFixed(3),
    sumPnlPct: +sumPnl.toFixed(2),
    profitFactor: +pf.toFixed(2),
    maxDDPct: +maxDD.toFixed(2),
    avgHoldBars: +(total ? sumHold / total : 0).toFixed(1),
    expectancyPct: +exp.toFixed(3),
  };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log("═".repeat(70));
  console.log("🎯 BACKTEST RISK RADAR — riskScore > 90 AND longCheck = 5/5");
  console.log("═".repeat(70));
  console.log(`Period: ${CANDLES_1H} candles 1h (~${(CANDLES_1H / 24 / 365).toFixed(1)}Y)`);
  console.log(`Max hold: ${MAX_HOLD}h · Fee: ${FEE_PCT}% per side`);
  console.log("");

  // Fetch data
  console.log("📡 Fetching klines …");
  const CANDLES_15M = CANDLES_1H * 4; // 1h = 4× 15m
  const CANDLES_4H = Math.ceil(CANDLES_1H / 4); // 1h = 1/4 of 4h
  const t0 = Date.now();
  const [k1h, k15m, k4h] = await Promise.all([
    fetchKlines("1h", CANDLES_1H),
    fetchKlines("15m", CANDLES_15M),
    fetchKlines("4h", CANDLES_4H + 200),
  ]);
  console.log(
    `  ✓ 1h: ${k1h.length} · 15m: ${k15m.length} · 4h: ${k4h.length} (${(
      (Date.now() - t0) /
      1000
    ).toFixed(1)}s)`
  );

  // Precompute series
  console.log("🧮 Computing indicator series …");
  const closes1h = k1h.map((c) => c.close);
  const closes4h = k4h.map((c) => c.close);
  const rsi1hSeries = calcRSISeriesAligned(closes1h, 14);
  const macd1hSeries = calcMACDSeries(closes1h, 12, 26, 9);
  const ema50_1hSeries = calcEMASeries(closes1h, 50);
  const ema50_4hSeries = calcEMASeries(closes4h, 50);
  const atrPct1hSeries = calcATRPctSeries(k1h, 14);
  const atrPct15mSeries = calcATRPctSeries(k15m, 14);

  // ── Scan entries ──
  console.log("🔎 Scanning entry signals …");
  const signals: number[] = [];
  const ctx: { [i: number]: Omit<Trade, "entryIdx" | "entryTime" | "entryPrice" | "exitIdx" | "exitTime" | "exitPrice" | "rawPnlPct" | "outcome" | "holdBars"> } = {};
  const startIdx = 100; // warmup for indicators
  const endIdx = k1h.length - MAX_HOLD - 1;

  let regimeUp = 0,
    regimeDown = 0,
    regimeFlat = 0;

  for (let i = startIdx; i <= endIdx; i++) {
    const rsi = rsi1hSeries[i];
    const macdH = macd1hSeries.histogram[i];
    const ema1h = ema50_1hSeries[i];
    const atr1h = atrPct1hSeries[i];
    if (rsi === null || macdH === null || ema1h === null || atr1h === null) continue;

    const close = k1h[i].close;
    const emaDist1h = ((close - ema1h) / ema1h) * 100;

    // Align 4h
    const idx4h = findIndexAt(k4h, k1h[i].time);
    if (idx4h < 0) continue;
    const ema4h = ema50_4hSeries[idx4h];
    if (ema4h === null) continue;
    const close4h = k4h[idx4h].close;
    const emaDist4h = ((close4h - ema4h) / ema4h) * 100;
    let htf: "UP" | "DOWN" | "FLAT";
    if (emaDist4h > 0.5) htf = "UP";
    else if (emaDist4h < -0.5) htf = "DOWN";
    else htf = "FLAT";

    // Align 15m
    const idx15m = findIndexAt(k15m, k1h[i].time);
    if (idx15m < 0) continue;
    const atr15m = atrPct15mSeries[idx15m];
    if (atr15m === null) continue;

    // Regime tally (over ALL valid 1h bars for base rate)
    if (htf === "UP") regimeUp++;
    else if (htf === "DOWN") regimeDown++;
    else regimeFlat++;

    // Check 8 warnings (ALL must be safe)
    // 5 LONG warnings:
    const long1_safe = htf !== "DOWN";
    const long2_safe = !(emaDist1h > 2);
    const long3_safe = !(rsi < 30);
    const long4_safe = !(atr15m < 0.3);
    const long5_safe = !(macdH < -50);
    // 3 SHORT warnings:
    const short1_safe = htf !== "UP";
    const short2_safe = !(emaDist1h < -2);
    const short3_safe = !(rsi > 70);

    const allSafe =
      long1_safe &&
      long2_safe &&
      long3_safe &&
      long4_safe &&
      long5_safe &&
      short1_safe &&
      short2_safe &&
      short3_safe;

    if (allSafe) {
      signals.push(i);
      ctx[i] = {
        rsi1h: rsi,
        macdHist1h: macdH,
        atrPct1h: atr1h,
        atrPct15m: atr15m,
        emaDist1h,
        emaDist4h,
        htf4hState: htf,
      };
    }
  }

  const totalBars = regimeUp + regimeDown + regimeFlat;
  console.log(`  ✓ Signals: ${signals.length} / ${totalBars} bars (${((signals.length / totalBars) * 100).toFixed(2)}%)`);
  console.log(`  ✓ Regime all bars: UP ${((regimeUp / totalBars) * 100).toFixed(1)}% · DOWN ${((regimeDown / totalBars) * 100).toFixed(1)}% · FLAT ${((regimeFlat / totalBars) * 100).toFixed(1)}%`);

  // ── TP/SL sweep ──
  const TP_SL_COMBOS: { tp: number; sl: number }[] = [
    { tp: 3, sl: 1 },
    { tp: 5, sl: 2 },
    { tp: 10, sl: 3 },
    { tp: 15, sl: 5 },
  ];
  const LEVERAGES = [1, 5, 10, 20];

  console.log("\n📊 Running TP/SL × Leverage sweep …");
  const results: any = { config: { candles: CANDLES_1H, fee: FEE_PCT, maxHold: MAX_HOLD }, signals_count: signals.length, combos: [] };

  // Build base trades per TP/SL
  const baseTradesPerCombo: { [key: string]: Trade[] } = {};
  for (const { tp, sl } of TP_SL_COMBOS) {
    const key = `${tp}_${sl}`;
    const trades: Trade[] = [];
    for (const i of signals) {
      const sim = simulateLong(k1h, i, tp, sl, MAX_HOLD);
      trades.push({
        entryIdx: i,
        entryTime: k1h[i].time,
        entryPrice: k1h[i].close,
        exitIdx: sim.exitIdx,
        exitTime: k1h[sim.exitIdx].time,
        exitPrice: k1h[sim.exitIdx].close,
        rawPnlPct: sim.rawPnlPct,
        outcome: sim.outcome,
        holdBars: sim.exitIdx - i,
        ...ctx[i],
      });
    }
    baseTradesPerCombo[key] = trades;
  }

  // Compute metrics
  console.log("\n┌─────────┬─────┬────────┬────────┬─────────┬──────────┬──────────┬─────────┬─────────┐");
  console.log("│ TP/SL   │ Lev │ N      │ WR %   │ Sum %   │ AvgWin   │ AvgLoss  │ PF      │ MaxDD   │");
  console.log("├─────────┼─────┼────────┼────────┼─────────┼──────────┼──────────┼─────────┼─────────┤");
  for (const { tp, sl } of TP_SL_COMBOS) {
    const key = `${tp}_${sl}`;
    const trades = baseTradesPerCombo[key];
    for (const lev of LEVERAGES) {
      const m = computeMetrics(trades, lev, FEE_PCT);
      const entry = { tp, sl, leverage: lev, ...m };
      results.combos.push(entry);
      console.log(
        `│ +${tp}%/-${sl}%  │ ${String(lev).padStart(2)}x │ ${String(m.total).padStart(6)} │ ${m.winRate.toFixed(1).padStart(6)} │ ${m.sumPnlPct.toFixed(1).padStart(7)} │ ${m.avgWinPct.toFixed(2).padStart(8)} │ ${m.avgLossPct.toFixed(2).padStart(8)} │ ${m.profitFactor.toFixed(2).padStart(7)} │ ${m.maxDDPct.toFixed(1).padStart(7)} │`
      );
    }
  }
  console.log("└─────────┴─────┴────────┴────────┴─────────┴──────────┴──────────┴─────────┴─────────┘");

  // ── Baseline: LONG mỗi 1h candle KHÔNG filter ──
  console.log("\n📏 Baseline: LONG every 1h candle (NO filter) — để so edge …");
  // Sample mỗi 10 candles (không thì quá nhiều trades, warped)
  const baselineEntries: number[] = [];
  for (let i = startIdx; i <= endIdx; i += 10) baselineEntries.push(i);

  results.baseline = [];
  console.log("┌─────────┬─────┬────────┬────────┬─────────┬──────────┬──────────┬─────────┐");
  console.log("│ TP/SL   │ Lev │ N      │ WR %   │ Sum %   │ AvgWin   │ AvgLoss  │ PF      │");
  console.log("├─────────┼─────┼────────┼────────┼─────────┼──────────┼──────────┼─────────┤");
  for (const { tp, sl } of TP_SL_COMBOS) {
    const baseTrades: Trade[] = [];
    for (const i of baselineEntries) {
      const sim = simulateLong(k1h, i, tp, sl, MAX_HOLD);
      baseTrades.push({
        entryIdx: i,
        entryTime: k1h[i].time,
        entryPrice: k1h[i].close,
        exitIdx: sim.exitIdx,
        exitTime: k1h[sim.exitIdx].time,
        exitPrice: k1h[sim.exitIdx].close,
        rawPnlPct: sim.rawPnlPct,
        outcome: sim.outcome,
        holdBars: sim.exitIdx - i,
        rsi1h: 0,
        macdHist1h: 0,
        atrPct1h: 0,
        atrPct15m: 0,
        emaDist1h: 0,
        emaDist4h: 0,
        htf4hState: "FLAT",
      });
    }
    for (const lev of [1, 10]) {
      const m = computeMetrics(baseTrades, lev, FEE_PCT);
      results.baseline.push({ tp, sl, leverage: lev, ...m });
      console.log(
        `│ +${tp}%/-${sl}%  │ ${String(lev).padStart(2)}x │ ${String(m.total).padStart(6)} │ ${m.winRate.toFixed(1).padStart(6)} │ ${m.sumPnlPct.toFixed(1).padStart(7)} │ ${m.avgWinPct.toFixed(2).padStart(8)} │ ${m.avgLossPct.toFixed(2).padStart(8)} │ ${m.profitFactor.toFixed(2).padStart(7)} │`
      );
    }
  }
  console.log("└─────────┴─────┴────────┴────────┴─────────┴──────────┴──────────┴─────────┘");

  // ── Regime breakdown (of signals) ──
  console.log("\n🌐 Regime breakdown of signals:");
  const sigUp = signals.filter((i) => ctx[i].htf4hState === "UP").length;
  const sigDown = signals.filter((i) => ctx[i].htf4hState === "DOWN").length;
  const sigFlat = signals.filter((i) => ctx[i].htf4hState === "FLAT").length;
  console.log(`  Signals HTF UP:   ${sigUp}  (${((sigUp / signals.length) * 100).toFixed(1)}%)`);
  console.log(`  Signals HTF DOWN: ${sigDown}  (${((sigDown / signals.length) * 100).toFixed(1)}%)`);
  console.log(`  Signals HTF FLAT: ${sigFlat}  (${((sigFlat / signals.length) * 100).toFixed(1)}%)`);
  console.log("  (Expected: gần 100% FLAT vì điều kiện intersect đòi FLAT)");
  results.regime_breakdown = { UP: sigUp, DOWN: sigDown, FLAT: sigFlat };

  // ── Sample trades (5 biggest win + loss of TP5/SL2 lev=10) ──
  const primary = baseTradesPerCombo["5_2"];
  const sorted = [...primary].sort((a, b) => b.rawPnlPct - a.rawPnlPct);
  console.log("\n🏆 Top 5 wins (TP5/SL2):");
  for (const t of sorted.slice(0, 5)) {
    const d = new Date(t.entryTime).toISOString().slice(0, 16);
    console.log(`  ${d}  rsi=${t.rsi1h.toFixed(1)}  emaD1h=${t.emaDist1h.toFixed(2)}%  ATR1h=${t.atrPct1h.toFixed(2)}%  → ${t.outcome} ${t.rawPnlPct >= 0 ? "+" : ""}${t.rawPnlPct.toFixed(2)}% in ${t.holdBars}h`);
  }
  console.log("\n💀 Top 5 losses (TP5/SL2):");
  for (const t of sorted.slice(-5).reverse()) {
    const d = new Date(t.entryTime).toISOString().slice(0, 16);
    console.log(`  ${d}  rsi=${t.rsi1h.toFixed(1)}  emaD1h=${t.emaDist1h.toFixed(2)}%  ATR1h=${t.atrPct1h.toFixed(2)}%  → ${t.outcome} ${t.rawPnlPct >= 0 ? "+" : ""}${t.rawPnlPct.toFixed(2)}% in ${t.holdBars}h`);
  }

  results.sample_top_wins = sorted.slice(0, 10).map((t) => ({
    time: new Date(t.entryTime).toISOString(),
    rsi1h: t.rsi1h,
    emaDist1h: t.emaDist1h,
    atrPct1h: t.atrPct1h,
    rawPnlPct: t.rawPnlPct,
    outcome: t.outcome,
    holdBars: t.holdBars,
  }));
  results.sample_top_losses = sorted.slice(-10).reverse().map((t) => ({
    time: new Date(t.entryTime).toISOString(),
    rsi1h: t.rsi1h,
    emaDist1h: t.emaDist1h,
    atrPct1h: t.atrPct1h,
    rawPnlPct: t.rawPnlPct,
    outcome: t.outcome,
    holdBars: t.holdBars,
  }));

  // ── Save ──
  writeFileSync(OUT_PATH, JSON.stringify(results, null, 2));
  console.log(`\n💾 Saved → ${OUT_PATH}`);

  // ── Verdict ──
  console.log("\n═".repeat(70));
  console.log("🎯 VERDICT");
  console.log("═".repeat(70));
  const best = results.combos.reduce((a: any, b: any) =>
    a.sumPnlPct > b.sumPnlPct ? a : b
  );
  const bestPF = results.combos.reduce((a: any, b: any) =>
    a.profitFactor > b.profitFactor ? a : b
  );
  console.log(`• Best sumPnL: TP${best.tp}/SL${best.sl} @ ${best.leverage}x → +${best.sumPnlPct}% (WR ${best.winRate}%, N=${best.total})`);
  console.log(`• Best PF:     TP${bestPF.tp}/SL${bestPF.sl} @ ${bestPF.leverage}x → PF ${bestPF.profitFactor} (WR ${bestPF.winRate}%, N=${bestPF.total})`);
  const baseline_5_2_10x = results.baseline.find((r: any) => r.tp === 5 && r.sl === 2 && r.leverage === 10);
  const filtered_5_2_10x = results.combos.find((r: any) => r.tp === 5 && r.sl === 2 && r.leverage === 10);
  if (baseline_5_2_10x && filtered_5_2_10x) {
    const edgeWR = filtered_5_2_10x.winRate - baseline_5_2_10x.winRate;
    const edgePF = filtered_5_2_10x.profitFactor - baseline_5_2_10x.profitFactor;
    console.log(`• Edge vs baseline (TP5/SL2 10x): WR +${edgeWR.toFixed(1)}%  ·  PF +${edgePF.toFixed(2)}`);
  }
  console.log("═".repeat(70));
}

main().catch((e) => {
  console.error("❌ Error:", e);
  process.exit(1);
});
