/**
 * analyze-clean-2pct-features.ts (anh Tommy 2026-05-04)
 * So sánh 77k CLEAN cây 5m (+2% TP, MAE<1%) vs baseline để tìm features predictive.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const TARGET_PCT = 2;
const MAX_ADVERSE_PCT = 1;
const LOOKFORWARD_BARS = 288;

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
  console.log("[analyze] Loading 5m...");
  const c = loadCache("5m");

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

  // Identify clean winners
  const winnerIdx: number[] = [];
  for (let i=20;i<c.length-LOOKFORWARD_BARS;i++) {
    const entry = c[i].close;
    const tp = entry*(1+TARGET_PCT/100), sl = entry*(1-MAX_ADVERSE_PCT/100);
    let stopped = false, hit = false;
    const limit = i+1+LOOKFORWARD_BARS;
    for (let j=i+1;j<limit;j++) {
      if (c[j].low<=sl) {stopped=true; break;}
      if (c[j].high>=tp) {hit=true; break;}
    }
    if (hit && !stopped) winnerIdx.push(i);
  }
  console.log(`[analyze] ${winnerIdx.length} clean winners`);

  // Random baseline same size (exclude winners)
  const winSet = new Set(winnerIdx);
  const baseIdx: number[] = [];
  // Sample size = min(winnerIdx.length, 30000) to avoid taking too long
  const baseSize = Math.min(winnerIdx.length, 30000);
  while (baseIdx.length < baseSize) {
    const idx = Math.floor(Math.random()*c.length);
    if (idx>=20 && idx<c.length-LOOKFORWARD_BARS && !winSet.has(idx)) baseIdx.push(idx);
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
      mom20: idx>=20 ? (b.close-c[idx-20].close)/c[idx-20].close*100 : NaN,
      atrRatio: atr14[idx] && atr14[idx]!>0 ? (b.high-b.low)/atr14[idx]! : NaN,
      distMA50: ma50[idx] && ma50[idx]!>0 ? (b.close-ma50[idx]!)/ma50[idx]!*100 : NaN,
    };
  }
  // Only sample winners too if too many — for speed
  const winSample = winnerIdx.length > 30000 ? winnerIdx.slice(0, 30000) : winnerIdx;
  console.log(`[analyze] Computing features ${winSample.length} winners + ${baseIdx.length} baseline...`);
  const winFeats = winSample.map(feats);
  const baseFeats = baseIdx.map(feats);
  const FEATS = ["rsi","stochK","macdH","body","upWick","dnWick","isBull","volRatio","bbPos","mom5","mom10","mom20","atrRatio","distMA50"];
  function stats(arr: any[], key: string) { const v = arr.map(o=>o[key]).filter(x=>Number.isFinite(x)); return {n:v.length, mean:mean(v), p25:pct(v,0.25), median:pct(v,0.5), p75:pct(v,0.75)}; }

  console.log(`\n=== FEATURES (CLEAN +2% MAE<1% vs BASELINE) ===`);
  console.log("Feature        | WIN mean med    | BASE mean med   | Δ_norm  | Note");
  console.log("-".repeat(100));
  const scored: { feat: string; winMean: number; baseMean: number; delta: number; deltaNorm: number }[] = [];
  for (const f of FEATS){
    const w = stats(winFeats, f), b = stats(baseFeats, f);
    const baseRange = Math.abs(b.p75-b.p25) || Math.abs(b.mean) || 1;
    const dn = (w.mean - b.mean) / baseRange;
    scored.push({feat:f, winMean:w.mean, baseMean:b.mean, delta:w.mean-b.mean, deltaNorm:dn});
    console.log(`${f.padEnd(14)} | ${w.mean.toFixed(2).padStart(7)} ${w.median.toFixed(2).padStart(6)}  | ${b.mean.toFixed(2).padStart(7)} ${b.median.toFixed(2).padStart(6)}  | ${(dn>=0?"+":"")+dn.toFixed(3).padStart(6)}  ${Math.abs(dn)>=0.3?"⭐":""}`);
  }
  scored.sort((a,b)=>Math.abs(b.deltaNorm)-Math.abs(a.deltaNorm));
  console.log(`\n=== TOP DISCRIMINATING ===`);
  console.log("Feature        | Win    | Base   | Δ      | Δ_normalized");
  for (const s of scored){
    console.log(`${s.feat.padEnd(14)} | ${s.winMean.toFixed(2).padStart(6)} | ${s.baseMean.toFixed(2).padStart(6)} | ${(s.delta>=0?"+":"")+s.delta.toFixed(2).padStart(5)} | ${(s.deltaNorm>=0?"+":"")+s.deltaNorm.toFixed(3)}`);
  }

  // Test binary filters — winner_rate trong từng nhóm
  console.log(`\n=== BINARY FILTER TEST (win rate when condition true vs base ${(winnerIdx.length/(c.length-LOOKFORWARD_BARS-20)*100).toFixed(1)}%) ===`);
  const conds: { name: string; pred: (idx: number)=>boolean }[] = [
    {name:"RSI<30 (oversold)",       pred:idx=>(rsi[idx]??50)<30},
    {name:"RSI<35",                   pred:idx=>(rsi[idx]??50)<35},
    {name:"Stoch K<20",               pred:idx=>(stochK[idx]??50)<20},
    {name:"MACD hist<-50",            pred:idx=>(macdH[idx]??0)<-50},
    {name:"bbPos<10%",                pred:idx=>{const m=ma20[idx], s=sd20[idx]; if(m===null||s===null||s===0) return false; return (c[idx].close-(m-2*s))/(4*s)*100<10;}},
    {name:"distMA50<-2%",             pred:idx=>{const m=ma50[idx]; if(!m||m===0) return false; return (c[idx].close-m)/m*100<-2;}},
    {name:"dnWick≥0.3%",              pred:idx=>(Math.min(c[idx].open,c[idx].close)-c[idx].low)/c[idx].open*100>=0.3},
    {name:"vol≥2× avg",               pred:idx=>{const v=volMA[idx]; if(!v||v===0) return false; return (c[idx].volume??0)/v>=2;}},
    {name:"atrRatio≥1.5",             pred:idx=>{const a=atr14[idx]; if(!a||a===0) return false; return (c[idx].high-c[idx].low)/a>=1.5;}},
    {name:"isBull=1 (xanh)",          pred:idx=>c[idx].close>c[idx].open},
    {name:"isBull=0 (đỏ)",            pred:idx=>c[idx].close<=c[idx].open},
    {name:"mom5<-0.5",                pred:idx=>idx>=5?((c[idx].close-c[idx-5].close)/c[idx-5].close*100)<-0.5:false},
  ];
  for (const cond of conds){
    let totalMatch = 0, winMatch = 0;
    for (let i=20;i<c.length-LOOKFORWARD_BARS;i++) if (cond.pred(i)) {totalMatch++; if (winSet.has(i)) winMatch++;}
    const wr = totalMatch>0 ? winMatch/totalMatch*100 : 0;
    const base = winnerIdx.length/(c.length-LOOKFORWARD_BARS-20)*100;
    const lift = wr/base;
    console.log(`  ${cond.name.padEnd(28)}: ${totalMatch.toString().padStart(7)} bars → ${winMatch.toString().padStart(6)} clean (${wr.toFixed(1)}%, lift ${lift.toFixed(2)}×) ${lift>=1.2?"⭐":""}`);
  }

  writeFileSync(join(__dirname,"..","assets","analyze_clean_2pct_features.json"), JSON.stringify({
    winnerCount: winnerIdx.length, baseCount: baseIdx.length,
    discriminating: scored,
  }));
  console.log(`\nSaved → assets/analyze_clean_2pct_features.json`);
}
main();
