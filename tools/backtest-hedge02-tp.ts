/**
 * backtest-hedge02-tp.ts (anh Tommy 2026-05-04)
 * Test Hedge02 BB wick 4H + 3 phương án TP từ MFE analysis:
 *   1. Baseline (no TP)
 *   2. SAFE: TP 5% + time-stop 48h
 *   3. BALANCED: TP 8% + time-stop 14d
 *   4. AGGRESSIVE: TP 10% + time-stop 30d
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const INITIAL_CAPITAL = 100000;
const NOTIONAL_PER_ADD = 1000;
const FEE_PER_SIDE_PCT = 0.05;
const MAINT_MARGIN_RATE = 0.004;
const COOLDOWN_MS = 4*60*60_000;
const BB_PERIOD = 20;
const BB_STD = 2;

interface Candle { time: number; open: number; high: number; low: number; close: number; }
interface Net { qty: number; avg: number; openMs: number; }
interface Event { ts: number; kind: "ADD"|"CLOSE"; side: "LONG"|"SHORT"; price: number; qty: number; avgAfter: number; realizedPnl?: number; reason?: string; }

function loadCache(tf: string): Candle[] { return JSON.parse(readFileSync(join(__dirname,"..",".cache",`binance-${tf}-3y.json`),"utf8")); }
function calcSMA(a: number[], p: number): (number|null)[] {
  const out: (number|null)[] = new Array(a.length).fill(null);
  if (a.length<p) return out;
  let s=0; for (let i=0;i<p;i++) s+=a[i]; out[p-1]=s/p;
  for (let i=p;i<a.length;i++){s+=a[i]-a[i-p]; out[i]=s/p;}
  return out;
}
function calcStdev(a: number[], p: number, sma: (number|null)[]): (number|null)[] {
  const out: (number|null)[] = new Array(a.length).fill(null);
  for (let i=p-1;i<a.length;i++){const m=sma[i]; if (m===null) continue; let sq=0; for (let j=i-p+1;j<=i;j++) sq+=(a[j]-m)**2; out[i]=Math.sqrt(sq/p);}
  return out;
}
function addNet(n: Net, q: number, p: number, ts: number): Net {
  const nq = n.qty+q;
  return { qty: nq, avg: nq>0 ? (n.qty*n.avg+q*p)/nq : 0, openMs: n.qty===0 ? ts : n.openMs };
}

interface Setup { name: string; tpPct: number; timeStopMs: number; }

function run(setup: Setup, c5: Candle[], c4h: Candle[]) {
  const closes = c4h.map(b=>b.close);
  const sma = calcSMA(closes, BB_PERIOD);
  const sd = calcStdev(closes, BB_PERIOD, sma);
  // Build entry events from 4H wick
  const entryEvents: { ts: number; side: "LONG"|"SHORT"; price: number }[] = [];
  for (let i=BB_PERIOD;i<c4h.length;i++){
    const m=sma[i], s=sd[i]; if (m===null||s===null) continue;
    const lower=m-BB_STD*s, upper=m+BB_STD*s;
    const bar=c4h[i];
    if (bar.low<=lower) entryEvents.push({ts:bar.time, side:"LONG", price:bar.close});
    if (bar.high>=upper) entryEvents.push({ts:bar.time, side:"SHORT", price:bar.close});
  }
  const evByTs = new Map<number, typeof entryEvents>();
  for (const e of entryEvents){const a=evByTs.get(e.ts)||[]; a.push(e); evByTs.set(e.ts,a);}

  let longNet: Net = {qty:0, avg:0, openMs:0};
  let shortNet: Net = {qty:0, avg:0, openMs:0};
  let wallet = INITIAL_CAPITAL;
  let totalFees=0, totalRealizedPnl=0, totalAddsL=0, totalAddsS=0, totalCloses=0;
  let win=0, loss=0, lastL=0, lastS=0;
  let liq=false, liqMs=0, peak=INITIAL_CAPITAL, trough=INITIAL_CAPITAL;
  const events: Event[] = [];

  function applyClose(side: "LONG"|"SHORT", price: number, ts: number, reason: string){
    const net = side==="LONG" ? longNet : shortNet;
    if (net.qty<=0) return;
    const realized = side==="LONG" ? net.qty*(price-net.avg) : net.qty*(net.avg-price);
    const fee = net.qty*price*(FEE_PER_SIDE_PCT/100);
    const np = realized-fee;
    wallet += np; totalRealizedPnl += realized; totalFees += fee; totalCloses++;
    if (np>=0) win++; else loss++;
    events.push({ts, kind:"CLOSE", side, price, qty:net.qty, avgAfter:net.avg, realizedPnl:np, reason});
    if (side==="LONG") longNet={qty:0, avg:0, openMs:0}; else shortNet={qty:0, avg:0, openMs:0};
  }

  for (let i=0;i<c5.length;i++){
    const bar = c5[i]; const price = bar.close; const ts = bar.time;
    // CHECK CLOSE FIRST (TP / time-stop)
    if (setup.tpPct > 0){
      // LONG TP: gain >= tpPct
      if (longNet.qty>0){
        const gain = (price - longNet.avg)/longNet.avg*100;
        if (gain >= setup.tpPct) applyClose("LONG", price, ts, `TP+${setup.tpPct}%`);
        else if (ts - longNet.openMs >= setup.timeStopMs) applyClose("LONG", price, ts, "time_stop");
      }
      if (shortNet.qty>0){
        const drop = (shortNet.avg - price)/shortNet.avg*100;
        if (drop >= setup.tpPct) applyClose("SHORT", price, ts, `TP+${setup.tpPct}%`);
        else if (ts - shortNet.openMs >= setup.timeStopMs) applyClose("SHORT", price, ts, "time_stop");
      }
    }
    // ENTRY
    const evs = evByTs.get(ts);
    if (evs) for (const e of evs){
      const cool = e.side==="LONG" ? ts-lastL>=COOLDOWN_MS : ts-lastS>=COOLDOWN_MS;
      if (!cool) continue;
      const qty = NOTIONAL_PER_ADD / e.price;
      const fee = NOTIONAL_PER_ADD * (FEE_PER_SIDE_PCT/100);
      if (e.side==="LONG"){
        longNet = addNet(longNet, qty, e.price, ts);
        totalAddsL++; lastL=ts;
        events.push({ts, kind:"ADD", side:"LONG", price:e.price, qty, avgAfter:longNet.avg});
      } else {
        shortNet = addNet(shortNet, qty, e.price, ts);
        totalAddsS++; lastS=ts;
        events.push({ts, kind:"ADD", side:"SHORT", price:e.price, qty, avgAfter:shortNet.avg});
      }
      wallet -= fee; totalFees += fee;
    }
    let upnl=0;
    if (longNet.qty>0) upnl += longNet.qty*(price-longNet.avg);
    if (shortNet.qty>0) upnl += shortNet.qty*(shortNet.avg-price);
    const eq = wallet + upnl;
    if (eq>peak) peak=eq; if (eq<trough) trough=eq;
    if (longNet.qty+shortNet.qty>0){
      const mm = (longNet.qty+shortNet.qty)*price*MAINT_MARGIN_RATE;
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
    name: setup.name, liquidated:liq, liqAtMs:liqMs,
    totalAddsLong: totalAddsL, totalAddsShort: totalAddsS, totalCloses,
    totalRealizedPnl, totalFees,
    finalLong: longNet, finalShort: shortNet, lastPrice,
    finalUpnlLong: upL, finalUpnlShort: upS, finalUpnl,
    wallet, finalEq, roi, maxDD:peak-trough, peak, trough,
    winCount: win, lossCount: loss, events,
  };
}

function main(){
  console.log("[hedge02-tp] Loading...");
  const c5 = loadCache("5m"); const c4h = loadCache("4h");

  const setups: Setup[] = [
    {name:"1. Baseline (no TP)",            tpPct:0,  timeStopMs:0},
    {name:"2. SAFE  TP+5%  + 48h stop",     tpPct:5,  timeStopMs:48*60*60_000},
    {name:"3. BALANCED TP+8% + 14d stop",   tpPct:8,  timeStopMs:14*24*60*60_000},
    {name:"4. AGGRESSIVE TP+10% + 30d stop",tpPct:10, timeStopMs:30*24*60*60_000},
  ];
  const results: any[] = [];
  for (const su of setups){
    const r = run(su, c5, c4h);
    results.push(r);
    const wr = r.winCount+r.lossCount;
    console.log(`\n[${su.name}]\n  ROI ${r.roi.toFixed(2)}% · ADD L${r.totalAddsLong}/S${r.totalAddsShort} · CLOSES ${r.totalCloses} · WR ${wr>0?(r.winCount/wr*100).toFixed(0)+"%":"—"} · Realized $${r.totalRealizedPnl.toFixed(0)} · uPnL ${r.finalUpnl>=0?"+":""}$${r.finalUpnl.toFixed(0)} · DD $${r.maxDD.toFixed(0)} · LIQ ${r.liquidated}`);
  }
  console.log("\n=== COMPARISON SORTED BY ROI ===");
  results.sort((a,b)=>b.roi-a.roi);
  console.log("Setup                                  ROI%      Realized      uPnL        EQUITY      DD$       Trades  CLOSES  WR%   LIQ");
  for (const r of results){
    const wr = r.winCount+r.lossCount;
    console.log(`${r.name.padEnd(40)}${r.roi.toFixed(2).padStart(8)}% ${('$'+r.totalRealizedPnl.toFixed(0)).padStart(12)} ${((r.finalUpnl>=0?'+':'')+'$'+r.finalUpnl.toFixed(0)).padStart(12)} ${('$'+r.finalEq.toFixed(0)).padStart(11)}  $${r.maxDD.toFixed(0).padStart(7)}  ${(r.totalAddsLong+r.totalAddsShort).toString().padStart(6)}  ${r.totalCloses.toString().padStart(6)}  ${wr>0?(r.winCount/wr*100).toFixed(0).padStart(4):"  —"}  ${r.liquidated?"YES":"NO"}`);
  }

  const priceLine: { ts: number; price: number }[] = [];
  const step = 10;
  for (let i=0;i<c5.length;i+=step) priceLine.push({ts:c5[i].time, price:c5[i].close});

  writeFileSync(join(__dirname,"..","assets","backtest_hedge02_tp_3y.json"), JSON.stringify({
    period:{start:c5[0].time, end:c5[c5.length-1].time},
    initialCapital: INITIAL_CAPITAL, notional: NOTIONAL_PER_ADD,
    results, priceLine,
  }));
  console.log("\nSaved → assets/backtest_hedge02_tp_3y.json");
}
main();
