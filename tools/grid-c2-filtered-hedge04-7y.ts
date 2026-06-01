/**
 * grid-c2-filtered-hedge04-7y.ts (anh Tommy 2026-05-14)
 *
 * Hedge04 design — C2 standalone (RSI 5m ≥ 70 + upWick + mom_all_up) + MTF filter để boost WR
 * và qty scale realistic, SL/TP per-trade MANDATORY.
 *
 * Filter modes:
 *   F0 = NONE                                      (baseline = grid trước)
 *   F1 = 1h RSI(14) > 50                          (HTF momentum bullish)
 *   F2 = daily close > MA50 daily                  (long-term trend up)
 *   F3 = F1 + F2 combined
 *   F4 = F3 + 15m RSI(14) > 55                    (MTF momentum confirmation)
 *
 * Qty grid: [0.01, 0.05, 0.1, 0.2, 0.5] BTC per trade.
 *
 * R:R grid: TP/SL pairs:
 *   [3/3 (1:1), 4/2 (2:1), 5/2.5 (2:1), 6/3 (2:1), 2/2 (1:1)]
 *
 * Cooldown fixed 15m (winner từ grid trước).
 *
 * Total: 5 filter × 5 qty × 5 R:R = 125 combos.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const INITIAL_CAPITAL = 100000;
const FEE_PER_SIDE_PCT = 0.05;
const MAINT_MARGIN_RATE = 0.004;
const COOLDOWN_MS = 15 * 60_000;

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

function aggregate(c5: Candle[], minutes: number): { bars: Candle[]; map5to: Int32Array } {
  const groupMs = minutes * 60_000;
  const bars: Candle[] = [];
  const map5to = new Int32Array(c5.length).fill(-1);
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
    // map5to[i] = index của HTF bar mà 5m bar i thuộc về (still open)
    // For filter use, dùng map5to[i] - 1 = bar HTF ĐÃ ĐÓNG gần nhất (no peek)
    map5to[i] = bars.length;
  }
  if (cur) bars.push(cur);
  return { bars, map5to };
}

interface Trade { entryPx: number; qty: number; tpPx: number; slPx: number; openIdx: number; }
interface Result {
  filterMode: number; tp: number; sl: number; qty: number; rr: number;
  finalEq: number; roi: number; ddPct: number;
  trades: number; tpHits: number; slHits: number; wr: number;
  liquidated: boolean; riskAdj: number;
  perYear: Record<number, number>; yearsPositive: number;
  avgHoldBars: number;
  c2Fires: number; c2Filtered: number;  // số C2 fires + số bị filter block
}

function simulate(
  c5: Candle[], iStart: number, iEnd: number,
  c2Sig: Uint8Array, filterPass: Uint8Array,
  tpPct: number, slPct: number, qty: number, filterMode: number
): Result {
  const open: Trade[] = [];
  let wallet = INITIAL_CAPITAL;
  let trades = 0, tpHits = 0, slHits = 0;
  let totalHoldBars = 0;
  let lastEntryTs = 0;
  let peak = INITIAL_CAPITAL, trough = INITIAL_CAPITAL;
  let liq = false;
  let c2Fires = 0, c2Filtered = 0;
  const perYearPnl: Record<number, number> = {};

  for (let i = iStart; i < iEnd; i++) {
    const bar = c5[i]; const price = bar.close; const ts = bar.time;
    const year = new Date(ts).getUTCFullYear();

    // Close open trades on TP/SL hit (conservative: SL first if both)
    for (let k = open.length - 1; k >= 0; k--) {
      const t = open[k];
      const slHit = bar.low <= t.slPx;
      const tpHit = bar.high >= t.tpPx;
      let closePx: number | null = null;
      let isSL = false;
      if (slHit) { closePx = t.slPx; isSL = true; }
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

    // C2 fire + filter + cooldown gate
    if (c2Sig[i] === 1) {
      c2Fires++;
      const passed = filterMode === 0 || filterPass[i] === 1;
      if (!passed) c2Filtered++;
      if (passed && (ts - lastEntryTs >= COOLDOWN_MS)) {
        const entryPx = price;
        const tpPx = entryPx * (1 + tpPct/100);
        const slPx = entryPx * (1 - slPct/100);
        const fee = qty * entryPx * (FEE_PER_SIDE_PCT/100);
        wallet -= fee;
        open.push({ entryPx, qty, tpPx, slPx, openIdx: i });
        lastEntryTs = ts;
      }
    }

    // Equity + DD + LIQ
    let upnl = 0, totQty = 0;
    for (const t of open) { upnl += t.qty * (price - t.entryPx); totQty += t.qty; }
    const eq = wallet + upnl;
    if (eq > peak) peak = eq;
    if (eq < trough) trough = eq;
    if (totQty > 0) {
      const mm = totQty * price * MAINT_MARGIN_RATE;
      if (eq <= mm) { liq = true; break; }
    }
  }
  const lastPrice = c5[iEnd - 1].close;
  let unrealUpnl = 0;
  for (const t of open) unrealUpnl += t.qty * (lastPrice - t.entryPx);
  const finalEq = wallet + unrealUpnl;
  const roi = (finalEq - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100;
  const ddPct = (peak - trough) / peak * 100;
  const yrsPos = Object.values(perYearPnl).filter(v => v >= 0).length;
  return {
    filterMode, tp: tpPct, sl: slPct, qty, rr: tpPct / slPct,
    finalEq, roi, ddPct,
    trades, tpHits, slHits, wr: trades > 0 ? tpHits / trades : 0,
    liquidated: liq, riskAdj: ddPct > 0 ? roi / ddPct : roi,
    perYear: perYearPnl, yearsPositive: yrsPos,
    avgHoldBars: trades > 0 ? totalHoldBars / trades : 0,
    c2Fires, c2Filtered,
  };
}

function filterModeName(m: number): string {
  switch(m) {
    case 0: return "NONE";
    case 1: return "1h_RSI>50";
    case 2: return "1d_close>MA50";
    case 3: return "1h+1d";
    case 4: return "1h+1d+15m_RSI>55";
    default: return "?";
  }
}

function main() {
  console.log("[grid-c2-h04f] Loading 7y 5m...");
  const c5 = loadCache();
  console.log(`  ${c5.length.toLocaleString()} bars`);

  console.log("[grid-c2-h04f] Aggregating 15m / 1h / 1d...");
  const { bars: c15, map5to: map5to15 } = aggregate(c5, 15);
  const { bars: c1h, map5to: map5to1h } = aggregate(c5, 60);
  const { bars: c1d, map5to: map5to1d } = aggregate(c5, 24 * 60);
  console.log(`  ${c15.length} 15m · ${c1h.length} 1h · ${c1d.length} 1d`);

  console.log("[grid-c2-h04f] Computing indicators...");
  const closes5 = c5.map(b => b.close);
  const closes15 = c15.map(b => b.close);
  const closes1h = c1h.map(b => b.close);
  const closes1d = c1d.map(b => b.close);
  const rsi5 = calcRSI(closes5, 14);
  const rsi15 = calcRSI(closes15, 14);
  const rsi1h = calcRSI(closes1h, 14);
  const ma50_1d = calcSMA(closes1d, 50);

  // C2 signal on 5m
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

  // Filter passes per mode (use CLOSED HTF bars: map5to[i] - 1)
  const filters: Uint8Array[] = [
    new Uint8Array(c5.length), // 0 NONE (unused)
    new Uint8Array(c5.length), // 1 1h RSI > 50
    new Uint8Array(c5.length), // 2 1d close > MA50 1d
    new Uint8Array(c5.length), // 3 1h+1d
    new Uint8Array(c5.length), // 4 1h+1d+15m RSI > 55
  ];
  for (let i = 0; i < c5.length; i++) {
    const hourIdx = map5to1h[i] - 1;     // closed 1h bar
    const dayIdx = map5to1d[i] - 1;       // closed 1d bar
    const f15Idx = map5to15[i] - 1;       // closed 15m bar
    const r1h = hourIdx >= 0 && rsi1h[hourIdx] !== null ? rsi1h[hourIdx]! : 50;
    const dayClose = dayIdx >= 0 ? closes1d[dayIdx] : 0;
    const ma50d = dayIdx >= 0 ? ma50_1d[dayIdx] : null;
    const r15 = f15Idx >= 0 && rsi15[f15Idx] !== null ? rsi15[f15Idx]! : 50;
    const f1 = r1h > 50;
    const f2 = ma50d !== null && dayClose > ma50d;
    const f15 = r15 > 55;
    if (f1) filters[1][i] = 1;
    if (f2) filters[2][i] = 1;
    if (f1 && f2) filters[3][i] = 1;
    if (f1 && f2 && f15) filters[4][i] = 1;
  }
  console.log(`  Filter pass-rate of C2 fires:`);
  for (let m = 1; m <= 4; m++) {
    let pass = 0;
    for (let i = 0; i < c5.length; i++) if (c2Sig[i] === 1 && filters[m][i] === 1) pass++;
    console.log(`    ${filterModeName(m).padEnd(20)} : ${pass} / ${c2Count} (${(pass/c2Count*100).toFixed(1)}%)`);
  }
  console.log("");

  const tpslGrid: Array<[number, number]> = [[3, 3], [4, 2], [5, 2.5], [6, 3], [2, 2]];
  const qtyGrid = [0.01, 0.05, 0.1, 0.2, 0.5];
  const filterModes = [0, 1, 2, 3, 4];

  const combos: Array<[number, number, number, number]> = [];
  for (const m of filterModes) {
    for (const [tp, sl] of tpslGrid) {
      for (const q of qtyGrid) {
        combos.push([m, tp, sl, q]);
      }
    }
  }
  console.log(`[grid-c2-h04f] Running ${combos.length} combos...`);

  const t0 = Date.now();
  const results: Result[] = [];
  for (let n = 0; n < combos.length; n++) {
    const [m, tp, sl, q] = combos[n];
    const r = simulate(c5, 0, c5.length, c2Sig, filters[m], tp, sl, q, m);
    results.push(r);
    if ((n+1) % 25 === 0) {
      const dt = (Date.now() - t0) / 1000;
      console.log(`  ${n+1}/${combos.length} done · ${dt.toFixed(1)}s · last: F${m}/TP${tp}/SL${sl}/q${q} ROI ${r.roi.toFixed(1)}% DD ${r.ddPct.toFixed(1)}% WR ${(r.wr*100).toFixed(0)}%`);
    }
  }
  console.log(`[grid-c2-h04f] Done in ${((Date.now()-t0)/1000).toFixed(1)}s\n`);

  // Filter valid: no LIQ + stability ≥ 5/7 + trades ≥ 100
  const valid = results.filter(r => !r.liquidated && r.yearsPositive >= 5 && r.trades >= 100);
  const top = [...valid].sort((a, b) => b.riskAdj - a.riskAdj).slice(0, 15);

  console.log(`=== TOP 15 BY RISK-ADJUSTED ROI (SL mandatory, stability ≥ 5/7, ≥100 trades) ===`);
  console.log(`Rank | Filter             | TP  | SL  | qty   | R:R  | ROI%     | DD%   | RiskAdj | WR%  | Trades (TP/SL) | Yrs+`);
  console.log(`-----|--------------------|-----|-----|-------|------|----------|-------|---------|------|----------------|-----`);
  top.forEach((r, i) => {
    console.log(`${String(i+1).padStart(4)} | ${filterModeName(r.filterMode).padEnd(18)} | ${r.tp.toFixed(1).padStart(3)} | ${r.sl.toFixed(1).padStart(3)} | ${r.qty.toFixed(3)} | ${r.rr.toFixed(2)} | ${(r.roi>=0?"+":"")}${r.roi.toFixed(2).padStart(8)} | ${r.ddPct.toFixed(1).padStart(5)} | ${r.riskAdj.toFixed(2).padStart(7)} | ${(r.wr*100).toFixed(1).padStart(5)} | ${String(r.trades).padStart(5)} (${r.tpHits}/${r.slHits}) | ${r.yearsPositive}/7`);
  });

  // Train/test top 5
  const splitIdx = Math.floor(c5.length * 0.7);
  const splitDate = new Date(c5[splitIdx].time).toISOString().slice(0, 10);
  console.log(`\n=== TRAIN/TEST 70/30 SPLIT @ ${splitDate} ===`);
  console.log(`Combo                                | TRAIN ROI / DD / RiskAdj / WR | TEST ROI / DD / RiskAdj / WR | DECAY?`);
  console.log(`-------------------------------------|-------------------------------|------------------------------|--------`);
  for (const r of top.slice(0, 5)) {
    const train = simulate(c5, 0, splitIdx, c2Sig, filters[r.filterMode], r.tp, r.sl, r.qty, r.filterMode);
    const test = simulate(c5, splitIdx, c5.length, c2Sig, filters[r.filterMode], r.tp, r.sl, r.qty, r.filterMode);
    const retain = train.riskAdj > 0 ? test.riskAdj / train.riskAdj : 0;
    const decay = retain < 0.7 ? "⚠️ HEAVY" : retain < 0.9 ? "moderate" : "OK";
    const label = `F${r.filterMode}=${filterModeName(r.filterMode)}/TP${r.tp}/SL${r.sl}/q${r.qty}`;
    console.log(`${label.padEnd(37)} | ${(train.roi>=0?"+":"")}${train.roi.toFixed(1).padStart(6)}% / ${train.ddPct.toFixed(1).padStart(4)}% / ${train.riskAdj.toFixed(2).padStart(5)} / ${(train.wr*100).toFixed(0).padStart(2)}% | ${(test.roi>=0?"+":"")}${test.roi.toFixed(1).padStart(6)}% / ${test.ddPct.toFixed(1).padStart(4)}% / ${test.riskAdj.toFixed(2).padStart(5)} / ${(test.wr*100).toFixed(0).padStart(2)}% | ${decay}`);
  }

  if (top.length > 0) {
    const best = top[0];
    console.log(`\n=== TOP 1 PER-YEAR PnL (F${best.filterMode}/TP${best.tp}/SL${best.sl}/qty${best.qty}) ===`);
    const years = [2019, 2020, 2021, 2022, 2023, 2024, 2025];
    for (const y of years) {
      const v = best.perYear[y] ?? 0;
      console.log(`  ${y}: ${v >= 0 ? "+" : ""}$${v.toFixed(0)}`);
    }
  }

  console.log(`\nValid: ${valid.length}/${results.length} · LIQ: ${results.filter(r => r.liquidated).length}`);

  writeFileSync(join(__dirname, "..", "assets", "grid_c2_filtered_hedge04_7y.json"), JSON.stringify({ top15: top, all: results, splitDate }, null, 2));
  console.log(`\n[grid-c2-h04f] ✅ Done — saved assets/grid_c2_filtered_hedge04_7y.json`);
}

main();
