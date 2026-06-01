/**
 * backtest-strategies-compare.ts — Compare 4 strategies trên 3y data.
 *
 * 1. hedge01-15m: baseline rule hiện tại (v0.4.33 simplified: SL -8%, MAX_QTY 0.05, score≥9, TP+10%)
 * 2. hedge01-1h: same logic nhưng eval trên 1h bars (less noise hypothesis)
 * 3. donchian-4h: Turtle breakout 20-bar Donchian channel, ATR-based SL
 * 4. ma-cross-4h: EMA50/EMA200 golden/death cross, hold until reverse
 * 5. atr-breakout-1h: close > prev_close + ATR(14)×1.5, ATR trailing SL
 *
 * Capital $100k, fee 0.05% taker, fixed qty per strategy theo risk %.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const INITIAL_CAPITAL = 100_000;
const FEE_PCT = 0.05;
const RISK_PER_TRADE_PCT = 1.0;  // $1000/trade ở $100k capital

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }
interface Trade { entryTs: number; exitTs: number; side: "LONG" | "SHORT"; entry: number; exit: number; qty: number; pnl: number; reason: string; }

function loadCache(tf: string): Candle[] {
  return JSON.parse(readFileSync(join(__dirname, "..", ".cache", `binance-${tf}-3y.json`), "utf8"));
}
function calcSMA(a: number[], p: number): (number | null)[] {
  const o: (number | null)[] = new Array(a.length).fill(null); if (a.length < p) return o;
  let s = 0; for (let i = 0; i < p; i++) s += a[i]; o[p - 1] = s / p;
  for (let i = p; i < a.length; i++) { s += a[i] - a[i - p]; o[i] = s / p; } return o;
}
function calcEMA(a: number[], p: number): (number | null)[] {
  const o: (number | null)[] = new Array(a.length).fill(null); if (a.length < p) return o;
  const k = 2 / (p + 1); let e = 0;
  for (let i = 0; i < p; i++) e += a[i]; e /= p; o[p - 1] = e;
  for (let i = p; i < a.length; i++) { e = a[i] * k + e * (1 - k); o[i] = e; } return o;
}
function calcATR(c: Candle[], p: number): (number | null)[] {
  const o: (number | null)[] = new Array(c.length).fill(null); if (c.length <= p) return o;
  const tr: number[] = new Array(c.length).fill(0);
  for (let i = 1; i < c.length; i++) tr[i] = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
  let s = 0; for (let i = 1; i <= p; i++) s += tr[i]; o[p] = s / p;
  for (let i = p + 1; i < c.length; i++) o[i] = (o[i - 1]! * (p - 1) + tr[i]) / p; return o;
}
function calcRSI(c: number[], p: number): (number | null)[] {
  const o: (number | null)[] = new Array(c.length).fill(null); if (c.length <= p) return o;
  let g = 0, l = 0; for (let i = 1; i <= p; i++) { const ch = c[i] - c[i - 1]; if (ch >= 0) g += ch; else l -= ch; }
  let ag = g / p, al = l / p; o[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = p + 1; i < c.length; i++) {
    const ch = c[i] - c[i - 1];
    ag = (ag * (p - 1) + Math.max(ch, 0)) / p; al = (al * (p - 1) + Math.max(-ch, 0)) / p;
    o[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  } return o;
}

function summarize(trades: Trade[], walletEnd: number, hwm: number, lowest: number): any {
  const roi = (walletEnd - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100;
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
    roi: +roi.toFixed(2), dd: +dd.toFixed(2), ra: +ra.toFixed(2),
    trades: trades.length, wr: +wr.toFixed(2),
    avgW: +avgW.toFixed(2), avgL: +avgL.toFixed(2),
    rr: avgL < 0 ? +(avgW / -avgL).toFixed(2) : 0,
    exp: +exp.toFixed(2),
    byYear: Object.fromEntries(Object.entries(byYear).map(([k, v]) => [k, Math.round(v)])),
  };
}

// === Strategy 1: hedge01 simplified (mean rev score≥9 + SL -8%) ===
function runHedge01(c: Candle[], rsi: (number | null)[], ma50: (number | null)[]): { trades: Trade[]; wallet: number; hwm: number; lowest: number } {
  let wallet = INITIAL_CAPITAL, hwm = INITIAL_CAPITAL, lowest = INITIAL_CAPITAL;
  const trades: Trade[] = [];
  let pos: { side: "LONG" | "SHORT"; entry: number; qty: number; entryTs: number; sl: number; tp: number } | null = null;
  let lastEntryTs = 0;
  const COOLDOWN = 60 * 60_000;
  for (let i = 50; i < c.length; i++) {
    const bar = c[i];
    if (pos) {
      const px = bar.close;
      let exit = false; let reason = "";
      if (pos.side === "LONG") {
        if (px >= pos.tp) { exit = true; reason = "TP"; }
        else if (px <= pos.sl) { exit = true; reason = "SL"; }
      } else {
        if (px <= pos.tp) { exit = true; reason = "TP"; }
        else if (px >= pos.sl) { exit = true; reason = "SL"; }
      }
      if (exit) {
        const pnl = (pos.side === "LONG" ? px - pos.entry : pos.entry - px) * pos.qty;
        const fee = pos.qty * (pos.entry + px) * FEE_PCT / 100;
        wallet += pnl - fee;
        if (wallet > hwm) hwm = wallet;
        if (wallet < lowest) lowest = wallet;
        trades.push({ entryTs: pos.entryTs, exitTs: bar.time, side: pos.side, entry: pos.entry, exit: px, qty: pos.qty, pnl: pnl - fee, reason });
        pos = null;
      }
    }
    if (pos || bar.time - lastEntryTs < COOLDOWN) continue;
    if (i < 50) continue;
    const r = rsi[i] ?? 50; const m = ma50[i];
    if (m === null) continue;
    const distMA = (bar.close - m) / m * 100;
    // Simple mean rev: RSI ≤ 30 + dist below MA → LONG; RSI ≥ 70 + dist above MA → SHORT
    if (r <= 30 && distMA <= -2) {
      const px = bar.close;
      const qty = (INITIAL_CAPITAL * RISK_PER_TRADE_PCT / 100) / (px * 0.08); // risk 1% / SL 8%
      pos = { side: "LONG", entry: px, qty, entryTs: bar.time, sl: px * 0.92, tp: px * 1.10 };
      lastEntryTs = bar.time;
    } else if (r >= 70 && distMA >= 2) {
      const px = bar.close;
      const qty = (INITIAL_CAPITAL * RISK_PER_TRADE_PCT / 100) / (px * 0.08);
      pos = { side: "SHORT", entry: px, qty, entryTs: bar.time, sl: px * 1.08, tp: px * 0.90 };
      lastEntryTs = bar.time;
    }
  }
  return { trades, wallet, hwm, lowest };
}

// === Strategy 2: Donchian 20-bar breakout (Turtle System 1) ===
function runDonchian(c: Candle[], atr: (number | null)[], lookback: number = 20, atrSlMult: number = 2): { trades: Trade[]; wallet: number; hwm: number; lowest: number } {
  let wallet = INITIAL_CAPITAL, hwm = INITIAL_CAPITAL, lowest = INITIAL_CAPITAL;
  const trades: Trade[] = [];
  let pos: { side: "LONG" | "SHORT"; entry: number; qty: number; entryTs: number; sl: number; highWatermark: number; lowWatermark: number } | null = null;

  for (let i = lookback + 1; i < c.length; i++) {
    const bar = c[i];
    const atrV = atr[i];
    if (!atrV) continue;

    // Compute Donchian high/low của lookback bars TRƯỚC bar hiện tại (no peek)
    let hi = -Infinity, lo = Infinity;
    for (let j = i - lookback; j < i; j++) { if (c[j].high > hi) hi = c[j].high; if (c[j].low < lo) lo = c[j].low; }

    if (pos) {
      const px = bar.close;
      // Trailing SL = chase highWatermark
      if (pos.side === "LONG") {
        if (px > pos.highWatermark) { pos.highWatermark = px; pos.sl = pos.highWatermark - atrV * atrSlMult; }
      } else {
        if (px < pos.lowWatermark) { pos.lowWatermark = px; pos.sl = pos.lowWatermark + atrV * atrSlMult; }
      }
      let exit = false; let reason = "TRAIL_SL";
      if (pos.side === "LONG" && px <= pos.sl) exit = true;
      else if (pos.side === "SHORT" && px >= pos.sl) exit = true;
      // Exit on opposite breakout
      if (pos.side === "LONG" && px <= lo) { exit = true; reason = "OPPOSITE"; }
      if (pos.side === "SHORT" && px >= hi) { exit = true; reason = "OPPOSITE"; }
      if (exit) {
        const pnl = (pos.side === "LONG" ? px - pos.entry : pos.entry - px) * pos.qty;
        const fee = pos.qty * (pos.entry + px) * FEE_PCT / 100;
        wallet += pnl - fee;
        if (wallet > hwm) hwm = wallet;
        if (wallet < lowest) lowest = wallet;
        trades.push({ entryTs: pos.entryTs, exitTs: bar.time, side: pos.side, entry: pos.entry, exit: px, qty: pos.qty, pnl: pnl - fee, reason });
        pos = null;
      }
    }
    if (pos) continue;
    const px = bar.close;
    const qty = (INITIAL_CAPITAL * RISK_PER_TRADE_PCT / 100) / (atrV * atrSlMult); // Turtle N-based
    if (px > hi) {
      pos = { side: "LONG", entry: px, qty, entryTs: bar.time, sl: px - atrV * atrSlMult, highWatermark: px, lowWatermark: px };
    } else if (px < lo) {
      pos = { side: "SHORT", entry: px, qty, entryTs: bar.time, sl: px + atrV * atrSlMult, highWatermark: px, lowWatermark: px };
    }
  }
  return { trades, wallet, hwm, lowest };
}

// === Strategy 3: MA cross EMA50/EMA200 ===
function runMACross(c: Candle[], e50: (number | null)[], e200: (number | null)[]): { trades: Trade[]; wallet: number; hwm: number; lowest: number } {
  let wallet = INITIAL_CAPITAL, hwm = INITIAL_CAPITAL, lowest = INITIAL_CAPITAL;
  const trades: Trade[] = [];
  let pos: { side: "LONG" | "SHORT"; entry: number; qty: number; entryTs: number } | null = null;

  for (let i = 201; i < c.length; i++) {
    const bar = c[i];
    const e50c = e50[i], e200c = e200[i];
    const e50p = e50[i - 1], e200p = e200[i - 1];
    if (e50c === null || e200c === null || e50p === null || e200p === null) continue;
    const goldenCross = e50p <= e200p && e50c > e200c;
    const deathCross = e50p >= e200p && e50c < e200c;

    if (pos) {
      // Exit on opposite cross
      let exit = false;
      if (pos.side === "LONG" && deathCross) exit = true;
      else if (pos.side === "SHORT" && goldenCross) exit = true;
      if (exit) {
        const px = bar.close;
        const pnl = (pos.side === "LONG" ? px - pos.entry : pos.entry - px) * pos.qty;
        const fee = pos.qty * (pos.entry + px) * FEE_PCT / 100;
        wallet += pnl - fee;
        if (wallet > hwm) hwm = wallet;
        if (wallet < lowest) lowest = wallet;
        trades.push({ entryTs: pos.entryTs, exitTs: bar.time, side: pos.side, entry: pos.entry, exit: px, qty: pos.qty, pnl: pnl - fee, reason: "OPPOSITE_CROSS" });
        pos = null;
      }
    }
    if (pos) continue;
    if (goldenCross) {
      const px = bar.close;
      // Sized: 1% risk assume SL 5%
      const qty = (INITIAL_CAPITAL * RISK_PER_TRADE_PCT / 100) / (px * 0.05);
      pos = { side: "LONG", entry: px, qty, entryTs: bar.time };
    } else if (deathCross) {
      const px = bar.close;
      const qty = (INITIAL_CAPITAL * RISK_PER_TRADE_PCT / 100) / (px * 0.05);
      pos = { side: "SHORT", entry: px, qty, entryTs: bar.time };
    }
  }
  return { trades, wallet, hwm, lowest };
}

// === Strategy 4: ATR Breakout (close > prev_close + ATR × 1.5) ===
function runATRBreakout(c: Candle[], atr: (number | null)[], mult: number = 1.5, atrSlMult: number = 2): { trades: Trade[]; wallet: number; hwm: number; lowest: number } {
  let wallet = INITIAL_CAPITAL, hwm = INITIAL_CAPITAL, lowest = INITIAL_CAPITAL;
  const trades: Trade[] = [];
  let pos: { side: "LONG" | "SHORT"; entry: number; qty: number; entryTs: number; sl: number; highWatermark: number; lowWatermark: number } | null = null;

  for (let i = 14 + 1; i < c.length; i++) {
    const bar = c[i];
    const atrV = atr[i]; if (!atrV) continue;
    const prev = c[i - 1];

    if (pos) {
      const px = bar.close;
      if (pos.side === "LONG") {
        if (px > pos.highWatermark) { pos.highWatermark = px; pos.sl = pos.highWatermark - atrV * atrSlMult; }
      } else {
        if (px < pos.lowWatermark) { pos.lowWatermark = px; pos.sl = pos.lowWatermark + atrV * atrSlMult; }
      }
      let exit = false;
      if (pos.side === "LONG" && px <= pos.sl) exit = true;
      if (pos.side === "SHORT" && px >= pos.sl) exit = true;
      if (exit) {
        const pnl = (pos.side === "LONG" ? px - pos.entry : pos.entry - px) * pos.qty;
        const fee = pos.qty * (pos.entry + px) * FEE_PCT / 100;
        wallet += pnl - fee;
        if (wallet > hwm) hwm = wallet;
        if (wallet < lowest) lowest = wallet;
        trades.push({ entryTs: pos.entryTs, exitTs: bar.time, side: pos.side, entry: pos.entry, exit: px, qty: pos.qty, pnl: pnl - fee, reason: "TRAIL_SL" });
        pos = null;
      }
    }
    if (pos) continue;
    const px = bar.close;
    const longTrig = prev.close + atrV * mult;
    const shortTrig = prev.close - atrV * mult;
    const qty = (INITIAL_CAPITAL * RISK_PER_TRADE_PCT / 100) / (atrV * atrSlMult);
    if (px > longTrig) {
      pos = { side: "LONG", entry: px, qty, entryTs: bar.time, sl: px - atrV * atrSlMult, highWatermark: px, lowWatermark: px };
    } else if (px < shortTrig) {
      pos = { side: "SHORT", entry: px, qty, entryTs: bar.time, sl: px + atrV * atrSlMult, highWatermark: px, lowWatermark: px };
    }
  }
  return { trades, wallet, hwm, lowest };
}

function main() {
  console.log("[compare] Loading...");
  const c15 = loadCache("15m");
  const c1h = loadCache("1h");
  const c4h = loadCache("4h");

  console.log("[compare] Pre-computing indicators...");
  const close15 = c15.map(b => b.close);
  const close1h = c1h.map(b => b.close);
  const close4h = c4h.map(b => b.close);
  const rsi15 = calcRSI(close15, 14);
  const rsi1h = calcRSI(close1h, 14);
  const ma50_15 = calcSMA(close15, 50);
  const ma50_1h = calcSMA(close1h, 50);
  const atr4h = calcATR(c4h, 14);
  const atr1h = calcATR(c1h, 14);
  const ema50_4h = calcEMA(close4h, 50);
  const ema200_4h = calcEMA(close4h, 200);

  const results: any[] = [];

  console.log("\n[compare] Running hedge01-15m simplified...");
  const r1 = runHedge01(c15, rsi15, ma50_15);
  results.push({ name: "hedge01-15m-simple", ...summarize(r1.trades, r1.wallet, r1.hwm, r1.lowest) });

  console.log("[compare] Running hedge01-1h simplified...");
  const r2 = runHedge01(c1h, rsi1h, ma50_1h);
  results.push({ name: "hedge01-1h-simple", ...summarize(r2.trades, r2.wallet, r2.hwm, r2.lowest) });

  console.log("[compare] Running Donchian-20 on 4h...");
  const r3 = runDonchian(c4h, atr4h, 20, 2);
  results.push({ name: "donchian-20-4h", ...summarize(r3.trades, r3.wallet, r3.hwm, r3.lowest) });

  console.log("[compare] Running Donchian-55 on 4h...");
  const r3b = runDonchian(c4h, atr4h, 55, 2);
  results.push({ name: "donchian-55-4h", ...summarize(r3b.trades, r3b.wallet, r3b.hwm, r3b.lowest) });

  console.log("[compare] Running EMA50/200 cross on 4h...");
  const r4 = runMACross(c4h, ema50_4h, ema200_4h);
  results.push({ name: "ema-cross-4h", ...summarize(r4.trades, r4.wallet, r4.hwm, r4.lowest) });

  console.log("[compare] Running ATR breakout on 1h...");
  const r5 = runATRBreakout(c1h, atr1h, 1.5, 2);
  results.push({ name: "atr-breakout-1h", ...summarize(r5.trades, r5.wallet, r5.hwm, r5.lowest) });

  console.log("[compare] Running ATR breakout on 4h...");
  const r6 = runATRBreakout(c4h, atr4h, 1.5, 2);
  results.push({ name: "atr-breakout-4h", ...summarize(r6.trades, r6.wallet, r6.hwm, r6.lowest) });

  console.log("\n=== STRATEGIES COMPARISON (capital $100k, 3y, risk 1%/trade) ===");
  console.log("Strategy              | ROI%     | DD%    | RA     | Trades | WR%    | AvgW   | AvgL    | R:R  | Exp/trade");
  console.log("-".repeat(115));
  for (const r of results) {
    console.log(`${r.name.padEnd(20)} | ${String(r.roi).padStart(8)} | ${String(r.dd).padStart(6)} | ${String(r.ra).padStart(6)} | ${String(r.trades).padStart(6)} | ${String(r.wr).padStart(6)} | ${String(r.avgW).padStart(6)} | ${String(r.avgL).padStart(7)} | ${String(r.rr).padStart(4)} | ${String(r.exp).padStart(8)}`);
  }

  console.log("\n=== PER-YEAR PnL ===");
  console.log("Strategy              | 2023      | 2024      | 2025      | 2026");
  console.log("-".repeat(85));
  for (const r of results) {
    const y23 = r.byYear["2023"] ?? "-";
    const y24 = r.byYear["2024"] ?? "-";
    const y25 = r.byYear["2025"] ?? "-";
    const y26 = r.byYear["2026"] ?? "-";
    console.log(`${r.name.padEnd(20)} | ${String(y23).padStart(9)} | ${String(y24).padStart(9)} | ${String(y25).padStart(9)} | ${String(y26).padStart(9)}`);
  }

  writeFileSync(join(__dirname, "..", "assets", "backtest_strategies_compare.json"), JSON.stringify(results, null, 2));
  console.log(`\nWritten assets/backtest_strategies_compare.json`);
}

main();
