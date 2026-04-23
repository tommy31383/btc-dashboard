/**
 * multi-tf-score-scan-v2.ts — Iteration 4 (Tuned weights)
 *
 * Insights từ iter3: static LONG weights ~ uniform alignment không beat iter2
 * boolean filters. Lý do: iter2 golden (ATR<0.3% + EMA tight + HTF FLAT) là
 * REGIME-SPECIFIC, không phải alignment. Cần weight MẠNH các signal này.
 *
 * Tuning thay đổi:
 *   LONG weights (regime-heavy):
 *     - 4h trend FLAT: +30 (dominant)
 *     - ATR 1h < 0.3%: +25
 *     - EMA1h dist ∈ [-0.5, 0.5]: +20
 *     - 1h RSI < 60: +10
 *     - 1d trend FLAT/UP: +10
 *     - 1w trend UP/FLAT: +8
 *     Penalty:
 *     - 1h RSI > 70: -30
 *     - 4h trend DOWN: -20
 *     - 1d RSI > 75: -25
 *
 *   SHORT weights (trend-follow-short):
 *     - 4h trend UP: +25  (scalp short chỉ khi 4h đang UP mạnh → reversal setup)
 *     - 1h RSI > 70: +20
 *     - EMA1h dist > +2%: +20
 *     - 1d RSI > 65: +15
 *     - 1w trend UP: +10
 *     Penalty:
 *     - 4h trend DOWN: -20
 *     - 1h RSI < 50: -15
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { calcRSISeriesAligned, calcMACDSeries, calcEMASeries } from "../utils/indicators";

const BINANCE = "https://api.binance.com/api/v3";
interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number; }
const TF_MIN: Record<string, number> = { "1h":60, "4h":240, "1d":1440, "1w":10080 };

async function fetchKlines(interval: string, total: number): Promise<Candle[]> {
  const all: Candle[] = []; let endTime: number | undefined;
  while (all.length < total) {
    const limit = Math.min(1000, total - all.length);
    const params = new URLSearchParams({ symbol: "BTCUSDT", interval, limit: String(limit) });
    if (endTime) params.set("endTime", String(endTime));
    const res = await fetch(`${BINANCE}/klines?${params}`);
    const data: any[] = await res.json();
    if (!Array.isArray(data) || !data.length) break;
    const batch = data.map((k: any) => ({ time:+k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5] }));
    all.unshift(...batch);
    endTime = batch[0].time - 1;
    await new Promise(r => setTimeout(r, 80));
  }
  const m = new Map<number, Candle>(); for (const c of all) m.set(c.time, c);
  return [...m.values()].sort((a,b) => a.time - b.time);
}

function htfIdxAt(htf: Candle[], t: number): number {
  let lo = 0, hi = htf.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo+hi)>>1; if (htf[m].time <= t) { ans=m; lo=m+1; } else hi=m-1; }
  return ans;
}
function trendFromEMA(price: number, ema: number | null): "UP"|"DOWN"|"FLAT" {
  if (ema == null) return "FLAT";
  const d = (price - ema) / ema * 100;
  return d > 0.3 ? "UP" : d < -0.3 ? "DOWN" : "FLAT";
}
function calcATRPctSeries(c: Candle[], period = 14): (number | null)[] {
  const out: (number|null)[] = new Array(c.length).fill(null);
  if (c.length < period + 1) return out;
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i-1].close), Math.abs(c[i].low - c[i-1].close));
  let atr = sum / period;
  out[period] = c[period].close > 0 ? (atr / c[period].close) * 100 : null;
  for (let i = period + 1; i < c.length; i++) {
    const tr = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i-1].close), Math.abs(c[i].low - c[i-1].close));
    atr = (atr * (period - 1) + tr) / period;
    out[i] = c[i].close > 0 ? (atr / c[i].close) * 100 : null;
  }
  return out;
}
function simulate(c: Candle[], entryIdx: number, side: "LONG"|"SHORT", tpPct: number, slPct: number, maxHold: number) {
  const ep = c[entryIdx].close;
  const tp = side === "LONG" ? ep * (1 + tpPct/100) : ep * (1 - tpPct/100);
  const sl = side === "LONG" ? ep * (1 - slPct/100) : ep * (1 + slPct/100);
  for (let i = entryIdx + 1; i < Math.min(entryIdx + 1 + maxHold, c.length); i++) {
    if (side === "LONG") {
      if (c[i].low  <= sl) return { outcome: "LOSS" as const, hold: i - entryIdx };
      if (c[i].high >= tp) return { outcome: "WIN"  as const, hold: i - entryIdx };
    } else {
      if (c[i].high >= sl) return { outcome: "LOSS" as const, hold: i - entryIdx };
      if (c[i].low  <= tp) return { outcome: "WIN"  as const, hold: i - entryIdx };
    }
  }
  return { outcome: "TIMEOUT" as const, hold: maxHold };
}

(async () => {
  console.log("=== Multi-TF scoring scan v2 (iter4, tuned weights) ===\n");
  const [e1h, e4h, e1d, e1w] = await Promise.all([
    fetchKlines("1h", 10000), fetchKlines("4h", 3000), fetchKlines("1d", 800), fetchKlines("1w", 200),
  ]);
  console.log(`  1h=${e1h.length}  4h=${e4h.length}  1d=${e1d.length}  1w=${e1w.length}`);

  const c1h = e1h.map(k => k.close);
  const rsi1h = calcRSISeriesAligned(c1h, 14);
  const macd1h = calcMACDSeries(c1h);
  const ema1h = calcEMASeries(c1h, 50);
  const emaDist1h: (number|null)[] = c1h.map((p, i) => { const e = ema1h[i]; return e !== null && e > 0 ? ((p-e)/e)*100 : null; });
  const atr1h = calcATRPctSeries(e1h, 14);

  const c4h = e4h.map(k => k.close);
  const rsi4h = calcRSISeriesAligned(c4h, 14);
  const ema4h = calcEMASeries(c4h, 50);

  const c1d = e1d.map(k => k.close);
  const rsi1d = calcRSISeriesAligned(c1d, 14);
  const ema1d = calcEMASeries(c1d, 50);

  const c1w = e1w.map(k => k.close);
  const ema1w = calcEMASeries(c1w, 50);

  const tfMs = TF_MIN["1h"] * 60 * 1000;

  function computeScores(i: number): { L: number; S: number } {
    let L = 0, S = 0;
    const p = c1h[i];
    const t = e1h[i].time + tfMs - 1;

    // --- 4h trend (dominant) ---
    const i4 = htfIdxAt(e4h, t);
    let t4 = "FLAT", r4: number | null = null;
    if (i4 >= 0) { t4 = trendFromEMA(e4h[i4].close, ema4h[i4]); r4 = rsi4h[i4] ?? null; }
    if (t4 === "FLAT") L += 30;
    if (t4 === "DOWN") L -= 20;
    if (t4 === "UP") S += 25;
    if (t4 === "DOWN") S -= 20;

    // --- 1d trend ---
    const i1 = htfIdxAt(e1d, t);
    let t1 = "FLAT", r1: number | null = null;
    if (i1 >= 0) { t1 = trendFromEMA(e1d[i1].close, ema1d[i1]); r1 = rsi1d[i1] ?? null; }
    if (t1 === "FLAT" || t1 === "UP") L += 10;
    if (r1 !== null && r1 > 75) L -= 25;
    if (r1 !== null && r1 > 65) S += 15;
    if (r1 !== null && r1 < 40) S -= 15;

    // --- 1w trend ---
    const iw = htfIdxAt(e1w, t);
    let tw = "FLAT";
    if (iw >= 0) tw = trendFromEMA(e1w[iw].close, ema1w[iw]);
    if (tw === "UP" || tw === "FLAT") L += 8;
    if (tw === "UP") S += 10;

    // --- 1h local ---
    const a1 = atr1h[i];
    if (a1 !== null && a1 < 0.3) L += 25;

    const ed1h = emaDist1h[i];
    if (ed1h !== null && ed1h >= -0.5 && ed1h <= 0.5) L += 20;
    if (ed1h !== null && ed1h > 2) S += 20;

    const rr = rsi1h[i];
    if (rr !== null && rr < 60) L += 10;
    if (rr !== null && rr > 70) { L -= 30; S += 20; }
    if (rr !== null && rr < 50) S -= 15;

    return { L, S };
  }

  console.log("\nComputing scores…");
  const scored: { i: number; L: number; S: number }[] = [];
  for (let i = 60; i < e1h.length - 101; i++) {
    const { L, S } = computeScores(i);
    scored.push({ i, L, S });
  }

  // Distribution check
  const scoresL = scored.map(s => s.L);
  const scoresS = scored.map(s => s.S);
  scoresL.sort((a,b)=>a-b); scoresS.sort((a,b)=>a-b);
  const pct = (arr: number[], q: number) => arr[Math.floor(arr.length * q)];
  console.log(`LONG  p25/p50/p75/p90/p99: ${pct(scoresL,0.25)}/${pct(scoresL,0.5)}/${pct(scoresL,0.75)}/${pct(scoresL,0.9)}/${pct(scoresL,0.99)}`);
  console.log(`SHORT p25/p50/p75/p90/p99: ${pct(scoresS,0.25)}/${pct(scoresS,0.5)}/${pct(scoresS,0.75)}/${pct(scoresS,0.9)}/${pct(scoresS,0.99)}`);

  console.log("\nGrid search…");
  const thresholds = [30, 40, 50, 60, 70, 80, 90];
  const tpVariants = [3, 4, 5];
  const slVariants = [1, 1.5, 2];
  const sides: ("LONG"|"SHORT")[] = ["LONG", "SHORT"];
  const maxHold = 100;
  const lev = 100;
  const fee = 0.04 * 2 * lev;

  const results: any[] = [];
  for (const side of sides) {
    for (const thr of thresholds) {
      for (const tp of tpVariants) {
        for (const sl of slVariants) {
          let wins=0, losses=0, timeouts=0, sumHold=0;
          let lastEntry = -999;
          for (const s of scored) {
            const sc = side === "LONG" ? s.L : s.S;
            if (sc < thr) continue;
            if (s.i - lastEntry < 8) continue;
            lastEntry = s.i;
            const out = simulate(e1h, s.i, side, tp, sl, maxHold);
            if (out.outcome === "WIN") wins++;
            else if (out.outcome === "LOSS") losses++;
            else timeouts++;
            sumHold += out.hold;
          }
          const N = wins + losses + timeouts;
          if (N < 15) continue;
          const gross = wins * tp * lev - losses * sl * lev;
          const net = gross - N * fee;
          const wr = (wins / N) * 100;
          const breakEven = (sl * lev + fee) / ((sl + tp) * lev) * 100;
          results.push({
            side, thr, tp, sl, N, wins, losses, timeouts,
            wr: +wr.toFixed(1),
            net: +net.toFixed(0),
            netPerTrade: +(net/N).toFixed(1),
            avgHold: +(sumHold/N).toFixed(1),
            breakEven: +breakEven.toFixed(1),
            edge: +(wr - breakEven).toFixed(1),
          });
        }
      }
    }
  }

  const profitable = results.filter(r => r.net > 0 && r.edge > 5);
  profitable.sort((a, b) => b.netPerTrade - a.netPerTrade || b.N - a.N);

  console.log(`\nFound ${results.length} combos total, ${profitable.length} profitable (edge>5%).`);
  console.log("\nTop 15 by NET/trade:");
  console.log("side | thr | tp/sl    | N     | wr%    | breakEven | edge   | net/trade | NET");
  console.log("-----|-----|----------|-------|--------|-----------|--------|-----------|-----");
  for (const r of profitable.slice(0, 15)) {
    console.log(`${r.side.padEnd(5)}| ${String(r.thr).padStart(3)} | ${r.tp}/${r.sl}    | ${String(r.N).padStart(5)} | ${String(r.wr).padStart(5)}% | ${String(r.breakEven).padStart(7)}%  | ${r.edge>=0?"+":""}${r.edge}% | ${r.netPerTrade>=0?"+":""}${r.netPerTrade}%     | ${r.net>=0?"+":""}${r.net}%`);
  }

  // Top by side
  const bestL = profitable.filter(r => r.side === "LONG")[0];
  const bestS = profitable.filter(r => r.side === "SHORT")[0];
  console.log("\n🏆 Best per side:");
  if (bestL) console.log(`  LONG:  thr=${bestL.thr} tp/sl=${bestL.tp}/${bestL.sl} | WR ${bestL.wr}% N=${bestL.N} | net/trade +${bestL.netPerTrade}% | total +${bestL.net}%`);
  else console.log("  LONG: no profitable combo");
  if (bestS) console.log(`  SHORT: thr=${bestS.thr} tp/sl=${bestS.tp}/${bestS.sl} | WR ${bestS.wr}% N=${bestS.N} | net/trade +${bestS.netPerTrade}% | total +${bestS.net}%`);
  else console.log("  SHORT: no profitable combo");

  const outPath = join(__dirname, "..", "assets", "multi_tf_score_scan_v2.json");
  writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    weightScheme: "v2_tuned_regime",
    totalScored: scored.length,
    totalCombos: results.length,
    profitable: profitable.length,
    bestLONG: bestL, bestSHORT: bestS,
    top20: profitable.slice(0, 20),
  }, null, 2));
  console.log(`\n✅ Wrote ${outPath}`);
})();
