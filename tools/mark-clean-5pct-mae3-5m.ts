/**
 * mark-clean-5pct-mae3-5m.ts (anh Tommy 2026-05-04)
 * Filter 5m: cây sau đó tăng ≥5% với MAE<3%, lookforward 7d.
 * Phân tích features + binary filter lift.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const TARGET_PCT = 5;
const MAX_ADVERSE_PCT = 3;
const LOOKFORWARD_BARS = 2016; // 7d

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
  console.log(`[mark-5pct-mae3] Loading 5m... TP+${TARGET_PCT}% / MAE<${MAX_ADVERSE_PCT}% / lookforward ${LOOKFORWARD_BARS*5/60/24}d`);
  const c = loadCache("5m");
  const closes = c.map(b=>b.close);
  const rsi = calcRSI(closes, 14);
  const stochK = calcStochK(c, 14);
  const macdH = calcMACDHist(closes);
  const ma50 = calcSMA(closes, 50);
  const ma20 = calcSMA(closes, 20);
  const sd20 = calcStdev(closes, 20, ma20);
  const ma200 = calcSMA(closes, 200);
  const atr14 = calcATR(c, 14);
  const vols = c.map(b=>b.volume??0);
  const volMA = calcSMA(vols, 20);

  const winners: { ts: number; entry: number; tpHitBars: number; mae: number; maxGain: number }[] = [];
  let dirtySL = 0, neverTP = 0;
  for (let i=200;i<c.length-LOOKFORWARD_BARS;i++) {
    const entry = c[i].close;
    const tp = entry*(1+TARGET_PCT/100);
    const sl = entry*(1-MAX_ADVERSE_PCT/100);
    let mae = 0, hit = -1, stopped = false, maxHi = entry;
    const limit = i+1+LOOKFORWARD_BARS;
    for (let j=i+1;j<limit;j++) {
      if (c[j].low <= sl) { const adv=(entry-c[j].low)/entry*100; if (adv>mae) mae=adv; stopped=true; break; }
      const adv = (entry-c[j].low)/entry*100; if (adv>mae) mae=adv;
      if (c[j].high>maxHi) maxHi=c[j].high;
      if (c[j].high>=tp) { hit=j; break; }
    }
    if (hit>=0 && !stopped) winners.push({ts:c[i].time, entry, tpHitBars:hit-i, mae, maxGain:(maxHi-entry)/entry*100});
    else if (stopped) dirtySL++;
    else neverTP++;
  }
  console.log(`\n=== RESULTS ===`);
  const total = c.length-LOOKFORWARD_BARS-200;
  console.log(`Total bars: ${total}`);
  console.log(`✅ CLEAN winners (TP+${TARGET_PCT}% MAE<${MAX_ADVERSE_PCT}%): ${winners.length} (${(winners.length/total*100).toFixed(2)}%)`);
  console.log(`❌ Dirty (giá rớt > ${MAX_ADVERSE_PCT}% trước TP): ${dirtySL} (${(dirtySL/total*100).toFixed(2)}%)`);
  console.log(`❌ Never TP trong ${LOOKFORWARD_BARS*5/60/24}d: ${neverTP} (${(neverTP/total*100).toFixed(2)}%)`);
  if (winners.length>0) {
    const hb = winners.map(w=>w.tpHitBars).sort((a,b)=>a-b);
    const m = winners.map(w=>w.mae).sort((a,b)=>a-b);
    const g = winners.map(w=>w.maxGain).sort((a,b)=>a-b);
    console.log(`\nTime hit +${TARGET_PCT}%: median=${pct(hb,0.5)} bars 5m = ${(pct(hb,0.5)*5/60).toFixed(1)}h  p75=${(pct(hb,0.75)*5/60).toFixed(1)}h  p90=${(pct(hb,0.9)*5/60).toFixed(1)}h`);
    console.log(`MAE: median=${pct(m,0.5).toFixed(2)}%  p75=${pct(m,0.75).toFixed(2)}%  p90=${pct(m,0.9).toFixed(2)}%`);
    console.log(`Max gain: median=${pct(g,0.5).toFixed(2)}%  p90=${pct(g,0.9).toFixed(2)}%`);
  }

  function feats(idx: number) {
    const b = c[idx];
    return {
      rsi: rsi[idx] ?? NaN, stochK: stochK[idx] ?? NaN, macdH: macdH[idx] ?? NaN,
      body: Math.abs(b.close-b.open)/b.open*100,
      upWick: (b.high-Math.max(b.open,b.close))/b.open*100,
      dnWick: (Math.min(b.open,b.close)-b.low)/b.open*100,
      isBull: b.close>b.open?1:0,
      volRatio: volMA[idx] && volMA[idx]!>0 ? (b.volume??0)/volMA[idx]! : NaN,
      bbPos: (ma20[idx]!==null && sd20[idx]!==null && sd20[idx]!>0) ? (b.close-(ma20[idx]!-2*sd20[idx]!))/(4*sd20[idx]!)*100 : NaN,
      mom5: idx>=5 ? (b.close-c[idx-5].close)/c[idx-5].close*100 : NaN,
      mom20: idx>=20 ? (b.close-c[idx-20].close)/c[idx-20].close*100 : NaN,
      mom60: idx>=60 ? (b.close-c[idx-60].close)/c[idx-60].close*100 : NaN,
      atrRatio: atr14[idx] && atr14[idx]!>0 ? (b.high-b.low)/atr14[idx]! : NaN,
      distMA50: ma50[idx] && ma50[idx]!>0 ? (b.close-ma50[idx]!)/ma50[idx]!*100 : NaN,
      distMA200: ma200[idx] && ma200[idx]!>0 ? (b.close-ma200[idx]!)/ma200[idx]!*100 : NaN,
    };
  }
  const winSet = new Set(winners.map(w=>w.ts));
  const winSample = winners.length > 30000 ? winners.slice(0, 30000) : winners;
  const winIdx = winSample.map(w=>{ let lo=0, hi=c.length-1, ans=-1; while (lo<=hi){const m=(lo+hi)>>1; if (c[m].time<=w.ts){ans=m; lo=m+1;} else hi=m-1;} return ans; }).filter(i=>i>=200);
  const baseIdx: number[] = [];
  while (baseIdx.length < Math.min(winIdx.length, 30000)){
    const idx = Math.floor(Math.random()*c.length);
    if (idx>=200 && idx<c.length-LOOKFORWARD_BARS && !winSet.has(c[idx].time)) baseIdx.push(idx);
  }
  console.log(`\n[features] ${winIdx.length} winners + ${baseIdx.length} baseline`);
  const wf = winIdx.map(feats); const bf = baseIdx.map(feats);
  const FEATS = ["rsi","stochK","macdH","body","upWick","dnWick","isBull","volRatio","bbPos","mom5","mom20","mom60","atrRatio","distMA50","distMA200"];
  function stats(arr: any[], k: string) { const v = arr.map(o=>o[k]).filter(x=>Number.isFinite(x)); return {mean:mean(v), median:pct(v,0.5), p25:pct(v,0.25), p75:pct(v,0.75)}; }
  const scored: { feat: string; winMean: number; baseMean: number; deltaNorm: number }[] = [];
  for (const f of FEATS) {
    const w = stats(wf, f), b = stats(bf, f);
    const baseRange = Math.abs(b.p75-b.p25) || Math.abs(b.mean) || 1;
    scored.push({feat:f, winMean:w.mean, baseMean:b.mean, deltaNorm:(w.mean-b.mean)/baseRange});
  }
  scored.sort((a,b)=>Math.abs(b.deltaNorm)-Math.abs(a.deltaNorm));
  console.log("\n=== TOP DISCRIMINATING ===");
  console.log("Feature        | Winner  | Baseline | Δ_norm  | Note");
  for (const s of scored){
    console.log(`${s.feat.padEnd(14)} | ${s.winMean.toFixed(2).padStart(7)} | ${s.baseMean.toFixed(2).padStart(7)} | ${(s.deltaNorm>=0?"+":"")+s.deltaNorm.toFixed(3).padStart(6)}  ${Math.abs(s.deltaNorm)>=0.3?"⭐":""}`);
  }

  const baseRate = winners.length/total*100;
  console.log(`\n=== BINARY FILTER (base ${baseRate.toFixed(2)}%) ===`);
  const conds: { name: string; pred: (idx: number)=>boolean }[] = [
    {name:"RSI<25", pred:i=>(rsi[i]??50)<25},
    {name:"RSI<30", pred:i=>(rsi[i]??50)<30},
    {name:"Stoch K<20", pred:i=>(stochK[i]??50)<20},
    {name:"MACD<-100", pred:i=>(macdH[i]??0)<-100},
    {name:"bbPos<5%", pred:i=>{const m=ma20[i], s=sd20[i]; if(!m||!s||s===0) return false; return (c[i].close-(m-2*s))/(4*s)*100<5;}},
    {name:"distMA50<-3%", pred:i=>{const m=ma50[i]; if(!m) return false; return (c[i].close-m)/m*100<-3;}},
    {name:"distMA50<-5%", pred:i=>{const m=ma50[i]; if(!m) return false; return (c[i].close-m)/m*100<-5;}},
    {name:"distMA200<-5%", pred:i=>{const m=ma200[i]; if(!m) return false; return (c[i].close-m)/m*100<-5;}},
    {name:"distMA200<-10%", pred:i=>{const m=ma200[i]; if(!m) return false; return (c[i].close-m)/m*100<-10;}},
    {name:"dnWick≥0.5%", pred:i=>(Math.min(c[i].open,c[i].close)-c[i].low)/c[i].open*100>=0.5},
    {name:"vol≥3×", pred:i=>{const v=volMA[i]; if(!v) return false; return (c[i].volume??0)/v>=3;}},
    {name:"mom20<-3%", pred:i=>i>=20?((c[i].close-c[i-20].close)/c[i-20].close*100)<-3:false},
    {name:"mom60<-5%", pred:i=>i>=60?((c[i].close-c[i-60].close)/c[i-60].close*100)<-5:false},
    {name:"COMBO bbPos<5+mom20<-3", pred:i=>{const ma=ma20[i], sd=sd20[i]; if(!ma||!sd) return false; const bp=(c[i].close-(ma-2*sd))/(4*sd)*100; const m20=i>=20?(c[i].close-c[i-20].close)/c[i-20].close*100:0; return bp<5 && m20<-3;}},
    {name:"COMBO RSI<30+distMA200<-5", pred:i=>{const m=ma200[i]; if(!m) return false; return (rsi[i]??50)<30 && (c[i].close-m)/m*100<-5;}},
    {name:"COMBO distMA200<-10+mom60<-5", pred:i=>{const m=ma200[i]; if(!m) return false; const cond1=(c[i].close-m)/m*100<-10; const cond2=i>=60?((c[i].close-c[i-60].close)/c[i-60].close*100)<-5:false; return cond1&&cond2;}},
  ];
  for (const cond of conds) {
    let totalMatch=0, win=0;
    for (let i=200;i<c.length-LOOKFORWARD_BARS;i++) if (cond.pred(i)) {totalMatch++; if (winSet.has(c[i].time)) win++;}
    const wr = totalMatch>0 ? win/totalMatch*100 : 0;
    const lift = wr/baseRate;
    console.log(`  ${cond.name.padEnd(38)}: ${totalMatch.toString().padStart(7)} bars → ${win.toString().padStart(6)} clean (${wr.toFixed(1)}%, lift ${lift.toFixed(2)}×) ${lift>=1.5?"⭐⭐":lift>=1.3?"⭐":""}`);
  }
}
main();
