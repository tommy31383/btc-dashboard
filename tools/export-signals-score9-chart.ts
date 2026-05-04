/**
 * export-signals-score9-chart.ts (anh Tommy 2026-05-04)
 * Xuất 479 LONG + 313 SHORT signals score≥9/11 ra JSON cho chart.
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
function calcATR(c: Candle[], p: number): (number|null)[] { const o: (number|null)[] = new Array(c.length).fill(null); if (c.length<=p) return o; const tr: number[] = new Array(c.length).fill(0); for (let i=1;i<c.length;i++) tr[i]=Math.max(c[i].high-c[i].low, Math.abs(c[i].high-c[i-1].close), Math.abs(c[i].low-c[i-1].close)); let s=0; for (let i=1;i<=p;i++) s+=tr[i]; o[p]=s/p; for (let i=p+1;i<c.length;i++) o[i]=(o[i-1]!*(p-1)+tr[i])/p; return o; }
function calcMACDHist(c: number[]): (number|null)[] { const e12=calcEMA(c,12), e26=calcEMA(c,26); const macd: (number|null)[] = c.map((_,i) => (e12[i]!=null && e26[i]!=null) ? e12[i]!-e26[i]! : null); const v: number[]=[], m: number[]=[]; for (let i=0;i<macd.length;i++) if (macd[i]!==null){v.push(macd[i]!); m.push(i);} const sigEma = calcEMA(v, 9); const signal: (number|null)[] = new Array(c.length).fill(null); for (let k=0;k<sigEma.length;k++) if (sigEma[k]!==null) signal[m[k]] = sigEma[k]; return c.map((_,i) => (macd[i]!=null && signal[i]!=null) ? macd[i]!-signal[i]! : null); }

function main() {
  const c = loadCache("15m");
  const c5 = loadCache("5m");
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

  const longs: any[] = [], shorts: any[] = [];
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
    if (lS>=9) longs.push({ts:b.time, price:b.close, low:b.low, score:lS, rsi:r, vol:volR});
    if (sS>=9) shorts.push({ts:b.time, price:b.close, high:b.high, score:sS, rsi:r, vol:volR});
  }
  console.log(`LONG: ${longs.length}, SHORT: ${shorts.length}`);

  const priceLine: { ts: number; price: number }[] = [];
  const step = 10;
  for (let i=0;i<c5.length;i+=step) priceLine.push({ts:c5[i].time, price:c5[i].close});

  writeFileSync(join(__dirname,"..","assets","signals_score9_3y.json"), JSON.stringify({
    period:{start:c5[0].time, end:c5[c5.length-1].time},
    longCount: longs.length, shortCount: shorts.length,
    longs, shorts, priceLine,
  }));
  console.log("Saved → assets/signals_score9_3y.json");
}
main();
