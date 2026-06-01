/**
 * bear-regime-hedge02new.ts (anh Tommy 2026-05-14)
 *
 * Detect bear regime + mark LONG (combo C2) khi !bear, SHORT mirror khi bear.
 *
 * Bear detect methods:
 *   M1. 1W trend: c1w[w-2].close < c1w[w-3].close (2 closed weekly bars red)
 *   M2. 1D below EMA200: 1D close < EMA200(1D)
 *   M3. Drawdown 20%: 1D close < max(1D close 60d) × 0.80
 *
 * SPEC: TP+2% / SL-1% / 24h (LONG) — mirror: TP-2% / SL+1% / 24h (SHORT, profit khi giá giảm 2%)
 * Combo LONG: RSI≥70 AND upWick≥0.3% AND mom_all_up
 * Combo SHORT (mirror): RSI≤30 AND dnWick≥0.3% AND mom_all_down
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const TP_PCT = 2.0;
const SL_PCT = 1.0;
const WINDOW_BARS = 288;
const FEE_PER_SIDE_PCT = 0.05;
const MS_5M = 5 * 60_000;
const MS_1D = 24 * 60 * 60_000;

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }
function loadCache(): Candle[] {
  return JSON.parse(readFileSync(join(__dirname, "..", ".cache", "binance-5m-7y.json"), "utf8"));
}

function calcSMA(a: number[], p: number): (number|null)[] {
  const o: (number|null)[] = new Array(a.length).fill(null);
  if (a.length < p) return o;
  let s = 0; for (let i = 0; i < p; i++) s += a[i];
  o[p-1] = s/p;
  for (let i = p; i < a.length; i++) { s += a[i] - a[i-p]; o[i] = s/p; }
  return o;
}
function calcEMA(a: number[], p: number): (number|null)[] {
  const o: (number|null)[] = new Array(a.length).fill(null);
  if (a.length < p) return o;
  const k = 2/(p+1); let e = 0;
  for (let i = 0; i < p; i++) e += a[i];
  e /= p; o[p-1] = e;
  for (let i = p; i < a.length; i++) { e = a[i]*k + e*(1-k); o[i] = e; }
  return o;
}
function calcStdev(a: number[], p: number, sma: (number|null)[]): (number|null)[] {
  const o: (number|null)[] = new Array(a.length).fill(null);
  for (let i = p-1; i < a.length; i++) {
    const m = sma[i]; if (m === null) continue;
    let sq = 0; for (let j = i-p+1; j <= i; j++) sq += (a[j]-m)**2;
    o[i] = Math.sqrt(sq/p);
  }
  return o;
}
function calcRSI(c: number[], p: number): (number|null)[] {
  const o: (number|null)[] = new Array(c.length).fill(null);
  if (c.length <= p) return o;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const ch = c[i]-c[i-1]; if (ch >= 0) g += ch; else l -= ch; }
  let ag = g/p, al = l/p;
  o[p] = al === 0 ? 100 : 100-100/(1+ag/al);
  for (let i = p+1; i < c.length; i++) {
    const ch = c[i]-c[i-1];
    ag = (ag*(p-1)+Math.max(ch,0))/p;
    al = (al*(p-1)+Math.max(-ch,0))/p;
    o[i] = al === 0 ? 100 : 100-100/(1+ag/al);
  }
  return o;
}
function calcStochK(c: Candle[], p: number): (number|null)[] {
  const o: (number|null)[] = new Array(c.length).fill(null);
  for (let i = p-1; i < c.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i-p+1; j <= i; j++) { if (c[j].high > hi) hi = c[j].high; if (c[j].low < lo) lo = c[j].low; }
    o[i] = hi === lo ? 50 : ((c[i].close-lo)/(hi-lo))*100;
  }
  return o;
}

// Aggregate 5m bars → daily bars (UTC). Returns 1D candles + map 5m_index → 1D_index
function aggregateDaily(c5: Candle[]): { daily: Candle[]; map5mToDaily: number[] } {
  const daily: Candle[] = [];
  const map5mToDaily: number[] = new Array(c5.length).fill(-1);
  let curDay = -1;
  let cur: Candle | null = null;
  for (let i = 0; i < c5.length; i++) {
    const bar = c5[i];
    const dayKey = Math.floor(bar.time / MS_1D);
    if (dayKey !== curDay) {
      if (cur) daily.push(cur);
      cur = { time: dayKey * MS_1D, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume ?? 0 };
      curDay = dayKey;
    } else if (cur) {
      if (bar.high > cur.high) cur.high = bar.high;
      if (bar.low < cur.low) cur.low = bar.low;
      cur.close = bar.close;
      cur.volume = (cur.volume ?? 0) + (bar.volume ?? 0);
    }
    // map current 5m bar to index of PREVIOUS closed daily bar (no peek)
    map5mToDaily[i] = daily.length - 1;
  }
  if (cur) daily.push(cur);
  return { daily, map5mToDaily };
}

// Aggregate daily → weekly (Mon-Sun, ISO week)
function aggregateWeekly(c1d: Candle[]): Candle[] {
  const weekly: Candle[] = [];
  let cur: Candle | null = null;
  let curWeek = -1;
  for (const bar of c1d) {
    // ISO week number (use Monday as week start)
    const d = new Date(bar.time);
    // weekKey = floor((time + 4 days offset) / 7 days) — anchor at Thursday for ISO
    const weekKey = Math.floor((bar.time + 3 * MS_1D) / (7 * MS_1D));
    if (weekKey !== curWeek) {
      if (cur) weekly.push(cur);
      cur = { time: weekKey * 7 * MS_1D, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume ?? 0 };
      curWeek = weekKey;
    } else if (cur) {
      if (bar.high > cur.high) cur.high = bar.high;
      if (bar.low < cur.low) cur.low = bar.low;
      cur.close = bar.close;
      cur.volume = (cur.volume ?? 0) + (bar.volume ?? 0);
    }
  }
  if (cur) weekly.push(cur);
  return weekly;
}

interface Feat {
  dnWick: number; upWick: number; body: number; isBull: number;
  volR: number; atrR: number; dMA50: number; dMA200: number;
  mom5: number; mom10: number; mom20: number;
  rsi: number; stochK: number;
}

function main() {
  console.log("[bear-regime] Loading 7y...");
  const c = loadCache();
  console.log(`  ${c.length.toLocaleString()} bars 5m`);
  console.log("[bear-regime] Aggregating daily + weekly bars...");
  const { daily: c1d, map5mToDaily } = aggregateDaily(c);
  const c1w = aggregateWeekly(c1d);
  console.log(`  ${c1d.length} daily bars, ${c1w.length} weekly bars`);

  // 1D regime: EMA200(1D) + MA50/MA200 + rolling 60d high
  const dailyCloses = c1d.map(b => b.close);
  const ema200_1d = calcEMA(dailyCloses, 200);
  const ma200_1d = calcSMA(dailyCloses, 200);
  // Rolling 60d high on daily close
  const high60d: (number|null)[] = new Array(c1d.length).fill(null);
  for (let i = 59; i < c1d.length; i++) {
    let h = -Infinity;
    for (let j = i-59; j <= i; j++) if (c1d[j].close > h) h = c1d[j].close;
    high60d[i] = h;
  }

  // 1W trend: c1w[idx-1].close < c1w[idx-2].close (2 closed weekly bars red)
  // For each daily bar, find latest CLOSED weekly bar index
  const dayToWeekIdx: number[] = new Array(c1d.length).fill(-1);
  let wIdx = -1;
  for (let i = 0; i < c1d.length; i++) {
    // find latest weekly bar with time + 7d < c1d[i].time (i.e., fully closed before this day)
    while (wIdx + 1 < c1w.length && c1w[wIdx + 1].time + 7 * MS_1D <= c1d[i].time) wIdx++;
    dayToWeekIdx[i] = wIdx;
  }

  // === Compute features per 5m bar (NO PEEK) ===
  console.log("[bear-regime] Computing 5m features...");
  const closes5 = c.map(b => b.close);
  const rsi5 = calcRSI(closes5, 14);
  const stochK5 = calcStochK(c, 14);
  const ma50_5 = calcSMA(closes5, 50);
  const ma200_5 = calcSMA(closes5, 200);

  const allFeats: Feat[] = new Array(c.length);
  for (let i = 0; i < c.length; i++) {
    const bar = c[i];
    const dnWick = (Math.min(bar.open, bar.close) - bar.low) / bar.open * 100;
    const upWick = (bar.high - Math.max(bar.open, bar.close)) / bar.open * 100;
    const body = Math.abs(bar.close - bar.open) / bar.open * 100;
    const isBull = bar.close > bar.open ? 1 : 0;
    const volR = 0;  // not needed cho combo C2
    const atrR = 0;
    const dMA50 = ma50_5[i] !== null ? (bar.close - ma50_5[i]!)/ma50_5[i]! * 100 : 0;
    const dMA200 = ma200_5[i] !== null ? (bar.close - ma200_5[i]!)/ma200_5[i]! * 100 : 0;
    const mom5 = i >= 6 ? (bar.close - c[i-6].close)/c[i-6].close * 100 : 0;
    const mom10 = i >= 11 ? (bar.close - c[i-11].close)/c[i-11].close * 100 : 0;
    const mom20 = i >= 21 ? (bar.close - c[i-21].close)/c[i-21].close * 100 : 0;
    allFeats[i] = { dnWick, upWick, body, isBull, volR, atrR, dMA50, dMA200, mom5, mom10, mom20,
                    rsi: rsi5[i] ?? 50, stochK: stochK5[i] ?? 50 };
  }

  // === Bear flags per 5m bar (using latest CLOSED daily/weekly — no peek) ===
  console.log("[bear-regime] Computing bear regime flags...");
  // Map 5m to latest closed daily: previous day bar (not current incomplete day)
  function bearFlagsAt(i: number): { m1_1w: boolean; m2_ema200d: boolean; m3_dd20: boolean } {
    const dayIdx = map5mToDaily[i] - 1;  // previous closed day (the day containing bar i is still open)
    if (dayIdx < 200) return { m1_1w: false, m2_ema200d: false, m3_dd20: false };
    // M1: 1W trend — find latest closed weekly bar
    const wIdxNow = dayToWeekIdx[dayIdx];
    const m1_1w = (wIdxNow >= 2 && c1w[wIdxNow].close < c1w[wIdxNow - 1].close);
    // M2: 1D close < EMA200(1D)
    const ema = ema200_1d[dayIdx];
    const m2 = ema !== null ? (c1d[dayIdx].close < ema) : false;
    // M3: drawdown 20% — 1D close < max(60d close) × 0.80
    const h60 = high60d[dayIdx];
    const m3 = h60 !== null ? (c1d[dayIdx].close < h60 * 0.80) : false;
    return { m1_1w, m2_ema200d: m2, m3_dd20: m3 };
  }

  // === Mark LONG (TP+2%/SL-1%/24h) ===
  console.log("[bear-regime] Marking LONG dataset...");
  interface Mark { i: number; year: number; winner: boolean; }
  const longMarks: Mark[] = [];
  for (let i = 200; i < c.length - WINDOW_BARS; i++) {
    const entry = c[i].close;
    const tp = entry * (1 + TP_PCT/100);
    const sl = entry * (1 - SL_PCT/100);
    let won = false, lost = false;
    for (let j = i+1; j < i+1+WINDOW_BARS; j++) {
      if (c[j].low <= sl) { lost = true; break; }
      if (c[j].high >= tp) { won = true; break; }
    }
    if (won || lost) longMarks.push({ i, year: new Date(c[i].time).getUTCFullYear(), winner: won });
  }

  // === Mark SHORT mirror (TP-2%/SL+1%/24h) ===
  console.log("[bear-regime] Marking SHORT mirror dataset...");
  const shortMarks: Mark[] = [];
  for (let i = 200; i < c.length - WINDOW_BARS; i++) {
    const entry = c[i].close;
    const tp = entry * (1 - TP_PCT/100);  // SHORT profit = price down
    const sl = entry * (1 + SL_PCT/100);  // SHORT stop = price up
    let won = false, lost = false;
    for (let j = i+1; j < i+1+WINDOW_BARS; j++) {
      if (c[j].high >= sl) { lost = true; break; }
      if (c[j].low <= tp) { won = true; break; }
    }
    if (won || lost) shortMarks.push({ i, year: new Date(c[i].time).getUTCFullYear(), winner: won });
  }

  console.log(`  LONG marks: ${longMarks.length.toLocaleString()}, win ${longMarks.filter(m=>m.winner).length.toLocaleString()} (WR ${(longMarks.filter(m=>m.winner).length/longMarks.length*100).toFixed(2)}%)`);
  console.log(`  SHORT marks: ${shortMarks.length.toLocaleString()}, win ${shortMarks.filter(m=>m.winner).length.toLocaleString()} (WR ${(shortMarks.filter(m=>m.winner).length/shortMarks.length*100).toFixed(2)}%)`);

  // Combo predicates
  const longC2 = (f: Feat) => f.rsi >= 70 && f.upWick >= 0.3 && f.mom5 >= 0 && f.mom10 >= 0 && f.mom20 >= 0;
  const shortC2 = (f: Feat) => f.rsi <= 30 && f.dnWick >= 0.3 && f.mom5 <= 0 && f.mom10 <= 0 && f.mom20 <= 0;

  // === Evaluate each filter strategy ===
  type Bearfn = (i: number) => boolean;
  const M1: Bearfn = i => bearFlagsAt(i).m1_1w;
  const M2: Bearfn = i => bearFlagsAt(i).m2_ema200d;
  const M3: Bearfn = i => bearFlagsAt(i).m3_dd20;

  interface Strat {
    name: string;
    longGate?: Bearfn;     // LONG fires only when this returns FALSE (i.e., not bear)
    shortGate?: Bearfn;    // SHORT fires only when this returns TRUE (i.e., is bear)
  }
  const strats: Strat[] = [
    { name: "Baseline (LONG only, no filter)" },
    { name: "M1 1W trend — LONG when !bear, SHORT when bear", longGate: M1, shortGate: M1 },
    { name: "M2 1D<EMA200 — LONG when !bear, SHORT when bear", longGate: M2, shortGate: M2 },
    { name: "M3 DD20% — LONG when !bear, SHORT when bear", longGate: M3, shortGate: M3 },
  ];

  function evalCombined(strat: Strat) {
    // Group results per year
    const years: Record<number, { longMatch: number; longWin: number; longRoi: number;
                                  shortMatch: number; shortWin: number; shortRoi: number;
                                  totalRoi: number }> = {};
    function bucket(y: number) {
      if (!years[y]) years[y] = { longMatch: 0, longWin: 0, longRoi: 0,
                                  shortMatch: 0, shortWin: 0, shortRoi: 0, totalRoi: 0 };
      return years[y];
    }
    // LONG
    for (const m of longMarks) {
      if (!longC2(allFeats[m.i])) continue;
      if (strat.longGate && strat.longGate(m.i)) continue;  // skip if bear
      const yr = bucket(m.year);
      yr.longMatch++;
      if (m.winner) yr.longWin++;
    }
    // SHORT (only fires if strategy enables shortGate)
    if (strat.shortGate) {
      for (const m of shortMarks) {
        if (!shortC2(allFeats[m.i])) continue;
        if (!strat.shortGate(m.i)) continue;  // skip if NOT bear
        const yr = bucket(m.year);
        yr.shortMatch++;
        if (m.winner) yr.shortWin++;
      }
    }
    let posY = 0, totY = 0;
    let sumLongROI = 0, sumShortROI = 0;
    let sumLongMatch = 0, sumLongWin = 0, sumShortMatch = 0, sumShortWin = 0;
    for (const y in years) {
      const yr = years[+y];
      const longWR = yr.longMatch > 0 ? yr.longWin / yr.longMatch : 0;
      const longEV = yr.longMatch > 0 ? (longWR * TP_PCT - (1-longWR) * SL_PCT - 2*FEE_PER_SIDE_PCT) : 0;
      yr.longRoi = yr.longMatch * longEV;
      const shortWR = yr.shortMatch > 0 ? yr.shortWin / yr.shortMatch : 0;
      const shortEV = yr.shortMatch > 0 ? (shortWR * TP_PCT - (1-shortWR) * SL_PCT - 2*FEE_PER_SIDE_PCT) : 0;
      yr.shortRoi = yr.shortMatch * shortEV;
      yr.totalRoi = yr.longRoi + yr.shortRoi;
      totY++;
      if (yr.totalRoi > 0) posY++;
      sumLongROI += yr.longRoi;
      sumShortROI += yr.shortRoi;
      sumLongMatch += yr.longMatch; sumLongWin += yr.longWin;
      sumShortMatch += yr.shortMatch; sumShortWin += yr.shortWin;
    }
    return { years, posY, totY, sumLongROI, sumShortROI, sumLongMatch, sumLongWin, sumShortMatch, sumShortWin };
  }

  console.log(`\n${"=".repeat(100)}\nDUAL-SIDE STRATEGY COMPARISON\nLONG combo: RSI≥70 AND upWick≥0.3% AND mom_all_up   SHORT combo (mirror): RSI≤30 AND dnWick≥0.3% AND mom_all_down\n${"=".repeat(100)}`);

  for (const s of strats) {
    const r = evalCombined(s);
    const yrs = Object.keys(r.years).map(Number).sort();
    const longWR = r.sumLongMatch > 0 ? r.sumLongWin / r.sumLongMatch * 100 : 0;
    const shortWR = r.sumShortMatch > 0 ? r.sumShortWin / r.sumShortMatch * 100 : 0;
    console.log(`\n[${s.name}]`);
    console.log(`  LONG  : ${r.sumLongMatch.toString().padStart(5)} match  WR ${longWR.toFixed(2).padStart(5)}%  ROI ${(r.sumLongROI>=0?'+':'')}${r.sumLongROI.toFixed(1)}%`);
    console.log(`  SHORT : ${r.sumShortMatch.toString().padStart(5)} match  WR ${shortWR.toFixed(2).padStart(5)}%  ROI ${(r.sumShortROI>=0?'+':'')}${r.sumShortROI.toFixed(1)}%`);
    console.log(`  Total ROI 7y: ${((r.sumLongROI+r.sumShortROI)>=0?'+':'')}${(r.sumLongROI+r.sumShortROI).toFixed(1)}%   Years positive: ${r.posY}/${r.totY} (${(r.posY/r.totY*100).toFixed(0)}%)`);
    console.log(`  Per-year (L=long, S=short, T=total):`);
    for (const y of yrs) {
      const yr = r.years[y];
      console.log(`    ${y}:  L ${yr.longMatch.toString().padStart(4)}/${yr.longWin.toString().padStart(4)} ${(yr.longRoi>=0?'+':'')}${yr.longRoi.toFixed(0)}%   S ${yr.shortMatch.toString().padStart(4)}/${yr.shortWin.toString().padStart(4)} ${(yr.shortRoi>=0?'+':'')}${yr.shortRoi.toFixed(0)}%   T ${(yr.totalRoi>=0?'+':'')}${yr.totalRoi.toFixed(0)}%`);
    }
  }

  console.log("\n[bear-regime] ✅ Done");
}

main();
