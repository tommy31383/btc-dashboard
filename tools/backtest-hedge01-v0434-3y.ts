/**
 * backtest-hedge01-v0434-3y.ts — backtest hedge01 v0.4.34 với 14 setups combined.
 *
 * Diff vs v0432 backtest:
 *   + Setup #12 EMA 50/200 cross 4h (qty 0.005, CD 12h)
 *   + Setup #13 ATR breakout 4h (qty 0.003, CD 4h)
 *   + Setup #14 Donchian 20 4h (qty 0.005, CD 12h)
 *   + Aggregate SL -8% (đã thay -12 trong v0.4.33)
 *
 * Compare với baseline v0.4.32 (mean-rev only) để xem trend-follow setups bổ sung edge thế nào.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const INITIAL_CAPITAL = 100_000;
const FEE_PCT = 0.05;
const COOLDOWN_MS = 60 * 60_000;
const TP_PCT = 10;
const AGGREGATE_SL_PCT = 8;
const C2_QTY = 0.007;
const DEEPDIP_QTY_BOOST = 0.05;
const SETUP11_QTY = 0.001;
const SETUP11_TP_PCT = 7;
const SETUP11_SL_PCT = 3.5;
const SETUP11_COOLDOWN_MS = 15 * 60_000;
const SETUP12_QTY = 0.005;
const SETUP13_QTY = 0.003;
const SETUP14_QTY = 0.005;
const SETUP12_COOLDOWN_MS = 12 * 60 * 60_000;
const SETUP13_COOLDOWN_MS = 4 * 60 * 60_000;
const SETUP14_COOLDOWN_MS = 12 * 60 * 60_000;
const MIN_BINANCE_QTY = 0.001;
const MAX_QTY = 0.02;
const ATR_BASELINE_PCT = 0.4;
const ATR_SCALE_MIN = 0.4;
const ATR_SCALE_MAX = 1.5;
const REGIME_PERSIST_BARS = 3;
const EMA_FAST = 50;
const EMA_SLOW = 200;
const ATR_BREAKOUT_MULT = 1.5;
const DONCHIAN_LOOKBACK = 20;

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }
interface Net { qty: number; avg: number; }
type Regime = "BULL" | "RANGE" | "BEAR";
interface S11Trade { id: string; entryPx: number; qty: number; tpPx: number; slPx: number; }

function loadCache(tf: string): Candle[] {
  return JSON.parse(readFileSync(join(__dirname, "..", ".cache", `binance-${tf}-3y.json`), "utf8"));
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
function calcStdev(a: number[], p: number, sma: (number | null)[]): (number | null)[] {
  const o: (number | null)[] = new Array(a.length).fill(null);
  for (let i = p - 1; i < a.length; i++) {
    const m = sma[i]; if (m === null) continue;
    let sq = 0; for (let j = i - p + 1; j <= i; j++) sq += (a[j] - m) ** 2; o[i] = Math.sqrt(sq / p);
  } return o;
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
function calcStochK(c: Candle[], p: number): (number | null)[] {
  const o: (number | null)[] = new Array(c.length).fill(null);
  for (let i = p - 1; i < c.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - p + 1; j <= i; j++) { if (c[j].high > hi) hi = c[j].high; if (c[j].low < lo) lo = c[j].low; }
    o[i] = hi === lo ? 50 : ((c[i].close - lo) / (hi - lo)) * 100;
  } return o;
}
function calcATR(c: Candle[], p: number): (number | null)[] {
  const o: (number | null)[] = new Array(c.length).fill(null); if (c.length <= p) return o;
  const tr: number[] = new Array(c.length).fill(0);
  for (let i = 1; i < c.length; i++) tr[i] = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
  let s = 0; for (let i = 1; i <= p; i++) s += tr[i]; o[p] = s / p;
  for (let i = p + 1; i < c.length; i++) o[i] = (o[i - 1]! * (p - 1) + tr[i]) / p; return o;
}
function calcMACDHist(c: number[]): (number | null)[] {
  const e12 = calcEMA(c, 12), e26 = calcEMA(c, 26);
  const macd: (number | null)[] = c.map((_, i) => (e12[i] != null && e26[i] != null) ? e12[i]! - e26[i]! : null);
  const v: number[] = [], m: number[] = [];
  for (let i = 0; i < macd.length; i++) if (macd[i] !== null) { v.push(macd[i]!); m.push(i); }
  const sigEma = calcEMA(v, 9);
  const signal: (number | null)[] = new Array(c.length).fill(null);
  for (let k = 0; k < sigEma.length; k++) if (sigEma[k] !== null) signal[m[k]] = sigEma[k];
  return c.map((_, i) => (macd[i] != null && signal[i] != null) ? macd[i]! - signal[i]! : null);
}
function aggregateQty(score: number, side: "LONG" | "SHORT"): number {
  let qty = 0;
  if (score === 11) qty += 0.001 * 3; if (score === 11) qty += 0.01;
  if (score >= 10) qty += 0.001; if (score >= 9) qty += 0.001;
  if (score >= 10) qty += 0.01;
  if (score === 11 && side === "LONG") qty += 0.001;
  return qty;
}
function findIdx(arr: Candle[], ts: number, hint: number = 0): number {
  let lo = hint, hi = arr.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (arr[mid].time <= ts) lo = mid; else hi = mid - 1; }
  return lo;
}

function main() {
  console.log("[v0434-3y] Loading...");
  const c5 = loadCache("5m");
  const c15 = loadCache("15m");
  const c1h = loadCache("1h");
  const c4h = loadCache("4h");
  const c1d = loadCache("1d");
  const c1w = loadCache("1w");

  console.log("[v0434-3y] Pre-computing indicators...");
  const close15 = c15.map(b => b.close);
  const vol15 = c15.map(b => b.volume ?? 0);
  const ma20_15 = calcSMA(close15, 20);
  const ind = {
    rsi15: calcRSI(close15, 14),
    stoch15: calcStochK(c15, 14),
    macdH15: calcMACDHist(close15),
    ma50_15: calcSMA(close15, 50),
    ma20_15,
    sd20_15: calcStdev(close15, 20, ma20_15),
    atr14_15: calcATR(c15, 14),
    volMA_15: calcSMA(vol15, 20),
    rsi5: calcRSI(c5.map(b => b.close), 14),
    ma200_5m: calcSMA(c5.map(b => b.close), 200),
    ma50_5m: calcSMA(c5.map(b => b.close), 50),
    rsi1h: calcRSI(c1h.map(b => b.close), 14),
    ma200d: calcSMA(c1d.map(b => b.close), 200),
    ma50d: calcSMA(c1d.map(b => b.close), 50),
    // 4h trend setups
    ema50_4h: calcEMA(c4h.map(b => b.close), EMA_FAST),
    ema200_4h: calcEMA(c4h.map(b => b.close), EMA_SLOW),
    atr14_4h: calcATR(c4h, 14),
  };

  let wallet = INITIAL_CAPITAL, hwm = INITIAL_CAPITAL;
  let longNet: Net = { qty: 0, avg: 0 }, shortNet: Net = { qty: 0, avg: 0 };
  let lastEntryLongMs = 0, lastEntryShortMs = 0, lastSetup11Ms = 0;
  let lastS12L = 0, lastS12S = 0, lastS13L = 0, lastS13S = 0, lastS14L = 0, lastS14S = 0;
  let regime: Regime = "RANGE", regimeConsec = 0, regimeLastRaw: Regime = "RANGE";
  let haltedUntil = 0;
  let setup11Trades: S11Trade[] = [];
  let entries = 0, closes = 0, wins = 0, losses = 0, sumWin = 0, sumLoss = 0;
  let lowestWallet = INITIAL_CAPITAL, totalFees = 0;
  const setupCounts: Record<string, number> = {};
  const byYear: Record<string, { entries: number; closes: number; pnl: number }> = {};
  let last15IdxProcessed = -1, last4hIdxProcessed = -1;
  let idx15 = 0, idx1h = 0, idx1d = 0, idx1w = 0, idx4h = 0;

  for (let i = 0; i < c5.length; i++) {
    const bar5 = c5[i]; const ts = bar5.time; const mark = bar5.close;
    idx15 = findIdx(c15, ts, idx15); idx1h = findIdx(c1h, ts, idx1h);
    idx1d = findIdx(c1d, ts, idx1d); idx1w = findIdx(c1w, ts, idx1w);
    idx4h = findIdx(c4h, ts, idx4h);
    const idx15c = idx15 - 1; const idx5c = i - 1; const idx1hc = idx1h - 1;
    const idx1dc = idx1d - 1; const idx4hc = idx4h - 1;

    // Close Setup #11
    const newS11: S11Trade[] = [];
    for (const t of setup11Trades) {
      if (mark >= t.tpPx || mark <= t.slPx) {
        const fee = t.qty * mark * FEE_PCT / 100;
        const pnl = (mark - t.entryPx) * t.qty;
        wallet += pnl - fee; totalFees += fee;
        if (wallet > hwm) hwm = wallet; if (wallet < lowestWallet) lowestWallet = wallet;
        closes++;
        if (pnl > 0) { wins++; sumWin += pnl; } else { losses++; sumLoss += pnl; }
        const y = new Date(ts).toISOString().slice(0, 4);
        byYear[y] = byYear[y] ?? { entries: 0, closes: 0, pnl: 0 };
        byYear[y].closes++; byYear[y].pnl += pnl - fee;
        longNet = { qty: Math.max(0, longNet.qty - t.qty), avg: longNet.qty - t.qty > 0 ? longNet.avg : 0 };
      } else newS11.push(t);
    }
    setup11Trades = newS11;

    // Aggregate close
    if (longNet.qty > 0 && longNet.avg > 0) {
      const gain = (mark - longNet.avg) / longNet.avg * 100;
      if (gain >= TP_PCT || gain <= -AGGREGATE_SL_PCT) {
        const fee = longNet.qty * mark * FEE_PCT / 100;
        const pnl = (mark - longNet.avg) * longNet.qty;
        wallet += pnl - fee; totalFees += fee;
        if (wallet > hwm) hwm = wallet; if (wallet < lowestWallet) lowestWallet = wallet;
        closes++;
        if (pnl > 0) { wins++; sumWin += pnl; } else { losses++; sumLoss += pnl; }
        const y = new Date(ts).toISOString().slice(0, 4);
        byYear[y] = byYear[y] ?? { entries: 0, closes: 0, pnl: 0 };
        byYear[y].closes++; byYear[y].pnl += pnl - fee;
        longNet = { qty: 0, avg: 0 }; setup11Trades = [];
      }
    }
    if (shortNet.qty > 0 && shortNet.avg > 0) {
      const drop = (shortNet.avg - mark) / shortNet.avg * 100;
      if (drop >= TP_PCT || drop <= -AGGREGATE_SL_PCT) {
        const fee = shortNet.qty * mark * FEE_PCT / 100;
        const pnl = (shortNet.avg - mark) * shortNet.qty;
        wallet += pnl - fee; totalFees += fee;
        if (wallet > hwm) hwm = wallet; if (wallet < lowestWallet) lowestWallet = wallet;
        closes++;
        if (pnl > 0) { wins++; sumWin += pnl; } else { losses++; sumLoss += pnl; }
        const y = new Date(ts).toISOString().slice(0, 4);
        byYear[y] = byYear[y] ?? { entries: 0, closes: 0, pnl: 0 };
        byYear[y].closes++; byYear[y].pnl += pnl - fee;
        shortNet = { qty: 0, avg: 0 };
      }
    }

    if (idx15c < 60 || idx15c <= last15IdxProcessed) continue;
    last15IdxProcessed = idx15c;
    if (ts < haltedUntil) continue;

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
    let newRegime = regime, newConsec = regimeConsec;
    if (rawReg === regime) newConsec = 1;
    else if (rawReg === regimeLastRaw) {
      newConsec = regimeConsec + 1;
      if (newConsec >= REGIME_PERSIST_BARS) { newRegime = rawReg; newConsec = 1; }
    } else newConsec = 1;
    regime = newRegime; regimeConsec = newConsec; regimeLastRaw = rawReg;

    let hwmScale = 1.0;
    if (wallet < hwm) {
      const dd = (hwm - wallet) / hwm * 100;
      if (dd < 5) hwmScale = 1.0;
      else if (dd < 10) hwmScale = 0.75;
      else if (dd < 15) hwmScale = 0.50;
      else if (dd < 20) hwmScale = 0.25;
      else { hwmScale = 0; haltedUntil = ts + 24 * 60 * 60_000; }
    }
    if (hwmScale === 0) continue;

    const atr = ind.atr14_15[idx15c];
    let atrScale = 1.0;
    if (atr !== null && atr > 0 && mark > 0) {
      const atrPct = atr / mark * 100;
      const f = ATR_BASELINE_PCT / atrPct;
      atrScale = Math.max(ATR_SCALE_MIN, Math.min(ATR_SCALE_MAX, f));
    }

    // Score
    if (idx15c < 60) continue;
    const last = c15[idx15c];
    const r = ind.rsi15[idx15c] ?? 50, sk = ind.stoch15[idx15c] ?? 50, mh = ind.macdH15[idx15c] ?? 0;
    const m50 = ind.ma50_15[idx15c], m20 = ind.ma20_15[idx15c], s20 = ind.sd20_15[idx15c] ?? 0;
    const atr14 = ind.atr14_15[idx15c] ?? 0, vm = ind.volMA_15[idx15c] ?? 0;
    const dnWick = (Math.min(last.open, last.close) - last.low) / last.open * 100;
    const upWick = (last.high - Math.max(last.open, last.close)) / last.open * 100;
    const body = Math.abs(last.close - last.open) / last.open * 100;
    const isBull = last.close > last.open ? 1 : 0;
    const volR = vm > 0 ? (last.volume ?? 0) / vm : 0;
    const bbPos = (m20 !== null && s20 > 0) ? (last.close - (m20 - 2 * s20)) / (4 * s20) * 100 : 50;
    const mom5 = idx15c >= 5 ? (last.close - c15[idx15c - 5].close) / c15[idx15c - 5].close * 100 : 0;
    const mom10 = idx15c >= 10 ? (last.close - c15[idx15c - 10].close) / c15[idx15c - 10].close * 100 : 0;
    const mom20 = idx15c >= 20 ? (last.close - c15[idx15c - 20].close) / c15[idx15c - 20].close * 100 : 0;
    const atrRatio = atr14 > 0 ? (last.high - last.low) / atr14 : 0;
    const distMA50 = m50 !== null ? (last.close - m50) / m50 * 100 : 0;
    let lS = 0, sS = 0;
    if (dnWick >= 0.5) lS++; if (body >= 0.5) lS++; if (isBull === 0) lS++;
    if (volR >= 2.0) lS++; if (atrRatio >= 1.5) lS++; if (r <= 35) lS++;
    if (sk <= 30) lS++; if (mh <= -100) lS++; if (bbPos <= 5) lS++;
    if (distMA50 <= -3) lS++; if (mom5 < 0 && mom10 < 0 && mom20 < 0) lS++;
    if (upWick >= 0.5) sS++; if (body >= 0.5) sS++; if (isBull === 1) sS++;
    if (volR >= 2.0) sS++; if (atrRatio >= 1.5) sS++; if (r >= 65) sS++;
    if (sk >= 70) sS++; if (mh >= 100) sS++; if (bbPos >= 95) sS++;
    if (distMA50 >= 3) sS++; if (mom5 > 0 && mom10 > 0 && mom20 > 0) sS++;

    let c2Fire = false;
    if (idx5c >= 22) {
      const last5 = c5[idx5c]; const r5 = ind.rsi5[idx5c];
      if (r5 !== null && r5 >= 70) {
        const upWick5 = (last5.high - Math.max(last5.open, last5.close)) / last5.open * 100;
        if (upWick5 >= 0.3) {
          const m5_5 = (last5.close - c5[idx5c - 5].close) / c5[idx5c - 5].close * 100;
          const m10_5 = (last5.close - c5[idx5c - 10].close) / c5[idx5c - 10].close * 100;
          const m20_5 = (last5.close - c5[idx5c - 20].close) / c5[idx5c - 20].close * 100;
          if (m5_5 >= 0 && m10_5 >= 0 && m20_5 >= 0) c2Fire = true;
        }
      }
    }
    let f4Pass = false;
    if (c2Fire) {
      const r15v = ind.rsi15[idx15c]; const r1hv = ind.rsi1h[idx1hc]; const m50dv = ind.ma50d[idx1dc];
      if (r15v !== null && r15v > 55 && r1hv !== null && r1hv > 50 && m50dv !== null && c1d[idx1dc].close > m50dv) f4Pass = true;
    }

    // 4h trend setups (only check khi sang 4h bar mới)
    let ema12: "LONG" | "SHORT" | null = null;
    let atr13: "LONG" | "SHORT" | null = null;
    let don14: "LONG" | "SHORT" | null = null;
    if (idx4hc >= EMA_SLOW + 1 && idx4hc > last4hIdxProcessed) {
      last4hIdxProcessed = idx4hc;
      const fp = ind.ema50_4h[idx4hc - 1], sp = ind.ema200_4h[idx4hc - 1];
      const fc = ind.ema50_4h[idx4hc], sc = ind.ema200_4h[idx4hc];
      if (fp !== null && sp !== null && fc !== null && sc !== null) {
        if (fp <= sp && fc > sc) ema12 = "LONG";
        else if (fp >= sp && fc < sc) ema12 = "SHORT";
      }
      // ATR breakout
      const atrV = ind.atr14_4h[idx4hc];
      if (atrV !== null && atrV > 0 && idx4hc >= 1) {
        const prev4h = c4h[idx4hc - 1]; const last4h = c4h[idx4hc];
        if (last4h.close > prev4h.close + atrV * ATR_BREAKOUT_MULT) atr13 = "LONG";
        else if (last4h.close < prev4h.close - atrV * ATR_BREAKOUT_MULT) atr13 = "SHORT";
      }
      // Donchian
      if (idx4hc >= DONCHIAN_LOOKBACK) {
        let hi = -Infinity, lo = Infinity;
        for (let j = idx4hc - DONCHIAN_LOOKBACK; j < idx4hc; j++) {
          if (c4h[j].high > hi) hi = c4h[j].high;
          if (c4h[j].low < lo) lo = c4h[j].low;
        }
        const l4 = c4h[idx4hc];
        if (l4.close > hi) don14 = "LONG";
        else if (l4.close < lo) don14 = "SHORT";
      }
    }

    const longCD = ts - lastEntryLongMs < COOLDOWN_MS;
    const shortCD = ts - lastEntryShortMs < COOLDOWN_MS;
    const s11CD = ts - lastSetup11Ms < SETUP11_COOLDOWN_MS;
    const longScale = regime === "BEAR" ? 0.5 : 1.0;
    const allowMomLong = regime !== "BEAR";
    const allowShortSide = regime !== "BULL";

    // Aggregate LONG (mean rev)
    if (!longCD) {
      let qty = 0;
      let setups: string[] = [];
      if (lS >= 9) {
        qty += aggregateQty(lS, "LONG");
        setups.push(`agg(${lS})`);
        if (idx5c >= 200) {
          const last5px = c5[idx5c].close;
          const m200 = ind.ma200_5m[idx5c]; const m50_5 = ind.ma50_5m[idx5c];
          let deep = false;
          if (m200 !== null && (last5px - m200) / m200 * 100 < -10) deep = true;
          else if (m50_5 !== null && (last5px - m50_5) / m50_5 * 100 < -5) deep = true;
          else if (idx5c >= 60) {
            const mom60 = (last5px - c5[idx5c - 60].close) / c5[idx5c - 60].close * 100;
            if (mom60 < -5) deep = true;
          }
          if (deep) { qty += DEEPDIP_QTY_BOOST; setups.push("S9"); }
        }
      }
      if (c2Fire && !f4Pass && allowMomLong) { qty += C2_QTY; setups.push("S10"); }
      qty *= longScale * hwmScale * atrScale;
      if (qty > 0 && qty < MIN_BINANCE_QTY) qty = MIN_BINANCE_QTY;
      if (qty > 0 && longNet.qty + qty <= MAX_QTY) {
        const fee = qty * mark * FEE_PCT / 100;
        wallet -= fee; totalFees += fee;
        const nq = longNet.qty + qty;
        longNet = { qty: nq, avg: (longNet.qty * longNet.avg + qty * mark) / nq };
        lastEntryLongMs = ts; entries++;
        const key = setups.join("+");
        setupCounts[key] = (setupCounts[key] ?? 0) + 1;
        const y = new Date(ts).toISOString().slice(0, 4);
        byYear[y] = byYear[y] ?? { entries: 0, closes: 0, pnl: 0 }; byYear[y].entries++;
      }
    }

    // Setup #11
    if (!s11CD && c2Fire && f4Pass && allowMomLong) {
      const scaledQty = SETUP11_QTY * hwmScale * atrScale;
      if (scaledQty >= MIN_BINANCE_QTY && longNet.qty + scaledQty <= MAX_QTY) {
        const tpPx = mark * (1 + SETUP11_TP_PCT / 100);
        const slPx = mark * (1 - SETUP11_SL_PCT / 100);
        const fee = scaledQty * mark * FEE_PCT / 100;
        wallet -= fee; totalFees += fee;
        const nq = longNet.qty + scaledQty;
        longNet = { qty: nq, avg: (longNet.qty * longNet.avg + scaledQty * mark) / nq };
        lastSetup11Ms = ts;
        setup11Trades.push({ id: `s11_${ts}`, entryPx: mark, qty: scaledQty, tpPx, slPx });
        entries++;
        setupCounts["S11"] = (setupCounts["S11"] ?? 0) + 1;
        const y = new Date(ts).toISOString().slice(0, 4);
        byYear[y] = byYear[y] ?? { entries: 0, closes: 0, pnl: 0 }; byYear[y].entries++;
      }
    }

    // Setup #12 EMA cross 4h
    const s12LCD = ts - lastS12L < SETUP12_COOLDOWN_MS;
    const s12SCD = ts - lastS12S < SETUP12_COOLDOWN_MS;
    if (ema12 === "LONG" && !s12LCD && allowMomLong) {
      let q = SETUP12_QTY * hwmScale * atrScale;
      if (q > 0 && q < MIN_BINANCE_QTY) q = MIN_BINANCE_QTY;
      if (q > 0 && longNet.qty + q <= MAX_QTY) {
        const fee = q * mark * FEE_PCT / 100;
        wallet -= fee; totalFees += fee;
        const nq = longNet.qty + q;
        longNet = { qty: nq, avg: (longNet.qty * longNet.avg + q * mark) / nq };
        lastS12L = ts; entries++;
        setupCounts["S12L"] = (setupCounts["S12L"] ?? 0) + 1;
        const y = new Date(ts).toISOString().slice(0, 4);
        byYear[y] = byYear[y] ?? { entries: 0, closes: 0, pnl: 0 }; byYear[y].entries++;
      }
    } else if (ema12 === "SHORT" && !s12SCD && allowShortSide) {
      let q = SETUP12_QTY * hwmScale * atrScale;
      if (q > 0 && q < MIN_BINANCE_QTY) q = MIN_BINANCE_QTY;
      if (q > 0 && shortNet.qty + q <= MAX_QTY) {
        const fee = q * mark * FEE_PCT / 100;
        wallet -= fee; totalFees += fee;
        const nq = shortNet.qty + q;
        shortNet = { qty: nq, avg: (shortNet.qty * shortNet.avg + q * mark) / nq };
        lastS12S = ts; entries++;
        setupCounts["S12S"] = (setupCounts["S12S"] ?? 0) + 1;
        const y = new Date(ts).toISOString().slice(0, 4);
        byYear[y] = byYear[y] ?? { entries: 0, closes: 0, pnl: 0 }; byYear[y].entries++;
      }
    }

    // Setup #13 ATR breakout 4h
    const s13LCD = ts - lastS13L < SETUP13_COOLDOWN_MS;
    const s13SCD = ts - lastS13S < SETUP13_COOLDOWN_MS;
    if (atr13 === "LONG" && !s13LCD && allowMomLong) {
      let q = SETUP13_QTY * hwmScale * atrScale;
      if (q > 0 && q < MIN_BINANCE_QTY) q = MIN_BINANCE_QTY;
      if (q > 0 && longNet.qty + q <= MAX_QTY) {
        const fee = q * mark * FEE_PCT / 100;
        wallet -= fee; totalFees += fee;
        const nq = longNet.qty + q;
        longNet = { qty: nq, avg: (longNet.qty * longNet.avg + q * mark) / nq };
        lastS13L = ts; entries++;
        setupCounts["S13L"] = (setupCounts["S13L"] ?? 0) + 1;
        const y = new Date(ts).toISOString().slice(0, 4);
        byYear[y] = byYear[y] ?? { entries: 0, closes: 0, pnl: 0 }; byYear[y].entries++;
      }
    } else if (atr13 === "SHORT" && !s13SCD && allowShortSide) {
      let q = SETUP13_QTY * hwmScale * atrScale;
      if (q > 0 && q < MIN_BINANCE_QTY) q = MIN_BINANCE_QTY;
      if (q > 0 && shortNet.qty + q <= MAX_QTY) {
        const fee = q * mark * FEE_PCT / 100;
        wallet -= fee; totalFees += fee;
        const nq = shortNet.qty + q;
        shortNet = { qty: nq, avg: (shortNet.qty * shortNet.avg + q * mark) / nq };
        lastS13S = ts; entries++;
        setupCounts["S13S"] = (setupCounts["S13S"] ?? 0) + 1;
        const y = new Date(ts).toISOString().slice(0, 4);
        byYear[y] = byYear[y] ?? { entries: 0, closes: 0, pnl: 0 }; byYear[y].entries++;
      }
    }

    // Setup #14 Donchian 4h
    const s14LCD = ts - lastS14L < SETUP14_COOLDOWN_MS;
    const s14SCD = ts - lastS14S < SETUP14_COOLDOWN_MS;
    if (don14 === "LONG" && !s14LCD && allowMomLong) {
      let q = SETUP14_QTY * hwmScale * atrScale;
      if (q > 0 && q < MIN_BINANCE_QTY) q = MIN_BINANCE_QTY;
      if (q > 0 && longNet.qty + q <= MAX_QTY) {
        const fee = q * mark * FEE_PCT / 100;
        wallet -= fee; totalFees += fee;
        const nq = longNet.qty + q;
        longNet = { qty: nq, avg: (longNet.qty * longNet.avg + q * mark) / nq };
        lastS14L = ts; entries++;
        setupCounts["S14L"] = (setupCounts["S14L"] ?? 0) + 1;
        const y = new Date(ts).toISOString().slice(0, 4);
        byYear[y] = byYear[y] ?? { entries: 0, closes: 0, pnl: 0 }; byYear[y].entries++;
      }
    } else if (don14 === "SHORT" && !s14SCD && allowShortSide) {
      let q = SETUP14_QTY * hwmScale * atrScale;
      if (q > 0 && q < MIN_BINANCE_QTY) q = MIN_BINANCE_QTY;
      if (q > 0 && shortNet.qty + q <= MAX_QTY) {
        const fee = q * mark * FEE_PCT / 100;
        wallet -= fee; totalFees += fee;
        const nq = shortNet.qty + q;
        shortNet = { qty: nq, avg: (shortNet.qty * shortNet.avg + q * mark) / nq };
        lastS14S = ts; entries++;
        setupCounts["S14S"] = (setupCounts["S14S"] ?? 0) + 1;
        const y = new Date(ts).toISOString().slice(0, 4);
        byYear[y] = byYear[y] ?? { entries: 0, closes: 0, pnl: 0 }; byYear[y].entries++;
      }
    }

    // SHORT aggregate (mean rev) — 1W bear filter
    if (sS >= 9 && !shortCD && allowShortSide) {
      let weeklyDown = false;
      if (idx1w >= 2) weeklyDown = c1w[idx1w - 1].close < c1w[idx1w - 2].close;
      if (weeklyDown) {
        let qty = aggregateQty(sS, "SHORT");
        qty *= hwmScale * atrScale;
        if (qty > 0 && qty < MIN_BINANCE_QTY) qty = MIN_BINANCE_QTY;
        if (qty > 0 && shortNet.qty + qty <= MAX_QTY) {
          const fee = qty * mark * FEE_PCT / 100;
          wallet -= fee; totalFees += fee;
          const nq = shortNet.qty + qty;
          shortNet = { qty: nq, avg: (shortNet.qty * shortNet.avg + qty * mark) / nq };
          lastEntryShortMs = ts; entries++;
          setupCounts[`aggS(${sS})`] = (setupCounts[`aggS(${sS})`] ?? 0) + 1;
          const y = new Date(ts).toISOString().slice(0, 4);
          byYear[y] = byYear[y] ?? { entries: 0, closes: 0, pnl: 0 }; byYear[y].entries++;
        }
      }
    }
  }

  // Force close
  const lastBar = c5[c5.length - 1];
  const lastMark = lastBar.close;
  if (longNet.qty > 0) {
    const pnl = (lastMark - longNet.avg) * longNet.qty;
    wallet += pnl;
    if (pnl > 0) { wins++; sumWin += pnl; } else if (pnl < 0) { losses++; sumLoss += pnl; }
    closes++;
  }
  if (shortNet.qty > 0) {
    const pnl = (shortNet.avg - lastMark) * shortNet.qty;
    wallet += pnl;
    if (pnl > 0) { wins++; sumWin += pnl; } else if (pnl < 0) { losses++; sumLoss += pnl; }
    closes++;
  }

  const roi = (wallet - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100;
  const maxDD = (hwm - lowestWallet) / hwm * 100;
  const wr = closes > 0 ? wins / closes * 100 : 0;
  const avgWin = wins > 0 ? sumWin / wins : 0;
  const avgLoss = losses > 0 ? sumLoss / losses : 0;
  const exp = closes > 0 ? (wr / 100 * avgWin + (1 - wr / 100) * avgLoss) : 0;
  const ra = maxDD > 0 ? roi / maxDD : (roi > 0 ? 999 : 0);

  const summary = {
    version: "v0.4.34", roi: +roi.toFixed(2), maxDD: +maxDD.toFixed(2), ra: +ra.toFixed(2),
    finalWallet: Math.round(wallet), hwm: Math.round(hwm),
    entries, closes, wins, losses, wr: +wr.toFixed(2),
    avgWin: +avgWin.toFixed(2), avgLoss: +avgLoss.toFixed(2),
    rr: avgLoss < 0 ? +(avgWin / -avgLoss).toFixed(2) : 0,
    expectancy: +exp.toFixed(2), totalFees: Math.round(totalFees),
    setupBreakdown: setupCounts,
    byYear: Object.fromEntries(Object.entries(byYear).map(([k, v]) => [k, { ...v, pnl: Math.round(v.pnl) }])),
  };

  console.log("\n=== HEDGE01 v0.4.34 — 3y backtest (14 setups combined) ===");
  console.log(JSON.stringify(summary, null, 2));

  console.log("\n=== COMPARISON TABLE ===");
  console.log("Version         | ROI%   | DD%   | RA    | Entries | Closes | WR%   | R:R  | Exp/trade");
  console.log("-".repeat(95));
  console.log(`v0.4.32 baseline|   0.71 |  1.49 |  0.48 |     462 |     71 | 69.01 | 0.53 |    11.27`);
  console.log(`v0.4.33 SL-8    |   1.03 |  1.55 |  0.66 |     484 |     85 | 57.65 | 0.95 |    13.28`);
  console.log(`v0.4.34 14setup | ${String(summary.roi).padStart(6)} | ${String(summary.maxDD).padStart(5)} | ${String(summary.ra).padStart(5)} | ${String(summary.entries).padStart(7)} | ${String(summary.closes).padStart(6)} | ${String(summary.wr).padStart(5)} | ${String(summary.rr).padStart(4)} | ${String(summary.expectancy).padStart(8)}`);

  writeFileSync(join(__dirname, "..", "assets", "backtest_h01_v0434_3y.json"), JSON.stringify(summary, null, 2));
  console.log(`\nWritten assets/backtest_h01_v0434_3y.json`);
}

main();
