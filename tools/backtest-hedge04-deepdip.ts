/**
 * backtest-hedge04-deepdip.ts (anh Tommy 2026-05-04)
 * Hedge04 = "DEEP DIP" rule. Backtest 4 setups + chart.
 *   Setup 1: distMA200 < -10% only → expect rare but high WR
 *   Setup 2: mom60 < -5% only → more frequent
 *   Setup 3: COMBO RSI<30 + distMA200<-10 → ultra rare super precise
 *   Setup 4: distMA200 < -10% OR mom60 < -5% → broader catch
 * TP +10%, SL -2%, time-stop 14d, qty 0.001 BTC, capital $100k
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const INITIAL_CAPITAL = 100000;
const QTY_BTC = 0.001;
const FEE_PER_SIDE_PCT = 0.05;
const MAINT_MARGIN_RATE = 0.004;
const COOLDOWN_MS = 4*60*60_000;
const MAX_CONCURRENT = 50;
const TP_PCT = 10;
const SL_PCT = 2;
const TIME_STOP_BARS_5M = 4032; // 14d

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }
interface Pos { qty: number; entry: number; openMs: number; sl: number; tp: number; }

function loadCache(tf: string): Candle[] { return JSON.parse(readFileSync(join(__dirname,"..",".cache",`binance-${tf}-3y.json`),"utf8")); }
function calcSMA(a: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); if (a.length<p) return o; let s=0; for (let i=0;i<p;i++) s+=a[i]; o[p-1]=s/p; for (let i=p;i<a.length;i++){s+=a[i]-a[i-p]; o[i]=s/p;} return o; }
function calcRSI(c: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(c.length).fill(null); if (c.length<=p) return o; let g=0,l=0; for (let i=1;i<=p;i++){const ch=c[i]-c[i-1]; if (ch>=0) g+=ch; else l-=ch;} let ag=g/p, al=l/p; o[p]=al===0?100:100-100/(1+ag/al); for (let i=p+1;i<c.length;i++){const ch=c[i]-c[i-1]; ag=(ag*(p-1)+Math.max(ch,0))/p; al=(al*(p-1)+Math.max(-ch,0))/p; o[i]=al===0?100:100-100/(1+ag/al);} return o; }

interface Setup { name: string; pred: (i: number, c: Candle[], rsi: (number|null)[], ma200: (number|null)[]) => boolean; }

function run(setup: Setup, c: Candle[], rsi: (number|null)[], ma200: (number|null)[]) {
  let positions: Pos[] = [];
  let wallet = INITIAL_CAPITAL;
  let totalFees=0, totalRealized=0, totalAdds=0, totalCloses=0;
  let win=0, loss=0, lastEntry=0;
  let liq=false, peak=INITIAL_CAPITAL, trough=INITIAL_CAPITAL;
  let slHits=0, tpHits=0, timeStops=0;
  const events: any[] = [];

  function closePos(idx: number, price: number, ts: number, reason: string){
    const p = positions[idx];
    const realized = p.qty*(price-p.entry);
    const fee = p.qty*price*(FEE_PER_SIDE_PCT/100);
    const np = realized-fee;
    wallet += np; totalRealized += realized; totalFees += fee; totalCloses++;
    if (np>=0) win++; else loss++;
    if (reason==="SL") slHits++; else if (reason==="TP") tpHits++; else timeStops++;
    events.push({ts, kind:"CLOSE", price, qty:p.qty, entry:p.entry, realizedPnl:np, reason});
    positions.splice(idx, 1);
  }

  for (let i=200;i<c.length;i++){
    const bar = c[i]; const price = bar.close; const ts = bar.time;
    for (let pi=positions.length-1; pi>=0; pi--){
      const p = positions[pi];
      if (bar.low <= p.sl) {closePos(pi, p.sl, ts, "SL"); continue;}
      if (bar.high >= p.tp) {closePos(pi, p.tp, ts, "TP"); continue;}
      if (ts - p.openMs >= TIME_STOP_BARS_5M*5*60_000) {closePos(pi, price, ts, "time"); continue;}
    }
    if (ts-lastEntry >= COOLDOWN_MS && positions.length < MAX_CONCURRENT) {
      if (setup.pred(i, c, rsi, ma200)) {
        const fee = QTY_BTC*price*(FEE_PER_SIDE_PCT/100);
        const sl = price*(1-SL_PCT/100);
        const tp = price*(1+TP_PCT/100);
        positions.push({qty:QTY_BTC, entry:price, openMs:ts, sl, tp});
        wallet -= fee; totalFees += fee;
        totalAdds++; lastEntry=ts;
        events.push({ts, kind:"ADD", price, qty:QTY_BTC});
      }
    }
    let upnl=0;
    for (const p of positions) upnl += p.qty*(price-p.entry);
    const eq = wallet+upnl;
    if (eq>peak) peak=eq; if (eq<trough) trough=eq;
    if (positions.length>0){
      let totQ=0; for (const p of positions) totQ += p.qty;
      const mm = totQ*price*MAINT_MARGIN_RATE;
      if (eq<=mm){liq=true; break;}
    }
  }
  const lastPrice = c[c.length-1].close;
  let upnl=0;
  for (const p of positions) upnl += p.qty*(lastPrice-p.entry);
  const finalEq = wallet+upnl;
  const roi = ((finalEq-INITIAL_CAPITAL)/INITIAL_CAPITAL)*100;
  return { name:setup.name, totalAdds, totalCloses, totalRealized, totalFees, finalUpnl:upnl, finalEq, roi, maxDD:peak-trough, peak, trough, winCount:win, lossCount:loss, slHits, tpHits, timeStops, liquidated:liq, events };
}

function main() {
  console.log("[hedge04-deepdip] Loading...");
  const c = loadCache("5m");
  const closes = c.map(b=>b.close);
  const rsi = calcRSI(closes, 14);
  const ma200 = calcSMA(closes, 200);

  const setups: Setup[] = [
    {name:"S1. distMA200 < -10%", pred:(i,c,rsi,ma200)=>{const m=ma200[i]; if(!m) return false; return (c[i].close-m)/m*100<-10;}},
    {name:"S2. mom60 < -5%", pred:(i,c)=>i>=60?((c[i].close-c[i-60].close)/c[i-60].close*100)<-5:false},
    {name:"S3. COMBO RSI<30 + distMA200<-10", pred:(i,c,rsi,ma200)=>{const m=ma200[i]; if(!m) return false; return (rsi[i]??50)<30 && (c[i].close-m)/m*100<-10;}},
    {name:"S4. distMA200<-10 OR mom60<-5", pred:(i,c,rsi,ma200)=>{const m=ma200[i]; const cond1=m?((c[i].close-m)/m*100<-10):false; const cond2=i>=60?((c[i].close-c[i-60].close)/c[i-60].close*100)<-5:false; return cond1||cond2;}},
  ];
  const results: any[] = [];
  for (const su of setups) {
    const r = run(su, c, rsi, ma200);
    results.push(r);
    const wr = r.winCount+r.lossCount;
    console.log(`\n[${su.name}]`);
    console.log(`  ADDs ${r.totalAdds} · CLOSES ${r.totalCloses} (TP${r.tpHits}/SL${r.slHits}/T${r.timeStops}) · WR ${wr>0?(r.winCount/wr*100).toFixed(0)+"%":"-"}`);
    console.log(`  Realized $${r.totalRealized.toFixed(0)} · uPnL ${r.finalUpnl>=0?"+":""}$${r.finalUpnl.toFixed(0)} · EQ $${r.finalEq.toFixed(0)} · ROI ${r.roi.toFixed(2)}% · DD $${r.maxDD.toFixed(0)} · LIQ ${r.liquidated}`);
  }

  console.log("\n=== SORTED BY ROI ===");
  results.sort((a,b)=>b.roi-a.roi);
  console.log("Setup                                ADDs  ROI%      Realized   TP   SL   T    WR%   DD$");
  for (const r of results){
    const wr = r.winCount+r.lossCount;
    console.log(`${r.name.padEnd(36)}${r.totalAdds.toString().padStart(5)}  ${r.roi.toFixed(2).padStart(7)}%  ${('$'+r.totalRealized.toFixed(0)).padStart(10)}  ${r.tpHits.toString().padStart(3)}  ${r.slHits.toString().padStart(3)}  ${r.timeStops.toString().padStart(3)}  ${wr>0?(r.winCount/wr*100).toFixed(0).padStart(4):"  —"}  $${r.maxDD.toFixed(0).padStart(7)}`);
  }

  // Save winner events for chart
  const winner = results[0];
  const priceLine: { ts: number; price: number }[] = [];
  const step = 10;
  for (let i=0;i<c.length;i+=step) priceLine.push({ts:c[i].time, price:c[i].close});

  writeFileSync(join(__dirname,"..","assets","backtest_hedge04_deepdip_3y.json"), JSON.stringify({
    config:{tpPct:TP_PCT, slPct:SL_PCT, timeStopBars5m:TIME_STOP_BARS_5M, capital:INITIAL_CAPITAL, qtyBtc:QTY_BTC},
    period:{start:c[0].time, end:c[c.length-1].time},
    results,
    winnerEvents: winner.events,
    priceLine,
  }));
  console.log("\nSaved → assets/backtest_hedge04_deepdip_3y.json");
}
main();
