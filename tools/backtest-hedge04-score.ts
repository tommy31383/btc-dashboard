/**
 * backtest-hedge04-score.ts (anh Tommy 2026-05-04)
 *
 * Hedge04 = ENTRY filter bằng MULTI-FEATURE SCORE (1H bars).
 *
 * 9 conditions LONG (đáy):
 *   1. dnWick% >= 0.5
 *   2. volRatio >= 1.5
 *   3. mom5% <= -1
 *   4. atrRatio >= 1.5
 *   5. macdH <= -50
 *   6. body% >= 0.5
 *   7. distMA50% <= -1.5
 *   8. RSI <= 40
 *   9. bbPos% <= 20
 *
 * SHORT mirror.
 *
 * 6 setup test:
 *   A. score≥4 + TP8% + 14d stop
 *   B. score≥5 + TP8% + 14d stop
 *   C. score≥4 + TP10% + 30d stop
 *   D. score≥5 + TP10% + 30d stop
 *   E. score≥6 + TP5% + 48h stop
 *   F. score≥4 NO TP (compare baseline)
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
interface Event { ts: number; kind: "ADD"|"CLOSE"; side: "LONG"|"SHORT"; price: number; qty: number; avgAfter: number; realizedPnl?: number; reason?: string; score?: number; }

function loadCache(tf: string): Candle[] { return JSON.parse(readFileSync(join(__dirname,"..",".cache",`binance-${tf}-3y.json`),"utf8")); }
function calcSMA(a: number[], p: number): (number|null)[] {
  const out: (number|null)[] = new Array(a.length).fill(null);
  if (a.length<p) return out;
  let s=0; for (let i=0;i<p;i++) s+=a[i]; out[p-1]=s/p;
  for (let i=p;i<a.length;i++){s+=a[i]-a[i-p]; out[i]=s/p;}
  return out;
}
function calcEMA(a: number[], p: number): (number|null)[] {
  const out: (number|null)[] = new Array(a.length).fill(null);
  if (a.length<p) return out;
  const k=2/(p+1);
  let e=0; for (let i=0;i<p;i++) e+=a[i]; e/=p; out[p-1]=e;
  for (let i=p;i<a.length;i++){e=a[i]*k+e*(1-k); out[i]=e;}
  return out;
}
function calcStdev(a: number[], p: number, sma: (number|null)[]): (number|null)[] {
  const out: (number|null)[] = new Array(a.length).fill(null);
  for (let i=p-1;i<a.length;i++){const m=sma[i]; if (m===null) continue; let sq=0; for (let j=i-p+1;j<=i;j++) sq+=(a[j]-m)**2; out[i]=Math.sqrt(sq/p);}
  return out;
}
function calcRSI(c: number[], p: number): (number|null)[] {
  const out: (number|null)[] = new Array(c.length).fill(null);
  if (c.length<=p) return out;
  let g=0,l=0;
  for (let i=1;i<=p;i++){const ch=c[i]-c[i-1]; if (ch>=0) g+=ch; else l-=ch;}
  let ag=g/p, al=l/p; out[p]=al===0?100:100-100/(1+ag/al);
  for (let i=p+1;i<c.length;i++){const ch=c[i]-c[i-1]; ag=(ag*(p-1)+Math.max(ch,0))/p; al=(al*(p-1)+Math.max(-ch,0))/p; out[i]=al===0?100:100-100/(1+ag/al);}
  return out;
}
function calcATR(c: Candle[], p: number): (number|null)[] {
  const out: (number|null)[] = new Array(c.length).fill(null);
  if (c.length<=p) return out;
  const tr: number[] = new Array(c.length).fill(0);
  for (let i=1;i<c.length;i++) tr[i]=Math.max(c[i].high-c[i].low, Math.abs(c[i].high-c[i-1].close), Math.abs(c[i].low-c[i-1].close));
  let s=0; for (let i=1;i<=p;i++) s+=tr[i]; out[p]=s/p;
  for (let i=p+1;i<c.length;i++) out[i]=(out[i-1]!*(p-1)+tr[i])/p;
  return out;
}
function calcMACDHist(c: number[]): (number|null)[] {
  const e12=calcEMA(c,12), e26=calcEMA(c,26);
  const macd: (number|null)[] = c.map((_,i) => (e12[i]!=null && e26[i]!=null) ? e12[i]!-e26[i]! : null);
  const valid: number[]=[], map: number[]=[];
  for (let i=0;i<macd.length;i++) if (macd[i]!==null){valid.push(macd[i]!); map.push(i);}
  const sigEma = calcEMA(valid, 9);
  const signal: (number|null)[] = new Array(c.length).fill(null);
  for (let k=0;k<sigEma.length;k++) if (sigEma[k]!==null) signal[map[k]] = sigEma[k];
  return c.map((_,i) => (macd[i]!=null && signal[i]!=null) ? macd[i]!-signal[i]! : null);
}
function addNet(n: Net, q: number, p: number, ts: number): Net {
  const nq = n.qty+q;
  return { qty: nq, avg: nq>0 ? (n.qty*n.avg+q*p)/nq : 0, openMs: n.qty===0 ? ts : n.openMs };
}

interface Setup { name: string; minScore: number; tpPct: number; timeStopMs: number; }

interface FeatBar { ts: number; open: number; high: number; low: number; close: number; longScore: number; shortScore: number; }

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
    const ma = ma20[i], sd = sd20[i];
    const bbPos = (ma!==null && sd!==null && sd>0) ? (b.close-(ma-2*sd))/((ma+2*sd)-(ma-2*sd))*100 : 50;
    const mom5 = i>=5 ? (b.close-c1h[i-5].close)/c1h[i-5].close*100 : 0;
    const atr = atr14[i]; const range = b.high-b.low;
    const atrRatio = atr && atr>0 ? range/atr : 0;
    const distMA50 = ma50[i] && ma50[i]!>0 ? (b.close-ma50[i]!)/ma50[i]!*100 : 0;
    const r = rsi[i] ?? 50;
    const mh = macdH[i] ?? 0;

    // LONG score: count bullish-reversal features
    let longScore = 0;
    if (dnWick >= 0.5) longScore++;
    if (volR >= 1.5) longScore++;
    if (mom5 <= -1) longScore++;
    if (atrRatio >= 1.5) longScore++;
    if (mh <= -50) longScore++;
    if (body >= 0.5) longScore++;
    if (distMA50 <= -1.5) longScore++;
    if (r <= 40) longScore++;
    if (bbPos <= 20) longScore++;

    // SHORT score: mirror
    let shortScore = 0;
    if (upWick >= 0.5) shortScore++;
    if (volR >= 1.5) shortScore++;
    if (mom5 >= 1) shortScore++;
    if (atrRatio >= 1.5) shortScore++;
    if (mh >= 50) shortScore++;
    if (body >= 0.5) shortScore++;
    if (distMA50 >= 1.5) shortScore++;
    if (r >= 60) shortScore++;
    if (bbPos >= 80) shortScore++;

    out.push({ ts: b.time, open: b.open, high: b.high, low: b.low, close: b.close, longScore, shortScore });
  }
  return out;
}

function run(setup: Setup, c5: Candle[], feats: FeatBar[]) {
  let longNet: Net = {qty:0, avg:0, openMs:0};
  let shortNet: Net = {qty:0, avg:0, openMs:0};
  let wallet = INITIAL_CAPITAL;
  let totalFees=0, totalRealizedPnl=0, totalAddsL=0, totalAddsS=0, totalCloses=0;
  let win=0, loss=0, lastL=0, lastS=0;
  let liq=false, liqMs=0, peak=INITIAL_CAPITAL, trough=INITIAL_CAPITAL;
  const events: Event[] = [];

  function applyClose(side: "LONG"|"SHORT", price: number, ts: number, reason: string){
    const net = side==="LONG" ? longNet : shortNet;
    if (net.qty<=0) return;
    const realized = side==="LONG" ? net.qty*(price-net.avg) : net.qty*(net.avg-price);
    const fee = net.qty*price*(FEE_PER_SIDE_PCT/100);
    const np = realized-fee;
    wallet += np; totalRealizedPnl += realized; totalFees += fee; totalCloses++;
    if (np>=0) win++; else loss++;
    events.push({ts, kind:"CLOSE", side, price, qty:net.qty, avgAfter:net.avg, realizedPnl:np, reason});
    if (side==="LONG") longNet={qty:0, avg:0, openMs:0}; else shortNet={qty:0, avg:0, openMs:0};
  }

  // Build 1H entry events from feats
  const entryByTs = new Map<number, { side: "LONG"|"SHORT"; price: number; score: number }[]>();
  for (const f of feats){
    if (f.longScore >= setup.minScore){
      const a = entryByTs.get(f.ts) || []; a.push({side:"LONG", price:f.close, score:f.longScore}); entryByTs.set(f.ts,a);
    }
    if (f.shortScore >= setup.minScore){
      const a = entryByTs.get(f.ts) || []; a.push({side:"SHORT", price:f.close, score:f.shortScore}); entryByTs.set(f.ts,a);
    }
  }

  for (let i=0;i<c5.length;i++){
    const bar = c5[i]; const price = bar.close; const ts = bar.time;
    if (setup.tpPct>0){
      if (longNet.qty>0){
        const gain = (price-longNet.avg)/longNet.avg*100;
        if (gain >= setup.tpPct) applyClose("LONG", price, ts, `TP+${setup.tpPct}%`);
        else if (ts-longNet.openMs >= setup.timeStopMs) applyClose("LONG", price, ts, "time_stop");
      }
      if (shortNet.qty>0){
        const drop = (shortNet.avg-price)/shortNet.avg*100;
        if (drop >= setup.tpPct) applyClose("SHORT", price, ts, `TP+${setup.tpPct}%`);
        else if (ts-shortNet.openMs >= setup.timeStopMs) applyClose("SHORT", price, ts, "time_stop");
      }
    }
    const evs = entryByTs.get(ts);
    if (evs) for (const e of evs){
      const cool = e.side==="LONG" ? ts-lastL>=COOLDOWN_MS : ts-lastS>=COOLDOWN_MS;
      if (!cool) continue;
      const qty = NOTIONAL_PER_ADD/e.price;
      const fee = NOTIONAL_PER_ADD*(FEE_PER_SIDE_PCT/100);
      if (e.side==="LONG"){longNet=addNet(longNet,qty,e.price,ts); totalAddsL++; lastL=ts; events.push({ts, kind:"ADD", side:"LONG", price:e.price, qty, avgAfter:longNet.avg, score:e.score});}
      else {shortNet=addNet(shortNet,qty,e.price,ts); totalAddsS++; lastS=ts; events.push({ts, kind:"ADD", side:"SHORT", price:e.price, qty, avgAfter:shortNet.avg, score:e.score});}
      wallet -= fee; totalFees += fee;
    }
    let upnl=0;
    if (longNet.qty>0) upnl += longNet.qty*(price-longNet.avg);
    if (shortNet.qty>0) upnl += shortNet.qty*(shortNet.avg-price);
    const eq = wallet+upnl;
    if (eq>peak) peak=eq; if (eq<trough) trough=eq;
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
    name: setup.name, liquidated:liq, liqAtMs:liqMs,
    totalAddsLong: totalAddsL, totalAddsShort: totalAddsS, totalCloses,
    totalRealizedPnl, totalFees,
    finalLong: longNet, finalShort: shortNet, lastPrice,
    finalUpnlLong: upL, finalUpnlShort: upS, finalUpnl,
    wallet, finalEq, roi, maxDD:peak-trough, peak, trough,
    winCount: win, lossCount: loss, events,
  };
}

function main(){
  console.log("[hedge04] Loading...");
  const c5 = loadCache("5m"); const c1h = loadCache("1h");
  console.log("[hedge04] Building features...");
  const feats = buildFeatures(c1h);

  // Histogram score distribution
  const longHist = new Array(10).fill(0), shortHist = new Array(10).fill(0);
  for (const f of feats){longHist[f.longScore]++; shortHist[f.shortScore]++;}
  console.log("LONG score histogram:", longHist.map((v,i)=>`${i}:${v}`).join(" "));
  console.log("SHORT score histogram:", shortHist.map((v,i)=>`${i}:${v}`).join(" "));

  const setups: Setup[] = [
    {name:"A. Score≥4 + TP8%  + 14d stop",  minScore:4, tpPct:8,  timeStopMs:14*24*60*60_000},
    {name:"B. Score≥5 + TP8%  + 14d stop",  minScore:5, tpPct:8,  timeStopMs:14*24*60*60_000},
    {name:"C. Score≥4 + TP10% + 30d stop",  minScore:4, tpPct:10, timeStopMs:30*24*60*60_000},
    {name:"D. Score≥5 + TP10% + 30d stop",  minScore:5, tpPct:10, timeStopMs:30*24*60*60_000},
    {name:"E. Score≥6 + TP5%  + 48h stop",  minScore:6, tpPct:5,  timeStopMs:48*60*60_000},
    {name:"F. Score≥4 NO TP",               minScore:4, tpPct:0,  timeStopMs:0},
  ];
  const results: any[] = [];
  for (const su of setups){
    const r = run(su, c5, feats);
    results.push(r);
    const wr = r.winCount+r.lossCount;
    console.log(`\n[${su.name}]\n  ROI ${r.roi.toFixed(2)}% · ADD L${r.totalAddsLong}/S${r.totalAddsShort} · CLOSES ${r.totalCloses} · WR ${wr>0?(r.winCount/wr*100).toFixed(0)+"%":"—"} · Realized $${r.totalRealizedPnl.toFixed(0)} · uPnL ${r.finalUpnl>=0?"+":""}$${r.finalUpnl.toFixed(0)} · DD $${r.maxDD.toFixed(0)} · LIQ ${r.liquidated}`);
  }
  console.log("\n=== SORTED BY ROI ===");
  results.sort((a,b)=>b.roi-a.roi);
  console.log("Setup                                  ROI%      Realized      uPnL        EQUITY      DD$       Trades  CLOSES  WR%   LIQ");
  for (const r of results){
    const wr = r.winCount+r.lossCount;
    console.log(`${r.name.padEnd(40)}${r.roi.toFixed(2).padStart(8)}% ${('$'+r.totalRealizedPnl.toFixed(0)).padStart(12)} ${((r.finalUpnl>=0?'+':'')+'$'+r.finalUpnl.toFixed(0)).padStart(12)} ${('$'+r.finalEq.toFixed(0)).padStart(11)}  $${r.maxDD.toFixed(0).padStart(7)}  ${(r.totalAddsLong+r.totalAddsShort).toString().padStart(6)}  ${r.totalCloses.toString().padStart(6)}  ${wr>0?(r.winCount/wr*100).toFixed(0).padStart(4):"  —"}  ${r.liquidated?"YES":"NO"}`);
  }

  const priceLine: { ts: number; price: number }[] = [];
  const step = 10;
  for (let i=0;i<c5.length;i+=step) priceLine.push({ts:c5[i].time, price:c5[i].close});

  writeFileSync(join(__dirname,"..","assets","backtest_hedge04_score_3y.json"), JSON.stringify({
    period:{start:c5[0].time, end:c5[c5.length-1].time},
    initialCapital: INITIAL_CAPITAL, notional: NOTIONAL_PER_ADD,
    longHist, shortHist, results, priceLine,
  }));
  console.log("\nSaved → assets/backtest_hedge04_score_3y.json");
}
main();
