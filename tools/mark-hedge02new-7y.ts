/**
 * mark-hedge02new-7y.ts (anh Tommy 2026-05-14)
 *
 * SPEC A focus: TP+1.5% / SL-1% / 24h LONG.
 * Best combo từ analysis 3y: distMA50≤-3% AND distMA200≤-5%
 *
 * Mục tiêu:
 *   1. Re-mark + re-rank combo trên data 7y (Binance Spot 5m từ Jan 2019)
 *   2. Per-year breakdown WR/match/ROI để check edge stability
 *   3. Train/test split (70% train / 30% test out-of-sample)
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const TP_PCT = 1.5;
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

interface Mark { i: number; year: number; winner: boolean; }
interface Feat {
  dnWick: number; upWick: number; body: number; isBull: number;
  volR: number; atrR: number; bbPos: number;
  dMA50: number; dMA200: number;
  mom5: number; mom10: number; mom20: number;
  rsi: number; stochK: number; macdH: number;
}

const CONDS: Array<{ name: string; check: (f: Feat) => boolean }> = [
  { name: "distMA50 ≤ -3%",    check: f => f.dMA50 <= -3 },
  { name: "distMA50 ≤ -2%",    check: f => f.dMA50 <= -2 },
  { name: "distMA50 ≤ -1%",    check: f => f.dMA50 <= -1 },
  { name: "distMA50 ≥ +2%",    check: f => f.dMA50 >= 2 },
  { name: "distMA200 ≤ -5%",   check: f => f.dMA200 <= -5 },
  { name: "distMA200 ≤ -3%",   check: f => f.dMA200 <= -3 },
  { name: "mom5 ≤ -2%",        check: f => f.mom5 <= -2 },
  { name: "mom5 ≤ -1%",        check: f => f.mom5 <= -1 },
  { name: "mom10 ≤ -2%",       check: f => f.mom10 <= -2 },
  { name: "mom20 ≤ -3%",       check: f => f.mom20 <= -3 },
  { name: "upWick ≥ 0.3%",     check: f => f.upWick >= 0.3 },
  { name: "upWick ≥ 0.5%",     check: f => f.upWick >= 0.5 },
  { name: "dnWick ≥ 0.5%",     check: f => f.dnWick >= 0.5 },
  { name: "body ≥ 0.5%",       check: f => f.body >= 0.5 },
  { name: "isBull",            check: f => f.isBull === 1 },
  { name: "isBear",            check: f => f.isBull === 0 },
  { name: "volR ≥ 2.0×",       check: f => f.volR >= 2.0 },
  { name: "volR ≥ 3.0×",       check: f => f.volR >= 3.0 },
  { name: "atrR ≥ 1.5×",       check: f => f.atrR >= 1.5 },
  { name: "atrR ≥ 2.0×",       check: f => f.atrR >= 2.0 },
  { name: "RSI ≥ 60",          check: f => f.rsi >= 60 },
  { name: "RSI ≥ 70",          check: f => f.rsi >= 70 },
  { name: "RSI ≤ 30",          check: f => f.rsi <= 30 },
  { name: "stochK ≥ 70",       check: f => f.stochK >= 70 },
  { name: "stochK ≥ 80",       check: f => f.stochK >= 80 },
  { name: "bbPos ≥ 80%",       check: f => f.bbPos >= 80 },
  { name: "bbPos ≥ 95%",       check: f => f.bbPos >= 95 },
  { name: "bbPos ≤ 5%",        check: f => f.bbPos <= 5 },
  { name: "macdH ≥ 50",        check: f => f.macdH >= 50 },
  { name: "macdH ≥ 100",       check: f => f.macdH >= 100 },
  { name: "mom_all_up",        check: f => f.mom5 >= 0 && f.mom10 >= 0 && f.mom20 >= 0 },
  { name: "mom_all_down",      check: f => f.mom5 < 0 && f.mom10 < 0 && f.mom20 < 0 },
];

function main() {
  console.log(`[mark-7y] Loading 7y data + computing features...`);
  const c = loadCache();
  const yearStart = new Date(c[0].time).getUTCFullYear();
  const yearEnd = new Date(c[c.length-1].time).getUTCFullYear();
  console.log(`  ${c.length.toLocaleString()} bars, ${yearStart} → ${yearEnd}`);

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
  const meanPrice = closes.reduce((s, v) => s + v, 0) / closes.length;

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

  // === Mark SPEC A ===
  console.log(`\n[mark-7y] Marking SPEC A (TP+${TP_PCT}%/SL-${SL_PCT}%/24h LONG)...`);
  const marks: Mark[] = [];
  for (let i = 200; i < c.length - WINDOW_BARS; i++) {
    const entry = c[i].close;
    const tp = entry * (1 + TP_PCT/100);
    const sl = entry * (1 - SL_PCT/100);
    let won = false, lost = false;
    for (let j = i+1; j < i+1+WINDOW_BARS; j++) {
      if (c[j].low <= sl) { lost = true; break; }
      if (c[j].high >= tp) { won = true; break; }
    }
    if (won || lost) marks.push({ i, year: new Date(c[i].time).getUTCFullYear(), winner: won });
  }
  const totalMarks = marks.length;
  const totalWins = marks.filter(m => m.winner).length;
  const baseWR = totalWins / totalMarks;
  console.log(`  Total: ${totalMarks.toLocaleString()} | Win: ${totalWins.toLocaleString()} | WR ${(baseWR*100).toFixed(2)}%`);

  // === Best combo apply: distMA50 ≤ -3% AND distMA200 ≤ -5% ===
  const BEST_COMBO = (f: Feat) => f.dMA50 <= -3 && f.dMA200 <= -5;

  // === Per-year breakdown (full no-filter) ===
  console.log(`\n=== PER-YEAR BREAKDOWN: NO FILTER vs BEST COMBO ===`);
  console.log(`Year   Bars   |  NoFilter: Marked    Win    WR%      EV%/trade  ROI%`);
  console.log(`              |  BestCombo: Match   Win    WR%      EV%/trade  ROI%   Lift`);
  console.log(`-----  ------ |  ------------------------------------------------------`);
  const yearStats: Record<number, any> = {};
  for (let y = yearStart; y <= yearEnd; y++) {
    const yMarks = marks.filter(m => m.year === y);
    if (yMarks.length === 0) continue;
    const yWins = yMarks.filter(m => m.winner).length;
    const yWR = yWins / yMarks.length;
    const yEv = yWR * TP_PCT - (1-yWR) * SL_PCT - 2*FEE_PER_SIDE_PCT;
    const yRoi = yMarks.length * yEv;
    // Best combo
    let cMatch = 0, cWin = 0;
    for (const m of yMarks) {
      if (BEST_COMBO(allFeats[m.i])) {
        cMatch++;
        if (m.winner) cWin++;
      }
    }
    const cWR = cMatch > 0 ? cWin / cMatch : 0;
    const cEv = cWR * TP_PCT - (1-cWR) * SL_PCT - 2*FEE_PER_SIDE_PCT;
    const cRoi = cMatch * cEv;
    const cLift = baseWR > 0 ? cWR / yWR : 0;
    yearStats[y] = { marked: yMarks.length, wins: yWins, wr: yWR, ev: yEv, roi: yRoi,
                     combo_match: cMatch, combo_wins: cWin, combo_wr: cWR, combo_ev: cEv, combo_roi: cRoi, combo_lift: cLift };
    console.log(`${y}   ${yMarks.length.toString().padStart(6)} |  NoFilter: ${yMarks.length.toString().padStart(7)} ${yWins.toString().padStart(6)}  ${(yWR*100).toFixed(2).padStart(5)}%   ${(yEv>=0?'+':'')}${yEv.toFixed(3).padStart(7)}%  ${(yRoi>=0?'+':'')}${yRoi.toFixed(1).padStart(7)}%`);
    console.log(`              |  Combo:    ${cMatch.toString().padStart(7)} ${cWin.toString().padStart(6)}  ${(cWR*100).toFixed(2).padStart(5)}%   ${(cEv>=0?'+':'')}${cEv.toFixed(3).padStart(7)}%  ${(cRoi>=0?'+':'')}${cRoi.toFixed(1).padStart(7)}%  ${cLift.toFixed(2)}×`);
  }

  // === Train / test split 70/30 chronological ===
  const splitIdx = Math.floor(marks.length * 0.7);
  const trainMarks = marks.slice(0, splitIdx);
  const testMarks = marks.slice(splitIdx);

  const trainSpan = trainMarks.length > 0 ? `${new Date(c[trainMarks[0].i].time).toISOString().slice(0,10)} → ${new Date(c[trainMarks[trainMarks.length-1].i].time).toISOString().slice(0,10)}` : "—";
  const testSpan  = testMarks.length > 0  ? `${new Date(c[testMarks[0].i].time).toISOString().slice(0,10)} → ${new Date(c[testMarks[testMarks.length-1].i].time).toISOString().slice(0,10)}` : "—";

  function evalSet(set: Mark[], filter?: (f: Feat) => boolean) {
    let total = 0, win = 0;
    for (const m of set) {
      if (filter && !filter(allFeats[m.i])) continue;
      total++;
      if (m.winner) win++;
    }
    const wr = total > 0 ? win / total : 0;
    const ev = wr * TP_PCT - (1-wr) * SL_PCT - 2*FEE_PER_SIDE_PCT;
    const roi = total * ev;
    return { total, win, wr, ev, roi };
  }

  console.log(`\n=== TRAIN / TEST SPLIT (70/30 chronological) ===`);
  console.log(`Train span: ${trainSpan}  (${trainMarks.length.toLocaleString()} marks)`);
  console.log(`Test span:  ${testSpan}  (${testMarks.length.toLocaleString()} marks)`);

  const trainAll = evalSet(trainMarks);
  const testAll  = evalSet(testMarks);
  const trainCombo = evalSet(trainMarks, BEST_COMBO);
  const testCombo  = evalSet(testMarks, BEST_COMBO);

  console.log(`\n            Marked   Win    WR%     EV%/trade  ROI%`);
  console.log(`Train NoFilter   ${trainAll.total.toString().padStart(7)} ${trainAll.win.toString().padStart(6)}  ${(trainAll.wr*100).toFixed(2).padStart(5)}%  ${(trainAll.ev>=0?'+':'')}${trainAll.ev.toFixed(3).padStart(7)}%  ${(trainAll.roi>=0?'+':'')}${trainAll.roi.toFixed(1).padStart(6)}%`);
  console.log(`Train Combo      ${trainCombo.total.toString().padStart(7)} ${trainCombo.win.toString().padStart(6)}  ${(trainCombo.wr*100).toFixed(2).padStart(5)}%  ${(trainCombo.ev>=0?'+':'')}${trainCombo.ev.toFixed(3).padStart(7)}%  ${(trainCombo.roi>=0?'+':'')}${trainCombo.roi.toFixed(1).padStart(6)}%`);
  console.log(`Test  NoFilter   ${testAll.total.toString().padStart(7)} ${testAll.win.toString().padStart(6)}  ${(testAll.wr*100).toFixed(2).padStart(5)}%  ${(testAll.ev>=0?'+':'')}${testAll.ev.toFixed(3).padStart(7)}%  ${(testAll.roi>=0?'+':'')}${testAll.roi.toFixed(1).padStart(6)}%`);
  console.log(`Test  Combo      ${testCombo.total.toString().padStart(7)} ${testCombo.win.toString().padStart(6)}  ${(testCombo.wr*100).toFixed(2).padStart(5)}%  ${(testCombo.ev>=0?'+':'')}${testCombo.ev.toFixed(3).padStart(7)}%  ${(testCombo.roi>=0?'+':'')}${testCombo.roi.toFixed(1).padStart(6)}%`);

  // Lift retention
  const trainLift = trainAll.wr > 0 ? trainCombo.wr / trainAll.wr : 0;
  const testLift  = testAll.wr  > 0 ? testCombo.wr  / testAll.wr  : 0;
  const liftRetention = trainLift > 0 ? testLift / trainLift : 0;
  console.log(`\nLift train: ${trainLift.toFixed(2)}×    Lift test: ${testLift.toFixed(2)}×    Retention: ${(liftRetention*100).toFixed(1)}%`);
  console.log(testCombo.wr >= 0.44 ? `✅ Test WR ${(testCombo.wr*100).toFixed(2)}% ≥ break-even 44% — combo có edge out-of-sample` : `⚠️ Test WR ${(testCombo.wr*100).toFixed(2)}% < break-even 44% — combo KHÔNG retain edge out-of-sample`);

  // === Re-run combo sweep trên 7y to confirm same winner ===
  console.log(`\n=== TOP 10 COMBO (re-rank by WR trên full 7y) ===`);
  interface ComboRow { name: string; depth: number; match: number; wr: number; lift: number; ev: number; roi: number; }
  const combos: ComboRow[] = [];
  const topSingles: typeof CONDS = [];
  // First: rank single features
  const singleRows: Array<{ co: typeof CONDS[0]; match: number; wr: number; lift: number }> = [];
  for (const co of CONDS) {
    let m = 0, w = 0;
    for (let k = 0; k < marks.length; k++) {
      if (!co.check(allFeats[marks[k].i])) continue;
      m++;
      if (marks[k].winner) w++;
    }
    if (m < 200) continue;
    const wr = w / m;
    singleRows.push({ co, match: m, wr, lift: wr / baseWR });
  }
  singleRows.sort((a, b) => b.lift - a.lift);
  topSingles.push(...singleRows.slice(0, 8).map(s => s.co));
  // Pair + triple
  for (let a = 0; a < topSingles.length; a++) {
    for (let b = a+1; b < topSingles.length; b++) {
      let m = 0, w = 0;
      for (let k = 0; k < marks.length; k++) {
        if (!topSingles[a].check(allFeats[marks[k].i]) || !topSingles[b].check(allFeats[marks[k].i])) continue;
        m++; if (marks[k].winner) w++;
      }
      if (m < 100) continue;
      const wr = w / m;
      combos.push({ name: `${topSingles[a].name} AND ${topSingles[b].name}`, depth: 2, match: m, wr: wr*100, lift: wr/baseWR, ev: wr*TP_PCT-(1-wr)*SL_PCT-2*FEE_PER_SIDE_PCT, roi: m*(wr*TP_PCT-(1-wr)*SL_PCT-2*FEE_PER_SIDE_PCT) });
    }
  }
  for (let a = 0; a < topSingles.length; a++) {
    for (let b = a+1; b < topSingles.length; b++) {
      for (let cc = b+1; cc < topSingles.length; cc++) {
        let m = 0, w = 0;
        for (let k = 0; k < marks.length; k++) {
          if (!topSingles[a].check(allFeats[marks[k].i]) || !topSingles[b].check(allFeats[marks[k].i]) || !topSingles[cc].check(allFeats[marks[k].i])) continue;
          m++; if (marks[k].winner) w++;
        }
        if (m < 100) continue;
        const wr = w / m;
        combos.push({ name: `${topSingles[a].name} AND ${topSingles[b].name} AND ${topSingles[cc].name}`, depth: 3, match: m, wr: wr*100, lift: wr/baseWR, ev: wr*TP_PCT-(1-wr)*SL_PCT-2*FEE_PER_SIDE_PCT, roi: m*(wr*TP_PCT-(1-wr)*SL_PCT-2*FEE_PER_SIDE_PCT) });
      }
    }
  }
  combos.sort((a, b) => b.wr - a.wr);
  console.log(`Rank  Match   WR%      Lift   EV%/trade   ROI 7y%  D  Combo`);
  for (let r = 0; r < Math.min(10, combos.length); r++) {
    const co = combos[r];
    console.log(`${String(r+1).padStart(2)}    ${co.match.toString().padStart(5)}   ${co.wr.toFixed(2).padStart(6)}%  ${co.lift.toFixed(2).padStart(4)}×  ${(co.ev>=0?'+':'')}${co.ev.toFixed(3).padStart(7)}%   ${(co.roi>=0?'+':'')}${co.roi.toFixed(1).padStart(6)}%  ${co.depth}  ${co.name}`);
  }

  // Save summary
  const outPath = join(__dirname, "..", "assets", "mark_hedge02new_7y_summary.json");
  writeFileSync(outPath, JSON.stringify({
    spec: { TP_PCT, SL_PCT, WINDOW_BARS, side: "LONG" },
    data_source: "Binance Spot BTCUSDT 5m, 7y",
    bars: c.length,
    year_range: [yearStart, yearEnd],
    baseline: { total: totalMarks, wins: totalWins, wr: baseWR },
    best_combo: { name: "distMA50 ≤ -3% AND distMA200 ≤ -5%",
      train: trainCombo, test: testCombo, train_lift: trainLift, test_lift: testLift, retention: liftRetention },
    per_year: yearStats,
    top_combos_by_wr: combos.slice(0, 20),
  }, null, 2));
  console.log(`\n[mark-7y] ✅ Summary saved → ${outPath}`);
}

main();
