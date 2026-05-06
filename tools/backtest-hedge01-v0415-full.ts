/**
 * backtest-hedge01-v0415-full.ts (anh Tommy 2026-05-04)
 * Backtest đầy đủ Hedge01 v0.4.15 PRODUCTION:
 *   - Score profile 11 features 15m + GOM 8 setups
 *   - DeepDip booster 5m (3 conditions)
 *   - TP 10% từ avg → CLOSE ALL
 *   - Cooldown 1h same side
 * Mục tiêu: detect issues, edge cases, anomalies.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const INITIAL_CAPITAL = 100000;
const FEE_PER_SIDE_PCT = 0.05;
const MAINT_MARGIN_RATE = 0.004;
const COOLDOWN_MS = 60*60_000;
const TP_PCT = 10;
const MIN_SCORE = 9;
const DEEPDIP_QTY_BOOST = 0.05;

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }
interface Net { qty: number; avg: number; }
interface Event { ts: number; kind: "ADD"|"CLOSE"; side: "LONG"|"SHORT"; price: number; qty: number; avgAfter: number; realizedPnl?: number; score?: number; isDeepDip?: boolean; barsInPos?: number; }

function loadCache(tf: string): Candle[] { return JSON.parse(readFileSync(join(__dirname,"..",".cache",`binance-${tf}-3y.json`),"utf8")); }
function calcSMA(a: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); if (a.length<p) return o; let s=0; for (let i=0;i<p;i++) s+=a[i]; o[p-1]=s/p; for (let i=p;i<a.length;i++){s+=a[i]-a[i-p]; o[i]=s/p;} return o; }
function calcEMA(a: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); if (a.length<p) return o; const k=2/(p+1); let e=0; for (let i=0;i<p;i++) e+=a[i]; e/=p; o[p-1]=e; for (let i=p;i<a.length;i++){e=a[i]*k+e*(1-k); o[i]=e;} return o; }
function calcStdev(a: number[], p: number, sma: (number|null)[]): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); for (let i=p-1;i<a.length;i++){const m=sma[i]; if (m===null) continue; let sq=0; for (let j=i-p+1;j<=i;j++) sq+=(a[j]-m)**2; o[i]=Math.sqrt(sq/p);} return o; }
function calcRSI(c: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(c.length).fill(null); if (c.length<=p) return o; let g=0,l=0; for (let i=1;i<=p;i++){const ch=c[i]-c[i-1]; if (ch>=0) g+=ch; else l-=ch;} let ag=g/p, al=l/p; o[p]=al===0?100:100-100/(1+ag/al); for (let i=p+1;i<c.length;i++){const ch=c[i]-c[i-1]; ag=(ag*(p-1)+Math.max(ch,0))/p; al=(al*(p-1)+Math.max(-ch,0))/p; o[i]=al===0?100:100-100/(1+ag/al);} return o; }
function calcStochK(c: Candle[], p: number): (number|null)[] { const o: (number|null)[] = new Array(c.length).fill(null); for (let i=p-1;i<c.length;i++){let hi=-Infinity, lo=Infinity; for (let j=i-p+1;j<=i;j++){if (c[j].high>hi) hi=c[j].high; if (c[j].low<lo) lo=c[j].low;} o[i]=hi===lo?50:((c[i].close-lo)/(hi-lo))*100;} return o; }
function calcATR(c: Candle[], p: number): (number|null)[] { const o: (number|null)[] = new Array(c.length).fill(null); if (c.length<=p) return o; const tr: number[] = new Array(c.length).fill(0); for (let i=1;i<c.length;i++) tr[i]=Math.max(c[i].high-c[i].low, Math.abs(c[i].high-c[i-1].close), Math.abs(c[i].low-c[i-1].close)); let s=0; for (let i=1;i<=p;i++) s+=tr[i]; o[p]=s/p; for (let i=p+1;i<c.length;i++) o[i]=(o[i-1]!*(p-1)+tr[i])/p; return o; }
function calcMACDHist(c: number[]): (number|null)[] { const e12=calcEMA(c,12), e26=calcEMA(c,26); const macd: (number|null)[] = c.map((_,i) => (e12[i]!=null && e26[i]!=null) ? e12[i]!-e26[i]! : null); const v: number[]=[], m: number[]=[]; for (let i=0;i<macd.length;i++) if (macd[i]!==null){v.push(macd[i]!); m.push(i);} const sigEma = calcEMA(v, 9); const signal: (number|null)[] = new Array(c.length).fill(null); for (let k=0;k<sigEma.length;k++) if (sigEma[k]!==null) signal[m[k]] = sigEma[k]; return c.map((_,i) => (macd[i]!=null && signal[i]!=null) ? macd[i]!-signal[i]! : null); }
function findIdx(arr: { time: number }[], t: number): number { let lo=0, hi=arr.length-1, ans=-1; while (lo<=hi){const m=(lo+hi)>>1; if (arr[m].time<=t){ans=m; lo=m+1;} else hi=m-1;} return ans; }

function aggregateQty(score: number, side: "LONG"|"SHORT"): number {
  let qty = 0;
  if (score === 11) qty += 0.001 * 3;
  if (score === 11) qty += 0.01;
  if (score >= 10) qty += 0.001;
  if (score >= 9) qty += 0.001;
  if (score >= 10) qty += 0.01;
  if (score === 11 && side === "LONG") qty += 0.001;
  return qty;
}
function isDeepDip(c5: Candle[], i: number): boolean {
  if (i < 200) return false;
  const last = c5[i].close;
  let s200=0; for (let j=i-200;j<i;j++) s200 += c5[j].close;
  const ma200 = s200/200;
  if ((last-ma200)/ma200*100 < -10) return true;
  let s50=0; for (let j=i-50;j<i;j++) s50 += c5[j].close;
  const ma50 = s50/50;
  if ((last-ma50)/ma50*100 < -5) return true;
  if (i>=60 && (last-c5[i-60].close)/c5[i-60].close*100 < -5) return true;
  return false;
}
function addNet(n: Net, q: number, p: number): Net { const nq=n.qty+q; return { qty:nq, avg: nq>0?(n.qty*n.avg+q*p)/nq:0 }; }

function main() {
  console.log("[h01-v0415-full] Loading...");
  const c5 = loadCache("5m"); const c15 = loadCache("15m");
  const closes15 = c15.map(b=>b.close);
  const rsi = calcRSI(closes15, 14); const stochK = calcStochK(c15, 14); const macdH = calcMACDHist(closes15);
  const ma50 = calcSMA(closes15, 50); const ma20 = calcSMA(closes15, 20); const sd20 = calcStdev(closes15, 20, ma20);
  const atr14 = calcATR(c15, 14); const vols = c15.map(b=>b.volume??0); const volMA = calcSMA(vols, 20);

  const signals: { ts: number; side: "LONG"|"SHORT"; price: number; score: number }[] = [];
  for (let i=20;i<c15.length;i++){
    const b = c15[i];
    const dnW = (Math.min(b.open,b.close)-b.low)/b.open*100;
    const upW = (b.high-Math.max(b.open,b.close))/b.open*100;
    const body = Math.abs(b.close-b.open)/b.open*100;
    const isBull = b.close>b.open?1:0;
    const volR = volMA[i] && volMA[i]!>0 ? (b.volume??0)/volMA[i]! : 0;
    const ma=ma20[i], sd=sd20[i];
    const bbPos = (ma!==null && sd!==null && sd>0) ? (b.close-(ma-2*sd))/(4*sd)*100 : 50;
    const mom5 = i>=5 ? (b.close-c15[i-5].close)/c15[i-5].close*100 : 0;
    const mom10 = i>=10 ? (b.close-c15[i-10].close)/c15[i-10].close*100 : 0;
    const mom20 = i>=20 ? (b.close-c15[i-20].close)/c15[i-20].close*100 : 0;
    const atr = atr14[i]; const range = b.high-b.low;
    const atrR = atr && atr>0 ? range/atr : 0;
    const distMA50 = ma50[i] && ma50[i]!>0 ? (b.close-ma50[i]!)/ma50[i]!*100 : 0;
    const r = rsi[i] ?? 50; const sk = stochK[i] ?? 50; const mh = macdH[i] ?? 0;
    let lS=0, sS=0;
    if (dnW>=0.5) lS++; if (body>=0.5) lS++; if (isBull===0) lS++; if (volR>=2.0) lS++; if (atrR>=1.5) lS++; if (r<=35) lS++; if (sk<=30) lS++; if (mh<=-100) lS++; if (bbPos<=5) lS++; if (distMA50<=-3) lS++; if (mom5<0&&mom10<0&&mom20<0) lS++;
    if (upW>=0.5) sS++; if (body>=0.5) sS++; if (isBull===1) sS++; if (volR>=2.0) sS++; if (atrR>=1.5) sS++; if (r>=65) sS++; if (sk>=70) sS++; if (mh>=100) sS++; if (bbPos>=95) sS++; if (distMA50>=3) sS++; if (mom5>0&&mom10>0&&mom20>0) sS++;
    if (lS >= MIN_SCORE) signals.push({ts:b.time, side:"LONG", price:b.close, score:lS});
    if (sS >= MIN_SCORE) signals.push({ts:b.time, side:"SHORT", price:b.close, score:sS});
  }
  const sigByTs = new Map<number, typeof signals>();
  for (const s of signals){const a=sigByTs.get(s.ts)||[]; a.push(s); sigByTs.set(s.ts,a);}

  let longNet: Net = {qty:0, avg:0}; let shortNet: Net = {qty:0, avg:0};
  let wallet = INITIAL_CAPITAL;
  let totalFees=0, totalRealized=0, totalAddsL=0, totalAddsS=0, totalCloses=0;
  let win=0, loss=0, lastL=0, lastS=0;
  let liq=false, liqMs=0, peak=INITIAL_CAPITAL, trough=INITIAL_CAPITAL;
  let deepDipFires = 0;
  let longOpenedMs = 0, shortOpenedMs = 0;
  const events: Event[] = [];
  const equityCurve: { ts: number; eq: number }[] = [];
  const positionDurations: { side: string; bars: number; pnl: number }[] = [];

  for (let i=0;i<c5.length;i++){
    const bar = c5[i]; const price = bar.close; const ts = bar.time;
    if (longNet.qty>0 && longNet.avg>0){
      const gain = (price-longNet.avg)/longNet.avg*100;
      if (gain >= TP_PCT){
        const realized = longNet.qty*(price-longNet.avg);
        const fee = longNet.qty*price*(FEE_PER_SIDE_PCT/100);
        const np = realized-fee;
        wallet += np; totalRealized += realized; totalFees += fee; totalCloses++;
        if (np>=0) win++; else loss++;
        const dur = longOpenedMs > 0 ? Math.floor((ts-longOpenedMs)/(60*60_000)) : 0;
        events.push({ts, kind:"CLOSE", side:"LONG", price, qty:longNet.qty, avgAfter:longNet.avg, realizedPnl:np, barsInPos:dur});
        positionDurations.push({side:"LONG", bars:dur, pnl:np});
        longNet = {qty:0, avg:0}; longOpenedMs = 0;
      }
    }
    if (shortNet.qty>0 && shortNet.avg>0){
      const drop = (shortNet.avg-price)/shortNet.avg*100;
      if (drop >= TP_PCT){
        const realized = shortNet.qty*(shortNet.avg-price);
        const fee = shortNet.qty*price*(FEE_PER_SIDE_PCT/100);
        const np = realized-fee;
        wallet += np; totalRealized += realized; totalFees += fee; totalCloses++;
        if (np>=0) win++; else loss++;
        const dur = shortOpenedMs > 0 ? Math.floor((ts-shortOpenedMs)/(60*60_000)) : 0;
        events.push({ts, kind:"CLOSE", side:"SHORT", price, qty:shortNet.qty, avgAfter:shortNet.avg, realizedPnl:np, barsInPos:dur});
        positionDurations.push({side:"SHORT", bars:dur, pnl:np});
        shortNet = {qty:0, avg:0}; shortOpenedMs = 0;
      }
    }
    const evs = sigByTs.get(ts);
    if (evs) for (const e of evs){
      const cool = e.side==="LONG" ? ts-lastL>=COOLDOWN_MS : ts-lastS>=COOLDOWN_MS;
      if (!cool) continue;
      let qty = aggregateQty(e.score, e.side);
      const isDD = e.side==="LONG" && isDeepDip(c5, i);
      if (isDD) { qty += DEEPDIP_QTY_BOOST; deepDipFires++; }
      if (qty <= 0) continue;
      const fee = qty*e.price*(FEE_PER_SIDE_PCT/100);
      if (e.side==="LONG"){
        if (longNet.qty===0) longOpenedMs = ts;
        longNet=addNet(longNet,qty,e.price); totalAddsL++; lastL=ts;
        events.push({ts, kind:"ADD", side:"LONG", price:e.price, qty, avgAfter:longNet.avg, score:e.score, isDeepDip:isDD});
      } else {
        if (shortNet.qty===0) shortOpenedMs = ts;
        shortNet=addNet(shortNet,qty,e.price); totalAddsS++; lastS=ts;
        events.push({ts, kind:"ADD", side:"SHORT", price:e.price, qty, avgAfter:shortNet.avg, score:e.score});
      }
      wallet -= fee; totalFees += fee;
    }
    let upnl=0;
    if (longNet.qty>0) upnl += longNet.qty*(price-longNet.avg);
    if (shortNet.qty>0) upnl += shortNet.qty*(shortNet.avg-price);
    const eq = wallet+upnl;
    if (eq>peak) peak=eq; if (eq<trough) trough=eq;
    if (i % 1000 === 0) equityCurve.push({ts, eq});
    if (longNet.qty+shortNet.qty>0){
      const totQ = longNet.qty+shortNet.qty;
      const mm = totQ*price*MAINT_MARGIN_RATE;
      if (eq<=mm){liq=true; liqMs=ts; break;}
    }
  }
  const lastPrice = c5[c5.length-1].close;
  const upL = longNet.qty>0 ? longNet.qty*(lastPrice-longNet.avg) : 0;
  const upS = shortNet.qty>0 ? shortNet.qty*(shortNet.avg-lastPrice) : 0;
  const finalUpnl = upL+upS;
  const finalEq = wallet+finalUpnl;
  const roi = ((finalEq-INITIAL_CAPITAL)/INITIAL_CAPITAL)*100;

  console.log(`\n=== HEDGE01 v0.4.15 PRODUCTION FULL BACKTEST ===`);
  console.log(`Period: ${new Date(c5[0].time).toISOString().slice(0,10)} → ${new Date(c5[c5.length-1].time).toISOString().slice(0,10)}`);
  console.log(`Capital: $${INITIAL_CAPITAL}`);
  console.log(`LIQ: ${liq?"YES @ "+new Date(liqMs).toISOString():"NO"}`);
  console.log(`ADDs: LONG ${totalAddsL}, SHORT ${totalAddsS}`);
  console.log(`CLOSES: ${totalCloses} (win ${win} / loss ${loss}, WR ${win+loss>0?(win/(win+loss)*100).toFixed(0):"-"}%)`);
  console.log(`DeepDip fires: ${deepDipFires}`);
  console.log(`Realized PnL: ${totalRealized>=0?"+":""}$${totalRealized.toFixed(0)}`);
  console.log(`Final LONG: ${longNet.qty.toFixed(4)} BTC @ $${longNet.avg.toFixed(0)} → uPnL ${upL>=0?"+":""}$${upL.toFixed(0)}`);
  console.log(`Final SHORT: ${shortNet.qty.toFixed(4)} BTC @ $${shortNet.avg.toFixed(0)} → uPnL ${upS>=0?"+":""}$${upS.toFixed(0)}`);
  console.log(`Final EQUITY: $${finalEq.toFixed(0)} · ROI ${roi.toFixed(2)}% · Max DD $${(peak-trough).toFixed(0)}`);
  console.log(`Fees total: $${totalFees.toFixed(0)}`);

  // ISSUE DETECTION
  console.log(`\n=== 🔍 ISSUE DETECTION ===`);

  // 1. Position duration distribution
  const longDurs = positionDurations.filter(p=>p.side==="LONG").map(p=>p.bars).sort((a,b)=>a-b);
  const shortDurs = positionDurations.filter(p=>p.side==="SHORT").map(p=>p.bars).sort((a,b)=>a-b);
  if (longDurs.length>0) {
    const med = longDurs[Math.floor(longDurs.length/2)];
    const max = longDurs[longDurs.length-1];
    console.log(`LONG positions duration (giờ): median ${med}h, max ${max}h (${(max/24).toFixed(1)} ngày)`);
    if (max > 30*24) console.log(`  ⚠️ LONG max ${(max/24).toFixed(0)} ngày — quá lâu, có thể stuck`);
  }
  if (shortDurs.length>0) {
    const med = shortDurs[Math.floor(shortDurs.length/2)];
    const max = shortDurs[shortDurs.length-1];
    console.log(`SHORT positions duration (giờ): median ${med}h, max ${max}h (${(max/24).toFixed(1)} ngày)`);
    if (max > 30*24) console.log(`  ⚠️ SHORT max ${(max/24).toFixed(0)} ngày — quá lâu`);
  }

  // 2. Stuck final position
  if (longNet.qty > 0) {
    const stuckHours = longOpenedMs > 0 ? Math.floor((c5[c5.length-1].time - longOpenedMs)/(60*60_000)) : 0;
    console.log(`⚠️ Final LONG position STUCK ${stuckHours}h (${(stuckHours/24).toFixed(1)} ngày) chưa close TP. Avg $${longNet.avg.toFixed(0)} vs current $${lastPrice.toFixed(0)} = ${((lastPrice-longNet.avg)/longNet.avg*100).toFixed(2)}%`);
  }
  if (shortNet.qty > 0) {
    const stuckHours = shortOpenedMs > 0 ? Math.floor((c5[c5.length-1].time - shortOpenedMs)/(60*60_000)) : 0;
    console.log(`⚠️ Final SHORT position STUCK ${stuckHours}h (${(stuckHours/24).toFixed(1)} ngày) chưa close TP. Avg $${shortNet.avg.toFixed(0)} vs current $${lastPrice.toFixed(0)} = ${((shortNet.avg-lastPrice)/shortNet.avg*100).toFixed(2)}%`);
  }

  // 3. DeepDip distribution
  const ddEvents = events.filter(e=>e.kind==="ADD" && e.isDeepDip);
  console.log(`\nDeepDip ADDs: ${ddEvents.length}/${totalAddsL+totalAddsS}`);
  if (ddEvents.length > 0) {
    const ddDates = ddEvents.map(e=>new Date(e.ts).toISOString().slice(0,10));
    const uniqueDates = [...new Set(ddDates)].slice(0, 10);
    console.log(`First 10 DeepDip dates: ${uniqueDates.slice(0,5).join(", ")}, ...`);
  }

  // 4. Largest losing/winning trade
  const closes = events.filter(e=>e.kind==="CLOSE") as any[];
  closes.sort((a,b)=>(a.realizedPnl||0)-(b.realizedPnl||0));
  if (closes.length>0) {
    console.log(`\nWorst trade: ${new Date(closes[0].ts).toISOString().slice(0,10)} ${closes[0].side} qty ${closes[0].qty.toFixed(3)} → PnL $${closes[0].realizedPnl?.toFixed(0)}`);
    console.log(`Best trade:  ${new Date(closes[closes.length-1].ts).toISOString().slice(0,10)} ${closes[closes.length-1].side} qty ${closes[closes.length-1].qty.toFixed(3)} → PnL $${closes[closes.length-1].realizedPnl?.toFixed(0)}`);
  }

  // 5. Score breakdown
  const adds = events.filter(e=>e.kind==="ADD") as any[];
  const scoreHist: Record<string, number> = {};
  for (const a of adds) {
    const k = `${a.side[0]}${a.score}`;
    scoreHist[k] = (scoreHist[k]||0)+1;
  }
  console.log(`\nScore breakdown ADDs: ${JSON.stringify(scoreHist)}`);

  // 6. DD as % peak
  const ddPct = peak > 0 ? (peak-trough)/peak*100 : 0;
  console.log(`\nMax DD: $${(peak-trough).toFixed(0)} = ${ddPct.toFixed(1)}% peak ($${peak.toFixed(0)})`);
  if (ddPct > 30) console.log(`  ⚠️ DD > 30% peak — psychology risk`);
  else console.log(`  ✅ DD ${ddPct.toFixed(1)}% — chấp nhận được`);

  // 7. Equity curve sanity
  const eqCurveValues = equityCurve.map(p=>p.eq);
  if (eqCurveValues.length > 0) {
    const minEq = Math.min(...eqCurveValues);
    const maxEq = Math.max(...eqCurveValues);
    console.log(`Equity range: $${minEq.toFixed(0)} → $${maxEq.toFixed(0)}`);
    if (minEq < INITIAL_CAPITAL * 0.5) console.log(`  ⚠️ Equity dropped below 50% capital lúc nào đó`);
  }

  console.log(`\n=== CONCLUSION ===`);
  if (!liq && roi > 0 && ddPct < 30) console.log(`✅ NO ISSUE — strategy ổn`);
  else {
    if (liq) console.log(`❌ LIQ HIT — KHÔNG OK production`);
    if (roi <= 0) console.log(`❌ ROI âm — KHÔNG OK`);
    if (ddPct >= 30) console.log(`⚠️ DD ${ddPct.toFixed(0)}% — risk cao, cân nhắc giảm size`);
  }

  writeFileSync(join(__dirname,"..","assets","backtest_hedge01_v0415.json"), JSON.stringify({
    period:{start:c5[0].time, end:c5[c5.length-1].time},
    config:{minScore:MIN_SCORE, tpPct:TP_PCT, deepDipQtyBoost:DEEPDIP_QTY_BOOST, capital:INITIAL_CAPITAL},
    liquidated:liq, liqAtMs:liqMs,
    totalAddsLong:totalAddsL, totalAddsShort:totalAddsS, totalCloses,
    winCount:win, lossCount:loss, deepDipFires,
    totalRealized, totalFees,
    finalLong:longNet, finalShort:shortNet, lastPrice,
    finalUpnl, finalEq, wallet, roi, maxDD:peak-trough, peak, trough,
    scoreBreakdown:scoreHist,
    events: events.slice(-300),
    equityCurve,
  }));
  console.log(`\nSaved → assets/backtest_hedge01_v0415.json`);
}
main();
