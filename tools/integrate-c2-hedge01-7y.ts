/**
 * integrate-c2-hedge01-7y.ts (anh Tommy 2026-05-14)
 *
 * So sánh 2 variants trên 7y data:
 *   V1: Hedge01 baseline (8 setups + DeepDip + 1W bear SHORT filter)
 *   V2: Hedge01 + C2 add-on (setup #9: 5m bar có RSI≥70 AND upWick≥0.3% AND mom_all_up
 *       → ADD 0.005 BTC LONG vào hedge01 framework, TP10% net từ avg)
 *
 * Hedge01 spec: TP10% từ avg, cooldown 1h same side, no SL.
 * 1W bear SHORT filter (v0.4.16): SHORT chỉ vào khi 2 weekly bars closed red.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const INITIAL_CAPITAL = 100000;
const FEE_PER_SIDE_PCT = 0.05;
const MAINT_MARGIN_RATE = 0.004;
const COOLDOWN_MS = 60 * 60_000;
const TP_PCT = 10;
const MIN_SCORE = 9;
const DEEPDIP_QTY_BOOST = 0.05;
const C2_QTY = 0.005;   // half of DeepDip booster — moderate add (sensitive parameter)
const MS_1D = 24 * 60 * 60_000;

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }
interface Net { qty: number; avg: number; }

function loadCache(): Candle[] {
  return JSON.parse(readFileSync(join(__dirname, "..", ".cache", "binance-5m-7y.json"), "utf8"));
}

function calcSMA(a: number[], p: number): (number|null)[] {
  const o: (number|null)[] = new Array(a.length).fill(null);
  if (a.length < p) return o;
  let s = 0; for (let i = 0; i < p; i++) s += a[i];
  o[p-1] = s/p;
  for (let i = p; i < a.length; i++) { s += a[i] - a[i-p]; o[i] = s/p; }
  return o;
}
function calcEMA(a: number[], p: number): (number|null)[] {
  const o: (number|null)[] = new Array(a.length).fill(null);
  if (a.length < p) return o;
  const k = 2/(p+1); let e = 0;
  for (let i = 0; i < p; i++) e += a[i];
  e /= p; o[p-1] = e;
  for (let i = p; i < a.length; i++) { e = a[i]*k + e*(1-k); o[i] = e; }
  return o;
}
function calcStdev(a: number[], p: number, sma: (number|null)[]): (number|null)[] {
  const o: (number|null)[] = new Array(a.length).fill(null);
  for (let i = p-1; i < a.length; i++) {
    const m = sma[i]; if (m === null) continue;
    let sq = 0; for (let j = i-p+1; j <= i; j++) sq += (a[j]-m)**2;
    o[i] = Math.sqrt(sq/p);
  }
  return o;
}
function calcRSI(c: number[], p: number): (number|null)[] {
  const o: (number|null)[] = new Array(c.length).fill(null);
  if (c.length <= p) return o;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const ch = c[i]-c[i-1]; if (ch >= 0) g += ch; else l -= ch; }
  let ag = g/p, al = l/p;
  o[p] = al === 0 ? 100 : 100-100/(1+ag/al);
  for (let i = p+1; i < c.length; i++) {
    const ch = c[i]-c[i-1];
    ag = (ag*(p-1)+Math.max(ch,0))/p;
    al = (al*(p-1)+Math.max(-ch,0))/p;
    o[i] = al === 0 ? 100 : 100-100/(1+ag/al);
  }
  return o;
}
function calcStochK(c: Candle[], p: number): (number|null)[] {
  const o: (number|null)[] = new Array(c.length).fill(null);
  for (let i = p-1; i < c.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i-p+1; j <= i; j++) { if (c[j].high > hi) hi = c[j].high; if (c[j].low < lo) lo = c[j].low; }
    o[i] = hi === lo ? 50 : ((c[i].close-lo)/(hi-lo))*100;
  }
  return o;
}
function calcATR(c: Candle[], p: number): (number|null)[] {
  const o: (number|null)[] = new Array(c.length).fill(null);
  if (c.length <= p) return o;
  const tr: number[] = new Array(c.length).fill(0);
  for (let i = 1; i < c.length; i++)
    tr[i] = Math.max(c[i].high-c[i].low, Math.abs(c[i].high-c[i-1].close), Math.abs(c[i].low-c[i-1].close));
  let s = 0;
  for (let i = 1; i <= p; i++) s += tr[i];
  o[p] = s/p;
  for (let i = p+1; i < c.length; i++) o[i] = (o[i-1]!*(p-1)+tr[i])/p;
  return o;
}
function calcMACDHist(c: number[]): (number|null)[] {
  const e12 = calcEMA(c, 12), e26 = calcEMA(c, 26);
  const macd: (number|null)[] = c.map((_, i) => (e12[i] != null && e26[i] != null) ? e12[i]!-e26[i]! : null);
  const v: number[] = [], idxMap: number[] = [];
  for (let i = 0; i < macd.length; i++) if (macd[i] !== null) { v.push(macd[i]!); idxMap.push(i); }
  const sigEma = calcEMA(v, 9);
  const signal: (number|null)[] = new Array(c.length).fill(null);
  for (let k = 0; k < sigEma.length; k++) if (sigEma[k] !== null) signal[idxMap[k]] = sigEma[k];
  return c.map((_, i) => (macd[i] != null && signal[i] != null) ? macd[i]!-signal[i]! : null);
}

function aggregateQty(score: number, side: "LONG"|"SHORT"): number {
  let q = 0;
  if (score === 11) q += 0.001 * 3;
  if (score === 11) q += 0.01;
  if (score >= 10) q += 0.001;
  if (score >= 9) q += 0.001;
  if (score >= 10) q += 0.01;
  if (score === 11 && side === "LONG") q += 0.001;
  return q;
}
function isDeepDip5m(c5: Candle[], i: number): boolean {
  if (i < 200) return false;
  const last = c5[i].close;
  let s200 = 0; for (let j = i-200; j < i; j++) s200 += c5[j].close;
  if ((last - s200/200) / (s200/200) * 100 < -10) return true;
  let s50 = 0; for (let j = i-50; j < i; j++) s50 += c5[j].close;
  if ((last - s50/50) / (s50/50) * 100 < -5) return true;
  if (i >= 60 && (last - c5[i-60].close) / c5[i-60].close * 100 < -5) return true;
  return false;
}
function addNet(n: Net, q: number, p: number): Net {
  const nq = n.qty + q;
  return { qty: nq, avg: nq > 0 ? (n.qty * n.avg + q * p) / nq : 0 };
}

// Aggregate 5m → 15m bars (for hedge01 score profile)
function aggregate(c5: Candle[], minutes: number): { bars: Candle[]; map5to: number[] } {
  const groupMs = minutes * 60_000;
  const bars: Candle[] = [];
  const map5to: number[] = new Array(c5.length).fill(-1);
  let curKey = -1;
  let cur: Candle | null = null;
  for (let i = 0; i < c5.length; i++) {
    const b = c5[i];
    const key = Math.floor(b.time / groupMs);
    if (key !== curKey) {
      if (cur) bars.push(cur);
      cur = { time: key * groupMs, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 };
      curKey = key;
    } else if (cur) {
      if (b.high > cur.high) cur.high = b.high;
      if (b.low < cur.low) cur.low = b.low;
      cur.close = b.close;
      cur.volume = (cur.volume ?? 0) + (b.volume ?? 0);
    }
    // bar i belongs to current (still open) group → no peek nếu dùng map5to[i]-1
    map5to[i] = bars.length;  // current open group index (the bar in c15)
  }
  if (cur) bars.push(cur);
  return { bars, map5to };
}

interface Variant {
  name: string;
  enableC2: boolean;
}
interface Result {
  name: string;
  finalEq: number; roi: number; maxDD: number; ddPct: number;
  totalAddsL: number; totalAddsS: number; totalCloses: number;
  c2Adds: number;
  win: number; loss: number; wr: number;
  liquidated: boolean;
  perYear: Record<number, number>;
  peak: number; trough: number;
  finalLong: Net; finalShort: Net;
  uPnLLong: number; uPnLShort: number;
}

function simulate(c5: Candle[], c15: Candle[], c1w: Candle[], signals15: Map<number, Array<{side: "LONG"|"SHORT"; price: number; score: number}>>, c2Sig: Uint8Array, weekClosedRedAt: (ts: number) => boolean, variant: Variant): Result {
  let longNet: Net = { qty: 0, avg: 0 };
  let shortNet: Net = { qty: 0, avg: 0 };
  let wallet = INITIAL_CAPITAL;
  let totalFees = 0, totalRealized = 0, totalAddsL = 0, totalAddsS = 0, totalCloses = 0;
  let win = 0, loss = 0, lastL = 0, lastS = 0;
  let c2Adds = 0;
  let peak = INITIAL_CAPITAL, trough = INITIAL_CAPITAL;
  let liq = false;
  const perYearPnl: Record<number, number> = {};

  for (let i = 0; i < c5.length; i++) {
    const bar = c5[i]; const price = bar.close; const ts = bar.time;
    const year = new Date(ts).getUTCFullYear();
    // Close LONG @ TP10
    if (longNet.qty > 0 && longNet.avg > 0) {
      const gain = (price - longNet.avg) / longNet.avg * 100;
      if (gain >= TP_PCT) {
        const realized = longNet.qty * (price - longNet.avg);
        const fee = longNet.qty * price * (FEE_PER_SIDE_PCT/100);
        const np = realized - fee;
        wallet += np; totalRealized += realized; totalFees += fee; totalCloses++;
        if (np >= 0) win++; else loss++;
        perYearPnl[year] = (perYearPnl[year] || 0) + np;
        longNet = { qty: 0, avg: 0 };
      }
    }
    // Close SHORT @ TP10
    if (shortNet.qty > 0 && shortNet.avg > 0) {
      const drop = (shortNet.avg - price) / shortNet.avg * 100;
      if (drop >= TP_PCT) {
        const realized = shortNet.qty * (shortNet.avg - price);
        const fee = shortNet.qty * price * (FEE_PER_SIDE_PCT/100);
        const np = realized - fee;
        wallet += np; totalRealized += realized; totalFees += fee; totalCloses++;
        if (np >= 0) win++; else loss++;
        perYearPnl[year] = (perYearPnl[year] || 0) + np;
        shortNet = { qty: 0, avg: 0 };
      }
    }
    // Find latest CLOSED 15m signal at or before this 5m bar
    // Signals indexed by 15m bar time; signal eval at the 15m bar CLOSE.
    // For 5m bar i at time ts, latest closed 15m is the one with time + 15min ≤ ts.
    const closed15Time = Math.floor(ts / (15*60_000)) * (15*60_000) - 15*60_000;
    const sigList = signals15.get(closed15Time);
    if (sigList) {
      for (const e of sigList) {
        const cool = e.side === "LONG" ? (ts - lastL >= COOLDOWN_MS) : (ts - lastS >= COOLDOWN_MS);
        if (!cool) continue;
        // SHORT bear filter v0.4.16
        if (e.side === "SHORT" && !weekClosedRedAt(ts)) continue;
        let qty = aggregateQty(e.score, e.side);
        if (e.side === "LONG" && isDeepDip5m(c5, i)) qty += DEEPDIP_QTY_BOOST;
        if (qty <= 0) continue;
        const fee = qty * e.price * (FEE_PER_SIDE_PCT/100);
        if (e.side === "LONG") {
          longNet = addNet(longNet, qty, e.price);
          totalAddsL++; lastL = ts;
        } else {
          shortNet = addNet(shortNet, qty, e.price);
          totalAddsS++; lastS = ts;
        }
        wallet -= fee; totalFees += fee;
      }
    }
    // C2 setup #9 (only V2)
    if (variant.enableC2 && c2Sig[i] === 1) {
      const cool = ts - lastL >= COOLDOWN_MS;
      if (cool) {
        const qty = C2_QTY;
        const fee = qty * price * (FEE_PER_SIDE_PCT/100);
        longNet = addNet(longNet, qty, price);
        totalAddsL++; lastL = ts;
        c2Adds++;
        wallet -= fee; totalFees += fee;
      }
    }
    let upnl = 0;
    if (longNet.qty > 0) upnl += longNet.qty * (price - longNet.avg);
    if (shortNet.qty > 0) upnl += shortNet.qty * (shortNet.avg - price);
    const eq = wallet + upnl;
    if (eq > peak) peak = eq;
    if (eq < trough) trough = eq;
    if (longNet.qty + shortNet.qty > 0) {
      const totQ = longNet.qty + shortNet.qty;
      const mm = totQ * price * MAINT_MARGIN_RATE;
      if (eq <= mm) { liq = true; break; }
    }
  }
  const lastPrice = c5[c5.length - 1].close;
  const upL = longNet.qty > 0 ? longNet.qty * (lastPrice - longNet.avg) : 0;
  const upS = shortNet.qty > 0 ? shortNet.qty * (shortNet.avg - lastPrice) : 0;
  const finalEq = wallet + upL + upS;
  const roi = (finalEq - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100;
  return {
    name: variant.name, finalEq, roi, maxDD: peak - trough, ddPct: (peak - trough) / peak * 100,
    totalAddsL, totalAddsS, totalCloses, c2Adds, win, loss, wr: win+loss > 0 ? win/(win+loss) : 0,
    liquidated: liq, perYear: perYearPnl, peak, trough, finalLong: longNet, finalShort: shortNet,
    uPnLLong: upL, uPnLShort: upS,
  };
}

function main() {
  console.log("[integrate-c2-h01] Loading 7y 5m...");
  const c5 = loadCache();
  console.log(`  ${c5.length.toLocaleString()} bars`);
  console.log("[integrate-c2-h01] Aggregating 15m + 1w...");
  const { bars: c15 } = aggregate(c5, 15);
  const { bars: c1w } = aggregate(c5, 7 * 24 * 60);   // weekly = 7d * 24h * 60min
  console.log(`  ${c15.length} 15m bars, ${c1w.length} weekly bars`);

  // Compute hedge01 signals from 15m
  console.log("[integrate-c2-h01] Computing hedge01 15m signals...");
  const closes15 = c15.map(b => b.close);
  const vols15 = c15.map(b => b.volume ?? 0);
  const rsi = calcRSI(closes15, 14);
  const stochK = calcStochK(c15, 14);
  const macdH = calcMACDHist(closes15);
  const ma50 = calcSMA(closes15, 50);
  const ma20 = calcSMA(closes15, 20);
  const sd20 = calcStdev(closes15, 20, ma20);
  const atr14 = calcATR(c15, 14);
  const volMA = calcSMA(vols15, 20);

  const signals: Array<{ ts: number; side: "LONG"|"SHORT"; price: number; score: number }> = [];
  for (let i = 20; i < c15.length; i++) {
    const b = c15[i];
    const dnW = (Math.min(b.open, b.close) - b.low) / b.open * 100;
    const upW = (b.high - Math.max(b.open, b.close)) / b.open * 100;
    const body = Math.abs(b.close - b.open) / b.open * 100;
    const isBull = b.close > b.open ? 1 : 0;
    const volR = volMA[i] && volMA[i]! > 0 ? (b.volume ?? 0) / volMA[i]! : 0;
    const ma = ma20[i], sd = sd20[i];
    const bbPos = (ma !== null && sd !== null && sd > 0) ? (b.close - (ma - 2*sd)) / (4*sd) * 100 : 50;
    const mom5 = i >= 5 ? (b.close - c15[i-5].close)/c15[i-5].close * 100 : 0;
    const mom10 = i >= 10 ? (b.close - c15[i-10].close)/c15[i-10].close * 100 : 0;
    const mom20 = i >= 20 ? (b.close - c15[i-20].close)/c15[i-20].close * 100 : 0;
    const atr = atr14[i]; const range = b.high - b.low;
    const atrR = atr && atr > 0 ? range / atr : 0;
    const distMA50 = ma50[i] && ma50[i]! > 0 ? (b.close - ma50[i]!) / ma50[i]! * 100 : 0;
    const r = rsi[i] ?? 50; const sk = stochK[i] ?? 50; const mh = macdH[i] ?? 0;
    let lS = 0, sS = 0;
    if (dnW>=0.5) lS++; if (body>=0.5) lS++; if (isBull===0) lS++; if (volR>=2.0) lS++; if (atrR>=1.5) lS++;
    if (r<=35) lS++; if (sk<=30) lS++; if (mh<=-100) lS++; if (bbPos<=5) lS++; if (distMA50<=-3) lS++;
    if (mom5<0 && mom10<0 && mom20<0) lS++;
    if (upW>=0.5) sS++; if (body>=0.5) sS++; if (isBull===1) sS++; if (volR>=2.0) sS++; if (atrR>=1.5) sS++;
    if (r>=65) sS++; if (sk>=70) sS++; if (mh>=100) sS++; if (bbPos>=95) sS++; if (distMA50>=3) sS++;
    if (mom5>0 && mom10>0 && mom20>0) sS++;
    if (lS >= MIN_SCORE) signals.push({ ts: b.time, side: "LONG", price: b.close, score: lS });
    if (sS >= MIN_SCORE) signals.push({ ts: b.time, side: "SHORT", price: b.close, score: sS });
  }
  const sigByTs = new Map<number, Array<{ side: "LONG"|"SHORT"; price: number; score: number }>>();
  for (const s of signals) {
    const a = sigByTs.get(s.ts) || [];
    a.push({ side: s.side, price: s.price, score: s.score });
    sigByTs.set(s.ts, a);
  }
  console.log(`  ${signals.length.toLocaleString()} signals 15m`);

  // Compute C2 signal on 5m
  console.log("[integrate-c2-h01] Computing C2 signal on 5m...");
  const closes5 = c5.map(b => b.close);
  const rsi5 = calcRSI(closes5, 14);
  const c2Sig = new Uint8Array(c5.length);
  let c2Count = 0;
  for (let i = 200; i < c5.length; i++) {
    const bar = c5[i];
    const upW = (bar.high - Math.max(bar.open, bar.close)) / bar.open * 100;
    const mom5 = i >= 6 ? (bar.close - c5[i-6].close)/c5[i-6].close * 100 : 0;
    const mom10 = i >= 11 ? (bar.close - c5[i-11].close)/c5[i-11].close * 100 : 0;
    const mom20 = i >= 21 ? (bar.close - c5[i-21].close)/c5[i-21].close * 100 : 0;
    const r = rsi5[i] ?? 0;
    if (r >= 70 && upW >= 0.3 && mom5 >= 0 && mom10 >= 0 && mom20 >= 0) { c2Sig[i] = 1; c2Count++; }
  }
  console.log(`  ${c2Count.toLocaleString()} C2 signals`);

  // Weekly bear filter (1W bar i-2 red vs i-3 — 2 closed bars red)
  // Precompute mapping: at any timestamp, find latest closed weekly bar idx
  // c1w bars: c1w[k].time is start of week. Bar closes at c1w[k].time + 7d.
  function weekClosedRedAt(ts: number): boolean {
    // Find latest closed bar: c1w[k].time + 7d ≤ ts
    let lo = 0, hi = c1w.length - 1, ans = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (c1w[m].time + 7 * MS_1D <= ts) { ans = m; lo = m + 1; }
      else hi = m - 1;
    }
    // Need at least 2 closed bars to compare
    if (ans < 1) return false;
    return c1w[ans].close < c1w[ans - 1].close;
  }

  // Run 2 variants
  console.log("\n[integrate-c2-h01] Simulating V1 (Hedge01 baseline)...");
  const v1 = simulate(c5, c15, c1w, sigByTs, new Uint8Array(c5.length), weekClosedRedAt, { name: "V1 Hedge01 baseline", enableC2: false });
  console.log("[integrate-c2-h01] Simulating V2 (Hedge01 + C2 setup #9)...");
  const v2 = simulate(c5, c15, c1w, sigByTs, c2Sig, weekClosedRedAt, { name: "V2 Hedge01 + C2", enableC2: true });

  function report(r: Result) {
    console.log(`\n=== ${r.name} ===`);
    console.log(`Final equity: $${r.finalEq.toFixed(0)} · ROI ${r.roi >= 0 ? "+" : ""}${r.roi.toFixed(2)}%`);
    console.log(`LIQ: ${r.liquidated ? "YES ❌" : "NO"}`);
    console.log(`Max DD: $${r.maxDD.toFixed(0)} = ${r.ddPct.toFixed(1)}% peak`);
    console.log(`ADDs: LONG ${r.totalAddsL}  SHORT ${r.totalAddsS}  (C2-only ADDs: ${r.c2Adds})`);
    console.log(`Closes: ${r.totalCloses}  Win ${r.win}  Loss ${r.loss}  WR ${(r.wr*100).toFixed(1)}%`);
    console.log(`Final LONG: ${r.finalLong.qty.toFixed(4)} BTC @ $${r.finalLong.avg.toFixed(0)}  uPnL ${r.uPnLLong >= 0 ? "+" : ""}$${r.uPnLLong.toFixed(0)}`);
    console.log(`Final SHORT: ${r.finalShort.qty.toFixed(4)} BTC @ $${r.finalShort.avg.toFixed(0)}  uPnL ${r.uPnLShort >= 0 ? "+" : ""}$${r.uPnLShort.toFixed(0)}`);
    const ys = Object.keys(r.perYear).map(Number).sort();
    console.log(`Per-year PnL realized:`);
    for (const y of ys) console.log(`  ${y}: ${r.perYear[y] >= 0 ? "+" : ""}$${r.perYear[y].toFixed(0)}`);
  }
  report(v1);
  report(v2);

  console.log(`\n=== COMPARISON V2 vs V1 ===`);
  console.log(`ROI:   V1 ${v1.roi.toFixed(2)}%   V2 ${v2.roi.toFixed(2)}%   Δ ${(v2.roi - v1.roi >= 0 ? "+" : "")}${(v2.roi - v1.roi).toFixed(2)}%`);
  console.log(`DD%:   V1 ${v1.ddPct.toFixed(1)}%   V2 ${v2.ddPct.toFixed(1)}%   Δ ${(v2.ddPct - v1.ddPct >= 0 ? "+" : "")}${(v2.ddPct - v1.ddPct).toFixed(1)}%`);
  console.log(`Final eq: V1 $${v1.finalEq.toFixed(0)}   V2 $${v2.finalEq.toFixed(0)}   Δ $${(v2.finalEq - v1.finalEq).toFixed(0)}`);
  console.log(`Closes:  V1 ${v1.totalCloses}  V2 ${v2.totalCloses}   Δ ${v2.totalCloses - v1.totalCloses}`);

  writeFileSync(join(__dirname, "..", "assets", "integrate_c2_hedge01_7y.json"), JSON.stringify({ v1, v2 }, null, 2));
  console.log(`\n[integrate-c2-h01] ✅ Done — saved assets/integrate_c2_hedge01_7y.json`);
}

main();
