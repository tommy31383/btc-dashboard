/**
 * backtest-hedge01-real.ts (anh Tommy 2026-05-04)
 * REAL-TIME backtest (no look-ahead) cho Hedge01 v2:
 *   - Entry: profile score≥9/11 trên 15m + filter bbWidth ≥ 3%
 *   - SL: -3% từ entry
 *   - TP: +5% từ entry
 *   - Per-position tracking (mỗi entry là 1 position riêng, không merge avg)
 *   - Cap max 10 concurrent positions/side
 *   - Test cả LONG + SHORT
 *
 * Compare 6 setups:
 *   A. score≥9 + SL3 + TP5 (no filter)
 *   B. score≥9 + bbWidth≥3 + SL3 + TP5
 *   C. score≥10 + SL3 + TP5
 *   D. score≥9 + LONG only
 *   E. score≥9 + SHORT only
 *   F. score≥11 + SL3 + TP5 (strict best)
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const INITIAL_CAPITAL = 100000;
const NOTIONAL_PER_ADD = 1000;
const FEE_PER_SIDE_PCT = 0.05;
const MAINT_MARGIN_RATE = 0.004;
const COOLDOWN_MS = 60*60_000;
// Sweep nhiều SL/TP combo
const SL_TP_COMBOS: { sl: number; tp: number }[] = [
  { sl: 3, tp: 5 },
  { sl: 3, tp: 8 },
  { sl: 3, tp: 10 },
  { sl: 3, tp: 12 },
  { sl: 3, tp: 15 },
  { sl: 5, tp: 10 },
  { sl: 5, tp: 15 },
  { sl: 2, tp: 8 },
];
let SL_PCT = 3;
let TP_PCT = 5;
const MAX_CONCURRENT = 10;
const FORWARD_CAP_BARS = 96 * 7;

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }
interface Pos { side: "LONG"|"SHORT"; qty: number; entry: number; openMs: number; sl: number; tp: number; }

function loadCache(tf: string): Candle[] { return JSON.parse(readFileSync(join(__dirname,"..",".cache",`binance-${tf}-3y.json`),"utf8")); }
function calcSMA(a: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); if (a.length<p) return o; let s=0; for (let i=0;i<p;i++) s+=a[i]; o[p-1]=s/p; for (let i=p;i<a.length;i++){s+=a[i]-a[i-p]; o[i]=s/p;} return o; }
function calcEMA(a: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); if (a.length<p) return o; const k=2/(p+1); let e=0; for (let i=0;i<p;i++) e+=a[i]; e/=p; o[p-1]=e; for (let i=p;i<a.length;i++){e=a[i]*k+e*(1-k); o[i]=e;} return o; }
function calcStdev(a: number[], p: number, sma: (number|null)[]): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); for (let i=p-1;i<a.length;i++){const m=sma[i]; if (m===null) continue; let sq=0; for (let j=i-p+1;j<=i;j++) sq+=(a[j]-m)**2; o[i]=Math.sqrt(sq/p);} return o; }
function calcRSI(c: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(c.length).fill(null); if (c.length<=p) return o; let g=0,l=0; for (let i=1;i<=p;i++){const ch=c[i]-c[i-1]; if (ch>=0) g+=ch; else l-=ch;} let ag=g/p, al=l/p; o[p]=al===0?100:100-100/(1+ag/al); for (let i=p+1;i<c.length;i++){const ch=c[i]-c[i-1]; ag=(ag*(p-1)+Math.max(ch,0))/p; al=(al*(p-1)+Math.max(-ch,0))/p; o[i]=al===0?100:100-100/(1+ag/al);} return o; }
function calcStochK(c: Candle[], p: number): (number|null)[] { const o: (number|null)[] = new Array(c.length).fill(null); for (let i=p-1;i<c.length;i++){let hi=-Infinity, lo=Infinity; for (let j=i-p+1;j<=i;j++){if (c[j].high>hi) hi=c[j].high; if (c[j].low<lo) lo=c[j].low;} o[i]=hi===lo?50:((c[i].close-lo)/(hi-lo))*100;} return o; }
function calcATR(c: Candle[], p: number): (number|null)[] { const o: (number|null)[] = new Array(c.length).fill(null); if (c.length<=p) return o; const tr: number[] = new Array(c.length).fill(0); for (let i=1;i<c.length;i++) tr[i]=Math.max(c[i].high-c[i].low, Math.abs(c[i].high-c[i-1].close), Math.abs(c[i].low-c[i-1].close)); let s=0; for (let i=1;i<=p;i++) s+=tr[i]; o[p]=s/p; for (let i=p+1;i<c.length;i++) o[i]=(o[i-1]!*(p-1)+tr[i])/p; return o; }
function calcMACDHist(c: number[]): (number|null)[] { const e12=calcEMA(c,12), e26=calcEMA(c,26); const macd: (number|null)[] = c.map((_,i) => (e12[i]!=null && e26[i]!=null) ? e12[i]!-e26[i]! : null); const v: number[]=[], m: number[]=[]; for (let i=0;i<macd.length;i++) if (macd[i]!==null){v.push(macd[i]!); m.push(i);} const sigEma = calcEMA(v, 9); const signal: (number|null)[] = new Array(c.length).fill(null); for (let k=0;k<sigEma.length;k++) if (sigEma[k]!==null) signal[m[k]] = sigEma[k]; return c.map((_,i) => (macd[i]!=null && signal[i]!=null) ? macd[i]!-signal[i]! : null); }

interface Setup {
  name: string;
  minScore: number;
  bbWidthMin: number; // 0 = no filter
  longEnabled: boolean;
  shortEnabled: boolean;
}

interface Sig { ts: number; side: "LONG"|"SHORT"; price: number; }

function buildSignals(c: Candle[], setup: Setup): Sig[] {
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
  const sigs: Sig[] = [];
  for (let i=20;i<c.length;i++){
    const b = c[i];
    const dnW = (Math.min(b.open,b.close)-b.low)/b.open*100;
    const upW = (b.high-Math.max(b.open,b.close))/b.open*100;
    const body = Math.abs(b.close-b.open)/b.open*100;
    const isBull = b.close>b.open ? 1 : 0;
    const volR = volMA[i] && volMA[i]!>0 ? (b.volume??0)/volMA[i]! : 0;
    const ma=ma20[i], sd=sd20[i];
    const bbPos = (ma!==null && sd!==null && sd>0) ? (b.close-(ma-2*sd))/(4*sd)*100 : 50;
    const bbWidth = (ma!==null && sd!==null && ma>0) ? (4*sd)/ma*100 : 0;
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
    if (setup.bbWidthMin>0 && bbWidth<setup.bbWidthMin) continue;
    if (setup.longEnabled && lS>=setup.minScore) sigs.push({ts:b.time, side:"LONG", price:b.close});
    if (setup.shortEnabled && sS>=setup.minScore) sigs.push({ts:b.time, side:"SHORT", price:b.close});
  }
  return sigs;
}

function run(setup: Setup, c5: Candle[], c15: Candle[]) {
  const sigs = buildSignals(c15, setup);
  const sigByTs = new Map<number, Sig[]>();
  for (const s of sigs){const a=sigByTs.get(s.ts)||[]; a.push(s); sigByTs.set(s.ts,a);}

  let positions: Pos[] = [];
  let wallet = INITIAL_CAPITAL;
  let totalFees=0, totalRealizedPnl=0, totalAddsL=0, totalAddsS=0, totalCloses=0;
  let win=0, loss=0;
  let lastL=0, lastS=0;
  let liq=false, liqMs=0, peak=INITIAL_CAPITAL, trough=INITIAL_CAPITAL;
  let timeStops=0, slHits=0, tpHits=0;

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

  for (let i=0;i<c5.length;i++){
    const bar = c5[i]; const price = bar.close; const ts = bar.time;
    // Check SL/TP for each pos (use bar high/low for realistic worst case)
    for (let pi=positions.length-1; pi>=0; pi--){
      const p = positions[pi];
      if (p.side==="LONG"){
        if (bar.low <= p.sl) {closePos(pi, p.sl, ts, "SL"); continue;}
        if (bar.high >= p.tp) {closePos(pi, p.tp, ts, "TP"); continue;}
      } else {
        if (bar.high >= p.sl) {closePos(pi, p.sl, ts, "SL"); continue;}
        if (bar.low <= p.tp) {closePos(pi, p.tp, ts, "TP"); continue;}
      }
      // Time stop = FORWARD_CAP_BARS bars 15m = 7d
      if (ts - p.openMs >= FORWARD_CAP_BARS * 15 * 60_000) {closePos(pi, price, ts, "time"); continue;}
    }
    // ENTRY
    const evs = sigByTs.get(ts);
    if (evs) for (const e of evs){
      const cool = e.side==="LONG" ? ts-lastL>=COOLDOWN_MS : ts-lastS>=COOLDOWN_MS;
      if (!cool) continue;
      const sideOpen = positions.filter(p=>p.side===e.side).length;
      if (sideOpen >= MAX_CONCURRENT) continue;
      const qty = NOTIONAL_PER_ADD / e.price;
      const fee = NOTIONAL_PER_ADD * (FEE_PER_SIDE_PCT/100);
      const sl = e.side==="LONG" ? e.price*(1-SL_PCT/100) : e.price*(1+SL_PCT/100);
      const tp = e.side==="LONG" ? e.price*(1+TP_PCT/100) : e.price*(1-TP_PCT/100);
      positions.push({side:e.side, qty, entry:e.price, openMs:ts, sl, tp});
      wallet -= fee; totalFees += fee;
      if (e.side==="LONG"){totalAddsL++; lastL=ts;} else {totalAddsS++; lastS=ts;}
    }
    // Stats
    let upnl=0;
    for (const p of positions){
      if (p.side==="LONG") upnl += p.qty*(price-p.entry);
      else upnl += p.qty*(p.entry-price);
    }
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
  for (const p of positions) upnl += (p.side==="LONG"?p.qty*(lastPrice-p.entry):p.qty*(p.entry-lastPrice));
  const finalEq = wallet+upnl;
  const roi = ((finalEq-INITIAL_CAPITAL)/INITIAL_CAPITAL)*100;
  return {
    name: setup.name,
    liquidated:liq, liqAtMs:liqMs,
    totalAddsLong: totalAddsL, totalAddsShort: totalAddsS, totalCloses,
    totalRealizedPnl, totalFees, finalUpnl: upnl, finalEq, wallet, roi,
    maxDD:peak-trough, peak, trough, winCount:win, lossCount:loss,
    slHits, tpHits, timeStops, openPositions: positions.length,
  };
}

function main(){
  console.log("[h01-real] Loading...");
  const c5 = loadCache("5m"); const c15 = loadCache("15m");

  const baseSetups: Setup[] = [
    {name:"score≥9", minScore:9, bbWidthMin:0, longEnabled:true, shortEnabled:true},
    {name:"score≥9+bbW≥3", minScore:9, bbWidthMin:3, longEnabled:true, shortEnabled:true},
    {name:"score≥10", minScore:10, bbWidthMin:0, longEnabled:true, shortEnabled:true},
    {name:"score≥11", minScore:11, bbWidthMin:0, longEnabled:true, shortEnabled:true},
  ];
  const results: any[] = [];
  for (const combo of SL_TP_COMBOS) {
    SL_PCT = combo.sl; TP_PCT = combo.tp;
    for (const su of baseSetups) {
      const setupName = `${su.name} SL${combo.sl}/TP${combo.tp}`;
      const r = run({...su, name: setupName}, c5, c15);
      results.push(r);
      const wr = r.winCount+r.lossCount;
      console.log(`[${setupName}] ROI ${r.roi.toFixed(2)}% · CLOSES ${r.totalCloses} (TP ${r.tpHits}/SL ${r.slHits}/T ${r.timeStops}) · WR ${wr>0?(r.winCount/wr*100).toFixed(0)+"%":"-"} · DD $${r.maxDD.toFixed(0)} · LIQ ${r.liquidated}`);
    }
  }
  console.log("\n=== TOP 10 SORTED BY ROI ===");
  results.sort((a,b)=>b.roi-a.roi);
  console.log("Setup                              ROI%      Realized   TPhits SLhits Time   WR%   DD$       LIQ");
  for (const r of results.slice(0, 10)){
    const wr = r.winCount+r.lossCount;
    console.log(`${r.name.padEnd(34)}${r.roi.toFixed(2).padStart(8)}%  ${('$'+r.totalRealizedPnl.toFixed(0)).padStart(10)}  ${r.tpHits.toString().padStart(5)}  ${r.slHits.toString().padStart(5)}  ${r.timeStops.toString().padStart(5)}  ${wr>0?(r.winCount/wr*100).toFixed(0).padStart(4):"  —"}  $${r.maxDD.toFixed(0).padStart(7)}  ${r.liquidated?"YES":"NO"}`);
  }

  writeFileSync(join(__dirname,"..","assets","backtest_hedge01_real_3y.json"), JSON.stringify({
    config:{slPct:SL_PCT, tpPct:TP_PCT, maxConcurrent:MAX_CONCURRENT, capital:INITIAL_CAPITAL, notional:NOTIONAL_PER_ADD},
    results,
  }));
  console.log("\nSaved → assets/backtest_hedge01_real_3y.json");
}
main();
