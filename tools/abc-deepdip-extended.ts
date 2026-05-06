/**
 * abc-deepdip-extended.ts (anh Tommy 2026-05-04)
 * A. Test Hedge01 + DeepDip với distMA50<-5% (broader trigger)
 * B. Backtest TP+5% MAE<3% standalone strategy với DeepDip filter
 * C. SHORT mirror — cây sau đó giảm 5% với MAE<3% trong 7d
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const INITIAL_CAPITAL = 100000;
const FEE_PER_SIDE_PCT = 0.05;
const MAINT_MARGIN_RATE = 0.004;

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }

function loadCache(tf: string): Candle[] { return JSON.parse(readFileSync(join(__dirname,"..",".cache",`binance-${tf}-3y.json`),"utf8")); }
function calcSMA(a: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); if (a.length<p) return o; let s=0; for (let i=0;i<p;i++) s+=a[i]; o[p-1]=s/p; for (let i=p;i<a.length;i++){s+=a[i]-a[i-p]; o[i]=s/p;} return o; }
function calcRSI(c: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(c.length).fill(null); if (c.length<=p) return o; let g=0,l=0; for (let i=1;i<=p;i++){const ch=c[i]-c[i-1]; if (ch>=0) g+=ch; else l-=ch;} let ag=g/p, al=l/p; o[p]=al===0?100:100-100/(1+ag/al); for (let i=p+1;i<c.length;i++){const ch=c[i]-c[i-1]; ag=(ag*(p-1)+Math.max(ch,0))/p; al=(al*(p-1)+Math.max(-ch,0))/p; o[i]=al===0?100:100-100/(1+ag/al);} return o; }

function pct(x: number[], q: number) { if (x.length===0) return NaN; const s=[...x].sort((a,b)=>a-b); return s[Math.min(Math.floor(s.length*q), s.length-1)]; }

interface BTRes { name: string; adds: number; closes: number; tpHits: number; slHits: number; timeStops: number; win: number; loss: number; realized: number; finalEq: number; roi: number; maxDD: number; liq: boolean; }

function runSimple(c: Candle[], side: "LONG"|"SHORT", entryPred: (i:number)=>boolean, name: string, tpPct: number, slPct: number, timeStopBars: number, qty: number = 0.01): BTRes {
  let positions: { entry: number; openMs: number; sl: number; tp: number }[] = [];
  let wallet = INITIAL_CAPITAL;
  let totalFees=0, totalRealized=0, adds=0, closes=0;
  let win=0, loss=0, lastEntry=0;
  let liq=false, peak=INITIAL_CAPITAL, trough=INITIAL_CAPITAL;
  let slHits=0, tpHits=0, timeStops=0;
  const COOLDOWN_MS = 4*60*60_000;
  const MAX_CONCURRENT = 30;

  function close(idx: number, price: number, ts: number, reason: string) {
    const p = positions[idx];
    const realized = side==="LONG" ? qty*(price-p.entry) : qty*(p.entry-price);
    const fee = qty*price*(FEE_PER_SIDE_PCT/100);
    const np = realized-fee;
    wallet += np; totalRealized += realized; totalFees += fee; closes++;
    if (np>=0) win++; else loss++;
    if (reason==="SL") slHits++; else if (reason==="TP") tpHits++; else timeStops++;
    positions.splice(idx, 1);
  }

  for (let i=200;i<c.length;i++){
    const bar = c[i]; const price = bar.close; const ts = bar.time;
    for (let pi=positions.length-1; pi>=0; pi--){
      const p = positions[pi];
      if (side==="LONG") {
        if (bar.low <= p.sl) {close(pi, p.sl, ts, "SL"); continue;}
        if (bar.high >= p.tp) {close(pi, p.tp, ts, "TP"); continue;}
      } else {
        if (bar.high >= p.sl) {close(pi, p.sl, ts, "SL"); continue;}
        if (bar.low <= p.tp) {close(pi, p.tp, ts, "TP"); continue;}
      }
      if (ts - p.openMs >= timeStopBars*5*60_000) {close(pi, price, ts, "time"); continue;}
    }
    if (ts-lastEntry >= COOLDOWN_MS && positions.length < MAX_CONCURRENT && entryPred(i)) {
      const fee = qty*price*(FEE_PER_SIDE_PCT/100);
      const sl = side==="LONG" ? price*(1-slPct/100) : price*(1+slPct/100);
      const tp = side==="LONG" ? price*(1+tpPct/100) : price*(1-tpPct/100);
      positions.push({entry:price, openMs:ts, sl, tp});
      wallet -= fee; totalFees += fee; adds++; lastEntry = ts;
    }
    let upnl=0;
    for (const p of positions) upnl += side==="LONG" ? qty*(price-p.entry) : qty*(p.entry-price);
    const eq = wallet+upnl;
    if (eq>peak) peak=eq; if (eq<trough) trough=eq;
    if (positions.length>0){
      const totQ = positions.length*qty;
      const mm = totQ*price*MAINT_MARGIN_RATE;
      if (eq<=mm){liq=true; break;}
    }
  }
  const lastPrice = c[c.length-1].close;
  let upnl=0; for (const p of positions) upnl += side==="LONG" ? qty*(lastPrice-p.entry) : qty*(p.entry-lastPrice);
  const finalEq = wallet+upnl;
  return { name, adds, closes, tpHits, slHits, timeStops, win, loss, realized: totalRealized, finalEq, roi: (finalEq-INITIAL_CAPITAL)/INITIAL_CAPITAL*100, maxDD: peak-trough, liq };
}

function main() {
  console.log("[abc] Loading...");
  const c = loadCache("5m");
  const closes = c.map(b=>b.close);
  const ma50 = calcSMA(closes, 50);
  const ma200 = calcSMA(closes, 200);
  const rsi = calcRSI(closes, 14);

  // === B: TP+5% standalone with DeepDip filters ===
  console.log("\n=== B. TP+5% standalone với DeepDip filters (qty 0.01 BTC, TP5/SL3) ===");
  const longFilters = [
    {name:"B1. distMA200<-10% only", pred:(i:number)=>{const m=ma200[i]; if(!m) return false; return (c[i].close-m)/m*100<-10;}},
    {name:"B2. distMA50<-5% only", pred:(i:number)=>{const m=ma50[i]; if(!m) return false; return (c[i].close-m)/m*100<-5;}},
    {name:"B3. mom60<-5% only", pred:(i:number)=>i>=60?((c[i].close-c[i-60].close)/c[i-60].close*100)<-5:false},
    {name:"B4. distMA50<-5 OR mom60<-5", pred:(i:number)=>{const m=ma50[i]; const c1=m?(c[i].close-m)/m*100<-5:false; const c2=i>=60?((c[i].close-c[i-60].close)/c[i-60].close*100)<-5:false; return c1||c2;}},
    {name:"B5. distMA200<-10 OR distMA50<-5 OR mom60<-5", pred:(i:number)=>{const m200=ma200[i], m50=ma50[i]; const c1=m200?(c[i].close-m200)/m200*100<-10:false; const c2=m50?(c[i].close-m50)/m50*100<-5:false; const c3=i>=60?((c[i].close-c[i-60].close)/c[i-60].close*100)<-5:false; return c1||c2||c3;}},
  ];
  const longResults: BTRes[] = [];
  for (const f of longFilters) {
    const r = runSimple(c, "LONG", f.pred, f.name, 5, 3, 2016, 0.01);
    longResults.push(r);
    const wr = r.win+r.loss;
    console.log(`  ${r.name.padEnd(48)} ADDs ${r.adds.toString().padStart(4)} · TP${r.tpHits}/SL${r.slHits}/T${r.timeStops} · WR ${wr>0?(r.win/wr*100).toFixed(0):"-"}% · Realized $${r.realized.toFixed(0)} · ROI ${r.roi.toFixed(2)}% · DD $${r.maxDD.toFixed(0)}`);
  }

  // === C: SHORT mirror analysis ===
  console.log("\n=== C. SHORT MIRROR — cây sau đó GIẢM 5% MAE<3% trong 7d ===");
  // Find clean SHORT winners
  const TARGET = 5, MAE = 3, BARS = 2016;
  const shortWinners = new Set<number>();
  for (let i=200;i<c.length-BARS;i++) {
    const entry = c[i].close;
    const tp = entry*(1-TARGET/100);
    const sl = entry*(1+MAE/100);
    let stopped = false, hit = false;
    for (let j=i+1;j<i+BARS;j++) {
      if (c[j].high>=sl) {stopped=true; break;}
      if (c[j].low<=tp) {hit=true; break;}
    }
    if (hit && !stopped) shortWinners.add(c[i].time);
  }
  const totalC = c.length-BARS-200;
  const baseRateC = shortWinners.size/totalC*100;
  console.log(`  Total CLEAN SHORT winners: ${shortWinners.size}/${totalC} = ${baseRateC.toFixed(2)}%`);

  // SHORT filters mirror
  const shortFilters = [
    {name:"distMA200>+10%", pred:(i:number)=>{const m=ma200[i]; if(!m) return false; return (c[i].close-m)/m*100>10;}},
    {name:"distMA50>+5%", pred:(i:number)=>{const m=ma50[i]; if(!m) return false; return (c[i].close-m)/m*100>5;}},
    {name:"mom60>+5%", pred:(i:number)=>i>=60?((c[i].close-c[i-60].close)/c[i-60].close*100)>5:false},
    {name:"RSI>70", pred:(i:number)=>(rsi[i]??50)>70},
    {name:"COMBO RSI>70+distMA200>+10", pred:(i:number)=>{const m=ma200[i]; if(!m) return false; return (rsi[i]??50)>70 && (c[i].close-m)/m*100>10;}},
    {name:"COMBO distMA200>+10 OR distMA50>+5 OR mom60>+5", pred:(i:number)=>{const m200=ma200[i], m50=ma50[i]; const c1=m200?(c[i].close-m200)/m200*100>10:false; const c2=m50?(c[i].close-m50)/m50*100>5:false; const c3=i>=60?((c[i].close-c[i-60].close)/c[i-60].close*100)>5:false; return c1||c2||c3;}},
  ];
  console.log("  Binary filter lift:");
  for (const f of shortFilters) {
    let total=0, win=0;
    for (let i=200;i<c.length-BARS;i++) if (f.pred(i)) {total++; if (shortWinners.has(c[i].time)) win++;}
    const wr = total>0 ? win/total*100 : 0;
    const lift = wr/baseRateC;
    console.log(`    ${f.name.padEnd(48)}: ${total.toString().padStart(7)} → ${win.toString().padStart(5)} (${wr.toFixed(1)}%, lift ${lift.toFixed(2)}×) ${lift>=1.5?"⭐⭐":lift>=1.3?"⭐":""}`);
  }

  // SHORT backtest top filters
  console.log("\n  SHORT backtest TP-5/SL+3 với top filters (qty 0.01):");
  const shortBacktestFilters = [
    {name:"S1. distMA200>+10% only", pred:(i:number)=>{const m=ma200[i]; if(!m) return false; return (c[i].close-m)/m*100>10;}},
    {name:"S2. distMA50>+5% only", pred:(i:number)=>{const m=ma50[i]; if(!m) return false; return (c[i].close-m)/m*100>5;}},
    {name:"S3. mom60>+5% only", pred:(i:number)=>i>=60?((c[i].close-c[i-60].close)/c[i-60].close*100)>5:false},
    {name:"S4. distMA200>+10 OR distMA50>+5 OR mom60>+5", pred:(i:number)=>{const m200=ma200[i], m50=ma50[i]; const c1=m200?(c[i].close-m200)/m200*100>10:false; const c2=m50?(c[i].close-m50)/m50*100>5:false; const c3=i>=60?((c[i].close-c[i-60].close)/c[i-60].close*100)>5:false; return c1||c2||c3;}},
  ];
  const shortResults: BTRes[] = [];
  for (const f of shortBacktestFilters) {
    const r = runSimple(c, "SHORT", f.pred, f.name, 5, 3, 2016, 0.01);
    shortResults.push(r);
    const wr = r.win+r.loss;
    console.log(`  ${r.name.padEnd(48)} ADDs ${r.adds.toString().padStart(4)} · TP${r.tpHits}/SL${r.slHits}/T${r.timeStops} · WR ${wr>0?(r.win/wr*100).toFixed(0):"-"}% · Realized $${r.realized.toFixed(0)} · ROI ${r.roi.toFixed(2)}% · DD $${r.maxDD.toFixed(0)}`);
  }
}
main();
