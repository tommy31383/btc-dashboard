/**
 * multi-tf-score-scan.ts — v4.3.15 Iteration 3 (Multi-TF Weighted Scoring)
 *
 * Idea: thay vì boolean filters cứng, tính "bullish alignment score" từ nhiều TF.
 *
 *   LONG score (0–100) cộng điểm khi các TF thuận bullish:
 *     - 1h:   EMA dist ≤ 0.5% (+8), RSI < 45 (+6), MACD hist rising (+6)
 *     - 4h:   trend UP (+15) / FLAT (+8), RSI 40-60 (+10), EMA dist <= 1% (+6)
 *     - 1d:   trend UP (+15) / FLAT (+8), RSI 40-65 (+10)
 *     - 1w:   trend UP (+10) / FLAT (+6)
 *     - Penalty: 1h RSI > 70 (-15), 1d RSI > 75 (-20)
 *
 *   SHORT score là mirror (thay UP↔DOWN, <45↔>55, v.v.)
 *
 * Grid scan (threshold, tpPct, slPct) × rule side → tìm combo best (WR + N + NET).
 * Output: top 10 combos, so sánh với iter2.
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
  console.log("=== Multi-TF weighted scoring scan (iter3) ===\n");

  console.log("Fetching 1h/4h/1d/1w klines…");
  const [e1h, e4h, e1d, e1w] = await Promise.all([
    fetchKlines("1h", 10000),
    fetchKlines("4h", 3000),
    fetchKlines("1d", 800),
    fetchKlines("1w", 200),
  ]);
  console.log(`  1h=${e1h.length}  4h=${e4h.length}  1d=${e1d.length}  1w=${e1w.length}`);

  // Indicators per TF
  const c1h = e1h.map(k => k.close);
  const rsi1h = calcRSISeriesAligned(c1h, 14);
  const macd1h = calcMACDSeries(c1h);
  const ema1h = calcEMASeries(c1h, 50);
  const emaDist1h: (number|null)[] = c1h.map((p, i) => { const e = ema1h[i]; return e !== null && e > 0 ? ((p-e)/e)*100 : null; });

  const c4h = e4h.map(k => k.close);
  const rsi4h = calcRSISeriesAligned(c4h, 14);
  const ema4h = calcEMASeries(c4h, 50);

  const c1d = e1d.map(k => k.close);
  const rsi1d = calcRSISeriesAligned(c1d, 14);
  const ema1d = calcEMASeries(c1d, 50);

  const c1w = e1w.map(k => k.close);
  const ema1w = calcEMASeries(c1w, 50);

  const tfMs = TF_MIN["1h"] * 60 * 1000;

  function computeScores(i: number): { longScore: number; shortScore: number; ctx: any } {
    let L = 0, S = 0;
    const p = c1h[i];

    // 1h EMA distance
    const ed1h = emaDist1h[i];
    if (ed1h !== null) {
      if (ed1h <= 0.5) L += 8;
      if (ed1h >= -0.5) S += 8; // inverted for SHORT edge from above EMA
      if (ed1h < -1) L += 4;    // deep below EMA favours LONG more
      if (ed1h > 1) S += 4;
    }
    // 1h RSI
    const r1h = rsi1h[i];
    if (r1h !== null) {
      if (r1h < 45) L += 6;
      if (r1h > 55) S += 6;
      if (r1h > 70) L -= 15;
      if (r1h < 30) S -= 15;
    }
    // 1h MACD rising
    const mh = macd1h.histogram[i];
    const pmh = i > 0 ? macd1h.histogram[i-1] : null;
    if (mh !== null && pmh !== null) {
      if (mh > pmh) L += 6;
      else S += 6;
    }

    const t = e1h[i].time + tfMs - 1;
    // 4h
    const i4 = htfIdxAt(e4h, t);
    let t4 = "FLAT", r4: number | null = null;
    if (i4 >= 0) { t4 = trendFromEMA(e4h[i4].close, ema4h[i4]); r4 = rsi4h[i4] ?? null; }
    if (t4 === "UP") L += 15; else if (t4 === "FLAT") L += 8;
    if (t4 === "DOWN") S += 15; else if (t4 === "FLAT") S += 8;
    if (r4 !== null) {
      if (r4 >= 40 && r4 <= 60) { L += 10; S += 10; }
      if (r4 > 65) L -= 8;
      if (r4 < 35) S -= 8;
    }

    // 1d
    const i1 = htfIdxAt(e1d, t);
    let t1 = "FLAT", r1: number | null = null;
    if (i1 >= 0) { t1 = trendFromEMA(e1d[i1].close, ema1d[i1]); r1 = rsi1d[i1] ?? null; }
    if (t1 === "UP") L += 15; else if (t1 === "FLAT") L += 8;
    if (t1 === "DOWN") S += 15; else if (t1 === "FLAT") S += 8;
    if (r1 !== null) {
      if (r1 >= 40 && r1 <= 65) L += 10;
      if (r1 >= 35 && r1 <= 60) S += 10;
      if (r1 > 75) L -= 20;
      if (r1 < 25) S -= 20;
    }

    // 1w
    const iw = htfIdxAt(e1w, t);
    let tw = "FLAT";
    if (iw >= 0) tw = trendFromEMA(e1w[iw].close, ema1w[iw]);
    if (tw === "UP") L += 10; else if (tw === "FLAT") L += 6;
    if (tw === "DOWN") S += 10; else if (tw === "FLAT") S += 6;

    return { longScore: L, shortScore: S, ctx: { t4, t1, tw, r4, r1, r1h, ed1h, mh } };
  }

  // Collect all scored candles
  console.log("\nComputing scores per candle…");
  const scored: { i: number; L: number; S: number }[] = [];
  for (let i = 60; i < e1h.length - 101; i++) {
    const { longScore, shortScore } = computeScores(i);
    scored.push({ i, L: longScore, S: shortScore });
  }

  // Grid search: threshold × tp × sl × side
  console.log("Grid search…");
  const thresholds = [40, 45, 50, 55, 60, 65, 70];
  const tpVariants = [3, 4, 5];
  const slVariants = [1.5, 2];
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
          // dedupe consecutive entries
          let lastEntry = -999;
          for (const s of scored) {
            const score = side === "LONG" ? s.L : s.S;
            if (score < thr) continue;
            if (s.i - lastEntry < 8) continue; // dedupe 8-hour cooldown
            lastEntry = s.i;
            const out = simulate(e1h, s.i, side, tp, sl, maxHold);
            if (out.outcome === "WIN") wins++;
            else if (out.outcome === "LOSS") losses++;
            else timeouts++;
            sumHold += out.hold;
          }
          const N = wins + losses + timeouts;
          if (N < 20) continue;
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
            edge: +(wr - breakEven).toFixed(1), // WR trên break-even bao nhiêu
          });
        }
      }
    }
  }

  // Sort: profitable only, by net/trade desc, then by N desc as tiebreaker
  const profitable = results.filter(r => r.net > 0 && r.edge > 3);
  profitable.sort((a, b) => b.netPerTrade - a.netPerTrade || b.N - a.N);

  console.log(`\nFound ${results.length} combos total, ${profitable.length} profitable (edge>3%).`);
  console.log("\nTop 15 by NET/trade:");
  console.log("side | thr | tp/sl | N     | wr%    | breakEven | edge  | net/trade | netPnL%");
  console.log("-----|-----|-------|-------|--------|-----------|-------|-----------|---------");
  for (const r of profitable.slice(0, 15)) {
    console.log(`${r.side.padEnd(5)}| ${String(r.thr).padStart(3)} | ${r.tp}/${r.sl}   | ${String(r.N).padStart(5)} | ${String(r.wr).padStart(5)}% | ${String(r.breakEven).padStart(7)}%  | ${r.edge>=0?"+":""}${r.edge}% | ${r.netPerTrade>=0?"+":""}${r.netPerTrade}%     | ${r.net>=0?"+":""}${r.net}%`);
  }

  const outPath = join(__dirname, "..", "assets", "multi_tf_score_scan.json");
  writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    weightScheme: "v1_static",
    totalScored: scored.length,
    totalCombos: results.length,
    profitable: profitable.length,
    top20: profitable.slice(0, 20),
    allResults: results,
  }, null, 2));
  console.log(`\n✅ Wrote ${outPath}`);

  // Comparison vs iter2 best
  console.log("\n📊 Comparison vs iter2 (Golden ATR+EMA+FLAT): WR=100% N=10 NET=+4920%");
  console.log("📊 Comparison vs iter2 (LONG Widened EMA+FLAT): WR=78.1% N=32 NET=+10844%");
  const bestL = profitable.filter(r => r.side === "LONG")[0];
  const bestS = profitable.filter(r => r.side === "SHORT")[0];
  if (bestL) console.log(`   iter3 best LONG:  thr=${bestL.thr} ${bestL.tp}/${bestL.sl} → WR ${bestL.wr}% N=${bestL.N} NET +${bestL.net}%`);
  if (bestS) console.log(`   iter3 best SHORT: thr=${bestS.thr} ${bestS.tp}/${bestS.sl} → WR ${bestS.wr}% N=${bestS.N} NET ${bestS.net>=0?"+":""}${bestS.net}%`);
})();
