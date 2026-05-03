/**
 * backtest-pivot-15m.ts (anh Tommy 2026-05-02)
 *
 * Backtest swing trade: vào lệnh tại MỌI pivot point (local high/low) trên 3y BTC 15m,
 * close tại pivot OPPOSITE tiếp theo (alternating swing).
 *
 * Specs:
 *   - $1 margin × 125x leverage = $125 notional/lệnh
 *   - Cross margin (no cap loss)
 *   - Fee Binance taker: 0.05%/side = 0.10% round-trip
 *   - 2 modes: HINDSIGHT (entry @ pivot price exact) vs REALISTIC (entry @ candle i+N close)
 */
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const args = process.argv.slice(2);
const N_VALUES = (args.find((a) => a.startsWith("--N="))?.replace("--N=", "") || "5,10,20").split(",").map((s) => parseInt(s, 10));
const YEARS = parseInt(args.find((a) => a.startsWith("--years="))?.replace("--years=", "") || "3", 10);

const MARGIN = 1;
const LEVERAGE = 125;
const NOTIONAL = MARGIN * LEVERAGE;
const FEE_PER_SIDE_PCT = 0.05;

interface Candle { time: number; open: number; high: number; low: number; close: number; }

function loadCache(): Candle[] {
  const p = join(__dirname, "..", ".cache", "binance-15m-3y.json");
  if (!existsSync(p)) throw new Error(`Missing ${p}`);
  return JSON.parse(readFileSync(p, "utf8"));
}

interface PivotEvent { idx: number; side: "LONG" | "SHORT"; pivotPrice: number; confirmIdx: number; confirmPrice: number; time: number; }

function detectPivots(candles: Candle[], n: number): PivotEvent[] {
  const events: PivotEvent[] = [];
  for (let i = n; i < candles.length - n; i++) {
    const c = candles[i];
    let isLow = true, isHigh = true;
    for (let j = i - n; j <= i + n; j++) {
      if (j === i) continue;
      if (candles[j].low <= c.low) isLow = false;
      if (candles[j].high >= c.high) isHigh = false;
      if (!isLow && !isHigh) break;
    }
    if (isLow) {
      events.push({ idx: i, side: "LONG", pivotPrice: c.low, confirmIdx: i + n, confirmPrice: candles[i + n].close, time: candles[i + n].time });
    } else if (isHigh) {
      events.push({ idx: i, side: "SHORT", pivotPrice: c.high, confirmIdx: i + n, confirmPrice: candles[i + n].close, time: candles[i + n].time });
    }
  }
  // Sort by confirm time (entry actual time)
  events.sort((a, b) => a.confirmIdx - b.confirmIdx);
  return events;
}

interface Trade { side: "LONG" | "SHORT"; entryTime: number; entryPrice: number; exitTime: number; exitPrice: number; pnl: number; pnlPct: number; holdBars: number; }

function simulate(events: PivotEvent[], mode: "hindsight" | "realistic"): { trades: Trade[]; totalPnl: number; totalFee: number } {
  const trades: Trade[] = [];
  let totalPnl = 0;
  let totalFee = 0;
  let openSide: "LONG" | "SHORT" | null = null;
  let openEntry = 0;
  let openTime = 0;
  let openIdx = 0;

  for (const ev of events) {
    const entryPrice = mode === "hindsight" ? ev.pivotPrice : ev.confirmPrice;
    if (openSide === null) {
      openSide = ev.side;
      openEntry = entryPrice;
      openTime = ev.time;
      openIdx = ev.confirmIdx;
      continue;
    }
    if (openSide === ev.side) continue; // same side → skip (đã có pos cùng side, không alternating)
    // Opposite side → CLOSE current + open new
    const exitPrice = entryPrice;
    const rawPct = openSide === "LONG"
      ? (exitPrice - openEntry) / openEntry * 100
      : (openEntry - exitPrice) / openEntry * 100;
    const grossPnl = NOTIONAL * rawPct / 100;
    const fee = NOTIONAL * (FEE_PER_SIDE_PCT / 100) * 2; // round-trip
    const netPnl = grossPnl - fee;
    trades.push({
      side: openSide, entryTime: openTime, entryPrice: openEntry,
      exitTime: ev.time, exitPrice, pnl: netPnl, pnlPct: rawPct,
      holdBars: ev.confirmIdx - openIdx,
    });
    totalPnl += netPnl;
    totalFee += fee;
    // Open new side
    openSide = ev.side;
    openEntry = entryPrice;
    openTime = ev.time;
    openIdx = ev.confirmIdx;
  }
  return { trades, totalPnl, totalFee };
}

(async () => {
  console.log(`Loading 15m cache 3y...`);
  const all = loadCache();
  const cutoff = Date.now() - YEARS * 365 * 24 * 3600 * 1000;
  const candles = all.filter((c) => c.time >= cutoff);
  console.log(`  ${candles.length.toLocaleString()} candles (last ${YEARS}y)`);

  console.log(`\n=== BACKTEST PIVOT ALTERNATING SWING · 3y · $${NOTIONAL} notional/lệnh · fee 0.05%/side ===\n`);

  for (const N of N_VALUES) {
    const events = detectPivots(candles, N);
    const longCount = events.filter(e => e.side === "LONG").length;
    const shortCount = events.filter(e => e.side === "SHORT").length;

    for (const mode of ["hindsight", "realistic"] as const) {
      const r = simulate(events, mode);
      const wins = r.trades.filter(t => t.pnl > 0).length;
      const losses = r.trades.filter(t => t.pnl <= 0).length;
      const wr = r.trades.length ? (wins / r.trades.length * 100) : 0;
      const avgPnl = r.trades.length ? r.totalPnl / r.trades.length : 0;
      const grossWin = r.trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
      const grossLoss = Math.abs(r.trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
      const pf = grossLoss > 0 ? grossWin / grossLoss : 999;
      const avgHoldBars = r.trades.length ? r.trades.reduce((s, t) => s + t.holdBars, 0) / r.trades.length : 0;

      console.log(`N=${N} ${mode.padEnd(10)} → entries ${events.length} (L${longCount}/S${shortCount}) · trades ${r.trades.length} · WR ${wr.toFixed(1)}% · avg pnl $${avgPnl.toFixed(2)} · TOTAL ${r.totalPnl >= 0 ? "+" : ""}$${r.totalPnl.toFixed(0)} · PF ${pf.toFixed(2)} · fee paid $${r.totalFee.toFixed(0)} · avg hold ${avgHoldBars.toFixed(1)} bars (${(avgHoldBars * 15 / 60).toFixed(1)}h)`);
    }
    console.log("");
  }
})();
