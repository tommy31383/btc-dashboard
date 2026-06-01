/**
 * backtest-a20-a21-a22-3y.ts — Test 3 improvements + combined trên 3y (2023-05 → 2026-05)
 *
 * BASELINE: v0.4.42/0.4.43 shipped (ADX>20 + sticky + ema + atrGate, ATR×3 trailing, all setups+sides)
 *
 * VARIANTS:
 *   A20: ATR×4 trailing first 48h, then ATR×3 (let trend establish)
 *   A21: Drop S13 SHORT entirely (WR 37.7% bleed)
 *   A22: S13+S14 require 4h vol > MA20(4h) × 1.2
 *   A_NEXT: A20 + A21 + A22 combined
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const INITIAL_CAPITAL = 100_000;
const FEE_PCT = 0.05;
const EMA_FAST = 50;
const EMA_SLOW = 200;
const ATR_BREAKOUT_MULT = 1.5;
const DONCHIAN_LOOKBACK = 20;
const REGIME_PERSIST_BARS = 3;
const SETUP12_QTY = 0.005, SETUP13_QTY = 0.003, SETUP14_QTY = 0.005;
const SETUP12_COOLDOWN_MS = 12 * 60 * 60_000;
const SETUP13_COOLDOWN_MS = 4 * 60 * 60_000;
const SETUP14_COOLDOWN_MS = 12 * 60 * 60_000;
const TREND_MAX_QTY_PER_SIDE = 0.02;

const ADX_THRESHOLD = 20;
const ADX_PERIOD = 14;
const ADX_STICKY = true;
const ATR_PCT_LOOKBACK = 90;
const ATR_PCT_PERCENTILE = 0.30;

const A20_INITIAL_SL_MULT = 4;
const A20_TRAILING_SL_MULT = 3;
const A20_TRANSITION_MS = 48 * 60 * 60_000;
const A22_VOL_MA = 20;
const A22_VOL_MULT = 1.2;

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
function calcADXFull(c: Candle[], p: number = 14): { adx: (number | null)[] } {
  const adxOut: (number | null)[] = new Array(c.length).fill(null);
  if (c.length <= p + 1) return { adx: adxOut };
  const plusDM: number[] = new Array(c.length).fill(0);
  const minusDM: number[] = new Array(c.length).fill(0);
  const tr: number[] = new Array(c.length).fill(0);
  for (let i = 1; i < c.length; i++) {
    const up = c[i].high - c[i - 1].high; const dn = c[i - 1].low - c[i].low;
    plusDM[i] = up > dn && up > 0 ? up : 0;
    minusDM[i] = dn > up && dn > 0 ? dn : 0;
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
    const dx = (plusDI + minusDI) > 0 ? Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100 : 0;
    dxArr.push(dx);
    if (dxArr.length >= p) {
      let adx = 0;
      for (let j = dxArr.length - p; j < dxArr.length; j++) adx += dxArr[j];
      adxOut[i] = adx / p;
    }
  }
  return { adx: adxOut };
}
function findIdx(arr: { time: number }[], ts: number, hint: number = 0): number {
  let lo = hint, hi = arr.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (arr[mid].time <= ts) lo = mid; else hi = mid - 1; }
  return lo;
}

interface VariantCfg {
  name: string;
  a20Enable: boolean;
  a21Enable: boolean;
  a22Enable: boolean;
}

const VARIANTS: VariantCfg[] = [
  { name: "BASELINE_v042",       a20Enable: false, a21Enable: false, a22Enable: false },
  { name: "A20_widerInitSL",     a20Enable: true,  a21Enable: false, a22Enable: false },
  { name: "A21_dropS13Short",    a20Enable: false, a21Enable: true,  a22Enable: false },
  { name: "A22_volFilter",       a20Enable: false, a21Enable: false, a22Enable: true  },
  { name: "A_NEXT_combo",        a20Enable: true,  a21Enable: true,  a22Enable: true  },
  { name: "A20_A22_combo",       a20Enable: true,  a21Enable: false, a22Enable: true  },
];

interface TrendTrade { id: string; kind: string; side: "LONG" | "SHORT"; entryPx: number; qty: number; hwm: number; lwm: number; slPx: number; atrEntry: number; entryTs: number; }

function run(c5: Candle[], c1h: Candle[], c4h: Candle[], c1d: Candle[], ind: any, cfg: VariantCfg, startIdx: number, endIdx: number): any {
  let wallet = INITIAL_CAPITAL, hwm = INITIAL_CAPITAL, hwmTs = c5[startIdx]?.time ?? 0;
  let lowestWallet = INITIAL_CAPITAL;
  let trendLongNet = { qty: 0, avg: 0 }, trendShortNet = { qty: 0, avg: 0 };
  let trendTrades: TrendTrade[] = [];
  let lastS12L = 0, lastS12S = 0, lastS13L = 0, lastS13S = 0, lastS14L = 0, lastS14S = 0;
  let regime: Regime = "RANGE", regimeConsec = 0, regimeLastRaw: Regime = "RANGE";
  let entries = 0, closes = 0, wins = 0, losses = 0, sumWin = 0, sumLoss = 0;
  let maxConsecLosses = 0, curConsecLosses = 0, maxDDDurationMs = 0;
  const byYear: Record<string, { entries: number; closes: number; pnl: number }> = {};
  const byDir = { LONG: { entries: 0, wins: 0, pnl: 0 }, SHORT: { entries: 0, wins: 0, pnl: 0 } };
  const bySetup: Record<string, { entries: number; wins: number; pnl: number }> = {};
  let idx1h = 0, idx4h = 0, idx1d = 0;
  let last4hIdx = -1;

  // Precompute 4h volume MA for A22
  const vol4hMA: (number | null)[] = new Array(c4h.length).fill(null);
  for (let i = A22_VOL_MA - 1; i < c4h.length; i++) {
    let s = 0;
    for (let j = i - A22_VOL_MA + 1; j <= i; j++) s += c4h[j].volume ?? 0;
    vol4hMA[i] = s / A22_VOL_MA;
  }

  for (let i = startIdx; i < endIdx; i++) {
    const bar = c5[i]; const ts = bar.time; const mark = bar.close;

    // Update trailing SL + close check (with A20 logic)
    const newTrend: TrendTrade[] = [];
    for (const t of trendTrades) {
      const heldMs = ts - t.entryTs;
      const slMult = cfg.a20Enable && heldMs < A20_TRANSITION_MS ? A20_INITIAL_SL_MULT : A20_TRAILING_SL_MULT;
      if (t.side === "LONG") {
        if (mark > t.hwm) { t.hwm = mark; t.slPx = t.hwm - t.atrEntry * slMult; }
        else if (cfg.a20Enable && heldMs >= A20_TRANSITION_MS && t.slPx < t.hwm - t.atrEntry * A20_TRAILING_SL_MULT) {
          // Transition tighter SL after 48h
          t.slPx = t.hwm - t.atrEntry * A20_TRAILING_SL_MULT;
        }
      } else {
        if (mark < t.lwm) { t.lwm = mark; t.slPx = t.lwm + t.atrEntry * slMult; }
        else if (cfg.a20Enable && heldMs >= A20_TRANSITION_MS && t.slPx > t.lwm + t.atrEntry * A20_TRAILING_SL_MULT) {
          t.slPx = t.lwm + t.atrEntry * A20_TRAILING_SL_MULT;
        }
      }
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
        byDir[t.side].pnl += net; if (pnl > 0) byDir[t.side].wins++;
        bySetup[t.kind] = bySetup[t.kind] ?? { entries: 0, wins: 0, pnl: 0 };
        bySetup[t.kind].pnl += net; if (pnl > 0) bySetup[t.kind].wins++;
        const netRef = t.side === "LONG" ? trendLongNet : trendShortNet;
        const rq = Math.max(0, netRef.qty - t.qty);
        if (t.side === "LONG") trendLongNet = { qty: rq, avg: rq > 0 ? netRef.avg : 0 };
        else trendShortNet = { qty: rq, avg: rq > 0 ? netRef.avg : 0 };
      } else newTrend.push(t);
    }
    trendTrades = newTrend;

    if (i < startIdx + 60) continue;
    idx1h = findIdx(c1h, ts, idx1h); idx4h = findIdx(c4h, ts, idx4h); idx1d = findIdx(c1d, ts, idx1d);
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

    // A19 baseline filters
    const adxVal = ind.adx14_4h[idx4hc];
    const adxPrev = ind.adx14_4h[idx4hc - 1];
    const adxPass = adxVal !== null && adxVal > ADX_THRESHOLD && (!ADX_STICKY || (adxPrev !== null && adxPrev > ADX_THRESHOLD));

    let emaLong = true, emaShort = true;
    if (idx1hc >= 200) {
      const e = ind.ema200_1h[idx1hc];
      if (e === null) { emaLong = false; emaShort = false; }
      else { if (c1h[idx1hc].close < e) emaLong = false; if (c1h[idx1hc].close > e) emaShort = false; }
    } else { emaLong = false; emaShort = false; }

    let atrGatePass = true;
    if (idx4hc >= 90) {
      const cur4hATR = ind.atr14_4h[idx4hc];
      const cur4hClose = c4h[idx4hc].close;
      if (cur4hATR === null) atrGatePass = false;
      else {
        const curPct = cur4hATR / cur4hClose * 100;
        const arr: number[] = [];
        for (let j = idx4hc - 89; j <= idx4hc; j++) {
          const a = ind.atr14_4h[j]; if (a !== null) arr.push(a / c4h[j].close * 100);
        }
        arr.sort((a, b) => a - b);
        const pX = arr[Math.floor(arr.length * ATR_PCT_PERCENTILE)];
        atrGatePass = curPct >= pX;
      }
    }

    // A22 vol filter: applied to S13/S14 entry, not gating
    const volPass = cfg.a22Enable ? (() => {
      const ma = vol4hMA[idx4hc]; const vol = c4h[idx4hc].volume ?? 0;
      return ma !== null && ma > 0 && vol >= ma * A22_VOL_MULT;
    })() : true;

    let filterLong = allowLong, filterShort = allowShort;
    if (!adxPass || !atrGatePass) { filterLong = false; filterShort = false; }
    if (!emaLong) filterLong = false;
    if (!emaShort) filterShort = false;

    // Setup detection
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
      // A21: drop S13 SHORT
      if (cfg.a21Enable && kind === "S13" && side === "SHORT") return;
      // A22: vol filter for S13/S14
      if (cfg.a22Enable && (kind === "S13" || kind === "S14") && !volPass) return;
      if (side === "LONG" && !filterLong) return;
      if (side === "SHORT" && !filterShort) return;
      const qty = baseQty;
      const cur = side === "LONG" ? trendLongNet.qty : trendShortNet.qty;
      if (cur + qty > TREND_MAX_QTY_PER_SIDE) return;
      // A20: initial SL is ATR×4 (default ATR×3)
      const initSLMult = cfg.a20Enable ? A20_INITIAL_SL_MULT : A20_TRAILING_SL_MULT;
      const slPx = side === "LONG" ? mark - atrVal4h * initSLMult : mark + atrVal4h * initSLMult;
      const entryFee = qty * mark * FEE_PCT / 100;
      wallet -= entryFee;
      const net = side === "LONG" ? trendLongNet : trendShortNet;
      const nq = net.qty + qty;
      const newNet = { qty: nq, avg: (net.qty * net.avg + qty * mark) / nq };
      if (side === "LONG") trendLongNet = newNet; else trendShortNet = newNet;
      trendTrades.push({ id: `${kind}_${side}_${ts}`, kind, side, entryPx: mark, qty, hwm: mark, lwm: mark, slPx, atrEntry: atrVal4h, entryTs: ts });
      lastTsRef.v = ts; entries++;
      byDir[side].entries++;
      bySetup[kind] = bySetup[kind] ?? { entries: 0, wins: 0, pnl: 0 };
      bySetup[kind].entries++;
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

  const roi = (wallet - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100;
  const maxDD = (hwm - lowestWallet) / hwm * 100;
  const wr = closes > 0 ? wins / closes * 100 : 0;
  const avgWin = wins > 0 ? sumWin / wins : 0;
  const avgLoss = losses > 0 ? sumLoss / losses : 0;
  const ra = maxDD > 0 ? roi / maxDD : (roi > 0 ? 999 : 0);
  const stab = Object.values(byYear).filter(d => d.pnl > 0).length;
  const total = Object.keys(byYear).length;
  return { entries, closes, wr: +wr.toFixed(1), roi: +roi.toFixed(2), maxDD: +maxDD.toFixed(2), ra: +ra.toFixed(2), rr: avgLoss < 0 ? +(avgWin / -avgLoss).toFixed(2) : 0, maxConsecLosses, ddDurationDays: +(maxDDDurationMs / 86_400_000).toFixed(1), byYear, byDir, bySetup, stab: `${stab}/${total}` };
}

function main() {
  console.log("[bt-a20-21-22] Loading 3y...");
  const c5all = loadCache("binance-5m-7y.json");
  const startTs = new Date("2023-05-25T00:00:00Z").getTime();
  const endTs = new Date("2026-05-25T00:00:00Z").getTime();
  const warmupTs = startTs - 60 * 86_400_000;
  const c5 = c5all.filter(b => b.time >= warmupTs && b.time <= endTs);
  const startIdx = c5.findIndex(b => b.time >= startTs);
  const c1h = aggregateBars(c5, 60);
  const c4h = aggregateBars(c5, 240);
  const c1d = aggregateBars(c5, 1440);
  console.log(`  5m=${c5.length}, 1h=${c1h.length}, 4h=${c4h.length}, 1d=${c1d.length}`);

  console.log("[bt-a20-21-22] Pre-computing indicators...");
  const adxObj = calcADXFull(c4h, ADX_PERIOD);
  const ind = {
    ma200d: calcSMA(c1d.map(b => b.close), 200), ma50d: calcSMA(c1d.map(b => b.close), 50),
    ema50_4h: calcEMA(c4h.map(b => b.close), EMA_FAST),
    ema200_4h: calcEMA(c4h.map(b => b.close), EMA_SLOW),
    ema200_1h: calcEMA(c1h.map(b => b.close), 200),
    atr14_4h: calcATR(c4h, 14),
    adx14_4h: adxObj.adx,
  };

  console.log("[bt-a20-21-22] Running variants...");
  const results: any[] = [];
  for (const cfg of VARIANTS) {
    const r = run(c5, c1h, c4h, c1d, ind, cfg, startIdx, c5.length);
    results.push({ scenario: cfg.name, ...r });
    console.log(`${cfg.name.padEnd(22)} | RA ${r.ra} | ROI ${r.roi}% | DD ${r.maxDD}% | Entries ${r.entries} | WR ${r.wr}% | R:R ${r.rr} | Stab ${r.stab} | MaxCL ${r.maxConsecLosses}`);
  }

  console.log("\n=== SUMMARY (sorted by RA) ===");
  results.sort((a, b) => b.ra - a.ra);
  console.log("Scenario             | RA   | ROI%  | DD%  | Entries | WR%   | R:R  | Stab | MaxCL");
  console.log("-".repeat(100));
  for (const r of results) {
    console.log(`${r.scenario.padEnd(20)} | ${String(r.ra).padStart(4)} | ${String(r.roi).padStart(5)} | ${String(r.maxDD).padStart(4)} | ${String(r.entries).padStart(7)} | ${String(r.wr).padStart(5)} | ${String(r.rr).padStart(4)} | ${r.stab.padStart(4)} | ${String(r.maxConsecLosses).padStart(5)}`);
  }

  console.log("\n=== PER-DIR + PER-SETUP ===");
  for (const r of results) {
    console.log(`\n${r.scenario}:`);
    for (const [s, d] of Object.entries(r.byDir)) {
      const dd = d as any;
      const wr2 = dd.entries > 0 ? dd.wins / dd.entries * 100 : 0;
      console.log(`  ${s.padEnd(6)} | n=${String(dd.entries).padStart(4)} | WR ${wr2.toFixed(1).padStart(5)}% | PnL $${(dd.pnl >= 0 ? '+' : '') + dd.pnl.toFixed(0)}`);
    }
    for (const [k, d] of Object.entries(r.bySetup).sort()) {
      const dd = d as any;
      const wr2 = dd.entries > 0 ? dd.wins / dd.entries * 100 : 0;
      console.log(`  ${k.padEnd(6)} | n=${String(dd.entries).padStart(4)} | WR ${wr2.toFixed(1).padStart(5)}% | PnL $${(dd.pnl >= 0 ? '+' : '') + dd.pnl.toFixed(0)}`);
    }
  }

  console.log("\n=== PER-YEAR ===");
  for (const r of results) {
    const years = Object.entries(r.byYear).sort().map(([y, d]: any) => `${y}=${d.pnl >= 0 ? '+' : ''}${d.pnl.toFixed(0)}`).join(' ');
    console.log(`${r.scenario.padEnd(22)} | ${years}`);
  }

  writeFileSync(join(__dirname, "..", "assets", "backtest_a20_a21_a22_3y.json"), JSON.stringify(results, null, 2));
  console.log("\nWritten assets/backtest_a20_a21_a22_3y.json");
}

main();
