/**
 * sweep-short-hedge02new-7y.ts (anh Tommy 2026-05-14)
 *
 * Sweep SHORT combos riêng (KHÔNG mirror LONG combo C2) trên 7y data.
 * Spec: TP-2% / SL+1% / 24h SHORT (R:R 2:1, break-even 36.67%)
 *
 * Goal: tìm combo SHORT có WR ≥ 40% + match ≥ 200 + edge stable per-year.
 * Nếu tìm được → dual-side hedge02-new. Nếu không → LONG only.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const TP_PCT = 2.0;
const SL_PCT = 1.0;
const WINDOW_BARS = 288;
const FEE_PER_SIDE_PCT = 0.05;

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
function calcATR(c: Candle[], p: number): (number|null)[] {
  const o: (number|null)[] = new Array(c.length).fill(null);
  if (c.length <= p) return o;
  const tr: number[] = new Array(c.length).fill(0);
  for (let i = 1; i < c.length; i++)
    tr[i] = Math.max(c[i].high-c[i].low, Math.abs(c[i].high-c[i-1].close), Math.abs(c[i].low-c[i-1].close));
  let s = 0;
  for (let i = 1; i <= p; i++) s += tr[i];
  o[p] = s/p;
  for (let i = p+1; i < c.length; i++) o[i] = (o[i-1]!*(p-1)+tr[i])/p;
  return o;
}
function calcMACDHist(c: number[]): (number|null)[] {
  const e12 = calcEMA(c, 12), e26 = calcEMA(c, 26);
  const macd: (number|null)[] = c.map((_, i) => (e12[i] != null && e26[i] != null) ? e12[i]!-e26[i]! : null);
  const v: number[] = [], idxMap: number[] = [];
  for (let i = 0; i < macd.length; i++) if (macd[i] !== null) { v.push(macd[i]!); idxMap.push(i); }
  const sigEma = calcEMA(v, 9);
  const signal: (number|null)[] = new Array(c.length).fill(null);
  for (let k = 0; k < sigEma.length; k++) if (sigEma[k] !== null) signal[idxMap[k]] = sigEma[k];
  return c.map((_, i) => (macd[i] != null && signal[i] != null) ? macd[i]!-signal[i]! : null);
}

interface Feat {
  dnWick: number; upWick: number; body: number; isBull: number;
  volR: number; atrR: number; bbPos: number;
  dMA50: number; dMA200: number;
  mom5: number; mom10: number; mom20: number;
  rsi: number; stochK: number; macdH: number;
}
interface Mark { i: number; year: number; winner: boolean; }

const CONDS: Array<{ name: string; check: (f: Feat) => boolean }> = [
  { name: "distMA50 ≥ +2%",       check: f => f.dMA50 >= 2 },
  { name: "distMA50 ≥ +3%",       check: f => f.dMA50 >= 3 },
  { name: "distMA50 ≤ -2%",       check: f => f.dMA50 <= -2 },
  { name: "distMA200 ≥ +5%",      check: f => f.dMA200 >= 5 },
  { name: "distMA200 ≥ +10%",     check: f => f.dMA200 >= 10 },
  { name: "distMA200 ≤ -5%",      check: f => f.dMA200 <= -5 },
  { name: "mom5 ≥ +2%",           check: f => f.mom5 >= 2 },
  { name: "mom5 ≥ +1%",           check: f => f.mom5 >= 1 },
  { name: "mom5 ≤ -1%",           check: f => f.mom5 <= -1 },
  { name: "mom10 ≥ +2%",          check: f => f.mom10 >= 2 },
  { name: "mom20 ≥ +3%",          check: f => f.mom20 >= 3 },
  { name: "upWick ≥ 0.3%",        check: f => f.upWick >= 0.3 },
  { name: "upWick ≥ 0.5%",        check: f => f.upWick >= 0.5 },
  { name: "upWick ≥ 1.0%",        check: f => f.upWick >= 1.0 },
  { name: "dnWick ≥ 0.5%",        check: f => f.dnWick >= 0.5 },
  { name: "body ≥ 0.5%",          check: f => f.body >= 0.5 },
  { name: "body ≥ 1.0%",          check: f => f.body >= 1.0 },
  { name: "isBull",               check: f => f.isBull === 1 },
  { name: "isBear",               check: f => f.isBull === 0 },
  { name: "volR ≥ 2.0×",          check: f => f.volR >= 2.0 },
  { name: "volR ≥ 3.0×",          check: f => f.volR >= 3.0 },
  { name: "atrR ≥ 2.0×",          check: f => f.atrR >= 2.0 },
  { name: "RSI ≥ 70",             check: f => f.rsi >= 70 },
  { name: "RSI ≥ 80",             check: f => f.rsi >= 80 },
  { name: "RSI ≤ 30",             check: f => f.rsi <= 30 },
  { name: "stochK ≥ 80",          check: f => f.stochK >= 80 },
  { name: "stochK ≥ 95",          check: f => f.stochK >= 95 },
  { name: "stochK ≤ 20",          check: f => f.stochK <= 20 },
  { name: "bbPos ≥ 95%",          check: f => f.bbPos >= 95 },
  { name: "bbPos ≥ 100%",         check: f => f.bbPos >= 100 },
  { name: "bbPos ≤ 5%",           check: f => f.bbPos <= 5 },
  { name: "macdH ≥ 100",          check: f => f.macdH >= 100 },
  { name: "macdH ≤ -100",         check: f => f.macdH <= -100 },
  { name: "mom_all_up",           check: f => f.mom5 >= 0 && f.mom10 >= 0 && f.mom20 >= 0 },
  { name: "mom_all_down",         check: f => f.mom5 <= 0 && f.mom10 <= 0 && f.mom20 <= 0 },
];

function main() {
  console.log("[sweep-short-7y] Loading + features...");
  const c = loadCache();
  console.log(`  ${c.length.toLocaleString()} bars`);
  const closes = c.map(b => b.close);
  const vols = c.map(b => b.volume ?? 0);
  const rsi = calcRSI(closes, 14);
  const stochK = calcStochK(c, 14);
  const macdH = calcMACDHist(closes);
  const ma50 = calcSMA(closes, 50);
  const ma20 = calcSMA(closes, 20);
  const ma200 = calcSMA(closes, 200);
  const sd20 = calcStdev(closes, 20, ma20);
  const atr14 = calcATR(c, 14);
  const volMA20 = calcSMA(vols, 20);
  const allFeats: Feat[] = new Array(c.length);
  for (let i = 0; i < c.length; i++) {
    const bar = c[i];
    const dnWick = (Math.min(bar.open, bar.close) - bar.low) / bar.open * 100;
    const upWick = (bar.high - Math.max(bar.open, bar.close)) / bar.open * 100;
    const body = Math.abs(bar.close - bar.open) / bar.open * 100;
    const isBull = bar.close > bar.open ? 1 : 0;
    const volR = (volMA20[i] && volMA20[i]! > 0) ? (bar.volume ?? 0) / volMA20[i]! : 0;
    const atrR = atr14[i] ? (bar.high - bar.low) / atr14[i]! : 0;
    const bbPos = (ma20[i] !== null && sd20[i] !== null && sd20[i]! > 0)
      ? (bar.close - (ma20[i]! - 2*sd20[i]!)) / (4*sd20[i]!) * 100 : 50;
    const dMA50 = ma50[i] !== null ? (bar.close - ma50[i]!)/ma50[i]! * 100 : 0;
    const dMA200 = ma200[i] !== null ? (bar.close - ma200[i]!)/ma200[i]! * 100 : 0;
    const mom5 = i >= 6 ? (bar.close - c[i-6].close)/c[i-6].close * 100 : 0;
    const mom10 = i >= 11 ? (bar.close - c[i-11].close)/c[i-11].close * 100 : 0;
    const mom20 = i >= 21 ? (bar.close - c[i-21].close)/c[i-21].close * 100 : 0;
    allFeats[i] = { dnWick, upWick, body, isBull, volR, atrR, bbPos, dMA50, dMA200, mom5, mom10, mom20,
                    rsi: rsi[i] ?? 50, stochK: stochK[i] ?? 50, macdH: macdH[i] ?? 0 };
  }

  // === Mark SHORT (TP-2%/SL+1%/24h) ===
  console.log("[sweep-short-7y] Marking SHORT (TP-2%/SL+1%/24h)...");
  const marks: Mark[] = [];
  for (let i = 200; i < c.length - WINDOW_BARS; i++) {
    const entry = c[i].close;
    const tp = entry * (1 - TP_PCT/100);
    const sl = entry * (1 + SL_PCT/100);
    let won = false, lost = false;
    for (let j = i+1; j < i+1+WINDOW_BARS; j++) {
      if (c[j].high >= sl) { lost = true; break; }
      if (c[j].low <= tp) { won = true; break; }
    }
    if (won || lost) marks.push({ i, year: new Date(c[i].time).getUTCFullYear(), winner: won });
  }
  const totalWins = marks.filter(m => m.winner).length;
  const baseWR = totalWins / marks.length;
  console.log(`  Marked: ${marks.length.toLocaleString()}  Win: ${totalWins.toLocaleString()}  Baseline SHORT WR ${(baseWR*100).toFixed(2)}%`);
  console.log(`  Break-even WR: 36.67% (R:R 2:1 + fees 0.10%)`);

  // === Single feature lift ===
  console.log("\n=== TOP 15 SINGLE FEATURES (rank by WR) ===");
  interface Row { name: string; check: (f: Feat) => boolean; match: number; win: number; wr: number; lift: number; ev: number; roi: number; }
  const rows: Row[] = [];
  for (const co of CONDS) {
    let m = 0, w = 0;
    for (let k = 0; k < marks.length; k++) {
      if (!co.check(allFeats[marks[k].i])) continue;
      m++; if (marks[k].winner) w++;
    }
    if (m < 200) continue;
    const wr = w / m;
    const ev = wr * TP_PCT - (1-wr) * SL_PCT - 2*FEE_PER_SIDE_PCT;
    rows.push({ name: co.name, check: co.check, match: m, win: w, wr, lift: wr/baseWR, ev, roi: m*ev });
  }
  rows.sort((a, b) => b.wr - a.wr);
  console.log("Rank  Match    WR%      Lift   EV%       ROI 7y%");
  for (let r = 0; r < Math.min(15, rows.length); r++) {
    const x = rows[r];
    console.log(`${String(r+1).padStart(2)}    ${x.match.toString().padStart(6)}   ${(x.wr*100).toFixed(2).padStart(5)}%  ${x.lift.toFixed(2).padStart(4)}×  ${(x.ev>=0?'+':'')}${x.ev.toFixed(3).padStart(7)}%  ${(x.roi>=0?'+':'')}${x.roi.toFixed(1).padStart(6)}%`);
  }

  // === Combo AND (top 8 singles) ===
  console.log("\n=== TOP 15 COMBO AND (rank by WR) ===");
  const top = rows.slice(0, 8);
  interface ComboRow { name: string; depth: number; match: number; wr: number; lift: number; ev: number; roi: number; }
  const combos: ComboRow[] = [];
  // Pair
  for (let a = 0; a < top.length; a++) for (let b = a+1; b < top.length; b++) {
    let m = 0, w = 0;
    for (let k = 0; k < marks.length; k++) {
      if (!top[a].check(allFeats[marks[k].i]) || !top[b].check(allFeats[marks[k].i])) continue;
      m++; if (marks[k].winner) w++;
    }
    if (m < 100) continue;
    const wr = w/m;
    const ev = wr*TP_PCT - (1-wr)*SL_PCT - 2*FEE_PER_SIDE_PCT;
    combos.push({ name: `${top[a].name} AND ${top[b].name}`, depth: 2, match: m, wr: wr*100, lift: wr/baseWR, ev, roi: m*ev });
  }
  // Triple
  for (let a = 0; a < top.length; a++) for (let b = a+1; b < top.length; b++) for (let cc = b+1; cc < top.length; cc++) {
    let m = 0, w = 0;
    for (let k = 0; k < marks.length; k++) {
      if (!top[a].check(allFeats[marks[k].i]) || !top[b].check(allFeats[marks[k].i]) || !top[cc].check(allFeats[marks[k].i])) continue;
      m++; if (marks[k].winner) w++;
    }
    if (m < 100) continue;
    const wr = w/m;
    const ev = wr*TP_PCT - (1-wr)*SL_PCT - 2*FEE_PER_SIDE_PCT;
    combos.push({ name: `${top[a].name} AND ${top[b].name} AND ${top[cc].name}`, depth: 3, match: m, wr: wr*100, lift: wr/baseWR, ev, roi: m*ev });
  }
  combos.sort((a, b) => b.wr - a.wr);
  console.log("Rank  Match   WR%      Lift   EV%       ROI 7y%  D  Combo");
  for (let r = 0; r < Math.min(15, combos.length); r++) {
    const co = combos[r];
    console.log(`${String(r+1).padStart(2)}    ${co.match.toString().padStart(5)}   ${co.wr.toFixed(2).padStart(5)}%  ${co.lift.toFixed(2).padStart(4)}×  ${(co.ev>=0?'+':'')}${co.ev.toFixed(3).padStart(7)}%  ${(co.roi>=0?'+':'')}${co.roi.toFixed(1).padStart(6)}%  ${co.depth}  ${co.name}`);
  }

  // === Per-year breakdown cho top 3 combo + train/test ===
  console.log("\n=== TOP 3 COMBO — per-year + train/test ===");
  const top3 = combos.slice(0, 3);
  const splitIdx = Math.floor(marks.length * 0.7);
  function evalSlice(slice: Mark[], filter: (f: Feat) => boolean) {
    let m = 0, w = 0;
    for (const k of slice) {
      if (!filter(allFeats[k.i])) continue;
      m++; if (k.winner) w++;
    }
    const wr = m > 0 ? w/m : 0;
    const ev = m > 0 ? wr*TP_PCT - (1-wr)*SL_PCT - 2*FEE_PER_SIDE_PCT : 0;
    return { m, w, wr, roi: m*ev };
  }

  for (let r = 0; r < top3.length; r++) {
    const co = top3[r];
    // re-build check fn
    const parts = co.name.split(" AND ");
    const checks = parts.map(p => CONDS.find(c => c.name === p)!.check);
    const filter = (f: Feat) => checks.every(ch => ch(f));

    const trainR = evalSlice(marks.slice(0, splitIdx), filter);
    const testR = evalSlice(marks.slice(splitIdx), filter);

    // Per-year
    const years: Record<number, { m: number; w: number; roi: number }> = {};
    for (const k of marks) {
      if (!filter(allFeats[k.i])) continue;
      years[k.year] = years[k.year] || { m: 0, w: 0, roi: 0 };
      years[k.year].m++;
      if (k.winner) years[k.year].w++;
    }
    let posY = 0, totY = 0;
    for (const y in years) {
      const yr = years[+y];
      const wr = yr.m > 0 ? yr.w/yr.m : 0;
      const ev = wr*TP_PCT - (1-wr)*SL_PCT - 2*FEE_PER_SIDE_PCT;
      yr.roi = yr.m * ev;
      totY++;
      if (yr.roi > 0) posY++;
    }
    const yearKeys = Object.keys(years).map(Number).sort();

    console.log(`\nRank ${r+1}: ${co.name}`);
    console.log(`  Train (70%):  ${trainR.m.toString().padStart(4)} match  WR ${(trainR.wr*100).toFixed(2).padStart(5)}%  ROI ${(trainR.roi>=0?'+':'')}${trainR.roi.toFixed(1)}%`);
    console.log(`  Test (30%):   ${testR.m.toString().padStart(4)} match  WR ${(testR.wr*100).toFixed(2).padStart(5)}%  ROI ${(testR.roi>=0?'+':'')}${testR.roi.toFixed(1)}%`);
    console.log(`  Stability: ${posY}/${totY} years positive`);
    console.log(`  Per-year:`);
    for (const y of yearKeys) {
      const yr = years[y];
      const wr = yr.m > 0 ? yr.w/yr.m*100 : 0;
      console.log(`    ${y}:  ${yr.m.toString().padStart(4)}/${yr.w.toString().padStart(4)} WR ${wr.toFixed(1).padStart(5)}%  ROI ${(yr.roi>=0?'+':'')}${yr.roi.toFixed(0)}%`);
    }
  }

  console.log("\n[sweep-short-7y] ✅ Done");
}

main();
