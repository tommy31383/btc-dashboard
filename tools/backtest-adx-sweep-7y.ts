/**
 * backtest-adx-sweep-7y.ts — Tune ADX threshold + combine ADX+VWAP+7TF (no hour fail).
 *
 * Variants:
 *   V0: baseline (no filter)
 *   V_ADX20/22/25/28/30/35: ADX threshold sweep
 *   V_VWAP_only: VWAP filter alone
 *   V_ADX25+VWAP: ADX25 + VWAP combined
 *   V_ADX25+VWAP+7TF: triple combo
 *   V_ADX20+VWAP: lower ADX threshold
 *   V_ADX25_LongOnly: ADX only for LONG side
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
function calcADX(c: Candle[], p: number = 14): (number | null)[] {
  const o: (number | null)[] = new Array(c.length).fill(null);
  if (c.length <= p + 1) return o;
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
    const dx = (plusDI + minusDI) > 0 ? Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100 : 0;
    dxArr.push(dx);
    if (dxArr.length >= p) {
      let adx = 0;
      for (let j = dxArr.length - p; j < dxArr.length; j++) adx += dxArr[j];
      o[i] = adx / p;
    }
  }
  return o;
}
function findIdx(arr: { time: number }[], ts: number, hint: number = 0): number {
  let lo = hint, hi = arr.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (arr[mid].time <= ts) lo = mid; else hi = mid - 1; }
  return lo;
}

interface VariantCfg {
  name: string;
  adxThreshold: number | null;  // null = no filter
  useVwap: boolean;
  use7tf: boolean;
  adxLongOnly: boolean;
}

const VARIANTS: VariantCfg[] = [
  { name: "V0_baseline",          adxThreshold: null, useVwap: false, use7tf: false, adxLongOnly: false },
  { name: "V_ADX_20",             adxThreshold: 20,   useVwap: false, use7tf: false, adxLongOnly: false },
  { name: "V_ADX_22",             adxThreshold: 22,   useVwap: false, use7tf: false, adxLongOnly: false },
  { name: "V_ADX_25",             adxThreshold: 25,   useVwap: false, use7tf: false, adxLongOnly: false },
  { name: "V_ADX_28",             adxThreshold: 28,   useVwap: false, use7tf: false, adxLongOnly: false },
  { name: "V_ADX_30",             adxThreshold: 30,   useVwap: false, use7tf: false, adxLongOnly: false },
  { name: "V_ADX_35",             adxThreshold: 35,   useVwap: false, use7tf: false, adxLongOnly: false },
  { name: "V_VWAP_only",          adxThreshold: null, useVwap: true,  use7tf: false, adxLongOnly: false },
  { name: "V_ADX25+VWAP",         adxThreshold: 25,   useVwap: true,  use7tf: false, adxLongOnly: false },
  { name: "V_ADX20+VWAP",         adxThreshold: 20,   useVwap: true,  use7tf: false, adxLongOnly: false },
  { name: "V_ADX25+VWAP+7TF",     adxThreshold: 25,   useVwap: true,  use7tf: true,  adxLongOnly: false },
  { name: "V_ADX25_LongOnly",     adxThreshold: 25,   useVwap: false, use7tf: false, adxLongOnly: true },
  { name: "V_ADX25_LongOnly+VWAP",adxThreshold: 25,   useVwap: true,  use7tf: false, adxLongOnly: true },
];

interface TrendTrade { id: string; kind: string; side: "LONG" | "SHORT"; entryPx: number; qty: number; hwm: number; lwm: number; slPx: number; atrEntry: number; }

function runBacktest(c5: Candle[], c15m: Candle[], c1h: Candle[], c4h: Candle[], c1d: Candle[], c1w: Candle[], ind: any, cfg: VariantCfg, startIdx: number, endIdx: number, name: string): any {
  let wallet = INITIAL_CAPITAL, hwm = INITIAL_CAPITAL;
  let trendLongNet = { qty: 0, avg: 0 }, trendShortNet = { qty: 0, avg: 0 };
  let trendTrades: TrendTrade[] = [];
  let lastS12L = 0, lastS12S = 0, lastS13L = 0, lastS13S = 0, lastS14L = 0, lastS14S = 0;
  let regime: Regime = "RANGE", regimeConsec = 0, regimeLastRaw: Regime = "RANGE";
  let entries = 0, closes = 0, wins = 0, losses = 0, sumWin = 0, sumLoss = 0;
  let lowestWallet = INITIAL_CAPITAL, totalFees = 0;
  const setupCounts: Record<string, number> = {};
  const byYear: Record<string, { entries: number; closes: number; pnl: number }> = {};
  let idx15m = 0, idx1h = 0, idx1d = 0, idx1w = 0, idx4h = 0;
  let last4hIdx = -1;

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

    if (i < startIdx + 60) continue;
    idx1h = findIdx(c1h, ts, idx1h); idx4h = findIdx(c4h, ts, idx4h); idx1d = findIdx(c1d, ts, idx1d);
    idx15m = findIdx(c15m, ts, idx15m); idx1w = findIdx(c1w, ts, idx1w);
    const idx4hc = idx4h - 1; const idx1hc = idx1h - 1; const idx1dc = idx1d - 1;
    const idx15mc = idx15m - 1; const idx1wc = idx1w - 1;
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

    // ADX filter
    const adxVal = ind.adx14_4h[idx4hc];
    const adxPass = cfg.adxThreshold === null ? true : (adxVal !== null && adxVal > cfg.adxThreshold);

    // VWAP filter
    let vwapLong = true, vwapShort = true;
    if (cfg.useVwap && ind.vwap30d[idx1dc] !== null) {
      const vwap = ind.vwap30d[idx1dc];
      if (mark > vwap) vwapShort = false;
      else if (mark < vwap) vwapLong = false;
    }

    // 7TF (6 TFs available — skip 1m)
    let tfL = 0, tfS = 0;
    if (cfg.use7tf) {
      const tfChecks: Array<[Candle[], (number | null)[], number]> = [
        [c5, ind.ema20_5m, i - 1],
        [c15m, ind.ema20_15m, idx15mc],
        [c1h, ind.ema20_1h, idx1hc],
        [c4h, ind.ema20_4h, idx4hc],
        [c1d, ind.ema20_1d, idx1dc],
        [c1w, ind.ema20_1w, idx1wc],
      ];
      for (const [bars, emaArr, idx] of tfChecks) {
        if (idx < 0 || idx >= bars.length) continue;
        const ema = emaArr[idx];
        if (ema === null) continue;
        if (bars[idx].close > ema) tfL++;
        else if (bars[idx].close < ema) tfS++;
      }
    }

    // Compute final filter:
    let filterLong = allowLong;
    let filterShort = allowShort;
    if (cfg.adxThreshold !== null && !adxPass) {
      if (cfg.adxLongOnly) filterLong = false;
      else { filterLong = false; filterShort = false; }
    }
    if (cfg.useVwap) { if (!vwapLong) filterLong = false; if (!vwapShort) filterShort = false; }
    if (cfg.use7tf) { if (tfL < 4) filterLong = false; if (tfS < 4) filterShort = false; }

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

  const roi = (wallet - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100;
  const maxDD = (hwm - lowestWallet) / hwm * 100;
  const wr = closes > 0 ? wins / closes * 100 : 0;
  const avgWin = wins > 0 ? sumWin / wins : 0;
  const avgLoss = losses > 0 ? sumLoss / losses : 0;
  const ra = maxDD > 0 ? roi / maxDD : (roi > 0 ? 999 : 0);
  return { name, roi: +roi.toFixed(2), maxDD: +maxDD.toFixed(2), ra: +ra.toFixed(2),
           entries, closes, wr: +wr.toFixed(2),
           rr: avgLoss < 0 ? +(avgWin / -avgLoss).toFixed(2) : 0,
           byYear: Object.fromEntries(Object.entries(byYear).map(([k, v]) => [k, { ...v, pnl: Math.round(v.pnl) }])) };
}

function main() {
  console.log("[adx-sweep-7y] Loading...");
  const c5 = loadCache("binance-5m-7y.json");
  const c15m = aggregateBars(c5, 15);
  const c1h = aggregateBars(c5, 60);
  const c4h = aggregateBars(c5, 240);
  const c1d = aggregateBars(c5, 1440);
  const c1w = aggregateBars(c5, 10080);
  console.log(`  5m=${c5.length}, 15m=${c15m.length}, 1h=${c1h.length}, 4h=${c4h.length}, 1d=${c1d.length}, 1w=${c1w.length}`);

  console.log("[adx-sweep-7y] Pre-computing indicators...");
  const ind = {
    ma200d: calcSMA(c1d.map(b => b.close), 200), ma50d: calcSMA(c1d.map(b => b.close), 50),
    ema50_4h: calcEMA(c4h.map(b => b.close), EMA_FAST),
    ema200_4h: calcEMA(c4h.map(b => b.close), EMA_SLOW),
    atr14_4h: calcATR(c4h, 14),
    adx14_4h: calcADX(c4h, 14),
    ema20_5m: calcEMA(c5.map(b => b.close), 20),
    ema20_15m: calcEMA(c15m.map(b => b.close), 20),
    ema20_1h: calcEMA(c1h.map(b => b.close), 20),
    ema20_4h: calcEMA(c4h.map(b => b.close), 20),
    ema20_1d: calcEMA(c1d.map(b => b.close), 20),
    ema20_1w: calcEMA(c1w.map(b => b.close), 20),
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

  const results: any[] = [];
  for (const cfg of VARIANTS) {
    const rFull = runBacktest(c5, c15m, c1h, c4h, c1d, c1w, ind, cfg, 0, c5.length, cfg.name);
    const rTrain = runBacktest(c5, c15m, c1h, c4h, c1d, c1w, ind, cfg, 0, splitIdx, `${cfg.name}_train`);
    const rTest = runBacktest(c5, c15m, c1h, c4h, c1d, c1w, ind, cfg, splitIdx, c5.length, `${cfg.name}_test`);
    const stab = Object.values(rFull.byYear).filter((v: any) => v.pnl > 0).length;
    const total = Object.keys(rFull.byYear).length;
    results.push({ scenario: cfg.name, full: rFull, train: rTrain, test: rTest, stab: `${stab}/${total}` });
    console.log(`${cfg.name.padEnd(28)}: Full RA ${rFull.ra} | Train RA ${rTrain.ra} | Test RA ${rTest.ra} | Stab ${stab}/${total} | Entries ${rFull.entries}`);
  }

  // Sort by composite score: avg(train_ra, test_ra) + bonus for stability
  results.sort((a, b) => {
    const aScore = (a.train.ra + a.test.ra) / 2 + (parseInt(a.stab.split("/")[0]) / parseInt(a.stab.split("/")[1])) * 0.1;
    const bScore = (b.train.ra + b.test.ra) / 2 + (parseInt(b.stab.split("/")[0]) / parseInt(b.stab.split("/")[1])) * 0.1;
    return bScore - aScore;
  });

  console.log("\n=== ADX SWEEP COMPARISON 7y (sorted by composite train+test+stab) ===");
  console.log("Scenario                       | Full RA | Train RA | Test RA | Stab | Entries");
  console.log("-".repeat(100));
  for (const r of results) {
    console.log(`${r.scenario.padEnd(30)} | ${String(r.full.ra).padStart(7)} | ${String(r.train.ra).padStart(8)} | ${String(r.test.ra).padStart(7)} | ${r.stab.padStart(4)} | ${String(r.full.entries).padStart(7)}`);
  }

  writeFileSync(join(__dirname, "..", "assets", "backtest_adx_sweep_7y.json"), JSON.stringify(results, null, 2));
  console.log(`\nWritten assets/backtest_adx_sweep_7y.json`);
}

main();
