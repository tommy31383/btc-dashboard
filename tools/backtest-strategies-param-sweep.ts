/**
 * backtest-strategies-param-sweep.ts — Comprehensive param sweep top 3 strategies.
 *
 * Sweep:
 *   EMA cross: TF ∈ {1h, 4h, 1d}, fast/slow ∈ {(20,50), (50,100), (50,200), (100,200)}
 *   Donchian:  TF ∈ {1h, 4h, 1d}, lookback ∈ {10, 20, 55, 100}
 *   ATR breakout: TF ∈ {1h, 4h, 1d}, mult ∈ {1.0, 1.5, 2.0, 2.5}
 *   + 2 Hybrid combos: EMA-cross-4h + Donchian-20-4h (capital split 50/50)
 *                      EMA-cross-4h + ATR-breakout-4h (capital split 50/50)
 *
 * Total: 12 EMA + 12 Donchian + 12 ATR + 2 hybrid = 38 variants
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const INITIAL_CAPITAL = 100_000;
const FEE_PCT = 0.05;
const RISK_PCT = 1.0;

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }
interface Trade { entryTs: number; exitTs: number; side: "LONG" | "SHORT"; entry: number; exit: number; qty: number; pnl: number; }

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

function summarize(name: string, trades: Trade[], wallet: number, hwm: number, lowest: number): any {
  const roi = (wallet - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100;
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
  const yearsPositive = Object.values(byYear).filter(v => v > 0).length;
  const yearsTotal = Object.keys(byYear).length;
  return {
    name, roi: +roi.toFixed(2), dd: +dd.toFixed(2), ra: +ra.toFixed(2),
    trades: trades.length, wr: +wr.toFixed(2),
    rr: avgL < 0 ? +(avgW / -avgL).toFixed(2) : 0,
    exp: +exp.toFixed(2),
    stability: `${yearsPositive}/${yearsTotal}`,
    byYear: Object.fromEntries(Object.entries(byYear).map(([k, v]) => [k, Math.round(v)])),
  };
}

function runDonchian(c: Candle[], atr: (number | null)[], lookback: number, atrSlMult: number = 2): { trades: Trade[]; wallet: number; hwm: number; lowest: number } {
  let wallet = INITIAL_CAPITAL, hwm = INITIAL_CAPITAL, lowest = INITIAL_CAPITAL;
  const trades: Trade[] = [];
  let pos: { side: "LONG" | "SHORT"; entry: number; qty: number; entryTs: number; sl: number; hw: number; lw: number } | null = null;
  for (let i = lookback + 1; i < c.length; i++) {
    const bar = c[i]; const atrV = atr[i]; if (!atrV) continue;
    let hi = -Infinity, lo = Infinity;
    for (let j = i - lookback; j < i; j++) { if (c[j].high > hi) hi = c[j].high; if (c[j].low < lo) lo = c[j].low; }
    if (pos) {
      const px = bar.close;
      if (pos.side === "LONG") { if (px > pos.hw) { pos.hw = px; pos.sl = pos.hw - atrV * atrSlMult; } }
      else { if (px < pos.lw) { pos.lw = px; pos.sl = pos.lw + atrV * atrSlMult; } }
      let exit = false;
      if (pos.side === "LONG" && (px <= pos.sl || px <= lo)) exit = true;
      if (pos.side === "SHORT" && (px >= pos.sl || px >= hi)) exit = true;
      if (exit) {
        const pnl = (pos.side === "LONG" ? px - pos.entry : pos.entry - px) * pos.qty;
        const fee = pos.qty * (pos.entry + px) * FEE_PCT / 100;
        wallet += pnl - fee;
        if (wallet > hwm) hwm = wallet; if (wallet < lowest) lowest = wallet;
        trades.push({ entryTs: pos.entryTs, exitTs: bar.time, side: pos.side, entry: pos.entry, exit: px, qty: pos.qty, pnl: pnl - fee });
        pos = null;
      }
    }
    if (pos) continue;
    const px = bar.close;
    const qty = (INITIAL_CAPITAL * RISK_PCT / 100) / (atrV * atrSlMult);
    if (px > hi) pos = { side: "LONG", entry: px, qty, entryTs: bar.time, sl: px - atrV * atrSlMult, hw: px, lw: px };
    else if (px < lo) pos = { side: "SHORT", entry: px, qty, entryTs: bar.time, sl: px + atrV * atrSlMult, hw: px, lw: px };
  }
  return { trades, wallet, hwm, lowest };
}

function runMACross(c: Candle[], eFast: (number | null)[], eSlow: (number | null)[]): { trades: Trade[]; wallet: number; hwm: number; lowest: number } {
  let wallet = INITIAL_CAPITAL, hwm = INITIAL_CAPITAL, lowest = INITIAL_CAPITAL;
  const trades: Trade[] = [];
  let pos: { side: "LONG" | "SHORT"; entry: number; qty: number; entryTs: number } | null = null;
  for (let i = 1; i < c.length; i++) {
    const bar = c[i];
    const fc = eFast[i], sc = eSlow[i], fp = eFast[i - 1], sp = eSlow[i - 1];
    if (fc === null || sc === null || fp === null || sp === null) continue;
    const golden = fp <= sp && fc > sc;
    const death = fp >= sp && fc < sc;
    if (pos) {
      let exit = false;
      if (pos.side === "LONG" && death) exit = true;
      if (pos.side === "SHORT" && golden) exit = true;
      if (exit) {
        const px = bar.close;
        const pnl = (pos.side === "LONG" ? px - pos.entry : pos.entry - px) * pos.qty;
        const fee = pos.qty * (pos.entry + px) * FEE_PCT / 100;
        wallet += pnl - fee;
        if (wallet > hwm) hwm = wallet; if (wallet < lowest) lowest = wallet;
        trades.push({ entryTs: pos.entryTs, exitTs: bar.time, side: pos.side, entry: pos.entry, exit: px, qty: pos.qty, pnl: pnl - fee });
        pos = null;
      }
    }
    if (pos) continue;
    if (golden) {
      const px = bar.close;
      const qty = (INITIAL_CAPITAL * RISK_PCT / 100) / (px * 0.05);
      pos = { side: "LONG", entry: px, qty, entryTs: bar.time };
    } else if (death) {
      const px = bar.close;
      const qty = (INITIAL_CAPITAL * RISK_PCT / 100) / (px * 0.05);
      pos = { side: "SHORT", entry: px, qty, entryTs: bar.time };
    }
  }
  return { trades, wallet, hwm, lowest };
}

function runATRBreakout(c: Candle[], atr: (number | null)[], mult: number, atrSlMult: number = 2): { trades: Trade[]; wallet: number; hwm: number; lowest: number } {
  let wallet = INITIAL_CAPITAL, hwm = INITIAL_CAPITAL, lowest = INITIAL_CAPITAL;
  const trades: Trade[] = [];
  let pos: { side: "LONG" | "SHORT"; entry: number; qty: number; entryTs: number; sl: number; hw: number; lw: number } | null = null;
  for (let i = 15; i < c.length; i++) {
    const bar = c[i]; const atrV = atr[i]; if (!atrV) continue;
    const prev = c[i - 1];
    if (pos) {
      const px = bar.close;
      if (pos.side === "LONG") { if (px > pos.hw) { pos.hw = px; pos.sl = pos.hw - atrV * atrSlMult; } }
      else { if (px < pos.lw) { pos.lw = px; pos.sl = pos.lw + atrV * atrSlMult; } }
      let exit = false;
      if (pos.side === "LONG" && px <= pos.sl) exit = true;
      if (pos.side === "SHORT" && px >= pos.sl) exit = true;
      if (exit) {
        const pnl = (pos.side === "LONG" ? px - pos.entry : pos.entry - px) * pos.qty;
        const fee = pos.qty * (pos.entry + px) * FEE_PCT / 100;
        wallet += pnl - fee;
        if (wallet > hwm) hwm = wallet; if (wallet < lowest) lowest = wallet;
        trades.push({ entryTs: pos.entryTs, exitTs: bar.time, side: pos.side, entry: pos.entry, exit: px, qty: pos.qty, pnl: pnl - fee });
        pos = null;
      }
    }
    if (pos) continue;
    const px = bar.close;
    const lt = prev.close + atrV * mult; const st = prev.close - atrV * mult;
    const qty = (INITIAL_CAPITAL * RISK_PCT / 100) / (atrV * atrSlMult);
    if (px > lt) pos = { side: "LONG", entry: px, qty, entryTs: bar.time, sl: px - atrV * atrSlMult, hw: px, lw: px };
    else if (px < st) pos = { side: "SHORT", entry: px, qty, entryTs: bar.time, sl: px + atrV * atrSlMult, hw: px, lw: px };
  }
  return { trades, wallet, hwm, lowest };
}

// Hybrid: combine equity curves từ 2 strategies (50/50 capital split)
function combineEquity(r1: { trades: Trade[]; wallet: number; hwm: number; lowest: number }, r2: { trades: Trade[]; wallet: number; hwm: number; lowest: number }): { trades: Trade[]; wallet: number; hwm: number; lowest: number } {
  // Halved capital → halved qty, but for compare em scale per-strategy half
  // Simpler: combine PnL events sorted by ts, track combined equity
  const events: { ts: number; pnl: number }[] = [];
  for (const t of r1.trades) events.push({ ts: t.exitTs, pnl: t.pnl / 2 }); // half size
  for (const t of r2.trades) events.push({ ts: t.exitTs, pnl: t.pnl / 2 });
  events.sort((a, b) => a.ts - b.ts);
  let wallet = INITIAL_CAPITAL, hwm = INITIAL_CAPITAL, lowest = INITIAL_CAPITAL;
  const combinedTrades: Trade[] = [];
  for (const e of events) {
    wallet += e.pnl;
    if (wallet > hwm) hwm = wallet;
    if (wallet < lowest) lowest = wallet;
    combinedTrades.push({ entryTs: e.ts, exitTs: e.ts, side: "LONG", entry: 0, exit: 0, qty: 0, pnl: e.pnl });
  }
  return { trades: combinedTrades, wallet, hwm, lowest };
}

function main() {
  console.log("[sweep] Loading caches...");
  const c1h = loadCache("1h");
  const c4h = loadCache("4h");
  const c1d = loadCache("1d");

  console.log("[sweep] Pre-computing indicators...");
  const ind: Record<string, { atr: (number | null)[]; emaCache: Map<number, (number | null)[]> }> = {};
  for (const [tf, c] of [["1h", c1h], ["4h", c4h], ["1d", c1d]] as const) {
    const cl = c.map(b => b.close);
    const emaCache = new Map<number, (number | null)[]>();
    for (const p of [20, 50, 100, 200]) emaCache.set(p, calcEMA(cl, p));
    ind[tf] = { atr: calcATR(c, 14), emaCache };
  }

  const tfs: { name: string; c: Candle[] }[] = [
    { name: "1h", c: c1h }, { name: "4h", c: c4h }, { name: "1d", c: c1d }
  ];

  const results: any[] = [];
  const rawResults: Record<string, any> = {};  // for hybrid

  // EMA cross sweep
  const emaParams = [[20, 50], [50, 100], [50, 200], [100, 200]];
  for (const tf of tfs) {
    for (const [fast, slow] of emaParams) {
      const r = runMACross(tf.c, ind[tf.name].emaCache.get(fast)!, ind[tf.name].emaCache.get(slow)!);
      const name = `ema-${fast}/${slow}-${tf.name}`;
      const s = summarize(name, r.trades, r.wallet, r.hwm, r.lowest);
      results.push(s);
      rawResults[name] = r;
    }
  }

  // Donchian sweep
  for (const tf of tfs) {
    for (const lb of [10, 20, 55, 100]) {
      const r = runDonchian(tf.c, ind[tf.name].atr, lb, 2);
      const name = `donch-${lb}-${tf.name}`;
      const s = summarize(name, r.trades, r.wallet, r.hwm, r.lowest);
      results.push(s);
      rawResults[name] = r;
    }
  }

  // ATR breakout sweep
  for (const tf of tfs) {
    for (const m of [1.0, 1.5, 2.0, 2.5]) {
      const r = runATRBreakout(tf.c, ind[tf.name].atr, m, 2);
      const name = `atrbo-${m}-${tf.name}`;
      const s = summarize(name, r.trades, r.wallet, r.hwm, r.lowest);
      results.push(s);
      rawResults[name] = r;
    }
  }

  // Hybrid combos
  const hybrids = [
    { name: "hybrid-ema50/200-4h+donch20-4h", a: "ema-50/200-4h", b: "donch-20-4h" },
    { name: "hybrid-ema50/200-4h+atrbo1.5-4h", a: "ema-50/200-4h", b: "atrbo-1.5-4h" },
    { name: "hybrid-donch20-4h+atrbo1.5-4h", a: "donch-20-4h", b: "atrbo-1.5-4h" },
    { name: "hybrid-3way-4h", a: "ema-50/200-4h", b: "donch-20-4h" },  // placeholder, will combine 3 separately
  ];
  for (const h of hybrids.slice(0, 3)) {
    const c = combineEquity(rawResults[h.a], rawResults[h.b]);
    results.push(summarize(h.name, c.trades, c.wallet, c.hwm, c.lowest));
  }

  // Sort by RiskAdj descending
  results.sort((a, b) => b.ra - a.ra);

  console.log("\n=== PARAM SWEEP RANKING (top 20 by RiskAdj, capital $100k, 3y) ===");
  console.log("Rank | Strategy                              | ROI%   | DD%   | RA    | Trades | WR%   | R:R  | Exp     | Stab");
  console.log("-".repeat(120));
  for (let i = 0; i < Math.min(20, results.length); i++) {
    const r = results[i];
    console.log(`${String(i + 1).padStart(3)}  | ${r.name.padEnd(37)} | ${String(r.roi).padStart(6)} | ${String(r.dd).padStart(5)} | ${String(r.ra).padStart(5)} | ${String(r.trades).padStart(6)} | ${String(r.wr).padStart(5)} | ${String(r.rr).padStart(4)} | ${String(r.exp).padStart(7)} | ${r.stability}`);
  }

  console.log("\n=== TOP 5 per-year PnL ===");
  console.log("Strategy                              | 2023      | 2024      | 2025      | 2026");
  console.log("-".repeat(100));
  for (let i = 0; i < Math.min(5, results.length); i++) {
    const r = results[i];
    const y23 = r.byYear["2023"] ?? "-";
    const y24 = r.byYear["2024"] ?? "-";
    const y25 = r.byYear["2025"] ?? "-";
    const y26 = r.byYear["2026"] ?? "-";
    console.log(`${r.name.padEnd(37)} | ${String(y23).padStart(9)} | ${String(y24).padStart(9)} | ${String(y25).padStart(9)} | ${String(y26).padStart(9)}`);
  }

  writeFileSync(join(__dirname, "..", "assets", "backtest_strategies_param_sweep.json"), JSON.stringify(results, null, 2));
  console.log(`\nWritten assets/backtest_strategies_param_sweep.json (${results.length} variants)`);
}

main();
