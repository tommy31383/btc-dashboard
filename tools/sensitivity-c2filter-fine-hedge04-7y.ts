/**
 * sensitivity-c2filter-fine-hedge04-7y.ts (anh Tommy 2026-05-14)
 *
 * Sensitivity sweep quanh winner F4/TP6/SL3/qty0.5/cd15m từ grid trước.
 * Tìm sweet spot để giảm train/test decay + boost RiskAdj.
 *
 * Grid:
 *   - filter: F3 (1h+1d), F4 (1h+1d+15m_RSI>55)
 *   - TP: [5, 5.5, 6, 6.5, 7]
 *   - SL: [2.5, 3, 3.5]
 *   - qty: [0.3, 0.5, 0.7]
 *   - cooldown: [15, 30] min
 *
 * Total: 2 × 5 × 3 × 3 × 2 = 180 combos.
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
    map5to[i] = bars.length;
  }
  if (cur) bars.push(cur);
  return { bars, map5to };
}

interface Trade { entryPx: number; qty: number; tpPx: number; slPx: number; openIdx: number; }
interface Result {
  filterMode: number; tp: number; sl: number; qty: number; cooldownMin: number; rr: number;
  finalEq: number; roi: number; ddPct: number;
  trades: number; tpHits: number; slHits: number; wr: number;
  liquidated: boolean; riskAdj: number;
  perYear: Record<number, number>; yearsPositive: number;
}

function simulate(
  c5: Candle[], iStart: number, iEnd: number,
  c2Sig: Uint8Array, filterPass: Uint8Array,
  tpPct: number, slPct: number, qty: number, cooldownMs: number, filterMode: number
): Result {
  const open: Trade[] = [];
  let wallet = INITIAL_CAPITAL;
  let trades = 0, tpHits = 0, slHits = 0;
  let lastEntryTs = 0;
  let peak = INITIAL_CAPITAL, trough = INITIAL_CAPITAL;
  let liq = false;
  const perYearPnl: Record<number, number> = {};

  for (let i = iStart; i < iEnd; i++) {
    const bar = c5[i]; const price = bar.close; const ts = bar.time;
    const year = new Date(ts).getUTCFullYear();
    for (let k = open.length - 1; k >= 0; k--) {
      const t = open[k];
      let closePx: number | null = null; let isSL = false;
      if (bar.low <= t.slPx) { closePx = t.slPx; isSL = true; }
      else if (bar.high >= t.tpPx) { closePx = t.tpPx; isSL = false; }
      if (closePx !== null) {
        const realized = t.qty * (closePx - t.entryPx);
        const fee = t.qty * closePx * (FEE_PER_SIDE_PCT/100);
        const np = realized - fee;
        wallet += np; trades++;
        if (isSL) slHits++; else tpHits++;
        perYearPnl[year] = (perYearPnl[year] || 0) + np;
        open.splice(k, 1);
      }
    }
    if (c2Sig[i] === 1 && (filterMode === 0 || filterPass[i] === 1) && (ts - lastEntryTs >= cooldownMs)) {
      const entryPx = price;
      const tpPx = entryPx * (1 + tpPct/100);
      const slPx = entryPx * (1 - slPct/100);
      wallet -= qty * entryPx * (FEE_PER_SIDE_PCT/100);
      open.push({ entryPx, qty, tpPx, slPx, openIdx: i });
      lastEntryTs = ts;
    }
    let upnl = 0, totQty = 0;
    for (const t of open) { upnl += t.qty * (price - t.entryPx); totQty += t.qty; }
    const eq = wallet + upnl;
    if (eq > peak) peak = eq;
    if (eq < trough) trough = eq;
    if (totQty > 0 && eq <= totQty * price * MAINT_MARGIN_RATE) { liq = true; break; }
  }
  const lastPrice = c5[iEnd-1].close;
  let unreal = 0;
  for (const t of open) unreal += t.qty * (lastPrice - t.entryPx);
  const finalEq = wallet + unreal;
  const roi = (finalEq - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100;
  const ddPct = (peak - trough) / peak * 100;
  const yrsPos = Object.values(perYearPnl).filter(v => v >= 0).length;
  return {
    filterMode, tp: tpPct, sl: slPct, qty, cooldownMin: cooldownMs/60_000, rr: tpPct/slPct,
    finalEq, roi, ddPct, trades, tpHits, slHits,
    wr: trades > 0 ? tpHits/trades : 0,
    liquidated: liq, riskAdj: ddPct > 0 ? roi/ddPct : roi,
    perYear: perYearPnl, yearsPositive: yrsPos,
  };
}
function filterModeName(m: number): string {
  return ["NONE", "1h_RSI>50", "1d_close>MA50", "1h+1d", "1h+1d+15m_RSI>55"][m];
}

function main() {
  console.log("[sens-fine] Loading 7y 5m...");
  const c5 = loadCache();
  console.log(`  ${c5.length.toLocaleString()} bars`);
  console.log("[sens-fine] Aggregating 15m / 1h / 1d...");
  const { bars: c15, map5to: m15 } = aggregate(c5, 15);
  const { bars: c1h, map5to: m1h } = aggregate(c5, 60);
  const { bars: c1d, map5to: m1d } = aggregate(c5, 24*60);
  console.log(`  ${c15.length} 15m · ${c1h.length} 1h · ${c1d.length} 1d`);
  const closes5 = c5.map(b => b.close);
  const closes15 = c15.map(b => b.close);
  const closes1h = c1h.map(b => b.close);
  const closes1d = c1d.map(b => b.close);
  const rsi5 = calcRSI(closes5, 14);
  const rsi15 = calcRSI(closes15, 14);
  const rsi1h = calcRSI(closes1h, 14);
  const ma50d = calcSMA(closes1d, 50);
  // C2
  const c2Sig = new Uint8Array(c5.length);
  let c2Count = 0;
  for (let i = 200; i < c5.length; i++) {
    const b = c5[i];
    const upW = (b.high - Math.max(b.open, b.close)) / b.open * 100;
    const m5 = i >= 6 ? (b.close - c5[i-6].close)/c5[i-6].close * 100 : 0;
    const m10 = i >= 11 ? (b.close - c5[i-11].close)/c5[i-11].close * 100 : 0;
    const m20 = i >= 21 ? (b.close - c5[i-21].close)/c5[i-21].close * 100 : 0;
    const r = rsi5[i] ?? 0;
    if (r >= 70 && upW >= 0.3 && m5 >= 0 && m10 >= 0 && m20 >= 0) { c2Sig[i] = 1; c2Count++; }
  }
  console.log(`  ${c2Count} C2 signals`);
  // Filter F3, F4
  const f3 = new Uint8Array(c5.length);
  const f4 = new Uint8Array(c5.length);
  for (let i = 0; i < c5.length; i++) {
    const hi = m1h[i] - 1, di = m1d[i] - 1, f15i = m15[i] - 1;
    const r1h = hi >= 0 && rsi1h[hi] !== null ? rsi1h[hi]! : 50;
    const dc = di >= 0 ? closes1d[di] : 0;
    const md = di >= 0 ? ma50d[di] : null;
    const r15 = f15i >= 0 && rsi15[f15i] !== null ? rsi15[f15i]! : 50;
    const F1 = r1h > 50;
    const F2 = md !== null && dc > md;
    const F15 = r15 > 55;
    if (F1 && F2) f3[i] = 1;
    if (F1 && F2 && F15) f4[i] = 1;
  }

  const tpGrid = [5, 5.5, 6, 6.5, 7];
  const slGrid = [2.5, 3, 3.5];
  const qtyGrid = [0.3, 0.5, 0.7];
  const cdGrid = [15, 30];
  const filterModes = [3, 4];
  const combos: Array<[number, number, number, number, number]> = [];
  for (const m of filterModes) for (const tp of tpGrid) for (const sl of slGrid) for (const q of qtyGrid) for (const cd of cdGrid) {
    combos.push([m, tp, sl, q, cd]);
  }
  console.log(`\n[sens-fine] Running ${combos.length} combos...`);
  const t0 = Date.now();
  const results: Result[] = [];
  for (let n = 0; n < combos.length; n++) {
    const [m, tp, sl, q, cd] = combos[n];
    const flt = m === 3 ? f3 : f4;
    const r = simulate(c5, 0, c5.length, c2Sig, flt, tp, sl, q, cd*60_000, m);
    results.push(r);
    if ((n+1) % 30 === 0) console.log(`  ${n+1}/${combos.length} done · ${((Date.now()-t0)/1000).toFixed(1)}s`);
  }
  console.log(`Done in ${((Date.now()-t0)/1000).toFixed(1)}s\n`);

  const valid = results.filter(r => !r.liquidated && r.yearsPositive >= 5 && r.trades >= 100);
  const top = [...valid].sort((a, b) => b.riskAdj - a.riskAdj).slice(0, 15);

  console.log(`=== TOP 15 BY RISK-ADJUSTED ROI (sensitivity fine) ===`);
  console.log(`Rank | Filter         | TP  | SL  | qty  | cd  | R:R  | ROI%    | DD%   | RiskAdj | WR%  | Trades | Yrs+`);
  console.log(`-----|----------------|-----|-----|------|-----|------|---------|-------|---------|------|--------|------`);
  top.forEach((r, i) => {
    console.log(`${String(i+1).padStart(4)} | ${filterModeName(r.filterMode).padEnd(14)} | ${r.tp.toFixed(1).padStart(3)} | ${r.sl.toFixed(1).padStart(3)} | ${r.qty.toFixed(2)} | ${String(r.cooldownMin).padStart(3)}m | ${r.rr.toFixed(2)} | ${(r.roi>=0?"+":"")}${r.roi.toFixed(2).padStart(7)} | ${r.ddPct.toFixed(1).padStart(5)} | ${r.riskAdj.toFixed(2).padStart(7)} | ${(r.wr*100).toFixed(1).padStart(5)} | ${String(r.trades).padStart(6)} | ${r.yearsPositive}/7`);
  });

  // Train/test top 5
  const splitIdx = Math.floor(c5.length * 0.7);
  const splitDate = new Date(c5[splitIdx].time).toISOString().slice(0, 10);
  console.log(`\n=== TRAIN/TEST 70/30 SPLIT @ ${splitDate} — TOP 5 ===`);
  console.log(`Combo                                  | TRAIN ROI / DD / RA / WR | TEST ROI / DD / RA / WR | Retain`);
  console.log(`---------------------------------------|--------------------------|-------------------------|-------`);
  for (const r of top.slice(0, 5)) {
    const flt = r.filterMode === 3 ? f3 : f4;
    const train = simulate(c5, 0, splitIdx, c2Sig, flt, r.tp, r.sl, r.qty, r.cooldownMin*60_000, r.filterMode);
    const test = simulate(c5, splitIdx, c5.length, c2Sig, flt, r.tp, r.sl, r.qty, r.cooldownMin*60_000, r.filterMode);
    const retain = train.riskAdj > 0 ? test.riskAdj / train.riskAdj : 0;
    const tag = retain < 0.7 ? "⚠️HEAVY" : retain < 0.9 ? "MODER" : "OK";
    const label = `F${r.filterMode}/TP${r.tp}/SL${r.sl}/q${r.qty}/cd${r.cooldownMin}m`;
    console.log(`${label.padEnd(38)} | ${(train.roi>=0?"+":"")}${train.roi.toFixed(1).padStart(5)}% / ${train.ddPct.toFixed(1).padStart(4)}% / ${train.riskAdj.toFixed(2).padStart(4)} / ${(train.wr*100).toFixed(0).padStart(2)}% | ${(test.roi>=0?"+":"")}${test.roi.toFixed(1).padStart(5)}% / ${test.ddPct.toFixed(1).padStart(4)}% / ${test.riskAdj.toFixed(2).padStart(4)} / ${(test.wr*100).toFixed(0).padStart(2)}% | ${tag} ${retain.toFixed(2)}`);
  }

  // Per-year top 1
  if (top.length > 0) {
    const best = top[0];
    console.log(`\n=== TOP 1 PER-YEAR PnL (F${best.filterMode}/TP${best.tp}/SL${best.sl}/q${best.qty}/cd${best.cooldownMin}m) ===`);
    for (const y of [2019, 2020, 2021, 2022, 2023, 2024, 2025]) {
      const v = best.perYear[y] ?? 0;
      console.log(`  ${y}: ${v >= 0 ? "+" : ""}$${v.toFixed(0)}`);
    }
  }

  writeFileSync(join(__dirname, "..", "assets", "sensitivity_c2filter_fine_hedge04_7y.json"), JSON.stringify({ top15: top, all: results }, null, 2));
  console.log(`\n[sens-fine] ✅ Done`);
}
main();
