/**
 * backtest-intraday-setups-7y.ts — Test 3 intra-day setups standalone + combined với v0.4.40 trend.
 *
 * Setups:
 *   #18 Intra-day 1h breakout: close > 6-bar prior high + vol > 1.5× MA(20)
 *   #19 Asian Session ORB: break Asian session (00-08 UTC) range in EU/US session
 *   #20 Hourly momentum: 3 consecutive 1h same-direction + RSI > 60 / < 40
 *
 * Each tested:
 *   - Standalone 7y full
 *   - Walk-forward train 2019-22 / test 2023-26
 *   - Combined với trend (v0.4.40 baseline) for regression check
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const INITIAL_CAPITAL = 100_000;
const FEE_PCT = 0.05;
const MIN_BINANCE_QTY = 0.001;
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

// === Setup #18 Intra-day 1h breakout ===
const S18_QTY = 0.005;
const S18_LOOKBACK_HOURS = 6;
const S18_VOL_RATIO = 1.5;
const S18_TP_PCT = 1.5;
const S18_SL_PCT = 1.0;
const S18_COOLDOWN_MS = 60 * 60_000;
const S18_TIMESTOP_MS = 4 * 60 * 60_000;

// === Setup #19 Asian-Session ORB ===
const S19_QTY = 0.005;
const S19_ASIAN_START_HOUR = 0;
const S19_ASIAN_END_HOUR = 8;
const S19_ENTRY_END_HOUR = 20;
const S19_TP_RANGE_MULT = 1.5;
const S19_SL_RANGE_MULT = 0.5;

// === Setup #20 Hourly momentum ===
const S20_QTY = 0.005;
const S20_CONSEC_BARS = 3;
const S20_RSI_HIGH = 60;
const S20_RSI_LOW = 40;
const S20_TP_PCT = 2.0;
const S20_SL_PCT = 1.5;
const S20_COOLDOWN_MS = 60 * 60_000;
const S20_TIMESTOP_MS = 6 * 60 * 60_000;

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }
type Regime = "BULL" | "RANGE" | "BEAR";

interface ScenarioConfig {
  name: string;
  enableTrend: boolean;
  enableS18: boolean;
  enableS19: boolean;
  enableS20: boolean;
}

const SCENARIOS: ScenarioConfig[] = [
  { name: "v0440_trend_only",           enableTrend: true,  enableS18: false, enableS19: false, enableS20: false },
  { name: "S18_only",                   enableTrend: false, enableS18: true,  enableS19: false, enableS20: false },
  { name: "S19_only",                   enableTrend: false, enableS18: false, enableS19: true,  enableS20: false },
  { name: "S20_only",                   enableTrend: false, enableS18: false, enableS19: false, enableS20: true },
  { name: "trend+S18",                  enableTrend: true,  enableS18: true,  enableS19: false, enableS20: false },
  { name: "trend+S19",                  enableTrend: true,  enableS18: false, enableS19: true,  enableS20: false },
  { name: "trend+S20",                  enableTrend: true,  enableS18: false, enableS19: false, enableS20: true },
  { name: "trend+ALL_intraday",         enableTrend: true,  enableS18: true,  enableS19: true,  enableS20: true },
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

interface SimpleTrade { id: string; kind: string; side: "LONG" | "SHORT"; entryPx: number; qty: number; tpPx: number; slPx: number; expireTs: number; }
interface TrendTrade { id: string; kind: string; side: "LONG" | "SHORT"; entryPx: number; qty: number; hwm: number; lwm: number; slPx: number; atrEntry: number; }

function runBacktest(c5: Candle[], c1h: Candle[], c4h: Candle[], c1d: Candle[], ind: any, cfg: ScenarioConfig, startIdx: number, endIdx: number): any {
  let wallet = INITIAL_CAPITAL, hwm = INITIAL_CAPITAL;
  let trendLongNet = { qty: 0, avg: 0 }, trendShortNet = { qty: 0, avg: 0 };
  let s18LongNet = { qty: 0, avg: 0 }, s18ShortNet = { qty: 0, avg: 0 };
  let s19LongNet = { qty: 0, avg: 0 }, s19ShortNet = { qty: 0, avg: 0 };
  let s20LongNet = { qty: 0, avg: 0 }, s20ShortNet = { qty: 0, avg: 0 };
  let trendTrades: TrendTrade[] = [];
  let s18Trades: SimpleTrade[] = [];
  let s19Trades: SimpleTrade[] = [];
  let s20Trades: SimpleTrade[] = [];
  let lastS12L = 0, lastS12S = 0, lastS13L = 0, lastS13S = 0, lastS14L = 0, lastS14S = 0;
  let lastS18LMs = 0, lastS18SMs = 0;
  let lastS19LMs = 0, lastS19SMs = 0;  // 1 per day per side
  let lastS20LMs = 0, lastS20SMs = 0;
  let regime: Regime = "RANGE", regimeConsec = 0, regimeLastRaw: Regime = "RANGE";
  let entries = 0, closes = 0, wins = 0, losses = 0, sumWin = 0, sumLoss = 0;
  let lowestWallet = INITIAL_CAPITAL, totalFees = 0;
  const setupCounts: Record<string, number> = {};
  const byYear: Record<string, { entries: number; closes: number; pnl: number }> = {};
  let idx1h = 0, idx1d = 0, idx4h = 0;
  let lastS18Hour = -1;
  let lastS19Day = -1;  // day-of-year tracking
  let lastS20Hour = -1;

  // Cached Asian ranges per day
  const asianRangeByDay: Map<string, { hi: number; lo: number }> = new Map();
  // Build Asian ranges from c1h
  for (const b of c1h) {
    const d = new Date(b.time);
    const hour = d.getUTCHours();
    if (hour < S19_ASIAN_START_HOUR || hour >= S19_ASIAN_END_HOUR) continue;
    const dayKey = d.toISOString().slice(0, 10);
    const cur = asianRangeByDay.get(dayKey);
    if (!cur) asianRangeByDay.set(dayKey, { hi: b.high, lo: b.low });
    else { if (b.high > cur.hi) cur.hi = b.high; if (b.low < cur.lo) cur.lo = b.low; }
  }

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

    // Close simple trades (S18/S19/S20)
    const closeSimples = (trades: SimpleTrade[], longNet: { qty: number; avg: number }, shortNet: { qty: number; avg: number }, setLong: (n: any) => void, setShort: (n: any) => void): SimpleTrade[] => {
      const newSim: SimpleTrade[] = [];
      for (const t of trades) {
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
          const net = t.side === "LONG" ? longNet : shortNet;
          const rq = Math.max(0, net.qty - t.qty);
          const newNet = { qty: rq, avg: rq > 0 ? net.avg : 0 };
          if (t.side === "LONG") setLong(newNet); else setShort(newNet);
        } else newSim.push(t);
      }
      return newSim;
    };
    s18Trades = closeSimples(s18Trades, s18LongNet, s18ShortNet, (n) => s18LongNet = n, (n) => s18ShortNet = n);
    s19Trades = closeSimples(s19Trades, s19LongNet, s19ShortNet, (n) => s19LongNet = n, (n) => s19ShortNet = n);
    s20Trades = closeSimples(s20Trades, s20LongNet, s20ShortNet, (n) => s20LongNet = n, (n) => s20ShortNet = n);

    if (i < startIdx + 60) continue;
    idx1h = findIdx(c1h, ts, idx1h); idx1d = findIdx(c1d, ts, idx1d); idx4h = findIdx(c4h, ts, idx4h);
    const idx1hc = idx1h - 1; const idx1dc = idx1d - 1; const idx4hc = idx4h - 1;

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

    // === Trend setups (S12/S13/S14) ===
    if (cfg.enableTrend) {
      let ema12: "LONG" | "SHORT" | null = null;
      let atr13: "LONG" | "SHORT" | null = null;
      let don14: "LONG" | "SHORT" | null = null;
      let atrVal4h: number | null = null;
      if (idx4hc >= EMA_SLOW + 1) {
        const fp = ind.ema50_4h[idx4hc - 1], sp = ind.ema200_4h[idx4hc - 1];
        const fc = ind.ema50_4h[idx4hc], sc = ind.ema200_4h[idx4hc];
        if (fp !== null && sp !== null && fc !== null && sc !== null) {
          if (fp <= sp && fc > sc) ema12 = "LONG";
          else if (fp >= sp && fc < sc) ema12 = "SHORT";
        }
        atrVal4h = ind.atr14_4h[idx4hc];
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

    // === Setup #18 1h breakout ===
    if (cfg.enableS18 && idx1hc >= S18_LOOKBACK_HOURS && idx1hc !== lastS18Hour) {
      lastS18Hour = idx1hc;
      // Compute prior 6-hour high/low (exclusive current hour)
      let hi = -Infinity, lo = Infinity;
      for (let j = idx1hc - S18_LOOKBACK_HOURS; j < idx1hc; j++) {
        if (c1h[j].high > hi) hi = c1h[j].high;
        if (c1h[j].low < lo) lo = c1h[j].low;
      }
      const lastH = c1h[idx1hc];
      // Vol check
      let volSum = 0; let n = 0;
      for (let j = Math.max(0, idx1hc - 20); j < idx1hc; j++) { volSum += c1h[j].volume ?? 0; n++; }
      const volMA = n > 0 ? volSum / n : 0;
      const volOk = volMA > 0 && (lastH.volume ?? 0) >= volMA * S18_VOL_RATIO;
      let s18Side: "LONG" | "SHORT" | null = null;
      if (lastH.close > hi && volOk && allowLong && ts - lastS18LMs >= S18_COOLDOWN_MS) s18Side = "LONG";
      else if (lastH.close < lo && volOk && allowShort && ts - lastS18SMs >= S18_COOLDOWN_MS) s18Side = "SHORT";
      if (s18Side) {
        const qty = S18_QTY;
        const fee = qty * mark * FEE_PCT / 100;
        wallet -= fee; totalFees += fee;
        const net = s18Side === "LONG" ? s18LongNet : s18ShortNet;
        const nq = net.qty + qty;
        const newNet = { qty: nq, avg: (net.qty * net.avg + qty * mark) / nq };
        if (s18Side === "LONG") s18LongNet = newNet; else s18ShortNet = newNet;
        s18Trades.push({
          id: `s18_${ts}`, kind: "S18", side: s18Side, entryPx: mark, qty,
          tpPx: s18Side === "LONG" ? mark * (1 + S18_TP_PCT / 100) : mark * (1 - S18_TP_PCT / 100),
          slPx: s18Side === "LONG" ? mark * (1 - S18_SL_PCT / 100) : mark * (1 + S18_SL_PCT / 100),
          expireTs: ts + S18_TIMESTOP_MS,
        });
        if (s18Side === "LONG") lastS18LMs = ts; else lastS18SMs = ts;
        entries++;
        setupCounts[`S18${s18Side[0]}`] = (setupCounts[`S18${s18Side[0]}`] ?? 0) + 1;
        const y = new Date(ts).toISOString().slice(0, 4);
        byYear[y] = byYear[y] ?? { entries: 0, closes: 0, pnl: 0 }; byYear[y].entries++;
      }
    }

    // === Setup #19 Asian Session ORB ===
    if (cfg.enableS19) {
      const d = new Date(ts);
      const hour = d.getUTCHours();
      const dayKey = d.toISOString().slice(0, 10);
      const dayOfYear = Math.floor(ts / 86400_000);
      // Entry window: 08-20 UTC, 1 entry per day
      if (hour >= S19_ASIAN_END_HOUR && hour < S19_ENTRY_END_HOUR && dayOfYear !== lastS19Day) {
        const asian = asianRangeByDay.get(dayKey);
        if (asian) {
          const range = asian.hi - asian.lo;
          if (range > 0) {
            let s19Side: "LONG" | "SHORT" | null = null;
            if (mark > asian.hi && allowLong) s19Side = "LONG";
            else if (mark < asian.lo && allowShort) s19Side = "SHORT";
            if (s19Side) {
              const qty = S19_QTY;
              const fee = qty * mark * FEE_PCT / 100;
              wallet -= fee; totalFees += fee;
              const net = s19Side === "LONG" ? s19LongNet : s19ShortNet;
              const nq = net.qty + qty;
              const newNet = { qty: nq, avg: (net.qty * net.avg + qty * mark) / nq };
              if (s19Side === "LONG") s19LongNet = newNet; else s19ShortNet = newNet;
              const tpPx = s19Side === "LONG" ? mark + range * S19_TP_RANGE_MULT : mark - range * S19_TP_RANGE_MULT;
              const slPx = s19Side === "LONG" ? mark - range * S19_SL_RANGE_MULT : mark + range * S19_SL_RANGE_MULT;
              // Expire end of UTC day (next midnight UTC)
              const endOfDay = Math.floor(ts / 86400_000) * 86400_000 + 86400_000;
              s19Trades.push({ id: `s19_${ts}`, kind: "S19", side: s19Side, entryPx: mark, qty, tpPx, slPx, expireTs: endOfDay });
              lastS19Day = dayOfYear;
              entries++;
              setupCounts[`S19${s19Side[0]}`] = (setupCounts[`S19${s19Side[0]}`] ?? 0) + 1;
              const y = new Date(ts).toISOString().slice(0, 4);
              byYear[y] = byYear[y] ?? { entries: 0, closes: 0, pnl: 0 }; byYear[y].entries++;
            }
          }
        }
      }
    }

    // === Setup #20 Hourly Momentum ===
    if (cfg.enableS20 && idx1hc >= S20_CONSEC_BARS && idx1hc !== lastS20Hour) {
      lastS20Hour = idx1hc;
      const r1h = ind.rsi1h[idx1hc];
      if (r1h !== null) {
        // Check 3 consecutive 1h bars same direction
        let allUp = true, allDown = true;
        for (let j = idx1hc - S20_CONSEC_BARS + 1; j <= idx1hc; j++) {
          if (c1h[j].close <= c1h[j].open) allUp = false;
          if (c1h[j].close >= c1h[j].open) allDown = false;
        }
        let s20Side: "LONG" | "SHORT" | null = null;
        if (allUp && r1h >= S20_RSI_HIGH && allowLong && ts - lastS20LMs >= S20_COOLDOWN_MS) s20Side = "LONG";
        else if (allDown && r1h <= S20_RSI_LOW && allowShort && ts - lastS20SMs >= S20_COOLDOWN_MS) s20Side = "SHORT";
        if (s20Side) {
          const qty = S20_QTY;
          const fee = qty * mark * FEE_PCT / 100;
          wallet -= fee; totalFees += fee;
          const net = s20Side === "LONG" ? s20LongNet : s20ShortNet;
          const nq = net.qty + qty;
          const newNet = { qty: nq, avg: (net.qty * net.avg + qty * mark) / nq };
          if (s20Side === "LONG") s20LongNet = newNet; else s20ShortNet = newNet;
          s20Trades.push({
            id: `s20_${ts}`, kind: "S20", side: s20Side, entryPx: mark, qty,
            tpPx: s20Side === "LONG" ? mark * (1 + S20_TP_PCT / 100) : mark * (1 - S20_TP_PCT / 100),
            slPx: s20Side === "LONG" ? mark * (1 - S20_SL_PCT / 100) : mark * (1 + S20_SL_PCT / 100),
            expireTs: ts + S20_TIMESTOP_MS,
          });
          if (s20Side === "LONG") lastS20LMs = ts; else lastS20SMs = ts;
          entries++;
          setupCounts[`S20${s20Side[0]}`] = (setupCounts[`S20${s20Side[0]}`] ?? 0) + 1;
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
  closeAll("LONG", s18LongNet); closeAll("SHORT", s18ShortNet);
  closeAll("LONG", s19LongNet); closeAll("SHORT", s19ShortNet);
  closeAll("LONG", s20LongNet); closeAll("SHORT", s20ShortNet);

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
  console.log("[intraday-7y] Loading...");
  const c5 = loadCache("binance-5m-7y.json");
  const c1h = aggregateBars(c5, 60);
  const c4h = aggregateBars(c5, 240);
  const c1d = aggregateBars(c5, 1440);
  console.log(`  5m=${c5.length}, 1h=${c1h.length}, 4h=${c4h.length}, 1d=${c1d.length}`);

  console.log("[intraday-7y] Pre-computing indicators...");
  const ind = {
    rsi1h: calcRSI(c1h.map(b => b.close), 14),
    ma200d: calcSMA(c1d.map(b => b.close), 200), ma50d: calcSMA(c1d.map(b => b.close), 50),
    ema50_4h: calcEMA(c4h.map(b => b.close), EMA_FAST),
    ema200_4h: calcEMA(c4h.map(b => b.close), EMA_SLOW),
    atr14_4h: calcATR(c4h, 14),
  };

  const splitTs = new Date("2023-01-01T00:00:00Z").getTime();
  const splitIdx = c5.findIndex(b => b.time >= splitTs);
  console.log(`  Split idx ${splitIdx} → train < ${new Date(splitTs).toISOString()}, test ≥`);

  const results: any[] = [];
  for (const cfg of SCENARIOS) {
    console.log(`\n[scenario] ${cfg.name}`);
    const rFull = runBacktest(c5, c1h, c4h, c1d, ind, cfg, 0, c5.length);
    const rTrain = runBacktest(c5, c1h, c4h, c1d, ind, cfg, 0, splitIdx);
    const rTest = runBacktest(c5, c1h, c4h, c1d, ind, cfg, splitIdx, c5.length);
    const stab = Object.values(rFull.byYear).filter((v: any) => v.pnl > 0).length;
    const total = Object.keys(rFull.byYear).length;
    console.log(`  Full 7y: ROI ${rFull.roi}% / DD ${rFull.maxDD}% / RA ${rFull.ra} / ${rFull.entries}E ${rFull.closes}C ${stab}/${total}`);
    console.log(`  Train 2019-22: ROI ${rTrain.roi}% / RA ${rTrain.ra} / ${rTrain.entries}E`);
    console.log(`  Test 2023-26:  ROI ${rTest.roi}% / RA ${rTest.ra} / ${rTest.entries}E`);
    results.push({ scenario: cfg.name, full: rFull, train: rTrain, test: rTest, stab: `${stab}/${total}` });
  }

  console.log("\n=== INTRADAY SETUPS COMPARISON 7y ===");
  console.log("Scenario                  | Full ROI% | Full RA | Stab | Train ROI% | Train RA | Test ROI% | Test RA | Entries");
  console.log("-".repeat(125));
  for (const r of results) {
    console.log(`${r.scenario.padEnd(25)} | ${String(r.full.roi).padStart(9)} | ${String(r.full.ra).padStart(7)} | ${r.stab.padStart(4)} | ${String(r.train.roi).padStart(10)} | ${String(r.train.ra).padStart(8)} | ${String(r.test.roi).padStart(9)} | ${String(r.test.ra).padStart(7)} | ${String(r.full.entries).padStart(7)}`);
  }

  console.log("\n=== PER-SETUP FIRE COUNT (best variant: trend+ALL_intraday) ===");
  const best = results.find(r => r.scenario === "trend+ALL_intraday");
  if (best) {
    for (const [sig, count] of Object.entries(best.full.setupCounts)) {
      console.log(`  ${sig.padEnd(15)}: ${count}`);
    }
  }

  writeFileSync(join(__dirname, "..", "assets", "backtest_intraday_setups_7y.json"), JSON.stringify(results, null, 2));
  console.log(`\nWritten assets/backtest_intraday_setups_7y.json`);
}

main();
