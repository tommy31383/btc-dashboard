/**
 * grid-tpsl-2layer-hedge01-7y.ts (anh Tommy 2026-05-14)
 *
 * Full 2-layer TP/SL grid sweep cho hedge01 v0.4.27 + C2 setup #10 trên 7y data.
 *
 * Layer 1 — Framework TP/SL (avg position trên hedge01 hedge mode):
 *   - tpPct: profit ≥ tpPct trên avg → close all side đó
 *   - slPct: loss ≥ slPct trên avg → close all side đó (0 = no SL, như current v0.4.27)
 *
 * Layer 2 — C2 per-position SL (chỉ áp dụng C2 entries, KHÔNG ảnh hưởng các setups #1-9):
 *   - c2SlPct: mỗi C2 entry track riêng. Nếu price ≤ entryPrice × (1 - c2SlPct/100)
 *     → close partial qty của entry đó (reduce từ longNet).
 *   - 0 = no per-position SL (current v0.4.27).
 *
 * Grid: TP[5,7,10,12,15,20] × SL[0,10,15,20,25,30] × C2SL[0,2,3,5,7,10] = 6×6×6 = 216 combos.
 *
 * Baseline = TP10 / SL0 / C2SL0 (current v0.4.27 = ROI +58.76% / DD 42.9% / RiskAdj 1.37).
 *
 * Rank by RiskAdj = ROI% / DD%.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const INITIAL_CAPITAL = 100000;
const FEE_PER_SIDE_PCT = 0.05;
const MAINT_MARGIN_RATE = 0.004;
const COOLDOWN_MS = 60 * 60_000;
const MIN_SCORE = 9;
const DEEPDIP_QTY_BOOST = 0.05;
const C2_QTY = 0.007;
const MS_1D = 24 * 60 * 60_000;

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }

function loadCache(): Candle[] {
  return JSON.parse(readFileSync(join(__dirname, "..", ".cache", "binance-5m-7y.json"), "utf8"));
}

function calcSMA(a: number[], p: number): (number|null)[] {
  const o: (number|null)[] = new Array(a.length).fill(null);
  if (a.length < p) return o;
  let s = 0; for (let i = 0; i < p; i++) s += a[i]; o[p-1] = s/p;
  for (let i = p; i < a.length; i++) { s += a[i] - a[i-p]; o[i] = s/p; }
  return o;
}
function calcEMA(a: number[], p: number): (number|null)[] {
  const o: (number|null)[] = new Array(a.length).fill(null);
  if (a.length < p) return o;
  const k = 2/(p+1); let e = 0;
  for (let i = 0; i < p; i++) e += a[i]; e /= p; o[p-1] = e;
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
function aggregate(c5: Candle[], minutes: number): { bars: Candle[] } {
  const groupMs = minutes * 60_000;
  const bars: Candle[] = [];
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
  }
  if (cur) bars.push(cur);
  return { bars };
}

interface C2Entry { qty: number; entryPrice: number; }
interface Result {
  tp: number; sl: number; c2sl: number;
  finalEq: number; roi: number; ddPct: number;
  closes: number; tpHits: number; slHits: number; c2SlHits: number;
  totalAddsL: number; totalAddsS: number; c2Adds: number;
  liquidated: boolean; riskAdj: number;
  perYear: Record<number, number>;
}

function simulate(
  c5: Candle[],
  sigByTs: Map<number, Array<{side: "LONG"|"SHORT"; price: number; score: number}>>,
  c2Sig: Uint8Array, weekClosedRedAt: (ts: number) => boolean,
  tpPct: number, slPct: number, c2SlPct: number
): Result {
  let longQty = 0, longAvg = 0;
  let shortQty = 0, shortAvg = 0;
  let wallet = INITIAL_CAPITAL;
  let totalAddsL = 0, totalAddsS = 0, c2Adds = 0;
  let closes = 0, tpHits = 0, slHits = 0, c2SlHits = 0;
  let lastL = 0, lastS = 0;
  let peak = INITIAL_CAPITAL, trough = INITIAL_CAPITAL;
  let liq = false;
  const c2Entries: C2Entry[] = [];
  const perYearPnl: Record<number, number> = {};

  function closeLongAll(price: number, ts: number, isSL: boolean) {
    if (longQty <= 0 || longAvg <= 0) return;
    const realized = longQty * (price - longAvg);
    const fee = longQty * price * (FEE_PER_SIDE_PCT/100);
    const np = realized - fee;
    wallet += np;
    closes++;
    if (isSL) slHits++; else tpHits++;
    const year = new Date(ts).getUTCFullYear();
    perYearPnl[year] = (perYearPnl[year] || 0) + np;
    longQty = 0; longAvg = 0;
    c2Entries.length = 0;
  }
  function closeShortAll(price: number, ts: number, isSL: boolean) {
    if (shortQty <= 0 || shortAvg <= 0) return;
    const realized = shortQty * (shortAvg - price);
    const fee = shortQty * price * (FEE_PER_SIDE_PCT/100);
    const np = realized - fee;
    wallet += np;
    closes++;
    if (isSL) slHits++; else tpHits++;
    const year = new Date(ts).getUTCFullYear();
    perYearPnl[year] = (perYearPnl[year] || 0) + np;
    shortQty = 0; shortAvg = 0;
  }

  for (let i = 0; i < c5.length; i++) {
    const bar = c5[i]; const price = bar.close; const ts = bar.time;

    // Framework TP/SL check trên avg
    if (longQty > 0 && longAvg > 0) {
      const gain = (price - longAvg) / longAvg * 100;
      if (gain >= tpPct) closeLongAll(price, ts, false);
      else if (slPct > 0 && gain <= -slPct) closeLongAll(price, ts, true);
    }
    if (shortQty > 0 && shortAvg > 0) {
      const drop = (shortAvg - price) / shortAvg * 100;
      if (drop >= tpPct) closeShortAll(price, ts, false);
      else if (slPct > 0 && drop <= -slPct) closeShortAll(price, ts, true);
    }

    // C2 per-position SL — chỉ apply nếu c2SlPct > 0 và còn long position + C2 entries
    if (c2SlPct > 0 && longQty > 0 && c2Entries.length > 0) {
      for (let k = c2Entries.length - 1; k >= 0; k--) {
        const e = c2Entries[k];
        const loss = (price - e.entryPrice) / e.entryPrice * 100;
        if (loss <= -c2SlPct) {
          // Close this C2 chunk at current price
          const realized = e.qty * (price - longAvg); // realized vs avg
          const fee = e.qty * price * (FEE_PER_SIDE_PCT/100);
          const np = realized - fee;
          wallet += np;
          c2SlHits++;
          const year = new Date(ts).getUTCFullYear();
          perYearPnl[year] = (perYearPnl[year] || 0) + np;
          // Reduce longQty, keep avg same (we close at current price below avg, so avg of remaining unchanged conceptually for tracking — simplification)
          longQty -= e.qty;
          if (longQty <= 1e-9) { longQty = 0; longAvg = 0; }
          c2Entries.splice(k, 1);
        }
      }
    }

    // Framework signals (15m closed bar)
    const closed15Time = Math.floor(ts / (15*60_000)) * (15*60_000) - 15*60_000;
    const sigList = sigByTs.get(closed15Time);
    if (sigList) {
      for (const e of sigList) {
        const cool = e.side === "LONG" ? (ts - lastL >= COOLDOWN_MS) : (ts - lastS >= COOLDOWN_MS);
        if (!cool) continue;
        if (e.side === "SHORT" && !weekClosedRedAt(ts)) continue;
        let qty = aggregateQty(e.score, e.side);
        if (e.side === "LONG" && isDeepDip5m(c5, i)) qty += DEEPDIP_QTY_BOOST;
        if (qty <= 0) continue;
        const fee = qty * e.price * (FEE_PER_SIDE_PCT/100);
        if (e.side === "LONG") {
          const nq = longQty + qty;
          longAvg = nq > 0 ? (longQty * longAvg + qty * e.price) / nq : 0;
          longQty = nq;
          totalAddsL++; lastL = ts;
        } else {
          const nq = shortQty + qty;
          shortAvg = nq > 0 ? (shortQty * shortAvg + qty * e.price) / nq : 0;
          shortQty = nq;
          totalAddsS++; lastS = ts;
        }
        wallet -= fee;
      }
    }

    // C2 fire (5m)
    if (c2Sig[i] === 1) {
      const cool = ts - lastL >= COOLDOWN_MS;
      if (cool) {
        const fee = C2_QTY * price * (FEE_PER_SIDE_PCT/100);
        const nq = longQty + C2_QTY;
        longAvg = nq > 0 ? (longQty * longAvg + C2_QTY * price) / nq : 0;
        longQty = nq;
        totalAddsL++; lastL = ts; c2Adds++;
        wallet -= fee;
        if (c2SlPct > 0) c2Entries.push({ qty: C2_QTY, entryPrice: price });
      }
    }

    // Equity + DD
    let upnl = 0;
    if (longQty > 0) upnl += longQty * (price - longAvg);
    if (shortQty > 0) upnl += shortQty * (shortAvg - price);
    const eq = wallet + upnl;
    if (eq > peak) peak = eq;
    if (eq < trough) trough = eq;
    if (longQty + shortQty > 0) {
      const totQ = longQty + shortQty;
      const mm = totQ * price * MAINT_MARGIN_RATE;
      if (eq <= mm) { liq = true; break; }
    }
  }
  const lastPrice = c5[c5.length - 1].close;
  const upL = longQty > 0 ? longQty * (lastPrice - longAvg) : 0;
  const upS = shortQty > 0 ? shortQty * (shortAvg - lastPrice) : 0;
  const finalEq = wallet + upL + upS;
  const roi = (finalEq - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100;
  const ddPct = (peak - trough) / peak * 100;
  return {
    tp: tpPct, sl: slPct, c2sl: c2SlPct,
    finalEq, roi, ddPct,
    closes, tpHits, slHits, c2SlHits,
    totalAddsL, totalAddsS, c2Adds,
    liquidated: liq, riskAdj: ddPct > 0 ? roi/ddPct : roi,
    perYear: perYearPnl,
  };
}

function main() {
  console.log("[grid-2layer] Loading 7y 5m...");
  const c5 = loadCache();
  console.log(`  ${c5.length.toLocaleString()} bars`);
  console.log("[grid-2layer] Aggregating 15m + 1w...");
  const { bars: c15 } = aggregate(c5, 15);
  const { bars: c1w } = aggregate(c5, 7 * 24 * 60);
  console.log(`  ${c15.length} 15m bars, ${c1w.length} weekly bars`);

  console.log("[grid-2layer] Computing hedge01 15m signals...");
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

  console.log("[grid-2layer] Computing C2 signal on 5m...");
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
  console.log(`  ${c2Count.toLocaleString()} C2 signals\n`);

  function weekClosedRedAt(ts: number): boolean {
    let lo = 0, hi = c1w.length - 1, ans = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (c1w[m].time + 7 * MS_1D <= ts) { ans = m; lo = m + 1; }
      else hi = m - 1;
    }
    if (ans < 1) return false;
    return c1w[ans].close < c1w[ans - 1].close;
  }

  const tpGrid = [5, 7, 10, 12, 15, 20];
  const slGrid = [0, 10, 15, 20, 25, 30];
  const c2SlGrid = [0, 2, 3, 5, 7, 10];

  console.log(`[grid-2layer] Running ${tpGrid.length * slGrid.length * c2SlGrid.length} combos...`);
  const results: Result[] = [];
  let n = 0;
  const t0 = Date.now();
  for (const tp of tpGrid) {
    for (const sl of slGrid) {
      for (const c2sl of c2SlGrid) {
        const r = simulate(c5, sigByTs, c2Sig, weekClosedRedAt, tp, sl, c2sl);
        results.push(r);
        n++;
        if (n % 18 === 0) {
          const dt = (Date.now() - t0) / 1000;
          console.log(`  ${n}/${tpGrid.length*slGrid.length*c2SlGrid.length} done · ${dt.toFixed(1)}s · last: TP${tp}/SL${sl}/C2SL${c2sl} ROI ${r.roi.toFixed(1)}% DD ${r.ddPct.toFixed(1)}%`);
        }
      }
    }
  }
  console.log(`[grid-2layer] All done in ${((Date.now()-t0)/1000).toFixed(1)}s\n`);

  // Baseline (TP10 SL0 C2SL0)
  const baseline = results.find(r => r.tp === 10 && r.sl === 0 && r.c2sl === 0)!;
  console.log(`=== BASELINE (v0.4.27 current: TP10/SL0/C2SL0) ===`);
  console.log(`  ROI ${baseline.roi.toFixed(2)}% · DD ${baseline.ddPct.toFixed(1)}% · RiskAdj ${baseline.riskAdj.toFixed(2)} · closes ${baseline.closes} · LIQ ${baseline.liquidated ? "YES" : "NO"}\n`);

  // Top 15 by RiskAdj (no LIQ)
  const validResults = results.filter(r => !r.liquidated);
  const top = [...validResults].sort((a, b) => b.riskAdj - a.riskAdj).slice(0, 15);
  console.log(`=== TOP 15 BY RISK-ADJUSTED ROI (ROI% / DD%) ===`);
  console.log(`Rank | TP  | SL  | C2SL | ROI%    | DD%   | RiskAdj | Closes (TP/SL/C2SL) | C2-ADDs | vs base`);
  console.log(`-----|-----|-----|------|---------|-------|---------|---------------------|---------|----------`);
  top.forEach((r, i) => {
    const sl = r.sl === 0 ? "NO" : String(r.sl);
    const c2sl = r.c2sl === 0 ? "NO" : String(r.c2sl);
    const isBaseline = r === baseline ? " ← base" : "";
    const dRoi = (r.roi - baseline.roi);
    const dDd = (r.ddPct - baseline.ddPct);
    console.log(`${String(i+1).padStart(4)} | ${String(r.tp).padStart(3)} | ${sl.padStart(3)} | ${c2sl.padStart(4)} | ${(r.roi>=0?"+":"")}${r.roi.toFixed(2).padStart(7)} | ${r.ddPct.toFixed(1).padStart(5)} | ${r.riskAdj.toFixed(2).padStart(7)} | ${String(r.closes).padStart(3)} (${r.tpHits}/${r.slHits}/${r.c2SlHits}) | ${String(r.c2Adds).padStart(7)} | Δ${(dRoi>=0?"+":"")}${dRoi.toFixed(1)}%/Δ${(dDd>=0?"+":"")}${dDd.toFixed(1)}p${isBaseline}`);
  });

  // Top 5 by ROI absolute
  console.log(`\n=== TOP 5 BY RAW ROI (no LIQ) ===`);
  const topRoi = [...validResults].sort((a, b) => b.roi - a.roi).slice(0, 5);
  topRoi.forEach((r, i) => {
    console.log(`${i+1}. TP${r.tp}/SL${r.sl||"NO"}/C2SL${r.c2sl||"NO"} → ROI +${r.roi.toFixed(2)}% / DD ${r.ddPct.toFixed(1)}% / RiskAdj ${r.riskAdj.toFixed(2)}`);
  });

  // LIQ count
  const liqCount = results.filter(r => r.liquidated).length;
  console.log(`\nLIQ count: ${liqCount}/${results.length} combos`);

  // Per-year stability for top 1
  const best = top[0];
  console.log(`\n=== TOP 1 PER-YEAR PnL (TP${best.tp}/SL${best.sl||"NO"}/C2SL${best.c2sl||"NO"}) ===`);
  const years = [2019, 2020, 2021, 2022, 2023, 2024, 2025];
  for (const y of years) {
    const v = best.perYear[y] ?? 0;
    console.log(`  ${y}: ${v >= 0 ? "+" : ""}$${v.toFixed(0)}`);
  }

  writeFileSync(join(__dirname, "..", "assets", "grid_tpsl_2layer_hedge01_7y.json"), JSON.stringify({ baseline, top15: top, all: results }, null, 2));
  console.log(`\n[grid-2layer] ✅ Done — saved assets/grid_tpsl_2layer_hedge01_7y.json`);
}

main();
