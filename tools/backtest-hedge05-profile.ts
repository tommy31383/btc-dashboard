/**
 * backtest-hedge05-profile.ts (anh Tommy 2026-05-04)
 * Hedge05 = 11-feature STRICT BOTTOM/TOP profile.
 *
 * 11 conditions LONG (đáy thật 15m):
 *  1. dnWick ≥ 0.5
 *  2. body ≥ 0.5
 *  3. isBull == 0 (đỏ)
 *  4. volRatio ≥ 2
 *  5. atrRatio ≥ 1.5
 *  6. RSI ≤ 35
 *  7. Stoch K ≤ 30
 *  8. macdH ≤ -100
 *  9. bbPos ≤ 5
 *  10. distMA50 ≤ -3
 *  11. mom5/10/20 đều < 0
 *
 * SHORT mirror.
 *
 * Test 8 setup:
 *  1. ALL 11 + TP10% + qty 0.001 BTC
 *  2. ALL 11 + TP15% + qty 0.001 BTC
 *  3. ALL 11 + TP20% + qty 0.001 BTC
 *  4. ALL 11 + TP10% + qty 0.01 BTC (10x size)
 *  5. ≥10/11 + TP10% + qty 0.001
 *  6. ≥9/11 + TP10% + qty 0.001
 *  7. ≥10/11 + TP10% + qty 0.01 (10x)
 *  8. ALL 11 + TP10% + LONG only (skip SHORT)
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const INITIAL_CAPITAL = 100000;
const FEE_PER_SIDE_PCT = 0.05;
const MAINT_MARGIN_RATE = 0.004;
const COOLDOWN_MS = 60*60_000;

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }
interface Net { qty: number; avg: number; }
interface Event { ts: number; kind: "ADD"|"CLOSE"; side: "LONG"|"SHORT"; price: number; qty: number; avgAfter: number; realizedPnl?: number; score?: number; }

function loadCache(tf: string): Candle[] { return JSON.parse(readFileSync(join(__dirname,"..",".cache",`binance-${tf}-3y.json`),"utf8")); }
function calcSMA(a: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); if (a.length<p) return o; let s=0; for (let i=0;i<p;i++) s+=a[i]; o[p-1]=s/p; for (let i=p;i<a.length;i++){s+=a[i]-a[i-p]; o[i]=s/p;} return o; }
function calcEMA(a: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); if (a.length<p) return o; const k=2/(p+1); let e=0; for (let i=0;i<p;i++) e+=a[i]; e/=p; o[p-1]=e; for (let i=p;i<a.length;i++){e=a[i]*k+e*(1-k); o[i]=e;} return o; }
function calcStdev(a: number[], p: number, sma: (number|null)[]): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); for (let i=p-1;i<a.length;i++){const m=sma[i]; if (m===null) continue; let sq=0; for (let j=i-p+1;j<=i;j++) sq+=(a[j]-m)**2; o[i]=Math.sqrt(sq/p);} return o; }
function calcRSI(c: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(c.length).fill(null); if (c.length<=p) return o; let g=0,l=0; for (let i=1;i<=p;i++){const ch=c[i]-c[i-1]; if (ch>=0) g+=ch; else l-=ch;} let ag=g/p, al=l/p; o[p]=al===0?100:100-100/(1+ag/al); for (let i=p+1;i<c.length;i++){const ch=c[i]-c[i-1]; ag=(ag*(p-1)+Math.max(ch,0))/p; al=(al*(p-1)+Math.max(-ch,0))/p; o[i]=al===0?100:100-100/(1+ag/al);} return o; }
function calcStochK(c: Candle[], p: number): (number|null)[] { const o: (number|null)[] = new Array(c.length).fill(null); for (let i=p-1;i<c.length;i++){let hi=-Infinity, lo=Infinity; for (let j=i-p+1;j<=i;j++){if (c[j].high>hi) hi=c[j].high; if (c[j].low<lo) lo=c[j].low;} o[i]=hi===lo?50:((c[i].close-lo)/(hi-lo))*100;} return o; }
function calcATR(c: Candle[], p: number): (number|null)[] { const o: (number|null)[] = new Array(c.length).fill(null); if (c.length<=p) return o; const tr: number[] = new Array(c.length).fill(0); for (let i=1;i<c.length;i++) tr[i]=Math.max(c[i].high-c[i].low, Math.abs(c[i].high-c[i-1].close), Math.abs(c[i].low-c[i-1].close)); let s=0; for (let i=1;i<=p;i++) s+=tr[i]; o[p]=s/p; for (let i=p+1;i<c.length;i++) o[i]=(o[i-1]!*(p-1)+tr[i])/p; return o; }
function calcMACDHist(c: number[]): (number|null)[] { const e12=calcEMA(c,12), e26=calcEMA(c,26); const macd: (number|null)[] = c.map((_,i) => (e12[i]!=null && e26[i]!=null) ? e12[i]!-e26[i]! : null); const v: number[]=[], m: number[]=[]; for (let i=0;i<macd.length;i++) if (macd[i]!==null){v.push(macd[i]!); m.push(i);} const sigEma = calcEMA(v, 9); const signal: (number|null)[] = new Array(c.length).fill(null); for (let k=0;k<sigEma.length;k++) if (sigEma[k]!==null) signal[m[k]] = sigEma[k]; return c.map((_,i) => (macd[i]!=null && signal[i]!=null) ? macd[i]!-signal[i]! : null); }
function addNet(n: Net, q: number, p: number): Net { const nq=n.qty+q; return { qty:nq, avg: nq>0?(n.qty*n.avg+q*p)/nq:0 }; }

interface FeatBar { ts: number; close: number; longScore: number; shortScore: number; }

function buildFeatures(c: Candle[]): FeatBar[] {
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
  const out: FeatBar[] = [];
  for (let i=0;i<c.length;i++){
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
    // LONG profile (đáy)
    let lS = 0;
    if (dnW >= 0.5) lS++;
    if (body >= 0.5) lS++;
    if (isBull === 0) lS++;
    if (volR >= 2.0) lS++;
    if (atrR >= 1.5) lS++;
    if (r <= 35) lS++;
    if (sk <= 30) lS++;
    if (mh <= -100) lS++;
    if (bbPos <= 5) lS++;
    if (distMA50 <= -3) lS++;
    if (mom5 < 0 && mom10 < 0 && mom20 < 0) lS++;
    // SHORT profile (đỉnh) - mirror
    let sS = 0;
    if (upW >= 0.5) sS++;
    if (body >= 0.5) sS++;
    if (isBull === 1) sS++;
    if (volR >= 2.0) sS++;
    if (atrR >= 1.5) sS++;
    if (r >= 65) sS++;
    if (sk >= 70) sS++;
    if (mh >= 100) sS++;
    if (bbPos >= 95) sS++;
    if (distMA50 >= 3) sS++;
    if (mom5 > 0 && mom10 > 0 && mom20 > 0) sS++;
    out.push({ ts:b.time, close:b.close, longScore:lS, shortScore:sS });
  }
  return out;
}

interface Setup { name: string; minScore: number; tpPct: number; qtyBtc: number; longOnly: boolean; }

function run(setup: Setup, c5: Candle[], feats: FeatBar[]) {
  const entryByTs = new Map<number, { side: "LONG"|"SHORT"; price: number; score: number }[]>();
  for (const f of feats){
    if (f.longScore >= setup.minScore){const a=entryByTs.get(f.ts)||[]; a.push({side:"LONG", price:f.close, score:f.longScore}); entryByTs.set(f.ts,a);}
    if (!setup.longOnly && f.shortScore >= setup.minScore){const a=entryByTs.get(f.ts)||[]; a.push({side:"SHORT", price:f.close, score:f.shortScore}); entryByTs.set(f.ts,a);}
  }

  let longNet: Net = {qty:0, avg:0};
  let shortNet: Net = {qty:0, avg:0};
  let wallet = INITIAL_CAPITAL;
  let totalFees=0, totalRealizedPnl=0, totalAddsL=0, totalAddsS=0, totalCloses=0;
  let win=0, loss=0, lastL=0, lastS=0;
  let liq=false, liqMs=0, peak=INITIAL_CAPITAL, trough=INITIAL_CAPITAL;
  const events: Event[] = [];

  for (let i=0;i<c5.length;i++){
    const bar = c5[i]; const price = bar.close; const ts = bar.time;
    // CLOSE TP
    if (longNet.qty>0 && longNet.avg>0){
      const gain = (price-longNet.avg)/longNet.avg*100;
      if (gain >= setup.tpPct){
        const realized = longNet.qty*(price-longNet.avg);
        const fee = longNet.qty*price*(FEE_PER_SIDE_PCT/100);
        const np = realized-fee;
        wallet += np; totalRealizedPnl += realized; totalFees += fee; totalCloses++;
        if (np>=0) win++; else loss++;
        events.push({ts, kind:"CLOSE", side:"LONG", price, qty:longNet.qty, avgAfter:longNet.avg, realizedPnl:np});
        longNet = {qty:0, avg:0};
      }
    }
    if (shortNet.qty>0 && shortNet.avg>0){
      const drop = (shortNet.avg-price)/shortNet.avg*100;
      if (drop >= setup.tpPct){
        const realized = shortNet.qty*(shortNet.avg-price);
        const fee = shortNet.qty*price*(FEE_PER_SIDE_PCT/100);
        const np = realized-fee;
        wallet += np; totalRealizedPnl += realized; totalFees += fee; totalCloses++;
        if (np>=0) win++; else loss++;
        events.push({ts, kind:"CLOSE", side:"SHORT", price, qty:shortNet.qty, avgAfter:shortNet.avg, realizedPnl:np});
        shortNet = {qty:0, avg:0};
      }
    }
    // ENTRY
    const evs = entryByTs.get(ts);
    if (evs) for (const e of evs){
      const cool = e.side==="LONG" ? ts-lastL>=COOLDOWN_MS : ts-lastS>=COOLDOWN_MS;
      if (!cool) continue;
      const qty = setup.qtyBtc;
      const fee = qty*e.price*(FEE_PER_SIDE_PCT/100);
      if (e.side==="LONG"){longNet=addNet(longNet,qty,e.price); totalAddsL++; lastL=ts; events.push({ts, kind:"ADD", side:"LONG", price:e.price, qty, avgAfter:longNet.avg, score:e.score});}
      else {shortNet=addNet(shortNet,qty,e.price); totalAddsS++; lastS=ts; events.push({ts, kind:"ADD", side:"SHORT", price:e.price, qty, avgAfter:shortNet.avg, score:e.score});}
      wallet -= fee; totalFees += fee;
    }
    let upnl=0;
    if (longNet.qty>0) upnl += longNet.qty*(price-longNet.avg);
    if (shortNet.qty>0) upnl += shortNet.qty*(shortNet.avg-price);
    const eq = wallet+upnl;
    if (eq>peak) peak=eq; if (eq<trough) trough=eq;
    if (longNet.qty+shortNet.qty>0){
      const mm=(longNet.qty+shortNet.qty)*price*MAINT_MARGIN_RATE;
      if (eq<=mm){liq=true; liqMs=ts; break;}
    }
  }
  const lastPrice = c5[c5.length-1].close;
  const upL = longNet.qty>0 ? longNet.qty*(lastPrice-longNet.avg) : 0;
  const upS = shortNet.qty>0 ? shortNet.qty*(shortNet.avg-lastPrice) : 0;
  const finalUpnl = upL+upS;
  const finalEq = wallet+finalUpnl;
  const roi = ((finalEq-INITIAL_CAPITAL)/INITIAL_CAPITAL)*100;
  return {
    name: setup.name,
    liquidated:liq, liqAtMs:liqMs,
    totalAddsLong: totalAddsL, totalAddsShort: totalAddsS, totalCloses,
    totalRealizedPnl, totalFees,
    finalLong: longNet, finalShort: shortNet, lastPrice,
    finalUpnl, finalEq, wallet, roi, maxDD:peak-trough, peak, trough,
    winCount: win, lossCount: loss,
    events,
  };
}

function main() {
  console.log("[hedge05] Loading 15m...");
  const c15 = loadCache("15m");
  const c5 = loadCache("5m");
  const feats = buildFeatures(c15);

  // Score histogram
  const longHist = new Array(12).fill(0), shortHist = new Array(12).fill(0);
  for (const f of feats){longHist[f.longScore]++; shortHist[f.shortScore]++;}
  console.log(`LONG  score histogram: ${longHist.map((v,i)=>`${i}:${v}`).join(" ")}`);
  console.log(`SHORT score histogram: ${shortHist.map((v,i)=>`${i}:${v}`).join(" ")}`);

  const setups: Setup[] = [
    {name:"1. ALL11 TP10% qty0.001",        minScore:11, tpPct:10, qtyBtc:0.001, longOnly:false},
    {name:"2. ALL11 TP15% qty0.001",        minScore:11, tpPct:15, qtyBtc:0.001, longOnly:false},
    {name:"3. ALL11 TP20% qty0.001",        minScore:11, tpPct:20, qtyBtc:0.001, longOnly:false},
    {name:"4. ALL11 TP10% qty0.01 (10x)",   minScore:11, tpPct:10, qtyBtc:0.01,  longOnly:false},
    {name:"5. ≥10/11 TP10% qty0.001",       minScore:10, tpPct:10, qtyBtc:0.001, longOnly:false},
    {name:"6. ≥9/11 TP10% qty0.001",        minScore:9,  tpPct:10, qtyBtc:0.001, longOnly:false},
    {name:"7. ≥10/11 TP10% qty0.01 (10x)",  minScore:10, tpPct:10, qtyBtc:0.01,  longOnly:false},
    {name:"8. ALL11 TP10% LONG only",       minScore:11, tpPct:10, qtyBtc:0.001, longOnly:true},
  ];

  const results: any[] = [];
  for (const su of setups){
    const r = run(su, c5, feats);
    results.push(r);
    const wr = r.winCount+r.lossCount;
    console.log(`\n[${su.name}]\n  ROI ${r.roi.toFixed(2)}% · ADD L${r.totalAddsLong}/S${r.totalAddsShort} · CL ${r.totalCloses} · WR ${wr>0?(r.winCount/wr*100).toFixed(0)+"%":"—"} · Realized $${r.totalRealizedPnl.toFixed(0)} · uPnL ${r.finalUpnl>=0?"+":""}$${r.finalUpnl.toFixed(0)} · DD $${r.maxDD.toFixed(0)} · LIQ ${r.liquidated}`);
  }
  console.log(`\n=== SORTED BY ROI ===`);
  results.sort((a,b)=>b.roi-a.roi);
  console.log("Setup                                  ROI%      Realized      uPnL        EQUITY      DD$       Trades  CLOSES  WR%   LIQ");
  for (const r of results){
    const wr = r.winCount+r.lossCount;
    console.log(`${r.name.padEnd(40)}${r.roi.toFixed(2).padStart(8)}% ${('$'+r.totalRealizedPnl.toFixed(0)).padStart(12)} ${((r.finalUpnl>=0?'+':'')+'$'+r.finalUpnl.toFixed(0)).padStart(12)} ${('$'+r.finalEq.toFixed(0)).padStart(11)}  $${r.maxDD.toFixed(0).padStart(7)}  ${(r.totalAddsLong+r.totalAddsShort).toString().padStart(6)}  ${r.totalCloses.toString().padStart(6)}  ${wr>0?(r.winCount/wr*100).toFixed(0).padStart(4):"  —"}  ${r.liquidated?"YES":"NO"}`);
  }

  const priceLine: { ts: number; price: number }[] = [];
  const step = 10;
  for (let i=0;i<c5.length;i+=step) priceLine.push({ts:c5[i].time, price:c5[i].close});

  writeFileSync(join(__dirname,"..","assets","backtest_hedge05_profile_3y.json"), JSON.stringify({
    period:{start:c5[0].time, end:c5[c5.length-1].time},
    longHist, shortHist,
    initialCapital: INITIAL_CAPITAL,
    results, priceLine,
  }));
  console.log(`\nSaved → assets/backtest_hedge05_profile_3y.json`);
}
main();
