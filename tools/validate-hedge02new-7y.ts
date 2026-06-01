/**
 * validate-hedge02new-7y.ts (anh Tommy 2026-05-14)
 *
 * Validate TOP combos từ 7y mark trên:
 *   1. Per-year breakdown (8 năm 2019-2026): edge có stable không?
 *   2. Train/test 70/30 chronological: lift retention?
 *   3. Multi-spec sweep: TP+1.5%/SL-1%, TP+1.5%/SL-0.5%, TP+2%/SL-1%
 *      → tìm spec + combo nào edge bền nhất trên 7y full cycle.
 *
 * Top combos validate:
 *   - C1: distMA50 ≥ +2% AND atrR ≥ 2.0× (best WR 46.37%)
 *   - C2: RSI ≥ 70 AND upWick ≥ 0.3% AND mom_all_up (best ROI +64.4%, 1946 trades)
 *   - C3: distMA50 ≥ +2% AND RSI ≥ 60 AND atrR ≥ 2.0×
 *   - C4: distMA50 ≤ -3% AND distMA200 ≤ -5% (cũ — confirm fail)
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

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

const COMBOS: Array<{ id: string; name: string; check: (f: Feat) => boolean }> = [
  { id: "C1", name: "distMA50≥+2% AND atrR≥2.0×",
    check: f => f.dMA50 >= 2 && f.atrR >= 2.0 },
  { id: "C2", name: "RSI≥70 AND upWick≥0.3% AND mom_all_up",
    check: f => f.rsi >= 70 && f.upWick >= 0.3 && f.mom5 >= 0 && f.mom10 >= 0 && f.mom20 >= 0 },
  { id: "C3", name: "distMA50≥+2% AND RSI≥60 AND atrR≥2.0×",
    check: f => f.dMA50 >= 2 && f.rsi >= 60 && f.atrR >= 2.0 },
  { id: "C4", name: "distMA50≤-3% AND distMA200≤-5% (cũ)",
    check: f => f.dMA50 <= -3 && f.dMA200 <= -5 },
];

function evalSet(marks: Mark[], tp: number, sl: number, allFeats: Feat[], filter?: (f: Feat) => boolean) {
  let total = 0, win = 0;
  for (const m of marks) {
    if (filter && !filter(allFeats[m.i])) continue;
    total++;
    if (m.winner) win++;
  }
  const wr = total > 0 ? win / total : 0;
  const ev = wr * tp - (1-wr) * sl - 2 * FEE_PER_SIDE_PCT;
  const roi = total * ev;
  return { total, win, wr, ev, roi };
}

function markSpec(c: Candle[], tpPct: number, slPct: number): Mark[] {
  const marks: Mark[] = [];
  for (let i = 200; i < c.length - WINDOW_BARS; i++) {
    const entry = c[i].close;
    const tp = entry * (1 + tpPct/100);
    const sl = entry * (1 - slPct/100);
    let won = false, lost = false;
    for (let j = i+1; j < i+1+WINDOW_BARS; j++) {
      if (c[j].low <= sl) { lost = true; break; }
      if (c[j].high >= tp) { won = true; break; }
    }
    if (won || lost) marks.push({ i, year: new Date(c[i].time).getUTCFullYear(), winner: won });
  }
  return marks;
}

function computeAllFeats(c: Candle[]): Feat[] {
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
  const feats: Feat[] = new Array(c.length);
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
    feats[i] = { dnWick, upWick, body, isBull, volR, atrR, bbPos, dMA50, dMA200, mom5, mom10, mom20,
                 rsi: rsi[i] ?? 50, stochK: stochK[i] ?? 50, macdH: macdH[i] ?? 0 };
  }
  return feats;
}

function main() {
  console.log("[validate-7y] Loading + computing features...");
  const c = loadCache();
  const yearStart = new Date(c[0].time).getUTCFullYear();
  const yearEnd = new Date(c[c.length-1].time).getUTCFullYear();
  console.log(`  ${c.length.toLocaleString()} bars, ${yearStart}-${yearEnd}`);
  const allFeats = computeAllFeats(c);

  const SPECS = [
    { label: "A", tp: 1.5, sl: 1.0 },
    { label: "B", tp: 1.5, sl: 0.5 },
    { label: "C", tp: 2.0, sl: 1.0 },
  ];

  for (const sp of SPECS) {
    const beW = ((sp.sl + 2*FEE_PER_SIDE_PCT) / (sp.tp + sp.sl) * 100).toFixed(2);
    console.log(`\n${"=".repeat(95)}\n[SPEC ${sp.label}] TP+${sp.tp}% / SL-${sp.sl}% / 24h LONG  (break-even ${beW}%)\n${"=".repeat(95)}`);
    const marks = markSpec(c, sp.tp, sp.sl);
    const totalWins = marks.filter(m => m.winner).length;
    const baseWR = totalWins / marks.length;
    console.log(`Marked: ${marks.length.toLocaleString()}  Win: ${totalWins.toLocaleString()}  WR ${(baseWR*100).toFixed(2)}%`);

    // Per-combo: train/test split + per-year stability
    const splitIdx = Math.floor(marks.length * 0.7);
    const trainMarks = marks.slice(0, splitIdx);
    const testMarks = marks.slice(splitIdx);
    const trainSpan = `${new Date(c[trainMarks[0].i].time).toISOString().slice(0,10)} → ${new Date(c[trainMarks[trainMarks.length-1].i].time).toISOString().slice(0,10)}`;
    const testSpan  = `${new Date(c[testMarks[0].i].time).toISOString().slice(0,10)} → ${new Date(c[testMarks[testMarks.length-1].i].time).toISOString().slice(0,10)}`;

    for (const co of COMBOS) {
      const train = evalSet(trainMarks, sp.tp, sp.sl, allFeats, co.check);
      const test = evalSet(testMarks, sp.tp, sp.sl, allFeats, co.check);
      // Per-year
      const years: Record<number, { match: number; win: number; wr: number; roi: number }> = {};
      let posYears = 0, totalYears = 0;
      for (const m of marks) {
        if (!co.check(allFeats[m.i])) continue;
        years[m.year] = years[m.year] || { match: 0, win: 0, wr: 0, roi: 0 };
        years[m.year].match++;
        if (m.winner) years[m.year].win++;
      }
      for (const y in years) {
        const yr = years[+y];
        yr.wr = yr.win / yr.match;
        const ev = yr.wr * sp.tp - (1-yr.wr) * sp.sl - 2*FEE_PER_SIDE_PCT;
        yr.roi = yr.match * ev;
        totalYears++;
        if (yr.roi > 0) posYears++;
      }
      const stability = totalYears > 0 ? (posYears / totalYears * 100).toFixed(0) : "—";
      const yearKeys = Object.keys(years).map(Number).sort();
      const yearStr = yearKeys.map(y => `${y}:${years[y].roi >= 0 ? '+' : ''}${years[y].roi.toFixed(0)}%(${years[y].match})`).join("  ");

      const trainLift = train.wr > 0 && trainMarks.filter(m => m.winner).length / trainMarks.length > 0 ? train.wr / (trainMarks.filter(m => m.winner).length / trainMarks.length) : 0;
      const testLift = test.wr > 0 && testMarks.filter(m => m.winner).length / testMarks.length > 0 ? test.wr / (testMarks.filter(m => m.winner).length / testMarks.length) : 0;

      console.log(`\n  ${co.id} — ${co.name}`);
      console.log(`    Train  ${train.total.toString().padStart(5)} match  WR ${(train.wr*100).toFixed(2).padStart(5)}%  lift ${trainLift.toFixed(2)}×  EV ${(train.ev>=0?'+':'')}${train.ev.toFixed(3)}%  ROI ${(train.roi>=0?'+':'')}${train.roi.toFixed(1)}%`);
      console.log(`    Test   ${test.total.toString().padStart(5)} match  WR ${(test.wr*100).toFixed(2).padStart(5)}%  lift ${testLift.toFixed(2)}×  EV ${(test.ev>=0?'+':'')}${test.ev.toFixed(3)}%  ROI ${(test.roi>=0?'+':'')}${test.roi.toFixed(1)}%`);
      console.log(`    Years positive: ${posYears}/${totalYears}  (stability ${stability}%)`);
      console.log(`    Per-year ROI:  ${yearStr}`);
    }
  }

  console.log(`\n[validate-7y] ✅ Done`);
}

main();
