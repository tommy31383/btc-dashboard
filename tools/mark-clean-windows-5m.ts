/**
 * mark-clean-windows-5m.ts (anh Tommy 2026-05-04)
 * Test 2 window strict cho cả LONG + SHORT trên 5m:
 *   A. TP±5% / MAE<2% trong 24h (288 bars)
 *   B. TP±3% / MAE<1% trong 6h  (72 bars)
 * Phân tích features + binary filter cho mỗi setup.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }
interface Setup { name: string; tpPct: number; maePct: number; bars: number; side: "LONG"|"SHORT"; }

function loadCache(tf: string): Candle[] { return JSON.parse(readFileSync(join(__dirname,"..",".cache",`binance-${tf}-3y.json`),"utf8")); }
function calcSMA(a: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); if (a.length<p) return o; let s=0; for (let i=0;i<p;i++) s+=a[i]; o[p-1]=s/p; for (let i=p;i<a.length;i++){s+=a[i]-a[i-p]; o[i]=s/p;} return o; }
function calcEMA(a: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); if (a.length<p) return o; const k=2/(p+1); let e=0; for (let i=0;i<p;i++) e+=a[i]; e/=p; o[p-1]=e; for (let i=p;i<a.length;i++){e=a[i]*k+e*(1-k); o[i]=e;} return o; }
function calcStdev(a: number[], p: number, sma: (number|null)[]): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); for (let i=p-1;i<a.length;i++){const m=sma[i]; if (m===null) continue; let sq=0; for (let j=i-p+1;j<=i;j++) sq+=(a[j]-m)**2; o[i]=Math.sqrt(sq/p);} return o; }
function calcRSI(c: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(c.length).fill(null); if (c.length<=p) return o; let g=0,l=0; for (let i=1;i<=p;i++){const ch=c[i]-c[i-1]; if (ch>=0) g+=ch; else l-=ch;} let ag=g/p, al=l/p; o[p]=al===0?100:100-100/(1+ag/al); for (let i=p+1;i<c.length;i++){const ch=c[i]-c[i-1]; ag=(ag*(p-1)+Math.max(ch,0))/p; al=(al*(p-1)+Math.max(-ch,0))/p; o[i]=al===0?100:100-100/(1+ag/al);} return o; }
function calcStochK(c: Candle[], p: number): (number|null)[] { const o: (number|null)[] = new Array(c.length).fill(null); for (let i=p-1;i<c.length;i++){let hi=-Infinity, lo=Infinity; for (let j=i-p+1;j<=i;j++){if (c[j].high>hi) hi=c[j].high; if (c[j].low<lo) lo=c[j].low;} o[i]=hi===lo?50:((c[i].close-lo)/(hi-lo))*100;} return o; }
function calcATR(c: Candle[], p: number): (number|null)[] { const o: (number|null)[] = new Array(c.length).fill(null); if (c.length<=p) return o; const tr: number[] = new Array(c.length).fill(0); for (let i=1;i<c.length;i++) tr[i]=Math.max(c[i].high-c[i].low, Math.abs(c[i].high-c[i-1].close), Math.abs(c[i].low-c[i-1].close)); let s=0; for (let i=1;i<=p;i++) s+=tr[i]; o[p]=s/p; for (let i=p+1;i<c.length;i++) o[i]=(o[i-1]!*(p-1)+tr[i])/p; return o; }
function calcMACDHist(c: number[]): (number|null)[] { const e12=calcEMA(c,12), e26=calcEMA(c,26); const macd: (number|null)[] = c.map((_,i) => (e12[i]!=null && e26[i]!=null) ? e12[i]!-e26[i]! : null); const v: number[]=[], m: number[]=[]; for (let i=0;i<macd.length;i++) if (macd[i]!==null){v.push(macd[i]!); m.push(i);} const sigEma = calcEMA(v, 9); const signal: (number|null)[] = new Array(c.length).fill(null); for (let k=0;k<sigEma.length;k++) if (sigEma[k]!==null) signal[m[k]] = sigEma[k]; return c.map((_,i) => (macd[i]!=null && signal[i]!=null) ? macd[i]!-signal[i]! : null); }

function findWinners(c: Candle[], setup: Setup): Set<number> {
  const winSet = new Set<number>();
  for (let i=20;i<c.length-setup.bars;i++) {
    const entry = c[i].close;
    const tp = setup.side==="LONG" ? entry*(1+setup.tpPct/100) : entry*(1-setup.tpPct/100);
    const sl = setup.side==="LONG" ? entry*(1-setup.maePct/100) : entry*(1+setup.maePct/100);
    let stopped = false, hit = false;
    const limit = i+1+setup.bars;
    for (let j=i+1;j<limit;j++) {
      if (setup.side==="LONG") {
        if (c[j].low <= sl) { stopped = true; break; }
        if (c[j].high >= tp) { hit = true; break; }
      } else {
        if (c[j].high >= sl) { stopped = true; break; }
        if (c[j].low <= tp) { hit = true; break; }
      }
    }
    if (hit && !stopped) winSet.add(i);
  }
  return winSet;
}

function analyzeFilters(c: Candle[], winSet: Set<number>, baseRate: number, longSide: boolean,
  rsi: (number|null)[], stochK: (number|null)[], macdH: (number|null)[],
  ma20: (number|null)[], sd20: (number|null)[], ma50: (number|null)[], atr14: (number|null)[], volMA: (number|null)[]
) {
  const conds: { name: string; pred: (idx: number)=>boolean }[] = longSide ? [
    {name:"RSI<30", pred:i=>(rsi[i]??50)<30},
    {name:"RSI<25", pred:i=>(rsi[i]??50)<25},
    {name:"Stoch K<20", pred:i=>(stochK[i]??50)<20},
    {name:"MACD<-100", pred:i=>(macdH[i]??0)<-100},
    {name:"bbPos<5%", pred:i=>{const m=ma20[i], s=sd20[i]; if(!m||!s||s===0) return false; return (c[i].close-(m-2*s))/(4*s)*100<5;}},
    {name:"distMA50<-3%", pred:i=>{const m=ma50[i]; if(!m) return false; return (c[i].close-m)/m*100<-3;}},
    {name:"dnWick≥0.5%", pred:i=>(Math.min(c[i].open,c[i].close)-c[i].low)/c[i].open*100>=0.5},
    {name:"vol≥3×", pred:i=>{const v=volMA[i]; if(!v) return false; return (c[i].volume??0)/v>=3;}},
    {name:"COMBO bbPos<5+mom20<-3", pred:i=>{const ma=ma20[i], sd=sd20[i]; if(!ma||!sd) return false; const bp=(c[i].close-(ma-2*sd))/(4*sd)*100; const m20=i>=20?(c[i].close-c[i-20].close)/c[i-20].close*100:0; return bp<5 && m20<-3;}},
  ] : [
    {name:"RSI>70", pred:i=>(rsi[i]??50)>70},
    {name:"RSI>75", pred:i=>(rsi[i]??50)>75},
    {name:"Stoch K>80", pred:i=>(stochK[i]??50)>80},
    {name:"MACD>+100", pred:i=>(macdH[i]??0)>100},
    {name:"bbPos>95%", pred:i=>{const m=ma20[i], s=sd20[i]; if(!m||!s||s===0) return false; return (c[i].close-(m-2*s))/(4*s)*100>95;}},
    {name:"distMA50>+3%", pred:i=>{const m=ma50[i]; if(!m) return false; return (c[i].close-m)/m*100>3;}},
    {name:"upWick≥0.5%", pred:i=>(c[i].high-Math.max(c[i].open,c[i].close))/c[i].open*100>=0.5},
    {name:"vol≥3×", pred:i=>{const v=volMA[i]; if(!v) return false; return (c[i].volume??0)/v>=3;}},
    {name:"COMBO bbPos>95+mom20>3", pred:i=>{const ma=ma20[i], sd=sd20[i]; if(!ma||!sd) return false; const bp=(c[i].close-(ma-2*sd))/(4*sd)*100; const m20=i>=20?(c[i].close-c[i-20].close)/c[i-20].close*100:0; return bp>95 && m20>3;}},
  ];
  for (const cond of conds) {
    let total=0, win=0;
    for (let i=20;i<c.length-2016;i++) if (cond.pred(i)) {total++; if (winSet.has(i)) win++;}
    const wr = total>0 ? win/total*100 : 0;
    const lift = wr/baseRate;
    console.log(`    ${cond.name.padEnd(28)}: ${total.toString().padStart(7)} → ${win.toString().padStart(6)} (${wr.toFixed(1)}%, lift ${lift.toFixed(2)}×) ${lift>=1.5?"⭐⭐":lift>=1.3?"⭐":""}`);
  }
}

function main() {
  console.log("[windows] Loading 5m + indicators...");
  const c = loadCache("5m");
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

  const setups: Setup[] = [
    {name:"A1. LONG TP+5% MAE<2% / 24h",  tpPct:5, maePct:2, bars:288, side:"LONG"},
    {name:"A2. SHORT TP-5% MAE<2% / 24h", tpPct:5, maePct:2, bars:288, side:"SHORT"},
    {name:"B1. LONG TP+3% MAE<1% / 6h",   tpPct:3, maePct:1, bars:72,  side:"LONG"},
    {name:"B2. SHORT TP-3% MAE<1% / 6h",  tpPct:3, maePct:1, bars:72,  side:"SHORT"},
  ];
  for (const su of setups) {
    console.log(`\n=== ${su.name} ===`);
    const win = findWinners(c, su);
    const total = c.length - su.bars - 20;
    const baseRate = win.size/total*100;
    console.log(`  ✅ Winners: ${win.size}/${total} = ${baseRate.toFixed(2)}%`);
    console.log(`  Binary filters:`);
    analyzeFilters(c, win, baseRate, su.side==="LONG", rsi, stochK, macdH, ma20, sd20, ma50, atr14, volMA);
  }
}
main();
