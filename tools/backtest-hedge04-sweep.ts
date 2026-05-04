/**
 * backtest-hedge04-sweep.ts (anh Tommy 2026-05-04)
 * Sweep Hedge04 score-filter:
 *   - Score: 3, 4, 5, 6
 *   - TP%:    5, 10, 15, 20, 25
 *   - Time:   14d, 30d, 60d
 *   - DD pause: none vs pause khi EQ drop 30% từ peak
 *   - HTF filter: none vs only trade with 1D MA200 trend
 * Total = 4×5×3×2×2 = 240 setups → cap to top 20 by ROI.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const INITIAL_CAPITAL = 100000;
const NOTIONAL_PER_ADD = 1000;
const FEE_PER_SIDE_PCT = 0.05;
const MAINT_MARGIN_RATE = 0.004;
const COOLDOWN_MS = 60*60_000;

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }
interface Net { qty: number; avg: number; openMs: number; }

function loadCache(tf: string): Candle[] { return JSON.parse(readFileSync(join(__dirname,"..",".cache",`binance-${tf}-3y.json`),"utf8")); }
function calcSMA(a: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); if (a.length<p) return o; let s=0; for (let i=0;i<p;i++) s+=a[i]; o[p-1]=s/p; for (let i=p;i<a.length;i++){s+=a[i]-a[i-p]; o[i]=s/p;} return o; }
function calcEMA(a: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); if (a.length<p) return o; const k=2/(p+1); let e=0; for (let i=0;i<p;i++) e+=a[i]; e/=p; o[p-1]=e; for (let i=p;i<a.length;i++){e=a[i]*k+e*(1-k); o[i]=e;} return o; }
function calcStdev(a: number[], p: number, sma: (number|null)[]): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); for (let i=p-1;i<a.length;i++){const m=sma[i]; if (m===null) continue; let sq=0; for (let j=i-p+1;j<=i;j++) sq+=(a[j]-m)**2; o[i]=Math.sqrt(sq/p);} return o; }
function calcRSI(c: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(c.length).fill(null); if (c.length<=p) return o; let g=0,l=0; for (let i=1;i<=p;i++){const ch=c[i]-c[i-1]; if (ch>=0) g+=ch; else l-=ch;} let ag=g/p, al=l/p; o[p]=al===0?100:100-100/(1+ag/al); for (let i=p+1;i<c.length;i++){const ch=c[i]-c[i-1]; ag=(ag*(p-1)+Math.max(ch,0))/p; al=(al*(p-1)+Math.max(-ch,0))/p; o[i]=al===0?100:100-100/(1+ag/al);} return o; }
function calcATR(c: Candle[], p: number): (number|null)[] { const o: (number|null)[] = new Array(c.length).fill(null); if (c.length<=p) return o; const tr: number[] = new Array(c.length).fill(0); for (let i=1;i<c.length;i++) tr[i]=Math.max(c[i].high-c[i].low, Math.abs(c[i].high-c[i-1].close), Math.abs(c[i].low-c[i-1].close)); let s=0; for (let i=1;i<=p;i++) s+=tr[i]; o[p]=s/p; for (let i=p+1;i<c.length;i++) o[i]=(o[i-1]!*(p-1)+tr[i])/p; return o; }
function calcMACDHist(c: number[]): (number|null)[] { const e12=calcEMA(c,12), e26=calcEMA(c,26); const macd: (number|null)[] = c.map((_,i) => (e12[i]!=null && e26[i]!=null) ? e12[i]!-e26[i]! : null); const v: number[]=[], m: number[]=[]; for (let i=0;i<macd.length;i++) if (macd[i]!==null){v.push(macd[i]!); m.push(i);} const sigEma = calcEMA(v, 9); const signal: (number|null)[] = new Array(c.length).fill(null); for (let k=0;k<sigEma.length;k++) if (sigEma[k]!==null) signal[m[k]] = sigEma[k]; return c.map((_,i) => (macd[i]!=null && signal[i]!=null) ? macd[i]!-signal[i]! : null); }
function findIdx(arr: { time: number }[], t: number): number { let lo=0, hi=arr.length-1, ans=-1; while (lo<=hi){const m=(lo+hi)>>1; if (arr[m].time<=t){ans=m; lo=m+1;} else hi=m-1;} return ans; }
function addNet(n: Net, q: number, p: number, ts: number): Net { const nq=n.qty+q; return { qty:nq, avg: nq>0?(n.qty*n.avg+q*p)/nq:0, openMs: n.qty===0?ts:n.openMs }; }

interface Setup { name: string; minScore: number; tpPct: number; timeStopMs: number; ddPausePct: number; useHTFTrend: boolean; }
interface FeatBar { ts: number; close: number; longScore: number; shortScore: number; }

function buildFeatures(c1h: Candle[]): FeatBar[] {
  const closes = c1h.map(b=>b.close);
  const rsi = calcRSI(closes, 14);
  const macdH = calcMACDHist(closes);
  const ma50 = calcSMA(closes, 50);
  const ma20 = calcSMA(closes, 20);
  const sd20 = calcStdev(closes, 20, ma20);
  const atr14 = calcATR(c1h, 14);
  const vols = c1h.map(b=>b.volume??0);
  const volMA = calcSMA(vols, 20);
  const out: FeatBar[] = [];
  for (let i=0;i<c1h.length;i++){
    const b = c1h[i];
    const dnWick = (Math.min(b.open,b.close)-b.low)/b.open*100;
    const upWick = (b.high-Math.max(b.open,b.close))/b.open*100;
    const body = Math.abs(b.close-b.open)/b.open*100;
    const volR = volMA[i] && volMA[i]!>0 ? (b.volume??0)/volMA[i]! : 0;
    const ma=ma20[i], sd=sd20[i];
    const bbPos = (ma!==null && sd!==null && sd>0) ? (b.close-(ma-2*sd))/((ma+2*sd)-(ma-2*sd))*100 : 50;
    const mom5 = i>=5 ? (b.close-c1h[i-5].close)/c1h[i-5].close*100 : 0;
    const atr = atr14[i]; const range = b.high-b.low;
    const atrRatio = atr && atr>0 ? range/atr : 0;
    const distMA50 = ma50[i] && ma50[i]!>0 ? (b.close-ma50[i]!)/ma50[i]!*100 : 0;
    const r = rsi[i] ?? 50;
    const mh = macdH[i] ?? 0;
    let lS=0, sS=0;
    if (dnWick>=0.5) lS++; if (volR>=1.5) lS++; if (mom5<=-1) lS++; if (atrRatio>=1.5) lS++; if (mh<=-50) lS++; if (body>=0.5) lS++; if (distMA50<=-1.5) lS++; if (r<=40) lS++; if (bbPos<=20) lS++;
    if (upWick>=0.5) sS++; if (volR>=1.5) sS++; if (mom5>=1) sS++; if (atrRatio>=1.5) sS++; if (mh>=50) sS++; if (body>=0.5) sS++; if (distMA50>=1.5) sS++; if (r>=60) sS++; if (bbPos>=80) sS++;
    out.push({ ts:b.time, close:b.close, longScore:lS, shortScore:sS });
  }
  return out;
}

function run(setup: Setup, c5: Candle[], feats: FeatBar[], c1d: Candle[], ma200_1d: (number|null)[]) {
  let longNet: Net = {qty:0, avg:0, openMs:0};
  let shortNet: Net = {qty:0, avg:0, openMs:0};
  let wallet = INITIAL_CAPITAL;
  let totalFees=0, totalRealizedPnl=0, totalAddsL=0, totalAddsS=0, totalCloses=0;
  let win=0, loss=0, lastL=0, lastS=0;
  let liq=false, liqMs=0, peak=INITIAL_CAPITAL, trough=INITIAL_CAPITAL;
  let pauseUntil=0;

  function applyClose(side: "LONG"|"SHORT", price: number, ts: number){
    const net = side==="LONG" ? longNet : shortNet;
    if (net.qty<=0) return;
    const realized = side==="LONG" ? net.qty*(price-net.avg) : net.qty*(net.avg-price);
    const fee = net.qty*price*(FEE_PER_SIDE_PCT/100);
    const np = realized-fee;
    wallet += np; totalRealizedPnl += realized; totalFees += fee; totalCloses++;
    if (np>=0) win++; else loss++;
    if (side==="LONG") longNet={qty:0, avg:0, openMs:0}; else shortNet={qty:0, avg:0, openMs:0};
  }

  // Build entry events from feats
  const entryByTs = new Map<number, { side: "LONG"|"SHORT"; price: number }[]>();
  for (const f of feats){
    if (f.longScore>=setup.minScore){const a=entryByTs.get(f.ts)||[]; a.push({side:"LONG", price:f.close}); entryByTs.set(f.ts,a);}
    if (f.shortScore>=setup.minScore){const a=entryByTs.get(f.ts)||[]; a.push({side:"SHORT", price:f.close}); entryByTs.set(f.ts,a);}
  }

  for (let i=0;i<c5.length;i++){
    const bar = c5[i]; const price = bar.close; const ts = bar.time;
    if (setup.tpPct>0){
      if (longNet.qty>0){
        const gain=(price-longNet.avg)/longNet.avg*100;
        if (gain>=setup.tpPct) applyClose("LONG", price, ts);
        else if (ts-longNet.openMs>=setup.timeStopMs) applyClose("LONG", price, ts);
      }
      if (shortNet.qty>0){
        const drop=(shortNet.avg-price)/shortNet.avg*100;
        if (drop>=setup.tpPct) applyClose("SHORT", price, ts);
        else if (ts-shortNet.openMs>=setup.timeStopMs) applyClose("SHORT", price, ts);
      }
    }
    // ENTRY
    if (ts>=pauseUntil){
      const evs = entryByTs.get(ts);
      if (evs) for (const e of evs){
        // HTF trend filter
        if (setup.useHTFTrend){
          const idx = findIdx(c1d, ts);
          if (idx<200) continue;
          const ma = ma200_1d[idx-1]; if (ma===null) continue;
          const trendUp = c1d[idx-1].close>ma;
          if (e.side==="LONG" && !trendUp) continue;
          if (e.side==="SHORT" && trendUp) continue;
        }
        const cool = e.side==="LONG" ? ts-lastL>=COOLDOWN_MS : ts-lastS>=COOLDOWN_MS;
        if (!cool) continue;
        const qty = NOTIONAL_PER_ADD/e.price;
        const fee = NOTIONAL_PER_ADD*(FEE_PER_SIDE_PCT/100);
        if (e.side==="LONG"){longNet=addNet(longNet,qty,e.price,ts); totalAddsL++; lastL=ts;}
        else {shortNet=addNet(shortNet,qty,e.price,ts); totalAddsS++; lastS=ts;}
        wallet -= fee; totalFees += fee;
      }
    }
    // Stats
    let upnl=0;
    if (longNet.qty>0) upnl += longNet.qty*(price-longNet.avg);
    if (shortNet.qty>0) upnl += shortNet.qty*(shortNet.avg-price);
    const eq = wallet+upnl;
    if (eq>peak) peak=eq; if (eq<trough) trough=eq;
    // DD pause
    if (setup.ddPausePct>0 && peak>0){
      const ddPct = (peak-eq)/peak*100;
      if (ddPct>=setup.ddPausePct){
        // Close all + pause 30 days
        if (longNet.qty>0) applyClose("LONG", price, ts);
        if (shortNet.qty>0) applyClose("SHORT", price, ts);
        pauseUntil = ts + 30*24*60*60_000;
        peak = wallet; // reset peak after pause
      }
    }
    if (longNet.qty+shortNet.qty>0){
      const mm=(longNet.qty+shortNet.qty)*price*MAINT_MARGIN_RATE;
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
    name: setup.name, params: setup,
    liquidated:liq, liqAtMs:liqMs,
    totalAddsLong: totalAddsL, totalAddsShort: totalAddsS, totalCloses,
    totalRealizedPnl, totalFees,
    finalLong: longNet, finalShort: shortNet, lastPrice,
    finalUpnl, finalEq, wallet, roi,
    maxDD:peak-trough, peak, trough,
    winCount: win, lossCount: loss,
  };
}

function main(){
  console.log("[hedge04-sweep] Loading...");
  const c5 = loadCache("5m"); const c1h = loadCache("1h"); const c1d = loadCache("1d");
  const feats = buildFeatures(c1h);
  const ma200_1d = calcSMA(c1d.map(b=>b.close), 200);

  const scores = [3,4,5,6];
  const tps = [5,10,15,20,25];
  const times = [14, 30, 60]; // days
  const ddPauses = [0, 30]; // %
  const htfFilters = [false, true];

  const results: any[] = [];
  let count = 0;
  const total = scores.length * tps.length * times.length * ddPauses.length * htfFilters.length;
  for (const s of scores) for (const tp of tps) for (const t of times) for (const dd of ddPauses) for (const hf of htfFilters){
    const setup: Setup = {
      name: `S${s} TP${tp}% T${t}d DD${dd} HTF${hf?'Y':'N'}`,
      minScore: s, tpPct: tp, timeStopMs: t*24*60*60_000, ddPausePct: dd, useHTFTrend: hf,
    };
    const r = run(setup, c5, feats, c1d, ma200_1d);
    results.push(r);
    count++;
    if (count%30===0) console.log(`  progress ${count}/${total}`);
  }
  results.sort((a,b)=>b.roi-a.roi);
  console.log(`\n=== TOP 25 (sorted ROI) ===`);
  console.log("Setup                                    ROI%      Realized      uPnL        EQUITY      DD$       Trades  CLOSES  WR%   LIQ");
  for (const r of results.slice(0,25)){
    const wr = r.winCount+r.lossCount;
    console.log(`${r.name.padEnd(42)}${r.roi.toFixed(2).padStart(8)}% ${('$'+r.totalRealizedPnl.toFixed(0)).padStart(12)} ${((r.finalUpnl>=0?'+':'')+'$'+r.finalUpnl.toFixed(0)).padStart(12)} ${('$'+r.finalEq.toFixed(0)).padStart(11)}  $${r.maxDD.toFixed(0).padStart(7)}  ${(r.totalAddsLong+r.totalAddsShort).toString().padStart(6)}  ${r.totalCloses.toString().padStart(6)}  ${wr>0?(r.winCount/wr*100).toFixed(0).padStart(4):"  —"}  ${r.liquidated?"YES":"NO"}`);
  }
  console.log(`\n=== BOTTOM 5 (worst) ===`);
  for (const r of results.slice(-5).reverse()){
    const wr = r.winCount+r.lossCount;
    console.log(`${r.name.padEnd(42)}${r.roi.toFixed(2).padStart(8)}% ${('$'+r.totalRealizedPnl.toFixed(0)).padStart(12)} DD $${r.maxDD.toFixed(0)} LIQ ${r.liquidated}`);
  }

  writeFileSync(join(__dirname,"..","assets","backtest_hedge04_sweep_3y.json"), JSON.stringify({
    initialCapital: INITIAL_CAPITAL, totalSetups: results.length,
    top25: results.slice(0,25),
    all: results.map(r => ({name:r.name, roi:r.roi, maxDD:r.maxDD, totalCloses:r.totalCloses, winCount:r.winCount, lossCount:r.lossCount, liquidated:r.liquidated, finalEq:r.finalEq, totalAddsLong:r.totalAddsLong, totalAddsShort:r.totalAddsShort, totalRealizedPnl:r.totalRealizedPnl, finalUpnl:r.finalUpnl})),
  }));
  console.log(`\n[hedge04-sweep] ${results.length} setups tested. Saved → assets/backtest_hedge04_sweep_3y.json`);
}
main();
