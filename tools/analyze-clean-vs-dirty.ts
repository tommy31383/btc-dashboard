/**
 * analyze-clean-vs-dirty.ts (anh Tommy 2026-05-04)
 * Tìm features phân biệt CLEAN (MAE<3% hit TP) vs DIRTY entries trong cùng pool score≥9.
 * Mục tiêu: feature predictive → add filter real-time entry.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const TP_PCT = 5;
const MAX_ADVERSE_PCT = 3;
const FORWARD_BARS_15M = 96 * 7;
const SCORE_MIN = 9;

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
  const c15 = loadCache("15m"); const c1h = loadCache("1h"); const c4h = loadCache("4h"); const c1d = loadCache("1d");
  const closes15 = c15.map(b=>b.close);
  const rsi = calcRSI(closes15, 14);
  const stochK = calcStochK(c15, 14);
  const macdH = calcMACDHist(closes15);
  const ma50 = calcSMA(closes15, 50);
  const ma20 = calcSMA(closes15, 20);
  const sd20 = calcStdev(closes15, 20, ma20);
  const atr14 = calcATR(c15, 14);
  const vols = c15.map(b=>b.volume??0);
  const volMA = calcSMA(vols, 20);

  // HTF indicators
  const closes1h = c1h.map(b=>b.close);
  const rsi1h = calcRSI(closes1h, 14);
  const ma200_1h = calcSMA(closes1h, 200);
  const closes1d = c1d.map(b=>b.close);
  const ma200_1d = calcSMA(closes1d, 200);
  const ma50_1d = calcSMA(closes1d, 50);
  function findIdx(arr: { time: number }[], t: number): number { let lo=0, hi=arr.length-1, ans=-1; while (lo<=hi){const m=(lo+hi)>>1; if (arr[m].time<=t){ans=m; lo=m+1;} else hi=m-1;} return ans; }

  // BB width % cho 15m
  const bbW: number[] = new Array(c15.length).fill(NaN);
  for (let i=0;i<c15.length;i++){
    const m=ma20[i], sd=sd20[i];
    if (m && sd) bbW[i] = (4*sd)/m*100;
  }

  // Build all signals score≥9 + extract features
  function getScores(i: number) {
    const b = c15[i];
    const dnW = (Math.min(b.open,b.close)-b.low)/b.open*100;
    const upW = (b.high-Math.max(b.open,b.close))/b.open*100;
    const body = Math.abs(b.close-b.open)/b.open*100;
    const isBull = b.close>b.open ? 1 : 0;
    const volR = volMA[i] && volMA[i]!>0 ? (b.volume??0)/volMA[i]! : 0;
    const ma=ma20[i], sd=sd20[i];
    const bbPos = (ma!==null && sd!==null && sd>0) ? (b.close-(ma-2*sd))/(4*sd)*100 : 50;
    const mom5 = i>=5 ? (b.close-c15[i-5].close)/c15[i-5].close*100 : 0;
    const mom10 = i>=10 ? (b.close-c15[i-10].close)/c15[i-10].close*100 : 0;
    const mom20 = i>=20 ? (b.close-c15[i-20].close)/c15[i-20].close*100 : 0;
    const atr = atr14[i]; const range = b.high-b.low;
    const atrR = atr && atr>0 ? range/atr : 0;
    const distMA50 = ma50[i] && ma50[i]!>0 ? (b.close-ma50[i]!)/ma50[i]!*100 : 0;
    const r = rsi[i] ?? 50;
    const sk = stochK[i] ?? 50;
    const mh = macdH[i] ?? 0;
    let lS=0, sS=0;
    if (dnW>=0.5) lS++; if (body>=0.5) lS++; if (isBull===0) lS++; if (volR>=2.0) lS++; if (atrR>=1.5) lS++; if (r<=35) lS++; if (sk<=30) lS++; if (mh<=-100) lS++; if (bbPos<=5) lS++; if (distMA50<=-3) lS++; if (mom5<0&&mom10<0&&mom20<0) lS++;
    if (upW>=0.5) sS++; if (body>=0.5) sS++; if (isBull===1) sS++; if (volR>=2.0) sS++; if (atrR>=1.5) sS++; if (r>=65) sS++; if (sk>=70) sS++; if (mh>=100) sS++; if (bbPos>=95) sS++; if (distMA50>=3) sS++; if (mom5>0&&mom10>0&&mom20>0) sS++;
    return {lS, sS};
  }

  // Extra features (PREDICTIVE candidates)
  function getExtra(i: number, side: "LONG"|"SHORT") {
    const b = c15[i];
    // HTF trend
    const idx1d = findIdx(c1d, b.time);
    const idx1h = findIdx(c1h, b.time);
    const ma200d = idx1d>=200 ? ma200_1d[idx1d] : null;
    const ma50d = idx1d>=50 ? ma50_1d[idx1d] : null;
    const ma200h = idx1h>=200 ? ma200_1h[idx1h] : null;
    const trendD200 = ma200d && idx1d>=0 ? (c1d[idx1d].close > ma200d ? 1 : 0) : 0;
    const trendD50 = ma50d && idx1d>=0 ? (c1d[idx1d].close > ma50d ? 1 : 0) : 0;
    const trendH200 = ma200h && idx1h>=0 ? (c1h[idx1h].close > ma200h ? 1 : 0) : 0;
    const rsi1hVal = idx1h>=0 ? (rsi1h[idx1h] ?? 50) : 50;
    // Score (degree of agreement)
    const {lS, sS} = getScores(i);
    const score = side==="LONG" ? lS : sS;
    // BB width
    const bbWidth = bbW[i];
    // ATR%
    const atrPct = atr14[i] && b.close>0 ? atr14[i]!/b.close*100 : NaN;
    // Hour of day
    const dt = new Date(b.time);
    const hour = dt.getUTCHours();
    // Day of week
    const dayOfWeek = dt.getUTCDay();
    // Distance to nearest MA50 (15m)
    const distMA50 = ma50[i] ? (b.close - ma50[i]!)/ma50[i]!*100 : NaN;
    return { score, trendD200, trendD50, trendH200, rsi1h: rsi1hVal, bbWidth, atrPct, hour, dayOfWeek, distMA50 };
  }

  // Identify CLEAN/DIRTY for both sides
  const longResults: { idx: number; isClean: boolean; feat: any }[] = [];
  const shortResults: { idx: number; isClean: boolean; feat: any }[] = [];

  for (let i=20;i<c15.length-FORWARD_BARS_15M;i++){
    const {lS, sS} = getScores(i);
    if (lS>=SCORE_MIN){
      const entry = c15[i].close;
      const tp = entry*(1+TP_PCT/100), sl = entry*(1-MAX_ADVERSE_PCT/100);
      let clean = false;
      const limit = Math.min(c15.length, i+1+FORWARD_BARS_15M);
      for (let j=i+1;j<limit;j++){
        if (c15[j].low <= sl) {clean=false; break;}
        if (c15[j].high >= tp) {clean=true; break;}
      }
      longResults.push({idx:i, isClean:clean, feat: getExtra(i, "LONG")});
    }
    if (sS>=SCORE_MIN){
      const entry = c15[i].close;
      const tp = entry*(1-TP_PCT/100), sl = entry*(1+MAX_ADVERSE_PCT/100);
      let clean = false;
      const limit = Math.min(c15.length, i+1+FORWARD_BARS_15M);
      for (let j=i+1;j<limit;j++){
        if (c15[j].high >= sl) {clean=false; break;}
        if (c15[j].low <= tp) {clean=true; break;}
      }
      shortResults.push({idx:i, isClean:clean, feat: getExtra(i, "SHORT")});
    }
  }

  function compareFeats(side: string, results: typeof longResults) {
    const clean = results.filter(r=>r.isClean);
    const dirty = results.filter(r=>!r.isClean);
    console.log(`\n=== ${side} ===  CLEAN ${clean.length} vs DIRTY ${dirty.length}`);
    const FEATS = ["score","trendD200","trendD50","trendH200","rsi1h","bbWidth","atrPct","hour","dayOfWeek","distMA50"];
    console.log("Feature       | CLEAN mean med  | DIRTY mean med  | Δ_norm  | Note");
    for (const f of FEATS) {
      const cv = clean.map(r=>r.feat[f]).filter(x=>Number.isFinite(x));
      const dv = dirty.map(r=>r.feat[f]).filter(x=>Number.isFinite(x));
      if (cv.length===0 || dv.length===0) continue;
      const cm = mean(cv), dm = mean(dv);
      const dvRange = Math.abs(pct(dv,0.75)-pct(dv,0.25)) || Math.abs(dm) || 1;
      const dn = (cm - dm) / dvRange;
      console.log(`${f.padEnd(13)} | ${cm.toFixed(2).padStart(7)} ${pct(cv,0.5).toFixed(2).padStart(6)}  | ${dm.toFixed(2).padStart(7)} ${pct(dv,0.5).toFixed(2).padStart(6)}  | ${(dn>=0?"+":"")+dn.toFixed(2).padStart(6)}  ${Math.abs(dn)>=0.3?"⭐":""}`);
    }

    // Test specific binary filter rules
    console.log(`\n${side} BINARY FILTER TEST (CLEAN rate by condition):`);
    const conditions: { name: string; pred: (r: any)=>boolean }[] = [
      side === "LONG" ?
        [
          {name: "trendD200=1 (BTC>MA200d)", pred: (r:any)=>r.feat.trendD200===1},
          {name: "trendD200=0 (BTC<MA200d)", pred: (r:any)=>r.feat.trendD200===0},
          {name: "trendD50=1 (BTC>MA50d)", pred: (r:any)=>r.feat.trendD50===1},
          {name: "trendH200=1 (BTC>MA200h)", pred: (r:any)=>r.feat.trendH200===1},
          {name: "rsi1h<35", pred: (r:any)=>r.feat.rsi1h<35},
          {name: "rsi1h<30", pred: (r:any)=>r.feat.rsi1h<30},
          {name: "score=11/11", pred: (r:any)=>r.feat.score===11},
          {name: "score=10/11", pred: (r:any)=>r.feat.score===10},
          {name: "bbWidth<3%", pred: (r:any)=>r.feat.bbWidth<3},
          {name: "atrPct<1%", pred: (r:any)=>r.feat.atrPct<1},
        ] :
        [
          {name: "trendD200=0 (BTC<MA200d)", pred: (r:any)=>r.feat.trendD200===0},
          {name: "trendD200=1 (BTC>MA200d)", pred: (r:any)=>r.feat.trendD200===1},
          {name: "trendD50=0 (BTC<MA50d)", pred: (r:any)=>r.feat.trendD50===0},
          {name: "trendH200=0 (BTC<MA200h)", pred: (r:any)=>r.feat.trendH200===0},
          {name: "rsi1h>65", pred: (r:any)=>r.feat.rsi1h>65},
          {name: "rsi1h>70", pred: (r:any)=>r.feat.rsi1h>70},
          {name: "score=11/11", pred: (r:any)=>r.feat.score===11},
          {name: "score=10/11", pred: (r:any)=>r.feat.score===10},
          {name: "bbWidth<3%", pred: (r:any)=>r.feat.bbWidth<3},
          {name: "atrPct<1%", pred: (r:any)=>r.feat.atrPct<1},
        ]
    ][0] as any;
    for (const cond of conditions){
      const filtered = results.filter(cond.pred);
      const filteredClean = filtered.filter(r=>r.isClean).length;
      const cleanRate = filtered.length>0 ? filteredClean/filtered.length*100 : 0;
      const baseRate = clean.length/results.length*100;
      const lift = cleanRate / baseRate;
      console.log(`  ${cond.name.padEnd(28)}: ${filtered.length} signals, ${filteredClean} clean = ${cleanRate.toFixed(0)}% (base ${baseRate.toFixed(0)}%, lift ${lift.toFixed(2)}×)`);
    }
  }

  compareFeats("LONG", longResults);
  compareFeats("SHORT", shortResults);

  writeFileSync(join(__dirname,"..","assets","analyze_clean_vs_dirty.json"), JSON.stringify({
    longTotal: longResults.length, longClean: longResults.filter(r=>r.isClean).length,
    shortTotal: shortResults.length, shortClean: shortResults.filter(r=>r.isClean).length,
  }));
  console.log("\nDone.");
}
main();
