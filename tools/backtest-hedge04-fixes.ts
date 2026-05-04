/**
 * backtest-hedge04-fixes.ts (anh Tommy 2026-05-04)
 * Test 3 fixes A/B/C cho Hedge04 strict 6h:
 *   A. TP 5% / SL 1% / time-stop 12h (R:R 5:1)
 *   B. Intersect ALL 3 filters: distMA50 + bbPos + wick
 *   C. + HTF trend filter (1D MA200)
 *   Combos: A+B, A+C, B+C, A+B+C
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const INITIAL_CAPITAL = 100000;
const NOTIONAL = 1000;
const FEE_PER_SIDE_PCT = 0.05;
const MAINT_MARGIN_RATE = 0.004;
const COOLDOWN_MS = 60*60_000;
const MAX_CONCURRENT = 10;

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }
interface Pos { side: "LONG"|"SHORT"; qty: number; entry: number; openMs: number; sl: number; tp: number; }

function loadCache(tf: string): Candle[] { return JSON.parse(readFileSync(join(__dirname,"..",".cache",`binance-${tf}-3y.json`),"utf8")); }
function calcSMA(a: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); if (a.length<p) return o; let s=0; for (let i=0;i<p;i++) s+=a[i]; o[p-1]=s/p; for (let i=p;i<a.length;i++){s+=a[i]-a[i-p]; o[i]=s/p;} return o; }
function calcStdev(a: number[], p: number, sma: (number|null)[]): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); for (let i=p-1;i<a.length;i++){const m=sma[i]; if (m===null) continue; let sq=0; for (let j=i-p+1;j<=i;j++) sq+=(a[j]-m)**2; o[i]=Math.sqrt(sq/p);} return o; }
function findIdx(arr: { time: number }[], t: number): number { let lo=0, hi=arr.length-1, ans=-1; while (lo<=hi){const m=(lo+hi)>>1; if (arr[m].time<=t){ans=m; lo=m+1;} else hi=m-1;} return ans; }

interface Setup {
  name: string;
  tpPct: number; slPct: number; timeStopBars5m: number;
  intersectAll: boolean; // B: intersect 3 filters
  useHTFTrend: boolean;  // C: HTF 1D MA200
  longEnabled: boolean; shortEnabled: boolean;
}

function buildSignals(c: Candle[], setup: Setup, c1d: Candle[], ma200_1d: (number|null)[]) {
  const closes = c.map(b=>b.close);
  const ma50 = calcSMA(closes, 50);
  const ma20 = calcSMA(closes, 20);
  const sd20 = calcStdev(closes, 20, ma20);
  const sigs: { ts: number; side: "LONG"|"SHORT"; price: number }[] = [];
  for (let i=50;i<c.length;i++) {
    const b = c[i];
    const ma = ma20[i], sd = sd20[i], m50 = ma50[i];
    if (!ma || !sd || !m50 || sd === 0) continue;
    const distMA50 = (b.close - m50) / m50 * 100;
    const bbPos = (b.close - (ma - 2*sd)) / (4*sd) * 100;
    const dnWick = (Math.min(b.open, b.close) - b.low) / b.open * 100;
    const upWick = (b.high - Math.max(b.open, b.close)) / b.open * 100;

    // LONG filter
    let longOk = setup.longEnabled;
    if (longOk) {
      if (setup.intersectAll) {
        longOk = distMA50 <= -3 && bbPos < 5 && dnWick >= 0.5;
      } else {
        longOk = distMA50 <= -3 && (bbPos < 5 || dnWick >= 0.5);
      }
    }
    // SHORT filter
    let shortOk = setup.shortEnabled;
    if (shortOk) {
      if (setup.intersectAll) {
        shortOk = distMA50 >= 3 && bbPos > 95 && upWick >= 0.5;
      } else {
        shortOk = distMA50 >= 3 && (bbPos > 95 || upWick >= 0.5);
      }
    }
    // HTF filter
    if (setup.useHTFTrend) {
      const idx1d = findIdx(c1d, b.time);
      if (idx1d >= 200) {
        const ma1d = ma200_1d[idx1d - 1];
        if (ma1d !== null) {
          const trendUp = c1d[idx1d - 1].close > ma1d;
          if (longOk && !trendUp) longOk = false;
          if (shortOk && trendUp) shortOk = false;
        }
      } else {
        longOk = false; shortOk = false;
      }
    }
    if (longOk) sigs.push({ ts: b.time, side: "LONG", price: b.close });
    if (shortOk) sigs.push({ ts: b.time, side: "SHORT", price: b.close });
  }
  return sigs;
}

function run(setup: Setup, c: Candle[], c1d: Candle[], ma200_1d: (number|null)[]) {
  const sigs = buildSignals(c, setup, c1d, ma200_1d);
  const sigByTs = new Map<number, typeof sigs>();
  for (const s of sigs){const a=sigByTs.get(s.ts)||[]; a.push(s); sigByTs.set(s.ts,a);}

  let positions: Pos[] = [];
  let wallet = INITIAL_CAPITAL;
  let totalFees=0, totalRealizedPnl=0, totalAddsL=0, totalAddsS=0, totalCloses=0;
  let win=0, loss=0, lastL=0, lastS=0;
  let liq=false, liqMs=0, peak=INITIAL_CAPITAL, trough=INITIAL_CAPITAL;
  let slHits=0, tpHits=0, timeStops=0;

  function closePos(idx: number, price: number, ts: number, reason: string){
    const p = positions[idx];
    const realized = p.side==="LONG" ? p.qty*(price-p.entry) : p.qty*(p.entry-price);
    const fee = p.qty*price*(FEE_PER_SIDE_PCT/100);
    const np = realized-fee;
    wallet += np; totalRealizedPnl += realized; totalFees += fee; totalCloses++;
    if (np>=0) win++; else loss++;
    if (reason==="SL") slHits++; else if (reason==="TP") tpHits++; else timeStops++;
    positions.splice(idx, 1);
  }

  for (let i=0;i<c.length;i++){
    const bar = c[i]; const price = bar.close; const ts = bar.time;
    for (let pi=positions.length-1; pi>=0; pi--){
      const p = positions[pi];
      if (p.side==="LONG"){
        if (bar.low <= p.sl) {closePos(pi, p.sl, ts, "SL"); continue;}
        if (bar.high >= p.tp) {closePos(pi, p.tp, ts, "TP"); continue;}
      } else {
        if (bar.high >= p.sl) {closePos(pi, p.sl, ts, "SL"); continue;}
        if (bar.low <= p.tp) {closePos(pi, p.tp, ts, "TP"); continue;}
      }
      if (ts - p.openMs >= setup.timeStopBars5m*5*60_000) {closePos(pi, price, ts, "time"); continue;}
    }
    const evs = sigByTs.get(ts);
    if (evs) for (const e of evs){
      const cool = e.side==="LONG" ? ts-lastL>=COOLDOWN_MS : ts-lastS>=COOLDOWN_MS;
      if (!cool) continue;
      const sideOpen = positions.filter(p=>p.side===e.side).length;
      if (sideOpen >= MAX_CONCURRENT) continue;
      const qty = NOTIONAL / e.price;
      const fee = NOTIONAL * (FEE_PER_SIDE_PCT/100);
      const sl = e.side==="LONG" ? e.price*(1-setup.slPct/100) : e.price*(1+setup.slPct/100);
      const tp = e.side==="LONG" ? e.price*(1+setup.tpPct/100) : e.price*(1-setup.tpPct/100);
      positions.push({side:e.side, qty, entry:e.price, openMs:ts, sl, tp});
      wallet -= fee; totalFees += fee;
      if (e.side==="LONG"){totalAddsL++; lastL=ts;} else {totalAddsS++; lastS=ts;}
    }
    let upnl=0;
    for (const p of positions) upnl += (p.side==="LONG"?p.qty*(price-p.entry):p.qty*(p.entry-price));
    const eq = wallet+upnl;
    if (eq>peak) peak=eq; if (eq<trough) trough=eq;
    if (positions.length>0){
      let totQ = 0; for (const p of positions) totQ += p.qty;
      const mm = totQ*price*MAINT_MARGIN_RATE;
      if (eq<=mm){liq=true; liqMs=ts; break;}
    }
  }
  const lastPrice = c[c.length-1].close;
  let upnl=0;
  for (const p of positions) upnl += (p.side==="LONG"?p.qty*(lastPrice-p.entry):p.qty*(p.entry-lastPrice));
  const finalEq = wallet+upnl;
  const roi = ((finalEq-INITIAL_CAPITAL)/INITIAL_CAPITAL)*100;
  return {
    name: setup.name, sigs: sigs.length,
    liquidated:liq, liqAtMs:liqMs,
    totalAddsLong: totalAddsL, totalAddsShort: totalAddsS, totalCloses,
    totalRealizedPnl, totalFees, finalUpnl: upnl, finalEq, wallet, roi,
    maxDD:peak-trough, peak, trough, winCount:win, lossCount:loss,
    slHits, tpHits, timeStops,
  };
}

function main(){
  console.log("[hedge04-fixes] Loading...");
  const c = loadCache("5m"); const c1d = loadCache("1d");
  const ma200_1d = calcSMA(c1d.map(b=>b.close), 200);
  // Bar count: 6h = 72 bars 5m, 12h = 144

  const setups: Setup[] = [
    {name:"BASELINE  TP3 SL1 6h",                 tpPct:3,slPct:1,timeStopBars5m:72,  intersectAll:false, useHTFTrend:false, longEnabled:true, shortEnabled:true},
    {name:"A. TP5 SL1 12h",                       tpPct:5,slPct:1,timeStopBars5m:144, intersectAll:false, useHTFTrend:false, longEnabled:true, shortEnabled:true},
    {name:"B. Intersect 3 filters TP3 SL1 6h",    tpPct:3,slPct:1,timeStopBars5m:72,  intersectAll:true,  useHTFTrend:false, longEnabled:true, shortEnabled:true},
    {name:"C. HTF MA200 trend TP3 SL1 6h",        tpPct:3,slPct:1,timeStopBars5m:72,  intersectAll:false, useHTFTrend:true,  longEnabled:true, shortEnabled:true},
    {name:"A+B  TP5 SL1 12h + intersect",         tpPct:5,slPct:1,timeStopBars5m:144, intersectAll:true,  useHTFTrend:false, longEnabled:true, shortEnabled:true},
    {name:"A+C  TP5 SL1 12h + HTF",               tpPct:5,slPct:1,timeStopBars5m:144, intersectAll:false, useHTFTrend:true,  longEnabled:true, shortEnabled:true},
    {name:"B+C  intersect + HTF",                 tpPct:3,slPct:1,timeStopBars5m:72,  intersectAll:true,  useHTFTrend:true,  longEnabled:true, shortEnabled:true},
    {name:"A+B+C  ALL combined",                  tpPct:5,slPct:1,timeStopBars5m:144, intersectAll:true,  useHTFTrend:true,  longEnabled:true, shortEnabled:true},
    {name:"A+C LONG only",                        tpPct:5,slPct:1,timeStopBars5m:144, intersectAll:false, useHTFTrend:true,  longEnabled:true, shortEnabled:false},
  ];
  const results: any[] = [];
  for (const su of setups){
    const r = run(su, c, c1d, ma200_1d);
    results.push(r);
    const wr = r.winCount+r.lossCount;
    console.log(`\n[${su.name}]`);
    console.log(`  sigs=${r.sigs} · ROI ${r.roi.toFixed(2)}% · L${r.totalAddsLong}/S${r.totalAddsShort} · CL ${r.totalCloses} (TP${r.tpHits}/SL${r.slHits}/T${r.timeStops}) · WR ${wr>0?(r.winCount/wr*100).toFixed(0)+"%":"-"} · Realized $${r.totalRealizedPnl.toFixed(0)} · DD $${r.maxDD.toFixed(0)} · LIQ ${r.liquidated}`);
  }
  console.log("\n=== SORTED BY ROI ===");
  results.sort((a,b)=>b.roi-a.roi);
  console.log("Setup                                     Signals  ROI%      Realized   TP   SL  T   WR%   DD$       LIQ");
  for (const r of results){
    const wr = r.winCount+r.lossCount;
    console.log(`${r.name.padEnd(42)}${r.sigs.toString().padStart(7)}  ${r.roi.toFixed(2).padStart(7)}% ${('$'+r.totalRealizedPnl.toFixed(0)).padStart(10)}  ${r.tpHits.toString().padStart(3)}  ${r.slHits.toString().padStart(3)}  ${r.timeStops.toString().padStart(3)}  ${wr>0?(r.winCount/wr*100).toFixed(0).padStart(4):"  —"}  $${r.maxDD.toFixed(0).padStart(7)}  ${r.liquidated?"YES":"NO"}`);
  }
}
main();
