/**
 * analyze-mae-sl-tp.ts (anh Tommy 2026-05-04)
 * Tính MAE (Max Adverse Excursion) cho mỗi entry signal score ≥9/11.
 * → recommend SL = p75 hoặc p90 của MAE.
 * Cũng tính MFE (Max Favorable) → recommend TP optimal.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const COOLDOWN_MS = 60*60_000;
const SCORE_LONG = 9, SCORE_SHORT = 9;
const FORWARD_BARS_15M = 96 * 7; // 7 ngày để tính MFE/MAE

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
  console.log("[mae-sl-tp] Loading 15m...");
  const c = loadCache("15m");

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

  // Identify signals score ≥ 9/11
  const longSigs: number[] = [];
  const shortSigs: number[] = [];
  for (let i=20;i<c.length;i++){
    const b = c[i];
    const dnW = (Math.min(b.open,b.close)-b.low)/b.open*100;
    const upW = (b.high-Math.max(b.open,b.close))/b.open*100;
    const body = Math.abs(b.close-b.open)/b.open*100;
    const isBull = b.close>b.open ? 1 : 0;
    const volR = volMA[i] && volMA[i]!>0 ? (b.volume??0)/volMA[i]! : 0;
    const ma=ma20[i], sd=sd20[i];
    const bbPos = (ma!==null && sd!==null && sd>0) ? (b.close-(ma-2*sd))/(4*sd)*100 : 50;
    const mom5 = i>=5 ? (b.close-c[i-5].close)/c[i-5].close*100 : 0;
    const mom10 = i>=10 ? (b.close-c[i-10].close)/c[i-10].close*100 : 0;
    const mom20 = i>=20 ? (b.close-c[i-20].close)/c[i-20].close*100 : 0;
    const atr = atr14[i]; const range = b.high-b.low;
    const atrR = atr && atr>0 ? range/atr : 0;
    const distMA50 = ma50[i] && ma50[i]!>0 ? (b.close-ma50[i]!)/ma50[i]!*100 : 0;
    const r = rsi[i] ?? 50;
    const sk = stochK[i] ?? 50;
    const mh = macdH[i] ?? 0;
    let lS=0, sS=0;
    if (dnW>=0.5) lS++; if (body>=0.5) lS++; if (isBull===0) lS++; if (volR>=2.0) lS++; if (atrR>=1.5) lS++; if (r<=35) lS++; if (sk<=30) lS++; if (mh<=-100) lS++; if (bbPos<=5) lS++; if (distMA50<=-3) lS++; if (mom5<0&&mom10<0&&mom20<0) lS++;
    if (upW>=0.5) sS++; if (body>=0.5) sS++; if (isBull===1) sS++; if (volR>=2.0) sS++; if (atrR>=1.5) sS++; if (r>=65) sS++; if (sk>=70) sS++; if (mh>=100) sS++; if (bbPos>=95) sS++; if (distMA50>=3) sS++; if (mom5>0&&mom10>0&&mom20>0) sS++;
    if (lS>=SCORE_LONG) longSigs.push(i);
    if (sS>=SCORE_SHORT) shortSigs.push(i);
  }
  console.log(`[mae] Signals: LONG ${longSigs.length}, SHORT ${shortSigs.length}`);

  // Compute MAE/MFE for LONG signals (entry at close)
  // MAE = max % drop from entry close before any TP-like favorable
  // MFE = max % gain
  function analyzeLong(signals: number[]) {
    const maes: number[] = []; const mfes: number[] = []; const timeToMfeBars: number[] = [];
    for (const idx of signals){
      const entry = c[idx].close;
      let maxDown = 0, maxUp = 0, idxOfMaxUp = idx;
      const limit = Math.min(c.length, idx + 1 + FORWARD_BARS_15M);
      for (let j=idx+1;j<limit;j++){
        const lowPct = (entry - c[j].low)/entry*100;  // adverse for long
        const highPct = (c[j].high - entry)/entry*100; // favorable
        if (lowPct > maxDown) maxDown = lowPct;
        if (highPct > maxUp){maxUp = highPct; idxOfMaxUp = j;}
      }
      maes.push(maxDown);
      mfes.push(maxUp);
      timeToMfeBars.push(idxOfMaxUp - idx);
    }
    return {maes, mfes, timeToMfeBars};
  }
  function analyzeShort(signals: number[]) {
    const maes: number[] = []; const mfes: number[] = []; const timeToMfeBars: number[] = [];
    for (const idx of signals){
      const entry = c[idx].close;
      let maxUp = 0, maxDown = 0, idxOfMaxDown = idx;
      const limit = Math.min(c.length, idx + 1 + FORWARD_BARS_15M);
      for (let j=idx+1;j<limit;j++){
        const highPct = (c[j].high - entry)/entry*100;  // adverse for short
        const lowPct = (entry - c[j].low)/entry*100; // favorable
        if (highPct > maxUp) maxUp = highPct;
        if (lowPct > maxDown){maxDown = lowPct; idxOfMaxDown = j;}
      }
      maes.push(maxUp);
      mfes.push(maxDown);
      timeToMfeBars.push(idxOfMaxDown - idx);
    }
    return {maes, mfes, timeToMfeBars};
  }

  const L = analyzeLong(longSigs);
  const S = analyzeShort(shortSigs);

  function dist(arr: number[], label: string){
    if (arr.length===0) {console.log(`${label}: empty`); return;}
    console.log(`${label.padEnd(40)} mean=${mean(arr).toFixed(2)}%  p25=${pct(arr,0.25).toFixed(2)}  med=${pct(arr,0.5).toFixed(2)}  p75=${pct(arr,0.75).toFixed(2)}  p90=${pct(arr,0.9).toFixed(2)}  max=${pct(arr,1).toFixed(2)}`);
  }

  console.log("\n=== LONG signals score≥9/11 (n="+longSigs.length+") ===");
  dist(L.maes, "MAE (max adverse drop %)");
  dist(L.mfes, "MFE (max favorable gain %)");
  dist(L.timeToMfeBars.map(b=>b*0.25), "Hours to MFE");

  console.log("\n=== SHORT signals score≥9/11 (n="+shortSigs.length+") ===");
  dist(S.maes, "MAE (max adverse rise %)");
  dist(S.mfes, "MFE (max favorable drop %)");
  dist(S.timeToMfeBars.map(b=>b*0.25), "Hours to MFE");

  // Hit rate at SL/TP combinations for LONG
  console.log("\n=== LONG: HIT RATE TP at various SL combos ===");
  const tps = [3, 5, 8, 10, 15, 20];
  const sls = [2, 3, 5, 8, 10];
  // For each pair (sl, tp): count trades that hit TP first vs SL first vs neither
  function simSLTP(c: Candle[], signals: number[], side: "LONG"|"SHORT", sl: number, tp: number) {
    let win=0, lose=0, neither=0;
    for (const idx of signals){
      const entry = c[idx].close;
      const limit = Math.min(c.length, idx+1+FORWARD_BARS_15M);
      let res: "WIN"|"LOSE"|"NONE" = "NONE";
      for (let j=idx+1;j<limit;j++){
        if (side==="LONG"){
          const highPct = (c[j].high-entry)/entry*100;
          const lowPct = (entry-c[j].low)/entry*100;
          // Check SL first (conservative — assume worst case)
          if (lowPct >= sl){res="LOSE"; break;}
          if (highPct >= tp){res="WIN"; break;}
        } else {
          const highPct = (c[j].high-entry)/entry*100;
          const lowPct = (entry-c[j].low)/entry*100;
          if (highPct >= sl){res="LOSE"; break;}
          if (lowPct >= tp){res="WIN"; break;}
        }
      }
      if (res==="WIN") win++; else if (res==="LOSE") lose++; else neither++;
    }
    const total = win+lose+neither;
    return {win, lose, neither, total, wr: win/(win+lose||1), ev: tp*(win/total) - sl*(lose/total)};
  }

  console.log("\n=== LONG: SL/TP grid → EV per trade (% of entry) ===");
  console.log("        TP→  " + tps.map(t=>`TP${t}%`.padStart(7)).join("  "));
  for (const sl of sls){
    const row = [`SL${sl}%`.padEnd(6)];
    for (const tp of tps){
      const r = simSLTP(c, longSigs, "LONG", sl, tp);
      row.push(`${(r.ev>=0?"+":"")+r.ev.toFixed(2)}%`.padStart(7));
    }
    console.log(row.join("  "));
  }

  console.log("\n=== LONG: SL/TP grid → WR (win/(win+lose)) ===");
  console.log("        TP→  " + tps.map(t=>`TP${t}%`.padStart(7)).join("  "));
  for (const sl of sls){
    const row = [`SL${sl}%`.padEnd(6)];
    for (const tp of tps){
      const r = simSLTP(c, longSigs, "LONG", sl, tp);
      row.push(`${(r.wr*100).toFixed(0)}%`.padStart(7));
    }
    console.log(row.join("  "));
  }

  console.log("\n=== SHORT: SL/TP grid → EV per trade ===");
  console.log("        TP→  " + tps.map(t=>`TP${t}%`.padStart(7)).join("  "));
  for (const sl of sls){
    const row = [`SL${sl}%`.padEnd(6)];
    for (const tp of tps){
      const r = simSLTP(c, shortSigs, "SHORT", sl, tp);
      row.push(`${(r.ev>=0?"+":"")+r.ev.toFixed(2)}%`.padStart(7));
    }
    console.log(row.join("  "));
  }

  console.log("\n=== SHORT: SL/TP grid → WR ===");
  console.log("        TP→  " + tps.map(t=>`TP${t}%`.padStart(7)).join("  "));
  for (const sl of sls){
    const row = [`SL${sl}%`.padEnd(6)];
    for (const tp of tps){
      const r = simSLTP(c, shortSigs, "SHORT", sl, tp);
      row.push(`${(r.wr*100).toFixed(0)}%`.padStart(7));
    }
    console.log(row.join("  "));
  }

  writeFileSync(join(__dirname,"..","assets","analyze_mae_sl_tp.json"), JSON.stringify({
    longSignals: longSigs.length, shortSignals: shortSigs.length,
    longMAE: {p25:pct(L.maes,0.25), p50:pct(L.maes,0.5), p75:pct(L.maes,0.75), p90:pct(L.maes,0.9), max:pct(L.maes,1)},
    longMFE: {p25:pct(L.mfes,0.25), p50:pct(L.mfes,0.5), p75:pct(L.mfes,0.75), p90:pct(L.mfes,0.9), max:pct(L.mfes,1)},
    shortMAE: {p25:pct(S.maes,0.25), p50:pct(S.maes,0.5), p75:pct(S.maes,0.75), p90:pct(S.maes,0.9), max:pct(S.maes,1)},
    shortMFE: {p25:pct(S.mfes,0.25), p50:pct(S.mfes,0.5), p75:pct(S.mfes,0.75), p90:pct(S.mfes,0.9), max:pct(S.mfes,1)},
  }));
  console.log(`\nSaved → assets/analyze_mae_sl_tp.json`);
}
main();
