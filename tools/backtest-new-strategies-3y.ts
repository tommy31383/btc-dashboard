/**
 * backtest-new-strategies-3y.ts (anh Tommy 2026-04-29)
 *
 * Backtest 3 rule mới world-class trên 3y BTC:
 *   1. DONCHIAN_BREAKOUT — Turtle Trading classic
 *   2. ATR_DYNAMIC_TP_SL — Volatility-adjusted TP/SL
 *   3. VOLUME_DIVERGENCE — Volume vs price divergence (proxy cho OI)
 *
 * Goal: tìm xem có rule mới nào PF > 2.0 (worth add vào hard_rules.json).
 *
 * Usage: npx tsx tools/backtest-new-strategies-3y.ts
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { Candle } from "../utils/backtester";

const YEARS = 3;
const FEE_PER_SIDE = 0.05; // %
const LEVERAGE = 100;
const MARGIN = 30;
const NOTIONAL = MARGIN * LEVERAGE;
const FEE_USD = NOTIONAL * (FEE_PER_SIDE / 100);

function loadCache(tf: string): Candle[] {
  const p = join(__dirname, "..", ".cache", `binance-${tf}-${YEARS}y.json`);
  if (!existsSync(p)) throw new Error(`Missing ${p}`);
  return JSON.parse(readFileSync(p, "utf8"));
}

// ─── Indicators ───────────────────────────────────────────────────────────
function calcATR(candles: Candle[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length < period + 1) return out;
  let sum = 0;
  for (let i = 1; i <= period; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    );
    sum += tr;
  }
  let atr = sum / period;
  out[period] = atr;
  for (let i = period + 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    );
    atr = (atr * (period - 1) + tr) / period;
    out[i] = atr;
  }
  return out;
}

function calcDonchian(candles: Candle[], period = 20): { upper: (number | null)[]; lower: (number | null)[] } {
  const upper: (number | null)[] = new Array(candles.length).fill(null);
  const lower: (number | null)[] = new Array(candles.length).fill(null);
  for (let i = period; i < candles.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - period; j < i; j++) {
      if (candles[j].high > hi) hi = candles[j].high;
      if (candles[j].low < lo) lo = candles[j].low;
    }
    upper[i] = hi;
    lower[i] = lo;
  }
  return { upper, lower };
}

// ─── Generic simulate trade ───────────────────────────────────────────────
function simulate(
  candles: Candle[], entryIdx: number, side: "LONG" | "SHORT",
  entryPrice: number, tpPrice: number, slPrice: number, maxHold: number,
): { outcome: "WIN" | "LOSS" | "TIMEOUT"; exitPrice: number; pnlPct: number; holdBars: number } {
  const maxIdx = Math.min(entryIdx + maxHold, candles.length - 1);
  for (let i = entryIdx + 1; i <= maxIdx; i++) {
    const c = candles[i];
    if (side === "LONG") {
      if (c.high >= tpPrice && c.low <= slPrice) {
        const pnl = ((slPrice - entryPrice) / entryPrice) * 100;
        return { outcome: pnl >= 0 ? "WIN" : "LOSS", exitPrice: slPrice, pnlPct: pnl, holdBars: i - entryIdx };
      }
      if (c.high >= tpPrice) return { outcome: "WIN", exitPrice: tpPrice, pnlPct: ((tpPrice - entryPrice) / entryPrice) * 100, holdBars: i - entryIdx };
      if (c.low <= slPrice) return { outcome: "LOSS", exitPrice: slPrice, pnlPct: ((slPrice - entryPrice) / entryPrice) * 100, holdBars: i - entryIdx };
    } else {
      if (c.low <= tpPrice && c.high >= slPrice) {
        const pnl = ((entryPrice - slPrice) / entryPrice) * 100;
        return { outcome: pnl >= 0 ? "WIN" : "LOSS", exitPrice: slPrice, pnlPct: pnl, holdBars: i - entryIdx };
      }
      if (c.low <= tpPrice) return { outcome: "WIN", exitPrice: tpPrice, pnlPct: ((entryPrice - tpPrice) / entryPrice) * 100, holdBars: i - entryIdx };
      if (c.high >= slPrice) return { outcome: "LOSS", exitPrice: slPrice, pnlPct: ((entryPrice - slPrice) / entryPrice) * 100, holdBars: i - entryIdx };
    }
  }
  // Timeout — exit at close
  const cFinal = candles[maxIdx];
  const finalPct = side === "LONG" ? (cFinal.close - entryPrice) / entryPrice * 100 : (entryPrice - cFinal.close) / entryPrice * 100;
  return { outcome: "TIMEOUT", exitPrice: cFinal.close, pnlPct: finalPct, holdBars: maxIdx - entryIdx };
}

interface Stats {
  trades: number; wins: number; losses: number; timeouts: number;
  winRate: number; netUsd: number; avgWinPct: number; avgLossPct: number;
  profitFactor: number; maxDdUsd: number;
}

function computeStats(trades: { outcome: string; pnlPct: number }[]): Stats {
  const w = trades.filter(t => t.outcome === "WIN").length;
  const l = trades.filter(t => t.outcome === "LOSS").length;
  const to = trades.filter(t => t.outcome === "TIMEOUT").length;
  const winsArr = trades.filter(t => t.pnlPct > 0).map(t => t.pnlPct);
  const lossArr = trades.filter(t => t.pnlPct < 0).map(t => Math.abs(t.pnlPct));
  const grossWin = winsArr.reduce((s, x) => s + x, 0);
  const grossLoss = lossArr.reduce((s, x) => s + x, 0);
  const pf = grossLoss === 0 ? 999 : grossWin / grossLoss;

  let cap = 5000, peak = 5000, dd = 0, netUsd = 0;
  for (const t of trades) {
    let pnl = MARGIN * t.pnlPct * LEVERAGE / 100;
    if (pnl < -MARGIN) pnl = -MARGIN;
    pnl -= 2 * FEE_USD;
    cap += pnl; netUsd += pnl;
    if (cap > peak) peak = cap;
    const drawdown = peak - cap;
    if (drawdown > dd) dd = drawdown;
  }
  return {
    trades: trades.length, wins: w, losses: l, timeouts: to,
    winRate: trades.length ? w / trades.length * 100 : 0,
    netUsd, avgWinPct: winsArr.length ? grossWin / winsArr.length : 0,
    avgLossPct: lossArr.length ? grossLoss / lossArr.length : 0,
    profitFactor: pf, maxDdUsd: dd,
  };
}

// ─── Strategy 1: DONCHIAN BREAKOUT ────────────────────────────────────────
function runDonchian(candles: Candle[], tf: string, period: number, atrTpMult: number, atrSlMult: number, cooldownBars: number): { trades: any[]; stats: Stats } {
  const atr = calcATR(candles, 14);
  const { upper, lower } = calcDonchian(candles, period);
  const trades: any[] = [];
  let lastEntry = -cooldownBars;
  const maxHold = period * 5;

  for (let i = period + 14; i < candles.length; i++) {
    if (i - lastEntry < cooldownBars) continue;
    const c = candles[i];
    const u = upper[i], lw = lower[i], a = atr[i];
    if (u === null || lw === null || a === null) continue;
    let side: "LONG" | "SHORT" | null = null;
    if (c.close > u) side = "LONG";
    else if (c.close < lw) side = "SHORT";
    if (!side) continue;
    const tpPrice = side === "LONG" ? c.close + atrTpMult * a : c.close - atrTpMult * a;
    const slPrice = side === "LONG" ? c.close - atrSlMult * a : c.close + atrSlMult * a;
    const sim = simulate(candles, i, side, c.close, tpPrice, slPrice, maxHold);
    trades.push({ time: c.time, side, ...sim });
    lastEntry = i;
  }
  return { trades, stats: computeStats(trades) };
}

// ─── Strategy 2: ATR-DYNAMIC TP/SL với simple trend signal ────────────────
function runAtrDynamic(candles: Candle[], atrTpMult: number, atrSlMult: number, cooldownBars: number): { trades: any[]; stats: Stats } {
  const atr = calcATR(candles, 14);
  const trades: any[] = [];
  let lastEntry = -cooldownBars;
  const period = 50;
  const maxHold = 200;
  // EMA50 cho trend signal
  const ema: (number | null)[] = new Array(candles.length).fill(null);
  const k = 2 / (period + 1);
  let e = candles.slice(0, period).reduce((s, c) => s + c.close, 0) / period;
  ema[period - 1] = e;
  for (let i = period; i < candles.length; i++) { e = candles[i].close * k + e * (1 - k); ema[i] = e; }

  for (let i = period + 14; i < candles.length; i++) {
    if (i - lastEntry < cooldownBars) continue;
    const c = candles[i], cp = candles[i - 1];
    const a = atr[i], em = ema[i];
    if (a === null || em === null) continue;
    // Pullback to EMA50 in trend
    let side: "LONG" | "SHORT" | null = null;
    if (cp.close > em && c.low <= em && c.close > em) side = "LONG"; // bullish pullback bounce
    else if (cp.close < em && c.high >= em && c.close < em) side = "SHORT"; // bearish pullback rejection
    if (!side) continue;
    const tpPrice = side === "LONG" ? c.close + atrTpMult * a : c.close - atrTpMult * a;
    const slPrice = side === "LONG" ? c.close - atrSlMult * a : c.close + atrSlMult * a;
    const sim = simulate(candles, i, side, c.close, tpPrice, slPrice, maxHold);
    trades.push({ time: c.time, side, ...sim });
    lastEntry = i;
  }
  return { trades, stats: computeStats(trades) };
}

// ─── Strategy 3: VOLUME DIVERGENCE (proxy OI) ─────────────────────────────
function runVolumeDiv(candles: Candle[], lookback: number, tpPct: number, slPct: number, cooldownBars: number): { trades: any[]; stats: Stats } {
  const trades: any[] = [];
  let lastEntry = -cooldownBars;
  const maxHold = 200;

  for (let i = lookback; i < candles.length; i++) {
    if (i - lastEntry < cooldownBars) continue;
    const c = candles[i];
    // Find swing high/low + volume comparison
    let pHi = -Infinity, pLo = Infinity, vHi = 0, vLo = 0;
    for (let j = i - lookback; j < i - lookback / 2; j++) {
      if (candles[j].high > pHi) { pHi = candles[j].high; vHi = candles[j].volume; }
      if (candles[j].low < pLo) { pLo = candles[j].low; vLo = candles[j].volume; }
    }
    let cHi = -Infinity, cLo = Infinity, cVHi = 0, cVLo = 0;
    for (let j = i - lookback / 2; j < i; j++) {
      if (candles[j].high > cHi) { cHi = candles[j].high; cVHi = candles[j].volume; }
      if (candles[j].low < cLo) { cLo = candles[j].low; cVLo = candles[j].volume; }
    }
    let side: "LONG" | "SHORT" | null = null;
    // Bullish div: price lower low + volume lower (selling exhausted)
    if (cLo < pLo && cVLo < vLo * 0.7 && c.close > cLo * 1.005) side = "LONG";
    // Bearish div: price higher high + volume lower
    else if (cHi > pHi && cVHi < vHi * 0.7 && c.close < cHi * 0.995) side = "SHORT";
    if (!side) continue;
    const tpPrice = side === "LONG" ? c.close * (1 + tpPct / 100) : c.close * (1 - tpPct / 100);
    const slPrice = side === "LONG" ? c.close * (1 - slPct / 100) : c.close * (1 + slPct / 100);
    const sim = simulate(candles, i, side, c.close, tpPrice, slPrice, maxHold);
    trades.push({ time: c.time, side, ...sim });
    lastEntry = i;
  }
  return { trades, stats: computeStats(trades) };
}

(async () => {
  const TFS = ["15m", "1h", "4h"];
  const results: any[] = [];
  console.log(`\n=== BACKTEST 3 NEW STRATEGIES · 3y BTC/USDT ===\n`);

  for (const tf of TFS) {
    console.log(`Loading ${tf}...`);
    const c = loadCache(tf);
    console.log(`  ${c.length} candles\n`);

    // 1. DONCHIAN — sweep period [10, 20, 50] × TP/SL ratio
    console.log(`[${tf}] DONCHIAN sweep:`);
    for (const period of [10, 20, 50]) {
      for (const [tpM, slM] of [[3, 1.5], [4, 2], [4, 1.5], [5, 2], [6, 2]]) {
        const { stats } = runDonchian(c, tf, period, tpM, slM, 5);
        const id = `DONCH_${tf}_p${period}_TP${tpM}xATR_SL${slM}xATR`;
        results.push({ id, tf, type: "DONCHIAN", ...stats });
        if (stats.profitFactor >= 1.3 && stats.trades >= 30) {
          console.log(`  ✅ ${id.padEnd(40)} ${stats.trades}t WR ${stats.winRate.toFixed(1)}% NET $${(stats.netUsd/1000).toFixed(0)}k PF ${stats.profitFactor.toFixed(2)} DD $${(stats.maxDdUsd/1000).toFixed(1)}k`);
        }
      }
    }

    // 2. ATR-DYNAMIC pullback
    console.log(`[${tf}] ATR-DYNAMIC sweep:`);
    for (const [tpM, slM] of [[3, 1.5], [4, 2], [5, 2], [4, 1.5], [6, 2]]) {
      const { stats } = runAtrDynamic(c, tpM, slM, 3);
      const id = `ATRD_${tf}_TP${tpM}xATR_SL${slM}xATR`;
      results.push({ id, tf, type: "ATR_DYNAMIC", ...stats });
      if (stats.profitFactor >= 1.3 && stats.trades >= 30) {
        console.log(`  ✅ ${id.padEnd(40)} ${stats.trades}t WR ${stats.winRate.toFixed(1)}% NET $${(stats.netUsd/1000).toFixed(0)}k PF ${stats.profitFactor.toFixed(2)} DD $${(stats.maxDdUsd/1000).toFixed(1)}k`);
      }
    }

    // 3. VOLUME DIV
    console.log(`[${tf}] VOLUME-DIV sweep:`);
    for (const lookback of [20, 50]) {
      for (const [tp, sl] of [[3, 2], [5, 3], [4, 2], [6, 3]]) {
        const { stats } = runVolumeDiv(c, lookback, tp, sl, 5);
        const id = `VOLDIV_${tf}_lb${lookback}_TP${tp}_SL${sl}`;
        results.push({ id, tf, type: "VOLUME_DIV", ...stats });
        if (stats.profitFactor >= 1.3 && stats.trades >= 30) {
          console.log(`  ✅ ${id.padEnd(40)} ${stats.trades}t WR ${stats.winRate.toFixed(1)}% NET $${(stats.netUsd/1000).toFixed(0)}k PF ${stats.profitFactor.toFixed(2)} DD $${(stats.maxDdUsd/1000).toFixed(1)}k`);
        }
      }
    }
    console.log("");
  }

  // Top 10 by PF (filter min 30 trades)
  const valid = results.filter(r => r.trades >= 30);
  console.log(`\n=== TOP 10 by PF (min 30 trades) — ${valid.length}/${results.length} valid ===`);
  for (const r of [...valid].sort((a, b) => b.profitFactor - a.profitFactor).slice(0, 10)) {
    console.log(`  ${r.id.padEnd(45)} PF ${r.profitFactor.toFixed(2)} · NET $${(r.netUsd/1000).toFixed(0)}k · DD $${(r.maxDdUsd/1000).toFixed(1)}k · WR ${r.winRate.toFixed(1)}% · ${r.trades}t`);
  }

  console.log(`\n=== TOP 10 by NET ===`);
  for (const r of [...valid].sort((a, b) => b.netUsd - a.netUsd).slice(0, 10)) {
    console.log(`  ${r.id.padEnd(45)} NET $${(r.netUsd/1000).toFixed(0)}k · PF ${r.profitFactor.toFixed(2)} · DD $${(r.maxDdUsd/1000).toFixed(1)}k · WR ${r.winRate.toFixed(1)}% · ${r.trades}t`);
  }

  // Save
  const outPath = join(__dirname, "..", "assets", "backtest_new_strategies_3y.json");
  writeFileSync(outPath, JSON.stringify({ generatedAt: Date.now(), config: { years: YEARS, fee: FEE_PER_SIDE, leverage: LEVERAGE, margin: MARGIN }, results }, null, 2));
  console.log(`\n💾 Saved: ${outPath}`);
})();
