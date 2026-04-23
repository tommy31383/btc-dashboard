/**
 * analyze-my-rule.ts
 *
 * DEEP forensic analysis of a user-defined rule. Answers:
 *   1. Which entries FAILED (lost money)?
 *   2. What did StochRSI + RSI look like on BOTH 15m AND 1H at each entry?
 *   3. What TP/SL combo would have flipped losers to winners?
 *   4. What SITUATIONS systematically cause losses?
 *
 * Usage:
 *   npx tsx tools/analyze-my-rule.ts tools/my_rules/rule_03.json
 *   npx tsx tools/analyze-my-rule.ts tools/my_rules/rule_03.json --candles=5000
 */

import { readFileSync, existsSync } from "fs";
import { Candle, EntryConditions, BacktestConfig } from "../utils/backtester";
import { calcRSI, calcStochRSI, calcMACD, calcBollinger, detectDivergence } from "../utils/indicators";

const BINANCE_REST = "https://api.binance.com/api/v3";

// ── CLI ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const rulePath = args.find((a) => !a.startsWith("--"));
const argCandles = parseInt(args.find((a) => a.startsWith("--candles="))?.replace("--candles=", "") || "5000", 10);

if (!rulePath || !existsSync(rulePath)) {
  console.error("Usage: npx tsx tools/analyze-my-rule.ts <rule.json> [--candles=5000]");
  process.exit(1);
}

// ── Load rule ───────────────────────────────────────────────────────────────
type CompOp = ">" | "<" | ">=" | "<=";
type IndName = "rsi" | "stochK" | "stochD";
interface HtfRsiFilter { tf: string; op: CompOp; value: number; }
type HtfFilter =
  | { type: "trend"; tf?: string; direction: "up" | "down" | "flat" }
  | { type: "rsi"; tf: string; op: CompOp; value: number }
  | { type: "slope"; tf: string; indicator: IndName; direction: "rising" | "falling"; lookback?: number }
  | { type: "compare"; tf: string; left: IndName; op: CompOp; right: IndName | number }
  | { type: "stochRange"; tf: string; kMin?: number; kMax?: number; dMin?: number; dMax?: number }
  | { type: "cross"; tf: string; direction: "k_above_d" | "k_below_d" | "bullish_cross" | "bearish_cross" };
interface MyRuleFile {
  label: string;
  tfKey: string;
  forceSide?: "LONG" | "SHORT";
  config: BacktestConfig & {
    htfTrendFilter?: { mode: string } | string;
    htfRsiFilter?: HtfRsiFilter;
    htfFilters?: HtfFilter[];
  };
}
const ruleFile: MyRuleFile = JSON.parse(readFileSync(rulePath, "utf8"));
const cfg = ruleFile.config;
const tfKey = ruleFile.tfKey;
const forceSide = ruleFile.forceSide || cfg.forceSide;

const HTF_MAP: Record<string, [string, string]> = {
  "5m": ["15m", "1h"], "15m": ["1h", "4h"], "1h": ["4h", "1d"], "4h": ["1d", "1w"],
};
const [HTF_NEAR, HTF_FAR] = HTF_MAP[tfKey] || ["1h", "4h"];

console.log(`\n════════════════════════════════════════════════════════════════`);
console.log(`  ANALYZE RULE: ${ruleFile.label}`);
console.log(`════════════════════════════════════════════════════════════════`);
console.log(`TF: ${tfKey}  ·  HTF: ${HTF_NEAR}/${HTF_FAR}  ·  Side: ${forceSide || "BOTH"}`);
console.log(`Thresholds: Stoch ${forceSide === "SHORT" ? `>${cfg.stochOBLevel}` : `<${cfg.stochOSLevel}`}  ·  RSI ${forceSide === "SHORT" ? `>${cfg.rsiOBLevel}` : `<${cfg.rsiOSLevel}`}`);
console.log(`TP/SL: +${cfg.targetPct}% / -${cfg.stopPct}%  ·  maxHold: ${cfg.maxHoldBars}`);
if (cfg.htfRsiFilter) console.log(`HTF RSI filter: ${cfg.htfRsiFilter.tf} RSI ${cfg.htfRsiFilter.op} ${cfg.htfRsiFilter.value}`);
if (cfg.htfTrendFilter) console.log(`HTF trend filter: ${JSON.stringify(cfg.htfTrendFilter)}`);
console.log(`Required: ${(cfg.requiredConditions || []).join(", ") || "(none)"}\n`);

