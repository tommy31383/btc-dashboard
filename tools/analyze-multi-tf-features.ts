/**
 * analyze-multi-tf-features.ts (anh Tommy 2026-05-04)
 * Multi-TF analysis: cây 5m winner (TP+5% MAE<3% / 7d) — features 5m + 15m + 1h + 4h + 1d + 1w.
 * Tìm HTF features predictive, test binary filter combos.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const TARGET_PCT = 5;
const MAX_ADVERSE_PCT = 3;
const LOOKFORWARD_BARS = 2016;

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }

function loadCache(tf: string): Candle[] { return JSON.parse(readFileSync(join(__dirname,"..",".cache",`binance-${tf}-3y.json`),"utf8")); }
function calcSMA(a: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); if (a.length<p) return o; let s=0; for (let i=0;i<p;i++) s+=a[i]; o[p-1]=s/p; for (let i=p;i<a.length;i++){s+=a[i]-a[i-p]; o[i]=s/p;} return o; }
function calcEMA(a: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); if (a.length<p) return o; const k=2/(p+1); let e=0; for (let i=0;i<p;i++) e+=a[i]; e/=p; o[p-1]=e; for (let i=p;i<a.length;i++){e=a[i]*k+e*(1-k); o[i]=e;} return o; }
function calcStdev(a: number[], p: number, sma: (number|null)[]): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); for (let i=p-1;i<a.length;i++){const m=sma[i]; if (m===null) continue; let sq=0; for (let j=i-p+1;j<=i;j++) sq+=(a[j]-m)**2; o[i]=Math.sqrt(sq/p);} return o; }
function calcRSI(c: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(c.length).fill(null); if (c.length<=p) return o; let g=0,l=0; for (let i=1;i<=p;i++){const ch=c[i]-c[i-1]; if (ch>=0) g+=ch; else l-=ch;} let ag=g/p, al=l/p; o[p]=al===0?100:100-100/(1+ag/al); for (let i=p+1;i<c.length;i++){const ch=c[i]-c[i-1]; ag=(ag*(p-1)+Math.max(ch,0))/p; al=(al*(p-1)+Math.max(-ch,0))/p; o[i]=al===0?100:100-100/(1+ag/al);} return o; }
function calcStochK(c: Candle[], p: number): (number|null)[] { const o: (number|null)[] = new Array(c.length).fill(null); for (let i=p-1;i<c.length;i++){let hi=-Infinity, lo=Infinity; for (let j=i-p+1;j<=i;j++){if (c[j].high>hi) hi=c[j].high; if (c[j].low<lo) lo=c[j].low;} o[i]=hi===lo?50:((c[i].close-lo)/(hi-lo))*100;} return o; }
function calcMACDHist(c: number[]): (number|null)[] { const e12=calcEMA(c,12), e26=calcEMA(c,26); const macd: (number|null)[] = c.map((_,i) => (e12[i]!=null && e26[i]!=null) ? e12[i]!-e26[i]! : null); const v: number[]=[], m: number[]=[]; for (let i=0;i<macd.length;i++) if (macd[i]!==null){v.push(macd[i]!); m.push(i);} const sigEma = calcEMA(v, 9); const signal: (number|null)[] = new Array(c.length).fill(null); for (let k=0;k<sigEma.length;k++) if (sigEma[k]!==null) signal[m[k]] = sigEma[k]; return c.map((_,i) => (macd[i]!=null && signal[i]!=null) ? macd[i]!-signal[i]! : null); }
function findIdx(arr: { time: number }[], t: number): number { let lo=0, hi=arr.length-1, ans=-1; while (lo<=hi){const m=(lo+hi)>>1; if (arr[m].time<=t){ans=m; lo=m+1;} else hi=m-1;} return ans; }
function pct(x: number[], q: number) { if (x.length===0) return NaN; const s=[...x].sort((a,b)=>a-b); return s[Math.min(Math.floor(s.length*q), s.length-1)]; }
function mean(x: number[]) { return x.length ? x.reduce((s,v)=>s+v,0)/x.length : NaN; }

interface TFData {
  bars: Candle[];
  rsi: (number|null)[]; stochK: (number|null)[]; macdH: (number|null)[];
  ma50: (number|null)[]; ma200: (number|null)[]; ma20: (number|null)[]; sd20: (number|null)[];
}

function buildTF(c: Candle[]): TFData {
  const closes = c.map(b=>b.close);
  return {
    bars: c, rsi: calcRSI(closes, 14), stochK: calcStochK(c, 14), macdH: calcMACDHist(closes),
    ma50: calcSMA(closes, 50), ma200: calcSMA(closes, 200),
    ma20: calcSMA(closes, 20), sd20: calcStdev(closes, 20, calcSMA(closes, 20)),
  };
}

function htfFeats(tfData: TFData, t: number) {
  const idx = findIdx(tfData.bars, t);
  if (idx < 200) return null;
  const b = tfData.bars[idx];
  const ma50 = tfData.ma50[idx], ma200 = tfData.ma200[idx], ma20 = tfData.ma20[idx], sd20 = tfData.sd20[idx];
  return {
    rsi: tfData.rsi[idx] ?? NaN,
    stochK: tfData.stochK[idx] ?? NaN,
    macdH: tfData.macdH[idx] ?? NaN,
    distMA50: ma50 ? (b.close - ma50)/ma50*100 : NaN,
    distMA200: ma200 ? (b.close - ma200)/ma200*100 : NaN,
    bbPos: (ma20 && sd20 && sd20>0) ? (b.close - (ma20-2*sd20))/(4*sd20)*100 : NaN,
    trendD200: ma200 ? (b.close > ma200 ? 1 : 0) : NaN,
    trendD50: ma50 ? (b.close > ma50 ? 1 : 0) : NaN,
  };
}

function main() {
  console.log("[multi-tf] Loading all TFs...");
  const c5 = loadCache("5m");
  const tf15 = buildTF(loadCache("15m"));
  const tf1h = buildTF(loadCache("1h"));
  const tf4h = buildTF(loadCache("4h"));
  const tf1d = buildTF(loadCache("1d"));
  const tf1w = buildTF(loadCache("1w"));
  console.log(`[multi-tf] Loaded — c5: ${c5.length}, 15m: ${tf15.bars.length}, 1h: ${tf1h.bars.length}, 4h: ${tf4h.bars.length}, 1d: ${tf1d.bars.length}, 1w: ${tf1w.bars.length}`);

  // Identify clean winners on 5m
  const winSet = new Set<number>();
  for (let i=200;i<c5.length-LOOKFORWARD_BARS;i++) {
    const entry = c5[i].close;
    const tp = entry*(1+TARGET_PCT/100);
    const sl = entry*(1-MAX_ADVERSE_PCT/100);
    let stopped=false, hit=false;
    for (let j=i+1;j<i+LOOKFORWARD_BARS;j++) {
      if (c5[j].low<=sl) {stopped=true; break;}
      if (c5[j].high>=tp) {hit=true; break;}
    }
    if (hit && !stopped) winSet.add(c5[i].time);
  }
  const totalBars = c5.length-LOOKFORWARD_BARS-200;
  const baseRate = winSet.size/totalBars*100;
  console.log(`[multi-tf] CLEAN winners: ${winSet.size}/${totalBars} = ${baseRate.toFixed(2)}%`);

  // Sample winners + baseline
  const allWinners: number[] = [];
  const allBaseline: number[] = [];
  for (let i=200;i<c5.length-LOOKFORWARD_BARS;i++) {
    if (winSet.has(c5[i].time)) allWinners.push(i);
    else allBaseline.push(i);
  }
  // Sample 20k each
  const winSample = allWinners.length > 20000 ? allWinners.filter((_,i)=>i%Math.floor(allWinners.length/20000)===0).slice(0,20000) : allWinners;
  const baseSample: number[] = [];
  while (baseSample.length < winSample.length) baseSample.push(allBaseline[Math.floor(Math.random()*allBaseline.length)]);
  console.log(`[multi-tf] Sampled ${winSample.length} winners + ${baseSample.length} baseline`);

  // Compute multi-TF features for each sample
  function multiTFFeat(idx: number) {
    const t = c5[idx].time;
    return {
      "15m": htfFeats(tf15, t),
      "1h":  htfFeats(tf1h, t),
      "4h":  htfFeats(tf4h, t),
      "1d":  htfFeats(tf1d, t),
      "1w":  htfFeats(tf1w, t),
    };
  }

  const winFeats = winSample.map(multiTFFeat);
  const baseFeats = baseSample.map(multiTFFeat);

  console.log(`\n=== MULTI-TF DISCRIMINATING FEATURES ===`);
  const tfs = ["15m","1h","4h","1d","1w"];
  const subFeats = ["rsi","stochK","macdH","distMA50","distMA200","bbPos","trendD200","trendD50"];
  const scored: { name: string; winMean: number; baseMean: number; deltaNorm: number }[] = [];
  for (const tf of tfs) for (const sf of subFeats) {
    const wv = winFeats.map((f:any)=>f[tf]?.[sf]).filter((x:any)=>Number.isFinite(x));
    const bv = baseFeats.map((f:any)=>f[tf]?.[sf]).filter((x:any)=>Number.isFinite(x));
    if (wv.length===0||bv.length===0) continue;
    const wm = mean(wv), bm = mean(bv);
    const baseRange = Math.abs(pct(bv,0.75)-pct(bv,0.25)) || Math.abs(bm) || 1;
    const dn = (wm-bm)/baseRange;
    scored.push({name:`${tf}.${sf}`, winMean:wm, baseMean:bm, deltaNorm:dn});
  }
  scored.sort((a,b)=>Math.abs(b.deltaNorm)-Math.abs(a.deltaNorm));
  console.log("Feature              | Winner   | Baseline | Δ_norm  | Note");
  for (const s of scored.slice(0, 25)){
    console.log(`${s.name.padEnd(20)} | ${s.winMean.toFixed(2).padStart(8)} | ${s.baseMean.toFixed(2).padStart(8)} | ${(s.deltaNorm>=0?"+":"")+s.deltaNorm.toFixed(3).padStart(6)}  ${Math.abs(s.deltaNorm)>=0.3?"⭐⭐":Math.abs(s.deltaNorm)>=0.15?"⭐":""}`);
  }

  // Binary filter test multi-TF
  console.log(`\n=== BINARY FILTER MULTI-TF (base ${baseRate.toFixed(2)}%) ===`);
  const conds: { name: string; pred: (idx: number)=>boolean }[] = [
    {name:"1d trend UP (close>MA200d)", pred:(idx:number)=>{const f=htfFeats(tf1d, c5[idx].time); return f ? f.trendD200===1 : false;}},
    {name:"1d trend DOWN", pred:(idx:number)=>{const f=htfFeats(tf1d, c5[idx].time); return f ? f.trendD200===0 : false;}},
    {name:"1w trend UP (close>MA50w)", pred:(idx:number)=>{const f=htfFeats(tf1w, c5[idx].time); return f ? f.trendD50===1 : false;}},
    {name:"1d distMA200<-5%", pred:(idx:number)=>{const f=htfFeats(tf1d, c5[idx].time); return f ? f.distMA200<-5 : false;}},
    {name:"1d distMA200<-10%", pred:(idx:number)=>{const f=htfFeats(tf1d, c5[idx].time); return f ? f.distMA200<-10 : false;}},
    {name:"1h RSI<30", pred:(idx:number)=>{const f=htfFeats(tf1h, c5[idx].time); return f ? f.rsi<30 : false;}},
    {name:"4h RSI<30", pred:(idx:number)=>{const f=htfFeats(tf4h, c5[idx].time); return f ? f.rsi<30 : false;}},
    {name:"1d RSI<40", pred:(idx:number)=>{const f=htfFeats(tf1d, c5[idx].time); return f ? f.rsi<40 : false;}},
    {name:"4h Stoch<20", pred:(idx:number)=>{const f=htfFeats(tf4h, c5[idx].time); return f ? f.stochK<20 : false;}},
    {name:"1d MACD<0", pred:(idx:number)=>{const f=htfFeats(tf1d, c5[idx].time); return f ? f.macdH<0 : false;}},
    // COMBOS
    {name:"COMBO 1d UP + 1h RSI<30", pred:(idx:number)=>{const fd=htfFeats(tf1d, c5[idx].time); const fh=htfFeats(tf1h, c5[idx].time); return (fd?.trendD200===1) && (fh && fh.rsi<30);}},
    {name:"COMBO 1d UP + 4h RSI<30", pred:(idx:number)=>{const fd=htfFeats(tf1d, c5[idx].time); const fh=htfFeats(tf4h, c5[idx].time); return (fd?.trendD200===1) && (fh && fh.rsi<30);}},
    {name:"COMBO 1w UP + 1d RSI<40", pred:(idx:number)=>{const fw=htfFeats(tf1w, c5[idx].time); const fd=htfFeats(tf1d, c5[idx].time); return (fw?.trendD50===1) && (fd && fd.rsi<40);}},
    {name:"COMBO 1d UP + 1d distMA200>+0% + 4h RSI<30", pred:(idx:number)=>{const fd=htfFeats(tf1d, c5[idx].time); const fh=htfFeats(tf4h, c5[idx].time); return (fd?.trendD200===1) && (fd && fd.distMA200>0) && (fh && fh.rsi<30);}},
    {name:"COMBO 1d distMA200<-5 + 1h RSI<30", pred:(idx:number)=>{const fd=htfFeats(tf1d, c5[idx].time); const fh=htfFeats(tf1h, c5[idx].time); return (fd && fd.distMA200<-5) && (fh && fh.rsi<30);}},
  ];
  for (const cond of conds) {
    let total=0, win=0;
    for (let i=200;i<c5.length-LOOKFORWARD_BARS;i++) if (cond.pred(i)) {total++; if (winSet.has(c5[i].time)) win++;}
    const wr = total>0 ? win/total*100 : 0;
    const lift = wr/baseRate;
    console.log(`  ${cond.name.padEnd(50)}: ${total.toString().padStart(7)} → ${win.toString().padStart(6)} (${wr.toFixed(1)}%, lift ${lift.toFixed(2)}×) ${lift>=1.5?"⭐⭐":lift>=1.3?"⭐":""}`);
  }
}
main();
