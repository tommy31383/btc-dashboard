/**
 * backtest-hedge01-denoise.ts (anh Tommy 2026-05-04)
 * Review Hedge01 (TREND FOLLOW MULTI-TF) + thêm khử nhiễu + SL3/TP8.
 *
 * Hedge01 base: weekly trend + S/R touch (1d/4h/1h/15m) → ADD
 * Noise filters tested:
 *   F1. Cooldown 4h (thay 1h) — giảm spam
 *   F2. TOUCH_PCT 0.2 (thay 0.4) — yêu cầu CỰC GẦN S/R
 *   F3. bbWidth ≥ 3% (avoid quiet market)
 *   F4. Multi-feature score ≥ 5/9 (overlap với Hedge04 profile)
 *   F5. RSI confluence (LONG khi RSI<40, SHORT khi RSI>60)
 *
 * 8 setups:
 *   A. baseline + SL3/TP8
 *   B. F1 (cd4h)
 *   C. F2 (touch 0.2)
 *   D. F3 (bbW≥3)
 *   E. F4 (score≥5)
 *   F. F5 (RSI conf)
 *   G. F1+F3 (cd4h + bbW)
 *   H. ALL filters
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const INITIAL_CAPITAL = 100000;
const NOTIONAL = 1000;
const FEE_PER_SIDE_PCT = 0.05;
const MAINT_MARGIN_RATE = 0.004;
const MAX_CONCURRENT = 10;
const PIVOT_N = 10;
const SL_PCT = 3;
const TP_PCT = 8;
const FORWARD_CAP_BARS_5M = 96 * 24 * 7; // 7d trong 5m bars

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
function findIdx(arr: { time: number }[], t: number): number { let lo=0, hi=arr.length-1, ans=-1; while (lo<=hi){const m=(lo+hi)>>1; if (arr[m].time<=t){ans=m; lo=m+1;} else hi=m-1;} return ans; }
function getWeeklyTrend(c1w: Candle[], t: number): "UP"|"DOWN"|null { const idx = findIdx(c1w, t); if (idx<2) return null; return c1w[idx-1].close > c1w[idx-2].close ? "UP" : "DOWN"; }
function detectSwingLevels(c: Candle[], n: number) { const lows: number[]=[], highs: number[]=[]; for (let i=n;i<c.length-n;i++){let isLo=true, isHi=true; for (let j=i-n;j<=i+n;j++){if (j===i) continue; if (c[j].low<=c[i].low) isLo=false; if (c[j].high>=c[i].high) isHi=false;} if (isLo) lows.push(c[i].low); if (isHi) highs.push(c[i].high);} return {lows:lows.sort((a,b)=>a-b), highs:highs.sort((a,b)=>a-b)}; }
function nearLevel(price: number, levels: number[], tolPct: number): boolean { const tol = price*tolPct/100; for (const lv of levels) if (Math.abs(lv-price)<=tol) return true; return false; }

interface Setup {
  name: string;
  cooldownMs: number;
  touchPct: number;
  bbWidthMin: number;
  scoreMin: number;     // 0 = no score filter
  rsiConfluence: boolean;
}

interface Sig { ts: number; side: "LONG"|"SHORT"; price: number; }

function buildSignals(c5: Candle[], c15: Candle[], c1h: Candle[], c4h: Candle[], c1d: Candle[], c1w: Candle[], setup: Setup): Sig[] {
  const sr15 = detectSwingLevels(c15, PIVOT_N);
  const sr1h = detectSwingLevels(c1h, PIVOT_N);
  const sr4h = detectSwingLevels(c4h, PIVOT_N);
  const sr1d = detectSwingLevels(c1d, PIVOT_N);
  const supports = [...sr15.lows, ...sr1h.lows, ...sr4h.lows, ...sr1d.lows];
  const resistances = [...sr15.highs, ...sr1h.highs, ...sr4h.highs, ...sr1d.highs];

  // Pre-compute indicators on 15m for noise filter
  const closes15 = c15.map(b=>b.close);
  const rsi15 = calcRSI(closes15, 14);
  const stochK15 = calcStochK(c15, 14);
  const macdH15 = calcMACDHist(closes15);
  const ma50_15 = calcSMA(closes15, 50);
  const ma20_15 = calcSMA(closes15, 20);
  const sd20_15 = calcStdev(closes15, 20, ma20_15);
  const atr14_15 = calcATR(c15, 14);
  const vols15 = c15.map(b=>b.volume??0);
  const volMA15 = calcSMA(vols15, 20);

  function filtersPass(side: "LONG"|"SHORT", c5t: number): boolean {
    const idx15 = findIdx(c15, c5t);
    if (idx15 < 20) return false;
    const b = c15[idx15];
    const ma=ma20_15[idx15], sd=sd20_15[idx15];
    const bbWidth = (ma!==null && sd!==null && ma>0) ? (4*sd)/ma*100 : 0;
    if (setup.bbWidthMin>0 && bbWidth<setup.bbWidthMin) return false;

    if (setup.scoreMin>0) {
      const dnW = (Math.min(b.open,b.close)-b.low)/b.open*100;
      const upW = (b.high-Math.max(b.open,b.close))/b.open*100;
      const body = Math.abs(b.close-b.open)/b.open*100;
      const isBull = b.close>b.open ? 1 : 0;
      const volR = volMA15[idx15] && volMA15[idx15]!>0 ? (b.volume??0)/volMA15[idx15]! : 0;
      const bbPos = (ma!==null && sd!==null && sd>0) ? (b.close-(ma-2*sd))/(4*sd)*100 : 50;
      const mom5 = idx15>=5 ? (b.close-c15[idx15-5].close)/c15[idx15-5].close*100 : 0;
      const mom10 = idx15>=10 ? (b.close-c15[idx15-10].close)/c15[idx15-10].close*100 : 0;
      const mom20 = idx15>=20 ? (b.close-c15[idx15-20].close)/c15[idx15-20].close*100 : 0;
      const atr = atr14_15[idx15]; const range = b.high-b.low;
      const atrR = atr && atr>0 ? range/atr : 0;
      const distMA50 = ma50_15[idx15] && ma50_15[idx15]!>0 ? (b.close-ma50_15[idx15]!)/ma50_15[idx15]!*100 : 0;
      const r = rsi15[idx15] ?? 50;
      const sk = stochK15[idx15] ?? 50;
      const mh = macdH15[idx15] ?? 0;
      let lS=0, sS=0;
      if (dnW>=0.5) lS++; if (body>=0.5) lS++; if (isBull===0) lS++; if (volR>=2.0) lS++; if (atrR>=1.5) lS++; if (r<=35) lS++; if (sk<=30) lS++; if (mh<=-100) lS++; if (bbPos<=5) lS++; if (distMA50<=-3) lS++; if (mom5<0&&mom10<0&&mom20<0) lS++;
      if (upW>=0.5) sS++; if (body>=0.5) sS++; if (isBull===1) sS++; if (volR>=2.0) sS++; if (atrR>=1.5) sS++; if (r>=65) sS++; if (sk>=70) sS++; if (mh>=100) sS++; if (bbPos>=95) sS++; if (distMA50>=3) sS++; if (mom5>0&&mom10>0&&mom20>0) sS++;
      if (side==="LONG" && lS<setup.scoreMin) return false;
      if (side==="SHORT" && sS<setup.scoreMin) return false;
    }

    if (setup.rsiConfluence) {
      const r = rsi15[idx15] ?? 50;
      if (side==="LONG" && r>=40) return false;
      if (side==="SHORT" && r<=60) return false;
    }
    return true;
  }

  const sigs: Sig[] = [];
  let lastL = 0, lastS = 0;
  for (let i=100;i<c5.length;i++){
    const bar = c5[i]; const price = bar.close; const ts = bar.time;
    const trend = getWeeklyTrend(c1w, ts);
    if (!trend) continue;
    if (trend==="UP") {
      if (ts-lastL >= setup.cooldownMs && nearLevel(price, supports, setup.touchPct)) {
        if (filtersPass("LONG", ts)) {
          sigs.push({ts, side:"LONG", price});
          lastL = ts;
        }
      }
    } else {
      if (ts-lastS >= setup.cooldownMs && nearLevel(price, resistances, setup.touchPct)) {
        if (filtersPass("SHORT", ts)) {
          sigs.push({ts, side:"SHORT", price});
          lastS = ts;
        }
      }
    }
  }
  return sigs;
}

function run(setup: Setup, c5: Candle[], c15: Candle[], c1h: Candle[], c4h: Candle[], c1d: Candle[], c1w: Candle[]) {
  const sigs = buildSignals(c5, c15, c1h, c4h, c1d, c1w, setup);
  const sigByTs = new Map<number, Sig[]>();
  for (const s of sigs){const a=sigByTs.get(s.ts)||[]; a.push(s); sigByTs.set(s.ts,a);}

  let positions: Pos[] = [];
  let wallet = INITIAL_CAPITAL;
  let totalFees=0, totalRealizedPnl=0, totalAddsL=0, totalAddsS=0, totalCloses=0;
  let win=0, loss=0;
  let liq=false, liqMs=0, peak=INITIAL_CAPITAL, trough=INITIAL_CAPITAL;
  let slHits=0, tpHits=0, timeStops=0;

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
    for (let pi=positions.length-1; pi>=0; pi--){
      const p = positions[pi];
      if (p.side==="LONG"){
        if (bar.low <= p.sl) {closePos(pi, p.sl, ts, "SL"); continue;}
        if (bar.high >= p.tp) {closePos(pi, p.tp, ts, "TP"); continue;}
      } else {
        if (bar.high >= p.sl) {closePos(pi, p.sl, ts, "SL"); continue;}
        if (bar.low <= p.tp) {closePos(pi, p.tp, ts, "TP"); continue;}
      }
      if (ts - p.openMs >= FORWARD_CAP_BARS_5M*5*60_000) {closePos(pi, price, ts, "time"); continue;}
    }
    const evs = sigByTs.get(ts);
    if (evs) for (const e of evs){
      const sideOpen = positions.filter(p=>p.side===e.side).length;
      if (sideOpen >= MAX_CONCURRENT) continue;
      const qty = NOTIONAL / e.price;
      const fee = NOTIONAL * (FEE_PER_SIDE_PCT/100);
      const sl = e.side==="LONG" ? e.price*(1-SL_PCT/100) : e.price*(1+SL_PCT/100);
      const tp = e.side==="LONG" ? e.price*(1+TP_PCT/100) : e.price*(1-TP_PCT/100);
      positions.push({side:e.side, qty, entry:e.price, openMs:ts, sl, tp});
      wallet -= fee; totalFees += fee;
      if (e.side==="LONG") totalAddsL++; else totalAddsS++;
    }
    let upnl=0;
    for (const p of positions) upnl += (p.side==="LONG"?p.qty*(price-p.entry):p.qty*(p.entry-price));
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
    name: setup.name, sigs: sigs.length,
    liquidated:liq, liqAtMs:liqMs,
    totalAddsLong: totalAddsL, totalAddsShort: totalAddsS, totalCloses,
    totalRealizedPnl, totalFees, finalUpnl: upnl, finalEq, wallet, roi,
    maxDD:peak-trough, peak, trough, winCount:win, lossCount:loss,
    slHits, tpHits, timeStops,
  };
}

function main(){
  console.log("[h01-denoise] Loading...");
  const c5=loadCache("5m"); const c15=loadCache("15m"); const c1h=loadCache("1h"); const c4h=loadCache("4h"); const c1d=loadCache("1d"); const c1w=loadCache("1w");

  const setups: Setup[] = [
    {name:"A. Baseline (cd1h, touch0.4)",     cooldownMs:60*60_000,    touchPct:0.4, bbWidthMin:0, scoreMin:0, rsiConfluence:false},
    {name:"B. F1 cd4h",                        cooldownMs:4*60*60_000,  touchPct:0.4, bbWidthMin:0, scoreMin:0, rsiConfluence:false},
    {name:"C. F2 touch 0.2 (cực gần S/R)",    cooldownMs:60*60_000,    touchPct:0.2, bbWidthMin:0, scoreMin:0, rsiConfluence:false},
    {name:"D. F3 bbW≥3%",                     cooldownMs:60*60_000,    touchPct:0.4, bbWidthMin:3, scoreMin:0, rsiConfluence:false},
    {name:"E. F4 score≥5/9 (15m)",            cooldownMs:60*60_000,    touchPct:0.4, bbWidthMin:0, scoreMin:5, rsiConfluence:false},
    {name:"F. F5 RSI conf (L<40, S>60)",      cooldownMs:60*60_000,    touchPct:0.4, bbWidthMin:0, scoreMin:0, rsiConfluence:true},
    {name:"G. F1+F3 cd4h+bbW",                cooldownMs:4*60*60_000,  touchPct:0.4, bbWidthMin:3, scoreMin:0, rsiConfluence:false},
    {name:"H. ALL filters",                    cooldownMs:4*60*60_000,  touchPct:0.2, bbWidthMin:3, scoreMin:5, rsiConfluence:true},
  ];
  const results: any[] = [];
  for (const su of setups){
    const r = run(su, c5, c15, c1h, c4h, c1d, c1w);
    results.push(r);
    const wr = r.winCount+r.lossCount;
    console.log(`\n[${su.name}]`);
    console.log(`  signals=${r.sigs} · ROI ${r.roi.toFixed(2)}% · L${r.totalAddsLong}/S${r.totalAddsShort} · CL ${r.totalCloses} (TP${r.tpHits}/SL${r.slHits}/T${r.timeStops}) · WR ${wr>0?(r.winCount/wr*100).toFixed(0)+"%":"-"} · Realized $${r.totalRealizedPnl.toFixed(0)} · DD $${r.maxDD.toFixed(0)} · LIQ ${r.liquidated}`);
  }
  console.log("\n=== SORTED BY ROI ===");
  results.sort((a,b)=>b.roi-a.roi);
  console.log("Setup                                    Signals  ROI%      Realized   TP   SL  T   WR%   DD$       LIQ");
  for (const r of results){
    const wr = r.winCount+r.lossCount;
    console.log(`${r.name.padEnd(40)}${r.sigs.toString().padStart(7)}  ${r.roi.toFixed(2).padStart(7)}% ${('$'+r.totalRealizedPnl.toFixed(0)).padStart(10)}  ${r.tpHits.toString().padStart(3)}  ${r.slHits.toString().padStart(3)}  ${r.timeStops.toString().padStart(3)}  ${wr>0?(r.winCount/wr*100).toFixed(0).padStart(4):"  —"}  $${r.maxDD.toFixed(0).padStart(7)}  ${r.liquidated?"YES":"NO"}`);
  }

  writeFileSync(join(__dirname,"..","assets","backtest_hedge01_denoise_3y.json"), JSON.stringify({
    config:{slPct:SL_PCT, tpPct:TP_PCT, capital:INITIAL_CAPITAL, notional:NOTIONAL},
    results,
  }));
  console.log("\nSaved → assets/backtest_hedge01_denoise_3y.json");
}
main();
