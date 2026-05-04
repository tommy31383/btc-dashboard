/**
 * filter-clean-both.ts (anh Tommy 2026-05-04)
 * Filter BOTH LONG + SHORT signals score≥9: chỉ giữ cây có MAE < 3% trước khi hit TP 5%.
 * = "clean signals" — SL nhỏ < 3%.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const TP_PCT = 5;
const MAX_ADVERSE_PCT = 3;
const FORWARD_BARS_15M = 96 * 7;

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }

function loadCache(tf: string): Candle[] { return JSON.parse(readFileSync(join(__dirname,"..",".cache",`binance-${tf}-3y.json`),"utf8")); }
function calcSMA(a: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); if (a.length<p) return o; let s=0; for (let i=0;i<p;i++) s+=a[i]; o[p-1]=s/p; for (let i=p;i<a.length;i++){s+=a[i]-a[i-p]; o[i]=s/p;} return o; }
function calcEMA(a: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); if (a.length<p) return o; const k=2/(p+1); let e=0; for (let i=0;i<p;i++) e+=a[i]; e/=p; o[p-1]=e; for (let i=p;i<a.length;i++){e=a[i]*k+e*(1-k); o[i]=e;} return o; }
function calcStdev(a: number[], p: number, sma: (number|null)[]): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); for (let i=p-1;i<a.length;i++){const m=sma[i]; if (m===null) continue; let sq=0; for (let j=i-p+1;j<=i;j++) sq+=(a[j]-m)**2; o[i]=Math.sqrt(sq/p);} return o; }
function calcRSI(c: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(c.length).fill(null); if (c.length<=p) return o; let g=0,l=0; for (let i=1;i<=p;i++){const ch=c[i]-c[i-1]; if (ch>=0) g+=ch; else l-=ch;} let ag=g/p, al=l/p; o[p]=al===0?100:100-100/(1+ag/al); for (let i=p+1;i<c.length;i++){const ch=c[i]-c[i-1]; ag=(ag*(p-1)+Math.max(ch,0))/p; al=(al*(p-1)+Math.max(-ch,0))/p; o[i]=al===0?100:100-100/(1+ag/al);} return o; }
function calcStochK(c: Candle[], p: number): (number|null)[] { const o: (number|null)[] = new Array(c.length).fill(null); for (let i=p-1;i<c.length;i++){let hi=-Infinity, lo=Infinity; for (let j=i-p+1;j<=i;j++){if (c[j].high>hi) hi=c[j].high; if (c[j].low<lo) lo=c[j].low;} o[i]=hi===lo?50:((c[i].close-lo)/(hi-lo))*100;} return o; }
function calcATR(c: Candle[], p: number): (number|null)[] { const o: (number|null)[] = new Array(c.length).fill(null); if (c.length<=p) return o; const tr: number[] = new Array(c.length).fill(0); for (let i=1;i<c.length;i++) tr[i]=Math.max(c[i].high-c[i].low, Math.abs(c[i].high-c[i-1].close), Math.abs(c[i].low-c[i-1].close)); let s=0; for (let i=1;i<=p;i++) s+=tr[i]; o[p]=s/p; for (let i=p+1;i<c.length;i++) o[i]=(o[i-1]!*(p-1)+tr[i])/p; return o; }
function calcMACDHist(c: number[]): (number|null)[] { const e12=calcEMA(c,12), e26=calcEMA(c,26); const macd: (number|null)[] = c.map((_,i) => (e12[i]!=null && e26[i]!=null) ? e12[i]!-e26[i]! : null); const v: number[]=[], m: number[]=[]; for (let i=0;i<macd.length;i++) if (macd[i]!==null){v.push(macd[i]!); m.push(i);} const sigEma = calcEMA(v, 9); const signal: (number|null)[] = new Array(c.length).fill(null); for (let k=0;k<sigEma.length;k++) if (sigEma[k]!==null) signal[m[k]] = sigEma[k]; return c.map((_,i) => (macd[i]!=null && signal[i]!=null) ? macd[i]!-signal[i]! : null); }

function main() {
  const c = loadCache("15m"); const c5 = loadCache("5m");
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

  const longIdx: number[] = [], shortIdx: number[] = [];
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
    if (lS>=9) longIdx.push(i);
    if (sS>=9) shortIdx.push(i);
  }
  console.log(`Total signals score≥9: LONG ${longIdx.length}, SHORT ${shortIdx.length}`);

  // Filter clean LONG: from entry close, before hit TP+5%, MAE (max DROP) ≤ 3%
  const cleanLong: any[] = [];
  let dirtyLongHighMAE = 0, dirtyLongNoTP = 0;
  for (const idx of longIdx) {
    const entry = c[idx].close;
    const tpTarget = entry * (1 + TP_PCT/100);
    const slBound = entry * (1 - MAX_ADVERSE_PCT/100);
    let mae = 0, hitTP = -1, stopped = false;
    const limit = Math.min(c.length, idx + 1 + FORWARD_BARS_15M);
    for (let j=idx+1; j<limit; j++) {
      if (c[j].low <= slBound) {
        const adv = (entry - c[j].low)/entry*100;
        if (adv > mae) mae = adv;
        stopped = true; break;
      }
      const adv = (entry - c[j].low)/entry*100;
      if (adv > mae) mae = adv;
      if (c[j].high >= tpTarget) { hitTP = j; break; }
    }
    if (hitTP >= 0 && !stopped) {
      cleanLong.push({ts:c[idx].time, entry, tpHitTs:c[hitTP].time, tpHitBars:hitTP-idx, mae});
    } else if (stopped) dirtyLongHighMAE++;
    else dirtyLongNoTP++;
  }

  // Filter clean SHORT: from entry close, before hit TP-5%, MAE (max RISE) ≤ 3%
  const cleanShort: any[] = [];
  let dirtyShortHighMAE = 0, dirtyShortNoTP = 0;
  for (const idx of shortIdx) {
    const entry = c[idx].close;
    const tpTarget = entry * (1 - TP_PCT/100);
    const slBound = entry * (1 + MAX_ADVERSE_PCT/100);
    let mae = 0, hitTP = -1, stopped = false;
    const limit = Math.min(c.length, idx + 1 + FORWARD_BARS_15M);
    for (let j=idx+1; j<limit; j++) {
      if (c[j].high >= slBound) {
        const adv = (c[j].high - entry)/entry*100;
        if (adv > mae) mae = adv;
        stopped = true; break;
      }
      const adv = (c[j].high - entry)/entry*100;
      if (adv > mae) mae = adv;
      if (c[j].low <= tpTarget) { hitTP = j; break; }
    }
    if (hitTP >= 0 && !stopped) {
      cleanShort.push({ts:c[idx].time, entry, tpHitTs:c[hitTP].time, tpHitBars:hitTP-idx, mae});
    } else if (stopped) dirtyShortHighMAE++;
    else dirtyShortNoTP++;
  }

  function pct(x: number[], q: number) { if (x.length===0) return NaN; const s=[...x].sort((a,b)=>a-b); return s[Math.min(Math.floor(s.length*q), s.length-1)]; }
  function mean(x: number[]) { return x.length ? x.reduce((s,v)=>s+v,0)/x.length : NaN; }

  console.log(`\n=== FILTER (TP=${TP_PCT}%, MAE max=${MAX_ADVERSE_PCT}%) ===`);
  console.log(`\nLONG: ${longIdx.length} total → ✅ ${cleanLong.length} CLEAN (${(cleanLong.length/longIdx.length*100).toFixed(0)}%)`);
  console.log(`  ❌ MAE > 3%: ${dirtyLongHighMAE}  ❌ no TP: ${dirtyLongNoTP}`);
  if (cleanLong.length>0) {
    const m = cleanLong.map(c=>c.mae); const t = cleanLong.map(c=>c.tpHitBars);
    console.log(`  CLEAN MAE: med=${pct(m,0.5).toFixed(2)}%  mean=${mean(m).toFixed(2)}%  p75=${pct(m,0.75).toFixed(2)}%`);
    console.log(`  CLEAN time to TP: med=${pct(t,0.5)} bars = ${(pct(t,0.5)*0.25).toFixed(1)}h  p75=${(pct(t,0.75)*0.25).toFixed(1)}h`);
  }

  console.log(`\nSHORT: ${shortIdx.length} total → ✅ ${cleanShort.length} CLEAN (${(cleanShort.length/shortIdx.length*100).toFixed(0)}%)`);
  console.log(`  ❌ MAE > 3%: ${dirtyShortHighMAE}  ❌ no TP: ${dirtyShortNoTP}`);
  if (cleanShort.length>0) {
    const m = cleanShort.map(c=>c.mae); const t = cleanShort.map(c=>c.tpHitBars);
    console.log(`  CLEAN MAE: med=${pct(m,0.5).toFixed(2)}%  mean=${mean(m).toFixed(2)}%  p75=${pct(m,0.75).toFixed(2)}%`);
    console.log(`  CLEAN time to TP: med=${pct(t,0.5)} bars = ${(pct(t,0.5)*0.25).toFixed(1)}h  p75=${(pct(t,0.75)*0.25).toFixed(1)}h`);
  }

  console.log(`\n=== EV PER TRADE ===`);
  console.log(`Mỗi clean trade = +${TP_PCT}% (chắc 100% hit)`);
  console.log(`LONG total EV: ${cleanLong.length} × ${TP_PCT}% = ${cleanLong.length*TP_PCT}% notional`);
  console.log(`SHORT total EV: ${cleanShort.length} × ${TP_PCT}% = ${cleanShort.length*TP_PCT}% notional`);
  console.log(`COMBINED: ${(cleanLong.length+cleanShort.length)} × ${TP_PCT}% = ${(cleanLong.length+cleanShort.length)*TP_PCT}% notional`);

  // Build chart data
  const cleanLongSet = new Set(cleanLong.map(c=>c.ts));
  const cleanShortSet = new Set(cleanShort.map(c=>c.ts));
  const longMarkers = longIdx.map(idx => ({ts:c[idx].time, price:c[idx].close, low:c[idx].low, isClean: cleanLongSet.has(c[idx].time)}));
  const shortMarkers = shortIdx.map(idx => ({ts:c[idx].time, price:c[idx].close, high:c[idx].high, isClean: cleanShortSet.has(c[idx].time)}));

  const priceLine: { ts: number; price: number }[] = [];
  const step = 10;
  for (let i=0;i<c5.length;i+=step) priceLine.push({ts:c5[i].time, price:c5[i].close});

  writeFileSync(join(__dirname,"..","assets","clean_signals_both.json"), JSON.stringify({
    period:{start:c5[0].time, end:c5[c5.length-1].time},
    config:{tpPct:TP_PCT, maxAdversePct:MAX_ADVERSE_PCT, scoreMin:9},
    totalLongs: longIdx.length, cleanLongs: cleanLong.length,
    totalShorts: shortIdx.length, cleanShorts: cleanShort.length,
    longMarkers, shortMarkers, priceLine,
  }));
  console.log("\nSaved → assets/clean_signals_both.json");
}
main();
