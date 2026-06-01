/**
 * backtest-hedge01-v0432-3y.ts (anh Tommy 2026-05-24)
 *
 * Full simulation hedge01 v0.4.32 trên 3y data (2023-04 → 2026-04).
 * Bao gồm TẤT CẢ overlays mới:
 *   - 8 setups gom (score 9/10/11)
 *   - Setup #9 DeepDip booster (+0.05 BTC)
 *   - Setup #10 C2 trend continuation (+0.007 BTC)
 *   - Setup #11 C2+F4 per-trade SL/TP (0.001 BTC, TP+7%/SL-3.5%, cooldown 15m)
 *   - Mutual-exclusive #10/#11 via F4
 *   - Regime BULL/RANGE/BEAR + persistence 3 bars
 *   - HWM DD ladder cooldown (5/10/15/20% → 1.0/0.75/0.5/0.25/halt24h)
 *   - ATR scale overlay (baseline 0.4%, clamp [0.4, 1.5])
 *   - Aggregate SL -12% hard
 *   - Min Binance qty 0.001 (rule level)
 *   - MAX_QTY 0.02 (scheduler)
 *   - 1W bear SHORT filter
 *
 * KHÔNG có: funding rate filter (3y data không có funding history, default allow).
 *
 * Output:
 *   - backtest_h01_v0432_3y_summary.json (aggregate stats)
 *   - backtest_h01_v0432_3y_entries.csv (mọi entry signal)
 *   - backtest_h01_v0432_3y_closes.csv (mọi close + PnL)
 *
 * Usage: npx tsx tools/backtest-hedge01-v0432-3y.ts
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

// === CONFIG (match production v0.4.32) ===
const INITIAL_CAPITAL = 100_000;  // backtest std (vs live $200)
const FEE_PER_SIDE_PCT = 0.05;
const COOLDOWN_MS = 60 * 60_000;
const TP_PCT = 10;
const AGGREGATE_SL_PCT = 12;
const C2_QTY = 0.007;
const DEEPDIP_QTY_BOOST = 0.05;
const SETUP11_QTY = 0.001;
const SETUP11_TP_PCT = 7;
const SETUP11_SL_PCT = 3.5;
const SETUP11_COOLDOWN_MS = 15 * 60_000;
const MAX_QTY_PER_SIDE = 0.02;
const MIN_BINANCE_QTY = 0.001;
const ATR_BASELINE_PCT = 0.4;
const ATR_SCALE_MIN = 0.4;
const ATR_SCALE_MAX = 1.5;
const REGIME_PERSIST_BARS = 3;

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }
interface Net { qty: number; avg: number; }
type Regime = "BULL" | "RANGE" | "BEAR";

interface EntryEvent {
  ts: number; iso: string; side: "LONG" | "SHORT"; price: number; qty: number;
  setup: string; score: number; regime: Regime; atrScale: number; hwmScale: number;
  setup11TradeId?: string;
}
interface CloseEvent {
  ts: number; iso: string; side: "LONG" | "SHORT"; price: number; qty: number;
  avgEntry: number; reason: "TP" | "SL" | "S11_TP" | "S11_SL"; pnlGross: number; fee: number;
  setup11TradeId?: string;
}
interface Setup11Trade { id: string; entryPx: number; qty: number; tpPx: number; slPx: number; }

function loadCache(tf: string): Candle[] {
  return JSON.parse(readFileSync(join(__dirname, "..", ".cache", `binance-${tf}-3y.json`), "utf8"));
}

// === Indicators ===
function calcSMA(a: number[], p: number): (number | null)[] {
  const o: (number | null)[] = new Array(a.length).fill(null);
  if (a.length < p) return o;
  let s = 0; for (let i = 0; i < p; i++) s += a[i]; o[p - 1] = s / p;
  for (let i = p; i < a.length; i++) { s += a[i] - a[i - p]; o[i] = s / p; }
  return o;
}
function calcEMA(a: number[], p: number): (number | null)[] {
  const o: (number | null)[] = new Array(a.length).fill(null);
  if (a.length < p) return o;
  const k = 2 / (p + 1); let e = 0;
  for (let i = 0; i < p; i++) e += a[i]; e /= p; o[p - 1] = e;
  for (let i = p; i < a.length; i++) { e = a[i] * k + e * (1 - k); o[i] = e; }
  return o;
}
function calcStdev(a: number[], p: number, sma: (number | null)[]): (number | null)[] {
  const o: (number | null)[] = new Array(a.length).fill(null);
  for (let i = p - 1; i < a.length; i++) {
    const m = sma[i]; if (m === null) continue;
    let sq = 0; for (let j = i - p + 1; j <= i; j++) sq += (a[j] - m) ** 2;
    o[i] = Math.sqrt(sq / p);
  } return o;
}
function calcRSI(c: number[], p: number): (number | null)[] {
  const o: (number | null)[] = new Array(c.length).fill(null);
  if (c.length <= p) return o;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const ch = c[i] - c[i - 1]; if (ch >= 0) g += ch; else l -= ch; }
  let ag = g / p, al = l / p;
  o[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = p + 1; i < c.length; i++) {
    const ch = c[i] - c[i - 1];
    ag = (ag * (p - 1) + Math.max(ch, 0)) / p;
    al = (al * (p - 1) + Math.max(-ch, 0)) / p;
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
  const o: (number | null)[] = new Array(c.length).fill(null);
  if (c.length <= p) return o;
  const tr: number[] = new Array(c.length).fill(0);
  for (let i = 1; i < c.length; i++) tr[i] = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
  let s = 0; for (let i = 1; i <= p; i++) s += tr[i]; o[p] = s / p;
  for (let i = p + 1; i < c.length; i++) o[i] = (o[i - 1]! * (p - 1) + tr[i]) / p;
  return o;
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

// === Score profile (11 features 15m) ===
function computeScores(c15: Candle[], i: number, rsi: (number | null)[], stoch: (number | null)[], macdH: (number | null)[], ma50: (number | null)[], ma20: (number | null)[], sd20: (number | null)[], atr14: (number | null)[], volMA: (number | null)[]): { longScore: number; shortScore: number } {
  if (i < 60) return { longScore: 0, shortScore: 0 };
  const last = c15[i];
  const r = rsi[i] ?? 50, sk = stoch[i] ?? 50, mh = macdH[i] ?? 0;
  const m50 = ma50[i], m20 = ma20[i], s20 = sd20[i] ?? 0, atr = atr14[i] ?? 0, vm = volMA[i] ?? 0;
  const dnWick = (Math.min(last.open, last.close) - last.low) / last.open * 100;
  const upWick = (last.high - Math.max(last.open, last.close)) / last.open * 100;
  const body = Math.abs(last.close - last.open) / last.open * 100;
  const isBull = last.close > last.open ? 1 : 0;
  const volR = vm > 0 ? (last.volume ?? 0) / vm : 0;
  const bbPos = (m20 !== null && s20 > 0) ? (last.close - (m20 - 2 * s20)) / (4 * s20) * 100 : 50;
  const mom5 = i >= 5 ? (last.close - c15[i - 5].close) / c15[i - 5].close * 100 : 0;
  const mom10 = i >= 10 ? (last.close - c15[i - 10].close) / c15[i - 10].close * 100 : 0;
  const mom20 = i >= 20 ? (last.close - c15[i - 20].close) / c15[i - 20].close * 100 : 0;
  const atrRatio = atr > 0 ? (last.high - last.low) / atr : 0;
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
  return { longScore: lS, shortScore: sS };
}

function aggregateQty(score: number, side: "LONG" | "SHORT"): number {
  let qty = 0;
  if (score === 11) qty += 0.001 * 3;
  if (score === 11) qty += 0.01;
  if (score >= 10) qty += 0.001;
  if (score >= 9) qty += 0.001;
  if (score >= 10) qty += 0.01;
  if (score === 11 && side === "LONG") qty += 0.001;
  return qty;
}

// === Setup #10 C2 (5m) ===
function isC2Trend5m(c5: Candle[], idx5: number, rsi5: (number | null)[]): boolean {
  if (idx5 < 22) return false;
  const last = c5[idx5];
  const r = rsi5[idx5]; if (r === null || r < 70) return false;
  const upWick = (last.high - Math.max(last.open, last.close)) / last.open * 100;
  if (upWick < 0.3) return false;
  const mom5 = (last.close - c5[idx5 - 5].close) / c5[idx5 - 5].close * 100;
  const mom10 = (last.close - c5[idx5 - 10].close) / c5[idx5 - 10].close * 100;
  const mom20 = (last.close - c5[idx5 - 20].close) / c5[idx5 - 20].close * 100;
  return mom5 >= 0 && mom10 >= 0 && mom20 >= 0;
}

// === Setup #11 F4 filter ===
function passF4Filter(rsi15: (number | null)[], idx15: number, rsi1h: (number | null)[], idx1h: number, c1d: Candle[], idx1d: number, ma50d: (number | null)[]): boolean {
  const r15 = rsi15[idx15]; if (r15 === null || r15 <= 55) return false;
  const r1h = rsi1h[idx1h]; if (r1h === null || r1h <= 50) return false;
  const m50 = ma50d[idx1d]; if (m50 === null) return false;
  const c1dClose = c1d[idx1d].close;
  return c1dClose > m50;
}

// === Setup #9 DeepDip (5m) ===
function isDeepDip(c5: Candle[], idx5: number, ma200_5m: (number | null)[], ma50_5m: (number | null)[]): boolean {
  if (idx5 < 200) return false;
  const last = c5[idx5].close;
  const m200 = ma200_5m[idx5]; const m50 = ma50_5m[idx5];
  if (m200 !== null) { const d = (last - m200) / m200 * 100; if (d < -10) return true; }
  if (m50 !== null) { const d = (last - m50) / m50 * 100; if (d < -5) return true; }
  if (idx5 >= 60) {
    const mom60 = (last - c5[idx5 - 60].close) / c5[idx5 - 60].close * 100;
    if (mom60 < -5) return true;
  }
  return false;
}

// === Regime (1d) ===
function detectRegime(c1d: Candle[], idx1d: number, ma200d: (number | null)[], ma50d: (number | null)[]): Regime {
  if (idx1d < 200) return "RANGE";
  const last = c1d[idx1d];
  const m200 = ma200d[idx1d]; const m50 = ma50d[idx1d];
  if (m200 === null) return "RANGE";
  // 20d range vol proxy
  let rangeSum = 0; let n = 0;
  for (let j = idx1d - 19; j <= idx1d; j++) { rangeSum += (c1d[j].high - c1d[j].low) / c1d[j].close; n++; }
  const avgRange = n > 0 ? rangeSum / n : 0;
  const isTrending = avgRange > 0.04;
  if (last.close < m200) return "BEAR";
  if (m50 !== null && last.close > m50 && m50 > m200 && isTrending) return "BULL";
  return "RANGE";
}

function applyPersistence(raw: Regime, prev: Regime, consec: number, lastRaw: Regime): { regime: Regime; consec: number; lastRaw: Regime } {
  if (raw === prev) return { regime: prev, consec: 1, lastRaw: raw };
  if (raw === lastRaw) {
    const next = consec + 1;
    if (next >= REGIME_PERSIST_BARS) return { regime: raw, consec: 1, lastRaw: raw };
    return { regime: prev, consec: next, lastRaw: raw };
  }
  return { regime: prev, consec: 1, lastRaw: raw };
}

function scaleLongQty(r: Regime): number { return r === "BEAR" ? 0.5 : 1.0; }
function allowMomentumLong(r: Regime): boolean { return r !== "BEAR"; }
function allowShort(r: Regime): boolean { return r !== "BULL"; }

function getHWMScale(hwm: number, wallet: number): number {
  if (hwm <= 0 || wallet >= hwm) return 1.0;
  const dd = (hwm - wallet) / hwm * 100;
  if (dd < 5) return 1.0;
  if (dd < 10) return 0.75;
  if (dd < 15) return 0.50;
  if (dd < 20) return 0.25;
  return 0;
}

function computeAtrScale(atr: number | null, markPrice: number): number {
  if (atr === null || atr <= 0 || markPrice <= 0) return 1.0;
  const atrPct = atr / markPrice * 100;
  if (atrPct <= 0) return 1.0;
  const f = ATR_BASELINE_PCT / atrPct;
  return Math.max(ATR_SCALE_MIN, Math.min(ATR_SCALE_MAX, f));
}

function addNet(n: Net, q: number, p: number): Net {
  const nq = n.qty + q;
  return { qty: nq, avg: nq > 0 ? (n.qty * n.avg + q * p) / nq : 0 };
}

// === Bucket time → indices ===
function findIdx(arr: Candle[], ts: number, hint: number = 0): number {
  // binary-search-friendly; arr is sorted by time
  let lo = hint, hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (arr[mid].time <= ts) lo = mid; else hi = mid - 1;
  }
  return lo;
}

function main() {
  console.log("[h01-v0432-3y] Loading caches...");
  const c5 = loadCache("5m");
  const c15 = loadCache("15m");
  const c1h = loadCache("1h");
  const c1d = loadCache("1d");
  const c1w = loadCache("1w");
  console.log(`  5m=${c5.length} 15m=${c15.length} 1h=${c1h.length} 1d=${c1d.length} 1w=${c1w.length}`);

  console.log("[h01-v0432-3y] Pre-computing indicators...");
  const close15 = c15.map(b => b.close);
  const vol15 = c15.map(b => b.volume ?? 0);
  const rsi15 = calcRSI(close15, 14);
  const stoch15 = calcStochK(c15, 14);
  const macdH15 = calcMACDHist(close15);
  const ma50_15 = calcSMA(close15, 50);
  const ma20_15 = calcSMA(close15, 20);
  const sd20_15 = calcStdev(close15, 20, ma20_15);
  const atr14_15 = calcATR(c15, 14);
  const volMA_15 = calcSMA(vol15, 20);

  const close5 = c5.map(b => b.close);
  const rsi5 = calcRSI(close5, 14);
  const ma200_5m = calcSMA(close5, 200);
  const ma50_5m = calcSMA(close5, 50);

  const close1h = c1h.map(b => b.close);
  const rsi1h = calcRSI(close1h, 14);

  const close1d = c1d.map(b => b.close);
  const ma200d = calcSMA(close1d, 200);
  const ma50d = calcSMA(close1d, 50);

  console.log("[h01-v0432-3y] Running simulation 5m loop...");
  let wallet = INITIAL_CAPITAL;
  let hwm = INITIAL_CAPITAL;
  let longNet: Net = { qty: 0, avg: 0 };
  let shortNet: Net = { qty: 0, avg: 0 };
  let lastEntryLongMs = 0, lastEntryShortMs = 0, lastSetup11Ms = 0;
  let regime: Regime = "RANGE", regimeConsec = 0, regimeLastRaw: Regime = "RANGE";
  let haltedUntil = 0;
  let setup11Trades: Setup11Trade[] = [];

  const entries: EntryEvent[] = [];
  const closes: CloseEvent[] = [];
  let last15IdxProcessed = -1;
  let last5IdxProcessed = -1;

  let idx15 = 0, idx1h = 0, idx1d = 0, idx1w = 0;

  for (let i = 0; i < c5.length; i++) {
    const bar5 = c5[i];
    const ts = bar5.time;
    const mark = bar5.close; // mid-bar; use close for simulation

    // Align HTF indices (idx points to LAST closed bar at this ts, since data is closed bars)
    idx15 = findIdx(c15, ts, idx15);
    idx1h = findIdx(c1h, ts, idx1h);
    idx1d = findIdx(c1d, ts, idx1d);
    idx1w = findIdx(c1w, ts, idx1w);

    // closed bar logic: rule dùng slice(0,-1) tức bar trước cùng nhất "closed"
    // Trong backtest, c15[idx15].time là bar CHỨA ts. Để mimic "closed-only", dùng idx15-1
    const idx15c = idx15 - 1; // closed 15m index
    const idx5c = i - 1; // closed 5m
    const idx1hc = idx1h - 1;
    const idx1dc = idx1d - 1;

    // === EvalClose first ===
    // Setup #11 per-trade
    const newS11: Setup11Trade[] = [];
    for (const t of setup11Trades) {
      if (mark >= t.tpPx) {
        const fee = t.qty * mark * FEE_PER_SIDE_PCT / 100;
        const pnl = (mark - t.entryPx) * t.qty;
        wallet += pnl - fee;
        if (wallet > hwm) hwm = wallet;
        // partial close from longNet (preserve avg)
        longNet = { qty: Math.max(0, longNet.qty - t.qty), avg: longNet.qty - t.qty > 0 ? longNet.avg : 0 };
        closes.push({ ts, iso: new Date(ts).toISOString(), side: "LONG", price: mark, qty: t.qty, avgEntry: t.entryPx, reason: "S11_TP", pnlGross: pnl, fee, setup11TradeId: t.id });
      } else if (mark <= t.slPx) {
        const fee = t.qty * mark * FEE_PER_SIDE_PCT / 100;
        const pnl = (mark - t.entryPx) * t.qty;
        wallet += pnl - fee;
        longNet = { qty: Math.max(0, longNet.qty - t.qty), avg: longNet.qty - t.qty > 0 ? longNet.avg : 0 };
        closes.push({ ts, iso: new Date(ts).toISOString(), side: "LONG", price: mark, qty: t.qty, avgEntry: t.entryPx, reason: "S11_SL", pnlGross: pnl, fee, setup11TradeId: t.id });
      } else {
        newS11.push(t);
      }
    }
    setup11Trades = newS11;

    // Aggregate TP / SL
    if (longNet.qty > 0 && longNet.avg > 0) {
      const gain = (mark - longNet.avg) / longNet.avg * 100;
      if (gain >= TP_PCT || gain <= -AGGREGATE_SL_PCT) {
        const fee = longNet.qty * mark * FEE_PER_SIDE_PCT / 100;
        const pnl = (mark - longNet.avg) * longNet.qty;
        wallet += pnl - fee;
        if (wallet > hwm) hwm = wallet;
        closes.push({ ts, iso: new Date(ts).toISOString(), side: "LONG", price: mark, qty: longNet.qty, avgEntry: longNet.avg, reason: gain >= TP_PCT ? "TP" : "SL", pnlGross: pnl, fee });
        longNet = { qty: 0, avg: 0 };
        // clear all setup11 trades (aggregate close all)
        setup11Trades = [];
      }
    }
    if (shortNet.qty > 0 && shortNet.avg > 0) {
      const drop = (shortNet.avg - mark) / shortNet.avg * 100;
      if (drop >= TP_PCT || drop <= -AGGREGATE_SL_PCT) {
        const fee = shortNet.qty * mark * FEE_PER_SIDE_PCT / 100;
        const pnl = (shortNet.avg - mark) * shortNet.qty;
        wallet += pnl - fee;
        if (wallet > hwm) hwm = wallet;
        closes.push({ ts, iso: new Date(ts).toISOString(), side: "SHORT", price: mark, qty: shortNet.qty, avgEntry: shortNet.avg, reason: drop >= TP_PCT ? "TP" : "SL", pnlGross: pnl, fee });
        shortNet = { qty: 0, avg: 0 };
      }
    }

    // === EvalEntry — chỉ khi bước sang 15m bar mới (closed-bar eval rate giống real engine) ===
    if (idx15c < 60 || idx15c <= last15IdxProcessed) continue;
    last15IdxProcessed = idx15c;

    // Halted check
    if (ts < haltedUntil) continue;

    // Regime detect on 1d closed
    const rawReg = detectRegime(c1d, idx1dc, ma200d, ma50d);
    const persisted = applyPersistence(rawReg, regime, regimeConsec, regimeLastRaw);
    regime = persisted.regime; regimeConsec = persisted.consec; regimeLastRaw = persisted.lastRaw;

    // HWM check
    const hwmScale = getHWMScale(hwm, wallet);
    if (hwmScale === 0) { haltedUntil = ts + 24 * 60 * 60_000; continue; }

    // ATR scale on 15m closed
    const atrScale = computeAtrScale(atr14_15[idx15c], mark);

    // Score on 15m closed
    const { longScore, shortScore } = computeScores(c15, idx15c, rsi15, stoch15, macdH15, ma50_15, ma20_15, sd20_15, atr14_15, volMA_15);

    // C2 + F4 cache (5m closed)
    const c2Fire = isC2Trend5m(c5, idx5c, rsi5);
    const f4Pass = c2Fire ? passF4Filter(rsi15, idx15c, rsi1h, idx1hc, c1d, idx1dc, ma50d) : false;

    // Cooldowns
    const longCD = ts - lastEntryLongMs < COOLDOWN_MS;
    const shortCD = ts - lastEntryShortMs < COOLDOWN_MS;
    const s11CD = ts - lastSetup11Ms < SETUP11_COOLDOWN_MS;

    // LONG aggregate
    if (!longCD) {
      let qty = 0;
      let setups: string[] = [];
      if (longScore >= 9) {
        qty += aggregateQty(longScore, "LONG");
        setups.push(`agg(${longScore})`);
        if (isDeepDip(c5, idx5c, ma200_5m, ma50_5m)) { qty += DEEPDIP_QTY_BOOST; setups.push("S9"); }
      }
      if (c2Fire && !f4Pass && allowMomentumLong(regime)) { qty += C2_QTY; setups.push("S10"); }
      qty *= scaleLongQty(regime) * hwmScale * atrScale;
      if (qty > 0 && qty < MIN_BINANCE_QTY) qty = MIN_BINANCE_QTY;
      // scheduler MAX_QTY check
      if (qty > 0 && longNet.qty + qty <= MAX_QTY_PER_SIDE) {
        const fee = qty * mark * FEE_PER_SIDE_PCT / 100;
        wallet -= fee;
        longNet = addNet(longNet, qty, mark);
        lastEntryLongMs = ts;
        entries.push({ ts, iso: new Date(ts).toISOString(), side: "LONG", price: mark, qty, setup: setups.join("+"), score: longScore, regime, atrScale, hwmScale });
      }
    }

    // Setup #11
    if (!s11CD && c2Fire && f4Pass && allowMomentumLong(regime)) {
      const scaledQty = SETUP11_QTY * hwmScale * atrScale;
      if (scaledQty >= MIN_BINANCE_QTY && longNet.qty + scaledQty <= MAX_QTY_PER_SIDE) {
        const tradeId = `s11_${ts}_${Math.floor(mark)}`;
        const tpPx = mark * (1 + SETUP11_TP_PCT / 100);
        const slPx = mark * (1 - SETUP11_SL_PCT / 100);
        const fee = scaledQty * mark * FEE_PER_SIDE_PCT / 100;
        wallet -= fee;
        longNet = addNet(longNet, scaledQty, mark);
        lastSetup11Ms = ts;
        setup11Trades.push({ id: tradeId, entryPx: mark, qty: scaledQty, tpPx, slPx });
        entries.push({ ts, iso: new Date(ts).toISOString(), side: "LONG", price: mark, qty: scaledQty, setup: "S11", score: longScore, regime, atrScale, hwmScale, setup11TradeId: tradeId });
      }
    }

    // SHORT
    if (shortScore >= 9 && !shortCD && allowShort(regime)) {
      let weeklyDown = false;
      if (idx1w >= 2) weeklyDown = c1w[idx1w - 1].close < c1w[idx1w - 2].close;
      if (weeklyDown) {
        let qty = aggregateQty(shortScore, "SHORT");
        qty *= hwmScale * atrScale;
        if (qty > 0 && qty < MIN_BINANCE_QTY) qty = MIN_BINANCE_QTY;
        if (qty > 0 && shortNet.qty + qty <= MAX_QTY_PER_SIDE) {
          const fee = qty * mark * FEE_PER_SIDE_PCT / 100;
          wallet -= fee;
          shortNet = addNet(shortNet, qty, mark);
          lastEntryShortMs = ts;
          entries.push({ ts, iso: new Date(ts).toISOString(), side: "SHORT", price: mark, qty, setup: `aggS(${shortScore})`, score: shortScore, regime, atrScale, hwmScale });
        }
      }
    }
  }

  // === Force close cuối kỳ ===
  const lastBar = c5[c5.length - 1];
  const lastMark = lastBar.close;
  if (longNet.qty > 0) {
    const pnl = (lastMark - longNet.avg) * longNet.qty;
    const fee = longNet.qty * lastMark * FEE_PER_SIDE_PCT / 100;
    wallet += pnl - fee;
    closes.push({ ts: lastBar.time, iso: new Date(lastBar.time).toISOString(), side: "LONG", price: lastMark, qty: longNet.qty, avgEntry: longNet.avg, reason: "TP", pnlGross: pnl, fee });
  }
  if (shortNet.qty > 0) {
    const pnl = (shortNet.avg - lastMark) * shortNet.qty;
    const fee = shortNet.qty * lastMark * FEE_PER_SIDE_PCT / 100;
    wallet += pnl - fee;
    closes.push({ ts: lastBar.time, iso: new Date(lastBar.time).toISOString(), side: "SHORT", price: lastMark, qty: shortNet.qty, avgEntry: shortNet.avg, reason: "TP", pnlGross: pnl, fee });
  }

  // === Stats ===
  const roi = (wallet - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100;
  const totalFees = closes.reduce((s, e) => s + e.fee, 0) + entries.reduce((s, e) => s + e.qty * e.price * FEE_PER_SIDE_PCT / 100, 0);
  const wins = closes.filter(c => c.pnlGross > 0).length;
  const losses = closes.filter(c => c.pnlGross < 0).length;
  const wr = closes.length > 0 ? wins / closes.length * 100 : 0;
  const maxDD = (hwm - Math.min(...[wallet, ...closes.map((_c, i) => INITIAL_CAPITAL + closes.slice(0, i + 1).reduce((s, e) => s + e.pnlGross - e.fee, 0))])) / hwm * 100;

  // Per-setup count
  const setupCounts: Record<string, number> = {};
  for (const e of entries) {
    setupCounts[e.setup] = (setupCounts[e.setup] ?? 0) + 1;
  }

  // Per-regime entries
  const regimeCounts: Record<string, number> = { BULL: 0, RANGE: 0, BEAR: 0 };
  for (const e of entries) regimeCounts[e.regime]++;

  // Per-year
  const byYear: Record<string, { entries: number; closes: number; pnl: number }> = {};
  for (const e of entries) {
    const y = e.iso.slice(0, 4);
    byYear[y] = byYear[y] ?? { entries: 0, closes: 0, pnl: 0 };
    byYear[y].entries++;
  }
  for (const c of closes) {
    const y = c.iso.slice(0, 4);
    byYear[y] = byYear[y] ?? { entries: 0, closes: 0, pnl: 0 };
    byYear[y].closes++;
    byYear[y].pnl += c.pnlGross - c.fee;
  }

  const summary = {
    version: "v0.4.32",
    period: `${c5[0].time} → ${c5[c5.length - 1].time}`,
    periodISO: `${new Date(c5[0].time).toISOString()} → ${new Date(c5[c5.length - 1].time).toISOString()}`,
    bars5m: c5.length,
    initialCapital: INITIAL_CAPITAL,
    finalWallet: Math.round(wallet * 100) / 100,
    hwm: Math.round(hwm * 100) / 100,
    roiPct: Math.round(roi * 100) / 100,
    maxDDPct: Math.round(maxDD * 100) / 100,
    totalEntries: entries.length,
    totalCloses: closes.length,
    wins, losses, winRatePct: Math.round(wr * 100) / 100,
    totalFeesUsd: Math.round(totalFees * 100) / 100,
    setupBreakdown: setupCounts,
    regimeBreakdown: regimeCounts,
    byYear,
    avgWin: closes.filter(c => c.pnlGross > 0).reduce((s, c) => s + c.pnlGross, 0) / Math.max(1, wins),
    avgLoss: closes.filter(c => c.pnlGross < 0).reduce((s, c) => s + c.pnlGross, 0) / Math.max(1, losses),
  };

  console.log("\n=== SUMMARY hedge01 v0.4.32 — 3y backtest ===");
  console.log(JSON.stringify(summary, null, 2));

  const outDir = join(__dirname, "..", "assets");
  writeFileSync(join(outDir, "backtest_h01_v0432_3y_summary.json"), JSON.stringify(summary, null, 2));
  // CSV entries (compact)
  const entCsv = ["ts,iso,side,price,qty,setup,score,regime,atrScale,hwmScale,setup11TradeId"];
  for (const e of entries) entCsv.push(`${e.ts},${e.iso},${e.side},${e.price},${e.qty.toFixed(6)},${e.setup},${e.score},${e.regime},${e.atrScale.toFixed(3)},${e.hwmScale.toFixed(3)},${e.setup11TradeId ?? ""}`);
  writeFileSync(join(outDir, "backtest_h01_v0432_3y_entries.csv"), entCsv.join("\n"));
  // CSV closes
  const clsCsv = ["ts,iso,side,price,qty,avgEntry,reason,pnlGross,fee,setup11TradeId"];
  for (const c of closes) clsCsv.push(`${c.ts},${c.iso},${c.side},${c.price},${c.qty.toFixed(6)},${c.avgEntry.toFixed(2)},${c.reason},${c.pnlGross.toFixed(2)},${c.fee.toFixed(2)},${c.setup11TradeId ?? ""}`);
  writeFileSync(join(outDir, "backtest_h01_v0432_3y_closes.csv"), clsCsv.join("\n"));
  console.log(`\nOutputs written to assets/`);
}

main();
