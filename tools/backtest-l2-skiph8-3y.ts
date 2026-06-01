/**
 * backtest-l2-skiph8-3y.ts — Test L2 skip hour 8 UTC entries on BTC + ETH.
 *
 * Pattern verified: hour 8 UTC losing in BOTH train (2023-24) AND test (2025-26) periods.
 * Hypothesis: skip hour 8 → BTC PnL $544 → $679 (+$135 estimated).
 * Real backtest with cooldown handling to verify exact impact.
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

function run(c5: Candle[], skipHours: number[], dropS12: boolean = false): any {
  const startTs = new Date("2023-05-25T00:00:00Z").getTime();
  const warmupTs = startTs - 60 * 86_400_000;
  const filtered = c5.filter(b => b.time >= warmupTs);
  const startIdx = filtered.findIndex(b => b.time >= startTs);
  const c1h = aggregateBars(filtered, 60);
  const c4h = aggregateBars(filtered, 240);
  const c1d = aggregateBars(filtered, 1440);
  const adxObj = calcADXFull(c4h, 14);
  const ind = {
    ma200d: calcSMA(c1d.map(b => b.close), 200), ma50d: calcSMA(c1d.map(b => b.close), 50),
    ema50_4h: calcEMA(c4h.map(b => b.close), EMA_FAST), ema200_4h: calcEMA(c4h.map(b => b.close), EMA_SLOW),
    ema200_1h: calcEMA(c1h.map(b => b.close), 200), atr14_4h: calcATR(c4h, 14), adx14_4h: adxObj.adx,
  };
  const vol4hMA: (number | null)[] = new Array(c4h.length).fill(null);
  for (let i = VOL_MA_PERIOD - 1; i < c4h.length; i++) {
    let s = 0;
    for (let j = i - VOL_MA_PERIOD + 1; j <= i; j++) s += c4h[j].volume ?? 0;
    vol4hMA[i] = s / VOL_MA_PERIOD;
  }
  let wallet = INITIAL_CAPITAL, hwm = INITIAL_CAPITAL, lowestWallet = INITIAL_CAPITAL;
  let trendLongN = 0, trendShortN = 0;
  let trendTrades: TrendTrade[] = [];
  let lastS12L = 0, lastS12S = 0, lastS13L = 0, lastS13S = 0, lastS14L = 0, lastS14S = 0;
  let regime: Regime = "RANGE", regimeConsec = 0, regimeLastRaw: Regime = "RANGE";
  let entries = 0, closes = 0, wins = 0;
  const byYear: Record<string, { pnl: number; entries: number }> = {};
  let idx1h = 0, idx4h = 0, idx1d = 0;
  let last4hIdx = -1;

  for (let i = startIdx; i < filtered.length; i++) {
    const bar = filtered[i]; const ts = bar.time; const mark = bar.close;
    const newTrend: TrendTrade[] = [];
    for (const t of trendTrades) {
      const heldMs = ts - t.entryTs;
      const slMult = heldMs < SL_TRANSITION_MS ? SL_INITIAL : SL_TRAILING;
      if (t.side === "LONG") { if (mark > t.hwm) { t.hwm = mark; t.slPx = t.hwm - t.atrEntry * slMult; } else if (heldMs >= SL_TRANSITION_MS) { const tgt = t.hwm - t.atrEntry * SL_TRAILING; if (tgt > t.slPx) t.slPx = tgt; } }
      else { if (mark < t.lwm) { t.lwm = mark; t.slPx = t.lwm + t.atrEntry * slMult; } else if (heldMs >= SL_TRANSITION_MS) { const tgt = t.lwm + t.atrEntry * SL_TRAILING; if (tgt < t.slPx) t.slPx = tgt; } }
      let exit = false;
      if (t.side === "LONG" && mark <= t.slPx) exit = true;
      if (t.side === "SHORT" && mark >= t.slPx) exit = true;
      if (exit) {
        const fee = t.qty * mark * FEE_PCT / 100;
        const pnl = (t.side === "LONG" ? mark - t.entryPx : t.entryPx - mark) * t.qty;
        const net = pnl - fee;
        wallet += net;
        if (wallet > hwm) hwm = wallet;
        if (wallet < lowestWallet) lowestWallet = wallet;
        closes++; if (pnl > 0) wins++;
        const y = new Date(ts).toISOString().slice(0, 4);
        byYear[y] = byYear[y] ?? { pnl: 0, entries: 0 };
        byYear[y].pnl += net;
        if (t.side === "LONG") trendLongN = Math.max(0, trendLongN - t.notional);
        else trendShortN = Math.max(0, trendShortN - t.notional);
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

    // L2: skip specific UTC hours
    const utcHour = new Date(ts).getUTCHours();
    if (skipHours.includes(utcHour)) { filterLong = false; filterShort = false; }

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
      const curN = side === "LONG" ? trendLongN : trendShortN;
      if (curN + notional > MAX_NOTIONAL_PER_SIDE) return;
      const slPx = side === "LONG" ? mark - atrVal4h * SL_INITIAL : mark + atrVal4h * SL_INITIAL;
      const entryFee = qty * mark * FEE_PCT / 100;
      wallet -= entryFee;
      if (side === "LONG") trendLongN += notional; else trendShortN += notional;
      trendTrades.push({ id: `${kind}_${side}_${ts}`, kind, side, entryPx: mark, qty, notional, hwm: mark, lwm: mark, slPx, atrEntry: atrVal4h, entryTs: ts });
      lastTsRef.v = ts; entries++;
      const y = new Date(ts).toISOString().slice(0, 4);
      byYear[y] = byYear[y] ?? { pnl: 0, entries: 0 }; byYear[y].entries++;
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
  const roi = (wallet - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100;
  const maxDD = (hwm - lowestWallet) / hwm * 100;
  const wr = closes > 0 ? wins / closes * 100 : 0;
  const ra = maxDD > 0 ? roi / maxDD : (roi > 0 ? 999 : 0);
  const stab = Object.values(byYear).filter(d => d.pnl > 0).length;
  return { entries, closes, wr: +wr.toFixed(1), roi: +roi.toFixed(2), maxDD: +maxDD.toFixed(2), ra: +ra.toFixed(2), byYear, stab: `${stab}/${Object.keys(byYear).length}` };
}

function main() {
  console.log("[bt-L2] Loading data...");
  const btc5 = loadCache("binance-5m-7y.json");
  const eth5 = loadCache("binance-eth-5m-3y.json");

  const variants: Array<{ name: string; skip: number[]; sym: string; dropS12?: boolean }> = [
    { name: "BTC BASELINE v0.4.46", skip: [], sym: "btc" },
    { name: "BTC L2 skip h=8", skip: [8], sym: "btc" },
    { name: "BTC L2 skip h=8+16", skip: [8, 16], sym: "btc" },  // 16h also lose in train period
    { name: "ETH BASELINE E1", skip: [], sym: "eth", dropS12: true },
    { name: "ETH L2 skip h=8", skip: [8], sym: "eth", dropS12: true },
  ];

  const results: any[] = [];
  for (const v of variants) {
    const data = v.sym === "btc" ? btc5 : eth5;
    const r = run(data, v.skip, v.dropS12 ?? false);
    results.push({ name: v.name, ...r });
    const years = Object.entries(r.byYear).sort().map(([y, d]: any) => `${y}=${d.pnl >= 0 ? '+' : ''}${d.pnl.toFixed(0)}`).join(' ');
    console.log(`${v.name.padEnd(28)} | RA ${r.ra} | ROI ${r.roi}% | DD ${r.maxDD}% | Entries ${r.entries} | WR ${r.wr}% | Stab ${r.stab}`);
    console.log(`  per-year: ${years}`);
  }

  writeFileSync(join(__dirname, "..", "assets", "backtest_l2_skiph8_3y.json"), JSON.stringify(results, null, 2));
  console.log("\nWritten assets/backtest_l2_skiph8_3y.json");
}

main();
