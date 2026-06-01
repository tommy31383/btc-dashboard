/**
 * backtest-pullback-7y.ts — Test Setup #21 Trend-aligned Pullback Entry.
 *
 * Hypothesis: v0.4.40 trend setups fire BREAKOUT (wave high) → entry expensive.
 * Pullback entry trong cùng trend = lower risk, better R:R.
 *
 * Logic:
 *   - Trend confirmed: EMA50 > EMA200 4h (BULL) hoặc < (BEAR), persistent 3+ bars
 *   - Pullback detected: 1h price touches EMA20 4h (deeper pullback option: EMA50 4h)
 *   - Entry: 1h close back above (LONG) / below (SHORT) EMA20 4h after pullback (confirm bounce)
 *   - SL: ATR(4h) × 1.0 (tight)
 *   - TP: ATR(4h) × 3.0 (R:R 3:1)
 *   - Cooldown 4h per side
 *
 * Variants:
 *   V0: v0.4.40 trend_only baseline (no pullback)
 *   V1: + Pullback shallow (EMA20 4h)
 *   V2: + Pullback medium (EMA50 4h)
 *   V3: + Pullback shallow with 1h RSI < 60 LONG / > 40 SHORT filter
 *   V4: + V1 with ATR×2 SL, ATR×5 TP (R:R 2.5)
 *   V5: ALL combined
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const INITIAL_CAPITAL = 100_000;
const FEE_PCT = 0.05;
const EMA_FAST = 50;
const EMA_SLOW = 200;
const ATR_BREAKOUT_MULT = 1.5;
const DONCHIAN_LOOKBACK = 20;
const TREND_ATR_SL_MULT = 3;
const TREND_MAX_QTY_PER_SIDE = 0.02;
const REGIME_PERSIST_BARS = 3;
const SETUP12_QTY = 0.005, SETUP13_QTY = 0.003, SETUP14_QTY = 0.005;
const SETUP12_COOLDOWN_MS = 12 * 60 * 60_000;
const SETUP13_COOLDOWN_MS = 4 * 60 * 60_000;
const SETUP14_COOLDOWN_MS = 12 * 60 * 60_000;
const MIN_BINANCE_QTY = 0.001;

// === Setup #21 Pullback ===
const S21_QTY = 0.005;
const S21_COOLDOWN_MS = 4 * 60 * 60_000;
const S21_TIMESTOP_MS = 24 * 60 * 60_000;

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }
type Regime = "BULL" | "RANGE" | "BEAR";

interface ScenarioConfig {
  name: string;
  enableTrend: boolean;
  enableS21: boolean;
  pullbackEma: number;       // EMA period for pullback target (20 or 50)
  atrSlMult: number;         // SL = ATR × this
  atrTpMult: number;         // TP = ATR × this
  useRsiFilter: boolean;     // require RSI 1h < 60 for LONG / > 40 for SHORT
}

const SCENARIOS: ScenarioConfig[] = [
  { name: "V0_trend_baseline",     enableTrend: true, enableS21: false, pullbackEma: 20, atrSlMult: 1.0, atrTpMult: 3.0, useRsiFilter: false },
  { name: "V1_pullback_ema20_R3",  enableTrend: true, enableS21: true,  pullbackEma: 20, atrSlMult: 1.0, atrTpMult: 3.0, useRsiFilter: false },
  { name: "V2_pullback_ema50_R3",  enableTrend: true, enableS21: true,  pullbackEma: 50, atrSlMult: 1.0, atrTpMult: 3.0, useRsiFilter: false },
  { name: "V3_pullback_ema20_RSI", enableTrend: true, enableS21: true,  pullbackEma: 20, atrSlMult: 1.0, atrTpMult: 3.0, useRsiFilter: true },
  { name: "V4_pullback_ema20_R25", enableTrend: true, enableS21: true,  pullbackEma: 20, atrSlMult: 2.0, atrTpMult: 5.0, useRsiFilter: false },
  { name: "V5_pullback_only_ema20",enableTrend: false,enableS21: true,  pullbackEma: 20, atrSlMult: 1.0, atrTpMult: 3.0, useRsiFilter: false },
];

function loadCache(name: string): Candle[] { return JSON.parse(readFileSync(join(__dirname, "..", ".cache", name), "utf8")); }
function aggregateBars(c5: Candle[], minutes: number): Candle[] {
  const targetMs = minutes * 60_000;
  const out: Candle[] = [];
  let cur: { bucket: number; bars: Candle[] } | null = null;
  for (const b of c5) {
    const bucket = Math.floor(b.time / targetMs) * targetMs;
    if (!cur || cur.bucket !== bucket) {
      if (cur && cur.bars.length > 0) {
        const bars = cur.bars;
        let hi = -Infinity, lo = Infinity, vol = 0;
        for (const x of bars) { if (x.high > hi) hi = x.high; if (x.low < lo) lo = x.low; vol += x.volume ?? 0; }
        out.push({ time: cur.bucket, open: bars[0].open, high: hi, low: lo, close: bars[bars.length - 1].close, volume: vol });
      }
      cur = { bucket, bars: [b] };
    } else cur.bars.push(b);
  }
  if (cur && cur.bars.length > 0) {
    const bars = cur.bars;
    let hi = -Infinity, lo = Infinity, vol = 0;
    for (const x of bars) { if (x.high > hi) hi = x.high; if (x.low < lo) lo = x.low; vol += x.volume ?? 0; }
    out.push({ time: cur.bucket, open: bars[0].open, high: hi, low: lo, close: bars[bars.length - 1].close, volume: vol });
  }
  return out;
}
function calcSMA(a: number[], p: number): (number | null)[] {
  const o: (number | null)[] = new Array(a.length).fill(null); if (a.length < p) return o;
  let s = 0; for (let i = 0; i < p; i++) s += a[i]; o[p - 1] = s / p;
  for (let i = p; i < a.length; i++) { s += a[i] - a[i - p]; o[i] = s / p; } return o;
}
function calcEMA(a: number[], p: number): (number | null)[] {
  const o: (number | null)[] = new Array(a.length).fill(null); if (a.length < p) return o;
  const k = 2 / (p + 1); let e = 0;
  for (let i = 0; i < p; i++) e += a[i]; e /= p; o[p - 1] = e;
  for (let i = p; i < a.length; i++) { e = a[i] * k + e * (1 - k); o[i] = e; } return o;
}
function calcRSI(c: number[], p: number): (number | null)[] {
  const o: (number | null)[] = new Array(c.length).fill(null); if (c.length <= p) return o;
  let g = 0, l = 0; for (let i = 1; i <= p; i++) { const ch = c[i] - c[i - 1]; if (ch >= 0) g += ch; else l -= ch; }
  let ag = g / p, al = l / p; o[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = p + 1; i < c.length; i++) {
    const ch = c[i] - c[i - 1];
    ag = (ag * (p - 1) + Math.max(ch, 0)) / p; al = (al * (p - 1) + Math.max(-ch, 0)) / p;
    o[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  } return o;
}
function calcATR(c: Candle[], p: number): (number | null)[] {
  const o: (number | null)[] = new Array(c.length).fill(null); if (c.length <= p) return o;
  const tr: number[] = new Array(c.length).fill(0);
  for (let i = 1; i < c.length; i++) tr[i] = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
  let s = 0; for (let i = 1; i <= p; i++) s += tr[i]; o[p] = s / p;
  for (let i = p + 1; i < c.length; i++) o[i] = (o[i - 1]! * (p - 1) + tr[i]) / p; return o;
}
function findIdx(arr: { time: number }[], ts: number, hint: number = 0): number {
  let lo = hint, hi = arr.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (arr[mid].time <= ts) lo = mid; else hi = mid - 1; }
  return lo;
}

interface TrendTrade { id: string; kind: string; side: "LONG" | "SHORT"; entryPx: number; qty: number; hwm: number; lwm: number; slPx: number; atrEntry: number; }
interface SimpleTrade { id: string; kind: string; side: "LONG" | "SHORT"; entryPx: number; qty: number; tpPx: number; slPx: number; expireTs: number; }

function runBacktest(c5: Candle[], c1h: Candle[], c4h: Candle[], c1d: Candle[], ind: any, cfg: ScenarioConfig, startIdx: number, endIdx: number): any {
  let wallet = INITIAL_CAPITAL, hwm = INITIAL_CAPITAL;
  let trendLongNet = { qty: 0, avg: 0 }, trendShortNet = { qty: 0, avg: 0 };
  let s21LongNet = { qty: 0, avg: 0 }, s21ShortNet = { qty: 0, avg: 0 };
  let trendTrades: TrendTrade[] = [];
  let s21Trades: SimpleTrade[] = [];
  let lastS12L = 0, lastS12S = 0, lastS13L = 0, lastS13S = 0, lastS14L = 0, lastS14S = 0;
  let lastS21LMs = 0, lastS21SMs = 0;
  let regime: Regime = "RANGE", regimeConsec = 0, regimeLastRaw: Regime = "RANGE";
  let entries = 0, closes = 0, wins = 0, losses = 0, sumWin = 0, sumLoss = 0;
  let lowestWallet = INITIAL_CAPITAL, totalFees = 0;
  const setupCounts: Record<string, number> = {};
  const byYear: Record<string, { entries: number; closes: number; pnl: number }> = {};
  let idx1h = 0, idx4h = 0, idx1d = 0;
  let last4hIdx = -1, last1hIdx = -1;
  // For pullback detection: track if price has touched EMA20 4h in current trend
  let touchedPullbackLong = false;
  let touchedPullbackShort = false;
  let prevTrendDir: "UP" | "DOWN" | null = null;

  // Pre-compute EMA target on 4h
  const ema20_4h = calcEMA(c4h.map(b => b.close), 20);
  const ema50_4h_full = calcEMA(c4h.map(b => b.close), 50);
  // pullback target series
  const pullbackEmaSeries = cfg.pullbackEma === 50 ? ema50_4h_full : ema20_4h;

  for (let i = startIdx; i < endIdx; i++) {
    const bar = c5[i]; const ts = bar.time; const mark = bar.close;

    // Close trend trailing
    const newTrend: TrendTrade[] = [];
    for (const t of trendTrades) {
      if (t.side === "LONG") { if (mark > t.hwm) { t.hwm = mark; t.slPx = t.hwm - t.atrEntry * TREND_ATR_SL_MULT; } }
      else { if (mark < t.lwm) { t.lwm = mark; t.slPx = t.lwm + t.atrEntry * TREND_ATR_SL_MULT; } }
      let exit = false;
      if (t.side === "LONG" && mark <= t.slPx) exit = true;
      if (t.side === "SHORT" && mark >= t.slPx) exit = true;
      if (exit) {
        const fee = t.qty * mark * FEE_PCT / 100;
        const pnl = (t.side === "LONG" ? mark - t.entryPx : t.entryPx - mark) * t.qty;
        wallet += pnl - fee; totalFees += fee;
        if (wallet > hwm) hwm = wallet; if (wallet < lowestWallet) lowestWallet = wallet;
        closes++;
        if (pnl > 0) { wins++; sumWin += pnl; } else { losses++; sumLoss += pnl; }
        const y = new Date(ts).toISOString().slice(0, 4);
        byYear[y] = byYear[y] ?? { entries: 0, closes: 0, pnl: 0 };
        byYear[y].closes++; byYear[y].pnl += pnl - fee;
        const net = t.side === "LONG" ? trendLongNet : trendShortNet;
        const rq = Math.max(0, net.qty - t.qty);
        if (t.side === "LONG") trendLongNet = { qty: rq, avg: rq > 0 ? net.avg : 0 };
        else trendShortNet = { qty: rq, avg: rq > 0 ? net.avg : 0 };
      } else newTrend.push(t);
    }
    trendTrades = newTrend;

    // Close S21 simple
    const newS21: SimpleTrade[] = [];
    for (const t of s21Trades) {
      let exit = false; let reason = "";
      if (t.side === "LONG") {
        if (bar.high >= t.tpPx) { exit = true; reason = "TP"; }
        else if (bar.low <= t.slPx) { exit = true; reason = "SL"; }
      } else {
        if (bar.low <= t.tpPx) { exit = true; reason = "TP"; }
        else if (bar.high >= t.slPx) { exit = true; reason = "SL"; }
      }
      if (!exit && ts >= t.expireTs) { exit = true; reason = "TIME"; }
      if (exit) {
        const exitPx = reason === "TP" ? t.tpPx : reason === "SL" ? t.slPx : bar.close;
        const fee = t.qty * (t.entryPx + exitPx) * FEE_PCT / 100;
        const pnl = (t.side === "LONG" ? exitPx - t.entryPx : t.entryPx - exitPx) * t.qty;
        wallet += pnl - fee; totalFees += fee;
        if (wallet > hwm) hwm = wallet; if (wallet < lowestWallet) lowestWallet = wallet;
        closes++;
        if (pnl > 0) { wins++; sumWin += pnl; } else { losses++; sumLoss += pnl; }
        const y = new Date(ts).toISOString().slice(0, 4);
        byYear[y] = byYear[y] ?? { entries: 0, closes: 0, pnl: 0 };
        byYear[y].closes++; byYear[y].pnl += pnl - fee;
        const net = t.side === "LONG" ? s21LongNet : s21ShortNet;
        const rq = Math.max(0, net.qty - t.qty);
        if (t.side === "LONG") s21LongNet = { qty: rq, avg: rq > 0 ? net.avg : 0 };
        else s21ShortNet = { qty: rq, avg: rq > 0 ? net.avg : 0 };
      } else newS21.push(t);
    }
    s21Trades = newS21;

    if (i < startIdx + 60) continue;
    idx1h = findIdx(c1h, ts, idx1h); idx4h = findIdx(c4h, ts, idx4h); idx1d = findIdx(c1d, ts, idx1d);
    const idx1hc = idx1h - 1; const idx4hc = idx4h - 1; const idx1dc = idx1d - 1;

    // Regime detection (from 1d MA200/MA50)
    const m200d = ind.ma200d[idx1dc]; const m50d = ind.ma50d[idx1dc];
    let rawReg: Regime = "RANGE";
    if (idx1dc >= 200 && m200d !== null) {
      const lastD = c1d[idx1dc];
      let rangeSum = 0; let n = 0;
      for (let j = idx1dc - 19; j <= idx1dc; j++) { rangeSum += (c1d[j].high - c1d[j].low) / c1d[j].close; n++; }
      const avgRange = n > 0 ? rangeSum / n : 0;
      const isTrending = avgRange > 0.04;
      if (lastD.close < m200d) rawReg = "BEAR";
      else if (m50d !== null && lastD.close > m50d && m50d > m200d && isTrending) rawReg = "BULL";
    }
    if (rawReg === regime) regimeConsec = 1;
    else if (rawReg === regimeLastRaw) {
      regimeConsec++;
      if (regimeConsec >= REGIME_PERSIST_BARS) { regime = rawReg; regimeConsec = 1; }
    } else regimeConsec = 1;
    regimeLastRaw = rawReg;
    const allowLong = regime !== "BEAR";
    const allowShort = regime !== "BULL";

    // Trend setups (S12/S13/S14) — copy v0.4.40 logic
    if (cfg.enableTrend && idx4hc !== last4hIdx && idx4hc >= EMA_SLOW + 1) {
      last4hIdx = idx4hc;
      let ema12: "LONG" | "SHORT" | null = null;
      let atr13: "LONG" | "SHORT" | null = null;
      let don14: "LONG" | "SHORT" | null = null;
      const atrVal4h = ind.atr14_4h[idx4hc];
      const fp = ind.ema50_4h[idx4hc - 1], sp = ind.ema200_4h[idx4hc - 1];
      const fc = ind.ema50_4h[idx4hc], sc = ind.ema200_4h[idx4hc];
      if (fp !== null && sp !== null && fc !== null && sc !== null) {
        if (fp <= sp && fc > sc) ema12 = "LONG";
        else if (fp >= sp && fc < sc) ema12 = "SHORT";
      }
      if (atrVal4h !== null && atrVal4h > 0 && idx4hc >= 1) {
        const prev4h = c4h[idx4hc - 1]; const last4h = c4h[idx4hc];
        if (last4h.close > prev4h.close + atrVal4h * ATR_BREAKOUT_MULT) atr13 = "LONG";
        else if (last4h.close < prev4h.close - atrVal4h * ATR_BREAKOUT_MULT) atr13 = "SHORT";
      }
      if (idx4hc >= DONCHIAN_LOOKBACK) {
        let hi = -Infinity, lo = Infinity;
        for (let j = idx4hc - DONCHIAN_LOOKBACK; j < idx4hc; j++) {
          if (c4h[j].high > hi) hi = c4h[j].high; if (c4h[j].low < lo) lo = c4h[j].low;
        }
        const l4 = c4h[idx4hc];
        if (l4.close > hi) don14 = "LONG";
        else if (l4.close < lo) don14 = "SHORT";
      }
      const trendEnter = (kind: string, side: "LONG" | "SHORT", baseQty: number, lastTsRef: { v: number }, cdMs: number) => {
        if (ts - lastTsRef.v < cdMs) return;
        if (atrVal4h === null || atrVal4h <= 0) return;
        if (side === "LONG" && !allowLong) return;
        if (side === "SHORT" && !allowShort) return;
        const qty = baseQty;
        const cur = side === "LONG" ? trendLongNet.qty : trendShortNet.qty;
        if (cur + qty > TREND_MAX_QTY_PER_SIDE) return;
        const slPx = side === "LONG" ? mark - atrVal4h * TREND_ATR_SL_MULT : mark + atrVal4h * TREND_ATR_SL_MULT;
        const fee = qty * mark * FEE_PCT / 100;
        wallet -= fee; totalFees += fee;
        const net = side === "LONG" ? trendLongNet : trendShortNet;
        const nq = net.qty + qty;
        const newNet = { qty: nq, avg: (net.qty * net.avg + qty * mark) / nq };
        if (side === "LONG") trendLongNet = newNet; else trendShortNet = newNet;
        trendTrades.push({ id: `${kind}_${side}_${ts}`, kind, side, entryPx: mark, qty, hwm: mark, lwm: mark, slPx, atrEntry: atrVal4h });
        lastTsRef.v = ts; entries++;
        setupCounts[`${kind}${side[0]}`] = (setupCounts[`${kind}${side[0]}`] ?? 0) + 1;
        const y = new Date(ts).toISOString().slice(0, 4);
        byYear[y] = byYear[y] ?? { entries: 0, closes: 0, pnl: 0 }; byYear[y].entries++;
      };
      const refL12 = { get v() { return lastS12L; }, set v(x: number) { lastS12L = x; } };
      const refS12 = { get v() { return lastS12S; }, set v(x: number) { lastS12S = x; } };
      const refL13 = { get v() { return lastS13L; }, set v(x: number) { lastS13L = x; } };
      const refS13 = { get v() { return lastS13S; }, set v(x: number) { lastS13S = x; } };
      const refL14 = { get v() { return lastS14L; }, set v(x: number) { lastS14L = x; } };
      const refS14 = { get v() { return lastS14S; }, set v(x: number) { lastS14S = x; } };
      if (ema12 === "LONG") trendEnter("S12", "LONG", SETUP12_QTY, refL12 as any, SETUP12_COOLDOWN_MS);
      else if (ema12 === "SHORT") trendEnter("S12", "SHORT", SETUP12_QTY, refS12 as any, SETUP12_COOLDOWN_MS);
      if (atr13 === "LONG") trendEnter("S13", "LONG", SETUP13_QTY, refL13 as any, SETUP13_COOLDOWN_MS);
      else if (atr13 === "SHORT") trendEnter("S13", "SHORT", SETUP13_QTY, refS13 as any, SETUP13_COOLDOWN_MS);
      if (don14 === "LONG") trendEnter("S14", "LONG", SETUP14_QTY, refL14 as any, SETUP14_COOLDOWN_MS);
      else if (don14 === "SHORT") trendEnter("S14", "SHORT", SETUP14_QTY, refS14 as any, SETUP14_COOLDOWN_MS);
    }

    // === Setup #21 Pullback ===
    if (cfg.enableS21 && idx1hc !== last1hIdx && idx4hc >= EMA_SLOW + 1) {
      last1hIdx = idx1hc;
      const e50 = ind.ema50_4h[idx4hc]; const e200 = ind.ema200_4h[idx4hc];
      const emaTarget = pullbackEmaSeries[idx4hc];
      const atrVal4h = ind.atr14_4h[idx4hc];
      if (e50 !== null && e200 !== null && emaTarget !== null && atrVal4h !== null && atrVal4h > 0) {
        // Determine current trend direction
        const trendDir: "UP" | "DOWN" | null = e50 > e200 ? "UP" : e50 < e200 ? "DOWN" : null;
        // Reset pullback flag when trend reverses
        if (trendDir !== prevTrendDir) {
          touchedPullbackLong = false;
          touchedPullbackShort = false;
          prevTrendDir = trendDir;
        }
        // Track pullback touches: 1h bar touches EMA target
        const lastH = c1h[idx1hc];
        if (trendDir === "UP") {
          // Pullback in uptrend = price visits EMA target from above
          if (lastH.low <= emaTarget) touchedPullbackLong = true;
        } else if (trendDir === "DOWN") {
          if (lastH.high >= emaTarget) touchedPullbackShort = true;
        }
        // Entry trigger: 1h close back above (LONG) / below (SHORT) EMA target sau pullback
        let s21Side: "LONG" | "SHORT" | null = null;
        if (trendDir === "UP" && touchedPullbackLong && lastH.close > emaTarget && allowLong && ts - lastS21LMs >= S21_COOLDOWN_MS) {
          // RSI filter optional: 1h RSI < 60 (not overbought)
          if (!cfg.useRsiFilter || (ind.rsi1h[idx1hc] !== null && ind.rsi1h[idx1hc]! < 60)) {
            s21Side = "LONG";
            touchedPullbackLong = false;
          }
        } else if (trendDir === "DOWN" && touchedPullbackShort && lastH.close < emaTarget && allowShort && ts - lastS21SMs >= S21_COOLDOWN_MS) {
          if (!cfg.useRsiFilter || (ind.rsi1h[idx1hc] !== null && ind.rsi1h[idx1hc]! > 40)) {
            s21Side = "SHORT";
            touchedPullbackShort = false;
          }
        }
        if (s21Side) {
          const qty = S21_QTY;
          const fee = qty * mark * FEE_PCT / 100;
          wallet -= fee; totalFees += fee;
          const net = s21Side === "LONG" ? s21LongNet : s21ShortNet;
          const nq = net.qty + qty;
          const newNet = { qty: nq, avg: (net.qty * net.avg + qty * mark) / nq };
          if (s21Side === "LONG") s21LongNet = newNet; else s21ShortNet = newNet;
          const tpPx = s21Side === "LONG" ? mark + atrVal4h * cfg.atrTpMult : mark - atrVal4h * cfg.atrTpMult;
          const slPx = s21Side === "LONG" ? mark - atrVal4h * cfg.atrSlMult : mark + atrVal4h * cfg.atrSlMult;
          s21Trades.push({
            id: `s21_${ts}`, kind: "S21", side: s21Side, entryPx: mark, qty, tpPx, slPx,
            expireTs: ts + S21_TIMESTOP_MS,
          });
          if (s21Side === "LONG") lastS21LMs = ts; else lastS21SMs = ts;
          entries++;
          setupCounts[`S21${s21Side[0]}`] = (setupCounts[`S21${s21Side[0]}`] ?? 0) + 1;
          const y = new Date(ts).toISOString().slice(0, 4);
          byYear[y] = byYear[y] ?? { entries: 0, closes: 0, pnl: 0 }; byYear[y].entries++;
        }
      }
    }
  }

  // Force close
  const lastBar = c5[endIdx - 1] ?? c5[c5.length - 1];
  const lastMark = lastBar.close;
  const closeAll = (side: "LONG" | "SHORT", net: { qty: number; avg: number }) => {
    if (net.qty > 0) {
      const pnl = (side === "LONG" ? lastMark - net.avg : net.avg - lastMark) * net.qty;
      wallet += pnl;
      if (pnl > 0) { wins++; sumWin += pnl; } else if (pnl < 0) { losses++; sumLoss += pnl; }
      closes++;
    }
  };
  closeAll("LONG", trendLongNet); closeAll("SHORT", trendShortNet);
  closeAll("LONG", s21LongNet); closeAll("SHORT", s21ShortNet);

  const roi = (wallet - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100;
  const maxDD = (hwm - lowestWallet) / hwm * 100;
  const wr = closes > 0 ? wins / closes * 100 : 0;
  const avgWin = wins > 0 ? sumWin / wins : 0;
  const avgLoss = losses > 0 ? sumLoss / losses : 0;
  const exp = closes > 0 ? (wr / 100 * avgWin + (1 - wr / 100) * avgLoss) : 0;
  const ra = maxDD > 0 ? roi / maxDD : (roi > 0 ? 999 : 0);
  return {
    name: cfg.name, roi: +roi.toFixed(2), maxDD: +maxDD.toFixed(2), ra: +ra.toFixed(2),
    entries, closes, wr: +wr.toFixed(2),
    rr: avgLoss < 0 ? +(avgWin / -avgLoss).toFixed(2) : 0,
    exp: +exp.toFixed(2), totalFees: Math.round(totalFees),
    setupCounts,
    byYear: Object.fromEntries(Object.entries(byYear).map(([k, v]) => [k, { ...v, pnl: Math.round(v.pnl) }])),
  };
}

function main() {
  console.log("[pullback-7y] Loading...");
  const c5 = loadCache("binance-5m-7y.json");
  const c1h = aggregateBars(c5, 60);
  const c4h = aggregateBars(c5, 240);
  const c1d = aggregateBars(c5, 1440);
  console.log(`  5m=${c5.length}, 1h=${c1h.length}, 4h=${c4h.length}, 1d=${c1d.length}`);

  console.log("[pullback-7y] Pre-computing indicators...");
  const ind = {
    rsi1h: calcRSI(c1h.map(b => b.close), 14),
    ma200d: calcSMA(c1d.map(b => b.close), 200), ma50d: calcSMA(c1d.map(b => b.close), 50),
    ema50_4h: calcEMA(c4h.map(b => b.close), EMA_FAST),
    ema200_4h: calcEMA(c4h.map(b => b.close), EMA_SLOW),
    atr14_4h: calcATR(c4h, 14),
  };

  const splitTs = new Date("2023-01-01T00:00:00Z").getTime();
  const splitIdx = c5.findIndex(b => b.time >= splitTs);

  const results: any[] = [];
  for (const cfg of SCENARIOS) {
    console.log(`\n[scenario] ${cfg.name}`);
    const rFull = runBacktest(c5, c1h, c4h, c1d, ind, cfg, 0, c5.length);
    const rTrain = runBacktest(c5, c1h, c4h, c1d, ind, cfg, 0, splitIdx);
    const rTest = runBacktest(c5, c1h, c4h, c1d, ind, cfg, splitIdx, c5.length);
    const stab = Object.values(rFull.byYear).filter((v: any) => v.pnl > 0).length;
    const total = Object.keys(rFull.byYear).length;
    console.log(`  Full 7y: ROI ${rFull.roi}% / RA ${rFull.ra} / ${rFull.entries}E ${stab}/${total}`);
    console.log(`  Train 2019-22: ROI ${rTrain.roi}% / RA ${rTrain.ra}`);
    console.log(`  Test 2023-26:  ROI ${rTest.roi}% / RA ${rTest.ra}`);
    results.push({ scenario: cfg.name, full: rFull, train: rTrain, test: rTest, stab: `${stab}/${total}` });
  }

  console.log("\n=== PULLBACK SCENARIOS COMPARISON 7y ===");
  console.log("Scenario                  | Full ROI% | Full RA | Stab | Train ROI% | Train RA | Test ROI% | Test RA | Entries");
  console.log("-".repeat(130));
  for (const r of results) {
    console.log(`${r.scenario.padEnd(25)} | ${String(r.full.roi).padStart(9)} | ${String(r.full.ra).padStart(7)} | ${r.stab.padStart(4)} | ${String(r.train.roi).padStart(10)} | ${String(r.train.ra).padStart(8)} | ${String(r.test.roi).padStart(9)} | ${String(r.test.ra).padStart(7)} | ${String(r.full.entries).padStart(7)}`);
  }

  console.log("\n=== Setup count per scenario ===");
  for (const r of results) {
    const counts = Object.entries(r.full.setupCounts).map(([k, v]) => `${k}=${v}`).join(", ");
    console.log(`  ${r.scenario}: ${counts}`);
  }

  writeFileSync(join(__dirname, "..", "assets", "backtest_pullback_7y.json"), JSON.stringify(results, null, 2));
  console.log(`\nWritten assets/backtest_pullback_7y.json`);
}

main();
