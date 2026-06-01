/**
 * sweep-tpsl-c2-7y.ts (anh Tommy 2026-05-14)
 *
 * Combo C2 (LONG): RSI≥70 AND upWick≥0.3% AND mom_all_up
 * Sweep TP × SL grid để tìm spec ROI 7y tốt nhất.
 *
 * TP range: 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5 (%)
 * SL range: 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2 (%)
 * Window: 24h (288 bars 5m)
 *
 * Output: top 20 spec sorted by ROI, + per-year breakdown top 3, + train/test split.
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

interface Feat { upWick: number; mom5: number; mom10: number; mom20: number; rsi: number; }

function main() {
  console.log("[sweep-tpsl-c2] Loading + features...");
  const c = loadCache();
  console.log(`  ${c.length.toLocaleString()} bars`);
  const closes = c.map(b => b.close);
  const rsi = calcRSI(closes, 14);

  // Pre-compute C2 signal indices (no peek)
  console.log("[sweep-tpsl-c2] Detecting C2 signal bars...");
  const signalIdx: number[] = [];
  for (let i = 200; i < c.length - 1; i++) {
    const bar = c[i];
    const upWick = (bar.high - Math.max(bar.open, bar.close)) / bar.open * 100;
    const mom5 = i >= 6 ? (bar.close - c[i-6].close)/c[i-6].close * 100 : 0;
    const mom10 = i >= 11 ? (bar.close - c[i-11].close)/c[i-11].close * 100 : 0;
    const mom20 = i >= 21 ? (bar.close - c[i-21].close)/c[i-21].close * 100 : 0;
    const r = rsi[i] ?? 0;
    if (r >= 70 && upWick >= 0.3 && mom5 >= 0 && mom10 >= 0 && mom20 >= 0) signalIdx.push(i);
  }
  console.log(`  C2 signals: ${signalIdx.length.toLocaleString()}`);

  // === Sweep TP × SL grid ===
  const TPs = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0];
  const SLs = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
  console.log(`\n[sweep-tpsl-c2] Sweeping ${TPs.length} × ${SLs.length} = ${TPs.length*SLs.length} grid combos...`);

  interface Result {
    tp: number; sl: number; rr: number; beW: number;
    total: number; win: number; loss: number; timeout: number;
    wr: number; ev: number; roi: number;
    posY: number; totY: number; perYear: Record<number, number>;
    trainWR: number; trainROI: number; trainN: number;
    testWR: number; testROI: number; testN: number;
  }
  const results: Result[] = [];

  for (const tp of TPs) {
    for (const sl of SLs) {
      let win = 0, loss = 0, timeout = 0;
      const yearMarks: Record<number, { win: number; loss: number }> = {};
      const trainSplit = Math.floor(signalIdx.length * 0.7);
      let trainWin = 0, trainLoss = 0, testWin = 0, testLoss = 0;

      for (let k = 0; k < signalIdx.length; k++) {
        const i = signalIdx[k];
        if (i + WINDOW_BARS >= c.length) continue;
        const entry = c[i].close;
        const tpPx = entry * (1 + tp/100);
        const slPx = entry * (1 - sl/100);
        let won = false, lost = false;
        for (let j = i+1; j < i+1+WINDOW_BARS; j++) {
          if (c[j].low <= slPx) { lost = true; break; }
          if (c[j].high >= tpPx) { won = true; break; }
        }
        const year = new Date(c[i].time).getUTCFullYear();
        yearMarks[year] = yearMarks[year] || { win: 0, loss: 0 };
        if (won) { win++; yearMarks[year].win++; if (k < trainSplit) trainWin++; else testWin++; }
        else if (lost) { loss++; yearMarks[year].loss++; if (k < trainSplit) trainLoss++; else testLoss++; }
        else timeout++;  // count timeout as loss? — em treat timeout = no trade (skip from EV calc)
      }
      const total = win + loss;
      if (total === 0) continue;
      const wr = win / total;
      const ev = wr * tp - (1-wr) * sl - 2 * FEE_PER_SIDE_PCT;
      const roi = total * ev;
      // Per-year ROI
      let posY = 0, totY = 0;
      const perYear: Record<number, number> = {};
      for (const y in yearMarks) {
        const yT = yearMarks[+y].win + yearMarks[+y].loss;
        if (yT === 0) continue;
        const yWR = yearMarks[+y].win / yT;
        const yEv = yWR * tp - (1-yWR) * sl - 2 * FEE_PER_SIDE_PCT;
        perYear[+y] = yT * yEv;
        totY++;
        if (perYear[+y] > 0) posY++;
      }
      const trainN = trainWin + trainLoss, testN = testWin + testLoss;
      const trainWR = trainN > 0 ? trainWin / trainN : 0;
      const trainROI = trainN > 0 ? trainN * (trainWR * tp - (1-trainWR) * sl - 2*FEE_PER_SIDE_PCT) : 0;
      const testWR = testN > 0 ? testWin / testN : 0;
      const testROI = testN > 0 ? testN * (testWR * tp - (1-testWR) * sl - 2*FEE_PER_SIDE_PCT) : 0;
      results.push({
        tp, sl, rr: tp/sl, beW: (sl + 2*FEE_PER_SIDE_PCT) / (tp + sl) * 100,
        total, win, loss, timeout, wr, ev, roi,
        posY, totY, perYear,
        trainWR, trainROI, trainN, testWR, testROI, testN,
      });
    }
  }

  // === Top 20 by ROI ===
  results.sort((a, b) => b.roi - a.roi);
  console.log("\n=== TOP 20 SPEC by ROI 7y (Combo C2 LONG, 24h window) ===");
  console.log(" TP%   SL%   R:R    BE%      N    W    L    TO    WR%      EV%      ROI 7y%  Stab  Test ROI%  Test WR%");
  console.log("----  ----  -----  -----  ----  ---  ---  ----  ------  -------  -------  ----  ---------  --------");
  for (let r = 0; r < Math.min(20, results.length); r++) {
    const x = results[r];
    const stab = `${x.posY}/${x.totY}`;
    console.log(`${x.tp.toFixed(2).padStart(4)}  ${x.sl.toFixed(2).padStart(4)}  ${x.rr.toFixed(2).padStart(4)}   ${x.beW.toFixed(2).padStart(4)}%  ${x.total.toString().padStart(4)}  ${x.win.toString().padStart(3)}  ${x.loss.toString().padStart(3)}  ${x.timeout.toString().padStart(4)}  ${(x.wr*100).toFixed(2).padStart(5)}%  ${(x.ev>=0?'+':'')}${x.ev.toFixed(3).padStart(7)}%  ${(x.roi>=0?'+':'')}${x.roi.toFixed(1).padStart(6)}%  ${stab.padStart(3)}  ${(x.testROI>=0?'+':'')}${x.testROI.toFixed(1).padStart(7)}%  ${(x.testWR*100).toFixed(2).padStart(6)}%`);
  }

  // === Top 3 spec — per-year breakdown ===
  console.log("\n=== TOP 3 SPEC — per-year breakdown ===");
  const top3 = results.slice(0, 3);
  for (let r = 0; r < top3.length; r++) {
    const x = top3[r];
    console.log(`\nRank ${r+1}: TP+${x.tp}% / SL-${x.sl}% (R:R ${x.rr.toFixed(2)}:1, BE ${x.beW.toFixed(2)}%)`);
    console.log(`  Total ${x.total}  WR ${(x.wr*100).toFixed(2)}%  ROI 7y ${(x.roi>=0?'+':'')}${x.roi.toFixed(1)}%  Stability ${x.posY}/${x.totY}`);
    console.log(`  Train (70%): ${x.trainN} trades, WR ${(x.trainWR*100).toFixed(2)}%, ROI ${(x.trainROI>=0?'+':'')}${x.trainROI.toFixed(1)}%`);
    console.log(`  Test (30%):  ${x.testN} trades, WR ${(x.testWR*100).toFixed(2)}%, ROI ${(x.testROI>=0?'+':'')}${x.testROI.toFixed(1)}%`);
    const yKeys = Object.keys(x.perYear).map(Number).sort();
    for (const y of yKeys) {
      console.log(`    ${y}:  ROI ${(x.perYear[y]>=0?'+':'')}${x.perYear[y].toFixed(1)}%`);
    }
  }

  // === Sort by stability (years positive) ===
  results.sort((a, b) => (b.posY/b.totY) - (a.posY/a.totY) || b.roi - a.roi);
  console.log("\n=== TOP 10 SPEC by STABILITY (years positive ratio) ===");
  console.log(" TP%   SL%   R:R    Stab    Total   WR%      ROI 7y%   Test ROI%");
  for (let r = 0; r < Math.min(10, results.length); r++) {
    const x = results[r];
    const stab = `${x.posY}/${x.totY}`;
    console.log(`${x.tp.toFixed(2).padStart(4)}  ${x.sl.toFixed(2).padStart(4)}  ${x.rr.toFixed(2).padStart(4)}   ${stab.padStart(5)}   ${x.total.toString().padStart(5)}  ${(x.wr*100).toFixed(2).padStart(5)}%  ${(x.roi>=0?'+':'')}${x.roi.toFixed(1).padStart(7)}%  ${(x.testROI>=0?'+':'')}${x.testROI.toFixed(1).padStart(7)}%`);
  }

  // Save summary
  writeFileSync(join(__dirname, "..", "assets", "sweep_tpsl_c2_7y.json"), JSON.stringify({
    combo: "RSI≥70 AND upWick≥0.3% AND mom_all_up",
    grid: { TPs, SLs, window_bars: WINDOW_BARS },
    signals_total: signalIdx.length,
    results: results.slice(0, 30),
  }, null, 2));

  console.log("\n[sweep-tpsl-c2] ✅ Done");
}

main();
