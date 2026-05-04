/**
 * backtest-hedge02-improvements.ts (anh Tommy 2026-05-04)
 *
 * Test 7 setup cải tiến Hedge02:
 *   1. Baseline (BB wick 4H, no close)
 *   2. +A: TP at opposite band + 30d time stop
 *   3. +B: Reversal confirm filter (RSI 1H + reversal candle)
 *   4. +C: HTF trend filter (1D MA200)
 *   5. A+B
 *   6. A+C
 *   7. A+B+C (recommend)
 *
 * Common: $100k cap, 0.001 BTC/ADD, lev 125x cross, fee 0.05%/side
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const INITIAL_CAPITAL = 100000;
const MIN_QTY_BTC = 0.001;
const FEE_PER_SIDE_PCT = 0.05;
const MAINT_MARGIN_RATE = 0.004;
const COOLDOWN_MS = 4 * 60 * 60_000;
const BB_PERIOD = 20;
const BB_STD = 2;
const TIME_STOP_MS = 30 * 24 * 60 * 60_000; // 30 ngày
const RSI_OS = 30;
const RSI_OB = 70;
const MA_HTF_PERIOD = 200;

interface Candle { time: number; open: number; high: number; low: number; close: number; }
interface Net { qty: number; avg: number; openMs: number; }

function loadCache(tf: string): Candle[] {
  const p = join(__dirname, "..", ".cache", `binance-${tf}-3y.json`);
  if (!existsSync(p)) throw new Error(`Missing ${p}`);
  return JSON.parse(readFileSync(p, "utf8"));
}
function findIdxAtOrBefore(arr: { time: number }[], t: number): number {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m].time <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}
function calcSMA(arr: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(arr.length).fill(null);
  if (arr.length < period) return out;
  let sum = 0; for (let i = 0; i < period; i++) sum += arr[i];
  out[period - 1] = sum / period;
  for (let i = period; i < arr.length; i++) { sum += arr[i] - arr[i - period]; out[i] = sum / period; }
  return out;
}
function calcStdev(arr: number[], period: number, sma: (number|null)[]): (number|null)[] {
  const out: (number|null)[] = new Array(arr.length).fill(null);
  for (let i = period - 1; i < arr.length; i++) {
    const m = sma[i]; if (m === null) continue;
    let sq = 0; for (let j = i - period + 1; j <= i; j++) sq += (arr[j] - m) ** 2;
    out[i] = Math.sqrt(sq / period);
  }
  return out;
}
function calcRSI(closes: number[], period: number): (number|null)[] {
  const out: (number|null)[] = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) { const c = closes[i]-closes[i-1]; if (c>=0) g+=c; else l-=c; }
  let ag = g/period, al = l/period;
  out[period] = al===0 ? 100 : 100-100/(1+ag/al);
  for (let i = period+1; i < closes.length; i++) {
    const c = closes[i]-closes[i-1];
    ag = (ag*(period-1)+Math.max(c,0))/period;
    al = (al*(period-1)+Math.max(-c,0))/period;
    out[i] = al===0 ? 100 : 100-100/(1+ag/al);
  }
  return out;
}
function addNet(n: Net, qty: number, price: number, ts: number): Net {
  const newQty = n.qty + qty;
  return { qty: newQty, avg: newQty > 0 ? (n.qty * n.avg + qty * price) / newQty : 0, openMs: n.qty === 0 ? ts : n.openMs };
}

interface Event { ts: number; kind: "ADD" | "CLOSE"; side: "LONG" | "SHORT"; price: number; qty: number; avgAfter: number; realizedPnl?: number; reason?: string; }

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
  events: Event[];
}

function simulate(
  name: string,
  c5: Candle[], c4h: Candle[], c1h: Candle[], c1d: Candle[],
  opts: { useTP: boolean; useReversalFilter: boolean; useHTFTrendFilter: boolean }
): Result {
  // Pre-compute indicators
  const closes4h = c4h.map((b) => b.close);
  const sma4h = calcSMA(closes4h, BB_PERIOD);
  const sd4h = calcStdev(closes4h, BB_PERIOD, sma4h);
  const closes1h = c1h.map((b) => b.close);
  const rsi1h = calcRSI(closes1h, 14);
  const closes1d = c1d.map((b) => b.close);
  const ma1d = calcSMA(closes1d, MA_HTF_PERIOD);

  // Pre-compute 4H BB info per bar
  const bb4h: { ts: number; lower: number; upper: number; mid: number }[] = [];
  for (let i = BB_PERIOD; i < c4h.length; i++) {
    const m = sma4h[i], sdv = sd4h[i]; if (m === null || sdv === null) continue;
    bb4h.push({ ts: c4h[i].time, lower: m - BB_STD * sdv, upper: m + BB_STD * sdv, mid: m });
  }
  const bbByTs = new Map<number, { lower: number; upper: number; mid: number }>();
  for (const b of bb4h) bbByTs.set(b.ts, { lower: b.lower, upper: b.upper, mid: b.mid });

  // 4H bar entry signals (wick touch)
  const sigs4h: { ts: number; side: "LONG"|"SHORT"; price: number; bar: Candle }[] = [];
  for (let i = BB_PERIOD; i < c4h.length; i++) {
    const m = sma4h[i], sdv = sd4h[i]; if (m === null || sdv === null) continue;
    const lower = m - BB_STD * sdv, upper = m + BB_STD * sdv;
    const bar = c4h[i];
    if (bar.low <= lower) sigs4h.push({ ts: bar.time, side: "LONG", price: bar.close, bar });
    if (bar.high >= upper) sigs4h.push({ ts: bar.time, side: "SHORT", price: bar.close, bar });
  }

  // Apply filters
  function passFilters(side: "LONG"|"SHORT", bar: Candle, ts: number): boolean {
    if (opts.useReversalFilter) {
      // RSI 1H + reversal candle
      const idx1h = findIdxAtOrBefore(c1h, ts);
      if (idx1h < 14) return false;
      const r = rsi1h[idx1h] ?? 50;
      if (side === "LONG" && r >= RSI_OS) {
        // Cũng accept nếu cây 4H này là bullish reversal (close > open + close > prev close)
        const prevBarIdx = findIdxAtOrBefore(c4h, ts) - 1;
        if (prevBarIdx < 0) return false;
        const prev = c4h[prevBarIdx];
        const isBullReversal = bar.close > bar.open && bar.close > prev.close;
        if (!isBullReversal) return false;
      }
      if (side === "SHORT" && r <= RSI_OB) {
        const prevBarIdx = findIdxAtOrBefore(c4h, ts) - 1;
        if (prevBarIdx < 0) return false;
        const prev = c4h[prevBarIdx];
        const isBearReversal = bar.close < bar.open && bar.close < prev.close;
        if (!isBearReversal) return false;
      }
    }
    if (opts.useHTFTrendFilter) {
      const idx1d = findIdxAtOrBefore(c1d, ts);
      if (idx1d < MA_HTF_PERIOD) return false;
      const ma = ma1d[idx1d] ?? null;
      if (ma === null) return false;
      const trendUp = c1d[idx1d].close > ma;
      // chỉ LONG khi trend UP, chỉ SHORT khi trend DOWN
      if (side === "LONG" && !trendUp) return false;
      if (side === "SHORT" && trendUp) return false;
    }
    return true;
  }

  // Group sigs by ts
  const sigByTs = new Map<number, typeof sigs4h>();
  for (const s of sigs4h) { const a = sigByTs.get(s.ts) || []; a.push(s); sigByTs.set(s.ts, a); }

  // State
  let longNet: Net = { qty: 0, avg: 0, openMs: 0 };
  let shortNet: Net = { qty: 0, avg: 0, openMs: 0 };
  let wallet = INITIAL_CAPITAL;
  let totalFees = 0, totalRealizedPnl = 0;
  let totalAddsLong = 0, totalAddsShort = 0, totalCloses = 0;
  let winCount = 0, lossCount = 0;
  let lastAddLongMs = 0, lastAddShortMs = 0;
  let liquidated = false, liqAtMs = 0;
  let peak = INITIAL_CAPITAL, trough = INITIAL_CAPITAL;
  const events: Event[] = [];

  function applyAdd(side: "LONG"|"SHORT", price: number, ts: number, reason: string) {
    const qty = MIN_QTY_BTC;
    const fee = qty * price * (FEE_PER_SIDE_PCT / 100);
    if (side === "LONG") {
      longNet = addNet(longNet, qty, price, ts);
      totalAddsLong++; lastAddLongMs = ts;
      events.push({ ts, kind: "ADD", side, price, qty, avgAfter: longNet.avg, reason });
    } else {
      shortNet = addNet(shortNet, qty, price, ts);
      totalAddsShort++; lastAddShortMs = ts;
      events.push({ ts, kind: "ADD", side, price, qty, avgAfter: shortNet.avg, reason });
    }
    wallet -= fee; totalFees += fee;
  }
  function applyClose(side: "LONG"|"SHORT", price: number, ts: number, reason: string) {
    const net = side === "LONG" ? longNet : shortNet;
    if (net.qty <= 0) return;
    const realized = side === "LONG" ? net.qty * (price - net.avg) : net.qty * (net.avg - price);
    const fee = net.qty * price * (FEE_PER_SIDE_PCT / 100);
    const netPnl = realized - fee;
    wallet += netPnl;
    totalRealizedPnl += realized; totalFees += fee; totalCloses++;
    if (netPnl >= 0) winCount++; else lossCount++;
    events.push({ ts, kind: "CLOSE", side, price, qty: net.qty, avgAfter: net.avg, realizedPnl: netPnl, reason });
    if (side === "LONG") longNet = { qty: 0, avg: 0, openMs: 0 };
    else shortNet = { qty: 0, avg: 0, openMs: 0 };
  }

  // Walk 5m
  let curBB: { lower: number; upper: number; mid: number } | null = null;
  for (let i = 0; i < c5.length; i++) {
    const bar = c5[i]; const price = bar.close; const ts = bar.time;
    // Update curBB with most recent 4H bar BB
    const bbHere = bbByTs.get(ts);
    if (bbHere) curBB = bbHere;

    // CHECK CLOSE FIRST (TP / time stop)
    if (opts.useTP && curBB) {
      // LONG TP: price >= upper band
      if (longNet.qty > 0 && price >= curBB.upper) {
        applyClose("LONG", price, ts, "TP_upper");
      }
      // SHORT TP: price <= lower band
      if (shortNet.qty > 0 && price <= curBB.lower) {
        applyClose("SHORT", price, ts, "TP_lower");
      }
      // Time stop 30d
      if (longNet.qty > 0 && ts - longNet.openMs >= TIME_STOP_MS) {
        applyClose("LONG", price, ts, "time_stop_30d");
      }
      if (shortNet.qty > 0 && ts - shortNet.openMs >= TIME_STOP_MS) {
        applyClose("SHORT", price, ts, "time_stop_30d");
      }
    }

    // CHECK ENTRY (only at 4H bar close)
    const sigs = sigByTs.get(ts);
    if (sigs) for (const sig of sigs) {
      const cool = sig.side === "LONG" ? ts - lastAddLongMs >= COOLDOWN_MS : ts - lastAddShortMs >= COOLDOWN_MS;
      if (!cool) continue;
      if (!passFilters(sig.side, sig.bar, ts)) continue;
      applyAdd(sig.side, sig.price, ts, "wick");
    }

    // LIQ + stats
    let upnl = 0;
    if (longNet.qty > 0) upnl += longNet.qty * (price - longNet.avg);
    if (shortNet.qty > 0) upnl += shortNet.qty * (shortNet.avg - price);
    const eq = wallet + upnl;
    if (eq > peak) peak = eq; if (eq < trough) trough = eq;
    if (longNet.qty + shortNet.qty > 0) {
      const mm = (longNet.qty + shortNet.qty) * price * MAINT_MARGIN_RATE;
      if (eq <= mm) { liquidated = true; liqAtMs = ts; break; }
    }
  }

  const lastPrice = c5[c5.length - 1].close;
  const finalUpnlLong = longNet.qty > 0 ? longNet.qty * (lastPrice - longNet.avg) : 0;
  const finalUpnlShort = shortNet.qty > 0 ? shortNet.qty * (shortNet.avg - lastPrice) : 0;
  const finalUpnl = finalUpnlLong + finalUpnlShort;
  const finalEq = wallet + finalUpnl;
  const roi = ((finalEq - INITIAL_CAPITAL) / INITIAL_CAPITAL) * 100;
  const maxDD = peak - trough;

  return { name, liquidated, liqAtMs, totalAddsLong, totalAddsShort, totalCloses, totalRealizedPnl, totalFees, finalLong: longNet, finalShort: shortNet, lastPrice, finalUpnlLong, finalUpnlShort, finalUpnl, wallet, finalEq, roi, maxDD, peak, trough, winCount, lossCount, events };
}

function main() {
  console.log("[hedge02-improve] Loading...");
  const c5 = loadCache("5m");
  const c4h = loadCache("4h");
  const c1h = loadCache("1h");
  const c1d = loadCache("1d");

  const setups = [
    { name: "1. Baseline (no improve)", opts: { useTP: false, useReversalFilter: false, useHTFTrendFilter: false } },
    { name: "2. +A: TP + 30d stop", opts: { useTP: true, useReversalFilter: false, useHTFTrendFilter: false } },
    { name: "3. +B: Reversal filter", opts: { useTP: false, useReversalFilter: true, useHTFTrendFilter: false } },
    { name: "4. +C: HTF trend filter", opts: { useTP: false, useReversalFilter: false, useHTFTrendFilter: true } },
    { name: "5. A + B", opts: { useTP: true, useReversalFilter: true, useHTFTrendFilter: false } },
    { name: "6. A + C", opts: { useTP: true, useReversalFilter: false, useHTFTrendFilter: true } },
    { name: "7. A + B + C (recommend)", opts: { useTP: true, useReversalFilter: true, useHTFTrendFilter: true } },
  ];

  const results: Result[] = [];
  for (const su of setups) {
    console.log(`\n[${su.name}]`);
    const r = simulate(su.name, c5, c4h, c1h, c1d, su.opts);
    results.push(r);
    const wr = r.winCount + r.lossCount;
    console.log(`  ROI ${r.roi.toFixed(2)}% · ADD L${r.totalAddsLong}/S${r.totalAddsShort} · CLOSES ${r.totalCloses} · WR ${wr>0?`${r.winCount}/${wr} (${(r.winCount/wr*100).toFixed(0)}%)`:"—"} · Realized $${r.totalRealizedPnl.toFixed(0)} · uPnL ${r.finalUpnl>=0?"+":""}$${r.finalUpnl.toFixed(0)} · DD $${r.maxDD.toFixed(0)} · LIQ ${r.liquidated}`);
  }

  console.log("\n=== COMPARISON SORTED BY ROI ===");
  console.log("Setup                                  ROI%      Realized      uPnL          EQUITY      DD$       Trades  CLOSES  WR%   LIQ");
  results.sort((a, b) => b.roi - a.roi);
  for (const r of results) {
    const wr = r.winCount + r.lossCount;
    console.log(`${r.name.padEnd(40)}${r.roi.toFixed(2).padStart(8)}% ${('$'+r.totalRealizedPnl.toFixed(0)).padStart(12)} ${((r.finalUpnl>=0?'+':'')+'$'+r.finalUpnl.toFixed(0)).padStart(12)} ${('$'+r.finalEq.toFixed(0)).padStart(11)}  $${r.maxDD.toFixed(0).padStart(7)}  ${(r.totalAddsLong+r.totalAddsShort).toString().padStart(6)}  ${r.totalCloses.toString().padStart(6)}  ${wr>0?(r.winCount/wr*100).toFixed(0).padStart(4):"  —"}  ${r.liquidated?"YES":"NO"}`);
  }

  const priceLine: { ts: number; price: number }[] = [];
  const step = 10;
  for (let i = 0; i < c5.length; i += step) priceLine.push({ ts: c5[i].time, price: c5[i].close });

  const out = {
    period: { start: c5[0].time, end: c5[c5.length - 1].time },
    initialCapital: INITIAL_CAPITAL,
    results,
    priceLine,
  };
  writeFileSync(join(__dirname, "..", "assets", "backtest_hedge02_improve_3y.json"), JSON.stringify(out));
  console.log("\nSaved → assets/backtest_hedge02_improve_3y.json");
}

main();
