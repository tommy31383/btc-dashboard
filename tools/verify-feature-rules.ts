/**
 * verify-feature-rules.ts — v4.3.15 Learning Loop iteration 1
 *
 * Chạy backtest CHÍNH THỨC 5 rule mới (rank 1-5 của 1h TF) với filter mới:
 *   atrFilter, macdHistFilter, emaDistFilter, htfTrendFilter (mode flat/custom)
 *
 * Đặc biệt: lưu HTF context (4h trend, 1d trend, 4h RSI) cho MỖI trade thắng/thua
 * → cho phép phân tích "loss thường xảy ra khi HTF nào" để auto-suggest adjust.
 *
 * Output:
 *   - assets/feature_rules_verification.json  (raw per-trade + summary)
 *   - assets/learning_report_v4.3.15.md       (human-readable)
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  calcRSI, calcRSISeriesAligned, calcMACDSeries, calcEMASeries,
} from "../utils/indicators";

const BINANCE = "https://api.binance.com/api/v3";
interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number; }
const TF_MIN: Record<string, number> = { "15m":15, "1h":60, "4h":240, "1d":1440, "1w":10080 };

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
  while (lo <= hi) { const mid = (lo+hi)>>1; if (htf[mid].time <= t) { ans=mid; lo=mid+1; } else hi=mid-1; }
  return ans;
}

function trendFromEMA(price: number, ema: number | null): "UP"|"DOWN"|"FLAT" {
  if (ema == null) return "FLAT";
  const d = (price - ema) / ema * 100;
  return d > 0.3 ? "UP" : d < -0.3 ? "DOWN" : "FLAT";
}

// ATR series Wilder 14
function calcATRPctSeries(c: Candle[], period = 14): (number | null)[] {
  const n = c.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (n < period + 1) return out;
  let sum = 0;
  for (let i = 1; i <= period; i++) {
    const tr = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i-1].close), Math.abs(c[i].low - c[i-1].close));
    sum += tr;
  }
  let atr = sum / period;
  out[period] = c[period].close > 0 ? (atr / c[period].close) * 100 : null;
  for (let i = period + 1; i < n; i++) {
    const tr = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i-1].close), Math.abs(c[i].low - c[i-1].close));
    atr = (atr * (period - 1) + tr) / period;
    out[i] = c[i].close > 0 ? (atr / c[i].close) * 100 : null;
  }
  return out;
}

function simulate(c: Candle[], entryIdx: number, entryPrice: number, side: "LONG"|"SHORT", tpPct: number, slPct: number, maxHold: number) {
  const tp = side === "LONG" ? entryPrice * (1 + tpPct/100) : entryPrice * (1 - tpPct/100);
  const sl = side === "LONG" ? entryPrice * (1 - slPct/100) : entryPrice * (1 + slPct/100);
  for (let i = entryIdx + 1; i < Math.min(entryIdx + 1 + maxHold, c.length); i++) {
    if (side === "LONG") {
      if (c[i].low  <= sl) return { outcome: "LOSS" as const, holdBars: i - entryIdx };
      if (c[i].high >= tp) return { outcome: "WIN"  as const, holdBars: i - entryIdx };
    } else {
      if (c[i].high >= sl) return { outcome: "LOSS" as const, holdBars: i - entryIdx };
      if (c[i].low  <= tp) return { outcome: "WIN"  as const, holdBars: i - entryIdx };
    }
  }
  return { outcome: "TIMEOUT" as const, holdBars: maxHold };
}

type FeatFilter = { op: ">"|"<"|">="|"<="|"between"; value?: number; min?: number; max?: number };

function evalFeat(v: number | null, f: FeatFilter | undefined): boolean {
  if (!f) return true;
  if (v === null) return false;
  switch (f.op) {
    case ">":  return v >  (f.value ?? 0);
    case "<":  return v <  (f.value ?? 0);
    case ">=": return v >= (f.value ?? 0);
    case "<=": return v <= (f.value ?? 0);
    case "between": return v >= (f.min ?? -Infinity) && v <= (f.max ?? Infinity);
  }
  return false;
}

(async () => {
  console.log(`=== verify-feature-rules v4.3.15 ===`);
  const rulesPath = join(__dirname, "..", "assets", "hard_rules.json");
  const raw = JSON.parse(readFileSync(rulesPath, "utf8"));
  const rules1h = (raw.tfs["1h"].rules as any[]).filter((r) => r.rank <= 5);
  console.log(`Target: ${rules1h.length} new feature rules on 1h`);

  console.log(`\nFetching klines…`);
  const entry = await fetchKlines("1h", 10000);
  const htf4h  = await fetchKlines("4h", 3000);
  const htf1d  = await fetchKlines("1d", 800);
  const htf1w  = await fetchKlines("1w", 200);
  console.log(`  entry=${entry.length}  4h=${htf4h.length}  1d=${htf1d.length}  1w=${htf1w.length}`);

  const closes = entry.map(x => x.close);
  const rsiArr = calcRSISeriesAligned(closes, 14);
  const macdArr = calcMACDSeries(closes);
  const ema50Arr = calcEMASeries(closes, 50);
  const atrArr = calcATRPctSeries(entry, 14);

  const emaDistArr: (number | null)[] = closes.map((p, i) => {
    const e = ema50Arr[i]; return e !== null && e > 0 ? ((p - e) / e) * 100 : null;
  });

  // HTF EMA + RSI
  const c4h = htf4h.map(x => x.close);
  const ema50_4h = calcEMASeries(c4h, 50);
  const rsi4hArr = calcRSISeriesAligned(c4h, 14);
  const c1d = htf1d.map(x => x.close);
  const ema50_1d = calcEMASeries(c1d, 50);
  const rsi1dArr = calcRSISeriesAligned(c1d, 14);
  const c1w = htf1w.map(x => x.close);
  const ema50_1w = calcEMASeries(c1w, 50);

  const tfMs = TF_MIN["1h"] * 60 * 1000;

  // Multi-TF score (mirrors tools/multi-tf-score-scan-v2.ts iter4 weights)
  function computeMultiTfScore(side: "LONG"|"SHORT", i: number): number {
    let L = 0, S = 0;
    const t = entry[i].time + tfMs - 1;
    const i4 = htfIdxAt(htf4h, t);
    const i1 = htfIdxAt(htf1d, t);
    const iw = htfIdxAt(htf1w, t);
    const t4 = i4 >= 0 ? trendFromEMA(htf4h[i4].close, ema50_4h[i4]) : "FLAT";
    const r4 = i4 >= 0 ? rsi4hArr[i4] : null;
    const t1 = i1 >= 0 ? trendFromEMA(htf1d[i1].close, ema50_1d[i1]) : "FLAT";
    const r1 = i1 >= 0 ? rsi1dArr[i1] : null;
    const tw = iw >= 0 ? trendFromEMA(htf1w[iw].close, ema50_1w[iw]) : "FLAT";
    if (t4 === "FLAT") L += 30;
    if (t4 === "DOWN") { L -= 20; S -= 20; }
    if (t4 === "UP") S += 25;
    if (t1 === "FLAT" || t1 === "UP") L += 10;
    if (r1 !== null && r1 > 75) L -= 25;
    if (r1 !== null && r1 > 65) S += 15;
    if (r1 !== null && r1 < 40) S -= 15;
    if (tw === "UP" || tw === "FLAT") L += 8;
    if (tw === "UP") S += 10;
    const a1 = atrArr[i];
    if (a1 !== null && a1 < 0.3) L += 25;
    const ed = emaDistArr[i];
    if (ed !== null && ed >= -0.5 && ed <= 0.5) L += 20;
    if (ed !== null && ed > 2) S += 20;
    const rr = rsiArr[i];
    if (rr !== null && rr < 60) L += 10;
    if (rr !== null && rr > 70) { L -= 30; S += 20; }
    if (rr !== null && rr < 50) S -= 15;
    return side === "LONG" ? L : S;
  }

  const allResults: any[] = [];

  for (const rule of rules1h) {
    const cfg = rule.config;
    const side: "LONG"|"SHORT" = cfg.forceSide;
    const tpPct = cfg.targetPct, slPct = cfg.stopPct, maxHold = cfg.maxHoldBars;
    const lev = cfg.leverage;
    const feePnl = 0.04 * 2 * lev;

    let wins=0, losses=0, timeouts=0, sumHold=0;
    let skipFilter = 0;
    const tradeDetails: any[] = []; // per-trade HTF context

    for (let i = 60; i < entry.length - maxHold - 1; i++) {
      const price = closes[i];

      // htfTrendFilter
      if (cfg.htfTrendFilter) {
        const mode = cfg.htfTrendFilter.mode;
        const t = entry[i].time + tfMs - 1;
        const i4 = htfIdxAt(htf4h, t);
        const i1d = htfIdxAt(htf1d, t);
        const t4 = i4 >= 0 ? trendFromEMA(htf4h[i4].close, ema50_4h[i4]) : "FLAT";
        const t1d = i1d >= 0 ? trendFromEMA(htf1d[i1d].close, ema50_1d[i1d]) : "FLAT";
        const want = side === "LONG" ? "UP" : "DOWN";
        if (mode === "near_match" && t4 !== want) { skipFilter++; continue; }
        if (mode === "far_match"  && t1d !== want) { skipFilter++; continue; }
        if (mode === "both_match" && (t4 !== want || t1d !== want)) { skipFilter++; continue; }
        if (mode === "near_flat"  && t4 !== "FLAT") { skipFilter++; continue; }
        if (mode === "far_flat"   && t1d !== "FLAT") { skipFilter++; continue; }
        if (mode === "both_flat"  && (t4 !== "FLAT" || t1d !== "FLAT")) { skipFilter++; continue; }
        if (typeof mode === "object" && mode.want) {
          const sel = mode.tf === "far" ? t1d : t4;
          if (sel !== mode.want) { skipFilter++; continue; }
        }
      }

      // htfRsiFilter (4h or 1d)
      if (cfg.htfRsiFilter) {
        const f = cfg.htfRsiFilter;
        const t = entry[i].time + tfMs - 1;
        let v: number | null = null;
        if (f.tf === "4h") { const ii = htfIdxAt(htf4h, t); v = ii>=0 ? rsi4hArr[ii] : null; }
        else if (f.tf === "1d") { const ii = htfIdxAt(htf1d, t); v = ii>=0 ? rsi1dArr[ii] : null; }
        if (v === null) { skipFilter++; continue; }
        const ok = f.op === ">" ? v > f.value : f.op === "<" ? v < f.value : f.op === ">=" ? v >= f.value : v <= f.value;
        if (!ok) { skipFilter++; continue; }
      }

      // multiTfScoreFilter
      if (cfg.multiTfScoreFilter) {
        const f = cfg.multiTfScoreFilter;
        const sc = computeMultiTfScore(f.side || side, i);
        if (sc < (f.threshold ?? 0)) { skipFilter++; continue; }
      }

      // atrFilter
      if (cfg.atrFilter && !evalFeat(atrArr[i], cfg.atrFilter)) { skipFilter++; continue; }
      // macdHistFilter
      if (cfg.macdHistFilter && !evalFeat(macdArr.histogram[i], cfg.macdHistFilter)) { skipFilter++; continue; }
      // emaDistFilter
      if (cfg.emaDistFilter && !evalFeat(emaDistArr[i], cfg.emaDistFilter)) { skipFilter++; continue; }

      // requiredConditions (rule #5 has rsiExtreme)
      if (cfg.requiredConditions?.length) {
        const rsi = rsiArr[i];
        const conds: Record<string, boolean> = {
          rsiExtreme: rsi !== null && (side === "LONG" ? rsi < (cfg.rsiOSLevel ?? 25) : rsi > (cfg.rsiOBLevel ?? 75)),
        };
        let fail = false;
        for (const k of cfg.requiredConditions) if (!conds[k]) { fail = true; break; }
        if (fail) { skipFilter++; continue; }
      }

      // Entry! Capture HTF context before simulate
      const t = entry[i].time + tfMs - 1;
      const i4 = htfIdxAt(htf4h, t);
      const i1d = htfIdxAt(htf1d, t);
      const ctx = {
        t4hTrend: i4 >= 0 ? trendFromEMA(htf4h[i4].close, ema50_4h[i4]) : "NA",
        t1dTrend: i1d >= 0 ? trendFromEMA(htf1d[i1d].close, ema50_1d[i1d]) : "NA",
        rsi4h: i4 >= 0 ? (rsi4hArr[i4] ?? null) : null,
        rsi1d: i1d >= 0 ? (rsi1dArr[i1d] ?? null) : null,
        atr1h: atrArr[i],
        emaDist1h: emaDistArr[i],
        macdHist: macdArr.histogram[i],
        rsi1h: rsiArr[i],
      };

      const out = simulate(entry, i, price, side, tpPct, slPct, maxHold);
      if (out.outcome === "WIN") wins++;
      else if (out.outcome === "LOSS") losses++;
      else timeouts++;
      sumHold += out.holdBars;
      tradeDetails.push({ entryTime: entry[i].time, outcome: out.outcome, hold: out.holdBars, ...ctx });
    }

    const trades = wins + losses + timeouts;
    const grossPct = wins * tpPct * lev - losses * slPct * lev;
    const feesPct = trades * feePnl;
    const netPct = grossPct - feesPct;
    const wr = trades > 0 ? (wins / trades) * 100 : 0;

    const saved = rule.stats;
    const drift = { wr: +(wr - saved.winRate).toFixed(1), n: trades - saved.trades };

    // LEARNING: phân tích loss cases
    const lossDetails = tradeDetails.filter(t => t.outcome === "LOSS");
    const winDetails  = tradeDetails.filter(t => t.outcome === "WIN");
    const avgLossRSI4h = lossDetails.length ? lossDetails.reduce((a,b)=>a+(b.rsi4h||0),0)/lossDetails.length : null;
    const avgWinRSI4h  = winDetails.length  ? winDetails.reduce((a,b)=>a+(b.rsi4h||0),0)/winDetails.length : null;
    const lossBy4hTrend: Record<string, number> = {};
    for (const t of lossDetails) lossBy4hTrend[t.t4hTrend] = (lossBy4hTrend[t.t4hTrend] || 0) + 1;
    const winBy4hTrend: Record<string, number> = {};
    for (const t of winDetails)  winBy4hTrend[t.t4hTrend] = (winBy4hTrend[t.t4hTrend] || 0) + 1;
    const lossBy1dTrend: Record<string, number> = {};
    for (const t of lossDetails) lossBy1dTrend[t.t1dTrend] = (lossBy1dTrend[t.t1dTrend] || 0) + 1;

    // Auto-suggest next iteration
    const suggestions: string[] = [];
    if (trades < 30) suggestions.push(`⚠️ N=${trades} quá ít, relax filter hoặc lấy thêm data`);
    if (avgLossRSI4h !== null && avgWinRSI4h !== null && Math.abs(avgLossRSI4h - avgWinRSI4h) > 8) {
      suggestions.push(`💡 Loss có RSI 4h TB=${avgLossRSI4h.toFixed(1)} vs Win=${avgWinRSI4h.toFixed(1)} → thêm htfRsiFilter 4h ${side==="LONG"?">":"< "}${Math.round((avgLossRSI4h+avgWinRSI4h)/2)}`);
    }
    const domLossTrend = Object.entries(lossBy4hTrend).sort((a,b)=>b[1]-a[1])[0];
    if (domLossTrend && domLossTrend[1] / Math.max(1,losses) > 0.6) {
      suggestions.push(`💡 ${((domLossTrend[1]/Math.max(1,losses))*100).toFixed(0)}% loss xảy ra khi 4h trend = ${domLossTrend[0]} → nếu khác rule intent, thêm filter loại`);
    }
    if (wr >= saved.winRate - 5 && trades >= 30) suggestions.push(`✅ WR match/beat claim, rule OK`);

    const result = {
      rank: rule.rank, label: rule.label, side,
      config: { tpPct, slPct, maxHold, lev, filters: { atr: cfg.atrFilter, macdHist: cfg.macdHistFilter, emaDist: cfg.emaDistFilter, htf: cfg.htfTrendFilter } },
      saved: { winRate: saved.winRate, trades: saved.trades, netPnL: saved.netPnL },
      fresh: { trades, wins, losses, timeouts, winRate: +wr.toFixed(1), netPnL: +netPct.toFixed(0), avgHold: trades>0 ? +(sumHold/trades).toFixed(1) : 0 },
      drift,
      accuracy: saved.winRate > 0 ? +((100 - Math.abs(wr - saved.winRate) / saved.winRate * 100)).toFixed(1) : 0,
      skipFilter,
      lossAnalysis: {
        avgLossRSI4h: avgLossRSI4h !== null ? +avgLossRSI4h.toFixed(1) : null,
        avgWinRSI4h:  avgWinRSI4h  !== null ? +avgWinRSI4h.toFixed(1)  : null,
        lossBy4hTrend, winBy4hTrend, lossBy1dTrend,
      },
      suggestions,
    };

    allResults.push(result);
    console.log(`\n#${rule.rank} [${side}] ${rule.label}`);
    console.log(`  Saved:  WR ${saved.winRate}% N=${saved.trades}`);
    console.log(`  Fresh:  WR ${wr.toFixed(1)}% N=${trades} NET=${netPct.toFixed(0)}%  drift ${drift.wr>=0?"+":""}${drift.wr}%`);
    console.log(`  Accuracy: ${result.accuracy}%  (skipFilter=${skipFilter})`);
    for (const s of suggestions) console.log(`  ${s}`);
  }

  // Write JSON
  const iterTag = process.argv.find((a) => a.startsWith("--iter="))?.split("=")[1] || "iter1";
  const outPath = join(__dirname, "..", "assets", `feature_rules_verification_${iterTag}.json`);
  writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), version: `v4.3.15-${iterTag}`, results: allResults }, null, 2));
  console.log(`\n✅ Wrote ${outPath}`);

  // Write markdown report
  const mdLines: string[] = [];
  mdLines.push(`# Learning Report — v4.3.15 iteration 1`);
  mdLines.push(`Generated: ${new Date().toISOString()}`);
  mdLines.push(`Data: Binance BTCUSDT, 10K candles 1h + HTF 4h/1d\n`);
  mdLines.push(`## Summary`);
  mdLines.push(`| # | Side | Label | Claim WR | Fresh WR | Drift | Accuracy | N | Verdict |`);
  mdLines.push(`|---|---|---|---|---|---|---|---|---|`);
  for (const r of allResults) {
    const verdict = r.fresh.trades < 10 ? "🔴 DEAD" : r.accuracy >= 90 ? "🟢 VERIFIED" : r.accuracy >= 70 ? "🟡 PARTIAL" : "🔴 DRIFT";
    mdLines.push(`| ${r.rank} | ${r.side} | ${r.label} | ${r.saved.winRate}% | ${r.fresh.winRate}% | ${r.drift.wr>=0?"+":""}${r.drift.wr}% | ${r.accuracy}% | ${r.fresh.trades} | ${verdict} |`);
  }
  mdLines.push(`\n## Per-rule loss analysis`);
  for (const r of allResults) {
    mdLines.push(`\n### #${r.rank} [${r.side}] ${r.label}`);
    mdLines.push(`- Trades: ${r.fresh.trades} (W${r.fresh.wins} / L${r.fresh.losses} / T${r.fresh.timeouts})`);
    mdLines.push(`- Avg RSI 4h at LOSS: ${r.lossAnalysis.avgLossRSI4h ?? "—"}, at WIN: ${r.lossAnalysis.avgWinRSI4h ?? "—"}`);
    mdLines.push(`- Loss by 4h trend: ${JSON.stringify(r.lossAnalysis.lossBy4hTrend)}`);
    mdLines.push(`- Win by 4h trend:  ${JSON.stringify(r.lossAnalysis.winBy4hTrend)}`);
    mdLines.push(`- Loss by 1d trend: ${JSON.stringify(r.lossAnalysis.lossBy1dTrend)}`);
    mdLines.push(`- Suggestions:`);
    for (const s of r.suggestions) mdLines.push(`  - ${s}`);
  }
  mdLines.push(`\n## Next iteration plan`);
  mdLines.push(`Based on suggestions above, re-inject rule v2 with HTF 1d context filter + adjusted thresholds.`);

  const mdPath = join(__dirname, "..", "assets", `learning_report_v4.3.15_${iterTag}.md`);
  writeFileSync(mdPath, mdLines.join("\n"));
  console.log(`✅ Wrote ${mdPath}`);
})();
