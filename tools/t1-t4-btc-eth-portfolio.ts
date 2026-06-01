/**
 * t1-t4-btc-eth-portfolio.ts — Deep test BTC + ETH portfolio (4 tests).
 *
 * T1: Portfolio 60/40 với ETH E1 (drop S12) — verify ROI / RA exact với proper config
 * T2: Walk-forward (train 2023-24 / test 2025-26) — portfolio robust out-of-sample?
 * T3: Stress test worst months — find joint failure periods
 * T4: Rolling 30d correlation — when does diversification break?
 *
 * Uses fresh backtest BTC v0.4.46 + ETH E1 với normalized notional $385/entry.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const INITIAL_CAPITAL = 100_000;
const FEE_PCT = 0.05;
const EMA_FAST = 50, EMA_SLOW = 200;
const ATR_BREAKOUT_MULT = 1.5;
const DONCHIAN_LOOKBACK = 20;
const REGIME_PERSIST_BARS = 3;
const ADX_THRESHOLD = 20;
const ADX_PERIOD = 14;
const ATR_PCT_PERCENTILE = 0.30;
const VOL_MA_PERIOD = 10;
const VOL_MULT = 1.2;
const SL_INITIAL = 4, SL_TRAILING = 3;
const SL_TRANSITION_MS = 48 * 60 * 60_000;
const NOTIONAL_PER_ENTRY = 385;
const MAX_NOTIONAL_PER_SIDE = 1540;
const SETUP12_MULT = 1.0, SETUP13_MULT = 0.6, SETUP14_MULT = 1.0;
const SETUP12_COOLDOWN_MS = 12 * 60 * 60_000;
const SETUP13_COOLDOWN_MS = 4 * 60 * 60_000;
const SETUP14_COOLDOWN_MS = 12 * 60 * 60_000;

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }
type Regime = "BULL" | "RANGE" | "BEAR";

function loadCache(name: string): Candle[] { return JSON.parse(readFileSync(join(__dirname, "..", ".cache", name), "utf8")); }
function aggregateBars(c5: Candle[], minutes: number): Candle[] { const targetMs = minutes * 60_000; const out: Candle[] = []; let cur: { bucket: number; bars: Candle[] } | null = null; for (const b of c5) { const bucket = Math.floor(b.time / targetMs) * targetMs; if (!cur || cur.bucket !== bucket) { if (cur && cur.bars.length > 0) { const bars = cur.bars; let hi = -Infinity, lo = Infinity, vol = 0; for (const x of bars) { if (x.high > hi) hi = x.high; if (x.low < lo) lo = x.low; vol += x.volume ?? 0; } out.push({ time: cur.bucket, open: bars[0].open, high: hi, low: lo, close: bars[bars.length - 1].close, volume: vol }); } cur = { bucket, bars: [b] }; } else cur.bars.push(b); } if (cur && cur.bars.length > 0) { const bars = cur.bars; let hi = -Infinity, lo = Infinity, vol = 0; for (const x of bars) { if (x.high > hi) hi = x.high; if (x.low < lo) lo = x.low; vol += x.volume ?? 0; } out.push({ time: cur.bucket, open: bars[0].open, high: hi, low: lo, close: bars[bars.length - 1].close, volume: vol }); } return out; }
function calcSMA(a: number[], p: number): (number | null)[] { const o: (number | null)[] = new Array(a.length).fill(null); if (a.length < p) return o; let s = 0; for (let i = 0; i < p; i++) s += a[i]; o[p - 1] = s / p; for (let i = p; i < a.length; i++) { s += a[i] - a[i - p]; o[i] = s / p; } return o; }
function calcEMA(a: number[], p: number): (number | null)[] { const o: (number | null)[] = new Array(a.length).fill(null); if (a.length < p) return o; const k = 2 / (p + 1); let e = 0; for (let i = 0; i < p; i++) e += a[i]; e /= p; o[p - 1] = e; for (let i = p; i < a.length; i++) { e = a[i] * k + e * (1 - k); o[i] = e; } return o; }
function calcATR(c: Candle[], p: number): (number | null)[] { const o: (number | null)[] = new Array(c.length).fill(null); if (c.length <= p) return o; const tr: number[] = new Array(c.length).fill(0); for (let i = 1; i < c.length; i++) tr[i] = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close)); let s = 0; for (let i = 1; i <= p; i++) s += tr[i]; o[p] = s / p; for (let i = p + 1; i < c.length; i++) o[i] = (o[i - 1]! * (p - 1) + tr[i]) / p; return o; }
function calcADXFull(c: Candle[], p: number = 14): { adx: (number | null)[] } { const adxOut: (number | null)[] = new Array(c.length).fill(null); if (c.length <= p + 1) return { adx: adxOut }; const plusDM: number[] = new Array(c.length).fill(0); const minusDM: number[] = new Array(c.length).fill(0); const tr: number[] = new Array(c.length).fill(0); for (let i = 1; i < c.length; i++) { const up = c[i].high - c[i - 1].high; const dn = c[i - 1].low - c[i].low; plusDM[i] = up > dn && up > 0 ? up : 0; minusDM[i] = dn > up && dn > 0 ? dn : 0; tr[i] = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close)); } let smTR = 0, smPlusDM = 0, smMinusDM = 0; for (let i = 1; i <= p; i++) { smTR += tr[i]; smPlusDM += plusDM[i]; smMinusDM += minusDM[i]; } const dxArr: number[] = []; for (let i = p + 1; i < c.length; i++) { smTR = smTR - smTR / p + tr[i]; smPlusDM = smPlusDM - smPlusDM / p + plusDM[i]; smMinusDM = smMinusDM - smMinusDM / p + minusDM[i]; const plusDI = smTR > 0 ? smPlusDM / smTR * 100 : 0; const minusDI = smTR > 0 ? smMinusDM / smTR * 100 : 0; const dx = (plusDI + minusDI) > 0 ? Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100 : 0; dxArr.push(dx); if (dxArr.length >= p) { let adx = 0; for (let j = dxArr.length - p; j < dxArr.length; j++) adx += dxArr[j]; adxOut[i] = adx / p; } } return { adx: adxOut }; }
function findIdx(arr: { time: number }[], ts: number, hint: number = 0): number { let lo = hint, hi = arr.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (arr[mid].time <= ts) lo = mid; else hi = mid - 1; } return lo; }

interface TrendTrade { id: string; kind: string; side: "LONG" | "SHORT"; entryPx: number; qty: number; notional: number; hwm: number; lwm: number; slPx: number; atrEntry: number; entryTs: number; }

function runWithMonthly(symbol: string, c5: Candle[], dropS12: boolean): { monthly: Record<string, number>; meta: any } {
  const startTs = new Date("2023-05-25T00:00:00Z").getTime();
  const warmupTs = startTs - 60 * 86_400_000;
  const filtered = c5.filter(b => b.time >= warmupTs);
  const startIdx = filtered.findIndex(b => b.time >= startTs);
  const c1h = aggregateBars(filtered, 60);
  const c4h = aggregateBars(filtered, 240);
  const c1d = aggregateBars(filtered, 1440);
  const adxObj = calcADXFull(c4h, ADX_PERIOD);
  const ind = {
    ma200d: calcSMA(c1d.map(b => b.close), 200), ma50d: calcSMA(c1d.map(b => b.close), 50),
    ema50_4h: calcEMA(c4h.map(b => b.close), EMA_FAST),
    ema200_4h: calcEMA(c4h.map(b => b.close), EMA_SLOW),
    ema200_1h: calcEMA(c1h.map(b => b.close), 200),
    atr14_4h: calcATR(c4h, 14),
    adx14_4h: adxObj.adx,
  };
  const vol4hMA: (number | null)[] = new Array(c4h.length).fill(null);
  for (let i = VOL_MA_PERIOD - 1; i < c4h.length; i++) {
    let s = 0;
    for (let j = i - VOL_MA_PERIOD + 1; j <= i; j++) s += c4h[j].volume ?? 0;
    vol4hMA[i] = s / VOL_MA_PERIOD;
  }
  let wallet = INITIAL_CAPITAL;
  let trendLongNotional = 0, trendShortNotional = 0;
  let trendTrades: TrendTrade[] = [];
  let lastS12L = 0, lastS12S = 0, lastS13L = 0, lastS13S = 0, lastS14L = 0, lastS14S = 0;
  let regime: Regime = "RANGE", regimeConsec = 0, regimeLastRaw: Regime = "RANGE";
  const monthlyPnL: Record<string, number> = {};
  let idx1h = 0, idx4h = 0, idx1d = 0;
  let last4hIdx = -1;
  let entries = 0, closes = 0, wins = 0;
  for (let i = startIdx; i < filtered.length; i++) {
    const bar = filtered[i]; const ts = bar.time; const mark = bar.close;
    const newTrend: TrendTrade[] = [];
    for (const t of trendTrades) {
      const heldMs = ts - t.entryTs;
      const slMult = heldMs < SL_TRANSITION_MS ? SL_INITIAL : SL_TRAILING;
      if (t.side === "LONG") { if (mark > t.hwm) { t.hwm = mark; t.slPx = t.hwm - t.atrEntry * slMult; } else if (heldMs >= SL_TRANSITION_MS) { const tgt = t.hwm - t.atrEntry * SL_TRAILING; if (tgt > t.slPx) t.slPx = tgt; } } else { if (mark < t.lwm) { t.lwm = mark; t.slPx = t.lwm + t.atrEntry * slMult; } else if (heldMs >= SL_TRANSITION_MS) { const tgt = t.lwm + t.atrEntry * SL_TRAILING; if (tgt < t.slPx) t.slPx = tgt; } }
      let exit = false;
      if (t.side === "LONG" && mark <= t.slPx) exit = true;
      if (t.side === "SHORT" && mark >= t.slPx) exit = true;
      if (exit) {
        const fee = t.qty * mark * FEE_PCT / 100;
        const pnl = (t.side === "LONG" ? mark - t.entryPx : t.entryPx - mark) * t.qty;
        const net = pnl - fee;
        wallet += net;
        closes++; if (pnl > 0) wins++;
        const m = new Date(ts).toISOString().slice(0, 7);
        monthlyPnL[m] = (monthlyPnL[m] ?? 0) + net;
        if (t.side === "LONG") trendLongNotional = Math.max(0, trendLongNotional - t.notional);
        else trendShortNotional = Math.max(0, trendShortNotional - t.notional);
      } else newTrend.push(t);
    }
    trendTrades = newTrend;
    if (i < startIdx + 60) continue;
    idx1h = findIdx(c1h, ts, idx1h); idx4h = findIdx(c4h, ts, idx4h); idx1d = findIdx(c1d, ts, idx1d);
    const idx4hc = idx4h - 1; const idx1hc = idx1h - 1; const idx1dc = idx1d - 1;
    if (idx4hc < EMA_SLOW + 1 || idx4hc === last4hIdx) continue;
    last4hIdx = idx4hc;
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
    else if (rawReg === regimeLastRaw) { regimeConsec++; if (regimeConsec >= REGIME_PERSIST_BARS) { regime = rawReg; regimeConsec = 1; } }
    else regimeConsec = 1;
    regimeLastRaw = rawReg;
    const allowLong = regime !== "BEAR";
    const allowShort = regime !== "BULL";
    const adxVal4h = ind.adx14_4h[idx4hc];
    const adxPrev4h = ind.adx14_4h[idx4hc - 1];
    const adxPass = adxVal4h !== null && adxVal4h > ADX_THRESHOLD && adxPrev4h !== null && adxPrev4h > ADX_THRESHOLD;
    let emaLong = true, emaShort = true;
    if (idx1hc >= 200) {
      const e = ind.ema200_1h[idx1hc];
      if (e === null) { emaLong = false; emaShort = false; }
      else { if (c1h[idx1hc].close < e) emaLong = false; if (c1h[idx1hc].close > e) emaShort = false; }
    } else { emaLong = false; emaShort = false; }
    let atrGatePass = true;
    if (idx4hc >= 90) {
      const cur4hATR = ind.atr14_4h[idx4hc]; const cur4hClose = c4h[idx4hc].close;
      if (cur4hATR === null) atrGatePass = false;
      else {
        const curPct = cur4hATR / cur4hClose * 100;
        const arr: number[] = [];
        for (let j = idx4hc - 89; j <= idx4hc; j++) { const a = ind.atr14_4h[j]; if (a !== null) arr.push(a / c4h[j].close * 100); }
        arr.sort((a, b) => a - b);
        const pX = arr[Math.floor(arr.length * ATR_PCT_PERCENTILE)];
        atrGatePass = curPct >= pX;
      }
    }
    const vol4hPass = (() => { const ma = vol4hMA[idx4hc]; const vol = c4h[idx4hc].volume ?? 0; return ma !== null && ma > 0 && vol >= ma * VOL_MULT; })();
    let filterLong = allowLong, filterShort = allowShort;
    if (!adxPass || !atrGatePass) { filterLong = false; filterShort = false; }
    if (!emaLong) filterLong = false;
    if (!emaShort) filterShort = false;
    let ema12: "LONG" | "SHORT" | null = null;
    let atr13: "LONG" | "SHORT" | null = null;
    let don14: "LONG" | "SHORT" | null = null;
    const atrVal4h = ind.atr14_4h[idx4hc];
    const fp = ind.ema50_4h[idx4hc - 1], sp = ind.ema200_4h[idx4hc - 1];
    const fc = ind.ema50_4h[idx4hc], sc = ind.ema200_4h[idx4hc];
    if (fp !== null && sp !== null && fc !== null && sc !== null) { if (fp <= sp && fc > sc) ema12 = "LONG"; else if (fp >= sp && fc < sc) ema12 = "SHORT"; }
    if (atrVal4h !== null && atrVal4h > 0 && idx4hc >= 1) {
      const prev4h = c4h[idx4hc - 1]; const last4h = c4h[idx4hc];
      if (last4h.close > prev4h.close + atrVal4h * ATR_BREAKOUT_MULT) atr13 = "LONG";
      else if (last4h.close < prev4h.close - atrVal4h * ATR_BREAKOUT_MULT) atr13 = "SHORT";
    }
    if (idx4hc >= DONCHIAN_LOOKBACK) {
      let hi = -Infinity, lo = Infinity;
      for (let j = idx4hc - DONCHIAN_LOOKBACK; j < idx4hc; j++) { if (c4h[j].high > hi) hi = c4h[j].high; if (c4h[j].low < lo) lo = c4h[j].low; }
      const l4 = c4h[idx4hc];
      if (l4.close > hi) don14 = "LONG"; else if (l4.close < lo) don14 = "SHORT";
    }
    const trendEnter = (kind: string, side: "LONG" | "SHORT", notMult: number, lastTsRef: { v: number }, cdMs: number) => {
      if (dropS12 && kind === "S12") return;
      if (ts - lastTsRef.v < cdMs) return;
      if (atrVal4h === null || atrVal4h <= 0) return;
      if ((kind === "S13" || kind === "S14") && !vol4hPass) return;
      if (side === "LONG" && !filterLong) return;
      if (side === "SHORT" && !filterShort) return;
      const notional = NOTIONAL_PER_ENTRY * notMult;
      const qty = notional / mark;
      const curNotional = side === "LONG" ? trendLongNotional : trendShortNotional;
      if (curNotional + notional > MAX_NOTIONAL_PER_SIDE) return;
      const slPx = side === "LONG" ? mark - atrVal4h * SL_INITIAL : mark + atrVal4h * SL_INITIAL;
      const entryFee = qty * mark * FEE_PCT / 100;
      wallet -= entryFee;
      if (side === "LONG") trendLongNotional += notional; else trendShortNotional += notional;
      trendTrades.push({ id: `${kind}_${side}_${ts}`, kind, side, entryPx: mark, qty, notional, hwm: mark, lwm: mark, slPx, atrEntry: atrVal4h, entryTs: ts });
      lastTsRef.v = ts; entries++;
    };
    const refL12 = { get v() { return lastS12L; }, set v(x: number) { lastS12L = x; } };
    const refS12 = { get v() { return lastS12S; }, set v(x: number) { lastS12S = x; } };
    const refL13 = { get v() { return lastS13L; }, set v(x: number) { lastS13L = x; } };
    const refS13 = { get v() { return lastS13S; }, set v(x: number) { lastS13S = x; } };
    const refL14 = { get v() { return lastS14L; }, set v(x: number) { lastS14L = x; } };
    const refS14 = { get v() { return lastS14S; }, set v(x: number) { lastS14S = x; } };
    if (ema12 === "LONG") trendEnter("S12", "LONG", SETUP12_MULT, refL12 as any, SETUP12_COOLDOWN_MS);
    else if (ema12 === "SHORT") trendEnter("S12", "SHORT", SETUP12_MULT, refS12 as any, SETUP12_COOLDOWN_MS);
    if (atr13 === "LONG") trendEnter("S13", "LONG", SETUP13_MULT, refL13 as any, SETUP13_COOLDOWN_MS);
    else if (atr13 === "SHORT") trendEnter("S13", "SHORT", SETUP13_MULT, refS13 as any, SETUP13_COOLDOWN_MS);
    if (don14 === "LONG") trendEnter("S14", "LONG", SETUP14_MULT, refL14 as any, SETUP14_COOLDOWN_MS);
    else if (don14 === "SHORT") trendEnter("S14", "SHORT", SETUP14_MULT, refS14 as any, SETUP14_COOLDOWN_MS);
  }
  return { monthly: monthlyPnL, meta: { entries, closes, wins, wr: closes > 0 ? wins / closes * 100 : 0 } };
}

function statsFromMonthly(monthly: number[], initial: number) {
  let equity = initial, peak = initial, trough = initial;
  for (const p of monthly) { equity += p; if (equity > peak) peak = equity; if (equity < trough) trough = equity; }
  const roi = (equity - initial) / initial * 100;
  const dd = (peak - trough) / peak * 100;
  const ra = dd > 0 ? roi / dd : (roi > 0 ? 999 : 0);
  const ret = monthly.map(p => p / initial * 100);
  const m = ret.reduce((a, b) => a + b, 0) / ret.length;
  const std = Math.sqrt(ret.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, ret.length - 1));
  const sharpe = std > 0 ? m / std * Math.sqrt(12) : 0;
  return { roi: +roi.toFixed(2), dd: +dd.toFixed(2), ra: +ra.toFixed(3), sharpe: +sharpe.toFixed(2), posM: ret.filter(r => r > 0).length, negM: ret.filter(r => r < 0).length };
}

function main() {
  console.log("[t1-t4] Backtesting BTC v0.4.46 + ETH E1 (drop S12)...");
  const btc = runWithMonthly("BTC", loadCache("binance-5m-7y.json"), false);
  const eth = runWithMonthly("ETH", loadCache("binance-eth-5m-3y.json"), true);

  const allMonths = Array.from(new Set([...Object.keys(btc.monthly), ...Object.keys(eth.monthly)])).sort();
  const btcM = allMonths.map(m => btc.monthly[m] ?? 0);
  const ethM = allMonths.map(m => eth.monthly[m] ?? 0);
  console.log(`  BTC entries ${btc.meta.entries}, WR ${btc.meta.wr.toFixed(1)}%`);
  console.log(`  ETH entries ${eth.meta.entries}, WR ${eth.meta.wr.toFixed(1)}%`);

  // T1: Portfolio 60/40
  console.log("\n=== T1: PORTFOLIO 60/40 WITH ETH E1 (drop S12) ===");
  const w = 0.6;
  const portM = btcM.map((b, i) => w * b + (1 - w) * ethM[i]);
  const portStats = statsFromMonthly(portM, INITIAL_CAPITAL);
  console.log(`  ROI ${portStats.roi}% | DD ${portStats.dd}% | RA ${portStats.ra} | Sharpe ${portStats.sharpe} | PosM/NegM ${portStats.posM}/${portStats.negM}`);

  // Per-year T1
  const yearPnL: Record<string, number> = {};
  for (let i = 0; i < allMonths.length; i++) {
    const y = allMonths[i].slice(0, 4);
    yearPnL[y] = (yearPnL[y] ?? 0) + portM[i];
  }
  console.log(`  Per-year:`);
  for (const [y, p] of Object.entries(yearPnL).sort()) console.log(`    ${y}: ${p >= 0 ? '+' : ''}$${p.toFixed(0)}`);

  // T2: Walk-forward train 2023-24 vs test 2025-26
  console.log("\n=== T2: WALK-FORWARD ===");
  const trainEnd = allMonths.findIndex(m => m >= "2025-01");
  const trainM = portM.slice(0, trainEnd);
  const testM = portM.slice(trainEnd);
  const trainStats = statsFromMonthly(trainM, INITIAL_CAPITAL);
  const testStats = statsFromMonthly(testM, INITIAL_CAPITAL);
  console.log(`  TRAIN 2023-24: ROI ${trainStats.roi}% | DD ${trainStats.dd}% | RA ${trainStats.ra} | Sharpe ${trainStats.sharpe}`);
  console.log(`  TEST  2025-26: ROI ${testStats.roi}% | DD ${testStats.dd}% | RA ${testStats.ra} | Sharpe ${testStats.sharpe}`);
  const tnDelta = ((testStats.ra - trainStats.ra) / Math.max(0.01, trainStats.ra) * 100).toFixed(1);
  console.log(`  RA train→test Δ: ${tnDelta}% (${Math.abs(parseFloat(tnDelta)) < 30 ? "ROBUST ✅" : "DEGRADE ⚠️"})`);

  // T3: Stress — worst joint months
  console.log("\n=== T3: STRESS TEST — Worst months ===");
  const monthRows = allMonths.map((m, i) => ({ month: m, btc: btcM[i], eth: ethM[i], port: portM[i] }));
  const worstJoint = [...monthRows].filter(r => r.btc < 0 && r.eth < 0).sort((a, b) => a.port - b.port).slice(0, 5);
  console.log(`  Joint failure months (both BTC & ETH negative) — count: ${monthRows.filter(r => r.btc < 0 && r.eth < 0).length}`);
  for (const r of worstJoint) console.log(`    ${r.month}: BTC $${r.btc.toFixed(0)} ETH $${r.eth.toFixed(0)} Port $${r.port.toFixed(0)}`);
  const onlyBTC = monthRows.filter(r => r.btc < 0 && r.eth >= 0).length;
  const onlyETH = monthRows.filter(r => r.btc >= 0 && r.eth < 0).length;
  console.log(`  BTC down/ETH up: ${onlyBTC} months (ETH saves)`);
  console.log(`  BTC up/ETH down: ${onlyETH} months (BTC saves)`);

  // T4: Rolling 30d correlation
  console.log("\n=== T4: ROLLING 6-MONTH CORRELATION ===");
  const window = 6;
  const corrPoints: { month: string; corr: number }[] = [];
  for (let i = window - 1; i < monthRows.length; i++) {
    const subBTC = btcM.slice(i - window + 1, i + 1);
    const subETH = ethM.slice(i - window + 1, i + 1);
    const meanB = subBTC.reduce((a, b) => a + b, 0) / window;
    const meanE = subETH.reduce((a, b) => a + b, 0) / window;
    let cov = 0, vB = 0, vE = 0;
    for (let j = 0; j < window; j++) { cov += (subBTC[j] - meanB) * (subETH[j] - meanE); vB += (subBTC[j] - meanB) ** 2; vE += (subETH[j] - meanE) ** 2; }
    const c = vB > 0 && vE > 0 ? cov / Math.sqrt(vB * vE) : 0;
    corrPoints.push({ month: allMonths[i], corr: +c.toFixed(2) });
  }
  console.log(`  Rolling 6-month BTC-ETH correlation:`);
  for (const r of corrPoints) {
    const bar = "▓".repeat(Math.round((r.corr + 1) * 10)) + "·".repeat(Math.max(0, 20 - Math.round((r.corr + 1) * 10)));
    const flag = r.corr > 0.8 ? "⚠️ HIGH" : r.corr < 0 ? "⭐ NEG" : "";
    console.log(`    ${r.month} [${bar}] ${r.corr >= 0 ? '+' : ''}${r.corr.toFixed(2)} ${flag}`);
  }
  const maxCorr = Math.max(...corrPoints.map(r => r.corr));
  const minCorr = Math.min(...corrPoints.map(r => r.corr));
  console.log(`  Max corr: ${maxCorr.toFixed(2)} (highest risk of joint fail)`);
  console.log(`  Min corr: ${minCorr.toFixed(2)} (best diversification)`);

  writeFileSync(join(__dirname, "..", "assets", "t1_t4_btc_eth_portfolio.json"), JSON.stringify({
    t1_portfolio_60_40: { stats: portStats, yearPnL, monthlyPnL: monthRows },
    t2_walkforward: { train: trainStats, test: testStats, deltaPct: tnDelta },
    t3_stress: { jointFailMonths: monthRows.filter(r => r.btc < 0 && r.eth < 0), btcDownEthUp: onlyBTC, btcUpEthDown: onlyETH },
    t4_correlation: { points: corrPoints, max: +maxCorr.toFixed(3), min: +minCorr.toFixed(3) },
    btcMeta: btc.meta, ethMeta: eth.meta,
  }, null, 2));
  console.log("\nWritten assets/t1_t4_btc_eth_portfolio.json");
}

main();
