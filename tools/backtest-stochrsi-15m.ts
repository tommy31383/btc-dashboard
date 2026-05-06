/**
 * backtest-stochrsi-15m.ts (anh Tommy 2026-05-04)
 * Entry LONG khi StochRSI K < 5 trên 15m. Sweep SL/TP combos.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const INITIAL_CAPITAL = 100000;
const NOTIONAL = 1000;
const FEE_PER_SIDE_PCT = 0.05;
const MAINT_MARGIN_RATE = 0.004;
const COOLDOWN_MS = 60*60_000;
const MAX_CONCURRENT = 20;
const TIME_STOP_BARS_15M = 96 * 4; // 4 days
const STOCH_K_THRESHOLD = 5;

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }
interface Pos { side: "LONG"|"SHORT"; qty: number; entry: number; openMs: number; sl: number; tp: number; }

function loadCache(tf: string): Candle[] { return JSON.parse(readFileSync(join(__dirname,"..",".cache",`binance-${tf}-3y.json`),"utf8")); }

function calcRSI(c: number[], p: number): (number|null)[] {
  const o: (number|null)[] = new Array(c.length).fill(null);
  if (c.length<=p) return o;
  let g=0, l=0;
  for (let i=1;i<=p;i++){const ch=c[i]-c[i-1]; if (ch>=0) g+=ch; else l-=ch;}
  let ag=g/p, al=l/p;
  o[p] = al===0 ? 100 : 100 - 100/(1+ag/al);
  for (let i=p+1;i<c.length;i++){const ch=c[i]-c[i-1]; ag=(ag*(p-1)+Math.max(ch,0))/p; al=(al*(p-1)+Math.max(-ch,0))/p; o[i]=al===0?100:100-100/(1+ag/al);}
  return o;
}

/** StochRSI K (period 14 / 14, no smoothing — raw) */
function calcStochRSI(c: number[], rsiP: number, stochP: number): (number|null)[] {
  const rsi = calcRSI(c, rsiP);
  const out: (number|null)[] = new Array(c.length).fill(null);
  for (let i = rsiP + stochP - 1; i < c.length; i++) {
    let hi = -Infinity, lo = Infinity;
    let valid = true;
    for (let j = i - stochP + 1; j <= i; j++) {
      const r = rsi[j];
      if (r === null) { valid = false; break; }
      if (r > hi) hi = r;
      if (r < lo) lo = r;
    }
    if (!valid) continue;
    const cur = rsi[i]!;
    out[i] = hi === lo ? 50 : ((cur - lo) / (hi - lo)) * 100;
  }
  return out;
}

interface Setup { name: string; slPct: number; tpPct: number; }

function run(setup: Setup, c15: Candle[], c5: Candle[], stochRSI: (number|null)[]) {
  // Build entry signals: bar index where stochRSI[i] < threshold AND prev was >= threshold (cross down)
  // Or: just when stochRSI[i] < threshold (every bar that's < 5)
  // Use cross-down for first entry, then cooldown handles rest
  const signals: { ts: number; price: number }[] = [];
  for (let i=1;i<c15.length;i++){
    const cur = stochRSI[i], prev = stochRSI[i-1];
    if (cur === null || prev === null) continue;
    // Fire whenever cross from >=5 down below 5
    if (cur < STOCH_K_THRESHOLD && prev >= STOCH_K_THRESHOLD) {
      signals.push({ ts: c15[i].time, price: c15[i].close });
    }
  }
  const sigByTs = new Map<number, typeof signals>();
  for (const s of signals){const a=sigByTs.get(s.ts)||[]; a.push(s); sigByTs.set(s.ts,a);}

  let positions: Pos[] = [];
  let wallet = INITIAL_CAPITAL;
  let totalFees=0, totalRealizedPnl=0, totalAdds=0, totalCloses=0;
  let win=0, loss=0, lastL=0;
  let liq=false, liqMs=0, peak=INITIAL_CAPITAL, trough=INITIAL_CAPITAL;
  let slHits=0, tpHits=0, timeStops=0;

  function closePos(idx: number, price: number, ts: number, reason: string){
    const p = positions[idx];
    const realized = p.qty*(price-p.entry);
    const fee = p.qty*price*(FEE_PER_SIDE_PCT/100);
    const np = realized-fee;
    wallet += np; totalRealizedPnl += realized; totalFees += fee; totalCloses++;
    if (np>=0) win++; else loss++;
    if (reason==="SL") slHits++; else if (reason==="TP") tpHits++; else timeStops++;
    positions.splice(idx, 1);
  }

  // Walk on 5m for accurate SL/TP fills
  for (let i=0;i<c5.length;i++){
    const bar = c5[i]; const price = bar.close; const ts = bar.time;
    for (let pi=positions.length-1; pi>=0; pi--){
      const p = positions[pi];
      if (bar.low <= p.sl) {closePos(pi, p.sl, ts, "SL"); continue;}
      if (bar.high >= p.tp) {closePos(pi, p.tp, ts, "TP"); continue;}
      if (ts - p.openMs >= TIME_STOP_BARS_15M*15*60_000) {closePos(pi, price, ts, "time"); continue;}
    }
    const evs = sigByTs.get(ts);
    if (evs) for (const e of evs){
      if (ts-lastL < COOLDOWN_MS) continue;
      if (positions.length >= MAX_CONCURRENT) continue;
      const qty = NOTIONAL / e.price;
      const fee = NOTIONAL * (FEE_PER_SIDE_PCT/100);
      const sl = e.price*(1-setup.slPct/100);
      const tp = e.price*(1+setup.tpPct/100);
      positions.push({side:"LONG", qty, entry:e.price, openMs:ts, sl, tp});
      wallet -= fee; totalFees += fee;
      totalAdds++; lastL=ts;
    }
    let upnl=0;
    for (const p of positions) upnl += p.qty*(price-p.entry);
    const eq = wallet+upnl;
    if (eq>peak) peak=eq; if (eq<trough) trough=eq;
    if (positions.length>0){
      let totQ = 0; for (const p of positions) totQ += p.qty;
      const mm = totQ*price*MAINT_MARGIN_RATE;
      if (eq<=mm){liq=true; liqMs=ts; break;}
    }
  }
  const lastPrice = c5[c5.length-1].close;
  let upnl=0;
  for (const p of positions) upnl += p.qty*(lastPrice-p.entry);
  const finalEq = wallet+upnl;
  const roi = ((finalEq-INITIAL_CAPITAL)/INITIAL_CAPITAL)*100;
  return {
    name: setup.name, sigs: signals.length,
    liquidated:liq, liqAtMs:liqMs,
    totalAdds, totalCloses,
    totalRealizedPnl, totalFees, finalUpnl: upnl, finalEq, wallet, roi,
    maxDD:peak-trough, peak, trough, winCount:win, lossCount:loss,
    slHits, tpHits, timeStops,
  };
}

