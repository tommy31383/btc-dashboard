/**
 * analyze-btc-drop-100k-70k.ts (anh Tommy 2026-05-04)
 * Forensic analysis: tìm period BTC từ $100k → $70k.
 * Dump indicators tuần (1w) + tháng-equiv (4w) + 1d trong period đó.
 * Mục đích: học signal cảnh báo SẬP.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }

function loadCache(tf: string): Candle[] { return JSON.parse(readFileSync(join(__dirname,"..",".cache",`binance-${tf}-3y.json`),"utf8")); }
function calcSMA(a: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); if (a.length<p) return o; let s=0; for (let i=0;i<p;i++) s+=a[i]; o[p-1]=s/p; for (let i=p;i<a.length;i++){s+=a[i]-a[i-p]; o[i]=s/p;} return o; }
function calcEMA(a: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); if (a.length<p) return o; const k=2/(p+1); let e=0; for (let i=0;i<p;i++) e+=a[i]; e/=p; o[p-1]=e; for (let i=p;i<a.length;i++){e=a[i]*k+e*(1-k); o[i]=e;} return o; }
function calcStdev(a: number[], p: number, sma: (number|null)[]): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); for (let i=p-1;i<a.length;i++){const m=sma[i]; if (m===null) continue; let sq=0; for (let j=i-p+1;j<=i;j++) sq+=(a[j]-m)**2; o[i]=Math.sqrt(sq/p);} return o; }
function calcRSI(c: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(c.length).fill(null); if (c.length<=p) return o; let g=0,l=0; for (let i=1;i<=p;i++){const ch=c[i]-c[i-1]; if (ch>=0) g+=ch; else l-=ch;} let ag=g/p, al=l/p; o[p]=al===0?100:100-100/(1+ag/al); for (let i=p+1;i<c.length;i++){const ch=c[i]-c[i-1]; ag=(ag*(p-1)+Math.max(ch,0))/p; al=(al*(p-1)+Math.max(-ch,0))/p; o[i]=al===0?100:100-100/(1+ag/al);} return o; }
function calcStochK(c: Candle[], p: number): (number|null)[] { const o: (number|null)[] = new Array(c.length).fill(null); for (let i=p-1;i<c.length;i++){let hi=-Infinity, lo=Infinity; for (let j=i-p+1;j<=i;j++){if (c[j].high>hi) hi=c[j].high; if (c[j].low<lo) lo=c[j].low;} o[i]=hi===lo?50:((c[i].close-lo)/(hi-lo))*100;} return o; }
function calcMACDHist(c: number[]): (number|null)[] { const e12=calcEMA(c,12), e26=calcEMA(c,26); const macd: (number|null)[] = c.map((_,i) => (e12[i]!=null && e26[i]!=null) ? e12[i]!-e26[i]! : null); const v: number[]=[], m: number[]=[]; for (let i=0;i<macd.length;i++) if (macd[i]!==null){v.push(macd[i]!); m.push(i);} const sigEma = calcEMA(v, 9); const signal: (number|null)[] = new Array(c.length).fill(null); for (let k=0;k<sigEma.length;k++) if (sigEma[k]!==null) signal[m[k]] = sigEma[k]; return c.map((_,i) => (macd[i]!=null && signal[i]!=null) ? macd[i]!-signal[i]! : null); }

function fmt(t: number) { return new Date(t).toISOString().slice(0,10); }

function main() {
  const c1d = loadCache("1d");
  const c1w = loadCache("1w");

  // 1) Find peak ≥ $100k then subsequent trough ≤ $70k on daily
  let peakIdx = -1, peakPrice = 0;
  let troughIdx = -1, troughPrice = Infinity;

  for (let i=0;i<c1d.length;i++){
    if (c1d[i].high >= 100000 && c1d[i].high > peakPrice) {
      peakPrice = c1d[i].high; peakIdx = i;
    }
  }
  if (peakIdx === -1) { console.log("Không tìm thấy bar nào ≥ $100k!"); return; }
  for (let i=peakIdx;i<c1d.length;i++){
    if (c1d[i].low <= 70000 && c1d[i].low < troughPrice) {
      troughPrice = c1d[i].low; troughIdx = i;
    }
  }

  console.log(`\n=== BTC SẬP: $${peakPrice.toFixed(0)} → $${troughPrice<Infinity?troughPrice.toFixed(0):"chưa chạm"} ===`);
  console.log(`PEAK:    ${fmt(c1d[peakIdx].time)} @ $${peakPrice.toFixed(0)}`);
  if (troughIdx >= 0) {
    console.log(`TROUGH:  ${fmt(c1d[troughIdx].time)} @ $${troughPrice.toFixed(0)}`);
    console.log(`Duration: ${troughIdx - peakIdx} ngày`);
    console.log(`Drop: ${((peakPrice - troughPrice)/peakPrice*100).toFixed(1)}%`);
  } else {
    console.log("BTC chưa chạm $70k trong period — bỏ qua.");
    return;
  }

  // 2) Dump 1W indicators around peak
  const wCloses = c1w.map(b=>b.close);
  const wRSI = calcRSI(wCloses, 14);
  const wStochK = calcStochK(c1w, 14);
  const wMACDH = calcMACDHist(wCloses);
  const wMA20 = calcSMA(wCloses, 20);
  const wSD20 = calcStdev(wCloses, 20, wMA20);
  const wMA50 = calcSMA(wCloses, 50);

  // Find weekly bars covering [peak-12 weeks, trough+4 weeks]
  const peakTs = c1d[peakIdx].time;
  const troughTs = c1d[troughIdx].time;
  const wStart = peakTs - 12*7*24*60*60_000;
  const wEnd = troughTs + 4*7*24*60*60_000;

  console.log(`\n=== WEEKLY (1W) bars từ ${fmt(wStart)} → ${fmt(wEnd)} ===`);
  console.log("Date         Close    Body%    UpW%   DnW%   RSI    StochK  MACDh    bbPos  distMA50");
  for (let i=0;i<c1w.length;i++){
    if (c1w[i].time < wStart || c1w[i].time > wEnd) continue;
    const b = c1w[i];
    const body = (b.close-b.open)/b.open*100;
    const upW = (b.high-Math.max(b.open,b.close))/b.open*100;
    const dnW = (Math.min(b.open,b.close)-b.low)/b.open*100;
    const r = wRSI[i];
    const sk = wStochK[i];
    const mh = wMACDH[i];
    const ma = wMA20[i], sd = wSD20[i];
    const bbPos = (ma!==null && sd!==null && sd>0) ? (b.close-(ma-2*sd))/(4*sd)*100 : NaN;
    const distMA50 = wMA50[i] && wMA50[i]!>0 ? (b.close-wMA50[i]!)/wMA50[i]!*100 : NaN;
    const flag = i===Math.floor((peakIdx*7+troughIdx*7)/2) ? "" : "";
    const peakFlag = b.high===peakPrice ? "← PEAK" : "";
    const troughFlag = b.low===troughPrice ? "← TROUGH" : "";
    console.log(`${fmt(b.time)}  $${b.close.toFixed(0).padStart(6)}  ${body.toFixed(1).padStart(6)}%  ${upW.toFixed(1).padStart(5)}%  ${dnW.toFixed(1).padStart(5)}%  ${r?.toFixed(0).padStart(4) ?? "?"}   ${sk?.toFixed(0).padStart(5) ?? "?"}   ${mh?.toFixed(0).padStart(6) ?? "?"}   ${bbPos.toFixed(0).padStart(4)}%   ${distMA50.toFixed(1).padStart(5)}%  ${peakFlag}${troughFlag}`);
  }

  // 3) Dump 1D indicators around peak (ngắn hơn, focus 30 days each side)
  const dCloses = c1d.map(b=>b.close);
  const dRSI = calcRSI(dCloses, 14);
  const dStochK = calcStochK(c1d, 14);
  const dMACDH = calcMACDHist(dCloses);
  const dMA20 = calcSMA(dCloses, 20);
  const dSD20 = calcStdev(dCloses, 20, dMA20);
  const dMA50 = calcSMA(dCloses, 50);
  const dMA200 = calcSMA(dCloses, 200);

  console.log(`\n=== DAILY indicators tại PEAK ${fmt(c1d[peakIdx].time)} (5 ngày trước → 5 ngày sau) ===`);
  console.log("Date         Close    Body%    UpW%   DnW%   RSI    StochK  MACDh   bbPos   d/MA50  d/MA200");
  for (let i=Math.max(0,peakIdx-5); i<=Math.min(c1d.length-1, peakIdx+5); i++){
    const b = c1d[i];
    const body = (b.close-b.open)/b.open*100;
    const upW = (b.high-Math.max(b.open,b.close))/b.open*100;
    const dnW = (Math.min(b.open,b.close)-b.low)/b.open*100;
    const ma = dMA20[i], sd = dSD20[i];
    const bbPos = (ma!==null && sd!==null && sd>0) ? (b.close-(ma-2*sd))/(4*sd)*100 : NaN;
    const distMA50 = dMA50[i] && dMA50[i]!>0 ? (b.close-dMA50[i]!)/dMA50[i]!*100 : NaN;
    const distMA200 = dMA200[i] && dMA200[i]!>0 ? (b.close-dMA200[i]!)/dMA200[i]!*100 : NaN;
    const peakFlag = i===peakIdx ? "← PEAK" : "";
    console.log(`${fmt(b.time)}  $${b.close.toFixed(0).padStart(6)}  ${body.toFixed(1).padStart(6)}%  ${upW.toFixed(1).padStart(5)}%  ${dnW.toFixed(1).padStart(5)}%  ${dRSI[i]?.toFixed(0).padStart(4) ?? "?"}   ${dStochK[i]?.toFixed(0).padStart(5) ?? "?"}   ${dMACDH[i]?.toFixed(0).padStart(6) ?? "?"}   ${bbPos.toFixed(0).padStart(4)}%   ${distMA50.toFixed(1).padStart(5)}%  ${distMA200.toFixed(1).padStart(6)}%  ${peakFlag}`);
  }

  // 4) Summary: warning signals 1-3 weeks BEFORE peak
  console.log(`\n=== ⚠️ WARNING SIGNALS — 1W indicators 1-3 tuần TRƯỚC PEAK ===`);
  const peakWeekIdx = (() => { for (let i=0;i<c1w.length;i++) if (c1w[i].high === peakPrice || (c1w[i].time <= peakTs && (i===c1w.length-1 || c1w[i+1].time > peakTs))) return i; return -1; })();
  if (peakWeekIdx >= 3) {
    for (let off=3; off>=0; off--) {
      const i = peakWeekIdx - off;
      const b = c1w[i];
      const r = wRSI[i] ?? 0;
      const sk = wStochK[i] ?? 0;
      const mh = wMACDH[i] ?? 0;
      const ma = wMA20[i], sd = wSD20[i];
      const bbPos = (ma!==null && sd!==null && sd>0) ? (b.close-(ma-2*sd))/(4*sd)*100 : NaN;
      const upW = (b.high-Math.max(b.open,b.close))/b.open*100;
      console.log(`Tuần T-${off} (${fmt(b.time)}):`);
      console.log(`  Close $${b.close.toFixed(0)}  RSI ${r.toFixed(0)}  StochK ${sk.toFixed(0)}  MACDh ${mh.toFixed(0)}  bbPos ${bbPos.toFixed(0)}%  upWick ${upW.toFixed(1)}%`);
      const warns: string[] = [];
      if (r > 75) warns.push(`⚠️ RSI > 75 OB cực`);
      if (sk > 90) warns.push(`⚠️ StochK > 90 OB`);
      if (bbPos > 100) warns.push(`⚠️ bbPos > 100% (xuyên upper BB)`);
      if (upW > 2) warns.push(`⚠️ upWick > 2% (rejection candle)`);
      if (mh < 0 && off === 0) warns.push(`⚠️ MACD hist âm (momentum yếu)`);
      if (warns.length > 0) console.log(`  ${warns.join(", ")}`);
    }
  }
}
main();
