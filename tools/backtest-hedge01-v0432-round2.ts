/**
 * backtest-hedge01-v0432-round2.ts — tune relax overlays trên top variant A.
 *
 * Base: variant A (SL -8% tight).
 * Test R1-R4 thêm relax:
 *   R1: A + TP +15% (let winners run)
 *   R2: R1 + disable regime BEAR scaling (restore full size)
 *   R3: R2 + raise ATR baseline 0.4 → 0.8 (less aggressive scale-down)
 *   R4: R3 + relax F4 (15m RSI > 50 thay > 55)
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const INITIAL_CAPITAL = 100_000;
const FEE_PER_SIDE_PCT = 0.05;
const COOLDOWN_MS = 60 * 60_000;
const C2_QTY = 0.007;
const DEEPDIP_QTY_BOOST = 0.05;
const SETUP11_QTY = 0.001;
const SETUP11_TP_PCT = 7;
const SETUP11_SL_PCT = 3.5;
const SETUP11_COOLDOWN_MS = 15 * 60_000;
const MIN_BINANCE_QTY = 0.001;
const MAX_QTY = 0.05;
const ATR_SCALE_MIN = 0.4;
const ATR_SCALE_MAX = 1.5;
const REGIME_PERSIST_BARS = 3;

interface Variant {
  name: string;
  tpPct: number;
  slPct: number;
  bearScale: number;       // 1.0 = no scale, 0.5 = default
  atrBaselinePct: number;
  f4Rsi15Threshold: number;
}

const VARIANTS: Variant[] = [
  { name: "A_baseline_SL8",       tpPct: 10, slPct: 8, bearScale: 0.5, atrBaselinePct: 0.4, f4Rsi15Threshold: 55 },
  { name: "R1_TP15",              tpPct: 15, slPct: 8, bearScale: 0.5, atrBaselinePct: 0.4, f4Rsi15Threshold: 55 },
  { name: "R2_TP15_noBearScale",  tpPct: 15, slPct: 8, bearScale: 1.0, atrBaselinePct: 0.4, f4Rsi15Threshold: 55 },
  { name: "R3_TP15_atr08",        tpPct: 15, slPct: 8, bearScale: 1.0, atrBaselinePct: 0.8, f4Rsi15Threshold: 55 },
  { name: "R4_TP15_atr08_F4_50",  tpPct: 15, slPct: 8, bearScale: 1.0, atrBaselinePct: 0.8, f4Rsi15Threshold: 50 },
];

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

interface Indicators {
  rsi15: (number | null)[]; stoch15: (number | null)[]; macdH15: (number | null)[];
  ma50_15: (number | null)[]; ma20_15: (number | null)[]; sd20_15: (number | null)[];
  atr14_15: (number | null)[]; volMA_15: (number | null)[];
  rsi5: (number | null)[]; ma200_5m: (number | null)[]; ma50_5m: (number | null)[];
  rsi1h: (number | null)[]; ma200d: (number | null)[]; ma50d: (number | null)[];
}

function runBacktest(c5: Candle[], c15: Candle[], c1h: Candle[], c1d: Candle[], c1w: Candle[], ind: Indicators, v: Variant): any {
  let wallet = INITIAL_CAPITAL, hwm = INITIAL_CAPITAL;
  let longNet: Net = { qty: 0, avg: 0 }, shortNet: Net = { qty: 0, avg: 0 };
  let lastEntryLongMs = 0, lastEntryShortMs = 0, lastSetup11Ms = 0;
  let regime: Regime = "RANGE", regimeConsec = 0, regimeLastRaw: Regime = "RANGE";
  let haltedUntil = 0;
  let setup11Trades: S11Trade[] = [];
  let entries = 0, closes = 0, wins = 0, losses = 0, sumWin = 0, sumLoss = 0;
  let lowestWallet = INITIAL_CAPITAL, totalFees = 0;
  const byYear: Record<string, { entries: number; closes: number; pnl: number }> = {};
  let last15IdxProcessed = -1;
  let idx15 = 0, idx1h = 0, idx1d = 0, idx1w = 0;

  for (let i = 0; i < c5.length; i++) {
    const bar5 = c5[i]; const ts = bar5.time; const mark = bar5.close;
    idx15 = findIdx(c15, ts, idx15); idx1h = findIdx(c1h, ts, idx1h);
    idx1d = findIdx(c1d, ts, idx1d); idx1w = findIdx(c1w, ts, idx1w);
    const idx15c = idx15 - 1; const idx5c = i - 1; const idx1hc = idx1h - 1; const idx1dc = idx1d - 1;

    // Setup #11 close
    const newS11: S11Trade[] = [];
    for (const t of setup11Trades) {
      if (mark >= t.tpPx || mark <= t.slPx) {
        const fee = t.qty * mark * FEE_PER_SIDE_PCT / 100;
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
      if (gain >= v.tpPct || gain <= -v.slPct) {
        const fee = longNet.qty * mark * FEE_PER_SIDE_PCT / 100;
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
      if (drop >= v.tpPct || drop <= -v.slPct) {
        const fee = shortNet.qty * mark * FEE_PER_SIDE_PCT / 100;
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
      const f = v.atrBaselinePct / atrPct;
      atrScale = Math.max(ATR_SCALE_MIN, Math.min(ATR_SCALE_MAX, f));
    }

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
      if (r15v !== null && r15v > v.f4Rsi15Threshold && r1hv !== null && r1hv > 50 && m50dv !== null && c1d[idx1dc].close > m50dv) f4Pass = true;
    }

    const longCD = ts - lastEntryLongMs < COOLDOWN_MS;
    const shortCD = ts - lastEntryShortMs < COOLDOWN_MS;
    const s11CD = ts - lastSetup11Ms < SETUP11_COOLDOWN_MS;
    const longScale = regime === "BEAR" ? v.bearScale : 1.0;
    const allowMomLong = regime !== "BEAR";
    const allowShortSide = regime !== "BULL";

    if (!longCD) {
      let qty = 0;
      if (lS >= 9) {
        qty += aggregateQty(lS, "LONG");
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
          if (deep) qty += DEEPDIP_QTY_BOOST;
        }
      }
      if (c2Fire && !f4Pass && allowMomLong) qty += C2_QTY;
      qty *= longScale * hwmScale * atrScale;
      if (qty > 0 && qty < MIN_BINANCE_QTY) qty = MIN_BINANCE_QTY;
      if (qty > 0 && longNet.qty + qty <= MAX_QTY) {
        const fee = qty * mark * FEE_PER_SIDE_PCT / 100;
        wallet -= fee; totalFees += fee;
        const nq = longNet.qty + qty;
        longNet = { qty: nq, avg: (longNet.qty * longNet.avg + qty * mark) / nq };
        lastEntryLongMs = ts; entries++;
        const y = new Date(ts).toISOString().slice(0, 4);
        byYear[y] = byYear[y] ?? { entries: 0, closes: 0, pnl: 0 };
        byYear[y].entries++;
      }
    }

    if (!s11CD && c2Fire && f4Pass && allowMomLong) {
      const scaledQty = SETUP11_QTY * hwmScale * atrScale;
      if (scaledQty >= MIN_BINANCE_QTY && longNet.qty + scaledQty <= MAX_QTY) {
        const tradeId = `s11_${ts}_${Math.floor(mark)}`;
        const tpPx = mark * (1 + SETUP11_TP_PCT / 100);
        const slPx = mark * (1 - SETUP11_SL_PCT / 100);
        const fee = scaledQty * mark * FEE_PER_SIDE_PCT / 100;
        wallet -= fee; totalFees += fee;
        const nq = longNet.qty + scaledQty;
        longNet = { qty: nq, avg: (longNet.qty * longNet.avg + scaledQty * mark) / nq };
        lastSetup11Ms = ts;
        setup11Trades.push({ id: tradeId, entryPx: mark, qty: scaledQty, tpPx, slPx });
        entries++;
        const y = new Date(ts).toISOString().slice(0, 4);
        byYear[y] = byYear[y] ?? { entries: 0, closes: 0, pnl: 0 };
        byYear[y].entries++;
      }
    }

    if (sS >= 9 && !shortCD && allowShortSide) {
      let weeklyDown = false;
      if (idx1w >= 2) weeklyDown = c1w[idx1w - 1].close < c1w[idx1w - 2].close;
      if (weeklyDown) {
        let qty = aggregateQty(sS, "SHORT");
        qty *= hwmScale * atrScale;
        if (qty > 0 && qty < MIN_BINANCE_QTY) qty = MIN_BINANCE_QTY;
        if (qty > 0 && shortNet.qty + qty <= MAX_QTY) {
          const fee = qty * mark * FEE_PER_SIDE_PCT / 100;
          wallet -= fee; totalFees += fee;
          const nq = shortNet.qty + qty;
          shortNet = { qty: nq, avg: (shortNet.qty * shortNet.avg + qty * mark) / nq };
          lastEntryShortMs = ts; entries++;
          const y = new Date(ts).toISOString().slice(0, 4);
          byYear[y] = byYear[y] ?? { entries: 0, closes: 0, pnl: 0 };
          byYear[y].entries++;
        }
      }
    }
  }

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
  const expectancy = closes > 0 ? (wr / 100 * avgWin + (1 - wr / 100) * avgLoss) : 0;
  const riskAdj = maxDD > 0 ? roi / maxDD : (roi > 0 ? 999 : 0);

  return {
    variant: v.name, roi: +roi.toFixed(2), maxDD: +maxDD.toFixed(2), riskAdj: +riskAdj.toFixed(2),
    entries, closes, wins, losses, wr: +wr.toFixed(2),
    avgWin: +avgWin.toFixed(2), avgLoss: +avgLoss.toFixed(2),
    rr: avgLoss < 0 ? +(avgWin / -avgLoss).toFixed(2) : 0,
    expectancy: +expectancy.toFixed(2), byYear,
  };
}

function main() {
  console.log("[round2] Loading caches...");
  const c5 = loadCache("5m");
  const c15 = loadCache("15m");
  const c1h = loadCache("1h");
  const c1d = loadCache("1d");
  const c1w = loadCache("1w");
  console.log("[round2] Pre-computing indicators...");
  const close15 = c15.map(b => b.close);
  const vol15 = c15.map(b => b.volume ?? 0);
  const ma20 = calcSMA(close15, 20);
  const ind: Indicators = {
    rsi15: calcRSI(close15, 14), stoch15: calcStochK(c15, 14), macdH15: calcMACDHist(close15),
    ma50_15: calcSMA(close15, 50), ma20_15: ma20, sd20_15: calcStdev(close15, 20, ma20),
    atr14_15: calcATR(c15, 14), volMA_15: calcSMA(vol15, 20),
    rsi5: calcRSI(c5.map(b => b.close), 14),
    ma200_5m: calcSMA(c5.map(b => b.close), 200),
    ma50_5m: calcSMA(c5.map(b => b.close), 50),
    rsi1h: calcRSI(c1h.map(b => b.close), 14),
    ma200d: calcSMA(c1d.map(b => b.close), 200), ma50d: calcSMA(c1d.map(b => b.close), 50),
  };

  const results: any[] = [];
  for (const v of VARIANTS) {
    console.log(`\n[round2] Running ${v.name}...`);
    const r = runBacktest(c5, c15, c1h, c1d, c1w, ind, v);
    results.push(r);
    console.log(`  ROI ${r.roi}% / DD ${r.maxDD}% / RA ${r.riskAdj} / ${r.entries}E ${r.closes}C WR ${r.wr}% R:R ${r.rr} Exp $${r.expectancy}`);
  }

  console.log("\n=== ROUND 2 COMPARISON (capital $100k, MAX_QTY 0.05, 3y) ===");
  console.log("Variant                       | ROI%   | DD%   | RA    | Entries | Closes | WR%   | R:R  | Exp/trade");
  console.log("-".repeat(115));
  for (const r of results) {
    console.log(`${r.variant.padEnd(29)} | ${String(r.roi).padStart(6)} | ${String(r.maxDD).padStart(5)} | ${String(r.riskAdj).padStart(5)} | ${String(r.entries).padStart(7)} | ${String(r.closes).padStart(6)} | ${String(r.wr).padStart(5)} | ${String(r.rr).padStart(4)} | ${String(r.expectancy).padStart(8)}`);
  }

  console.log("\n=== PER-YEAR PnL ===");
  console.log("Variant                       | 2023    | 2024    | 2025    | 2026");
  console.log("-".repeat(80));
  for (const r of results) {
    const y23 = r.byYear["2023"]?.pnl?.toFixed(0) ?? "-";
    const y24 = r.byYear["2024"]?.pnl?.toFixed(0) ?? "-";
    const y25 = r.byYear["2025"]?.pnl?.toFixed(0) ?? "-";
    const y26 = r.byYear["2026"]?.pnl?.toFixed(0) ?? "-";
    console.log(`${r.variant.padEnd(29)} | ${String(y23).padStart(7)} | ${String(y24).padStart(7)} | ${String(y25).padStart(7)} | ${String(y26).padStart(7)}`);
  }

  writeFileSync(join(__dirname, "..", "assets", "backtest_h01_v0432_round2.json"), JSON.stringify(results, null, 2));
  console.log(`\nWritten assets/backtest_h01_v0432_round2.json`);
}

main();