function main() {
  console.log("[stochrsi-15m] Loading...");
  const c15 = loadCache("15m");
  const c5 = loadCache("5m");
  const closes15 = c15.map(b=>b.close);
  const stochRSI = calcStochRSI(closes15, 14, 14);
  // Count signals
  let crossCount = 0;
  for (let i=1;i<c15.length;i++){
    const cur = stochRSI[i], prev = stochRSI[i-1];
    if (cur===null||prev===null) continue;
    if (cur < STOCH_K_THRESHOLD && prev >= STOCH_K_THRESHOLD) crossCount++;
  }
  console.log(`[stochrsi-15m] StochRSI K cross-down <${STOCH_K_THRESHOLD}: ${crossCount} signals`);

  // Sweep SL/TP
  const sls = [0.5, 1, 2, 3, 5];
  const tps = [1, 2, 3, 5, 8, 10, 15];
  const results: any[] = [];
  for (const sl of sls) for (const tp of tps) {
    const r = run({name:`SL${sl}/TP${tp}`, slPct:sl, tpPct:tp}, c15, c5, stochRSI);
    results.push(r);
  }
  results.sort((a,b)=>b.roi-a.roi);
  console.log("\n=== TOP 15 (sorted by ROI) ===");
  console.log("Setup        ROI%       Realized   ADDs   TP   SL   T    WR%   DD$       LIQ");
  for (const r of results.slice(0,15)){
    const wr = r.winCount+r.lossCount;
    console.log(`${r.name.padEnd(13)} ${r.roi.toFixed(2).padStart(7)}%  ${('$'+r.totalRealizedPnl.toFixed(0)).padStart(10)}  ${r.totalAdds.toString().padStart(5)}  ${r.tpHits.toString().padStart(3)}  ${r.slHits.toString().padStart(3)}  ${r.timeStops.toString().padStart(3)}  ${wr>0?(r.winCount/wr*100).toFixed(0).padStart(4):"  —"}  $${r.maxDD.toFixed(0).padStart(7)}  ${r.liquidated?"YES":"NO"}`);
  }
  console.log("\n=== BOTTOM 5 (worst) ===");
  for (const r of results.slice(-5).reverse()){
    const wr = r.winCount+r.lossCount;
    console.log(`${r.name.padEnd(13)} ${r.roi.toFixed(2).padStart(7)}%  ${('$'+r.totalRealizedPnl.toFixed(0)).padStart(10)}  WR ${wr>0?(r.winCount/wr*100).toFixed(0):"-"}%  DD $${r.maxDD.toFixed(0)}  LIQ ${r.liquidated}`);
  }

  writeFileSync(join(__dirname,"..","assets","backtest_stochrsi_15m.json"), JSON.stringify({
    config:{tf:"15m", stochThreshold:STOCH_K_THRESHOLD, capital:INITIAL_CAPITAL, notional:NOTIONAL},
    signalCount: crossCount,
    results,
  }));
  console.log("\nSaved → assets/backtest_stochrsi_15m.json");
}
main();
