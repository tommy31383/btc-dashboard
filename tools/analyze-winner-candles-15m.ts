/**
 * analyze-winner-candles-15m.ts (anh Tommy 2026-05-04)
 * Phân tích đặc điểm 14501 cây 15m sau đó tăng ≥10% trong 7d.
 * So sánh với 14501 cây random baseline để tìm features khác biệt.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const TARGET_PCT = 10;
const LOOKFORWARD_BARS = 672;

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }

function loadCache(tf: string): Candle[] { return JSON.parse(readFileSync(join(__dirname,"..",".cache",`binance-${tf}-3y.json`),"utf8")); }
function calcSMA(a: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); if (a.length<p) return o; let s=0; for (let i=0;i<p;i++) s+=a[i]; o[p-1]=s/p; for (let i=p;i<a.length;i++){s+=a[i]-a[i-p]; o[i]=s/p;} return o; }
function calcEMA(a: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); if (a.length<p) return o; const k=2/(p+1); let e=0; for (let i=0;i<p;i++) e+=a[i]; e/=p; o[p-1]=e; for (let i=p;i<a.length;i++){e=a[i]*k+e*(1-k); o[i]=e;} return o; }
function calcStdev(a: number[], p: number, sma: (number|null)[]): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); for (let i=p-1;i<a.length;i++){const m=sma[i]; if (m===null) continue; let sq=0; for (let j=i-p+1;j<=i;j++) sq+=(a[j]-m)**2; o[i]=Math.sqrt(sq/p);} return o; }
function calcRSI(c: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(c.length).fill(null); if (c.length<=p) return o; let g=0,l=0; for (let i=1;i<=p;i++){const ch=c[i]-c[i-1]; if (ch>=0) g+=ch; else l-=ch;} let ag=g/p, al=l/p; o[p]=al===0?100:100-100/(1+ag/al); for (let i=p+1;i<c.length;i++){const ch=c[i]-c[i-1]; ag=(ag*(p-1)+Math.max(ch,0))/p; al=(al*(p-1)+Math.max(-ch,0))/p; o[i]=al===0?100:100-100/(1+ag/al);} return o; }
function calcStochK(c: Candle[], p: number): (number|null)[] { const o: (number|null)[] = new Array(c.length).fill(null); for (let i=p-1;i<c.length;i++){let hi=-Infinity, lo=Infinity; for (let j=i-p+1;j<=i;j++){if (c[j].high>hi) hi=c[j].high; if (c[j].low<lo) lo=c[j].low;} o[i]=hi===lo?50:((c[i].close-lo)/(hi-lo))*100;} return o; }
function calcATR(c: Candle[], p: number): (number|null)[] { const o: (number|null)[] = new Array(c.length).fill(null); if (c.length<=p) return o; const tr: number[] = new Array(c.length).fill(0); for (let i=1;i<c.length;i++) tr[i]=Math.max(c[i].high-c[i].low, Math.abs(c[i].high-c[i-1].close), Math.abs(c[i].low-c[i-1].close)); let s=0; for (let i=1;i<=p;i++) s+=tr[i]; o[p]=s/p; for (let i=p+1;i<c.length;i++) o[i]=(o[i-1]!*(p-1)+tr[i])/p; return o; }
function calcMACDHist(c: number[]): (number|null)[] { const e12=calcEMA(c,12), e26=calcEMA(c,26); const macd: (number|null)[] = c.map((_,i) => (e12[i]!=null && e26[i]!=null) ? e12[i]!-e26[i]! : null); const v: number[]=[], m: number[]=[]; for (let i=0;i<macd.length;i++) if (macd[i]!==null){v.push(macd[i]!); m.push(i);} const sigEma = calcEMA(v, 9); const signal: (number|null)[] = new Array(c.length).fill(null); for (let k=0;k<sigEma.length;k++) if (sigEma[k]!==null) signal[m[k]] = sigEma[k]; return c.map((_,i) => (macd[i]!=null && signal[i]!=null) ? macd[i]!-signal[i]! : null); }

function pct(x: number[], q: number) { if (x.length===0) return NaN; const s=[...x].sort((a,b)=>a-b); return s[Math.min(Math.floor(s.length*q), s.length-1)]; }
function mean(x: number[]) { return x.length ? x.reduce((s,v)=>s+v,0)/x.length : NaN; }

function main() {
  console.log("[analyze-winners] Loading 15m...");
  const c = loadCache("15m");
  console.log(`[analyze-winners] ${c.length} bars`);

  // Pre-compute indicators
  const closes = c.map(b=>b.close);
  const rsi = calcRSI(closes, 14);
  const stochK = calcStochK(c, 14);
  const macdH = calcMACDHist(closes);
  const ma50 = calcSMA(closes, 50);
  const ma20 = calcSMA(closes, 20);
  const sd20 = calcStdev(closes, 20, ma20);
  const atr14 = calcATR(c, 14);
  const vols = c.map(b=>b.volume??0);
  const volMA = calcSMA(vols, 20);

  // Identify winners
  const winnerIdx: number[] = [];
  for (let i=0;i<c.length-1;i++){
    const target = c[i].low * (1+TARGET_PCT/100);
    const limit = Math.min(c.length, i+1+LOOKFORWARD_BARS);
    for (let j=i+1;j<limit;j++){
      if (c[j].high>=target){winnerIdx.push(i); break;}
    }
  }
  console.log(`[analyze-winners] ${winnerIdx.length} winner bars`);

  // Random baseline (same size, exclude winners để fair)
  const winnerSet = new Set(winnerIdx);
  const baselineIdx: number[] = [];
  while (baselineIdx.length < winnerIdx.length){
    const idx = Math.floor(Math.random() * c.length);
    if (idx>=50 && idx<c.length-LOOKFORWARD_BARS && !winnerSet.has(idx)) baselineIdx.push(idx);
  }

  function feats(idx: number) {
    const b = c[idx];
    return {
      rsi: rsi[idx] ?? NaN,
      stochK: stochK[idx] ?? NaN,
      macdH: macdH[idx] ?? NaN,
      body: Math.abs(b.close-b.open)/b.open*100,
      upWick: (b.high-Math.max(b.open,b.close))/b.open*100,
      dnWick: (Math.min(b.open,b.close)-b.low)/b.open*100,
      isBull: b.close>b.open ? 1 : 0,
      volRatio: volMA[idx] && volMA[idx]!>0 ? (b.volume??0)/volMA[idx]! : NaN,
      bbPos: (ma20[idx]!==null && sd20[idx]!==null && sd20[idx]!>0) ? (b.close-(ma20[idx]!-2*sd20[idx]!))/(4*sd20[idx]!)*100 : NaN,
      mom5: idx>=5 ? (b.close-c[idx-5].close)/c[idx-5].close*100 : NaN,
      mom10: idx>=10 ? (b.close-c[idx-10].close)/c[idx-10].close*100 : NaN,
      atrRatio: atr14[idx] && atr14[idx]!>0 ? (b.high-b.low)/atr14[idx]! : NaN,
      distMA50: ma50[idx] && ma50[idx]!>0 ? (b.close-ma50[idx]!)/ma50[idx]!*100 : NaN,
    };
  }

  const winFeats = winnerIdx.map(feats);
  const baseFeats = baselineIdx.map(feats);
  const FEATS = ["rsi","stochK","macdH","body","upWick","dnWick","isBull","volRatio","bbPos","mom5","mom10","atrRatio","distMA50"];

  function stats(arr: any[], key: string) {
    const v = arr.map(o=>o[key]).filter(x=>Number.isFinite(x));
    return {n:v.length, mean:mean(v), p25:pct(v,0.25), median:pct(v,0.5), p75:pct(v,0.75)};
  }

  console.log(`\n=== FEATURES — WINNERS (n=${winnerIdx.length}) vs BASELINE (n=${baselineIdx.length}) ===`);
  console.log("Feature        | WINNER mean   med    p25    p75   | BASE mean   med    p25    p75   | Δ(W-B)");
  console.log("-".repeat(115));
  const scored: { feat: string; winnerMean: number; baseMean: number; delta: number; deltaNorm: number }[] = [];
  for (const f of FEATS){
    const w = stats(winFeats, f), b = stats(baseFeats, f);
    const baseRange = Math.abs(b.p75-b.p25) || Math.abs(b.mean) || 1;
    const dn = (w.mean - b.mean) / baseRange;
    scored.push({feat:f, winnerMean:w.mean, baseMean:b.mean, delta:w.mean-b.mean, deltaNorm:dn});
    console.log(`${f.padEnd(14)} | ${w.mean.toFixed(2).padStart(7)} ${w.median.toFixed(2).padStart(6)} ${w.p25.toFixed(2).padStart(6)} ${w.p75.toFixed(2).padStart(6)} | ${b.mean.toFixed(2).padStart(7)} ${b.median.toFixed(2).padStart(6)} ${b.p25.toFixed(2).padStart(6)} ${b.p75.toFixed(2).padStart(6)} | ${(w.mean-b.mean>=0?"+":"")+(w.mean-b.mean).toFixed(2)}`);
  }

  scored.sort((a,b)=>Math.abs(b.deltaNorm)-Math.abs(a.deltaNorm));
  console.log(`\n=== TOP DISCRIMINATING (sorted by |Δ normalized|) ===`);
  console.log("Feature        | Winner | Baseline | Δ        | Δ_normalized (σ-like)");
  for (const s of scored){
    console.log(`${s.feat.padEnd(14)} | ${s.winnerMean.toFixed(2).padStart(7)} | ${s.baseMean.toFixed(2).padStart(8)} | ${(s.delta>=0?"+":"")+s.delta.toFixed(2).padStart(7)} | ${(s.deltaNorm>=0?"+":"")+s.deltaNorm.toFixed(3)}`);
  }

  // Save
  writeFileSync(join(__dirname,"..","assets","analyze_winner_candles_15m.json"), JSON.stringify({
    config:{targetPct:TARGET_PCT, lookforwardBars:LOOKFORWARD_BARS},
    winnerCount: winnerIdx.length, baselineCount: baselineIdx.length,
    discriminating: scored,
    winnerStats: Object.fromEntries(FEATS.map(f=>[f,stats(winFeats,f)])),
    baselineStats: Object.fromEntries(FEATS.map(f=>[f,stats(baseFeats,f)])),
  }));
  console.log(`\nSaved → assets/analyze_winner_candles_15m.json`);
}
main();
