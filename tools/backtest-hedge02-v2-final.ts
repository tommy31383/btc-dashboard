/**
 * backtest-hedge02-v2-final.ts (anh Tommy 2026-05-04)
 * Backtest CHÍNH XÁC config Hedge02 v0.4.7 production:
 *   - Score ≥ 4/9 features (1H bars)
 *   - TP +10% từ avg → CLOSE ALL
 *   - Cooldown 1h same side
 *   - Capital $100k, 0.001 BTC/ADD
 * Output JSON với full events cho chart.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const INITIAL_CAPITAL = 100000;
const MIN_QTY_BTC = 0.001;
const FEE_PER_SIDE_PCT = 0.05;
const MAINT_MARGIN_RATE = 0.004;
const COOLDOWN_MS = 60*60_000;
const MIN_SCORE = 4;
const TP_PCT = 10;

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }
interface Net { qty: number; avg: number; }
interface Event { ts: number; kind: "ADD"|"CLOSE"; side: "LONG"|"SHORT"; price: number; qty: number; avgAfter: number; realizedPnl?: number; score?: number; }

function loadCache(tf: string): Candle[] { return JSON.parse(readFileSync(join(__dirname,"..",".cache",`binance-${tf}-3y.json`),"utf8")); }
function calcSMA(a: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); if (a.length<p) return o; let s=0; for (let i=0;i<p;i++) s+=a[i]; o[p-1]=s/p; for (let i=p;i<a.length;i++){s+=a[i]-a[i-p]; o[i]=s/p;} return o; }
function calcEMA(a: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); if (a.length<p) return o; const k=2/(p+1); let e=0; for (let i=0;i<p;i++) e+=a[i]; e/=p; o[p-1]=e; for (let i=p;i<a.length;i++){e=a[i]*k+e*(1-k); o[i]=e;} return o; }
function calcStdev(a: number[], p: number, sma: (number|null)[]): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); for (let i=p-1;i<a.length;i++){const m=sma[i]; if (m===null) continue; let sq=0; for (let j=i-p+1;j<=i;j++) sq+=(a[j]-m)**2; o[i]=Math.sqrt(sq/p);} return o; }
function calcRSI(c: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(c.length).fill(null); if (c.length<=p) return o; let g=0,l=0; for (let i=1;i<=p;i++){const ch=c[i]-c[i-1]; if (ch>=0) g+=ch; else l-=ch;} let ag=g/p, al=l/p; o[p]=al===0?100:100-100/(1+ag/al); for (let i=p+1;i<c.length;i++){const ch=c[i]-c[i-1]; ag=(ag*(p-1)+Math.max(ch,0))/p; al=(al*(p-1)+Math.max(-ch,0))/p; o[i]=al===0?100:100-100/(1+ag/al);} return o; }
function calcATR(c: Candle[], p: number): (number|null)[] { const o: (number|null)[] = new Array(c.length).fill(null); if (c.length<=p) return o; const tr: number[] = new Array(c.length).fill(0); for (let i=1;i<c.length;i++) tr[i]=Math.max(c[i].high-c[i].low, Math.abs(c[i].high-c[i-1].close), Math.abs(c[i].low-c[i-1].close)); let s=0; for (let i=1;i<=p;i++) s+=tr[i]; o[p]=s/p; for (let i=p+1;i<c.length;i++) o[i]=(o[i-1]!*(p-1)+tr[i])/p; return o; }
function calcMACDHist(c: number[]): (number|null)[] { const e12=calcEMA(c,12), e26=calcEMA(c,26); const macd: (number|null)[] = c.map((_,i) => (e12[i]!=null && e26[i]!=null) ? e12[i]!-e26[i]! : null); const v: number[]=[], m: number[]=[]; for (let i=0;i<macd.length;i++) if (macd[i]!==null){v.push(macd[i]!); m.push(i);} const sigEma = calcEMA(v, 9); const signal: (number|null)[] = new Array(c.length).fill(null); for (let k=0;k<sigEma.length;k++) if (sigEma[k]!==null) signal[m[k]] = sigEma[k]; return c.map((_,i) => (macd[i]!=null && signal[i]!=null) ? macd[i]!-signal[i]! : null); }
function addNet(n: Net, q: number, p: number): Net { const nq=n.qty+q; return { qty: nq, avg: nq>0 ? (n.qty*n.avg+q*p)/nq : 0 }; }

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
    const dnW = (Math.min(b.open,b.close)-b.low)/b.open*100;
    const upW = (b.high-Math.max(b.open,b.close))/b.open*100;
    const body = Math.abs(b.close-b.open)/b.open*100;
    const volR = volMA[i] && volMA[i]!>0 ? (b.volume??0)/volMA[i]! : 0;
    const ma=ma20[i], sd=sd20[i];
    const bbPos = (ma!==null && sd!==null && sd>0) ? (b.close-(ma-2*sd))/(4*sd)*100 : 50;
    const mom5 = i>=5 ? (b.close-c1h[i-5].close)/c1h[i-5].close*100 : 0;
    const atr = atr14[i]; const range = b.high-b.low;
    const atrR = atr && atr>0 ? range/atr : 0;
    const distMA50 = ma50[i] && ma50[i]!>0 ? (b.close-ma50[i]!)/ma50[i]!*100 : 0;
    const r = rsi[i] ?? 50;
    const mh = macdH[i] ?? 0;
    let lS=0, sS=0;
    if (dnW>=0.5) lS++; if (volR>=1.5) lS++; if (mom5<=-1) lS++; if (atrR>=1.5) lS++; if (mh<=-50) lS++; if (body>=0.5) lS++; if (distMA50<=-1.5) lS++; if (r<=40) lS++; if (bbPos<=20) lS++;
    if (upW>=0.5) sS++; if (volR>=1.5) sS++; if (mom5>=1) sS++; if (atrR>=1.5) sS++; if (mh>=50) sS++; if (body>=0.5) sS++; if (distMA50>=1.5) sS++; if (r>=60) sS++; if (bbPos>=80) sS++;
    out.push({ts:b.time, close:b.close, longScore:lS, shortScore:sS});
  }
  return out;
}

function main() {
  console.log("[h02-v2] Loading...");
  const c5 = loadCache("5m"); const c1h = loadCache("1h");
  const feats = buildFeatures(c1h);

  const entryByTs = new Map<number, { side: "LONG"|"SHORT"; price: number; score: number }[]>();
  for (const f of feats){
    if (f.longScore>=MIN_SCORE){const a=entryByTs.get(f.ts)||[]; a.push({side:"LONG", price:f.close, score:f.longScore}); entryByTs.set(f.ts,a);}
    if (f.shortScore>=MIN_SCORE){const a=entryByTs.get(f.ts)||[]; a.push({side:"SHORT", price:f.close, score:f.shortScore}); entryByTs.set(f.ts,a);}
  }

  let longNet: Net = {qty:0, avg:0};
  let shortNet: Net = {qty:0, avg:0};
  let wallet = INITIAL_CAPITAL;
  let totalFees=0, totalRealizedPnl=0, totalAddsL=0, totalAddsS=0, totalCloses=0;
  let win=0, loss=0, lastL=0, lastS=0;
  let liq=false, liqMs=0, peak=INITIAL_CAPITAL, trough=INITIAL_CAPITAL;
  const events: Event[] = [];

  for (let i=0;i<c5.length;i++){
    const bar = c5[i]; const price = bar.close; const ts = bar.time;

    // CLOSE: TP +10% từ avg
    if (longNet.qty>0 && longNet.avg>0){
      const gain = (price-longNet.avg)/longNet.avg*100;
      if (gain>=TP_PCT){
        const realized = longNet.qty*(price-longNet.avg);
        const fee = longNet.qty*price*(FEE_PER_SIDE_PCT/100);
        const np = realized-fee;
        wallet += np; totalRealizedPnl += realized; totalFees += fee; totalCloses++;
        if (np>=0) win++; else loss++;
        events.push({ts, kind:"CLOSE", side:"LONG", price, qty:longNet.qty, avgAfter:longNet.avg, realizedPnl:np});
        longNet={qty:0, avg:0};
      }
    }
    if (shortNet.qty>0 && shortNet.avg>0){
      const drop = (shortNet.avg-price)/shortNet.avg*100;
      if (drop>=TP_PCT){
        const realized = shortNet.qty*(shortNet.avg-price);
        const fee = shortNet.qty*price*(FEE_PER_SIDE_PCT/100);
        const np = realized-fee;
        wallet += np; totalRealizedPnl += realized; totalFees += fee; totalCloses++;
        if (np>=0) win++; else loss++;
        events.push({ts, kind:"CLOSE", side:"SHORT", price, qty:shortNet.qty, avgAfter:shortNet.avg, realizedPnl:np});
        shortNet={qty:0, avg:0};
      }
    }
    // ENTRY
    const evs = entryByTs.get(ts);
    if (evs) for (const e of evs){
      const cool = e.side==="LONG" ? ts-lastL>=COOLDOWN_MS : ts-lastS>=COOLDOWN_MS;
      if (!cool) continue;
      const qty = MIN_QTY_BTC;
      const fee = qty*e.price*(FEE_PER_SIDE_PCT/100);
      if (e.side==="LONG"){longNet=addNet(longNet,qty,e.price); totalAddsL++; lastL=ts; events.push({ts, kind:"ADD", side:"LONG", price:e.price, qty, avgAfter:longNet.avg, score:e.score});}
      else {shortNet=addNet(shortNet,qty,e.price); totalAddsS++; lastS=ts; events.push({ts, kind:"ADD", side:"SHORT", price:e.price, qty, avgAfter:shortNet.avg, score:e.score});}
      wallet -= fee; totalFees += fee;
    }
    // Stats + LIQ
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

  console.log(`\n=== Hedge02 v0.4.7 PRODUCTION CONFIG (Score≥4 + TP10%) ===`);
  console.log(`Period: ${new Date(c5[0].time).toISOString().slice(0,10)} → ${new Date(c5[c5.length-1].time).toISOString().slice(0,10)}`);
  console.log(`Capital: $${INITIAL_CAPITAL}, qty/ADD: 0.001 BTC`);
  console.log(`LIQ: ${liq?"YES":"NO"}`);
  console.log(`ADDs: LONG ${totalAddsL}, SHORT ${totalAddsS}`);
  console.log(`CLOSES: ${totalCloses} (win ${win} / loss ${loss}, WR ${win+loss>0?(win/(win+loss)*100).toFixed(0):"-"}%)`);
  console.log(`Realized PnL: ${totalRealizedPnl>=0?"+":""}$${totalRealizedPnl.toFixed(2)}`);
  console.log(`Final LONG: ${longNet.qty.toFixed(4)} @ $${longNet.avg.toFixed(0)} → uPnL ${upL>=0?"+":""}$${upL.toFixed(2)}`);
  console.log(`Final SHORT: ${shortNet.qty.toFixed(4)} @ $${shortNet.avg.toFixed(0)} → uPnL ${upS>=0?"+":""}$${upS.toFixed(2)}`);
  console.log(`Final EQUITY: $${finalEq.toFixed(2)} · ROI ${roi.toFixed(2)}% · Max DD $${(peak-trough).toFixed(0)}`);

  const priceLine: { ts: number; price: number }[] = [];
  const step = 10;
  for (let i=0;i<c5.length;i+=step) priceLine.push({ts:c5[i].time, price:c5[i].close});

  writeFileSync(join(__dirname,"..","assets","backtest_hedge02_v2_3y.json"), JSON.stringify({
    period:{start:c5[0].time, end:c5[c5.length-1].time},
    config:{ minScore: MIN_SCORE, tpPct: TP_PCT, qtyBtc: MIN_QTY_BTC, capital: INITIAL_CAPITAL },
    liquidated: liq, liqAtMs: liqMs,
    totalAddsLong: totalAddsL, totalAddsShort: totalAddsS, totalCloses,
    winCount: win, lossCount: loss,
    totalRealizedPnl, totalFees,
    finalLong: longNet, finalShort: shortNet, lastPrice,
    finalUpnl, finalEq, wallet, roi, maxDD: peak-trough, peak, trough,
    events, priceLine,
  }));
  console.log(`\nSaved → assets/backtest_hedge02_v2_3y.json`);
}
main();
