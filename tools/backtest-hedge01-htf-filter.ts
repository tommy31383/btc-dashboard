/**
 * backtest-hedge01-htf-filter.ts (anh Tommy 2026-05-04)
 * Test C+D: HTF trend filter cho Hedge01 + DeepDip.
 *   BASELINE: Hedge01 v0.4.15 hiện tại (no HTF filter)
 *   C1: Chỉ cho phép LONG entry khi 1d close > MA200d (uptrend filter)
 *   C2: Chỉ cho phép DeepDip BOOSTER khi 1d UP (DeepDip restricted)
 *   D1: Block ALL entries khi 1d bear (close < MA200d)
 *   D2: Block ALL entries khi 1d MACD < 0
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const INITIAL_CAPITAL = 100000;
const FEE_PER_SIDE_PCT = 0.05;
const MAINT_MARGIN_RATE = 0.004;
const COOLDOWN_MS = 60*60_000;
const TP_PCT = 10;
const MIN_SCORE = 9;
const DEEPDIP_QTY_BOOST = 0.05;

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }
interface Net { qty: number; avg: number; }

function loadCache(tf: string): Candle[] { return JSON.parse(readFileSync(join(__dirname,"..",".cache",`binance-${tf}-3y.json`),"utf8")); }
function calcSMA(a: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); if (a.length<p) return o; let s=0; for (let i=0;i<p;i++) s+=a[i]; o[p-1]=s/p; for (let i=p;i<a.length;i++){s+=a[i]-a[i-p]; o[i]=s/p;} return o; }
function calcEMA(a: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); if (a.length<p) return o; const k=2/(p+1); let e=0; for (let i=0;i<p;i++) e+=a[i]; e/=p; o[p-1]=e; for (let i=p;i<a.length;i++){e=a[i]*k+e*(1-k); o[i]=e;} return o; }
function calcStdev(a: number[], p: number, sma: (number|null)[]): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); for (let i=p-1;i<a.length;i++){const m=sma[i]; if (m===null) continue; let sq=0; for (let j=i-p+1;j<=i;j++) sq+=(a[j]-m)**2; o[i]=Math.sqrt(sq/p);} return o; }
function calcRSI(c: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(c.length).fill(null); if (c.length<=p) return o; let g=0,l=0; for (let i=1;i<=p;i++){const ch=c[i]-c[i-1]; if (ch>=0) g+=ch; else l-=ch;} let ag=g/p, al=l/p; o[p]=al===0?100:100-100/(1+ag/al); for (let i=p+1;i<c.length;i++){const ch=c[i]-c[i-1]; ag=(ag*(p-1)+Math.max(ch,0))/p; al=(al*(p-1)+Math.max(-ch,0))/p; o[i]=al===0?100:100-100/(1+ag/al);} return o; }
function calcStochK(c: Candle[], p: number): (number|null)[] { const o: (number|null)[] = new Array(c.length).fill(null); for (let i=p-1;i<c.length;i++){let hi=-Infinity, lo=Infinity; for (let j=i-p+1;j<=i;j++){if (c[j].high>hi) hi=c[j].high; if (c[j].low<lo) lo=c[j].low;} o[i]=hi===lo?50:((c[i].close-lo)/(hi-lo))*100;} return o; }
function calcATR(c: Candle[], p: number): (number|null)[] { const o: (number|null)[] = new Array(c.length).fill(null); if (c.length<=p) return o; const tr: number[] = new Array(c.length).fill(0); for (let i=1;i<c.length;i++) tr[i]=Math.max(c[i].high-c[i].low, Math.abs(c[i].high-c[i-1].close), Math.abs(c[i].low-c[i-1].close)); let s=0; for (let i=1;i<=p;i++) s+=tr[i]; o[p]=s/p; for (let i=p+1;i<c.length;i++) o[i]=(o[i-1]!*(p-1)+tr[i])/p; return o; }
function calcMACDHist(c: number[]): (number|null)[] { const e12=calcEMA(c,12), e26=calcEMA(c,26); const macd: (number|null)[] = c.map((_,i) => (e12[i]!=null && e26[i]!=null) ? e12[i]!-e26[i]! : null); const v: number[]=[], m: number[]=[]; for (let i=0;i<macd.length;i++) if (macd[i]!==null){v.push(macd[i]!); m.push(i);} const sigEma = calcEMA(v, 9); const signal: (number|null)[] = new Array(c.length).fill(null); for (let k=0;k<sigEma.length;k++) if (sigEma[k]!==null) signal[m[k]] = sigEma[k]; return c.map((_,i) => (macd[i]!=null && signal[i]!=null) ? macd[i]!-signal[i]! : null); }
function findIdx(arr: { time: number }[], t: number): number { let lo=0, hi=arr.length-1, ans=-1; while (lo<=hi){const m=(lo+hi)>>1; if (arr[m].time<=t){ans=m; lo=m+1;} else hi=m-1;} return ans; }

function aggregateQty(score: number, side: "LONG"|"SHORT"): number {
  let qty = 0;
  if (score === 11) qty += 0.001 * 3;
  if (score === 11) qty += 0.01;
  if (score >= 10) qty += 0.001;
  if (score >= 9) qty += 0.001;
  if (score >= 10) qty += 0.01;
  if (score === 11 && side === "LONG") qty += 0.001;
  return qty;
}
function isDeepDip(c5: Candle[], i: number): boolean {
  if (i < 200) return false;
  const last = c5[i].close;
  let sum200=0; for (let j=i-200;j<i;j++) sum200 += c5[j].close;
  const ma200 = sum200/200;
  if ((last-ma200)/ma200*100 < -10) return true;
  let sum50=0; for (let j=i-50;j<i;j++) sum50 += c5[j].close;
  const ma50 = sum50/50;
  if ((last-ma50)/ma50*100 < -5) return true;
  if (i>=60 && (last-c5[i-60].close)/c5[i-60].close*100 < -5) return true;
  return false;
}
function addNet(n: Net, q: number, p: number): Net { const nq=n.qty+q; return { qty:nq, avg: nq>0?(n.qty*n.avg+q*p)/nq:0 }; }

interface Setup { name: string; htfMode: "none"|"longOnlyUptrend"|"deepDipOnlyUptrend"|"blockBear"|"blockMacdNeg"; }

function run(setup: Setup, c5: Candle[], c15: Candle[], c1d: Candle[]) {
  const closes15 = c15.map(b=>b.close);
  const rsi = calcRSI(closes15, 14); const stochK = calcStochK(c15, 14); const macdH = calcMACDHist(closes15);
  const ma50_15 = calcSMA(closes15, 50); const ma20_15 = calcSMA(closes15, 20); const sd20_15 = calcStdev(closes15, 20, ma20_15);
  const atr14 = calcATR(c15, 14); const vols = c15.map(b=>b.volume??0); const volMA = calcSMA(vols, 20);
  // 1d indicators for HTF filter
  const closes1d = c1d.map(b=>b.close);
  const ma200_1d = calcSMA(closes1d, 200);
  const macdH_1d = calcMACDHist(closes1d);

  function htfPass(side: "LONG"|"SHORT", c5Idx: number, scoreOK: boolean, deepDipFlag: boolean): { entryOK: boolean; deepDipOK: boolean } {
    const ts = c5[c5Idx].time;
    const idx1d = findIdx(c1d, ts);
    if (idx1d < 200) return { entryOK: scoreOK, deepDipOK: deepDipFlag };
    const ma1d = ma200_1d[idx1d];
    const m1d = macdH_1d[idx1d];
    const trendUp = ma1d ? c1d[idx1d].close > ma1d : false;
    const macdPos = m1d ? m1d > 0 : false;
    let entryOK = scoreOK;
    let deepDipOK = deepDipFlag;
    switch (setup.htfMode) {
      case "longOnlyUptrend":
        if (side === "LONG" && !trendUp) entryOK = false;
        break;
      case "deepDipOnlyUptrend":
        if (deepDipFlag && !trendUp) deepDipOK = false;
        break;
      case "blockBear":
        if (!trendUp) entryOK = false;
        break;
      case "blockMacdNeg":
        if (!macdPos) entryOK = false;
        break;
    }
    return { entryOK, deepDipOK };
  }

  // Build signals from 15m
  const signals: { ts: number; side: "LONG"|"SHORT"; price: number; score: number; bar5mIdx: number }[] = [];
  // Map 15m time → c5 idx
  for (let i=20;i<c15.length;i++){
    const b = c15[i];
    const dnW = (Math.min(b.open,b.close)-b.low)/b.open*100;
    const upW = (b.high-Math.max(b.open,b.close))/b.open*100;
    const body = Math.abs(b.close-b.open)/b.open*100;
    const isBull = b.close>b.open?1:0;
    const volR = volMA[i] && volMA[i]!>0 ? (b.volume??0)/volMA[i]! : 0;
    const ma=ma20_15[i], sd=sd20_15[i];
    const bbPos = (ma!==null && sd!==null && sd>0) ? (b.close-(ma-2*sd))/(4*sd)*100 : 50;
    const mom5 = i>=5 ? (b.close-c15[i-5].close)/c15[i-5].close*100 : 0;
    const mom10 = i>=10 ? (b.close-c15[i-10].close)/c15[i-10].close*100 : 0;
    const mom20 = i>=20 ? (b.close-c15[i-20].close)/c15[i-20].close*100 : 0;
    const atr = atr14[i]; const range = b.high-b.low;
    const atrR = atr && atr>0 ? range/atr : 0;
    const distMA50 = ma50_15[i] && ma50_15[i]!>0 ? (b.close-ma50_15[i]!)/ma50_15[i]!*100 : 0;
    const r = rsi[i] ?? 50; const sk = stochK[i] ?? 50; const mh = macdH[i] ?? 0;
    let lS=0, sS=0;
    if (dnW>=0.5) lS++; if (body>=0.5) lS++; if (isBull===0) lS++; if (volR>=2.0) lS++; if (atrR>=1.5) lS++; if (r<=35) lS++; if (sk<=30) lS++; if (mh<=-100) lS++; if (bbPos<=5) lS++; if (distMA50<=-3) lS++; if (mom5<0&&mom10<0&&mom20<0) lS++;
    if (upW>=0.5) sS++; if (body>=0.5) sS++; if (isBull===1) sS++; if (volR>=2.0) sS++; if (atrR>=1.5) sS++; if (r>=65) sS++; if (sk>=70) sS++; if (mh>=100) sS++; if (bbPos>=95) sS++; if (distMA50>=3) sS++; if (mom5>0&&mom10>0&&mom20>0) sS++;
    const c5Idx = findIdx(c5, b.time);
    if (c5Idx < 0) continue;
    if (lS >= MIN_SCORE) signals.push({ts:b.time, side:"LONG", price:b.close, score:lS, bar5mIdx: c5Idx});
    if (sS >= MIN_SCORE) signals.push({ts:b.time, side:"SHORT", price:b.close, score:sS, bar5mIdx: c5Idx});
  }
  const sigByTs = new Map<number, typeof signals>();
  for (const s of signals){const a=sigByTs.get(s.ts)||[]; a.push(s); sigByTs.set(s.ts,a);}

  let longNet: Net = {qty:0, avg:0}; let shortNet: Net = {qty:0, avg:0};
  let wallet = INITIAL_CAPITAL;
  let totalFees=0, totalRealized=0, totalAddsL=0, totalAddsS=0, totalCloses=0;
  let win=0, loss=0, lastL=0, lastS=0;
  let liq=false, peak=INITIAL_CAPITAL, trough=INITIAL_CAPITAL;
  let deepDipFires = 0;
  let blockedByHTF = 0;

  for (let i=0;i<c5.length;i++){
    const bar = c5[i]; const price = bar.close; const ts = bar.time;
    if (longNet.qty>0 && longNet.avg>0){
      const gain = (price-longNet.avg)/longNet.avg*100;
      if (gain >= TP_PCT){
        const realized = longNet.qty*(price-longNet.avg);
        const fee = longNet.qty*price*(FEE_PER_SIDE_PCT/100);
        const np = realized-fee;
        wallet += np; totalRealized += realized; totalFees += fee; totalCloses++;
        if (np>=0) win++; else loss++;
        longNet = {qty:0, avg:0};
      }
    }
    if (shortNet.qty>0 && shortNet.avg>0){
      const drop = (shortNet.avg-price)/shortNet.avg*100;
      if (drop >= TP_PCT){
        const realized = shortNet.qty*(shortNet.avg-price);
        const fee = shortNet.qty*price*(FEE_PER_SIDE_PCT/100);
        const np = realized-fee;
        wallet += np; totalRealized += realized; totalFees += fee; totalCloses++;
        if (np>=0) win++; else loss++;
        shortNet = {qty:0, avg:0};
      }
    }
    const evs = sigByTs.get(ts);
    if (evs) for (const e of evs){
      const cool = e.side==="LONG" ? ts-lastL>=COOLDOWN_MS : ts-lastS>=COOLDOWN_MS;
      if (!cool) continue;
      let qty = aggregateQty(e.score, e.side);
      let isDD = e.side==="LONG" && isDeepDip(c5, i);
      const htf = htfPass(e.side, i, true, isDD);
      if (!htf.entryOK) { blockedByHTF++; continue; }
      if (isDD && !htf.deepDipOK) isDD = false;
      if (isDD) { qty += DEEPDIP_QTY_BOOST; deepDipFires++; }
      if (qty <= 0) continue;
      const fee = qty*e.price*(FEE_PER_SIDE_PCT/100);
      if (e.side==="LONG"){longNet=addNet(longNet,qty,e.price); totalAddsL++; lastL=ts;}
      else {shortNet=addNet(shortNet,qty,e.price); totalAddsS++; lastS=ts;}
      wallet -= fee; totalFees += fee;
    }
    let upnl=0;
    if (longNet.qty>0) upnl += longNet.qty*(price-longNet.avg);
    if (shortNet.qty>0) upnl += shortNet.qty*(shortNet.avg-price);
    const eq = wallet+upnl;
    if (eq>peak) peak=eq; if (eq<trough) trough=eq;
    if (longNet.qty+shortNet.qty>0){
      const totQ = longNet.qty+shortNet.qty;
      const mm = totQ*price*MAINT_MARGIN_RATE;
      if (eq<=mm){liq=true; break;}
    }
  }
  const lastPrice = c5[c5.length-1].close;
  const upL = longNet.qty>0 ? longNet.qty*(lastPrice-longNet.avg) : 0;
  const upS = shortNet.qty>0 ? shortNet.qty*(shortNet.avg-lastPrice) : 0;
  const finalUpnl = upL+upS;
  const finalEq = wallet+finalUpnl;
  return {
    name: setup.name, totalAddsL, totalAddsS, totalCloses, win, loss,
    totalRealized, totalFees, finalUpnl, finalEq,
    roi: (finalEq-INITIAL_CAPITAL)/INITIAL_CAPITAL*100,
    maxDD: peak-trough, deepDipFires, blockedByHTF, liq,
  };
}

function main() {
  console.log("[h01-htf] Loading...");
  const c5 = loadCache("5m"); const c15 = loadCache("15m"); const c1d = loadCache("1d");

  const setups: Setup[] = [
    {name:"BASELINE (no HTF filter)",        htfMode:"none"},
    {name:"C1. LONG only when 1d UP",         htfMode:"longOnlyUptrend"},
    {name:"C2. DeepDip only when 1d UP",      htfMode:"deepDipOnlyUptrend"},
    {name:"D1. Block ALL when 1d bear",       htfMode:"blockBear"},
    {name:"D2. Block ALL when 1d MACD<0",     htfMode:"blockMacdNeg"},
  ];
  const results: any[] = [];
  for (const su of setups) {
    const r = run(su, c5, c15, c1d);
    results.push(r);
    const wr = r.win+r.loss;
    console.log(`\n[${su.name}]`);
    console.log(`  ADDs L${r.totalAddsL}/S${r.totalAddsS} · CL ${r.totalCloses} · WR ${wr>0?(r.win/wr*100).toFixed(0)+"%":"-"} · DeepDip fires: ${r.deepDipFires} · HTF blocked: ${r.blockedByHTF}`);
    console.log(`  Realized $${r.totalRealized.toFixed(0)} · uPnL ${r.finalUpnl>=0?"+":""}$${r.finalUpnl.toFixed(0)} · EQ $${r.finalEq.toFixed(0)} · ROI ${r.roi.toFixed(2)}% · DD $${r.maxDD.toFixed(0)} · LIQ ${r.liq}`);
  }
  console.log("\n=== SORTED BY ROI ===");
  results.sort((a,b)=>b.roi-a.roi);
  console.log("Setup                                ADDs L/S   CL   WR%  DD$       Realized   ROI%       LIQ");
  for (const r of results){
    const wr = r.win+r.loss;
    console.log(`${r.name.padEnd(36)}${(r.totalAddsL+'/'+r.totalAddsS).padStart(10)}  ${r.totalCloses.toString().padStart(3)}  ${wr>0?(r.win/wr*100).toFixed(0).padStart(3):"  —"}%  $${r.maxDD.toFixed(0).padStart(7)}  ${('$'+r.totalRealized.toFixed(0)).padStart(10)}  ${(r.roi>=0?'+':'')+r.roi.toFixed(2).padStart(7)}%  ${r.liq?"YES":"NO"}`);
  }
}
main();
