/**
 * backtest-setup-15-16.ts — Standalone backtest 2 new setups:
 *   #15 Funding Arbitrage — fade crowded longs/shorts via funding rate
 *   #16 Liquidation Cascade Fade — fade extreme moves (proxy via price+vol)
 *
 * Period: 3y (2023-05 → 2026-04), capital $100k, fee 0.05%
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const INITIAL_CAPITAL = 100_000;
const FEE_PCT = 0.05;

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }
interface FundingPoint { time: number; rate: number; mark: number; }
interface Trade { entryTs: number; exitTs: number; side: "LONG" | "SHORT"; entry: number; exit: number; qty: number; pnl: number; reason: string; signal: string; }

function loadCache(tf: string): Candle[] {
  return JSON.parse(readFileSync(join(__dirname, "..", ".cache", `binance-${tf}-3y.json`), "utf8"));
}
function loadFunding(): FundingPoint[] {
  return JSON.parse(readFileSync(join(__dirname, "..", ".cache", "binance-funding-3y.json"), "utf8"));
}
function calcSMA(a: number[], p: number): (number | null)[] {
  const o: (number | null)[] = new Array(a.length).fill(null); if (a.length < p) return o;
  let s = 0; for (let i = 0; i < p; i++) s += a[i]; o[p - 1] = s / p;
  for (let i = p; i < a.length; i++) { s += a[i] - a[i - p]; o[i] = s / p; } return o;
}
function calcATR(c: Candle[], p: number): (number | null)[] {
  const o: (number | null)[] = new Array(c.length).fill(null); if (c.length <= p) return o;
  const tr: number[] = new Array(c.length).fill(0);
  for (let i = 1; i < c.length; i++) tr[i] = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
  let s = 0; for (let i = 1; i <= p; i++) s += tr[i]; o[p] = s / p;
  for (let i = p + 1; i < c.length; i++) o[i] = (o[i - 1]! * (p - 1) + tr[i]) / p; return o;
}
function findIdx(arr: { time: number }[], ts: number, hint: number = 0): number {
  let lo = hint, hi = arr.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (arr[mid].time <= ts) lo = mid; else hi = mid - 1; }
  return lo;
}

function summarize(name: string, trades: Trade[], finalWallet: number, hwm: number, lowest: number): any {
  const roi = (finalWallet - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100;
  const dd = (hwm - lowest) / hwm * 100;
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
  const wr = trades.length > 0 ? wins.length / trades.length * 100 : 0;
  const avgW = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgL = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  const ra = dd > 0 ? roi / dd : (roi > 0 ? 999 : 0);
  const exp = trades.length > 0 ? (wr / 100 * avgW + (1 - wr / 100) * avgL) : 0;
  const byYear: Record<string, number> = {};
  for (const t of trades) {
    const y = new Date(t.exitTs).toISOString().slice(0, 4);
    byYear[y] = (byYear[y] ?? 0) + t.pnl;
  }
  return {
    name, roi: +roi.toFixed(2), dd: +dd.toFixed(2), ra: +ra.toFixed(2),
    trades: trades.length, wr: +wr.toFixed(2),
    avgW: +avgW.toFixed(2), avgL: +avgL.toFixed(2),
    rr: avgL < 0 ? +(avgW / -avgL).toFixed(2) : 0,
    exp: +exp.toFixed(2),
    byYear: Object.fromEntries(Object.entries(byYear).map(([k, v]) => [k, Math.round(v)])),
  };
}

// === Setup #15: Funding Arbitrage ===
// SHORT khi avg funding 24h (3 funding events) > +0.05%/8h
// LONG khi avg funding 24h < -0.005%/8h
// Time stop 5 days OR funding revert to ±0.02%
function runSetup15(c5: Candle[], funding: FundingPoint[], longTh: number, shortTh: number, exitTh: number, qty: number, slPct: number, tpPct: number, timeStopDays: number): { trades: Trade[]; wallet: number; hwm: number; lowest: number } {
  let wallet = INITIAL_CAPITAL, hwm = INITIAL_CAPITAL, lowest = INITIAL_CAPITAL;
  const trades: Trade[] = [];
  interface Pos { side: "LONG" | "SHORT"; entry: number; entryTs: number; tpPx: number; slPx: number; expireTs: number; qty: number; }
  let pos: Pos | null = null;
  let fIdx = 0;
  let lastEntryTs = 0;
  const COOLDOWN = 8 * 60 * 60_000;  // 1 funding cycle

  for (let i = 0; i < c5.length; i++) {
    const bar = c5[i]; const ts = bar.time; const mark = bar.close;

    // Close current position
    if (pos) {
      let exit = false; let reason = "";
      if (pos.side === "LONG") {
        if (bar.high >= pos.tpPx) { exit = true; reason = "TP"; }
        else if (bar.low <= pos.slPx) { exit = true; reason = "SL"; }
      } else {
        if (bar.low <= pos.tpPx) { exit = true; reason = "TP"; }
        else if (bar.high >= pos.slPx) { exit = true; reason = "SL"; }
      }
      if (!exit && ts >= pos.expireTs) { exit = true; reason = "TIME"; }
      // Funding revert exit
      if (!exit) {
        fIdx = findIdx(funding, ts, fIdx);
        const recentF = funding.slice(Math.max(0, fIdx - 2), fIdx + 1);
        const avgF = recentF.reduce((s, f) => s + f.rate, 0) / Math.max(1, recentF.length);
        if (pos.side === "SHORT" && avgF < exitTh) { exit = true; reason = "REVERT"; }
        if (pos.side === "LONG" && avgF > -exitTh) { exit = true; reason = "REVERT"; }
      }
      if (exit) {
        const exitPx = reason === "TP" ? pos.tpPx : reason === "SL" ? pos.slPx : bar.close;
        const pnl = (pos.side === "LONG" ? exitPx - pos.entry : pos.entry - exitPx) * pos.qty;
        const fee = pos.qty * (pos.entry + exitPx) * FEE_PCT / 100;
        const net = pnl - fee;
        wallet += net;
        if (wallet > hwm) hwm = wallet;
        if (wallet < lowest) lowest = wallet;
        trades.push({ entryTs: pos.entryTs, exitTs: ts, side: pos.side, entry: pos.entry, exit: exitPx, qty: pos.qty, pnl: net, reason, signal: "s15" });
        pos = null;
      }
    }
    if (pos || ts - lastEntryTs < COOLDOWN) continue;

    // Funding lookup: avg last 3 funding events (24h)
    fIdx = findIdx(funding, ts, fIdx);
    if (fIdx < 3) continue;
    const recent = funding.slice(fIdx - 2, fIdx + 1);
    const avgF = recent.reduce((s, f) => s + f.rate, 0) / 3;

    if (avgF >= shortTh) {
      pos = {
        side: "SHORT", entry: mark, entryTs: ts, qty,
        tpPx: mark * (1 - tpPct / 100), slPx: mark * (1 + slPct / 100),
        expireTs: ts + timeStopDays * 24 * 60 * 60_000,
      };
      lastEntryTs = ts;
    } else if (avgF <= longTh) {
      pos = {
        side: "LONG", entry: mark, entryTs: ts, qty,
        tpPx: mark * (1 + tpPct / 100), slPx: mark * (1 - slPct / 100),
        expireTs: ts + timeStopDays * 24 * 60 * 60_000,
      };
      lastEntryTs = ts;
    }
  }

  if (pos) {
    const last = c5[c5.length - 1];
    const pnl = (pos.side === "LONG" ? last.close - pos.entry : pos.entry - last.close) * pos.qty;
    wallet += pnl;
    trades.push({ entryTs: pos.entryTs, exitTs: last.time, side: pos.side, entry: pos.entry, exit: last.close, qty: pos.qty, pnl, reason: "FORCE", signal: "s15" });
  }
  return { trades, wallet, hwm, lowest };
}

// === Setup #16: Liquidation Cascade Fade (proxy via price + vol spike) ===
// Detect: 1h move > 3% + vol > 2× avg → fade direction
function runSetup16(c5: Candle[], priceMoveThPct: number, volRatioTh: number, qty: number, slPct: number, tpPct: number, cooldownHours: number): { trades: Trade[]; wallet: number; hwm: number; lowest: number } {
  let wallet = INITIAL_CAPITAL, hwm = INITIAL_CAPITAL, lowest = INITIAL_CAPITAL;
  const trades: Trade[] = [];
  interface Pos { side: "LONG" | "SHORT"; entry: number; entryTs: number; tpPx: number; slPx: number; expireTs: number; qty: number; }
  let pos: Pos | null = null;
  let lastEntryLongTs = 0, lastEntryShortTs = 0;
  const COOLDOWN = cooldownHours * 60 * 60_000;

  // Pre-compute avg vol 20-bar rolling
  const volMA: (number | null)[] = new Array(c5.length).fill(null);
  for (let i = 19; i < c5.length; i++) {
    let s = 0; for (let j = i - 19; j <= i; j++) s += c5[j].volume ?? 0;
    volMA[i] = s / 20;
  }

  for (let i = 12; i < c5.length; i++) {
    const bar = c5[i]; const ts = bar.time; const mark = bar.close;

    // Close
    if (pos) {
      let exit = false; let reason = "";
      if (pos.side === "LONG") {
        if (bar.high >= pos.tpPx) { exit = true; reason = "TP"; }
        else if (bar.low <= pos.slPx) { exit = true; reason = "SL"; }
      } else {
        if (bar.low <= pos.tpPx) { exit = true; reason = "TP"; }
        else if (bar.high >= pos.slPx) { exit = true; reason = "SL"; }
      }
      if (!exit && ts >= pos.expireTs) { exit = true; reason = "TIME"; }
      if (exit) {
        const exitPx = reason === "TP" ? pos.tpPx : reason === "SL" ? pos.slPx : bar.close;
        const pnl = (pos.side === "LONG" ? exitPx - pos.entry : pos.entry - exitPx) * pos.qty;
        const fee = pos.qty * (pos.entry + exitPx) * FEE_PCT / 100;
        const net = pnl - fee;
        wallet += net;
        if (wallet > hwm) hwm = wallet;
        if (wallet < lowest) lowest = wallet;
        trades.push({ entryTs: pos.entryTs, exitTs: ts, side: pos.side, entry: pos.entry, exit: exitPx, qty: pos.qty, pnl: net, reason, signal: "s16" });
        pos = null;
      }
    }
    if (pos) continue;

    // Detect cascade
    const prev1h = c5[i - 12].close;
    const change1h = (mark - prev1h) / prev1h * 100;
    const vol = c5[i].volume ?? 0;
    const vmAvg = volMA[i] ?? 0;
    if (vmAvg <= 0) continue;
    const volRatio = vol / vmAvg;

    if (volRatio < volRatioTh) continue;

    if (change1h <= -priceMoveThPct && ts - lastEntryLongTs > COOLDOWN) {
      // Fade LONG
      pos = {
        side: "LONG", entry: mark, entryTs: ts, qty,
        tpPx: mark * (1 + tpPct / 100), slPx: mark * (1 - slPct / 100),
        expireTs: ts + 24 * 60 * 60_000,  // 1 day time stop
      };
      lastEntryLongTs = ts;
    } else if (change1h >= priceMoveThPct && ts - lastEntryShortTs > COOLDOWN) {
      // Fade SHORT
      pos = {
        side: "SHORT", entry: mark, entryTs: ts, qty,
        tpPx: mark * (1 - tpPct / 100), slPx: mark * (1 + slPct / 100),
        expireTs: ts + 24 * 60 * 60_000,
      };
      lastEntryShortTs = ts;
    }
  }

  if (pos) {
    const last = c5[c5.length - 1];
    const pnl = (pos.side === "LONG" ? last.close - pos.entry : pos.entry - last.close) * pos.qty;
    wallet += pnl;
    trades.push({ entryTs: pos.entryTs, exitTs: last.time, side: pos.side, entry: pos.entry, exit: last.close, qty: pos.qty, pnl, reason: "FORCE", signal: "s16" });
  }
  return { trades, wallet, hwm, lowest };
}

function main() {
  console.log("[s15-16] Loading...");
  const c5 = loadCache("5m");
  const funding = loadFunding();
  console.log(`  5m bars: ${c5.length}, funding entries: ${funding.length}`);

  const results: any[] = [];

  console.log("\n[s15] Setup #15 Funding Arb — sweep thresholds...");
  // Sweep: SHORT threshold, LONG threshold, qty, SL, TP
  const s15Variants = [
    { name: "s15_th005_qty01_sl3_tp5_5d",    longTh: -0.0001, shortTh: 0.0005, exitTh: 0.0001, qty: 0.1, sl: 3, tp: 5, days: 5 },
    { name: "s15_th01_qty01_sl3_tp5_5d",     longTh: -0.0001, shortTh: 0.0008,  exitTh: 0.0001, qty: 0.1, sl: 3, tp: 5, days: 5 },
    { name: "s15_th005_qty005_sl2_tp4_3d",   longTh: -0.0001, shortTh: 0.0005, exitTh: 0.0001, qty: 0.05, sl: 2, tp: 4, days: 3 },
    { name: "s15_th003_qty01_sl3_tp6_5d",    longTh: -0.0001, shortTh: 0.0003, exitTh: 0.0001, qty: 0.1, sl: 3, tp: 6, days: 5 },
    { name: "s15_th005_qty02_sl2_tp3_2d",    longTh: -0.0001, shortTh: 0.0005, exitTh: 0.0001, qty: 0.2, sl: 2, tp: 3, days: 2 },
  ];
  for (const v of s15Variants) {
    const r = runSetup15(c5, funding, v.longTh, v.shortTh, v.exitTh, v.qty, v.sl, v.tp, v.days);
    results.push(summarize(v.name, r.trades, r.wallet, r.hwm, r.lowest));
  }

  console.log("\n[s16] Setup #16 Liq Cascade Fade — sweep thresholds...");
  const s16Variants = [
    { name: "s16_drop3_vol2_qty01_sl15_tp2_4h",  drop: 3, vol: 2, qty: 0.1, sl: 1.5, tp: 2, cd: 4 },
    { name: "s16_drop2_vol25_qty01_sl1_tp15_4h", drop: 2, vol: 2.5, qty: 0.1, sl: 1.0, tp: 1.5, cd: 4 },
    { name: "s16_drop4_vol3_qty02_sl2_tp3_8h",   drop: 4, vol: 3, qty: 0.2, sl: 2.0, tp: 3.0, cd: 8 },
    { name: "s16_drop3_vol2_qty01_sl2_tp4_4h",   drop: 3, vol: 2, qty: 0.1, sl: 2.0, tp: 4.0, cd: 4 },
    { name: "s16_drop25_vol2_qty01_sl15_tp3_4h", drop: 2.5, vol: 2, qty: 0.1, sl: 1.5, tp: 3.0, cd: 4 },
  ];
  for (const v of s16Variants) {
    const r = runSetup16(c5, v.drop, v.vol, v.qty, v.sl, v.tp, v.cd);
    results.push(summarize(v.name, r.trades, r.wallet, r.hwm, r.lowest));
  }

  // Sort by RA descending
  results.sort((a, b) => b.ra - a.ra);

  console.log("\n=== SETUP #15 + #16 SWEEP (capital $100k, 3y) ===");
  console.log("Variant                          | ROI%    | DD%    | RA    | Trades | WR%   | R:R  | Exp/trade");
  console.log("-".repeat(110));
  for (const r of results) {
    console.log(`${r.name.padEnd(32)} | ${String(r.roi).padStart(7)} | ${String(r.dd).padStart(6)} | ${String(r.ra).padStart(5)} | ${String(r.trades).padStart(6)} | ${String(r.wr).padStart(5)} | ${String(r.rr).padStart(4)} | ${String(r.exp).padStart(8)}`);
  }

  console.log("\n=== PER-YEAR TOP 5 ===");
  console.log("Variant                          | 2023    | 2024    | 2025    | 2026");
  console.log("-".repeat(85));
  for (let i = 0; i < Math.min(5, results.length); i++) {
    const r = results[i];
    const y = (k: string) => r.byYear[k] ?? "-";
    console.log(`${r.name.padEnd(32)} | ${String(y("2023")).padStart(7)} | ${String(y("2024")).padStart(7)} | ${String(y("2025")).padStart(7)} | ${String(y("2026")).padStart(7)}`);
  }

  writeFileSync(join(__dirname, "..", "assets", "backtest_setup_15_16.json"), JSON.stringify(results, null, 2));
  console.log(`\nWritten assets/backtest_setup_15_16.json`);
}

main();
