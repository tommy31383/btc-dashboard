/**
 * backtest-hedge01-v042-3y.ts — Full backtest hedge01 v0.4.42 (A19 BC combo)
 *   Period: 2023-05-25 → 2026-05-25 (3y exactly)
 *   Active setups: #12 EMA cross + #13 ATR breakout + #14 Donchian (trend-only)
 *   Filters: ADX(14) 4h > 20 + sticky 2 bars + EMA200 1h gate + 4h ATR%ile > 30th rolling 90
 *   Position: hedge mode (LONG + SHORT independent), trailing ATR×3 SL
 *   Capital: $100k mô phỏng, fee 0.05% per side
 *
 * Output: full stats per year/month/direction/setup + equity curve
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

// v0.4.42 A19 filters
const ADX_THRESHOLD = 20;
const ADX_PERIOD = 14;
const ADX_STICKY = true;
const EMA200_1H_GATE = true;
const ATR_PCT_GATE = true;
const ATR_PCT_LOOKBACK = 90;
const ATR_PCT_PERCENTILE = 0.30;

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

interface TrendTrade {
  id: string; kind: string; side: "LONG" | "SHORT";
  entryPx: number; qty: number; hwm: number; lwm: number; slPx: number; atrEntry: number;
  entryRegime: Regime; entryTs: number; entryFee: number;
}

interface ClosedTrade {
  kind: string; side: "LONG" | "SHORT";
  entryTs: number; exitTs: number; holdMs: number;
  entryPx: number; exitPx: number; qty: number;
  pnl: number; net: number; fee: number;
}

function main() {
  console.log("[bt-v042-3y] Loading data...");
  const c5all = loadCache("binance-5m-7y.json");
  // Slice 3y exactly from 2023-05-25 to 2026-05-25
  const startTs = new Date("2023-05-25T00:00:00Z").getTime();
  const endTs = new Date("2026-05-25T00:00:00Z").getTime();
  // Warm-up: cần 200 bar 4h = 800h = 33 days; lấy thêm 60 days warm-up
  const warmupTs = startTs - 60 * 86_400_000;
  const c5 = c5all.filter(b => b.time >= warmupTs && b.time <= endTs);
  const startIdx = c5.findIndex(b => b.time >= startTs);
  console.log(`  5m all=${c5all.length}, 3y slice=${c5.length}, startIdx=${startIdx} (${new Date(c5[startIdx]?.time).toISOString()})`);
  console.log(`  Period: ${new Date(c5[0].time).toISOString()} → ${new Date(c5[c5.length - 1].time).toISOString()}`);

  const c15m = aggregateBars(c5, 15);
  const c1h = aggregateBars(c5, 60);
  const c4h = aggregateBars(c5, 240);
  const c1d = aggregateBars(c5, 1440);
  console.log(`  15m=${c15m.length}, 1h=${c1h.length}, 4h=${c4h.length}, 1d=${c1d.length}`);

  console.log("[bt-v042-3y] Pre-computing indicators...");
  const adxInd = calcADXFull(c4h, ADX_PERIOD);
  const ind = {
    ma200d: calcSMA(c1d.map(b => b.close), 200), ma50d: calcSMA(c1d.map(b => b.close), 50),
    ema50_4h: calcEMA(c4h.map(b => b.close), EMA_FAST),
    ema200_4h: calcEMA(c4h.map(b => b.close), EMA_SLOW),
    ema200_1h: calcEMA(c1h.map(b => b.close), 200),
    atr14_4h: calcATR(c4h, 14),
  };

  console.log("[bt-v042-3y] Running...");
  let wallet = INITIAL_CAPITAL, hwm = INITIAL_CAPITAL, hwmTs = c5[startIdx].time;
  let lowestWallet = INITIAL_CAPITAL;
  let trendLongNet = { qty: 0, avg: 0 }, trendShortNet = { qty: 0, avg: 0 };
  let trendTrades: TrendTrade[] = [];
  let lastS12L = 0, lastS12S = 0, lastS13L = 0, lastS13S = 0, lastS14L = 0, lastS14S = 0;
  let regime: Regime = "RANGE", regimeConsec = 0, regimeLastRaw: Regime = "RANGE";

  const closedTrades: ClosedTrade[] = [];
  const equityCurve: { ts: number; equity: number }[] = [];
  let totalFees = 0;
  let totalSignalsRaw = 0, totalSignalsBlocked = 0;
  let blockedByAdx = 0, blockedBySticky = 0, blockedByEma = 0, blockedByAtr = 0, blockedByRegime = 0;
  let curConsecLosses = 0, maxConsecLosses = 0;
  let maxDDDurationMs = 0;
  let idx15m = 0, idx1h = 0, idx1d = 0, idx4h = 0;
  let last4hIdx = -1;

  for (let i = startIdx; i < c5.length; i++) {
    const bar = c5[i]; const ts = bar.time; const mark = bar.close;

    // === Trailing SL chase + close check ===
    const newTrend: TrendTrade[] = [];
    for (const t of trendTrades) {
      if (t.side === "LONG") { if (mark > t.hwm) { t.hwm = mark; t.slPx = t.hwm - t.atrEntry * TREND_ATR_SL_MULT; } }
      else { if (mark < t.lwm) { t.lwm = mark; t.slPx = t.lwm + t.atrEntry * TREND_ATR_SL_MULT; } }
      let exit = false;
      if (t.side === "LONG" && mark <= t.slPx) exit = true;
      if (t.side === "SHORT" && mark >= t.slPx) exit = true;
      if (exit) {
        const exitFee = t.qty * mark * FEE_PCT / 100;
        const pnl = (t.side === "LONG" ? mark - t.entryPx : t.entryPx - mark) * t.qty;
        const net = pnl - exitFee;
        wallet += net; totalFees += exitFee;
        if (wallet > hwm) { hwm = wallet; hwmTs = ts; }
        else { const dur = ts - hwmTs; if (dur > maxDDDurationMs) maxDDDurationMs = dur; }
        if (wallet < lowestWallet) lowestWallet = wallet;
        if (pnl > 0) { curConsecLosses = 0; }
        else { curConsecLosses++; if (curConsecLosses > maxConsecLosses) maxConsecLosses = curConsecLosses; }
        closedTrades.push({
          kind: t.kind, side: t.side, entryTs: t.entryTs, exitTs: ts, holdMs: ts - t.entryTs,
          entryPx: t.entryPx, exitPx: mark, qty: t.qty, pnl, net, fee: t.entryFee + exitFee,
        });
        const netRef = t.side === "LONG" ? trendLongNet : trendShortNet;
        const rq = Math.max(0, netRef.qty - t.qty);
        if (t.side === "LONG") trendLongNet = { qty: rq, avg: rq > 0 ? netRef.avg : 0 };
        else trendShortNet = { qty: rq, avg: rq > 0 ? netRef.avg : 0 };
      } else newTrend.push(t);
    }
    trendTrades = newTrend;

    if (i < startIdx + 60) continue;
    idx1h = findIdx(c1h, ts, idx1h); idx4h = findIdx(c4h, ts, idx4h); idx1d = findIdx(c1d, ts, idx1d);
    idx15m = findIdx(c15m, ts, idx15m);
    const idx4hc = idx4h - 1; const idx1hc = idx1h - 1; const idx1dc = idx1d - 1;
    if (idx4hc < EMA_SLOW + 1 || idx4hc === last4hIdx) continue;
    last4hIdx = idx4hc;

    // === Regime detection (1d MA200/MA50 + 20d range vol) ===
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

    // === v0.4.42 A19 filters ===
    const adxVal = adxInd.adx[idx4hc];
    const adxPrev = adxInd.adx[idx4hc - 1];
    const adxPassRaw = adxVal !== null && adxVal > ADX_THRESHOLD;
    const adxPass = ADX_STICKY ? (adxPassRaw && adxPrev !== null && adxPrev > ADX_THRESHOLD) : adxPassRaw;

    // EMA200 1h
    let emaLong = true, emaShort = true;
    if (EMA200_1H_GATE && idx1hc >= 200) {
      const ema200_1h = ind.ema200_1h[idx1hc];
      if (ema200_1h === null) { emaLong = false; emaShort = false; }
      else {
        if (c1h[idx1hc].close < ema200_1h) emaLong = false;
        if (c1h[idx1hc].close > ema200_1h) emaShort = false;
      }
    }

    // ATR percentile gate
    let atrGatePass = true;
    if (ATR_PCT_GATE && idx4hc >= 90) {
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
        const pX = arr[Math.floor(arr.length * ATR_PCT_PERCENTILE)];
        atrGatePass = curPct >= pX;
      }
    }

    let filterLong = allowLong, filterShort = allowShort;
    if (!adxPass) { filterLong = false; filterShort = false; if (!adxPassRaw) blockedByAdx++; else blockedBySticky++; }
    if (!emaLong) { filterLong = false; blockedByEma++; }
    if (!emaShort) { filterShort = false; blockedByEma++; }
    if (!atrGatePass) { filterLong = false; filterShort = false; blockedByAtr++; }
    if (!allowLong) blockedByRegime++;
    if (!allowShort) blockedByRegime++;

    // === Trend setups detection ===
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
      totalSignalsRaw++;
      if (side === "LONG" && !filterLong) { totalSignalsBlocked++; return; }
      if (side === "SHORT" && !filterShort) { totalSignalsBlocked++; return; }
      const qty = baseQty;
      const cur = side === "LONG" ? trendLongNet.qty : trendShortNet.qty;
      if (cur + qty > TREND_MAX_QTY_PER_SIDE) { totalSignalsBlocked++; return; }
      const slPx = side === "LONG" ? mark - atrVal4h * TREND_ATR_SL_MULT : mark + atrVal4h * TREND_ATR_SL_MULT;
      const entryFee = qty * mark * FEE_PCT / 100;
      wallet -= entryFee; totalFees += entryFee;
      const net = side === "LONG" ? trendLongNet : trendShortNet;
      const nq = net.qty + qty;
      const newNet = { qty: nq, avg: (net.qty * net.avg + qty * mark) / nq };
      if (side === "LONG") trendLongNet = newNet; else trendShortNet = newNet;
      trendTrades.push({ id: `${kind}_${side}_${ts}`, kind, side, entryPx: mark, qty, hwm: mark, lwm: mark, slPx, atrEntry: atrVal4h, entryRegime: regime, entryTs: ts, entryFee });
      lastTsRef.v = ts;
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

    // sample equity curve weekly
    if (equityCurve.length === 0 || ts - equityCurve[equityCurve.length - 1].ts >= 7 * 86_400_000) {
      const mtm = wallet + trendTrades.reduce((s, t) => s + (t.side === "LONG" ? mark - t.entryPx : t.entryPx - mark) * t.qty, 0);
      equityCurve.push({ ts, equity: +mtm.toFixed(0) });
    }
  }

  // === Aggregate stats ===
  const totalEntries = closedTrades.length + trendTrades.length;
  const totalCloses = closedTrades.length;
  const wins = closedTrades.filter(t => t.pnl > 0).length;
  const losses = closedTrades.filter(t => t.pnl <= 0).length;
  const wr = totalCloses > 0 ? wins / totalCloses * 100 : 0;
  const sumWin = closedTrades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const sumLoss = closedTrades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0);
  const avgWin = wins > 0 ? sumWin / wins : 0;
  const avgLoss = losses > 0 ? sumLoss / losses : 0;
  const rr = avgLoss < 0 ? avgWin / -avgLoss : 0;
  const expectancy = totalCloses > 0 ? closedTrades.reduce((s, t) => s + t.net, 0) / totalCloses : 0;
  const roi = (wallet - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100;
  const maxDD = (hwm - lowestWallet) / hwm * 100;
  const ra = maxDD > 0 ? roi / maxDD : (roi > 0 ? 999 : 0);
  const avgHoldHours = totalCloses > 0 ? closedTrades.reduce((s, t) => s + t.holdMs, 0) / totalCloses / 3_600_000 : 0;

  // Per-year
  const byYear: Record<string, { entries: number; closes: number; wins: number; pnl: number }> = {};
  for (const t of closedTrades) {
    const y = new Date(t.entryTs).toISOString().slice(0, 4);
    byYear[y] = byYear[y] ?? { entries: 0, closes: 0, wins: 0, pnl: 0 };
    byYear[y].entries++; byYear[y].closes++;
    if (t.pnl > 0) byYear[y].wins++;
    byYear[y].pnl += t.net;
  }

  // Per-month
  const byMonth: Record<string, { closes: number; wins: number; pnl: number }> = {};
  for (const t of closedTrades) {
    const m = new Date(t.entryTs).toISOString().slice(0, 7);
    byMonth[m] = byMonth[m] ?? { closes: 0, wins: 0, pnl: 0 };
    byMonth[m].closes++;
    if (t.pnl > 0) byMonth[m].wins++;
    byMonth[m].pnl += t.net;
  }

  // Per-direction
  const byDir: Record<string, { entries: number; wins: number; pnl: number; avgHoldH: number }> = {
    LONG: { entries: 0, wins: 0, pnl: 0, avgHoldH: 0 },
    SHORT: { entries: 0, wins: 0, pnl: 0, avgHoldH: 0 },
  };
  for (const t of closedTrades) {
    byDir[t.side].entries++;
    if (t.pnl > 0) byDir[t.side].wins++;
    byDir[t.side].pnl += t.net;
    byDir[t.side].avgHoldH += t.holdMs / 3_600_000;
  }
  byDir.LONG.avgHoldH = byDir.LONG.entries > 0 ? byDir.LONG.avgHoldH / byDir.LONG.entries : 0;
  byDir.SHORT.avgHoldH = byDir.SHORT.entries > 0 ? byDir.SHORT.avgHoldH / byDir.SHORT.entries : 0;

  // Per-setup
  const bySetup: Record<string, { entries: number; wins: number; pnl: number; avgHoldH: number }> = {};
  for (const t of closedTrades) {
    bySetup[t.kind] = bySetup[t.kind] ?? { entries: 0, wins: 0, pnl: 0, avgHoldH: 0 };
    bySetup[t.kind].entries++;
    if (t.pnl > 0) bySetup[t.kind].wins++;
    bySetup[t.kind].pnl += t.net;
    bySetup[t.kind].avgHoldH += t.holdMs / 3_600_000;
  }
  for (const k of Object.keys(bySetup)) {
    bySetup[k].avgHoldH = bySetup[k].entries > 0 ? bySetup[k].avgHoldH / bySetup[k].entries : 0;
  }

  // === Console output ===
  console.log("\n" + "=".repeat(80));
  console.log(`HEDGE01 v0.4.42 BACKTEST 3y (${new Date(c5[startIdx].time).toISOString().slice(0, 10)} → ${new Date(c5[c5.length - 1].time).toISOString().slice(0, 10)})`);
  console.log("=".repeat(80));
  console.log(`\nConfig: TREND-ONLY (Setup #12/#13/#14) with A19 filters:`);
  console.log(`  ADX(14) 4h > ${ADX_THRESHOLD} + sticky 2 bars`);
  console.log(`  EMA200 1h gate (price aligned)`);
  console.log(`  4h ATR% > ${ATR_PCT_PERCENTILE * 100}th percentile rolling ${ATR_PCT_LOOKBACK} bars`);
  console.log(`  Hedge mode: LONG + SHORT independent buckets`);
  console.log(`  Trailing SL: ATR×${TREND_ATR_SL_MULT} chase HWM/LWM`);
  console.log(`  Capital: $${INITIAL_CAPITAL.toLocaleString()}, fee ${FEE_PCT}% per side`);

  console.log(`\n📊 OVERALL`);
  console.log(`  Wallet final:    $${wallet.toFixed(0)} (HWM $${hwm.toFixed(0)}, low $${lowestWallet.toFixed(0)})`);
  console.log(`  ROI 3y:          ${roi.toFixed(2)}%`);
  console.log(`  Max DD:          ${maxDD.toFixed(2)}%`);
  console.log(`  RA (ROI/DD):     ${ra.toFixed(2)}`);
  console.log(`  Max DD duration: ${(maxDDDurationMs / 86_400_000).toFixed(1)} days`);
  console.log(`  Total fees:      $${totalFees.toFixed(0)}`);

  console.log(`\n🎯 ENTRIES & SIGNALS`);
  console.log(`  Total entries (fired):      ${totalEntries}`);
  console.log(`  Total closes:               ${totalCloses}`);
  console.log(`  Still open at end:          ${trendTrades.length}`);
  console.log(`  Avg entries/year:           ${(totalEntries / 3).toFixed(1)}`);
  console.log(`  Avg entries/month:          ${(totalEntries / 36).toFixed(1)}`);
  console.log(`  Raw signals:                ${totalSignalsRaw}`);
  console.log(`  Signals blocked:            ${totalSignalsBlocked} (${(totalSignalsBlocked / totalSignalsRaw * 100).toFixed(1)}%)`);
  console.log(`  Pass rate:                  ${(totalEntries / totalSignalsRaw * 100).toFixed(1)}%`);
  console.log(`  Blocked breakdown (signals can fail multiple):`);
  console.log(`    by ADX threshold:         ${blockedByAdx}`);
  console.log(`    by sticky:                ${blockedBySticky}`);
  console.log(`    by EMA200 1h:             ${blockedByEma}`);
  console.log(`    by ATR percentile:        ${blockedByAtr}`);
  console.log(`    by regime:                ${blockedByRegime}`);

  console.log(`\n💰 TRADE STATS`);
  console.log(`  Win rate:                   ${wr.toFixed(1)}% (${wins}W / ${losses}L)`);
  console.log(`  Avg win:                    $${avgWin.toFixed(2)}`);
  console.log(`  Avg loss:                   $${avgLoss.toFixed(2)}`);
  console.log(`  R:R (avgW / |avgL|):        ${rr.toFixed(2)}`);
  console.log(`  Expectancy per trade:       $${expectancy.toFixed(2)}`);
  console.log(`  Avg hold time:              ${avgHoldHours.toFixed(1)} hours (${(avgHoldHours / 24).toFixed(1)} days)`);
  console.log(`  Max consecutive losses:     ${maxConsecLosses}`);

  console.log(`\n📅 PER-YEAR`);
  console.log(`  Year | Entries | Closes | Wins | WR%   | PnL ($)`);
  console.log(`  -----|---------|--------|------|-------|--------`);
  for (const [y, d] of Object.entries(byYear).sort()) {
    const wr2 = d.closes > 0 ? d.wins / d.closes * 100 : 0;
    console.log(`  ${y} | ${String(d.entries).padStart(7)} | ${String(d.closes).padStart(6)} | ${String(d.wins).padStart(4)} | ${wr2.toFixed(1).padStart(5)} | ${(d.pnl >= 0 ? '+' : '') + d.pnl.toFixed(0).padStart(6)}`);
  }
  const stab = Object.values(byYear).filter(d => d.pnl > 0).length;
  console.log(`  Stability: ${stab}/${Object.keys(byYear).length} years positive`);

  console.log(`\n📈 PER-DIRECTION`);
  for (const [s, d] of Object.entries(byDir)) {
    const wr2 = d.entries > 0 ? d.wins / d.entries * 100 : 0;
    console.log(`  ${s.padEnd(6)} | Entries ${String(d.entries).padStart(4)} | Wins ${String(d.wins).padStart(3)} | WR ${wr2.toFixed(1).padStart(5)}% | PnL ${(d.pnl >= 0 ? '+' : '') + '$' + d.pnl.toFixed(0)} | Avg hold ${d.avgHoldH.toFixed(1)}h`);
  }

  console.log(`\n🎲 PER-SETUP`);
  for (const [k, d] of Object.entries(bySetup).sort()) {
    const wr2 = d.entries > 0 ? d.wins / d.entries * 100 : 0;
    const setupName = k === "S12" ? "EMA 50/200 cross" : k === "S13" ? "ATR breakout" : "Donchian 20-bar";
    console.log(`  ${k} ${setupName.padEnd(18)} | Entries ${String(d.entries).padStart(4)} | Wins ${String(d.wins).padStart(3)} | WR ${wr2.toFixed(1).padStart(5)}% | PnL ${(d.pnl >= 0 ? '+' : '') + '$' + d.pnl.toFixed(0).padStart(6)} | Avg hold ${d.avgHoldH.toFixed(1)}h`);
  }

  console.log(`\n📊 PER-MONTH (last 12 months)`);
  console.log(`  Month   | Closes | Wins | PnL`);
  const monthsArr = Object.entries(byMonth).sort();
  const last12 = monthsArr.slice(-12);
  for (const [m, d] of last12) {
    const wr2 = d.closes > 0 ? d.wins / d.closes * 100 : 0;
    console.log(`  ${m} | ${String(d.closes).padStart(6)} | ${String(d.wins).padStart(4)} (${wr2.toFixed(0)}%) | ${(d.pnl >= 0 ? '+' : '') + '$' + d.pnl.toFixed(0)}`);
  }

  // Write JSON
  const out = {
    config: { version: "v0.4.42 A19", periodStart: new Date(c5[startIdx].time).toISOString(), periodEnd: new Date(c5[c5.length - 1].time).toISOString(),
              adxThreshold: ADX_THRESHOLD, adxSticky: ADX_STICKY, emaGate: EMA200_1H_GATE, atrPctile: ATR_PCT_PERCENTILE,
              initialCapital: INITIAL_CAPITAL, feePct: FEE_PCT },
    overall: { walletFinal: +wallet.toFixed(0), hwm: +hwm.toFixed(0), lowestWallet: +lowestWallet.toFixed(0),
               roi: +roi.toFixed(2), maxDD: +maxDD.toFixed(2), ra: +ra.toFixed(2),
               ddDurationDays: +(maxDDDurationMs / 86_400_000).toFixed(1), totalFees: +totalFees.toFixed(0) },
    signals: { totalEntries, totalCloses, stillOpen: trendTrades.length, totalSignalsRaw, totalSignalsBlocked,
               blockedByAdx, blockedBySticky, blockedByEma, blockedByAtr, blockedByRegime },
    stats: { wr: +wr.toFixed(2), wins, losses, avgWin: +avgWin.toFixed(2), avgLoss: +avgLoss.toFixed(2),
             rr: +rr.toFixed(2), expectancy: +expectancy.toFixed(2), avgHoldHours: +avgHoldHours.toFixed(1),
             maxConsecLosses },
    byYear, byMonth, byDir, bySetup,
    equityCurve,
    trades: closedTrades.map(t => ({ ...t, entryTs: new Date(t.entryTs).toISOString(), exitTs: new Date(t.exitTs).toISOString(), pnl: +t.pnl.toFixed(2), net: +t.net.toFixed(2), fee: +t.fee.toFixed(2) })),
  };
  writeFileSync(join(__dirname, "..", "assets", "backtest_hedge01_v042_3y.json"), JSON.stringify(out, null, 2));
  console.log(`\nWritten assets/backtest_hedge01_v042_3y.json (${closedTrades.length} closed trades)`);
}

main();
