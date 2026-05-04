/**
 * analyze-tp-target.ts (anh Tommy 2026-05-04)
 *
 * Tính từ 121 đỉnh + 151 đáy 1H thật:
 *   - Sau cây đáy, MAX gain bao nhiêu trong 24h, 48h, 96h, 7d, 14d, 30d?
 *   - Sau cây đỉnh, MAX drop bao nhiêu?
 *   - Phân bố MFE (Max Favorable Excursion) → tìm TP tối ưu
 *   - Thời gian trung bình từ đáy → đạt MFE
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const WINDOW = 24, REV_LOOKAHEAD = 48, REV_PCT = 5;

interface Candle { time: number; open: number; high: number; low: number; close: number; }

function loadCache(tf: string): Candle[] {
  return JSON.parse(readFileSync(join(__dirname,"..",".cache",`binance-${tf}-3y.json`),"utf8"));
}
function pct(x: number[], q: number): number {
  if (x.length===0) return NaN;
  const s=[...x].sort((a,b)=>a-b);
  return s[Math.min(Math.floor(s.length*q), s.length-1)];
}
function mean(x: number[]) { return x.length ? x.reduce((s,v)=>s+v,0)/x.length : NaN; }

function main(){
  const c = loadCache("1h");
  console.log(`[tp] ${c.length} bars 1H`);

  // Identify peaks + bottoms (same as previous analysis)
  const peaks: number[] = [], bottoms: number[] = [];
  for (let i=WINDOW;i<c.length-REV_LOOKAHEAD;i++){
    let isMax=true; for (let j=i-WINDOW;j<=i+WINDOW;j++) if (j!==i && c[j].high>=c[i].high){isMax=false; break;}
    if (isMax){
      let mn=Infinity; for (let j=i+1;j<=i+REV_LOOKAHEAD;j++) if (c[j].low<mn) mn=c[j].low;
      if (mn<=c[i].high*(1-REV_PCT/100)) peaks.push(i);
    }
    let isMin=true; for (let j=i-WINDOW;j<=i+WINDOW;j++) if (j!==i && c[j].low<=c[i].low){isMin=false; break;}
    if (isMin){
      let mx=-Infinity; for (let j=i+1;j<=i+REV_LOOKAHEAD;j++) if (c[j].high>mx) mx=c[j].high;
      if (mx>=c[i].low*(1+REV_PCT/100)) bottoms.push(i);
    }
  }
  console.log(`[tp] ${peaks.length} peaks, ${bottoms.length} bottoms`);

  // For each bottom, compute MAX gain achieved at horizons 24h, 48h, 96h, 7d, 14d, 30d, plus time-to-peak
  const HORIZONS = [24, 48, 96, 168, 336, 720]; // hours
  function analyzeBottoms() {
    const results: Record<number, number[]> = {};
    const timeToMax: number[] = []; // bars to reach maximum within max horizon
    for (const h of HORIZONS) results[h] = [];
    for (const idx of bottoms){
      const entry = c[idx].low; // worst-case entry at bottom = could buy at low
      let maxGainAtH: Record<number, number> = {};
      let absMaxGain = 0, absMaxIdx = idx;
      for (const h of HORIZONS) maxGainAtH[h] = 0;
      const horizonMax = HORIZONS[HORIZONS.length-1];
      for (let k=1; k<=horizonMax && idx+k<c.length; k++){
        const gain = (c[idx+k].high - entry)/entry*100;
        if (gain > absMaxGain){absMaxGain=gain; absMaxIdx=idx+k;}
        for (const h of HORIZONS) if (k<=h) maxGainAtH[h] = Math.max(maxGainAtH[h], gain);
      }
      for (const h of HORIZONS) results[h].push(maxGainAtH[h]);
      timeToMax.push(absMaxIdx - idx);
    }
    return { results, timeToMax };
  }
  function analyzePeaks() {
    const results: Record<number, number[]> = {};
    const timeToMin: number[] = [];
    for (const h of HORIZONS) results[h] = [];
    for (const idx of peaks){
      const entry = c[idx].high; // worst-case sell at peak high
      let maxDropAtH: Record<number, number> = {};
      let absMaxDrop = 0, absMaxIdx = idx;
      for (const h of HORIZONS) maxDropAtH[h] = 0;
      const horizonMax = HORIZONS[HORIZONS.length-1];
      for (let k=1; k<=horizonMax && idx+k<c.length; k++){
        const drop = (entry - c[idx+k].low)/entry*100;
        if (drop > absMaxDrop){absMaxDrop=drop; absMaxIdx=idx+k;}
        for (const h of HORIZONS) if (k<=h) maxDropAtH[h] = Math.max(maxDropAtH[h], drop);
      }
      for (const h of HORIZONS) results[h].push(maxDropAtH[h]);
      timeToMin.push(absMaxIdx - idx);
    }
    return { results, timeToMin };
  }

  const botAna = analyzeBottoms();
  const peakAna = analyzePeaks();

  // Print stats
  function printDistribution(title: string, arr: number[]){
    if (arr.length===0) {console.log(`${title}: empty`); return;}
    console.log(`${title.padEnd(32)} mean=${mean(arr).toFixed(2)}%  p25=${pct(arr,0.25).toFixed(2)}%  med=${pct(arr,0.5).toFixed(2)}%  p75=${pct(arr,0.75).toFixed(2)}%  p90=${pct(arr,0.9).toFixed(2)}%  max=${pct(arr,1).toFixed(2)}%`);
  }

  console.log("\n=== MAX GAIN AFTER BOTTOM (from low) ===");
  for (const h of HORIZONS) printDistribution(`${h}h horizon`, botAna.results[h]);
  console.log(`\nTime to absolute max (bars 1H): mean=${mean(botAna.timeToMax).toFixed(0)}  med=${pct(botAna.timeToMax,0.5).toFixed(0)}  p75=${pct(botAna.timeToMax,0.75).toFixed(0)}`);

  console.log("\n=== MAX DROP AFTER PEAK (from high) ===");
  for (const h of HORIZONS) printDistribution(`${h}h horizon`, peakAna.results[h]);
  console.log(`\nTime to absolute min (bars 1H): mean=${mean(peakAna.timeToMin).toFixed(0)}  med=${pct(peakAna.timeToMin,0.5).toFixed(0)}  p75=${pct(peakAna.timeToMin,0.75).toFixed(0)}`);

  // Hit rate at TP levels
  console.log("\n=== HIT RATE TP ON BOTTOM ENTRIES (% trades reach TP within horizon) ===");
  console.log("TP%    | 24h    48h    96h    7d    14d   30d");
  const tpLevels = [1, 2, 3, 5, 8, 10, 15, 20];
  for (const tp of tpLevels){
    const row = [`${tp}%`.padEnd(6)];
    for (const h of HORIZONS){
      const arr = botAna.results[h];
      const hit = arr.filter(v => v >= tp).length / arr.length * 100;
      row.push(`${hit.toFixed(0)}%`.padStart(6));
    }
    console.log(row.join("  "));
  }
  console.log("\n=== HIT RATE TP ON PEAK ENTRIES (% drop reaches TP) ===");
  console.log("TP%    | 24h    48h    96h    7d    14d   30d");
  for (const tp of tpLevels){
    const row = [`${tp}%`.padEnd(6)];
    for (const h of HORIZONS){
      const arr = peakAna.results[h];
      const hit = arr.filter(v => v >= tp).length / arr.length * 100;
      row.push(`${hit.toFixed(0)}%`.padStart(6));
    }
    console.log(row.join("  "));
  }

  // Expected value: TP × hit_rate (best TP × probability)
  console.log("\n=== EXPECTED VALUE = TP × hit_rate per horizon (BOTTOM) ===");
  console.log("TP%    | 24h     48h     96h     7d     14d    30d");
  for (const tp of tpLevels){
    const row = [`${tp}%`.padEnd(6)];
    for (const h of HORIZONS){
      const arr = botAna.results[h];
      const hit = arr.filter(v => v >= tp).length / arr.length;
      const ev = tp * hit;
      row.push(`${ev.toFixed(2)}%`.padStart(7));
    }
    console.log(row.join("  "));
  }
  console.log("\n=== EXPECTED VALUE (PEAK) ===");
  for (const tp of tpLevels){
    const row = [`${tp}%`.padEnd(6)];
    for (const h of HORIZONS){
      const arr = peakAna.results[h];
      const hit = arr.filter(v => v >= tp).length / arr.length;
      const ev = tp * hit;
      row.push(`${ev.toFixed(2)}%`.padStart(7));
    }
    console.log(row.join("  "));
  }

  // Save
  writeFileSync(join(__dirname,"..","assets","analyze_tp_target.json"), JSON.stringify({
    peaks: peaks.length, bottoms: bottoms.length, horizons: HORIZONS, tpLevels,
    bottomMaxGain: Object.fromEntries(HORIZONS.map(h => [h, botAna.results[h]])),
    peakMaxDrop: Object.fromEntries(HORIZONS.map(h => [h, peakAna.results[h]])),
    timeToMaxBottom: botAna.timeToMax,
    timeToMinPeak: peakAna.timeToMin,
  }));
  console.log("\nSaved → assets/analyze_tp_target.json");
}
main();
