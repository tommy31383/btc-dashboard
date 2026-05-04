/**
 * backtest-hedge-all.ts (anh Tommy 2026-05-04)
 *
 * Backtest CẢ 3 rule Hedge01/02/03 cùng setup → so sánh fair:
 *   - Capital $100k, 0.001 BTC/ADD, lev 125x cross hedge, fee 0.05%/side
 *   - Period: 3 năm (Apr 2023 → Apr 2026)
 *
 * Hedge01: TREND FOLLOW MULTI-TF (weekly trend + S/R touch, close on flip)
 * Hedge02: BB WICK HEDGE NO-CLOSE 4H (winner from sweep)
 * Hedge03: SKELETON (return null) — no trades
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const INITIAL_CAPITAL = 100000;
const MIN_QTY_BTC = 0.001;
const FEE_PER_SIDE_PCT = 0.05;
const MAINT_MARGIN_RATE = 0.004;

interface Candle { time: number; open: number; high: number; low: number; close: number; }
interface Net { qty: number; avg: number; }

function loadCache(tf: string): Candle[] {
  const p = join(__dirname, "..", ".cache", `binance-${tf}-3y.json`);
  if (!existsSync(p)) throw new Error(`Missing ${p}`);
  return JSON.parse(readFileSync(p, "utf8"));
}

function findIndexAtOrBefore(arr: { time: number }[], t: number): number {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (arr[m].time <= t) { ans = m; lo = m + 1; } else hi = m - 1;
  }
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
function detectSwingLevels(candles: Candle[], n: number): { lows: number[]; highs: number[] } {
  const lows: number[] = [], highs: number[] = [];
  for (let i = n; i < candles.length - n; i++) {
    let isLow = true, isHigh = true;
    for (let j = i - n; j <= i + n; j++) {
      if (j === i) continue;
      if (candles[j].low <= candles[i].low) isLow = false;
      if (candles[j].high >= candles[i].high) isHigh = false;
    }
    if (isLow) lows.push(candles[i].low);
    if (isHigh) highs.push(candles[i].high);
  }
  return { lows: lows.sort((a, b) => a - b), highs: highs.sort((a, b) => a - b) };
}
function nearLevel(price: number, levels: number[], tolPct: number): boolean {
  const tol = price * (tolPct / 100);
  for (const lv of levels) if (Math.abs(lv - price) <= tol) return true;
  return false;
}
function getWeeklyTrend(c1w: Candle[], t: number): "UP" | "DOWN" | null {
  const idx = findIndexAtOrBefore(c1w, t);
  if (idx < 2) return null;
  return c1w[idx - 1].close > c1w[idx - 2].close ? "UP" : "DOWN";
}
function addNet(n: Net, qty: number, price: number): Net {
  const newQty = n.qty + qty;
  return { qty: newQty, avg: newQty > 0 ? (n.qty * n.avg + qty * price) / newQty : 0 };
}

interface Event { ts: number; kind: "ADD" | "CLOSE"; side: "LONG" | "SHORT"; price: number; qty: number; avgAfter: number; realizedPnl?: number; reason?: string; }

interface Result {
  key: string; name: string;
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

function newState(): Result & { lastAddLongMs: number; lastAddShortMs: number; lastEntryMs: number; prevTrend: "UP"|"DOWN"|null } {
  return {
    key: "", name: "", liquidated: false, liqAtMs: 0,
    totalAddsLong: 0, totalAddsShort: 0, totalCloses: 0,
    totalRealizedPnl: 0, totalFees: 0,
    finalLong: { qty: 0, avg: 0 }, finalShort: { qty: 0, avg: 0 }, lastPrice: 0,
    finalUpnlLong: 0, finalUpnlShort: 0, finalUpnl: 0,
    wallet: INITIAL_CAPITAL, finalEq: 0,
    roi: 0, maxDD: 0, peak: INITIAL_CAPITAL, trough: INITIAL_CAPITAL,
    winCount: 0, lossCount: 0, events: [],
    lastAddLongMs: 0, lastAddShortMs: 0, lastEntryMs: 0, prevTrend: null,
  };
}

function applyAdd(s: any, side: "LONG"|"SHORT", price: number, ts: number, reason?: string) {
  const qty = MIN_QTY_BTC;
  const fee = qty * price * (FEE_PER_SIDE_PCT / 100);
  if (side === "LONG") {
    s.finalLong = addNet(s.finalLong, qty, price);
    s.totalAddsLong++;
    s.lastAddLongMs = ts;
    s.events.push({ ts, kind: "ADD", side, price, qty, avgAfter: s.finalLong.avg, reason });
  } else {
    s.finalShort = addNet(s.finalShort, qty, price);
    s.totalAddsShort++;
    s.lastAddShortMs = ts;
    s.events.push({ ts, kind: "ADD", side, price, qty, avgAfter: s.finalShort.avg, reason });
  }
  s.wallet -= fee; s.totalFees += fee; s.lastEntryMs = ts;
}

function applyCloseAll(s: any, side: "LONG"|"SHORT", price: number, ts: number) {
  const net = side === "LONG" ? s.finalLong : s.finalShort;
  if (net.qty <= 0) return;
  const realized = side === "LONG" ? net.qty * (price - net.avg) : net.qty * (net.avg - price);
  const fee = net.qty * price * (FEE_PER_SIDE_PCT / 100);
  const netPnl = realized - fee;
  s.wallet += netPnl;
  s.totalRealizedPnl += realized;
  s.totalFees += fee;
  s.totalCloses++;
  if (netPnl >= 0) s.winCount++; else s.lossCount++;
  s.events.push({ ts, kind: "CLOSE", side, price, qty: net.qty, avgAfter: net.avg, realizedPnl: netPnl });
  if (side === "LONG") s.finalLong = { qty: 0, avg: 0 };
  else s.finalShort = { qty: 0, avg: 0 };
}

function checkLiqAndStats(s: any, price: number, ts: number) {
  let upnl = 0;
  if (s.finalLong.qty > 0) upnl += s.finalLong.qty * (price - s.finalLong.avg);
  if (s.finalShort.qty > 0) upnl += s.finalShort.qty * (s.finalShort.avg - price);
  const eq = s.wallet + upnl;
  if (eq > s.peak) s.peak = eq;
  if (eq < s.trough) s.trough = eq;
  if (s.finalLong.qty + s.finalShort.qty > 0) {
    const mm = (s.finalLong.qty + s.finalShort.qty) * price * MAINT_MARGIN_RATE;
    if (eq <= mm) { s.liquidated = true; s.liqAtMs = ts; return true; }
  }
  return false;
}

// ============ HEDGE01 — TREND FOLLOW MULTI-TF ============
function runHedge01(c5: Candle[], c15: Candle[], c1h: Candle[], c4h: Candle[], c1d: Candle[], c1w: Candle[]): Result {
  const PIVOT_N = 10, TOUCH_PCT = 0.4, COOLDOWN_MS = 60 * 60_000;
  const sr15 = detectSwingLevels(c15, PIVOT_N);
  const sr1h = detectSwingLevels(c1h, PIVOT_N);
  const sr4h = detectSwingLevels(c4h, PIVOT_N);
  const sr1d = detectSwingLevels(c1d, PIVOT_N);
  const supports = [...sr15.lows, ...sr1h.lows, ...sr4h.lows, ...sr1d.lows];
  const resistances = [...sr15.highs, ...sr1h.highs, ...sr4h.highs, ...sr1d.highs];
  const s: any = newState();
  s.key = "hedge01"; s.name = "Hedge01 — TREND FOLLOW MULTI-TF";

  for (let i = 100; i < c5.length; i++) {
    const bar = c5[i]; const price = bar.close; const ts = bar.time;
    const trend = getWeeklyTrend(c1w, ts);
    if (!trend) continue;
    if (s.prevTrend && trend !== s.prevTrend) {
      if (trend === "UP" && s.finalShort.qty > 0) applyCloseAll(s, "SHORT", price, ts);
      else if (trend === "DOWN" && s.finalLong.qty > 0) applyCloseAll(s, "LONG", price, ts);
    }
    s.prevTrend = trend;
    const longCool = ts - s.lastAddLongMs >= COOLDOWN_MS;
    const shortCool = ts - s.lastAddShortMs >= COOLDOWN_MS;
    if (trend === "UP" && longCool && s.finalShort.qty === 0) {
      if (nearLevel(price, supports, TOUCH_PCT)) applyAdd(s, "LONG", price, ts, "support");
    } else if (trend === "DOWN" && shortCool && s.finalLong.qty === 0) {
      if (nearLevel(price, resistances, TOUCH_PCT)) applyAdd(s, "SHORT", price, ts, "resistance");
    }
    if (checkLiqAndStats(s, price, ts)) break;
  }
  return finalize(s, c5);
}

// ============ HEDGE02 — BB WICK HEDGE NO-CLOSE 4H ============
function runHedge02(c5: Candle[], c4h: Candle[]): Result {
  const BB_PERIOD = 20, BB_STD = 2, COOLDOWN_MS = 4 * 60 * 60_000;
  const closes4h = c4h.map((b) => b.close);
  const sma = calcSMA(closes4h, BB_PERIOD);
  const sd = calcStdev(closes4h, BB_PERIOD, sma);
  const s: any = newState();
  s.key = "hedge02"; s.name = "Hedge02 — BB WICK HEDGE NO-CLOSE 4H";

  // Build events from 4H bars then replay on 5m for accurate LIQ
  const events4h: { ts: number; side: "LONG"|"SHORT"; price: number }[] = [];
  for (let i = BB_PERIOD; i < c4h.length; i++) {
    const m = sma[i], sdv = sd[i]; if (m === null || sdv === null) continue;
    const upper = m + BB_STD * sdv, lower = m - BB_STD * sdv;
    const bar = c4h[i];
    if (bar.low <= lower) events4h.push({ ts: bar.time, side: "LONG", price: bar.close });
    if (bar.high >= upper) events4h.push({ ts: bar.time, side: "SHORT", price: bar.close });
  }
  const evByTs = new Map<number, typeof events4h>();
  for (const e of events4h) { const a = evByTs.get(e.ts) || []; a.push(e); evByTs.set(e.ts, a); }
  for (let i = 0; i < c5.length; i++) {
    const bar = c5[i]; const price = bar.close; const ts = bar.time;
    const evs = evByTs.get(ts);
    if (evs) for (const e of evs) {
      const cool = e.side === "LONG" ? ts - s.lastAddLongMs >= COOLDOWN_MS : ts - s.lastAddShortMs >= COOLDOWN_MS;
      if (cool) applyAdd(s, e.side, e.price, ts, "wick");
    }
    if (checkLiqAndStats(s, price, ts)) break;
  }
  return finalize(s, c5);
}

// ============ HEDGE03 — SKELETON (no-op) ============
function runHedge03(c5: Candle[]): Result {
  const s: any = newState();
  s.key = "hedge03"; s.name = "Hedge03 — SKELETON (placeholder)";
  // Walk price for stats only
  for (let i = 100; i < c5.length; i++) checkLiqAndStats(s, c5[i].close, c5[i].time);
  return finalize(s, c5);
}

function finalize(s: any, c5: Candle[]): Result {
  const lastPrice = c5[c5.length - 1].close;
  s.lastPrice = lastPrice;
  s.finalUpnlLong = s.finalLong.qty > 0 ? s.finalLong.qty * (lastPrice - s.finalLong.avg) : 0;
  s.finalUpnlShort = s.finalShort.qty > 0 ? s.finalShort.qty * (s.finalShort.avg - lastPrice) : 0;
  s.finalUpnl = s.finalUpnlLong + s.finalUpnlShort;
  s.finalEq = s.wallet + s.finalUpnl;
  s.roi = ((s.finalEq - INITIAL_CAPITAL) / INITIAL_CAPITAL) * 100;
  s.maxDD = s.peak - s.trough;
  return s;
}

function main() {
  console.log("[hedge-all] Loading klines...");
  const c5 = loadCache("5m");
  const c15 = loadCache("15m");
  const c1h = loadCache("1h");
  const c4h = loadCache("4h");
  const c1d = loadCache("1d");
  const c1w = loadCache("1w");

  console.log("\n[hedge-all] Running Hedge01...");
  const r1 = runHedge01(c5, c15, c1h, c4h, c1d, c1w);
  console.log(`  ROI ${r1.roi.toFixed(2)}% · ADD L${r1.totalAddsLong}/S${r1.totalAddsShort} · CLOSES ${r1.totalCloses} · Realized $${r1.totalRealizedPnl.toFixed(0)} · WR ${r1.winCount}/${r1.winCount+r1.lossCount} · DD $${r1.maxDD.toFixed(0)} · LIQ ${r1.liquidated}`);

  console.log("\n[hedge-all] Running Hedge02...");
  const r2 = runHedge02(c5, c4h);
  console.log(`  ROI ${r2.roi.toFixed(2)}% · ADD L${r2.totalAddsLong}/S${r2.totalAddsShort} · CLOSES ${r2.totalCloses} · Realized $${r2.totalRealizedPnl.toFixed(0)} · DD $${r2.maxDD.toFixed(0)} · LIQ ${r2.liquidated}`);

  console.log("\n[hedge-all] Running Hedge03 (skeleton)...");
  const r3 = runHedge03(c5);
  console.log(`  ROI ${r3.roi.toFixed(2)}% · ADD ${r3.totalAddsLong+r3.totalAddsShort} · (no-op placeholder)`);

  console.log("\n=== COMPARISON ===");
  console.log("Rule       ROI%       Realized      Final uPnL    DD$       Trades      LIQ");
  for (const r of [r1, r2, r3]) {
    console.log(`${r.key.padEnd(9)} ${r.roi.toFixed(2).padStart(7)}%   ${('$'+r.totalRealizedPnl.toFixed(0)).padStart(11)}   ${(r.finalUpnl>=0?'+':'')+'$'+r.finalUpnl.toFixed(0).padStart(7)}   $${r.maxDD.toFixed(0).padStart(7)}   ${(r.totalAddsLong+r.totalAddsShort).toString().padStart(6)}/${r.totalCloses}   ${r.liquidated?'YES':'NO'}`);
  }

  const priceLine: { ts: number; price: number }[] = [];
  const step = 10;
  for (let i = 0; i < c5.length; i += step) priceLine.push({ ts: c5[i].time, price: c5[i].close });

  const out = {
    period: { start: c5[0].time, end: c5[c5.length - 1].time },
    initialCapital: INITIAL_CAPITAL,
    results: [r1, r2, r3],
    priceLine,
  };
  writeFileSync(join(__dirname, "..", "assets", "backtest_hedge_all_3y.json"), JSON.stringify(out));
  console.log("\nSaved → assets/backtest_hedge_all_3y.json");
}

main();