// ── Fetch klines ────────────────────────────────────────────────────────────
async function fetchKlines(interval: string, total: number): Promise<Candle[]> {
  const all: Candle[] = [];
  let endTime: number | undefined;
  while (all.length < total) {
    const remaining = total - all.length;
    const limit = Math.min(1000, remaining);
    const params = new URLSearchParams({ symbol: "BTCUSDT", interval, limit: String(limit) });
    if (endTime) params.set("endTime", String(endTime));
    const res = await fetch(`${BINANCE_REST}/klines?${params.toString()}`);
    const data: any[] = await res.json();
    if (data.length === 0) break;
    const batch: Candle[] = data.map((k) => ({
      time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
      low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
    }));
    all.unshift(...batch);
    endTime = batch[0].time - 1;
    await new Promise((r) => setTimeout(r, 100));
  }
  const byTime = new Map<number, Candle>();
  for (const c of all) byTime.set(c.time, c);
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

// ── Indicator snapshots ─────────────────────────────────────────────────────
interface IndSnap {
  rsi: number | null;
  stochK: number | null;
  stochD: number | null;
}
function buildIndicatorSeries(candles: Candle[]): IndSnap[] {
  const out: IndSnap[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (i < 15) { out.push({ rsi: null, stochK: null, stochD: null }); continue; }
    const closes = candles.slice(0, i + 1).map((c) => c.close);
    const rsi = calcRSI(closes);
    const stoch = calcStochRSI(closes);
    out.push({ rsi, stochK: stoch.k, stochD: stoch.d });
  }
  return out;
}

/** Align HTF indicator series to every entry-TF candle index. */
function alignHTFSeries(entryCandles: Candle[], htfCandles: Candle[], htfSeries: IndSnap[]): IndSnap[] {
  const out: IndSnap[] = new Array(entryCandles.length).fill({ rsi: null, stochK: null, stochD: null });
  let j = 0;
  for (let i = 0; i < entryCandles.length; i++) {
    while (j + 1 < htfCandles.length && htfCandles[j + 1].time <= entryCandles[i].time) j++;
    if (htfCandles[j] && htfCandles[j].time <= entryCandles[i].time) {
      out[i] = htfSeries[j];
    }
  }
  return out;
}

// ── HTF EMA trend (for htfTrendFilter support) ──────────────────────────────
type Trend = "UP" | "DOWN" | "FLAT";
function calcEMASeries(closes: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = ema;
  for (let i = period; i < closes.length; i++) { ema = closes[i] * k + ema * (1 - k); out[i] = ema; }
  return out;
}
function buildHTFTrendArr(entryCandles: Candle[], htfCandles: Candle[]): Trend[] {
  const closes = htfCandles.map((c) => c.close);
  const ema = calcEMASeries(closes, 50);
  const trends: Trend[] = htfCandles.map((c, i) => {
    if (ema[i] === null) return "FLAT";
    const d = ((c.close - ema[i]!) / ema[i]!) * 100;
    return d > 0.3 ? "UP" : d < -0.3 ? "DOWN" : "FLAT";
  });
  const out: Trend[] = new Array(entryCandles.length).fill("FLAT");
  let j = 0;
  for (let i = 0; i < entryCandles.length; i++) {
    while (j + 1 < htfCandles.length && htfCandles[j + 1].time <= entryCandles[i].time) j++;
    out[i] = trends[j] || "FLAT";
  }
  return out;
}

// ── Entry condition eval ────────────────────────────────────────────────────
const MIN_LOOKBACK = 50;
interface CandleConds { longConds: EntryConditions; shortConds: EntryConditions; }
function computeConditionsAt(candles: Candle[], idx: number, cfg: BacktestConfig): CandleConds {
  const empty = { stochExtreme: false, rsiExtreme: false, divergence: false, bollingerTouch: false, macdCross: false };
  if (idx < MIN_LOOKBACK) return { longConds: empty, shortConds: empty };
  const closes = candles.slice(0, idx + 1).map((c) => c.close);
  const price = candles[idx].close;
  const rsi = calcRSI(closes);
  if (rsi === null) return { longConds: empty, shortConds: empty };
  const stoch = calcStochRSI(closes);
  const macd = calcMACD(closes);
  const bb = calcBollinger(closes);
  const div = closes.length >= 44 ? detectDivergence(closes) : null;
  const prevCloses = candles.slice(0, idx).map((c) => c.close);
  const prevMacd = prevCloses.length >= 35 ? calcMACD(prevCloses) : null;
  const longConds: EntryConditions = {
    stochExtreme: stoch.k !== null && stoch.k < cfg.stochOSLevel,
    rsiExtreme: rsi < cfg.rsiOSLevel,
    divergence: div === "BULLISH_DIV",
    bollingerTouch: bb.lower !== null && price <= bb.lower,
    macdCross: macd.histogram !== null && prevMacd !== null && prevMacd.histogram !== null && (
      (prevMacd.histogram < 0 && macd.histogram >= 0) || (macd.histogram > prevMacd.histogram)
    ),
  };
  const shortConds: EntryConditions = {
    stochExtreme: stoch.k !== null && stoch.k > cfg.stochOBLevel,
    rsiExtreme: rsi > cfg.rsiOBLevel,
    divergence: div === "BEARISH_DIV",
    bollingerTouch: bb.upper !== null && price >= bb.upper,
    macdCross: macd.histogram !== null && prevMacd !== null && prevMacd.histogram !== null && (
      (prevMacd.histogram > 0 && macd.histogram <= 0) || (macd.histogram < prevMacd.histogram)
    ),
  };
  return { longConds, shortConds };
}

function applyCompOp(left: number, op: CompOp, right: number): boolean {
  switch (op) { case ">": return left > right; case "<": return left < right; case ">=": return left >= right; case "<=": return left <= right; }
}
function readInd(series: { rsi: (number|null)[]; stochK: (number|null)[]; stochD: (number|null)[] }, name: IndName, idx: number) {
  return (name === "rsi" ? series.rsi : name === "stochK" ? series.stochK : series.stochD)[idx];
}
function evalHtfFilter(
  f: HtfFilter,
  htfSeriesByTF: Record<string, { rsi: (number|null)[]; stochK: (number|null)[]; stochD: (number|null)[] }>,
  htfAlignByTF: Record<string, number[]>,
  entryIdx: number,
  trendsByTF: Record<string, Trend[]>,
): boolean {
  const tf = (f as any).tf || HTF_NEAR;
  const series = htfSeriesByTF[tf];
  const align = htfAlignByTF[tf];
  if (!series || !align) return false;
  const idx = align[entryIdx];
  if (idx < 0) return false;
  switch (f.type) {
    case "trend": {
      const want: Trend = f.direction === "up" ? "UP" : f.direction === "down" ? "DOWN" : "FLAT";
      return (trendsByTF[tf] || [])[entryIdx] === want;
    }
    case "rsi": {
      const v = series.rsi[idx]; if (v === null) return false;
      return applyCompOp(v, f.op, f.value);
    }
    case "slope": {
      const lb = f.lookback ?? 3; if (idx - lb < 0) return false;
      const now = readInd(series, f.indicator, idx); const past = readInd(series, f.indicator, idx - lb);
      if (now === null || past === null) return false;
      return f.direction === "rising" ? (now - past) > 0 : (now - past) < 0;
    }
    case "compare": {
      const l = readInd(series, f.left, idx); if (l === null) return false;
      const r = typeof f.right === "number" ? f.right : readInd(series, f.right, idx);
      if (r === null) return false;
      return applyCompOp(l, f.op, r);
    }
    case "stochRange": {
      const k = series.stochK[idx]; const d = series.stochD[idx];
      if (k === null) return false;
      if (f.kMin !== undefined && k < f.kMin) return false;
      if (f.kMax !== undefined && k > f.kMax) return false;
      if (f.dMin !== undefined && (d === null || d < f.dMin)) return false;
      if (f.dMax !== undefined && (d === null || d > f.dMax)) return false;
      return true;
    }
    case "cross": {
      const k = series.stochK[idx]; const d = series.stochD[idx];
      if (k === null || d === null) return false;
      if (f.direction === "k_above_d") return k > d;
      if (f.direction === "k_below_d") return k < d;
      if (idx < 1) return false;
      const pk = series.stochK[idx-1]; const pd = series.stochD[idx-1];
      if (pk === null || pd === null) return false;
      if (f.direction === "bullish_cross") return pk <= pd && k > d;
      if (f.direction === "bearish_cross") return pk >= pd && k < d;
      return false;
    }
  }
}

function ruleFires(
  conds: EntryConditions, cfg: BacktestConfig,
  htfNear: Trend, htfFar: Trend, htfNearRsi: number | null, htfFarRsi: number | null,
  side: "LONG" | "SHORT",
  entryIdx: number,
  htfSeriesByTF: Record<string, { rsi: (number|null)[]; stochK: (number|null)[]; stochD: (number|null)[] }>,
  htfAlignByTF: Record<string, number[]>,
  trendsByTF: Record<string, Trend[]>,
): boolean {
  const want: Trend = side === "LONG" ? "UP" : "DOWN";
  if ((cfg as any).htfTrendFilter) {
    const f = (cfg as any).htfTrendFilter; const mode = f.mode || f;
    if (mode === "near_match" && htfNear !== want) return false;
    if (mode === "far_match" && htfFar !== want) return false;
    if (mode === "both_match" && (htfNear !== want || htfFar !== want)) return false;
  }
  if ((cfg as any).htfRsiFilter) {
    const f = (cfg as any).htfRsiFilter as HtfRsiFilter;
    const rsi = f.tf === HTF_NEAR ? htfNearRsi : f.tf === HTF_FAR ? htfFarRsi : null;
    if (rsi === null) return false;
    const pass = f.op === ">" ? rsi > f.value : f.op === "<" ? rsi < f.value : f.op === ">=" ? rsi >= f.value : rsi <= f.value;
    if (!pass) return false;
  }
  const htfFilters = (cfg as any).htfFilters as HtfFilter[] | undefined;
  if (htfFilters?.length) {
    for (const f of htfFilters) {
      if (!evalHtfFilter(f, htfSeriesByTF, htfAlignByTF, entryIdx, trendsByTF)) return false;
    }
  }
  if (cfg.requiredConditions?.length) for (const k of cfg.requiredConditions) if (!conds[k]) return false;
  if (cfg.weights) {
    let s = 0; for (const k of Object.keys(cfg.weights) as (keyof EntryConditions)[]) if (conds[k]) s += cfg.weights[k] || 0;
    if (s < (cfg.minWeightedScore || 1)) return false;
  } else {
    const cnt = Object.values(conds).filter(Boolean).length;
    if (cnt < (cfg.minScore || 1)) return false;
  }
  return true;
}

// ── Simulate trade WITH MFE/MAE tracking ────────────────────────────────────
interface Outcome {
  outcome: "WIN" | "LOSS" | "TIMEOUT";
  pnlPct: number;
  holdBars: number;
  maePct: number; // max adverse excursion (most negative during trade)
  mfePct: number; // max favorable excursion (most positive during trade)
}
function simulate(
  candles: Candle[], entryIdx: number, side: "LONG" | "SHORT",
  targetPct: number, stopPct: number, maxHoldBars: number,
): Outcome {
  const entryPrice = candles[entryIdx].close;
  const maxIdx = Math.min(entryIdx + maxHoldBars, candles.length - 1);
  let mae = 0, mfe = 0;
  for (let i = entryIdx + 1; i <= maxIdx; i++) {
    const c = candles[i];
    const highPct = ((c.high - entryPrice) / entryPrice) * 100;
    const lowPct = ((c.low - entryPrice) / entryPrice) * 100;
    if (side === "LONG") {
      mae = Math.min(mae, lowPct);
      mfe = Math.max(mfe, highPct);
      if (lowPct <= -stopPct) return { outcome: "LOSS", pnlPct: -stopPct, holdBars: i - entryIdx, maePct: mae, mfePct: mfe };
      if (highPct >= targetPct) return { outcome: "WIN", pnlPct: targetPct, holdBars: i - entryIdx, maePct: mae, mfePct: mfe };
    } else {
      mae = Math.min(mae, -highPct);
      mfe = Math.max(mfe, -lowPct);
      if (highPct >= stopPct) return { outcome: "LOSS", pnlPct: -stopPct, holdBars: i - entryIdx, maePct: mae, mfePct: mfe };
      if (lowPct <= -targetPct) return { outcome: "WIN", pnlPct: targetPct, holdBars: i - entryIdx, maePct: mae, mfePct: mfe };
    }
  }
  const finalPct = side === "LONG" ? ((candles[maxIdx].close - entryPrice) / entryPrice) * 100
                                   : ((entryPrice - candles[maxIdx].close) / entryPrice) * 100;
  return { outcome: "TIMEOUT", pnlPct: finalPct, holdBars: maxIdx - entryIdx, maePct: mae, mfePct: mfe };
}

// ── Stats helper ────────────────────────────────────────────────────────────
function mean(arr: number[]): number { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function fmt(n: number | null, d = 1): string { return n === null ? "  —  " : n.toFixed(d).padStart(5, " "); }
function pad(s: string, n: number): string { return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length); }

// ── Main ────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`Fetching klines...`);
  const [entryCandles, htfNearCandles, htfFarCandles] = await Promise.all([
    fetchKlines(tfKey, argCandles),
    fetchKlines(HTF_NEAR, Math.min(argCandles, 5000)),
    fetchKlines(HTF_FAR, Math.min(argCandles, 2000)),
  ]);
  console.log(`  ${tfKey}: ${entryCandles.length} · ${HTF_NEAR}: ${htfNearCandles.length} · ${HTF_FAR}: ${htfFarCandles.length}`);
  console.log(`  Period: ${new Date(entryCandles[0].time).toISOString().slice(0, 10)} → ${new Date(entryCandles[entryCandles.length - 1].time).toISOString().slice(0, 10)}\n`);

  console.log(`Computing indicator series on all 3 TFs (this takes a bit)...`);
  const entryInd = buildIndicatorSeries(entryCandles);
  const nearIndRaw = buildIndicatorSeries(htfNearCandles);
  const farIndRaw = buildIndicatorSeries(htfFarCandles);
  const nearInd = alignHTFSeries(entryCandles, htfNearCandles, nearIndRaw);
  const farInd = alignHTFSeries(entryCandles, htfFarCandles, farIndRaw);
  const nearTrends = buildHTFTrendArr(entryCandles, htfNearCandles);
  const farTrends = buildHTFTrendArr(entryCandles, htfFarCandles);
  console.log(`  done.\n`);

  // ── Build HTF series + alignment keyed by TF name (for htfFilters support) ──
  const toSeries = (snaps: IndSnap[]) => ({
    rsi: snaps.map((s) => s.rsi),
    stochK: snaps.map((s) => s.stochK),
    stochD: snaps.map((s) => s.stochD),
  });
  const buildAlign = (entryCs: Candle[], htfCs: Candle[]): number[] => {
    const out: number[] = new Array(entryCs.length).fill(-1); let j = 0;
    for (let i = 0; i < entryCs.length; i++) {
      while (j + 1 < htfCs.length && htfCs[j + 1].time <= entryCs[i].time) j++;
      if (htfCs[j] && htfCs[j].time <= entryCs[i].time) out[i] = j;
    }
    return out;
  };
  const htfSeriesByTF: Record<string, { rsi: (number|null)[]; stochK: (number|null)[]; stochD: (number|null)[] }> = {
    [HTF_NEAR]: toSeries(nearIndRaw),
    [HTF_FAR]: toSeries(farIndRaw),
  };
  const htfAlignByTF: Record<string, number[]> = {
    [HTF_NEAR]: buildAlign(entryCandles, htfNearCandles),
    [HTF_FAR]: buildAlign(entryCandles, htfFarCandles),
  };
  const trendsByTF: Record<string, Trend[]> = {
    [HTF_NEAR]: nearTrends,
    [HTF_FAR]: farTrends,
  };

  // ── Find all entries ──
  const entries: { idx: number; side: "LONG" | "SHORT" }[] = [];
  const sidesToCheck: ("LONG" | "SHORT")[] = forceSide ? [forceSide] : ["LONG", "SHORT"];
  let lastIdx = -cfg.maxHoldBars;
  for (let i = MIN_LOOKBACK; i < entryCandles.length - cfg.maxHoldBars - 1; i++) {
    if (i - lastIdx < cfg.maxHoldBars) continue;
    const c = computeConditionsAt(entryCandles, i, cfg);
    for (const side of sidesToCheck) {
      const sc = side === "LONG" ? c.longConds : c.shortConds;
      if (ruleFires(sc, cfg, nearTrends[i], farTrends[i], nearInd[i].rsi, farInd[i].rsi, side, i, htfSeriesByTF, htfAlignByTF, trendsByTF)) {
        entries.push({ idx: i, side }); lastIdx = i; break;
      }
    }
  }

  // ── Simulate each entry with rule's TP/SL ──
  const trades = entries.map((e) => ({
    ...e,
    ...simulate(entryCandles, e.idx, e.side, cfg.targetPct, cfg.stopPct, cfg.maxHoldBars),
    entryCandle: entryCandles[e.idx],
    ind15m: entryInd[e.idx],
    ind1h: nearInd[e.idx],
    ind4h: farInd[e.idx],
  }));

  // ── DETAILED TRADE TABLE ──
  console.log(`────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────`);
  console.log(`  TRADE TABLE  (${trades.length} trades, TP ${cfg.targetPct}% / SL ${cfg.stopPct}%)`);
  console.log(`────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────`);
  console.log(` #  | Entry time        | Out   | Hold | PnL    | MFE%  | MAE%  || 15m RSI | 15m Kd    || 1H RSI | 1H Kd     | 4H RSI | 4H Kd`);
  console.log(`────┼───────────────────┼───────┼──────┼────────┼───────┼───────╫─────────┼───────────╫────────┼───────────┼────────┼───────────`);
  trades.forEach((t, i) => {
    const dt = new Date(t.entryCandle.time).toISOString().replace("T", " ").slice(0, 16);
    const outcome = t.outcome === "WIN" ? "✅ WIN " : t.outcome === "LOSS" ? "❌ LOSS" : "⏱ TOUT";
    const pnl = `${t.pnlPct >= 0 ? "+" : ""}${t.pnlPct.toFixed(2)}%`.padStart(7, " ");
    const mfe = `+${t.mfePct.toFixed(1)}`.padStart(5, " ");
    const mae = `${t.maePct.toFixed(1)}`.padStart(5, " ");
    const i15 = t.ind15m; const i1h = t.ind1h; const i4h = t.ind4h;
    console.log(
      ` ${String(i + 1).padStart(2, " ")} | ${dt} | ${outcome} | ${String(t.holdBars).padStart(4, " ")} | ${pnl} | ${mfe} | ${mae} ` +
      `|| ${fmt(i15.rsi)}   | ${fmt(i15.stochK)}/${fmt(i15.stochD)} ` +
      `|| ${fmt(i1h.rsi)}  | ${fmt(i1h.stochK)}/${fmt(i1h.stochD)} ` +
      `| ${fmt(i4h.rsi)}  | ${fmt(i4h.stochK)}/${fmt(i4h.stochD)}`
    );
  });
  console.log(`────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n`);

  const wins = trades.filter((t) => t.outcome === "WIN");
  const losses = trades.filter((t) => t.outcome === "LOSS");
  const timeouts = trades.filter((t) => t.outcome === "TIMEOUT");
  const fails = [...losses, ...timeouts.filter((t) => t.pnlPct < 0)];

  // ── INDICATOR DISTRIBUTION: wins vs losses ──
  console.log(`════════════════════════════════════════════════════════════════`);
  console.log(`  INDICATOR DISTRIBUTION — WINS vs FAILS (LOSS + neg-TIMEOUT)`);
  console.log(`════════════════════════════════════════════════════════════════`);
  const winInd = { r15: wins.map((t) => t.ind15m.rsi!), sk15: wins.map((t) => t.ind15m.stochK!), sd15: wins.map((t) => t.ind15m.stochD!),
                   r1h: wins.map((t) => t.ind1h.rsi!), sk1h: wins.map((t) => t.ind1h.stochK!), sd1h: wins.map((t) => t.ind1h.stochD!) };
  const failInd = { r15: fails.map((t) => t.ind15m.rsi!), sk15: fails.map((t) => t.ind15m.stochK!), sd15: fails.map((t) => t.ind15m.stochD!),
                    r1h: fails.map((t) => t.ind1h.rsi!), sk1h: fails.map((t) => t.ind1h.stochK!), sd1h: fails.map((t) => t.ind1h.stochD!) };
  const row = (label: string, w: number[], f: number[]) => {
    const wm = mean(w.filter((x) => !isNaN(x)));
    const fm = mean(f.filter((x) => !isNaN(x)));
    const diff = fm - wm;
    const arrow = Math.abs(diff) > 5 ? (diff > 0 ? "  ⚠ fails ↑" : "  ⚠ fails ↓") : "";
    console.log(`  ${pad(label, 18)} WIN avg: ${fmt(wm)}   FAIL avg: ${fmt(fm)}   Δ: ${diff >= 0 ? "+" : ""}${diff.toFixed(1)}${arrow}`);
  };
  row("15m RSI",      winInd.r15,  failInd.r15);
  row("15m StochK",   winInd.sk15, failInd.sk15);
  row("15m StochD",   winInd.sd15, failInd.sd15);
  row("1H  RSI",      winInd.r1h,  failInd.r1h);
  row("1H  StochK",   winInd.sk1h, failInd.sk1h);
  row("1H  StochD",   winInd.sd1h, failInd.sd1h);
  console.log("");

  // ── MFE/MAE analysis on LOSERS — "how close did they get to TP before SL?" ──
  console.log(`════════════════════════════════════════════════════════════════`);
  console.log(`  LOSS POST-MORTEM — were trades CLOSE to winning?`);
  console.log(`════════════════════════════════════════════════════════════════`);
  losses.forEach((t, i) => {
    const dt = new Date(t.entryCandle.time).toISOString().replace("T", " ").slice(0, 16);
    const ratio = (t.mfePct / cfg.targetPct) * 100;
    const verdict = ratio < 20 ? "💀 Never had a chance (price went straight down)"
                  : ratio < 50 ? "😬 Got some traction but reversed"
                  : ratio < 90 ? "😭 Almost made TP, then reversed HARD"
                  : "💔 Missed TP by a hair";
    console.log(`  #${String(i + 1).padStart(2, " ")} ${dt}  MFE +${t.mfePct.toFixed(2)}% (${ratio.toFixed(0)}% of TP)  →  ${verdict}`);
  });
  console.log("");

  // ── TP/SL SENSITIVITY SWEEP ──
  console.log(`════════════════════════════════════════════════════════════════`);
  console.log(`  TP/SL SENSITIVITY SWEEP  (same ${trades.length} entries, varying exits)`);
  console.log(`════════════════════════════════════════════════════════════════`);
  console.log(`   TP%  |  SL% | R:R  | Wins | Loss | TOut | WR    | PF    | NetPnL   |  comment`);
  console.log(`  ──────┼──────┼──────┼──────┼──────┼──────┼───────┼───────┼──────────┼──────────────────`);
  const sweep: Array<{ tp: number; sl: number; comment: string }> = [
    { tp: 1.0, sl: 0.5, comment: "tight scalping" },
    { tp: 1.5, sl: 0.75, comment: "scalping" },
    { tp: 2.0, sl: 1.0, comment: "tight R:R 2:1" },
    { tp: 3.0, sl: 1.5, comment: "CURRENT" },
    { tp: 4.0, sl: 2.0, comment: "wider R:R 2:1" },
    { tp: 5.0, sl: 2.5, comment: "swing R:R 2:1" },
    { tp: 2.0, sl: 0.5, comment: "asymmetric R:R 4:1" },
    { tp: 3.0, sl: 1.0, comment: "asymmetric R:R 3:1" },
    { tp: 3.0, sl: 2.0, comment: "looser stop R:R 1.5:1" },
    { tp: 1.5, sl: 1.5, comment: "1:1" },
  ];
  const FEE_PER_TRADE = 0.05 * 2 * cfg.leverage;
  for (const s of sweep) {
    const sim = entries.map((e) => simulate(entryCandles, e.idx, e.side, s.tp, s.sl, cfg.maxHoldBars));
    const w = sim.filter((t) => t.outcome === "WIN").length;
    const l = sim.filter((t) => t.outcome === "LOSS").length;
    const to = sim.filter((t) => t.outcome === "TIMEOUT").length;
    const wr = sim.length > 0 ? (w / sim.length) * 100 : 0;
    const gw = sim.filter((t) => t.pnlPct > 0).reduce((s, t) => s + t.pnlPct, 0);
    const gl = Math.abs(sim.filter((t) => t.pnlPct < 0).reduce((s, t) => s + t.pnlPct, 0));
    const pf = gl > 0 ? gw / gl : (gw > 0 ? 999 : 0);
    const gross = sim.reduce((s, t) => s + t.pnlPct * cfg.leverage, 0);
    const net = gross - sim.length * FEE_PER_TRADE;
    const marker = (s.tp === cfg.targetPct && s.sl === cfg.stopPct) ? " ← " : "   ";
    console.log(
      `  ${s.tp.toFixed(1).padStart(4, " ")}  | ${s.sl.toFixed(2).padStart(4, " ")} | ${(s.tp / s.sl).toFixed(2).padStart(4, " ")} | ` +
      `${String(w).padStart(4, " ")} | ${String(l).padStart(4, " ")} | ${String(to).padStart(4, " ")} | ` +
      `${wr.toFixed(1).padStart(5, " ")}% | ${(pf === 999 ? "∞" : pf.toFixed(2)).padStart(5, " ")} | ${(net >= 0 ? "+" : "") + net.toFixed(0).padStart(5, " ")}%  |${marker}${s.comment}`
    );
  }
  console.log("");

  // ── RECOMMENDATIONS ──
  console.log(`════════════════════════════════════════════════════════════════`);
  console.log(`  KEY FINDINGS`);
  console.log(`════════════════════════════════════════════════════════════════`);
  const r15wf = mean(winInd.r15.filter((x) => !isNaN(x))) - mean(failInd.r15.filter((x) => !isNaN(x)));
  const sk15wf = mean(winInd.sk15.filter((x) => !isNaN(x))) - mean(failInd.sk15.filter((x) => !isNaN(x)));
  const r1hwf = mean(winInd.r1h.filter((x) => !isNaN(x))) - mean(failInd.r1h.filter((x) => !isNaN(x)));
  const sk1hwf = mean(winInd.sk1h.filter((x) => !isNaN(x))) - mean(failInd.sk1h.filter((x) => !isNaN(x)));

  if (Math.abs(r15wf) > 5) console.log(`  • 15m RSI: losses entered ${r15wf > 0 ? "LOWER" : "HIGHER"} RSI → try ${r15wf > 0 ? "raising rsiOSLevel (avoid very low entries)" : "lowering rsiOSLevel (avoid already-hot entries)"}`);
  if (Math.abs(sk15wf) > 10) console.log(`  • 15m StochK: losses entered ${sk15wf > 0 ? "LOWER" : "HIGHER"} StochK → try ${sk15wf > 0 ? "raising stochOSLevel floor" : "adding stochOSLevel cap (reject when stoch already hot)"}`);
  if (Math.abs(r1hwf) > 3) console.log(`  • 1H RSI: losses happened when 1H RSI was ${r1hwf > 0 ? "LOWER" : "HIGHER"} → adjust htfRsiFilter threshold`);
  if (Math.abs(sk1hwf) > 10) console.log(`  • 1H StochK: losses happened when 1H StochK was ${sk1hwf > 0 ? "LOWER" : "HIGHER"} → consider adding 1H StochK filter`);

  const almostWon = losses.filter((t) => (t.mfePct / cfg.targetPct) > 0.5).length;
  if (almostWon > 0) console.log(`  • ${almostWon}/${losses.length} losses reached >50% of TP before reversing → tighter SL or trailing stop might help`);

  const bestSweep = sweep.map((s) => {
    const sim = entries.map((e) => simulate(entryCandles, e.idx, e.side, s.tp, s.sl, cfg.maxHoldBars));
    const gross = sim.reduce((s, t) => s + t.pnlPct * cfg.leverage, 0);
    return { ...s, net: gross - sim.length * FEE_PER_TRADE };
  }).sort((a, b) => b.net - a.net);
  console.log(`  • Best TP/SL combo on this sample: TP=${bestSweep[0].tp}% SL=${bestSweep[0].sl}% → NET ${bestSweep[0].net >= 0 ? "+" : ""}${bestSweep[0].net.toFixed(0)}%  (${bestSweep[0].comment})`);
  console.log("");
})();
