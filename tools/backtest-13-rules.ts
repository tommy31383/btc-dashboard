/**
 * backtest-13-rules.ts (anh Tommy 2026-05-04)
 * Test 13 rule families chống nhau với BTC 3y, $100k cap, $1000 notional/ADD.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const INITIAL_CAPITAL = 100000;
const NOTIONAL_PER_ADD = 1000;
const FEE_PER_SIDE_PCT = 0.05;
const MAINT_MARGIN_RATE = 0.004;

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }
interface Net { qty: number; avg: number; openMs: number; }
interface Sig { ts: number; price: number; signal: "LONG"|"SHORT"|"CLOSE_LONG"|"CLOSE_SHORT"; sizeMul?: number; }
interface Event { ts: number; kind: "ADD"|"CLOSE"; side: "LONG"|"SHORT"; price: number; qty: number; avgAfter: number; realizedPnl?: number; }

function loadCache(tf: string): Candle[] {
  const p = join(__dirname, "..", ".cache", `binance-${tf}-3y.json`);
  if (!existsSync(p)) throw new Error(`Missing ${p}`);
  return JSON.parse(readFileSync(p, "utf8"));
}
function findIdx(arr: { time: number }[], t: number): number {
  let lo=0, hi=arr.length-1, ans=-1;
  while (lo<=hi){const m=(lo+hi)>>1; if (arr[m].time<=t){ans=m; lo=m+1;} else hi=m-1;}
  return ans;
}
function calcSMA(a: number[], p: number): (number|null)[] {
  const out: (number|null)[] = new Array(a.length).fill(null);
  if (a.length < p) return out;
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
  for (let i=1;i<c.length;i++){tr[i]=Math.max(c[i].high-c[i].low, Math.abs(c[i].high-c[i-1].close), Math.abs(c[i].low-c[i-1].close));}
  let s=0; for (let i=1;i<=p;i++) s+=tr[i]; out[p]=s/p;
  for (let i=p+1;i<c.length;i++) out[i]=(out[i-1]!*(p-1)+tr[i])/p;
  return out;
}
function calcMACD(c: number[]): {macd: (number|null)[]; signal: (number|null)[]} {
  const ema12 = calcEMA(c, 12), ema26 = calcEMA(c, 26);
  const macd: (number|null)[] = c.map((_,i) => (ema12[i]!=null && ema26[i]!=null) ? ema12[i]!-ema26[i]! : null);
  const macdValid: number[] = []; const macdMap: number[] = [];
  for (let i=0;i<macd.length;i++) if (macd[i]!==null){macdValid.push(macd[i]!); macdMap.push(i);}
  const sigEma = calcEMA(macdValid, 9);
  const signal: (number|null)[] = new Array(c.length).fill(null);
  for (let k=0;k<sigEma.length;k++) if (sigEma[k]!==null) signal[macdMap[k]] = sigEma[k];
  return {macd, signal};
}
function addNet(n: Net, q: number, p: number, ts: number): Net {
  const nq = n.qty+q;
  return {qty: nq, avg: nq>0 ? (n.qty*n.avg+q*p)/nq : 0, openMs: n.qty===0 ? ts : n.openMs};
}

interface Result {
  name: string;
  liquidated: boolean; liqAtMs: number;
  totalAddsLong: number; totalAddsShort: number; totalCloses: number;
  totalRealizedPnl: number; totalFees: number;
  finalLong: Net; finalShort: Net; lastPrice: number;
  finalUpnlLong: number; finalUpnlShort: number; finalUpnl: number;
  wallet: number; finalEq: number;
  roi: number; maxDD: number; peak: number; trough: number;
  winCount: number; lossCount: number;
  totalNotionalUsd: number;
  events: Event[];
}

function simulate(name: string, sigs: Sig[], priceLine: { ts: number; price: number }[]): Result {
  let longNet: Net = {qty:0, avg:0, openMs:0};
  let shortNet: Net = {qty:0, avg:0, openMs:0};
  let wallet = INITIAL_CAPITAL;
  let totalFees=0, totalRealizedPnl=0, totalAddsL=0, totalAddsS=0, totalCloses=0;
  let win=0, loss=0, lastL=0, lastS=0, totalNotional=0;
  let liq=false, liqMs=0, peak=INITIAL_CAPITAL, trough=INITIAL_CAPITAL;
  const events: Event[] = [];
  const cooldown = 60*60_000; // 1h cooldown ADD same side
  const sigByTs = new Map<number, Sig[]>();
  for (const s of sigs){const a=sigByTs.get(s.ts)||[]; a.push(s); sigByTs.set(s.ts,a);}
  for (let i=0;i<priceLine.length;i++){
    const p = priceLine[i];
    const list = sigByTs.get(p.ts);
    if (list) for (const sig of list){
      const price = sig.price; const sm = sig.sizeMul ?? 1;
      const notional = NOTIONAL_PER_ADD * sm;
      const qty = notional / price;
      const fee = notional * (FEE_PER_SIDE_PCT/100);
      if (sig.signal==="LONG" && p.ts-lastL>=cooldown){
        longNet = addNet(longNet, qty, price, p.ts);
        wallet -= fee; totalFees += fee; totalAddsL++; lastL=p.ts; totalNotional += notional;
        events.push({ts:p.ts, kind:"ADD", side:"LONG", price, qty, avgAfter:longNet.avg});
      } else if (sig.signal==="SHORT" && p.ts-lastS>=cooldown){
        shortNet = addNet(shortNet, qty, price, p.ts);
        wallet -= fee; totalFees += fee; totalAddsS++; lastS=p.ts; totalNotional += notional;
        events.push({ts:p.ts, kind:"ADD", side:"SHORT", price, qty, avgAfter:shortNet.avg});
      } else if (sig.signal==="CLOSE_LONG" && longNet.qty>0){
        const realized = longNet.qty*(price-longNet.avg);
        const f = longNet.qty*price*(FEE_PER_SIDE_PCT/100);
        const net = realized-f;
        wallet += net; totalRealizedPnl += realized; totalFees += f; totalCloses++;
        if (net>=0) win++; else loss++;
        events.push({ts:p.ts, kind:"CLOSE", side:"LONG", price, qty:longNet.qty, avgAfter:longNet.avg, realizedPnl:net});
        longNet={qty:0, avg:0, openMs:0};
      } else if (sig.signal==="CLOSE_SHORT" && shortNet.qty>0){
        const realized = shortNet.qty*(shortNet.avg-price);
        const f = shortNet.qty*price*(FEE_PER_SIDE_PCT/100);
        const net = realized-f;
        wallet += net; totalRealizedPnl += realized; totalFees += f; totalCloses++;
        if (net>=0) win++; else loss++;
        events.push({ts:p.ts, kind:"CLOSE", side:"SHORT", price, qty:shortNet.qty, avgAfter:shortNet.avg, realizedPnl:net});
        shortNet={qty:0, avg:0, openMs:0};
      }
    }
    let upnl=0;
    if (longNet.qty>0) upnl += longNet.qty*(p.price-longNet.avg);
    if (shortNet.qty>0) upnl += shortNet.qty*(shortNet.avg-p.price);
    const eq = wallet + upnl;
    if (eq>peak) peak=eq; if (eq<trough) trough=eq;
    if (longNet.qty+shortNet.qty>0){
      const mm = (longNet.qty+shortNet.qty)*p.price*MAINT_MARGIN_RATE;
      if (eq<=mm){liq=true; liqMs=p.ts; break;}
    }
  }
  const lastPrice = priceLine[priceLine.length-1].price;
  const upL = longNet.qty>0 ? longNet.qty*(lastPrice-longNet.avg) : 0;
  const upS = shortNet.qty>0 ? shortNet.qty*(shortNet.avg-lastPrice) : 0;
  const finalUpnl = upL+upS;
  const finalEq = wallet+finalUpnl;
  const roi = ((finalEq-INITIAL_CAPITAL)/INITIAL_CAPITAL)*100;
  return {name, liquidated:liq, liqAtMs:liqMs, totalAddsLong:totalAddsL, totalAddsShort:totalAddsS, totalCloses,
    totalRealizedPnl, totalFees, finalLong:longNet, finalShort:shortNet, lastPrice,
    finalUpnlLong:upL, finalUpnlShort:upS, finalUpnl, wallet, finalEq, roi,
    maxDD:peak-trough, peak, trough, winCount:win, lossCount:loss, totalNotionalUsd:totalNotional, events};
}

// ============ RULES ============

// R1: Donchian breakout (1D) — BUY break high 20d, EXIT < low 10d
function R1_donchian(c1d: Candle[]): Sig[] {
  const sigs: Sig[] = []; let inLong=false;
  for (let i=20;i<c1d.length;i++){
    let hi20=-Infinity; for (let j=i-20;j<i;j++) if (c1d[j].high>hi20) hi20=c1d[j].high;
    let lo10=Infinity; for (let j=i-10;j<i;j++) if (c1d[j].low<lo10) lo10=c1d[j].low;
    const c = c1d[i];
    if (!inLong && c.close>hi20){sigs.push({ts:c.time, price:c.close, signal:"LONG"}); inLong=true;}
    else if (inLong && c.close<lo10){sigs.push({ts:c.time, price:c.close, signal:"CLOSE_LONG"}); inLong=false;}
  }
  return sigs;
}

// R2: EMA9/21 cross (1H)
function R2_emaCross(c1h: Candle[]): Sig[] {
  const cl = c1h.map(b=>b.close);
  const e9=calcEMA(cl,9), e21=calcEMA(cl,21);
  const sigs: Sig[]=[]; let inLong=false;
  for (let i=22;i<c1h.length;i++){
    if (e9[i]==null||e21[i]==null) continue;
    const up=e9[i]!>e21[i]!, prevUp=(e9[i-1]!>e21[i-1]!);
    if (!inLong && up && !prevUp){sigs.push({ts:c1h[i].time, price:c1h[i].close, signal:"LONG"}); inLong=true;}
    else if (inLong && !up && prevUp){sigs.push({ts:c1h[i].time, price:c1h[i].close, signal:"CLOSE_LONG"}); inLong=false;}
  }
  return sigs;
}

// R3: Pyramid trend — start small, ADD 2x@+3%, 3x@+6%, 4x@+10% từ entry; close khi giảm 5% từ đỉnh local
function R3_pyramid(c1h: Candle[]): Sig[] {
  const sigs: Sig[]=[]; let inLong=false; let entry=0; let levels:boolean[]=[false,false,false,false]; let peakSinceEntry=0;
  const cl = c1h.map(b=>b.close);
  const e21 = calcEMA(cl,21), e50 = calcEMA(cl,50);
  for (let i=51;i<c1h.length;i++){
    if (e21[i]==null||e50[i]==null) continue;
    const c = c1h[i].close;
    if (!inLong){
      if (e21[i]!>e50[i]! && (e21[i-1]!<=e50[i-1]!)){
        sigs.push({ts:c1h[i].time, price:c, signal:"LONG", sizeMul:1});
        inLong=true; entry=c; peakSinceEntry=c; levels=[true,false,false,false];
      }
    } else {
      if (c>peakSinceEntry) peakSinceEntry=c;
      // pyramid adds
      const gain = (c-entry)/entry*100;
      if (!levels[1] && gain>=3){sigs.push({ts:c1h[i].time, price:c, signal:"LONG", sizeMul:2}); levels[1]=true;}
      if (!levels[2] && gain>=6){sigs.push({ts:c1h[i].time, price:c, signal:"LONG", sizeMul:3}); levels[2]=true;}
      if (!levels[3] && gain>=10){sigs.push({ts:c1h[i].time, price:c, signal:"LONG", sizeMul:4}); levels[3]=true;}
      // exit on 5% drop from peak
      if ((peakSinceEntry-c)/peakSinceEntry*100 >= 5){sigs.push({ts:c1h[i].time, price:c, signal:"CLOSE_LONG"}); inLong=false; levels=[false,false,false,false];}
    }
  }
  return sigs;
}

// R4: BB breakout continuation (1H) — close > upper BB → BUY (ngược Hedge02)
function R4_bbBreakout(c1h: Candle[]): Sig[] {
  const cl = c1h.map(b=>b.close);
  const sma=calcSMA(cl,20), sd=calcStdev(cl,20,sma);
  const sigs: Sig[]=[]; let inLong=false, inShort=false;
  for (let i=21;i<c1h.length;i++){
    const m=sma[i], s=sd[i]; if (m===null||s===null) continue;
    const u=m+2*s, l=m-2*s;
    const c = c1h[i].close;
    // Continuation: break trên = momentum lên → LONG
    if (!inLong && c>u){
      if (inShort){sigs.push({ts:c1h[i].time, price:c, signal:"CLOSE_SHORT"}); inShort=false;}
      sigs.push({ts:c1h[i].time, price:c, signal:"LONG"}); inLong=true;
    }
    // Break dưới = momentum xuống → SHORT
    if (!inShort && c<l){
      if (inLong){sigs.push({ts:c1h[i].time, price:c, signal:"CLOSE_LONG"}); inLong=false;}
      sigs.push({ts:c1h[i].time, price:c, signal:"SHORT"}); inShort=true;
    }
    // Re-cross middle = exit
    if (inLong && c<m){sigs.push({ts:c1h[i].time, price:c, signal:"CLOSE_LONG"}); inLong=false;}
    if (inShort && c>m){sigs.push({ts:c1h[i].time, price:c, signal:"CLOSE_SHORT"}); inShort=false;}
  }
  return sigs;
}

// R5: ATR breakout (1H) — close > prev close + 2×ATR
function R5_atrBreakout(c1h: Candle[]): Sig[] {
  const atr = calcATR(c1h, 14);
  const sigs: Sig[]=[]; let inLong=false;
  for (let i=15;i<c1h.length;i++){
    const a = atr[i]; if (a===null) continue;
    const c = c1h[i].close, pc = c1h[i-1].close;
    if (!inLong && c > pc + 2*a){sigs.push({ts:c1h[i].time, price:c, signal:"LONG"}); inLong=true;}
    else if (inLong && c < pc - 1*a){sigs.push({ts:c1h[i].time, price:c, signal:"CLOSE_LONG"}); inLong=false;}
  }
  return sigs;
}

// R6: BB squeeze release — width < 50%-ile of recent → wait → break = momentum direction
function R6_squeeze(c1h: Candle[]): Sig[] {
  const cl = c1h.map(b=>b.close);
  const sma=calcSMA(cl,20), sd=calcStdev(cl,20,sma);
  const sigs: Sig[]=[]; let inLong=false; let inShort=false;
  for (let i=120;i<c1h.length;i++){
    const m=sma[i], s=sd[i]; if (m===null||s===null) continue;
    const width = (4*s)/m;
    // Compare with avg width 100 bars
    let sumW=0, cnt=0;
    for (let j=i-100;j<i;j++){const sm=sma[j], sdv=sd[j]; if (sm===null||sdv===null) continue; sumW+=(4*sdv)/sm; cnt++;}
    if (cnt<50) continue;
    const avgW = sumW/cnt;
    const isSqueeze = width < avgW * 0.7;
    if (!isSqueeze) continue;
    // Wait for break — check next bars: but for simplicity ENTRY at squeeze + direction confirm next bar
    if (i+1>=c1h.length) continue;
    const nextC = c1h[i+1].close;
    const c = c1h[i].close;
    if (!inLong && nextC > m + 0.5*s){sigs.push({ts:c1h[i+1].time, price:nextC, signal:"LONG"}); inLong=true;}
    if (!inShort && nextC < m - 0.5*s){sigs.push({ts:c1h[i+1].time, price:nextC, signal:"SHORT"}); inShort=true;}
    if (inLong && nextC < m){sigs.push({ts:c1h[i+1].time, price:nextC, signal:"CLOSE_LONG"}); inLong=false;}
    if (inShort && nextC > m){sigs.push({ts:c1h[i+1].time, price:nextC, signal:"CLOSE_SHORT"}); inShort=false;}
  }
  return sigs;
}

// R7: RSI > 60 + price > MA50 (1H) → LONG; exit when RSI < 40
function R7_rsiMomentum(c1h: Candle[]): Sig[] {
  const cl = c1h.map(b=>b.close);
  const rsi = calcRSI(cl, 14); const ma = calcSMA(cl, 50);
  const sigs: Sig[]=[]; let inLong=false;
  for (let i=51;i<c1h.length;i++){
    const r=rsi[i], m=ma[i]; if (r===null||m===null) continue;
    const c=c1h[i].close;
    if (!inLong && r>60 && c>m){sigs.push({ts:c1h[i].time, price:c, signal:"LONG"}); inLong=true;}
    else if (inLong && r<40){sigs.push({ts:c1h[i].time, price:c, signal:"CLOSE_LONG"}); inLong=false;}
  }
  return sigs;
}

// R8: MACD cross + volume spike (1H)
function R8_macdVol(c1h: Candle[]): Sig[] {
  const cl = c1h.map(b=>b.close);
  const m = calcMACD(cl);
  const vols = c1h.map(b=>b.volume??0);
  const smaVol = calcSMA(vols, 20);
  const sigs: Sig[]=[]; let inLong=false, inShort=false;
  for (let i=35;i<c1h.length;i++){
    const macd=m.macd[i], sig=m.signal[i], pmacd=m.macd[i-1], psig=m.signal[i-1];
    if (macd==null||sig==null||pmacd==null||psig==null) continue;
    const sv = smaVol[i]; if (sv==null) continue;
    const volSpike = (c1h[i].volume??0) > 1.5*sv;
    const crossUp = macd>sig && pmacd<=psig;
    const crossDn = macd<sig && pmacd>=psig;
    const c = c1h[i].close;
    if (!inLong && crossUp && volSpike){
      if (inShort){sigs.push({ts:c1h[i].time, price:c, signal:"CLOSE_SHORT"}); inShort=false;}
      sigs.push({ts:c1h[i].time, price:c, signal:"LONG"}); inLong=true;
    } else if (!inShort && crossDn && volSpike){
      if (inLong){sigs.push({ts:c1h[i].time, price:c, signal:"CLOSE_LONG"}); inLong=false;}
      sigs.push({ts:c1h[i].time, price:c, signal:"SHORT"}); inShort=true;
    }
  }
  return sigs;
}

// R9: Stoch K crossover + HTF trend up (1D MA50)
function R9_stochHtf(c1h: Candle[], c1d: Candle[]): Sig[] {
  // Compute Stoch K (14) on 1H using highs/lows
  const k: (number|null)[] = new Array(c1h.length).fill(null);
  for (let i=13;i<c1h.length;i++){
    let hi=-Infinity, lo=Infinity;
    for (let j=i-13;j<=i;j++){if (c1h[j].high>hi) hi=c1h[j].high; if (c1h[j].low<lo) lo=c1h[j].low;}
    k[i] = hi===lo ? 50 : ((c1h[i].close-lo)/(hi-lo))*100;
  }
  const ma1d = calcSMA(c1d.map(b=>b.close), 50);
  const sigs: Sig[]=[]; let inLong=false;
  for (let i=15;i<c1h.length;i++){
    const ki=k[i], pki=k[i-1]; if (ki===null||pki===null) continue;
    const idx1d = findIdx(c1d, c1h[i].time);
    if (idx1d<50) continue;
    const ma = ma1d[idx1d-1] ?? null; if (ma===null) continue;
    const trendUp = c1d[idx1d-1].close > ma;
    if (!trendUp) continue;
    const crossUp = ki>20 && pki<=20;
    const crossDn = ki<80 && pki>=80;
    const c = c1h[i].close;
    if (!inLong && crossUp){sigs.push({ts:c1h[i].time, price:c, signal:"LONG"}); inLong=true;}
    else if (inLong && crossDn){sigs.push({ts:c1h[i].time, price:c, signal:"CLOSE_LONG"}); inLong=false;}
  }
  return sigs;
}

// R10: DCA Martingale — entry LONG, ADD 2x mỗi 3% giảm, max 8x
function R10_dcaMart(c4h: Candle[]): Sig[] {
  const sigs: Sig[]=[]; let inLong=false, entry=0, lastTrigger=0, doubled=0;
  for (let i=0;i<c4h.length;i++){
    const c = c4h[i].close;
    if (!inLong){
      sigs.push({ts:c4h[i].time, price:c, signal:"LONG", sizeMul:1});
      inLong=true; entry=c; lastTrigger=c; doubled=0;
    } else {
      const dropPct = (lastTrigger-c)/lastTrigger*100;
      if (dropPct>=3 && doubled<3){
        const mul = Math.pow(2, doubled+1);
        sigs.push({ts:c4h[i].time, price:c, signal:"LONG", sizeMul:mul});
        lastTrigger=c; doubled++;
      }
      // Close khi giá vượt entry trung bình +5% (proxy: vượt entry +5%)
      const gain = (c-entry)/entry*100;
      if (gain>=8){
        sigs.push({ts:c4h[i].time, price:c, signal:"CLOSE_LONG"});
        inLong=false; doubled=0;
      }
    }
  }
  return sigs;
}

// R11: Anti-martingale — sau win double size, sau loss reset
// Implement as EMA cross with adaptive size (sizeMul depends on prev close PnL)
function R11_antiMart(c1h: Candle[]): Sig[] {
  const cl = c1h.map(b=>b.close);
  const e9=calcEMA(cl,9), e21=calcEMA(cl,21);
  const sigs: Sig[]=[]; let inLong=false; let nextSize=1; let entryPrice=0;
  for (let i=22;i<c1h.length;i++){
    if (e9[i]==null||e21[i]==null) continue;
    const up=e9[i]!>e21[i]!, prev=(e9[i-1]!>e21[i-1]!);
    const c = c1h[i].close;
    if (!inLong && up && !prev){
      sigs.push({ts:c1h[i].time, price:c, signal:"LONG", sizeMul:nextSize});
      inLong=true; entryPrice=c;
    } else if (inLong && !up && prev){
      sigs.push({ts:c1h[i].time, price:c, signal:"CLOSE_LONG"});
      inLong=false;
      const win = c > entryPrice;
      nextSize = win ? Math.min(nextSize*2, 8) : 1;
    }
  }
  return sigs;
}

// R12: Buy & Hold ALL IN at start
function R12_buyHold(c5: Candle[]): Sig[] {
  return [{ts:c5[0].time, price:c5[0].close, signal:"LONG", sizeMul:100}]; // 100x = $100k notional
}

// R13: DCA hold — $1000/week LONG, never sell
function R13_dcaHold(c5: Candle[]): Sig[] {
  const sigs: Sig[]=[];
  const weekMs = 7*24*60*60_000;
  let nextTs = c5[0].time;
  for (const b of c5){
    if (b.time>=nextTs){
      sigs.push({ts:b.time, price:b.close, signal:"LONG"});
      nextTs = b.time + weekMs;
    }
  }
  return sigs;
}

function main(){
  console.log("[13rules] Loading...");
  const c5 = loadCache("5m"), c1h = loadCache("1h"), c4h = loadCache("4h"), c1d = loadCache("1d");
  const fullPL = c5.map(b=>({ts:b.time, price:b.close}));

  const setups = [
    {name:"R1. Donchian breakout 20d",        sigs:R1_donchian(c1d)},
    {name:"R2. EMA9/21 cross 1H",             sigs:R2_emaCross(c1h)},
    {name:"R3. Pyramid trend (EMA21x50)",     sigs:R3_pyramid(c1h)},
    {name:"R4. BB breakout 1H (continuation)",sigs:R4_bbBreakout(c1h)},
    {name:"R5. ATR breakout 2x 1H",           sigs:R5_atrBreakout(c1h)},
    {name:"R6. BB squeeze release 1H",        sigs:R6_squeeze(c1h)},
    {name:"R7. RSI>60 + MA50 momentum 1H",    sigs:R7_rsiMomentum(c1h)},
    {name:"R8. MACD cross + vol spike 1H",    sigs:R8_macdVol(c1h)},
    {name:"R9. Stoch + HTF trend",            sigs:R9_stochHtf(c1h, c1d)},
    {name:"R10. DCA Martingale 4H",           sigs:R10_dcaMart(c4h)},
    {name:"R11. Anti-martingale EMA 1H",      sigs:R11_antiMart(c1h)},
    {name:"R12. Buy & Hold ALL-IN",           sigs:R12_buyHold(c5)},
    {name:"R13. DCA $1000/week",              sigs:R13_dcaHold(c5)},
  ];

  const results: Result[] = [];
  for (const s of setups){
    console.log(`\n[${s.name}] sigs=${s.sigs.length}`);
    const r = simulate(s.name, s.sigs, fullPL);
    results.push(r);
    const wr = r.winCount+r.lossCount;
    console.log(`  ROI ${r.roi.toFixed(2)}% · L${r.totalAddsLong}/S${r.totalAddsShort} · CL ${r.totalCloses} · WR ${wr>0?(r.winCount/wr*100).toFixed(0)+"%":"—"} · Realized $${r.totalRealizedPnl.toFixed(0)} · uPnL ${r.finalUpnl>=0?"+":""}$${r.finalUpnl.toFixed(0)} · DD $${r.maxDD.toFixed(0)} · LIQ ${r.liquidated}`);
  }
  console.log("\n=== SORTED BY ROI ===");
  results.sort((a,b)=>b.roi-a.roi);
  console.log("Rule                                       ROI%       Realized      uPnL        EQUITY      DD$       Trades  CLOSES  WR%   LIQ");
  for (const r of results){
    const wr = r.winCount+r.lossCount;
    console.log(`${r.name.padEnd(42)}${r.roi.toFixed(2).padStart(8)}% ${('$'+r.totalRealizedPnl.toFixed(0)).padStart(12)} ${((r.finalUpnl>=0?'+':'')+'$'+r.finalUpnl.toFixed(0)).padStart(12)} ${('$'+r.finalEq.toFixed(0)).padStart(11)}  $${r.maxDD.toFixed(0).padStart(7)}  ${(r.totalAddsLong+r.totalAddsShort).toString().padStart(6)}  ${r.totalCloses.toString().padStart(6)}  ${wr>0?(r.winCount/wr*100).toFixed(0).padStart(4):"  —"}  ${r.liquidated?"YES":"NO"}`);
  }

  const priceLine: { ts: number; price: number }[] = [];
  const step = 10;
  for (let i=0;i<c5.length;i+=step) priceLine.push({ts:c5[i].time, price:c5[i].close});

  const out = {
    period:{start:c5[0].time, end:c5[c5.length-1].time},
    initialCapital:INITIAL_CAPITAL, notional:NOTIONAL_PER_ADD,
    results, priceLine,
  };
  writeFileSync(join(__dirname,"..","assets","backtest_13rules_3y.json"), JSON.stringify(out));
  console.log("\nSaved → assets/backtest_13rules_3y.json");
}
main();
