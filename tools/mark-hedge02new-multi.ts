/**
 * mark-hedge02new-multi.ts (anh Tommy 2026-05-14)
 *
 * So sánh 3 spec SLTP cho hedge02-new:
 *   A. TP+1.5% / SL-1.0% (R:R 1.5:1, break-even 44% sau fees)
 *   B. TP+2.0% / SL-1.0% (R:R 2:1,   break-even 35% sau fees)
 *   C. TP+1.5% / SL-0.5% (R:R 3:1,   break-even 26% sau fees)
 *
 * Window 24h (288 bars 5m), LONG only.
 *
 * Mỗi spec: mark winners + lift table single feature + combo AND (top 2 / top 3).
 * Combo dùng để boost lift ≥ 1.5× và match ≥ 500 trades / 3y (frequency rule production).
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const WINDOW_BARS = 288;
const FEE_PER_SIDE_PCT = 0.05;
const POS_BTC = 0.001;

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }

function loadCache(tf: string): Candle[] {
  return JSON.parse(readFileSync(join(__dirname, "..", ".cache", `binance-${tf}-3y.json`), "utf8"));
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

interface Mark { i: number; winner: boolean; }
interface Feat {
  dnWick: number; upWick: number; body: number; isBull: number;
  volR: number; atrR: number; bbPos: number;
  dMA50: number; dMA200: number;
  mom5: number; mom10: number; mom20: number;
  rsi: number; stochK: number; macdH: number;
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
    if (won) marks.push({ i, winner: true });
    else if (lost) marks.push({ i, winner: false });
    // timeout: skip
  }
  return marks;
}

const CONDS: Array<{ name: string; check: (f: Feat) => boolean }> = [
  { name: "distMA50 ≤ -3%",    check: f => f.dMA50 <= -3 },
  { name: "distMA50 ≤ -2%",    check: f => f.dMA50 <= -2 },
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
  { name: "stochK ≥ 70",       check: f => f.stochK >= 70 },
  { name: "stochK ≥ 80",       check: f => f.stochK >= 80 },
  { name: "stochK ≤ 30",       check: f => f.stochK <= 30 },
  { name: "bbPos ≥ 80%",       check: f => f.bbPos >= 80 },
  { name: "bbPos ≥ 95%",       check: f => f.bbPos >= 95 },
  { name: "bbPos ≤ 5%",        check: f => f.bbPos <= 5 },
  { name: "macdH ≥ 50",        check: f => f.macdH >= 50 },
  { name: "macdH ≥ 100",       check: f => f.macdH >= 100 },
  { name: "mom_all_up",        check: f => f.mom5 >= 0 && f.mom10 >= 0 && f.mom20 >= 0 },
  { name: "mom_all_down",      check: f => f.mom5 < 0 && f.mom10 < 0 && f.mom20 < 0 },
];

function analyzeSpec(label: string, tpPct: number, slPct: number, c: Candle[], allFeats: Feat[], meanPrice: number) {
  console.log(`\n${"=".repeat(80)}\n[SPEC ${label}] TP+${tpPct}% / SL-${slPct}% / 24h / LONG\n${"=".repeat(80)}`);
  const breakEvenRaw = slPct / (tpPct + slPct);
  const beWithFees = (slPct + 2*FEE_PER_SIDE_PCT) / (tpPct + slPct);
  console.log(`Break-even WR: raw ${(breakEvenRaw*100).toFixed(2)}% / with fees ${(beWithFees*100).toFixed(2)}%`);

  const marks = markSpec(c, tpPct, slPct);
  const wins = marks.filter(m => m.winner).length;
  const losses = marks.length - wins;
  const total = marks.length;
  const wr = wins / total;
  console.log(`Marked: ${total.toLocaleString()} (win ${wins.toLocaleString()} / loss ${losses.toLocaleString()})  baseline WR ${(wr*100).toFixed(2)}%`);

  const ev = wr * tpPct - (1-wr) * slPct - 2 * FEE_PER_SIDE_PCT;  // pct
  const evUsd = (POS_BTC * meanPrice) * (ev/100);
  console.log(`No-filter EV/trade: ${(ev>0?'+':'')}${ev.toFixed(4)}% ≈ ${(evUsd>0?'+':'')}$${evUsd.toFixed(3)}`);

  // Pre-compute feature → marker WR (single condition)
  interface LiftRow { name: string; check: (f: Feat) => boolean; match: number; matchWin: number; wr: number; lift: number; ev: number; evUsd: number; }
  const liftRows: LiftRow[] = [];
  // Pre-extract marked feats
  const markedFeats = marks.map(m => allFeats[m.i]);
  for (const co of CONDS) {
    let m = 0, mw = 0;
    for (let k = 0; k < marks.length; k++) {
      if (!co.check(markedFeats[k])) continue;
      m++;
      if (marks[k].winner) mw++;
    }
    if (m < 100) continue;
    const mwr = mw / m;
    const lift = mwr / wr;
    const evPct = mwr * tpPct - (1-mwr) * slPct - 2*FEE_PER_SIDE_PCT;
    const evU = (POS_BTC * meanPrice) * (evPct/100);
    liftRows.push({ name: co.name, check: co.check, match: m, matchWin: mw, wr: mwr*100, lift, ev: evPct, evUsd: evU });
  }
  liftRows.sort((a, b) => b.lift - a.lift);

  console.log(`\nTop 12 single-feature lift:`);
  console.log(`Rank  Feature              Match     WR%     Lift    EV%        EV/trade`);
  for (let r = 0; r < Math.min(12, liftRows.length); r++) {
    const l = liftRows[r];
    console.log(`${String(r+1).padStart(2)}    ${l.name.padEnd(20)} ${l.match.toString().padStart(7)}  ${l.wr.toFixed(2).padStart(5)}%  ${l.lift.toFixed(2).padStart(4)}×   ${(l.ev>=0?'+':'')}${l.ev.toFixed(3).padStart(6)}%  ${(l.evUsd>=0?'+':'')}$${l.evUsd.toFixed(3)}`);
  }

  // === Combo AND filter — RANK BY WR (anh Tommy focus WR + ROI%) ===
  console.log(`\nTop 15 combo AND (top 8 singles × pairs + triples + quads) — RANK BY WR:`);
  const topSingles = liftRows.slice(0, 8);
  interface ComboRow { name: string; depth: number; match: number; wr: number; lift: number; evPct: number; roi3y: number; }
  const combos: ComboRow[] = [];
  const pushCombo = (name: string, depth: number, m: number, mw: number) => {
    if (m < 100) return;
    const mwr = mw / m;
    const lift = mwr / wr;
    const evPct = mwr * tpPct - (1-mwr) * slPct - 2*FEE_PER_SIDE_PCT;
    const roi3y = m * evPct;   // cumulative ROI% 3y (linear, fixed position)
    combos.push({ name, depth, match: m, wr: mwr*100, lift, evPct, roi3y });
  };
  // Pair
  for (let a = 0; a < topSingles.length; a++) {
    for (let b = a+1; b < topSingles.length; b++) {
      const A = topSingles[a], B = topSingles[b];
      let m = 0, mw = 0;
      for (let k = 0; k < marks.length; k++) {
        if (!A.check(markedFeats[k]) || !B.check(markedFeats[k])) continue;
        m++;
        if (marks[k].winner) mw++;
      }
      pushCombo(`${A.name} AND ${B.name}`, 2, m, mw);
    }
  }
  // Triple
  for (let a = 0; a < topSingles.length; a++) {
    for (let b = a+1; b < topSingles.length; b++) {
      for (let cc = b+1; cc < topSingles.length; cc++) {
        const A = topSingles[a], B = topSingles[b], C = topSingles[cc];
        let m = 0, mw = 0;
        for (let k = 0; k < marks.length; k++) {
          if (!A.check(markedFeats[k]) || !B.check(markedFeats[k]) || !C.check(markedFeats[k])) continue;
          m++;
          if (marks[k].winner) mw++;
        }
        pushCombo(`${A.name} AND ${B.name} AND ${C.name}`, 3, m, mw);
      }
    }
  }
  // Quad — chỉ thử nếu có pair/triple ≥ 200 match (tránh overfit)
  for (let a = 0; a < topSingles.length; a++) {
    for (let b = a+1; b < topSingles.length; b++) {
      for (let cc = b+1; cc < topSingles.length; cc++) {
        for (let d = cc+1; d < topSingles.length; d++) {
          const A = topSingles[a], B = topSingles[b], C = topSingles[cc], D = topSingles[d];
          let m = 0, mw = 0;
          for (let k = 0; k < marks.length; k++) {
            if (!A.check(markedFeats[k]) || !B.check(markedFeats[k]) || !C.check(markedFeats[k]) || !D.check(markedFeats[k])) continue;
            m++;
            if (marks[k].winner) mw++;
          }
          pushCombo(`${A.name} AND ${B.name} AND ${C.name} AND ${D.name}`, 4, m, mw);
        }
      }
    }
  }
  combos.sort((a, b) => b.wr - a.wr);
  console.log(`Rank  Match  WR%      Lift   EV%/trade  ROI 3y%  D  Combo`);
  console.log(`----  -----  -------  -----  ---------  -------  -  -----`);
  for (let r = 0; r < Math.min(15, combos.length); r++) {
    const co = combos[r];
    console.log(`${String(r+1).padStart(2)}    ${co.match.toString().padStart(5)}  ${co.wr.toFixed(2).padStart(6)}%  ${co.lift.toFixed(2).padStart(4)}×  ${(co.evPct>=0?'+':'')}${co.evPct.toFixed(3).padStart(7)}%  ${(co.roi3y>=0?'+':'')}${co.roi3y.toFixed(1).padStart(6)}%  ${co.depth}  ${co.name}`);
  }

  // Also show best by ROI 3y (volume × edge) cho complete picture
  combos.sort((a, b) => b.roi3y - a.roi3y);
  console.log(`\nTop 5 combo by CUMULATIVE ROI 3y (volume × edge):`);
  for (let r = 0; r < Math.min(5, combos.length); r++) {
    const co = combos[r];
    console.log(`${String(r+1).padStart(2)}    ${co.match.toString().padStart(5)}  ${co.wr.toFixed(2).padStart(6)}%  ${co.lift.toFixed(2).padStart(4)}×  ${(co.evPct>=0?'+':'')}${co.evPct.toFixed(3).padStart(7)}%  ${(co.roi3y>=0?'+':'')}${co.roi3y.toFixed(1).padStart(6)}%  ${co.depth}  ${co.name}`);
  }

  return { label, tpPct, slPct, baseline_wr: wr, baseline_match: total,
           top_combos_by_wr: [...combos].sort((a, b) => b.wr - a.wr).slice(0, 10),
           top_combos_by_roi: [...combos].sort((a, b) => b.roi3y - a.roi3y).slice(0, 10),
           top_singles: liftRows.slice(0, 10) };
}

function main() {
  console.log("[mark-multi] Loading 5m cache + computing features (one-pass)...");
  const c = loadCache("5m");
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
  console.log(`  ${c.length} bars, mean price $${meanPrice.toFixed(0)}`);

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

  const SPECS = [
    { label: "A", tp: 1.5, sl: 1.0 },
    { label: "B", tp: 2.0, sl: 1.0 },
    { label: "C", tp: 1.5, sl: 0.5 },
  ];
  const results = SPECS.map(s => analyzeSpec(s.label, s.tp, s.sl, c, allFeats, meanPrice));

  console.log(`\n${"=".repeat(80)}\nSIDE-BY-SIDE SUMMARY — best combo by WR & by ROI 3y\n${"=".repeat(80)}`);
  for (const r of results) {
    const byWR = r.top_combos_by_wr[0];
    const byROI = r.top_combos_by_roi[0];
    const rr = (r.tpPct/r.slPct).toFixed(2);
    const beWFee = ((r.slPct + 2*FEE_PER_SIDE_PCT) / (r.tpPct + r.slPct) * 100).toFixed(2);
    console.log(`\n[SPEC ${r.label}] TP+${r.tpPct}%/SL-${r.slPct}% (R:R ${rr}:1)  base WR ${(r.baseline_wr*100).toFixed(2)}%  break-even ${beWFee}%`);
    if (byWR) console.log(`  Best WR:  WR ${byWR.wr.toFixed(2)}%  match ${byWR.match}  lift ${byWR.lift.toFixed(2)}×  EV ${(byWR.evPct>=0?'+':'')}${byWR.evPct.toFixed(3)}%/trade  ROI3y ${(byWR.roi3y>=0?'+':'')}${byWR.roi3y.toFixed(1)}%`);
    if (byWR) console.log(`            → ${byWR.name}`);
    if (byROI) console.log(`  Best ROI: WR ${byROI.wr.toFixed(2)}%  match ${byROI.match}  lift ${byROI.lift.toFixed(2)}×  EV ${(byROI.evPct>=0?'+':'')}${byROI.evPct.toFixed(3)}%/trade  ROI3y ${(byROI.roi3y>=0?'+':'')}${byROI.roi3y.toFixed(1)}%`);
    if (byROI) console.log(`            → ${byROI.name}`);
  }
  console.log("\n[mark-multi] ✅ Done");

  writeFileSync(join(__dirname, "..", "assets", "mark_hedge02new_multispec_summary.json"), JSON.stringify(results, null, 2));
}

main();
