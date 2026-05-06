/**
 * backtest-redflag-filter.ts (anh Tommy 2026-05-04)
 * Test RED FLAG filter cho Hedge03 (StochRSI<5 LONG):
 *   A. Baseline (deployed)
 *   B. + RED FLAG: skip LONG khi detector score≥3 (5 signals top)
 *   C. + RED FLAG: skip LONG khi K<90 cross-down (đơn lẻ)
 *   D. Refined SHORT: score≥3 + drop≥3% from local peak
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const INITIAL_CAPITAL = 100000;
const NOTIONAL = 1000;
const FEE_PER_SIDE_PCT = 0.05;
const MAINT_MARGIN_RATE = 0.004;
const COOLDOWN_MS = 60*60_000;
const MAX_CONCURRENT = 20;
const TIME_STOP_BARS_15M = 96 * 4;
const SL_PCT = 5, TP_PCT = 10;
const STOCH_K_THRESHOLD = 5;

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }
interface Pos { side: "LONG"|"SHORT"; qty: number; entry: number; openMs: number; sl: number; tp: number; }

function loadCache(tf: string): Candle[] { return JSON.parse(readFileSync(join(__dirname,"..",".cache",`binance-${tf}-3y.json`),"utf8")); }
function calcSMA(a: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); if (a.length<p) return o; let s=0; for (let i=0;i<p;i++) s+=a[i]; o[p-1]=s/p; for (let i=p;i<a.length;i++){s+=a[i]-a[i-p]; o[i]=s/p;} return o; }
function calcEMA(a: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); if (a.length<p) return o; const k=2/(p+1); let e=0; for (let i=0;i<p;i++) e+=a[i]; e/=p; o[p-1]=e; for (let i=p;i<a.length;i++){e=a[i]*k+e*(1-k); o[i]=e;} return o; }
function calcRSI(c: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(c.length).fill(null); if (c.length<=p) return o; let g=0,l=0; for (let i=1;i<=p;i++){const ch=c[i]-c[i-1]; if (ch>=0) g+=ch; else l-=ch;} let ag=g/p, al=l/p; o[p]=al===0?100:100-100/(1+ag/al); for (let i=p+1;i<c.length;i++){const ch=c[i]-c[i-1]; ag=(ag*(p-1)+Math.max(ch,0))/p; al=(al*(p-1)+Math.max(-ch,0))/p; o[i]=al===0?100:100-100/(1+ag/al);} return o; }
function calcStochK(c: Candle[], p: number): (number|null)[] { const o: (number|null)[] = new Array(c.length).fill(null); for (let i=p-1;i<c.length;i++){let hi=-Infinity, lo=Infinity; for (let j=i-p+1;j<=i;j++){if (c[j].high>hi) hi=c[j].high; if (c[j].low<lo) lo=c[j].low;} o[i]=hi===lo?50:((c[i].close-lo)/(hi-lo))*100;} return o; }
function calcMACDHist(c: number[]): (number|null)[] { const e12=calcEMA(c,12), e26=calcEMA(c,26); const macd: (number|null)[] = c.map((_,i) => (e12[i]!=null && e26[i]!=null) ? e12[i]!-e26[i]! : null); const v: number[]=[], m: number[]=[]; for (let i=0;i<macd.length;i++) if (macd[i]!==null){v.push(macd[i]!); m.push(i);} const sigEma = calcEMA(v, 9); const signal: (number|null)[] = new Array(c.length).fill(null); for (let k=0;k<sigEma.length;k++) if (sigEma[k]!==null) signal[m[k]] = sigEma[k]; return c.map((_,i) => (macd[i]!=null && signal[i]!=null) ? macd[i]!-signal[i]! : null); }
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
function findIdx(arr: { time: number }[], t: number): number { let lo=0, hi=arr.length-1, ans=-1; while (lo<=hi){const m=(lo+hi)>>1; if (arr[m].time<=t){ans=m; lo=m+1;} else hi=m-1;} return ans; }

function topDetectorScore(ts: number, c1d: Candle[], c1w: Candle[],
  d_stochK: (number|null)[], d_rsi: (number|null)[], d_ma200: (number|null)[],
  w_macdh: (number|null)[]): number {
  let score = 0;
  const idx1d = findIdx(c1d, ts);
  const idx1w = findIdx(c1w, ts);
  if (idx1d >= 1) {
    const k = d_stochK[idx1d], kp = d_stochK[idx1d-1], r = d_rsi[idx1d], m200 = d_ma200[idx1d];
    if (k!==null && kp!==null && k < 90 && kp >= 90) score++;
    if (k!==null && r!==null && k > 90 && r > 70) score++;
    if (m200!==null && m200>0 && (c1d[idx1d].close - m200)/m200*100 > 15) score++;
  }
  if (idx1w >= 1) {
    const m0 = w_macdh[idx1w], m1 = w_macdh[idx1w-1];
    if (m0!==null && m0<0 && m1!==null && m1<0) score++;
    const b = c1w[idx1w];
    if ((b.high - Math.max(b.open, b.close))/b.open*100 > 2) score++;
  }
  return score;
}

interface Setup { name: string; useRedFlag: boolean; redFlagMode: "score3"|"k90only"|"none"; }

function run(setup: Setup, c5: Candle[], c15: Candle[], c1d: Candle[], c1w: Candle[],
  stochRSI: (number|null)[], d_stochK: (number|null)[], d_rsi: (number|null)[], d_ma200: (number|null)[], w_macdh: (number|null)[]) {
  // Build LONG signals from StochRSI<5 cross-down
  const signals: { ts: number; price: number }[] = [];
  for (let i=1;i<c15.length;i++){
    const cur = stochRSI[i], prev = stochRSI[i-1];
    if (cur===null||prev===null) continue;
    if (cur < STOCH_K_THRESHOLD && prev >= STOCH_K_THRESHOLD) signals.push({ts:c15[i].time, price:c15[i].close});
  }
  const sigByTs = new Map<number, typeof signals>();
  for (const s of signals){const a=sigByTs.get(s.ts)||[]; a.push(s); sigByTs.set(s.ts,a);}

  let positions: Pos[] = [];
  let wallet = INITIAL_CAPITAL;
  let totalFees=0, totalRealized=0, totalAdds=0, totalCloses=0;
  let win=0, loss=0, lastEntry=0;
  let liq=false, peak=INITIAL_CAPITAL, trough=INITIAL_CAPITAL;
  let slHits=0, tpHits=0, timeStops=0;
  let blockedByRedFlag = 0;

  function closePos(idx: number, price: number, ts: number, reason: string){
    const p = positions[idx];
    const realized = p.qty*(price-p.entry);
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
      if (bar.low <= p.sl) {closePos(pi, p.sl, ts, "SL"); continue;}
      if (bar.high >= p.tp) {closePos(pi, p.tp, ts, "TP"); continue;}
      if (ts - p.openMs >= TIME_STOP_BARS_15M*15*60_000) {closePos(pi, price, ts, "time"); continue;}
    }
    const evs = sigByTs.get(ts);
    if (evs) for (const e of evs){
      if (ts-lastEntry < COOLDOWN_MS) continue;
      if (positions.length >= MAX_CONCURRENT) continue;
      // RED FLAG check
      if (setup.useRedFlag) {
        const idx1d = findIdx(c1d, ts);
        if (setup.redFlagMode === "score3") {
          if (topDetectorScore(ts, c1d, c1w, d_stochK, d_rsi, d_ma200, w_macdh) >= 3) {
            blockedByRedFlag++;
            continue;
          }
        } else if (setup.redFlagMode === "k90only") {
          if (idx1d >= 1) {
            const k = d_stochK[idx1d], kp = d_stochK[idx1d-1];
            if (k!==null && kp!==null && k < 90 && kp >= 90) {
              blockedByRedFlag++; continue;
            }
          }
        }
      }
      const qty = NOTIONAL / e.price;
      const fee = NOTIONAL * (FEE_PER_SIDE_PCT/100);
      const sl = e.price*(1-SL_PCT/100);
      const tp = e.price*(1+TP_PCT/100);
      positions.push({side:"LONG", qty, entry:e.price, openMs:ts, sl, tp});
      wallet -= fee; totalFees += fee;
      totalAdds++; lastEntry=ts;
    }
    let upnl=0;
    for (const p of positions) upnl += p.qty*(price-p.entry);
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
  for (const p of positions) upnl += p.qty*(lastPrice-p.entry);
  const finalEq = wallet+upnl;
  const roi = ((finalEq-INITIAL_CAPITAL)/INITIAL_CAPITAL)*100;
  return {
    name: setup.name, signals: signals.length, blockedByRedFlag,
    liquidated:liq, totalAdds, totalCloses,
    totalRealized, totalFees, finalUpnl: upnl, finalEq, roi,
    maxDD:peak-trough, peak, trough, winCount:win, lossCount:loss,
    slHits, tpHits, timeStops,
  };
}

function main() {
  console.log("[redflag] Loading...");
  const c5 = loadCache("5m"); const c15 = loadCache("15m"); const c1d = loadCache("1d"); const c1w = loadCache("1w");
  const stochRSI = calcStochRSI(c15.map(b=>b.close), 14, 14);
  const d_stochK = calcStochK(c1d, 14);
  const d_rsi = calcRSI(c1d.map(b=>b.close), 14);
  const d_ma200 = calcSMA(c1d.map(b=>b.close), 200);
  const w_macdh = calcMACDHist(c1w.map(b=>b.close));

  const setups: Setup[] = [
    {name:"A. Baseline (no filter)",       useRedFlag:false, redFlagMode:"none"},
    {name:"B. + RED FLAG score≥3",          useRedFlag:true,  redFlagMode:"score3"},
    {name:"C. + RED FLAG K<90 only",        useRedFlag:true,  redFlagMode:"k90only"},
  ];
  const results: any[] = [];
  for (const su of setups) {
    const r = run(su, c5, c15, c1d, c1w, stochRSI, d_stochK, d_rsi, d_ma200, w_macdh);
    results.push(r);
    const wr = r.winCount+r.lossCount;
    console.log(`\n[${su.name}]`);
    console.log(`  signals=${r.signals} · blocked=${r.blockedByRedFlag} · ADDs=${r.totalAdds} · CLOSES ${r.totalCloses} (TP${r.tpHits}/SL${r.slHits}/T${r.timeStops}) · WR ${wr>0?(r.winCount/wr*100).toFixed(0)+"%":"-"}`);
    console.log(`  Realized $${r.totalRealized.toFixed(0)} · uPnL ${r.finalUpnl>=0?"+":""}$${r.finalUpnl.toFixed(0)} · EQ $${r.finalEq.toFixed(0)} · ROI ${r.roi.toFixed(2)}% · DD $${r.maxDD.toFixed(0)}`);
  }
  console.log("\n=== COMPARISON ===");
  console.log("Setup                              Signals Blocked ADDs   ROI%       Realized   WR%   DD$       Δ_DD");
  const baselineDD = results[0].maxDD;
  for (const r of results){
    const wr = r.winCount+r.lossCount;
    const ddDiff = ((r.maxDD - baselineDD)/baselineDD*100);
    console.log(`${r.name.padEnd(34)}${r.signals.toString().padStart(7)}  ${r.blockedByRedFlag.toString().padStart(6)}  ${r.totalAdds.toString().padStart(5)}  ${r.roi.toFixed(2).padStart(7)}%  ${('$'+r.totalRealized.toFixed(0)).padStart(10)}  ${wr>0?(r.winCount/wr*100).toFixed(0).padStart(4):"  —"}  $${r.maxDD.toFixed(0).padStart(7)}  ${(ddDiff>=0?"+":"")+ddDiff.toFixed(0)}%`);
  }
}
main();
