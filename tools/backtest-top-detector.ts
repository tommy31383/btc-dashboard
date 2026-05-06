/**
 * backtest-top-detector.ts (anh Tommy 2026-05-04)
 * "TOP DETECTOR" rule với 5 signals + K<90 cross-down:
 *   1. 1W MACD hist < 0 trong 2 tuần (bear divergence persistent)
 *   2. 1W upWick > 2%
 *   3. 1D distMA200 > +15%
 *   4. 1D Stoch K > 90 AND RSI > 70 (OB extreme)
 *   5. 1D StochK cross DOWN 90 (was >90, now <90) — EXIT signal
 *
 * Test 3 modes:
 *   A. Score-based: ≥3 of 5 signals → SHORT entry, TP 5% / SL 2%
 *   B. Strict: ALL 5 signals → SHORT entry
 *   C. K<90 cross DOWN alone (single signal) → SHORT
 *
 * Verify catch lần BTC sập 124k → 70k tháng 10/2025 → 02/2026.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const INITIAL_CAPITAL = 100000;
const NOTIONAL = 1000;
const FEE_PER_SIDE_PCT = 0.05;
const MAINT_MARGIN_RATE = 0.004;
const COOLDOWN_MS = 4*60*60_000; // 4h
const MAX_CONCURRENT = 10;
const TIME_STOP_BARS_5M = 96 * 24 * 7; // 7 days in 5m bars

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }
interface Pos { qty: number; entry: number; openMs: number; sl: number; tp: number; }

function loadCache(tf: string): Candle[] { return JSON.parse(readFileSync(join(__dirname,"..",".cache",`binance-${tf}-3y.json`),"utf8")); }
function calcSMA(a: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); if (a.length<p) return o; let s=0; for (let i=0;i<p;i++) s+=a[i]; o[p-1]=s/p; for (let i=p;i<a.length;i++){s+=a[i]-a[i-p]; o[i]=s/p;} return o; }
function calcEMA(a: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); if (a.length<p) return o; const k=2/(p+1); let e=0; for (let i=0;i<p;i++) e+=a[i]; e/=p; o[p-1]=e; for (let i=p;i<a.length;i++){e=a[i]*k+e*(1-k); o[i]=e;} return o; }
function calcRSI(c: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(c.length).fill(null); if (c.length<=p) return o; let g=0,l=0; for (let i=1;i<=p;i++){const ch=c[i]-c[i-1]; if (ch>=0) g+=ch; else l-=ch;} let ag=g/p, al=l/p; o[p]=al===0?100:100-100/(1+ag/al); for (let i=p+1;i<c.length;i++){const ch=c[i]-c[i-1]; ag=(ag*(p-1)+Math.max(ch,0))/p; al=(al*(p-1)+Math.max(-ch,0))/p; o[i]=al===0?100:100-100/(1+ag/al);} return o; }
function calcStochK(c: Candle[], p: number): (number|null)[] { const o: (number|null)[] = new Array(c.length).fill(null); for (let i=p-1;i<c.length;i++){let hi=-Infinity, lo=Infinity; for (let j=i-p+1;j<=i;j++){if (c[j].high>hi) hi=c[j].high; if (c[j].low<lo) lo=c[j].low;} o[i]=hi===lo?50:((c[i].close-lo)/(hi-lo))*100;} return o; }
function calcMACDHist(c: number[]): (number|null)[] { const e12=calcEMA(c,12), e26=calcEMA(c,26); const macd: (number|null)[] = c.map((_,i) => (e12[i]!=null && e26[i]!=null) ? e12[i]!-e26[i]! : null); const v: number[]=[], m: number[]=[]; for (let i=0;i<macd.length;i++) if (macd[i]!==null){v.push(macd[i]!); m.push(i);} const sigEma = calcEMA(v, 9); const signal: (number|null)[] = new Array(c.length).fill(null); for (let k=0;k<sigEma.length;k++) if (sigEma[k]!==null) signal[m[k]] = sigEma[k]; return c.map((_,i) => (macd[i]!=null && signal[i]!=null) ? macd[i]!-signal[i]! : null); }
function findIdx(arr: { time: number }[], t: number): number { let lo=0, hi=arr.length-1, ans=-1; while (lo<=hi){const m=(lo+hi)>>1; if (arr[m].time<=t){ans=m; lo=m+1;} else hi=m-1;} return ans; }

interface Setup { name: string; minScore: number; mode: "score"|"strict"|"k90only"; tpPct: number; slPct: number; }

interface SignalCheck { kCross90: boolean; kRsiOb: boolean; distMA200: boolean; wMACDneg: boolean; wUpWick: boolean; score: number; }

function checkSignals(c5Idx: number, c5: Candle[], c1d: Candle[], c1w: Candle[],
  d_stochK: (number|null)[], d_rsi: (number|null)[], d_ma200: (number|null)[],
  w_macdh: (number|null)[]): SignalCheck {
  const ts = c5[c5Idx].time;
  const idx1d = findIdx(c1d, ts);
  const idx1w = findIdx(c1w, ts);
  let kCross90=false, kRsiOb=false, distMA200=false, wMACDneg=false, wUpWick=false;
  if (idx1d >= 1) {
    const k = d_stochK[idx1d]; const kp = d_stochK[idx1d-1];
    if (k!==null && kp!==null) kCross90 = k < 90 && kp >= 90;
    const r = d_rsi[idx1d];
    if (k!==null && r!==null) kRsiOb = k > 90 && r > 70;
    const m200 = d_ma200[idx1d];
    if (m200!==null && m200>0) distMA200 = (c1d[idx1d].close - m200)/m200*100 > 15;
  }
  if (idx1w >= 2) {
    const m0 = w_macdh[idx1w], m1 = w_macdh[idx1w-1];
    wMACDneg = (m0!==null && m0<0) && (m1!==null && m1<0);
    const b = c1w[idx1w];
    wUpWick = (b.high - Math.max(b.open, b.close))/b.open*100 > 2;
  }
  const score = (kCross90?1:0) + (kRsiOb?1:0) + (distMA200?1:0) + (wMACDneg?1:0) + (wUpWick?1:0);
  return {kCross90, kRsiOb, distMA200, wMACDneg, wUpWick, score};
}

function run(setup: Setup, c5: Candle[], c1d: Candle[], c1w: Candle[],
  d_stochK: (number|null)[], d_rsi: (number|null)[], d_ma200: (number|null)[], w_macdh: (number|null)[]) {
  let positions: Pos[] = [];
  let wallet = INITIAL_CAPITAL;
  let totalFees=0, totalRealized=0, totalAdds=0, totalCloses=0;
  let win=0, loss=0, lastEntry=0;
  let liq=false, peak=INITIAL_CAPITAL, trough=INITIAL_CAPITAL;
  let slHits=0, tpHits=0, timeStops=0;
  let signalsFired = 0;
  let prevSignaled = false;

  function closePos(idx: number, price: number, ts: number, reason: string){
    const p = positions[idx];
    const realized = p.qty*(p.entry-price);
    const fee = p.qty*price*(FEE_PER_SIDE_PCT/100);
    const np = realized-fee;
    wallet += np; totalRealized += realized; totalFees += fee; totalCloses++;
    if (np>=0) win++; else loss++;
    if (reason==="SL") slHits++; else if (reason==="TP") tpHits++; else timeStops++;
    positions.splice(idx, 1);
  }

  for (let i=200;i<c5.length;i++){
    const bar = c5[i]; const price = bar.close; const ts = bar.time;
    for (let pi=positions.length-1; pi>=0; pi--){
      const p = positions[pi];
      if (bar.high >= p.sl) {closePos(pi, p.sl, ts, "SL"); continue;}
      if (bar.low <= p.tp) {closePos(pi, p.tp, ts, "TP"); continue;}
      if (ts - p.openMs >= TIME_STOP_BARS_5M*5*60_000) {closePos(pi, price, ts, "time"); continue;}
    }
    if (ts-lastEntry >= COOLDOWN_MS && positions.length < MAX_CONCURRENT) {
      const sc = checkSignals(i, c5, c1d, c1w, d_stochK, d_rsi, d_ma200, w_macdh);
      let entry = false;
      if (setup.mode === "score") entry = sc.score >= setup.minScore;
      else if (setup.mode === "strict") entry = sc.score === 5;
      else if (setup.mode === "k90only") entry = sc.kCross90;
      // Avoid same-signal repeat (only entry on rising edge)
      if (entry && !prevSignaled) {
        signalsFired++;
        const qty = NOTIONAL / price;
        const fee = NOTIONAL * (FEE_PER_SIDE_PCT/100);
        const sl = price*(1+setup.slPct/100);
        const tp = price*(1-setup.tpPct/100);
        positions.push({qty, entry:price, openMs:ts, sl, tp});
        wallet -= fee; totalFees += fee;
        totalAdds++; lastEntry=ts;
      }
      prevSignaled = entry;
    }
    let upnl=0;
    for (const p of positions) upnl += p.qty*(p.entry-price);
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
  for (const p of positions) upnl += p.qty*(p.entry-lastPrice);
  const finalEq = wallet+upnl;
  const roi = ((finalEq-INITIAL_CAPITAL)/INITIAL_CAPITAL)*100;
  return {
    name: setup.name, signalsFired, totalAdds, totalCloses,
    totalRealized, totalFees, finalUpnl: upnl, finalEq, roi,
    maxDD:peak-trough, peak, trough, winCount:win, lossCount:loss,
    slHits, tpHits, timeStops, liquidated:liq,
  };
}

function main() {
  console.log("[top-detector] Loading...");
  const c5 = loadCache("5m"); const c1d = loadCache("1d"); const c1w = loadCache("1w");
  const d_stochK = calcStochK(c1d, 14);
  const d_rsi = calcRSI(c1d.map(b=>b.close), 14);
  const d_ma200 = calcSMA(c1d.map(b=>b.close), 200);
  const w_macdh = calcMACDHist(c1w.map(b=>b.close));

  const setups: Setup[] = [
    {name:"A1. Score≥3 SHORT TP5/SL2",   mode:"score",  minScore:3, tpPct:5, slPct:2},
    {name:"A2. Score≥3 SHORT TP10/SL3",  mode:"score",  minScore:3, tpPct:10, slPct:3},
    {name:"A3. Score≥4 SHORT TP10/SL3",  mode:"score",  minScore:4, tpPct:10, slPct:3},
    {name:"B. Strict ALL 5 SHORT TP10/SL3", mode:"strict", minScore:5, tpPct:10, slPct:3},
    {name:"C1. K<90 only SHORT TP5/SL2", mode:"k90only", minScore:1, tpPct:5, slPct:2},
    {name:"C2. K<90 only SHORT TP10/SL3", mode:"k90only", minScore:1, tpPct:10, slPct:3},
    {name:"C3. K<90 only SHORT TP3/SL1", mode:"k90only", minScore:1, tpPct:3, slPct:1},
  ];
  const results: any[] = [];
  for (const su of setups) {
    const r = run(su, c5, c1d, c1w, d_stochK, d_rsi, d_ma200, w_macdh);
    results.push(r);
    const wr = r.winCount+r.lossCount;
    console.log(`\n[${su.name}]`);
    console.log(`  signals=${r.signalsFired} · ADDs=${r.totalAdds} · CLOSES ${r.totalCloses} (TP${r.tpHits}/SL${r.slHits}/T${r.timeStops}) · WR ${wr>0?(r.winCount/wr*100).toFixed(0)+"%":"-"}`);
    console.log(`  Realized $${r.totalRealized.toFixed(0)} · uPnL ${r.finalUpnl>=0?"+":""}$${r.finalUpnl.toFixed(0)} · EQ $${r.finalEq.toFixed(0)} · ROI ${r.roi.toFixed(2)}% · DD $${r.maxDD.toFixed(0)} · LIQ ${r.liquidated}`);
  }
  console.log("\n=== SORTED BY ROI ===");
  results.sort((a,b)=>b.roi-a.roi);
  console.log("Setup                              ADDs   ROI%      Realized   TP   SL   T    WR%   DD$");
  for (const r of results){
    const wr = r.winCount+r.lossCount;
    console.log(`${r.name.padEnd(34)}${r.totalAdds.toString().padStart(5)}  ${r.roi.toFixed(2).padStart(7)}%  ${('$'+r.totalRealized.toFixed(0)).padStart(10)}  ${r.tpHits.toString().padStart(3)}  ${r.slHits.toString().padStart(3)}  ${r.timeStops.toString().padStart(3)}  ${wr>0?(r.winCount/wr*100).toFixed(0).padStart(4):"  —"}  $${r.maxDD.toFixed(0).padStart(7)}`);
  }

  // Special check: did any setup catch the 124k → 70k drop?
  console.log("\n=== CATCH 124k→70k DROP (Oct 2025 - Feb 2026)? ===");
  const dropStart = new Date("2025-10-06").getTime();
  const dropEnd = new Date("2026-02-02").getTime();
  // Re-run best setup with detail
  console.log("Best setup signals fired during peak/drop period:");
  // Walk c5 around peak and check signals
  let totalInPeriod = 0;
  for (let i=200;i<c5.length;i++){
    const ts = c5[i].time;
    if (ts < dropStart - 7*24*60*60_000 || ts > dropStart + 7*24*60*60_000) continue;
    const sc = checkSignals(i, c5, c1d, c1w, d_stochK, d_rsi, d_ma200, w_macdh);
    if (sc.score >= 3) {
      console.log(`  ${new Date(ts).toISOString().slice(0,16)}  $${c5[i].close.toFixed(0)}  score=${sc.score}/5  [kCross90:${sc.kCross90?'✓':' '} kRsiOb:${sc.kRsiOb?'✓':' '} distMA200:${sc.distMA200?'✓':' '} wMACDneg:${sc.wMACDneg?'✓':' '} wUpWick:${sc.wUpWick?'✓':' '}]`);
      totalInPeriod++;
      if (totalInPeriod > 20) {console.log("  ... (cap 20 entries)"); break;}
    }
  }
  console.log(`Total ≥3 score signals in peak ±7d window: ${totalInPeriod}`);
}
main();
