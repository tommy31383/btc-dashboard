/**
 * backtest-grid-trading.ts (anh Tommy 2026-05-04)
 * Grid trading backtest 3y trên BTC.
 *
 * Logic:
 *   - Define price range [P_MIN, P_MAX] với GRID_SPACING_PCT
 *   - Mỗi level: nếu giá BAR cross xuống → BUY 0.001 BTC tại level
 *   - Mỗi position được TP tại level + GRID_SPACING_PCT (vd +1%)
 *   - Khi giá cross lên TP level → SELL → realize profit
 *   - Position scale với capital
 *
 * Test 5 setups:
 *   A. Spacing 0.5% / range $25k-$130k
 *   B. Spacing 1.0% / range $25k-$130k
 *   C. Spacing 2.0% / range $25k-$130k
 *   D. Spacing 1.0% + max 100 positions
 *   E. Spacing 0.5% + max 200 positions
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const INITIAL_CAPITAL = 100000;
const QTY_PER_LEVEL_BTC = 0.001;
const FEE_PER_SIDE_PCT = 0.05;
const MAINT_MARGIN_RATE = 0.004;
const P_MIN = 25000;
const P_MAX = 130000;

interface Candle { time: number; open: number; high: number; low: number; close: number; }
interface Pos { entry: number; tp: number; openMs: number; }

function loadCache(tf: string): Candle[] { return JSON.parse(readFileSync(join(__dirname,"..",".cache",`binance-${tf}-3y.json`),"utf8")); }

interface Setup { name: string; spacingPct: number; maxPositions: number; }

function run(setup: Setup, c: Candle[]) {
  // Build grid levels
  const levels: number[] = [];
  let p = P_MIN;
  while (p <= P_MAX) { levels.push(p); p *= 1 + setup.spacingPct / 100; }
  // levelStateOpen[i] = số position OPEN tại level i (we allow multiple if price touches multiple times)
  // Simpler: mỗi level chỉ cho phép 1 OPEN tại 1 thời điểm (re-buy sau khi sold)
  const levelOpen = new Array(levels.length).fill(false);

  let positions: Pos[] = [];
  let wallet = INITIAL_CAPITAL;
  let totalFees = 0, totalRealizedPnl = 0;
  let totalBuys = 0, totalSells = 0;
  let liq = false, liqMs = 0, peak = INITIAL_CAPITAL, trough = INITIAL_CAPITAL;
  let prevClose = c[0].close;

  for (let i = 0; i < c.length; i++) {
    const bar = c[i];
    const ts = bar.time;
    // 1) CHECK SELL: price reach TP for any open position
    for (let pi = positions.length - 1; pi >= 0; pi--) {
      const p = positions[pi];
      if (bar.high >= p.tp) {
        const realized = QTY_PER_LEVEL_BTC * (p.tp - p.entry);
        const fee = QTY_PER_LEVEL_BTC * p.tp * (FEE_PER_SIDE_PCT / 100);
        wallet += realized - fee;
        totalRealizedPnl += realized;
        totalFees += fee;
        totalSells++;
        // Free up the level
        for (let li = 0; li < levels.length; li++) {
          if (Math.abs(levels[li] - p.entry) / p.entry < 0.001) { levelOpen[li] = false; break; }
        }
        positions.splice(pi, 1);
      }
    }
    // 2) CHECK BUY: each level price crossed DOWN this bar (low <= level <= prev close)
    if (positions.length < setup.maxPositions) {
      for (let li = 0; li < levels.length; li++) {
        if (levelOpen[li]) continue;
        const lvl = levels[li];
        // Cross down: bar.low <= lvl AND prevClose > lvl
        if (bar.low <= lvl && prevClose > lvl) {
          if (positions.length >= setup.maxPositions) break;
          const tp = lvl * (1 + setup.spacingPct / 100);
          const fee = QTY_PER_LEVEL_BTC * lvl * (FEE_PER_SIDE_PCT / 100);
          positions.push({ entry: lvl, tp, openMs: ts });
          levelOpen[li] = true;
          wallet -= fee; totalFees += fee; totalBuys++;
        }
      }
    }
    // 3) Stats + LIQ check
    let upnl = 0;
    for (const p of positions) upnl += QTY_PER_LEVEL_BTC * (bar.close - p.entry);
    const eq = wallet + upnl;
    if (eq > peak) peak = eq;
    if (eq < trough) trough = eq;
    if (positions.length > 0) {
      const totalQty = positions.length * QTY_PER_LEVEL_BTC;
      const mm = totalQty * bar.close * MAINT_MARGIN_RATE;
      if (eq <= mm) { liq = true; liqMs = ts; break; }
    }
    prevClose = bar.close;
  }
  const lastPrice = c[c.length - 1].close;
  let upnl = 0;
  for (const p of positions) upnl += QTY_PER_LEVEL_BTC * (lastPrice - p.entry);
  const finalEq = wallet + upnl;
  const roi = ((finalEq - INITIAL_CAPITAL) / INITIAL_CAPITAL) * 100;
  return {
    name: setup.name,
    levels: levels.length,
    liquidated: liq, liqAtMs: liqMs,
    totalBuys, totalSells, openPositions: positions.length,
    totalRealizedPnl, totalFees, finalUpnl: upnl, finalEq, wallet, roi,
    maxDD: peak - trough, peak, trough,
  };
}

function main() {
  console.log("[grid] Loading 5m...");
  const c = loadCache("5m");
  console.log(`[grid] ${c.length} bars`);

  const setups: Setup[] = [
    { name: "A. spacing 0.5% / unlimited positions", spacingPct: 0.5, maxPositions: 10000 },
    { name: "B. spacing 1.0% / unlimited",            spacingPct: 1.0, maxPositions: 10000 },
    { name: "C. spacing 2.0% / unlimited",            spacingPct: 2.0, maxPositions: 10000 },
    { name: "D. spacing 1.0% / max 100 pos",          spacingPct: 1.0, maxPositions: 100 },
    { name: "E. spacing 0.5% / max 200 pos",          spacingPct: 0.5, maxPositions: 200 },
    { name: "F. spacing 0.3% / max 300 pos",          spacingPct: 0.3, maxPositions: 300 },
  ];
  const results: any[] = [];
  for (const su of setups) {
    const r = run(su, c);
    results.push(r);
    console.log(`\n[${su.name}]`);
    console.log(`  levels=${r.levels} · BUYs=${r.totalBuys} · SELLs=${r.totalSells} · open=${r.openPositions}`);
    console.log(`  Realized $${r.totalRealizedPnl.toFixed(0)} · Fees $${r.totalFees.toFixed(0)} · uPnL ${r.finalUpnl>=0?"+":""}$${r.finalUpnl.toFixed(0)}`);
    console.log(`  EQUITY $${r.finalEq.toFixed(0)} · ROI ${r.roi>=0?"+":""}${r.roi.toFixed(2)}% · DD $${r.maxDD.toFixed(0)} · LIQ ${r.liquidated}`);
  }
  console.log("\n=== SORTED BY ROI ===");
  results.sort((a, b) => b.roi - a.roi);
  console.log("Setup                                       Levels  BUYs   SELLs  Open  Realized    uPnL        EQUITY      ROI%       DD$       LIQ");
  for (const r of results) {
    console.log(`${r.name.padEnd(44)}${r.levels.toString().padStart(6)}  ${r.totalBuys.toString().padStart(5)}  ${r.totalSells.toString().padStart(5)}  ${r.openPositions.toString().padStart(4)}  ${('$'+r.totalRealizedPnl.toFixed(0)).padStart(10)}  ${((r.finalUpnl>=0?'+':'')+'$'+r.finalUpnl.toFixed(0)).padStart(10)}  ${('$'+r.finalEq.toFixed(0)).padStart(10)}  ${(r.roi>=0?'+':'')+r.roi.toFixed(2).padStart(7)}%  $${r.maxDD.toFixed(0).padStart(7)}  ${r.liquidated?"YES":"NO"}`);
  }

  writeFileSync(join(__dirname,"..","assets","backtest_grid_3y.json"), JSON.stringify({
    config: { initialCapital: INITIAL_CAPITAL, qtyBtc: QTY_PER_LEVEL_BTC, pMin: P_MIN, pMax: P_MAX },
    results,
  }));
  console.log("\nSaved → assets/backtest_grid_3y.json");
}
main();
