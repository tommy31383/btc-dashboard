/**
 * backtest-stochrsi-extended.ts (anh Tommy 2026-05-04)
 * Extend Hedge03 StochRSI test:
 *   C. Sweep threshold (3, 5, 7, 10, 15) cho LONG
 *   D. SHORT mirror (StochRSI K cross UP qua 95) với SL/TP grid
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const INITIAL_CAPITAL = 100000;
const NOTIONAL = 1000;
const FEE_PER_SIDE_PCT = 0.05;
const MAINT_MARGIN_RATE = 0.004;
const COOLDOWN_MS = 15*60_000; // B: 15 phút thay 1h
const MAX_CONCURRENT = 20;
const TIME_STOP_BARS_15M = 96 * 4;

interface Candle { time: number; open: number; high: number; low: number; close: number; }
interface Pos { side: "LONG"|"SHORT"; qty: number; entry: number; openMs: number; sl: number; tp: number; }

function loadCache(tf: string): Candle[] { return JSON.parse(readFileSync(join(__dirname,"..",".cache",`binance-${tf}-3y.json`),"utf8")); }
function calcRSI(c: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(c.length).fill(null); if (c.length<=p) return o; let g=0,l=0; for (let i=1;i<=p;i++){const ch=c[i]-c[i-1]; if (ch>=0) g+=ch; else l-=ch;} let ag=g/p, al=l/p; o[p]=al===0?100:100-100/(1+ag/al); for (let i=p+1;i<c.length;i++){const ch=c[i]-c[i-1]; ag=(ag*(p-1)+Math.max(ch,0))/p; al=(al*(p-1)+Math.max(-ch,0))/p; o[i]=al===0?100:100-100/(1+ag/al);} return o; }
function calcStochRSI(c: number[], rsiP: number, stochP: number): (number|null)[] {
  const rsi = calcRSI(c, rsiP);
  const out: (number|null)[] = new Array(c.length).fill(null);
  for (let i = rsiP + stochP - 1; i < c.length; i++) {
    let hi = -Infinity, lo = Infinity, valid = true;
    for (let j = i - stochP + 1; j <= i; j++) { const r = rsi[j]; if (r === null) { valid = false; break; } if (r > hi) hi = r; if (r < lo) lo = r; }
    if (!valid) continue;
    const cur = rsi[i]!;
    out[i] = hi === lo ? 50 : ((cur - lo) / (hi - lo)) * 100;
  }
  return out;
}

interface Setup { name: string; side: "LONG"|"SHORT"; threshold: number; slPct: number; tpPct: number; }

function run(setup: Setup, c15: Candle[], c5: Candle[], stochRSI: (number|null)[]) {
  const signals: { ts: number; price: number }[] = [];
  for (let i=1;i<c15.length;i++){
    const cur = stochRSI[i], prev = stochRSI[i-1];
    if (cur===null||prev===null) continue;
    if (setup.side==="LONG") {
      if (cur < setup.threshold && prev >= setup.threshold) signals.push({ts:c15[i].time, price:c15[i].close});
    } else {
      if (cur > setup.threshold && prev <= setup.threshold) signals.push({ts:c15[i].time, price:c15[i].close});
    }
  }
  const sigByTs = new Map<number, typeof signals>();
  for (const s of signals){const a=sigByTs.get(s.ts)||[]; a.push(s); sigByTs.set(s.ts,a);}

  let positions: Pos[] = [];
  let wallet = INITIAL_CAPITAL;
  let totalFees=0, totalRealized=0, totalAdds=0, totalCloses=0;
  let win=0, loss=0, lastEntry=0;
  let liq=false, peak=INITIAL_CAPITAL, trough=INITIAL_CAPITAL;
  let slHits=0, tpHits=0, timeStops=0;

  function closePos(idx: number, price: number, ts: number, reason: string){
    const p = positions[idx];
    const realized = p.side==="LONG" ? p.qty*(price-p.entry) : p.qty*(p.entry-price);
    const fee = p.qty*price*(FEE_PER_SIDE_PCT/100);
    const np = realized-fee;
    wallet += np; totalRealized += realized; totalFees += fee; totalCloses++;
    if (np>=0) win++; else loss++;
    if (reason==="SL") slHits++; else if (reason==="TP") tpHits++; else timeStops++;
    positions.splice(idx, 1);
  }

  for (let i=0;i<c5.length;i++){
    const bar = c5[i]; const price = bar.close; const ts = bar.time;
    for (let pi=positions.length-1; pi>=0; pi--){
      const p = positions[pi];
      if (p.side==="LONG") {
        if (bar.low <= p.sl) {closePos(pi, p.sl, ts, "SL"); continue;}
        if (bar.high >= p.tp) {closePos(pi, p.tp, ts, "TP"); continue;}
      } else {
        if (bar.high >= p.sl) {closePos(pi, p.sl, ts, "SL"); continue;}
        if (bar.low <= p.tp) {closePos(pi, p.tp, ts, "TP"); continue;}
      }
      if (ts - p.openMs >= TIME_STOP_BARS_15M*15*60_000) {closePos(pi, price, ts, "time"); continue;}
    }
    const evs = sigByTs.get(ts);
    if (evs) for (const e of evs){
      if (ts-lastEntry < COOLDOWN_MS) continue;
      if (positions.length >= MAX_CONCURRENT) continue;
      const qty = NOTIONAL / e.price;
      const fee = NOTIONAL * (FEE_PER_SIDE_PCT/100);
      const sl = setup.side==="LONG" ? e.price*(1-setup.slPct/100) : e.price*(1+setup.slPct/100);
      const tp = setup.side==="LONG" ? e.price*(1+setup.tpPct/100) : e.price*(1-setup.tpPct/100);
      positions.push({side:setup.side, qty, entry:e.price, openMs:ts, sl, tp});
      wallet -= fee; totalFees += fee;
      totalAdds++; lastEntry=ts;
    }
    let upnl=0;
    for (const p of positions) upnl += (p.side==="LONG"?p.qty*(price-p.entry):p.qty*(p.entry-price));
    const eq = wallet+upnl;
    if (eq>peak) peak=eq; if (eq<trough) trough=eq;
    if (positions.length>0){
      let totQ = 0; for (const p of positions) totQ += p.qty;
      const mm = totQ*price*MAINT_MARGIN_RATE;
      if (eq<=mm){liq=true; break;}
    }
  }
  const lastPrice = c5[c5.length-1].close;
  let upnl=0;
  for (const p of positions) upnl += (p.side==="LONG"?p.qty*(lastPrice-p.entry):p.qty*(p.entry-lastPrice));
  const finalEq = wallet+upnl;
  const roi = ((finalEq-INITIAL_CAPITAL)/INITIAL_CAPITAL)*100;
  return {
    name: setup.name, sigs: signals.length, side: setup.side, threshold: setup.threshold,
    liquidated:liq, totalAdds, totalCloses,
    totalRealized, totalFees, finalUpnl: upnl, finalEq, roi,
    maxDD:peak-trough, peak, trough, winCount:win, lossCount:loss,
    slHits, tpHits, timeStops,
  };
}

function main() {
  console.log("[stochrsi-ext] Loading...");
  const c15 = loadCache("15m");
  const c5 = loadCache("5m");
  const closes15 = c15.map(b=>b.close);
  const stochRSI = calcStochRSI(closes15, 14, 14);

  console.log("\n=== C. THRESHOLD SWEEP (LONG, SL5/TP10) ===");
  const longThresh = [3, 5, 7, 10, 15, 20];
  const longResults: any[] = [];
  for (const t of longThresh) {
    const r = run({name:`LONG K<${t} SL5/TP10`, side:"LONG", threshold:t, slPct:5, tpPct:10}, c15, c5, stochRSI);
    longResults.push(r);
  }
  longResults.sort((a,b)=>b.roi-a.roi);
  console.log("Threshold  Signals  ADDs   ROI%      Realized   TP   SL    T    WR%   DD$");
  for (const r of longResults){
    const wr = r.winCount+r.lossCount;
    console.log(`<${String(r.threshold).padStart(2)}        ${r.sigs.toString().padStart(7)}  ${r.totalAdds.toString().padStart(5)}  ${r.roi.toFixed(2).padStart(7)}%  ${('$'+r.totalRealized.toFixed(0)).padStart(10)}  ${r.tpHits.toString().padStart(3)}  ${r.slHits.toString().padStart(4)}  ${r.timeStops.toString().padStart(3)}  ${wr>0?(r.winCount/wr*100).toFixed(0).padStart(4):"  —"}  $${r.maxDD.toFixed(0).padStart(7)}`);
  }

  console.log("\n=== D. SHORT MIRROR — StochRSI K cross UP qua 95, SL/TP sweep ===");
  const shortSls = [2, 3, 5];
  const shortTps = [5, 8, 10, 15];
  const shortResults: any[] = [];
  for (const sl of shortSls) for (const tp of shortTps) {
    const r = run({name:`SHORT K>95 SL${sl}/TP${tp}`, side:"SHORT", threshold:95, slPct:sl, tpPct:tp}, c15, c5, stochRSI);
    shortResults.push(r);
  }
  shortResults.sort((a,b)=>b.roi-a.roi);
  console.log("Setup                         Sigs  ADDs   ROI%      Realized   TP   SL   T    WR%");
  for (const r of shortResults){
    const wr = r.winCount+r.lossCount;
    console.log(`${r.name.padEnd(28)}  ${r.sigs.toString().padStart(5)}  ${r.totalAdds.toString().padStart(5)}  ${r.roi.toFixed(2).padStart(7)}%  ${('$'+r.totalRealized.toFixed(0)).padStart(10)}  ${r.tpHits.toString().padStart(3)}  ${r.slHits.toString().padStart(3)}  ${r.timeStops.toString().padStart(3)}  ${wr>0?(r.winCount/wr*100).toFixed(0).padStart(4):"  —"}`);
  }

  // Combo: Best LONG + Best SHORT
  const bestLong = longResults[0];
  const bestShort = shortResults[0];
  console.log("\n=== COMBO BEST LONG + BEST SHORT (50/50 capital) ===");
  console.log(`  Best LONG: ${bestLong.name} → ROI ${bestLong.roi.toFixed(2)}%`);
  console.log(`  Best SHORT: ${bestShort.name} → ROI ${bestShort.roi.toFixed(2)}%`);
  console.log(`  Combo estimated ROI: ${((bestLong.roi + bestShort.roi)/2).toFixed(2)}%`);
}
main();
