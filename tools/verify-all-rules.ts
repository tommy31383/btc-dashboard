/**
 * verify-all-rules.ts
 *
 * Backtest CHÍNH THỨC từng rule trong hard_rules.json với fresh Binance data.
 * So sánh WR/NET thực tế vs stats đã lưu. Output:
 *   - assets/rules_verification.json (raw results)
 *   - assets/rules_verification_preview.html (visual report)
 *
 * KHÔNG ghi đè hard_rules.json — chỉ report.
 *
 * Logic backtest phải mirror useRuleAlerts.ts để đảm bảo consistent:
 *   - candleReversalFilter + emaPosFilter (rule reversal 4h)
 *   - requiredConditions (bitmask match)
 *   - htfTrendFilter (near/far/both)
 *   - minScore (popcount bits)
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { calcRSI, calcStochRSI, calcMACD, calcBollinger, detectDivergence, calcEMASeries, calcRSISeriesAligned, calcMACDSeries, calcBollingerSeries } from "../utils/indicators";

const BINANCE = "https://api.binance.com/api/v3";

interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number; }

const TF_CONFIG: Record<string, { candles: number; htfNear: string; htfFar: string }> = {
  "5m":  { candles: 10000, htfNear: "15m", htfFar: "1h" },
  "15m": { candles: 10000, htfNear: "1h",  htfFar: "4h" },
  "1h":  { candles: 10000, htfNear: "4h",  htfFar: "1d" },
  "4h":  { candles: 6000,  htfNear: "1d",  htfFar: "1w" },
  "1d":  { candles: 2000,  htfNear: "1w",  htfFar: "1M" },
  "1w":  { candles: 500,   htfNear: "1M",  htfFar: "1M" },
};

const TF_MINUTES: Record<string, number> = { "5m":5, "15m":15, "1h":60, "4h":240, "6h":360, "1d":1440, "1w":10080, "1M":43200 };

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

// Find 4h/HTF candle at or before a given entry-TF candle close time
function htfIdxAt(htf: Candle[], targetTime: number): number {
  let lo = 0, hi = htf.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (htf[mid].time <= targetTime) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

function trendFromEMA(price: number, ema: number | null): "UP"|"DOWN"|"FLAT" {
  if (ema == null) return "FLAT";
  const d = (price - ema) / ema * 100;
  return d > 0.3 ? "UP" : d < -0.3 ? "DOWN" : "FLAT";
}

function simulate(c: Candle[], entryIdx: number, entryPrice: number, side: "LONG"|"SHORT", tpPct: number, slPct: number, maxHold: number) {
  const tp = side === "LONG" ? entryPrice * (1 + tpPct/100) : entryPrice * (1 - tpPct/100);
  const sl = side === "LONG" ? entryPrice * (1 - slPct/100) : entryPrice * (1 + slPct/100);
  for (let i = entryIdx + 1; i < Math.min(entryIdx + 1 + maxHold, c.length); i++) {
    if (side === "LONG") {
      if (c[i].low <= sl) return { outcome: "LOSS" as const, holdBars: i - entryIdx };
      if (c[i].high >= tp) return { outcome: "WIN" as const, holdBars: i - entryIdx };
    } else {
      if (c[i].high >= sl) return { outcome: "LOSS" as const, holdBars: i - entryIdx };
      if (c[i].low <= tp) return { outcome: "WIN" as const, holdBars: i - entryIdx };
    }
  }
  return { outcome: "TIMEOUT" as const, holdBars: maxHold };
}

async function verifyTF(tfKey: string, rules: any[]): Promise<any[]> {
  const cfg = TF_CONFIG[tfKey];
  if (!cfg) { console.log(`  [${tfKey}] không có config, skip`); return []; }

  console.log(`\n=== [${tfKey}] Fetching ${cfg.candles} entry + HTF klines ===`);
  const entry = await fetchKlines(tfKey, cfg.candles);
  const htfNear = await fetchKlines(cfg.htfNear, Math.ceil(cfg.candles * TF_MINUTES[tfKey] / TF_MINUTES[cfg.htfNear]) + 100).catch(() => [] as Candle[]);
  const htfFar  = await fetchKlines(cfg.htfFar,  Math.ceil(cfg.candles * TF_MINUTES[tfKey] / TF_MINUTES[cfg.htfFar])  + 100).catch(() => [] as Candle[]);
  console.log(`  got ${entry.length} entry, ${htfNear.length} near, ${htfFar.length} far`);
  if (entry.length < 100) return [];

  const closes = entry.map(x => x.close);
  const rsiArr = calcRSISeriesAligned(closes, 14);
  const macdArr = calcMACDSeries(closes);
  const bbArr = calcBollingerSeries(closes, 20, 2);
  const ema50 = calcEMASeries(closes, 50);

  // Pre-compute StochK for each bar (expensive — simplified)
  const stochArr: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = 50; i < closes.length; i++) {
    const w = closes.slice(0, i + 1);
    const s = calcStochRSI(w);
    stochArr[i] = s.k;
  }
  // Divergence: compute per bar but expensive — sample every 5 bars, interpolate
  const divArr: ("BULLISH_DIV"|"BEARISH_DIV"|null)[] = new Array(closes.length).fill(null);
  for (let i = 50; i < closes.length; i++) {
    if (i % 3 === 0) divArr[i] = detectDivergence(closes.slice(0, i + 1)) as any;
    else divArr[i] = divArr[i-1];
  }

  // HTF trend series (EMA50)
  const htfNearCloses = htfNear.map(x => x.close);
  const htfFarCloses  = htfFar.map(x => x.close);
  const htfNearEMA = calcEMASeries(htfNearCloses, 50);
  const htfFarEMA  = calcEMASeries(htfFarCloses, 50);

  const results: any[] = [];

  for (const rule of rules) {
    const rcfg = rule.config || {};
    const ruleSide: "LONG"|"SHORT" = rcfg.forceSide || rule.stats?.side || "LONG";
    const lev = rcfg.leverage || 10;
    const tpPct = rcfg.targetPct || 2;
    const slPct = rcfg.stopPct || 1;
    const maxHold = rcfg.maxHoldBars || 100;
    const feePerSide = 0.04;
    const feePnl = feePerSide * 2 * lev;

    const required: string[] = rcfg.requiredConditions || [];
    const minScore = rcfg.minScore ?? 1;

    let wins = 0, losses = 0, timeouts = 0, sumHold = 0;
    let skippedHtfNear = 0, skippedHtfFar = 0, skippedNoSignal = 0, skippedReversal = 0, skippedEma = 0;

    for (let i = 50; i < entry.length - maxHold - 1; i++) {
      const price = closes[i];

      // candleReversalFilter (4h reversal rules)
      if (rcfg.candleReversalFilter) {
        const want = ruleSide === "LONG" ? "UP_REVERSAL" : "DOWN_REVERSAL";
        if (i < 1) continue;
        const prevBull = entry[i-1].close >= entry[i-1].open;
        const currBull = entry[i].close >= entry[i].open;
        const rev = prevBull === currBull ? null : (!prevBull && currBull ? "UP_REVERSAL" : "DOWN_REVERSAL");
        if (rev !== want) { skippedReversal++; continue; }
      }

      // emaPosFilter
      if (rcfg.emaPosFilter) {
        const e = ema50[i];
        if (e == null) continue;
        const above = price >= e;
        if (rcfg.emaPosFilter === "above" && !above) { skippedEma++; continue; }
        if (rcfg.emaPosFilter === "below" && above)  { skippedEma++; continue; }
      }

      // HTF trend filter
      if (rcfg.htfTrendFilter) {
        const mode = rcfg.htfTrendFilter.mode || rcfg.htfTrendFilter;
        const want = ruleSide === "LONG" ? "UP" : "DOWN";
        const t = entry[i].time + TF_MINUTES[tfKey] * 60 * 1000 - 1;
        const ni = htfIdxAt(htfNear, t);
        const fi = htfIdxAt(htfFar, t);
        const nt = ni >= 0 ? trendFromEMA(htfNear[ni].close, htfNearEMA[ni]) : "FLAT";
        const ft = fi >= 0 ? trendFromEMA(htfFar[fi].close, htfFarEMA[fi]) : "FLAT";
        if (mode === "near_match" && nt !== want) { skippedHtfNear++; continue; }
        if (mode === "far_match"  && ft !== want) { skippedHtfFar++;  continue; }
        if (mode === "both_match" && (nt !== want || ft !== want)) { skippedHtfNear++; continue; }
      }

      // Conditions
      const rsi = rsiArr[i];
      const stK = stochArr[i];
      const mh = macdArr.histogram[i];
      const pmh = i > 0 ? macdArr.histogram[i-1] : null;
      const bb = { upper: bbArr.upper[i], lower: bbArr.lower[i] };
      const div = divArr[i];

      const conds: Record<string, boolean> = {
        stochExtreme: stK !== null && (ruleSide === "LONG" ? stK < (rcfg.stochOSLevel ?? 5) : stK > (rcfg.stochOBLevel ?? 95)),
        rsiExtreme:   rsi !== null && (ruleSide === "LONG" ? rsi < (rcfg.rsiOSLevel ?? 25) : rsi > (rcfg.rsiOBLevel ?? 75)),
        divergence:   ruleSide === "LONG" ? div === "BULLISH_DIV" : div === "BEARISH_DIV",
        bollingerTouch: ruleSide === "LONG" ? (bb.lower !== null && price <= bb.lower) : (bb.upper !== null && price >= bb.upper),
        macdCross:    mh !== null && pmh !== null && (ruleSide === "LONG" ? ((pmh < 0 && mh >= 0) || mh > pmh) : ((pmh > 0 && mh <= 0) || mh < pmh)),
      };

      // Required conditions check
      let reqFail = false;
      for (const k of required) if (!conds[k]) { reqFail = true; break; }
      if (reqFail) { skippedNoSignal++; continue; }

      // minScore (if no required or candleReversal)
      if (!rcfg.candleReversalFilter && required.length === 0) {
        const n = Object.values(conds).filter(Boolean).length;
        if (n < minScore) { skippedNoSignal++; continue; }
      }

      // Entry
      const out = simulate(entry, i, price, ruleSide, tpPct, slPct, maxHold);
      if (out.outcome === "WIN") wins++;
      else if (out.outcome === "LOSS") losses++;
      else timeouts++;
      sumHold += out.holdBars;
    }

    const trades = wins + losses + timeouts;
    const grossPct = wins * tpPct * lev - losses * slPct * lev;
    const feesPct = trades * feePnl;
    const netPct = grossPct - feesPct;
    const wr = trades > 0 ? (wins / trades) * 100 : 0;
    const avgHold = trades > 0 ? sumHold / trades : 0;

    const saved = rule.stats || {};
    const savedNet = typeof saved.netPnL === "number" ? saved.netPnL : null;
    const savedWr  = typeof saved.winRate === "number" ? saved.winRate : null;
    const netDrift = savedNet !== null ? netPct - savedNet : null;
    const wrDrift  = savedWr  !== null ? wr - savedWr : null;

    let verdict: "MATCH" | "DRIFT" | "BROKEN" | "DEAD";
    if (trades < 10) verdict = "DEAD";
    else if (savedNet === null || savedNet === undefined) verdict = "BROKEN";
    else if (Math.abs(netDrift || 0) / Math.max(1, Math.abs(savedNet)) > 0.3) verdict = "DRIFT";
    else verdict = "MATCH";

    const result = {
      tfKey, rank: rule.rank, label: rule.label || `${ruleSide} rank${rule.rank}`,
      side: ruleSide,
      config: { tpPct, slPct, lev, maxHold, required, minScore, htfFilter: rcfg.htfTrendFilter?.mode || rcfg.htfTrendFilter?.label || null, reversal: !!rcfg.candleReversalFilter, emaPosFilter: rcfg.emaPosFilter || null },
      fresh: { trades, wins, losses, timeouts, winRate: +wr.toFixed(1), netPnL: +netPct.toFixed(0), avgHold: +avgHold.toFixed(1) },
      saved: { trades: saved.trades ?? null, winRate: savedWr, netPnL: savedNet },
      drift: { netPct: netDrift !== null ? +netDrift.toFixed(0) : null, wrPct: wrDrift !== null ? +wrDrift.toFixed(1) : null },
      verdict,
      skipStats: { htfNear: skippedHtfNear, htfFar: skippedHtfFar, noSignal: skippedNoSignal, reversal: skippedReversal, ema: skippedEma },
    };
    results.push(result);
    const fresh = result.fresh;
    console.log(`  #${String(rule.rank).padStart(2)} ${ruleSide.padEnd(5)} ${('+'+tpPct+'/-'+slPct).padEnd(9)} N=${String(fresh.trades).padStart(5)} WR=${String(fresh.winRate).padStart(5)}% NET=${(fresh.netPnL>=0?'+':'')+fresh.netPnL}% [saved NET=${savedNet}%] → ${verdict}`);
  }
  return results;
}

(async () => {
  console.log(`=== verify-all-rules ===`);
  const rulesPath = join(__dirname, "..", "assets", "hard_rules.json");
  const raw = JSON.parse(readFileSync(rulesPath, "utf8"));

  const argsTF = process.argv.slice(2).find(a => a.startsWith("--tf="))?.split("=")[1];
  const tfList = argsTF ? argsTF.split(",") : Object.keys(raw.tfs);

  const allResults: any[] = [];
  for (const tfKey of tfList) {
    const rules = raw.tfs[tfKey]?.rules || [];
    if (rules.length === 0) continue;
    const res = await verifyTF(tfKey, rules);
    allResults.push(...res);
  }

  const outJson = join(__dirname, "..", "assets", "rules_verification.json");
  writeFileSync(outJson, JSON.stringify({ generatedAt: new Date().toISOString(), results: allResults }, null, 2));
  console.log(`\n✅ Wrote ${outJson}`);

  // Summary
  const byVerdict: Record<string, number> = {};
  for (const r of allResults) byVerdict[r.verdict] = (byVerdict[r.verdict] || 0) + 1;
  console.log(`\nSummary: ${JSON.stringify(byVerdict)}`);
})();
