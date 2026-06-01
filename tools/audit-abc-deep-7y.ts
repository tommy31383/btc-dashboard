/**
 * audit-abc-deep-7y.ts — Deep audit A/B/C + test 6 improvements on top of A.
 *
 * BASE VARIANTS (re-confirm winners):
 *   A: V_ADX_22          (winner candidate)
 *   B: V_ADX25+VWAP      (low-DD alternative)
 *   C: V_ADX_25          (previous winner)
 *
 * IMPROVEMENTS layered on A (ADX > 22):
 *   A1: + STICKY (need 2 consecutive 4h bars ADX > 22) → reject noise spikes
 *   A2: + ATR_PCT_GATE (skip 4h ATR% below 30th percentile rolling 90 bars) → dead market
 *   A3: + DI_AGREE (LONG only if DI+ > DI-, SHORT only if DI- > DI+) → align direction
 *   A4: + MIN_ATR_PCT (require ATR% ≥ 1.0% / 4h) → avoid choppy
 *   A5: + EMA_TREND_GATE (price > EMA200 1h for LONG, < for SHORT) → momentum align
 *   A6: ALL of A1+A3+A5 combined (intersection — most strict)
 *
 * REPORT (per variant):
 *   - Full ROI / DD / RA / Entries / WR / RR
 *   - Per-direction: LONG vs SHORT (entries, wins, pnl)
 *   - Per-setup: S12 EMA / S13 ATR breakout / S14 Donchian
 *   - Per-regime: BULL / RANGE / BEAR
 *   - Per-year PnL + stability
 *   - Sharpe (monthly), max consecutive losses, max DD duration (days)
 *   - Train (2019-22) RA / Test (2023-26) RA / Walk-forward 5 folds
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

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }
type Regime = "BULL" | "RANGE" | "BEAR";

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
function calcATR(c: Candle[], p: number): (number | null)[] {
  const o: (number | null)[] = new Array(c.length).fill(null); if (c.length <= p) return o;
  const tr: number[] = new Array(c.length).fill(0);
  for (let i = 1; i < c.length; i++) tr[i] = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
  let s = 0; for (let i = 1; i <= p; i++) s += tr[i]; o[p] = s / p;
  for (let i = p + 1; i < c.length; i++) o[i] = (o[i - 1]! * (p - 1) + tr[i]) / p; return o;
}
// Returns { adx, plusDI, minusDI } arrays
function calcADXFull(c: Candle[], p: number = 14): { adx: (number | null)[]; plusDI: (number | null)[]; minusDI: (number | null)[] } {
  const adxOut: (number | null)[] = new Array(c.length).fill(null);
  const plusOut: (number | null)[] = new Array(c.length).fill(null);
  const minusOut: (number | null)[] = new Array(c.length).fill(null);
  if (c.length <= p + 1) return { adx: adxOut, plusDI: plusOut, minusDI: minusOut };
  const plusDM: number[] = new Array(c.length).fill(0);
  const minusDM: number[] = new Array(c.length).fill(0);
  const tr: number[] = new Array(c.length).fill(0);
  for (let i = 1; i < c.length; i++) {
    const upMove = c[i].high - c[i - 1].high;
    const dnMove = c[i - 1].low - c[i].low;
    plusDM[i] = upMove > dnMove && upMove > 0 ? upMove : 0;
    minusDM[i] = dnMove > upMove && dnMove > 0 ? dnMove : 0;
    tr[i] = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
  }
  let smTR = 0, smPlusDM = 0, smMinusDM = 0;
  for (let i = 1; i <= p; i++) { smTR += tr[i]; smPlusDM += plusDM[i]; smMinusDM += minusDM[i]; }
  const dxArr: number[] = [];
  for (let i = p + 1; i < c.length; i++) {
    smTR = smTR - smTR / p + tr[i];
    smPlusDM = smPlusDM - smPlusDM / p + plusDM[i];
    smMinusDM = smMinusDM - smMinusDM / p + minusDM[i];
    const plusDI = smTR > 0 ? smPlusDM / smTR * 100 : 0;
    const minusDI = smTR > 0 ? smMinusDM / smTR * 100 : 0;
    plusOut[i] = plusDI; minusOut[i] = minusDI;
    const dx = (plusDI + minusDI) > 0 ? Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100 : 0;
    dxArr.push(dx);
    if (dxArr.length >= p) {
      let adx = 0;
      for (let j = dxArr.length - p; j < dxArr.length; j++) adx += dxArr[j];
      adxOut[i] = adx / p;
    }
  }
  return { adx: adxOut, plusDI: plusOut, minusDI: minusOut };
}
function findIdx(arr: { time: number }[], ts: number, hint: number = 0): number {
  let lo = hint, hi = arr.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (arr[mid].time <= ts) lo = mid; else hi = mid - 1; }
  return lo;
}

interface VariantCfg {
  name: string;
  adxThreshold: number;
  useVwap: boolean;
  stickyADX: boolean;            // need 2 consecutive 4h bars
  atrPctGate: boolean;           // 4h ATR% > rolling 30th percentile
  diAgree: boolean;              // LONG only if +DI > -DI
  minAtrPct: number | null;      // require 4h ATR% ≥ X
  emaTrendGate: boolean;         // price > EMA200 1h for LONG
}

const VARIANTS: VariantCfg[] = [
  { name: "A_ADX22",              adxThreshold: 22, useVwap: false, stickyADX: false, atrPctGate: false, diAgree: false, minAtrPct: null, emaTrendGate: false },
  { name: "B_ADX25+VWAP",         adxThreshold: 25, useVwap: true,  stickyADX: false, atrPctGate: false, diAgree: false, minAtrPct: null, emaTrendGate: false },
  { name: "C_ADX25",              adxThreshold: 25, useVwap: false, stickyADX: false, atrPctGate: false, diAgree: false, minAtrPct: null, emaTrendGate: false },
  { name: "A1_+sticky",           adxThreshold: 22, useVwap: false, stickyADX: true,  atrPctGate: false, diAgree: false, minAtrPct: null, emaTrendGate: false },
  { name: "A2_+atrGate",          adxThreshold: 22, useVwap: false, stickyADX: false, atrPctGate: true,  diAgree: false, minAtrPct: null, emaTrendGate: false },
  { name: "A3_+diAgree",          adxThreshold: 22, useVwap: false, stickyADX: false, atrPctGate: false, diAgree: true,  minAtrPct: null, emaTrendGate: false },
  { name: "A4_+minAtr1pct",       adxThreshold: 22, useVwap: false, stickyADX: false, atrPctGate: false, diAgree: false, minAtrPct: 1.0,  emaTrendGate: false },
  { name: "A5_+emaTrendGate",     adxThreshold: 22, useVwap: false, stickyADX: false, atrPctGate: false, diAgree: false, minAtrPct: null, emaTrendGate: true },
  { name: "A6_sticky+di+ema",     adxThreshold: 22, useVwap: false, stickyADX: true,  atrPctGate: false, diAgree: true,  minAtrPct: null, emaTrendGate: true },
];

interface TrendTrade { id: string; kind: string; side: "LONG" | "SHORT"; entryPx: number; qty: number; hwm: number; lwm: number; slPx: number; atrEntry: number; entryRegime: Regime; entryTs: number; }

interface DeepStats {
  name: string;
  roi: number; maxDD: number; ra: number;
  entries: number; closes: number; wr: number; rr: number;
  byYear: Record<string, { entries: number; closes: number; pnl: number }>;
  byDir: { LONG: { entries: number; wins: number; pnl: number }; SHORT: { entries: number; wins: number; pnl: number } };
  bySetup: Record<string, { entries: number; wins: number; pnl: number }>;
  byRegime: Record<Regime, { entries: number; wins: number; pnl: number }>;
  maxConsecLosses: number;
  ddDurationDays: number;
  sharpeMonthly: number;
  monthlyPnL: number[];
}

function runDeep(c5: Candle[], c15m: Candle[], c1h: Candle[], c4h: Candle[], c1d: Candle[], c1w: Candle[], ind: any, cfg: VariantCfg, startIdx: number, endIdx: number, name: string): DeepStats {
  let wallet = INITIAL_CAPITAL, hwm = INITIAL_CAPITAL, hwmTs = c5[startIdx]?.time ?? 0;
  let trendLongNet = { qty: 0, avg: 0 }, trendShortNet = { qty: 0, avg: 0 };
  let trendTrades: TrendTrade[] = [];
  let lastS12L = 0, lastS12S = 0, lastS13L = 0, lastS13S = 0, lastS14L = 0, lastS14S = 0;
  let regime: Regime = "RANGE", regimeConsec = 0, regimeLastRaw: Regime = "RANGE";
  let entries = 0, closes = 0, wins = 0, losses = 0, sumWin = 0, sumLoss = 0;
  let lowestWallet = INITIAL_CAPITAL;
  let curConsecLosses = 0, maxConsecLosses = 0;
  let maxDDDurationMs = 0;
  const byYear: Record<string, { entries: number; closes: number; pnl: number }> = {};
  const byDir = { LONG: { entries: 0, wins: 0, pnl: 0 }, SHORT: { entries: 0, wins: 0, pnl: 0 } };
  const bySetup: Record<string, { entries: number; wins: number; pnl: number }> = {};
  const byRegime: Record<Regime, { entries: number; wins: number; pnl: number }> = {
    BULL: { entries: 0, wins: 0, pnl: 0 }, RANGE: { entries: 0, wins: 0, pnl: 0 }, BEAR: { entries: 0, wins: 0, pnl: 0 },
  };
  const monthlyPnL: Record<string, number> = {};
  let idx15m = 0, idx1h = 0, idx1d = 0, idx1w = 0, idx4h = 0;
  let last4hIdx = -1;
  let lastAdxPass = false;  // for sticky

  for (let i = startIdx; i < endIdx; i++) {
    const bar = c5[i]; const ts = bar.time; const mark = bar.close;

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
        const net = pnl - fee;
        wallet += net;
        if (wallet > hwm) { hwm = wallet; hwmTs = ts; }
        else { const dur = ts - hwmTs; if (dur > maxDDDurationMs) maxDDDurationMs = dur; }
        if (wallet < lowestWallet) lowestWallet = wallet;
        closes++;
        if (pnl > 0) { wins++; sumWin += pnl; curConsecLosses = 0; }
        else { losses++; sumLoss += pnl; curConsecLosses++; if (curConsecLosses > maxConsecLosses) maxConsecLosses = curConsecLosses; }
        const y = new Date(ts).toISOString().slice(0, 4);
        byYear[y] = byYear[y] ?? { entries: 0, closes: 0, pnl: 0 };
        byYear[y].closes++; byYear[y].pnl += net;
        const m = new Date(ts).toISOString().slice(0, 7);
        monthlyPnL[m] = (monthlyPnL[m] ?? 0) + net;
        byDir[t.side].pnl += net; if (pnl > 0) byDir[t.side].wins++;
        bySetup[t.kind] = bySetup[t.kind] ?? { entries: 0, wins: 0, pnl: 0 };
        bySetup[t.kind].pnl += net; if (pnl > 0) bySetup[t.kind].wins++;
        byRegime[t.entryRegime].pnl += net; if (pnl > 0) byRegime[t.entryRegime].wins++;
        const netRef = t.side === "LONG" ? trendLongNet : trendShortNet;
        const rq = Math.max(0, netRef.qty - t.qty);
        if (t.side === "LONG") trendLongNet = { qty: rq, avg: rq > 0 ? netRef.avg : 0 };
        else trendShortNet = { qty: rq, avg: rq > 0 ? netRef.avg : 0 };
      } else newTrend.push(t);
    }
    trendTrades = newTrend;

    if (i < startIdx + 60) continue;
    idx1h = findIdx(c1h, ts, idx1h); idx4h = findIdx(c4h, ts, idx4h); idx1d = findIdx(c1d, ts, idx1d);
    idx15m = findIdx(c15m, ts, idx15m); idx1w = findIdx(c1w, ts, idx1w);
    const idx4hc = idx4h - 1; const idx1hc = idx1h - 1; const idx1dc = idx1d - 1;
    if (idx4hc < EMA_SLOW + 1 || idx4hc === last4hIdx) continue;
    last4hIdx = idx4hc;

    // Regime
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

    const adxVal = ind.adx14_4h[idx4hc];
    const plusDI = ind.plusDI_4h[idx4hc];
    const minusDI = ind.minusDI_4h[idx4hc];
    const adxPassRaw = adxVal !== null && adxVal > cfg.adxThreshold;
    const adxPass = cfg.stickyADX ? (adxPassRaw && lastAdxPass) : adxPassRaw;
    lastAdxPass = adxPassRaw;

    // VWAP filter
    let vwapLong = true, vwapShort = true;
    if (cfg.useVwap && ind.vwap30d[idx1dc] !== null) {
      const vwap = ind.vwap30d[idx1dc];
      if (mark > vwap) vwapShort = false;
      else if (mark < vwap) vwapLong = false;
    }

    // ATR percentile gate (4h)
    let atrGatePass = true;
    if (cfg.atrPctGate && idx4hc >= 90) {
      const cur4hATR = ind.atr14_4h[idx4hc];
      const cur4hClose = c4h[idx4hc].close;
      if (cur4hATR === null) atrGatePass = false;
      else {
        const curPct = cur4hATR / cur4hClose * 100;
        const arr: number[] = [];
        for (let j = idx4hc - 89; j <= idx4hc; j++) {
          const a = ind.atr14_4h[j];
          if (a !== null) arr.push(a / c4h[j].close * 100);
        }
        arr.sort((a, b) => a - b);
        const p30 = arr[Math.floor(arr.length * 0.3)];
        atrGatePass = curPct >= p30;
      }
    }

    // Min ATR pct
    let minAtrPass = true;
    if (cfg.minAtrPct !== null) {
      const cur4hATR = ind.atr14_4h[idx4hc];
      const cur4hClose = c4h[idx4hc].close;
      if (cur4hATR === null) minAtrPass = false;
      else minAtrPass = (cur4hATR / cur4hClose * 100) >= cfg.minAtrPct;
    }

    // EMA200 1h trend gate
    let emaLong = true, emaShort = true;
    if (cfg.emaTrendGate && idx1hc >= 200) {
      const ema200_1h = ind.ema200_1h[idx1hc];
      if (ema200_1h === null) { emaLong = false; emaShort = false; }
      else {
        if (c1h[idx1hc].close < ema200_1h) emaLong = false;
        if (c1h[idx1hc].close > ema200_1h) emaShort = false;
      }
    }

    // DI agreement
    let diLong = true, diShort = true;
    if (cfg.diAgree) {
      if (plusDI === null || minusDI === null) { diLong = false; diShort = false; }
      else {
        if (plusDI <= minusDI) diLong = false;
        if (minusDI <= plusDI) diShort = false;
      }
    }

    let filterLong = allowLong, filterShort = allowShort;
    if (!adxPass) { filterLong = false; filterShort = false; }
    if (cfg.useVwap) { if (!vwapLong) filterLong = false; if (!vwapShort) filterShort = false; }
    if (cfg.atrPctGate && !atrGatePass) { filterLong = false; filterShort = false; }
    if (cfg.minAtrPct !== null && !minAtrPass) { filterLong = false; filterShort = false; }
    if (cfg.emaTrendGate) { if (!emaLong) filterLong = false; if (!emaShort) filterShort = false; }
    if (cfg.diAgree) { if (!diLong) filterLong = false; if (!diShort) filterShort = false; }

    // Trend setups
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
      if (side === "LONG" && !filterLong) return;
      if (side === "SHORT" && !filterShort) return;
      const qty = baseQty;
      const cur = side === "LONG" ? trendLongNet.qty : trendShortNet.qty;
      if (cur + qty > TREND_MAX_QTY_PER_SIDE) return;
      const slPx = side === "LONG" ? mark - atrVal4h * TREND_ATR_SL_MULT : mark + atrVal4h * TREND_ATR_SL_MULT;
      const fee = qty * mark * FEE_PCT / 100;
      wallet -= fee;
      const net = side === "LONG" ? trendLongNet : trendShortNet;
      const nq = net.qty + qty;
      const newNet = { qty: nq, avg: (net.qty * net.avg + qty * mark) / nq };
      if (side === "LONG") trendLongNet = newNet; else trendShortNet = newNet;
      trendTrades.push({ id: `${kind}_${side}_${ts}`, kind, side, entryPx: mark, qty, hwm: mark, lwm: mark, slPx, atrEntry: atrVal4h, entryRegime: regime, entryTs: ts });
      lastTsRef.v = ts; entries++;
      byDir[side].entries++;
      bySetup[kind] = bySetup[kind] ?? { entries: 0, wins: 0, pnl: 0 };
      bySetup[kind].entries++;
      byRegime[regime].entries++;
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

  // Close residual at end (only for full-period stats — comment for clean equity)

  const roi = (wallet - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100;
  const maxDD = (hwm - lowestWallet) / hwm * 100;
  const wr = closes > 0 ? wins / closes * 100 : 0;
  const avgWin = wins > 0 ? sumWin / wins : 0;
  const avgLoss = losses > 0 ? sumLoss / losses : 0;
  const ra = maxDD > 0 ? roi / maxDD : (roi > 0 ? 999 : 0);
  const monthlyArr = Object.values(monthlyPnL);
  const meanM = monthlyArr.length > 0 ? monthlyArr.reduce((a, b) => a + b, 0) / monthlyArr.length : 0;
  const stdM = monthlyArr.length > 1 ? Math.sqrt(monthlyArr.reduce((s, v) => s + (v - meanM) ** 2, 0) / (monthlyArr.length - 1)) : 0;
  const sharpe = stdM > 0 ? (meanM / stdM) * Math.sqrt(12) : 0;  // annualized

  return {
    name,
    roi: +roi.toFixed(2), maxDD: +maxDD.toFixed(2), ra: +ra.toFixed(2),
    entries, closes, wr: +wr.toFixed(2),
    rr: avgLoss < 0 ? +(avgWin / -avgLoss).toFixed(2) : 0,
    byYear: Object.fromEntries(Object.entries(byYear).map(([k, v]) => [k, { ...v, pnl: Math.round(v.pnl) }])),
    byDir: {
      LONG: { entries: byDir.LONG.entries, wins: byDir.LONG.wins, pnl: Math.round(byDir.LONG.pnl) },
      SHORT: { entries: byDir.SHORT.entries, wins: byDir.SHORT.wins, pnl: Math.round(byDir.SHORT.pnl) },
    },
    bySetup: Object.fromEntries(Object.entries(bySetup).map(([k, v]) => [k, { entries: v.entries, wins: v.wins, pnl: Math.round(v.pnl) }])),
    byRegime: {
      BULL: { entries: byRegime.BULL.entries, wins: byRegime.BULL.wins, pnl: Math.round(byRegime.BULL.pnl) },
      RANGE: { entries: byRegime.RANGE.entries, wins: byRegime.RANGE.wins, pnl: Math.round(byRegime.RANGE.pnl) },
      BEAR: { entries: byRegime.BEAR.entries, wins: byRegime.BEAR.wins, pnl: Math.round(byRegime.BEAR.pnl) },
    },
    maxConsecLosses,
    ddDurationDays: +(maxDDDurationMs / 86_400_000).toFixed(1),
    sharpeMonthly: +sharpe.toFixed(2),
    monthlyPnL: monthlyArr.map(v => +v.toFixed(0)),
  };
}

function main() {
  console.log("[audit-abc] Loading 7y data...");
  const c5 = loadCache("binance-5m-7y.json");
  const c15m = aggregateBars(c5, 15);
  const c1h = aggregateBars(c5, 60);
  const c4h = aggregateBars(c5, 240);
  const c1d = aggregateBars(c5, 1440);
  const c1w = aggregateBars(c5, 10080);
  console.log(`  5m=${c5.length}, 15m=${c15m.length}, 1h=${c1h.length}, 4h=${c4h.length}, 1d=${c1d.length}, 1w=${c1w.length}`);

  console.log("[audit-abc] Pre-computing indicators...");
  const adxFull = calcADXFull(c4h, 14);
  const ind = {
    ma200d: calcSMA(c1d.map(b => b.close), 200), ma50d: calcSMA(c1d.map(b => b.close), 50),
    ema50_4h: calcEMA(c4h.map(b => b.close), EMA_FAST),
    ema200_4h: calcEMA(c4h.map(b => b.close), EMA_SLOW),
    ema200_1h: calcEMA(c1h.map(b => b.close), 200),
    atr14_4h: calcATR(c4h, 14),
    adx14_4h: adxFull.adx,
    plusDI_4h: adxFull.plusDI,
    minusDI_4h: adxFull.minusDI,
    vwap30d: (() => {
      const out: (number | null)[] = new Array(c1d.length).fill(null);
      for (let i = 29; i < c1d.length; i++) {
        let pv = 0, v = 0;
        for (let j = i - 29; j <= i; j++) {
          const tp = (c1d[j].high + c1d[j].low + c1d[j].close) / 3;
          const vol = c1d[j].volume ?? 0;
          pv += tp * vol; v += vol;
        }
        out[i] = v > 0 ? pv / v : null;
      }
      return out;
    })(),
  };

  const splitTs = new Date("2023-01-01T00:00:00Z").getTime();
  const splitIdx = c5.findIndex(b => b.time >= splitTs);

  // Walk-forward 5 folds: 2019-21→22, 2019-22→23, 2019-23→24, 2019-24→25, 2019-25→26
  const yearStarts = [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026].map(y => {
    const ts = new Date(`${y}-01-01T00:00:00Z`).getTime();
    return c5.findIndex(b => b.time >= ts);
  });
  const wfFolds = [
    { testYear: 2022, trainEnd: yearStarts[3], testEnd: yearStarts[4] },
    { testYear: 2023, trainEnd: yearStarts[4], testEnd: yearStarts[5] },
    { testYear: 2024, trainEnd: yearStarts[5], testEnd: yearStarts[6] },
    { testYear: 2025, trainEnd: yearStarts[6], testEnd: yearStarts[7] },
    { testYear: 2026, trainEnd: yearStarts[7], testEnd: c5.length },
  ];

  const results: any[] = [];
  for (const cfg of VARIANTS) {
    const rFull = runDeep(c5, c15m, c1h, c4h, c1d, c1w, ind, cfg, 0, c5.length, cfg.name);
    const rTrain = runDeep(c5, c15m, c1h, c4h, c1d, c1w, ind, cfg, 0, splitIdx, `${cfg.name}_train`);
    const rTest = runDeep(c5, c15m, c1h, c4h, c1d, c1w, ind, cfg, splitIdx, c5.length, `${cfg.name}_test`);
    const wf = wfFolds.map(f => {
      const r = runDeep(c5, c15m, c1h, c4h, c1d, c1w, ind, cfg, f.trainEnd, f.testEnd, `${cfg.name}_wf${f.testYear}`);
      return { year: f.testYear, roi: r.roi, dd: r.maxDD, ra: r.ra, entries: r.entries };
    });
    const stab = Object.values(rFull.byYear).filter((v: any) => v.pnl > 0).length;
    const total = Object.keys(rFull.byYear).length;
    results.push({ scenario: cfg.name, full: rFull, train: rTrain, test: rTest, wf, stab: `${stab}/${total}` });
    console.log(`${cfg.name.padEnd(24)}: Full RA ${rFull.ra} | Train ${rTrain.ra} | Test ${rTest.ra} | Stab ${stab}/${total} | Entries ${rFull.entries} | Sharpe ${rFull.sharpeMonthly} | MaxConsecL ${rFull.maxConsecLosses} | DDdur ${rFull.ddDurationDays}d`);
  }

  // Sort by composite: avg(train,test) + stab/total*0.1 + sharpe*0.05
  results.sort((a, b) => {
    const scoreA = (a.train.ra + a.test.ra) / 2 + (parseInt(a.stab.split("/")[0]) / parseInt(a.stab.split("/")[1])) * 0.1 + a.full.sharpeMonthly * 0.05;
    const scoreB = (b.train.ra + b.test.ra) / 2 + (parseInt(b.stab.split("/")[0]) / parseInt(b.stab.split("/")[1])) * 0.1 + b.full.sharpeMonthly * 0.05;
    return scoreB - scoreA;
  });

  console.log("\n=== AUDIT A/B/C + 6 IMPROVEMENTS (sorted by composite) ===");
  console.log("Scenario             | Full RA | Train | Test  | Stab | Entries | Sharpe | MaxCL | DDdur");
  console.log("-".repeat(100));
  for (const r of results) {
    console.log(`${r.scenario.padEnd(20)} | ${String(r.full.ra).padStart(7)} | ${String(r.train.ra).padStart(5)} | ${String(r.test.ra).padStart(5)} | ${r.stab.padStart(4)} | ${String(r.full.entries).padStart(7)} | ${String(r.full.sharpeMonthly).padStart(6)} | ${String(r.full.maxConsecLosses).padStart(5)} | ${String(r.full.ddDurationDays).padStart(5)}d`);
  }

  console.log("\n=== WALK-FORWARD (per-year test, train cumulative) ===");
  console.log("Scenario             | wf2022 | wf2023 | wf2024 | wf2025 | wf2026 | mean RA");
  console.log("-".repeat(100));
  for (const r of results) {
    const ras = r.wf.map((w: any) => w.ra);
    const meanRA = ras.reduce((a: number, b: number) => a + b, 0) / ras.length;
    console.log(`${r.scenario.padEnd(20)} | ${ras.map((v: number) => String(v).padStart(6)).join(" | ")} | ${meanRA.toFixed(2).padStart(7)}`);
  }

  console.log("\n=== PER-DIRECTION (Full period) ===");
  console.log("Scenario             | LONG entries/wins/pnl | SHORT entries/wins/pnl");
  console.log("-".repeat(100));
  for (const r of results) {
    const L = r.full.byDir.LONG; const S = r.full.byDir.SHORT;
    console.log(`${r.scenario.padEnd(20)} | ${String(L.entries).padStart(4)} / ${String(L.wins).padStart(4)} / ${String(L.pnl).padStart(6)} | ${String(S.entries).padStart(4)} / ${String(S.wins).padStart(4)} / ${String(S.pnl).padStart(6)}`);
  }

  console.log("\n=== PER-REGIME (Full period) ===");
  console.log("Scenario             | BULL ent/wins/pnl  | RANGE ent/wins/pnl | BEAR ent/wins/pnl");
  console.log("-".repeat(100));
  for (const r of results) {
    const B = r.full.byRegime.BULL; const R = r.full.byRegime.RANGE; const E = r.full.byRegime.BEAR;
    console.log(`${r.scenario.padEnd(20)} | ${String(B.entries).padStart(4)}/${String(B.wins).padStart(3)}/${String(B.pnl).padStart(6)} | ${String(R.entries).padStart(4)}/${String(R.wins).padStart(3)}/${String(R.pnl).padStart(6)} | ${String(E.entries).padStart(4)}/${String(E.wins).padStart(3)}/${String(E.pnl).padStart(6)}`);
  }

  console.log("\n=== PER-SETUP (Full period) ===");
  console.log("Scenario             | S12 ent/wins/pnl   | S13 ent/wins/pnl   | S14 ent/wins/pnl");
  console.log("-".repeat(100));
  for (const r of results) {
    const s12 = r.full.bySetup.S12 ?? { entries: 0, wins: 0, pnl: 0 };
    const s13 = r.full.bySetup.S13 ?? { entries: 0, wins: 0, pnl: 0 };
    const s14 = r.full.bySetup.S14 ?? { entries: 0, wins: 0, pnl: 0 };
    console.log(`${r.scenario.padEnd(20)} | ${String(s12.entries).padStart(4)}/${String(s12.wins).padStart(3)}/${String(s12.pnl).padStart(6)} | ${String(s13.entries).padStart(4)}/${String(s13.wins).padStart(3)}/${String(s13.pnl).padStart(6)} | ${String(s14.entries).padStart(4)}/${String(s14.wins).padStart(3)}/${String(s14.pnl).padStart(6)}`);
  }

  writeFileSync(join(__dirname, "..", "assets", "audit_abc_deep_7y.json"), JSON.stringify(results, null, 2));
  console.log(`\nWritten assets/audit_abc_deep_7y.json`);
}

main();
