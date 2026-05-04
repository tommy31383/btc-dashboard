/**
 * backtest-hedge04-dd-fix.ts (anh Tommy 2026-05-04)
 * Reduce DD cho winner setup S3 TP10% T30d HTFN bằng 8 strategies:
 *   1. Baseline (winner ref)
 *   2. + SL 5%
 *   3. + Cap 50/side
 *   4. + SL5% + Cap50
 *   5. + Asymmetric SHORT 0.3x trong BTC bull (1D MA200)
 *   6. + Equity-based size 1% EQ
 *   7. + Hard EQ stop -30% pause permanent
 *   8. ALL combined
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const INITIAL_CAPITAL = 100000;
const NOTIONAL_BASE = 1000;
const FEE_PER_SIDE_PCT = 0.05;
const MAINT_MARGIN_RATE = 0.004;
const COOLDOWN_MS = 60*60_000;
const MIN_SCORE = 3;
const TP_PCT = 10;
const TIME_STOP_MS = 30*24*60*60_000;

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }
interface Pos { qty: number; entry: number; openMs: number; }

function loadCache(tf: string): Candle[] { return JSON.parse(readFileSync(join(__dirname,"..",".cache",`binance-${tf}-3y.json`),"utf8")); }
function calcSMA(a: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); if (a.length<p) return o; let s=0; for (let i=0;i<p;i++) s+=a[i]; o[p-1]=s/p; for (let i=p;i<a.length;i++){s+=a[i]-a[i-p]; o[i]=s/p;} return o; }
function calcEMA(a: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); if (a.length<p) return o; const k=2/(p+1); let e=0; for (let i=0;i<p;i++) e+=a[i]; e/=p; o[p-1]=e; for (let i=p;i<a.length;i++){e=a[i]*k+e*(1-k); o[i]=e;} return o; }
function calcStdev(a: number[], p: number, sma: (number|null)[]): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); for (let i=p-1;i<a.length;i++){const m=sma[i]; if (m===null) continue; let sq=0; for (let j=i-p+1;j<=i;j++) sq+=(a[j]-m)**2; o[i]=Math.sqrt(sq/p);} return o; }
function calcRSI(c: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(c.length).fill(null); if (c.length<=p) return o; let g=0,l=0; for (let i=1;i<=p;i++){const ch=c[i]-c[i-1]; if (ch>=0) g+=ch; else l-=ch;} let ag=g/p, al=l/p; o[p]=al===0?100:100-100/(1+ag/al); for (let i=p+1;i<c.length;i++){const ch=c[i]-c[i-1]; ag=(ag*(p-1)+Math.max(ch,0))/p; al=(al*(p-1)+Math.max(-ch,0))/p; o[i]=al===0?100:100-100/(1+ag/al);} return o; }
function calcATR(c: Candle[], p: number): (number|null)[] { const o: (number|null)[] = new Array(c.length).fill(null); if (c.length<=p) return o; const tr: number[] = new Array(c.length).fill(0); for (let i=1;i<c.length;i++) tr[i]=Math.max(c[i].high-c[i].low, Math.abs(c[i].high-c[i-1].close), Math.abs(c[i].low-c[i-1].close)); let s=0; for (let i=1;i<=p;i++) s+=tr[i]; o[p]=s/p; for (let i=p+1;i<c.length;i++) o[i]=(o[i-1]!*(p-1)+tr[i])/p; return o; }
function calcMACDHist(c: number[]): (number|null)[] { const e12=calcEMA(c,12), e26=calcEMA(c,26); const macd: (number|null)[] = c.map((_,i) => (e12[i]!=null && e26[i]!=null) ? e12[i]!-e26[i]! : null); const v: number[]=[], m: number[]=[]; for (let i=0;i<macd.length;i++) if (macd[i]!==null){v.push(macd[i]!); m.push(i);} const sigEma = calcEMA(v, 9); const signal: (number|null)[] = new Array(c.length).fill(null); for (let k=0;k<sigEma.length;k++) if (sigEma[k]!==null) signal[m[k]] = sigEma[k]; return c.map((_,i) => (macd[i]!=null && signal[i]!=null) ? macd[i]!-signal[i]! : null); }
function findIdx(arr: { time: number }[], t: number): number { let lo=0, hi=arr.length-1, ans=-1; while (lo<=hi){const m=(lo+hi)>>1; if (arr[m].time<=t){ans=m; lo=m+1;} else hi=m-1;} return ans; }

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

interface Setup {
  name: string;
  slPct: number;             // 0 = no SL
  maxPositions: number;       // 0 = unlimited
  asymmShort: boolean;        // SHORT 0.3x in bull
  equitySize: boolean;        // size = 1% of equity
  hardEqStopPct: number;      // close all + permanent stop nếu DD > X%
}

function run(setup: Setup, c5: Candle[], feats: FeatBar[], c1d: Candle[], ma200_1d: (number|null)[]) {
  let longPos: Pos[] = [];
  let shortPos: Pos[] = [];
  let wallet = INITIAL_CAPITAL;
  let totalFees=0, totalRealizedPnl=0, totalAddsL=0, totalAddsS=0, totalCloses=0;
  let win=0, loss=0, lastL=0, lastS=0;
  let liq=false, liqMs=0, peak=INITIAL_CAPITAL, trough=INITIAL_CAPITAL;
  let permanentStop = false;

  function closePos(side: "LONG"|"SHORT", posIdx: number, price: number, ts: number){
    const p = side==="LONG" ? longPos[posIdx] : shortPos[posIdx];
    const realized = side==="LONG" ? p.qty*(price-p.entry) : p.qty*(p.entry-price);
    const fee = p.qty*price*(FEE_PER_SIDE_PCT/100);
    const np = realized-fee;
    wallet += np; totalRealizedPnl += realized; totalFees += fee; totalCloses++;
    if (np>=0) win++; else loss++;
    if (side==="LONG") longPos.splice(posIdx,1); else shortPos.splice(posIdx,1);
  }
  function closeAll(price: number, ts: number){
    while (longPos.length>0) closePos("LONG", 0, price, ts);
    while (shortPos.length>0) closePos("SHORT", 0, price, ts);
  }

  // Entry events
  const entryByTs = new Map<number, { side: "LONG"|"SHORT"; price: number }[]>();
  for (const f of feats){
    if (f.longScore>=MIN_SCORE){const a=entryByTs.get(f.ts)||[]; a.push({side:"LONG", price:f.close}); entryByTs.set(f.ts,a);}
    if (f.shortScore>=MIN_SCORE){const a=entryByTs.get(f.ts)||[]; a.push({side:"SHORT", price:f.close}); entryByTs.set(f.ts,a);}
  }

  for (let i=0;i<c5.length;i++){
    const bar = c5[i]; const price = bar.close; const ts = bar.time;
    if (permanentStop) continue;

    // Check TP/SL/time-stop per position
    for (let pi=longPos.length-1; pi>=0; pi--){
      const p = longPos[pi];
      const gain = (price-p.entry)/p.entry*100;
      if (gain >= TP_PCT) closePos("LONG", pi, price, ts);
      else if (setup.slPct>0 && gain <= -setup.slPct) closePos("LONG", pi, price, ts);
      else if (ts-p.openMs >= TIME_STOP_MS) closePos("LONG", pi, price, ts);
    }
    for (let pi=shortPos.length-1; pi>=0; pi--){
      const p = shortPos[pi];
      const drop = (p.entry-price)/p.entry*100;
      if (drop >= TP_PCT) closePos("SHORT", pi, price, ts);
      else if (setup.slPct>0 && drop <= -setup.slPct) closePos("SHORT", pi, price, ts);
      else if (ts-p.openMs >= TIME_STOP_MS) closePos("SHORT", pi, price, ts);
    }

    // Stats + DD check (BEFORE entry)
    let upnl = 0;
    for (const p of longPos) upnl += p.qty*(price-p.entry);
    for (const p of shortPos) upnl += p.qty*(p.entry-price);
    const eq = wallet+upnl;
    if (eq>peak) peak=eq; if (eq<trough) trough=eq;
    if (setup.hardEqStopPct>0 && peak>0){
      const ddPct = (peak-eq)/peak*100;
      if (ddPct >= setup.hardEqStopPct){
        closeAll(price, ts);
        permanentStop = true;
        continue;
      }
    }

    // ENTRY
    const evs = entryByTs.get(ts);
    if (evs) for (const e of evs){
      const cool = e.side==="LONG" ? ts-lastL>=COOLDOWN_MS : ts-lastS>=COOLDOWN_MS;
      if (!cool) continue;
      const side = e.side;
      // Cap max positions per side
      if (setup.maxPositions>0){
        const currentSide = side==="LONG" ? longPos.length : shortPos.length;
        if (currentSide >= setup.maxPositions) continue;
      }
      // Determine notional
      let notional = setup.equitySize ? eq * 0.01 : NOTIONAL_BASE;
      if (notional<=0) continue;
      // Asymmetric size SHORT in bull
      if (setup.asymmShort && side==="SHORT"){
        const idx = findIdx(c1d, ts);
        if (idx>=200){
          const ma = ma200_1d[idx-1]; if (ma!==null){
            const trendUp = c1d[idx-1].close>ma;
            if (trendUp) notional *= 0.3;
          }
        }
      }
      const qty = notional / e.price;
      const fee = notional * (FEE_PER_SIDE_PCT/100);
      if (side==="LONG"){longPos.push({qty, entry:e.price, openMs:ts}); totalAddsL++; lastL=ts;}
      else {shortPos.push({qty, entry:e.price, openMs:ts}); totalAddsS++; lastS=ts;}
      wallet -= fee; totalFees += fee;
    }

    // LIQ check
    let totQty = 0; for (const p of longPos) totQty+=p.qty; for (const p of shortPos) totQty+=p.qty;
    if (totQty>0){
      const mm = totQty*price*MAINT_MARGIN_RATE;
      if (eq<=mm){liq=true; liqMs=ts; break;}
    }
  }
  const lastPrice = c5[c5.length-1].close;
  let upL=0, upS=0;
  for (const p of longPos) upL += p.qty*(lastPrice-p.entry);
  for (const p of shortPos) upS += p.qty*(p.entry-lastPrice);
  const finalUpnl = upL+upS;
  const finalEq = wallet+finalUpnl;
  const roi = ((finalEq-INITIAL_CAPITAL)/INITIAL_CAPITAL)*100;
  let qtyL=0, qtyS=0; for (const p of longPos) qtyL+=p.qty; for (const p of shortPos) qtyS+=p.qty;
  return {
    name: setup.name,
    liquidated:liq, liqAtMs:liqMs, permanentStop,
    totalAddsLong: totalAddsL, totalAddsShort: totalAddsS, totalCloses,
    totalRealizedPnl, totalFees,
    finalLongQty: qtyL, finalShortQty: qtyS,
    finalUpnl, finalEq, wallet, roi,
    maxDD:peak-trough, peak, trough,
    winCount: win, lossCount: loss,
    openPositions: longPos.length + shortPos.length,
  };
}

function main(){
  console.log("[dd-fix] Loading...");
  const c5 = loadCache("5m"); const c1h = loadCache("1h"); const c1d = loadCache("1d");
  const feats = buildFeatures(c1h);
  const ma200 = calcSMA(c1d.map(b=>b.close), 200);

  const setups: Setup[] = [
    {name:"1. Baseline (winner ref)",        slPct:0,  maxPositions:0,  asymmShort:false, equitySize:false, hardEqStopPct:30},
    {name:"2. + SL 5%",                       slPct:5,  maxPositions:0,  asymmShort:false, equitySize:false, hardEqStopPct:30},
    {name:"3. + Cap 50/side",                 slPct:0,  maxPositions:50, asymmShort:false, equitySize:false, hardEqStopPct:30},
    {name:"4. SL5% + Cap50",                  slPct:5,  maxPositions:50, asymmShort:false, equitySize:false, hardEqStopPct:30},
    {name:"5. Asymmetric SHORT 0.3x bull",    slPct:0,  maxPositions:0,  asymmShort:true,  equitySize:false, hardEqStopPct:30},
    {name:"6. Equity-based size 1%",          slPct:0,  maxPositions:0,  asymmShort:false, equitySize:true,  hardEqStopPct:30},
    {name:"7. Hard EQ stop -30% perm",        slPct:0,  maxPositions:0,  asymmShort:false, equitySize:false, hardEqStopPct:30},  // Same as baseline since baseline already has DD30
    {name:"8. ALL combined",                  slPct:5,  maxPositions:50, asymmShort:true,  equitySize:true,  hardEqStopPct:30},
  ];

  // For setup 7 to differ from baseline, change permanent flag — actually baseline DD30 in original sweep was pause not permanent. Here we use permanent stop. So baseline gets pause-equivalent (effectively same as no DD if peak resets).
  // Already implemented as permanent. Setup 1 = setup 7 essentially — let's adjust setup 1 to NO DD stop:
  setups[0] = {name:"1. Baseline NO DD stop",  slPct:0,  maxPositions:0,  asymmShort:false, equitySize:false, hardEqStopPct:0};

  const results: any[] = [];
  for (const su of setups){
    const r = run(su, c5, feats, c1d, ma200);
    results.push(r);
    const wr = r.winCount+r.lossCount;
    console.log(`\n[${su.name}]\n  ROI ${r.roi.toFixed(2)}% · ADD L${r.totalAddsLong}/S${r.totalAddsShort} · CL ${r.totalCloses} · WR ${wr>0?(r.winCount/wr*100).toFixed(0)+"%":"—"} · Realized $${r.totalRealizedPnl.toFixed(0)} · uPnL ${r.finalUpnl>=0?"+":""}$${r.finalUpnl.toFixed(0)} · DD $${r.maxDD.toFixed(0)} (${(r.maxDD/r.peak*100).toFixed(0)}% of peak) · LIQ ${r.liquidated} · Stop ${r.permanentStop}`);
  }
  console.log("\n=== SORTED BY ROI / DD ratio (bigger = better risk-adjusted) ===");
  const ranked = results.map(r => ({...r, ratio: r.maxDD>0 ? r.roi*1000/r.maxDD : (r.roi>=0?Infinity:-Infinity)}));
  ranked.sort((a,b)=> b.ratio - a.ratio);
  console.log("Setup                                    ROI%      DD$       DD%peak  Ratio   Realized      EQUITY     Trades  CLOSES  WR%   LIQ");
  for (const r of ranked){
    const wr = r.winCount+r.lossCount;
    console.log(`${r.name.padEnd(42)}${r.roi.toFixed(2).padStart(7)}%  $${r.maxDD.toFixed(0).padStart(7)}  ${(r.maxDD/r.peak*100).toFixed(0).padStart(6)}%  ${r.ratio.toFixed(2).padStart(6)}  ${('$'+r.totalRealizedPnl.toFixed(0)).padStart(11)}  ${('$'+r.finalEq.toFixed(0)).padStart(10)}  ${(r.totalAddsLong+r.totalAddsShort).toString().padStart(6)}  ${r.totalCloses.toString().padStart(6)}  ${wr>0?(r.winCount/wr*100).toFixed(0).padStart(4):"  —"}  ${r.liquidated?"YES":"NO"}`);
  }

  writeFileSync(join(__dirname,"..","assets","backtest_hedge04_dd_fix_3y.json"), JSON.stringify({
    initialCapital: INITIAL_CAPITAL, results,
  }));
  console.log("\nSaved → assets/backtest_hedge04_dd_fix_3y.json");
}
main();
