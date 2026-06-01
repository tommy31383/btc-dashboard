/**
 * grid-c2-standalone-hedge04-7y.ts (anh Tommy 2026-05-14)
 *
 * Design hedge04 — rule standalone từ signal C2 (RSI≥70 + upWick + mom_all_up trên 5m),
 * mỗi trade INDEPENDENT với TP/SL per-trade MANDATORY (philosophy "biết vô biết ra").
 *
 * Không gom position, không avg. Mỗi C2 fire = 1 trade riêng. Cooldown control entry only.
 *
 * Grid:
 *   - TP [1.5, 2, 2.5, 3, 4] × SL [1, 1.5, 2, 2.5, 3]  (chỉ giữ TP ≥ SL = R:R ≥ 1:1)
 *   - qty [0.003, 0.005, 0.007, 0.010, 0.015]
 *   - cooldown [15min, 30min, 1h, 2h]
 *
 * Total valid: 19 (TP,SL) × 5 qty × 4 cooldown = 380 combos.
 *
 * Sau khi rank by RiskAdj + stability ≥ 5/7 năm, top 5 → train/test 70/30 split.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const INITIAL_CAPITAL = 100000;
const FEE_PER_SIDE_PCT = 0.05;
const MAINT_MARGIN_RATE = 0.004;

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }

function loadCache(): Candle[] {
  return JSON.parse(readFileSync(join(__dirname, "..", ".cache", "binance-5m-7y.json"), "utf8"));
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

interface Trade { entryPx: number; qty: number; tpPx: number; slPx: number; openIdx: number; }
interface Result {
  tp: number; sl: number; qty: number; cooldownMin: number; rr: number;
  finalEq: number; roi: number; ddPct: number;
  trades: number; tpHits: number; slHits: number; wr: number;
  liquidated: boolean; riskAdj: number;
  perYear: Record<number, number>; yearsPositive: number; yearsNegative: number;
  avgHoldBars: number;
}

function simulate(
  c5: Candle[], iStart: number, iEnd: number,
  c2Sig: Uint8Array,
  tpPct: number, slPct: number, qty: number, cooldownMs: number
): Result {
  const open: Trade[] = [];
  let wallet = INITIAL_CAPITAL;
  let trades = 0, tpHits = 0, slHits = 0;
  let totalHoldBars = 0;
  let lastEntryTs = 0;
  let peak = INITIAL_CAPITAL, trough = INITIAL_CAPITAL;
  let liq = false;
  const perYearPnl: Record<number, number> = {};

  for (let i = iStart; i < iEnd; i++) {
    const bar = c5[i]; const price = bar.close; const ts = bar.time;
    const year = new Date(ts).getUTCFullYear();

    // Check open trades for TP/SL hit (use high/low for intra-bar fill)
    for (let k = open.length - 1; k >= 0; k--) {
      const t = open[k];
      // Conservative: if both hit same bar, SL first (worst case)
      const slHit = bar.low <= t.slPx;
      const tpHit = bar.high >= t.tpPx;
      let closePx: number | null = null;
      let isSL = false;
      if (slHit && tpHit) { closePx = t.slPx; isSL = true; }
      else if (slHit) { closePx = t.slPx; isSL = true; }
      else if (tpHit) { closePx = t.tpPx; isSL = false; }
      if (closePx !== null) {
        const realized = t.qty * (closePx - t.entryPx);
        const fee = t.qty * closePx * (FEE_PER_SIDE_PCT/100);
        const np = realized - fee;
        wallet += np;
        trades++;
        if (isSL) slHits++; else tpHits++;
        totalHoldBars += (i - t.openIdx);
        perYearPnl[year] = (perYearPnl[year] || 0) + np;
        open.splice(k, 1);
      }
    }

    // C2 signal + cooldown gate → open new trade
    if (c2Sig[i] === 1 && (ts - lastEntryTs >= cooldownMs)) {
      const entryPx = price;
      const tpPx = entryPx * (1 + tpPct/100);
      const slPx = entryPx * (1 - slPct/100);
      const fee = qty * entryPx * (FEE_PER_SIDE_PCT/100);
      wallet -= fee;
      open.push({ entryPx, qty, tpPx, slPx, openIdx: i });
      lastEntryTs = ts;
    }

    // Equity + DD tracking
    let upnl = 0;
    let totQty = 0;
    for (const t of open) {
      upnl += t.qty * (price - t.entryPx);
      totQty += t.qty;
    }
    const eq = wallet + upnl;
    if (eq > peak) peak = eq;
    if (eq < trough) trough = eq;
    if (totQty > 0) {
      const mm = totQty * price * MAINT_MARGIN_RATE;
      if (eq <= mm) { liq = true; break; }
    }
  }
  // Close remaining open trades at last price (unrealized)
  const lastPrice = c5[iEnd - 1].close;
  let unrealUpnl = 0;
  for (const t of open) unrealUpnl += t.qty * (lastPrice - t.entryPx);
  const finalEq = wallet + unrealUpnl;
  const roi = (finalEq - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100;
  const ddPct = (peak - trough) / peak * 100;
  const yearsPos = Object.values(perYearPnl).filter(v => v >= 0).length;
  const yearsNeg = Object.values(perYearPnl).filter(v => v < 0).length;
  return {
    tp: tpPct, sl: slPct, qty, cooldownMin: cooldownMs / 60_000, rr: tpPct / slPct,
    finalEq, roi, ddPct,
    trades, tpHits, slHits, wr: trades > 0 ? tpHits / trades : 0,
    liquidated: liq, riskAdj: ddPct > 0 ? roi / ddPct : roi,
    perYear: perYearPnl, yearsPositive: yearsPos, yearsNegative: yearsNeg,
    avgHoldBars: trades > 0 ? totalHoldBars / trades : 0,
  };
}

function main() {
  console.log("[grid-c2-h04] Loading 7y 5m...");
  const c5 = loadCache();
  console.log(`  ${c5.length.toLocaleString()} bars`);

  console.log("[grid-c2-h04] Computing C2 signal on 5m...");
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

  const tpGrid = [1.5, 2, 2.5, 3, 4];
  const slGrid = [1, 1.5, 2, 2.5, 3];
  const qtyGrid = [0.003, 0.005, 0.007, 0.010, 0.015];
  const cooldownGrid = [15, 30, 60, 120]; // minutes

  const combos: Array<[number, number, number, number]> = [];
  for (const tp of tpGrid) {
    for (const sl of slGrid) {
      if (sl > tp) continue;
      for (const q of qtyGrid) {
        for (const cm of cooldownGrid) {
          combos.push([tp, sl, q, cm]);
        }
      }
    }
  }
  console.log(`[grid-c2-h04] Running ${combos.length} valid combos (TP≥SL, SL mandatory)...`);
  const t0 = Date.now();
  const results: Result[] = [];
  for (let n = 0; n < combos.length; n++) {
    const [tp, sl, q, cm] = combos[n];
    const r = simulate(c5, 0, c5.length, c2Sig, tp, sl, q, cm * 60_000);
    results.push(r);
    if ((n+1) % 50 === 0) {
      const dt = (Date.now() - t0) / 1000;
      console.log(`  ${n+1}/${combos.length} done · ${dt.toFixed(1)}s · last: TP${tp}/SL${sl}/qty${q}/cd${cm}m ROI ${r.roi.toFixed(1)}% DD ${r.ddPct.toFixed(1)}%`);
    }
  }
  console.log(`[grid-c2-h04] Full 7y done in ${((Date.now()-t0)/1000).toFixed(1)}s\n`);

  // Filter: no LIQ + stability ≥ 5/7 + trades ≥ 100 (statistical)
  const valid = results.filter(r => !r.liquidated && r.yearsPositive >= 5 && r.trades >= 100);
  const top = [...valid].sort((a, b) => b.riskAdj - a.riskAdj).slice(0, 15);

  console.log(`=== TOP 15 BY RISK-ADJUSTED ROI (SL mandatory, stability ≥ 5/7, trades ≥ 100) ===`);
  console.log(`Rank | TP  | SL  | qty   | cd  | R:R  | ROI%    | DD%   | RiskAdj | WR%  | Trades (TP/SL) | Yrs+ | Hold`);
  console.log(`-----|-----|-----|-------|-----|------|---------|-------|---------|------|----------------|------|-----`);
  top.forEach((r, i) => {
    console.log(`${String(i+1).padStart(4)} | ${r.tp.toFixed(1).padStart(3)} | ${r.sl.toFixed(1).padStart(3)} | ${r.qty.toFixed(3)} | ${String(r.cooldownMin).padStart(3)}m | ${r.rr.toFixed(2)} | ${(r.roi>=0?"+":"")}${r.roi.toFixed(2).padStart(7)} | ${r.ddPct.toFixed(1).padStart(5)} | ${r.riskAdj.toFixed(2).padStart(7)} | ${(r.wr*100).toFixed(1).padStart(5)} | ${String(r.trades).padStart(5)} (${r.tpHits}/${r.slHits}) | ${r.yearsPositive}/7 | ${r.avgHoldBars.toFixed(0).padStart(3)}b`);
  });

  // Train/test split for top 5
  const splitIdx = Math.floor(c5.length * 0.7);
  const splitTs = c5[splitIdx].time;
  const splitDate = new Date(splitTs).toISOString().slice(0, 10);
  console.log(`\n=== TRAIN/TEST 70/30 SPLIT @ ${splitDate} ===`);
  console.log(`Combo                       | TRAIN ROI / DD / RiskAdj / WR | TEST ROI / DD / RiskAdj / WR | DECAY?`);
  console.log(`----------------------------|-------------------------------|------------------------------|--------`);
  const splitResults: Array<{combo: Result; train: Result; test: Result}> = [];
  for (const r of top.slice(0, 5)) {
    const train = simulate(c5, 0, splitIdx, c2Sig, r.tp, r.sl, r.qty, r.cooldownMin * 60_000);
    const test = simulate(c5, splitIdx, c5.length, c2Sig, r.tp, r.sl, r.qty, r.cooldownMin * 60_000);
    splitResults.push({ combo: r, train, test });
    const retain = train.riskAdj > 0 ? test.riskAdj / train.riskAdj : 0;
    const decay = retain < 0.7 ? "⚠️ HEAVY" : retain < 0.9 ? "moderate" : "OK";
    const label = `TP${r.tp}/SL${r.sl}/q${r.qty}/cd${r.cooldownMin}m`;
    console.log(`${label.padEnd(28)} | ${(train.roi>=0?"+":"")}${train.roi.toFixed(1).padStart(5)}% / ${train.ddPct.toFixed(1).padStart(4)}% / ${train.riskAdj.toFixed(2).padStart(5)} / ${(train.wr*100).toFixed(0).padStart(2)}% | ${(test.roi>=0?"+":"")}${test.roi.toFixed(1).padStart(5)}% / ${test.ddPct.toFixed(1).padStart(4)}% / ${test.riskAdj.toFixed(2).padStart(5)} / ${(test.wr*100).toFixed(0).padStart(2)}% | ${decay}`);
  }

  // Per-year top 1
  if (top.length > 0) {
    const best = top[0];
    console.log(`\n=== TOP 1 PER-YEAR PnL (TP${best.tp}/SL${best.sl}/qty${best.qty}/cd${best.cooldownMin}m) ===`);
    const years = [2019, 2020, 2021, 2022, 2023, 2024, 2025];
    for (const y of years) {
      const v = best.perYear[y] ?? 0;
      console.log(`  ${y}: ${v >= 0 ? "+" : ""}$${v.toFixed(0)}`);
    }
  }

  console.log(`\nValid combos (no LIQ + ≥5/7 yr+ + ≥100 trades): ${valid.length}/${results.length}`);

  writeFileSync(join(__dirname, "..", "assets", "grid_c2_standalone_hedge04_7y.json"), JSON.stringify({ top15: top, splitResults, all: results, splitDate }, null, 2));
  console.log(`\n[grid-c2-h04] ✅ Done — saved assets/grid_c2_standalone_hedge04_7y.json`);
}

main();
