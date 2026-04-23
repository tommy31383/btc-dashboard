/**
 * backtest-my-rule.ts
 *
 * Backtest a USER-DEFINED rule (JSON file) on real Binance data. If win rate
 * meets the threshold (default 60%), auto-inject into assets/hard_rules.json
 * with source="MYRULE" so it shows up in the app.
 *
 * Rule JSON schema (see tools/my_rules/rule_01.json):
 *   {
 *     "label": "MyRule#1 — ...",
 *     "tfKey": "15m",              // TF to backtest on
 *     "forceSide": "LONG" | "SHORT",
 *     "config": {                  // BacktestConfig — all rule logic lives here
 *       leverage, targetPct, stopPct, maxHoldBars,
 *       minScore, stochOSLevel, stochOBLevel, rsiOSLevel, rsiOBLevel,
 *       requiredConditions?, weights?, minWeightedScore?,
 *       forceSide?, htfTrendFilter?
 *     }
 *   }
 *
 * Usage:
 *   npx tsx tools/backtest-my-rule.ts tools/my_rules/rule_01.json
 *   npx tsx tools/backtest-my-rule.ts tools/my_rules/rule_01.json --candles=5000
 *   npx tsx tools/backtest-my-rule.ts tools/my_rules/rule_01.json --min-wr=55
 *   npx tsx tools/backtest-my-rule.ts tools/my_rules/rule_01.json --dry       # no save
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, basename } from "path";
import { Candle, EntryConditions, BacktestConfig } from "../utils/backtester";
import { calcRSI, calcStochRSI, calcMACD, calcBollinger, detectDivergence } from "../utils/indicators";

const BINANCE_REST = "https://api.binance.com/api/v3";

// ── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const rulePath = args.find((a) => !a.startsWith("--"));
const argCandles = parseInt(args.find((a) => a.startsWith("--candles="))?.replace("--candles=", "") || "5000", 10);
const MIN_WR = parseFloat(args.find((a) => a.startsWith("--min-wr="))?.replace("--min-wr=", "") || "60");
const MIN_PF = parseFloat(args.find((a) => a.startsWith("--min-pf="))?.replace("--min-pf=", "") || "1.5");
const MIN_TRADES = parseInt(args.find((a) => a.startsWith("--min-trades="))?.replace("--min-trades=", "") || "10", 10);
const DRY_RUN = args.includes("--dry");
const argFee = parseFloat(args.find((a) => a.startsWith("--fee="))?.replace("--fee=", "") || "0.05");

if (!rulePath) {
  console.error("Usage: npx tsx tools/backtest-my-rule.ts <rule.json> [--candles=5000] [--min-wr=60] [--min-pf=1.5] [--min-trades=10] [--dry]");
  process.exit(1);
}
if (!existsSync(rulePath)) {
  console.error(`Rule file not found: ${rulePath}`);
  process.exit(1);
}

// ── Load rule ───────────────────────────────────────────────────────────────
type CompOp = ">" | "<" | ">=" | "<=";
type IndName = "rsi" | "stochK" | "stochD";

interface HtfRsiFilter { tf: string; op: CompOp; value: number; }

/** Extensible HTF filter schema — all filters in htfFilters[] must pass. */
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
  note?: string;
}
const ruleFile: MyRuleFile = JSON.parse(readFileSync(rulePath, "utf8"));
const cfg = ruleFile.config;
const tfKey = ruleFile.tfKey;
const forceSide = ruleFile.forceSide || cfg.forceSide;

// ── HTF mapping (must match scan-tpsl-htf.ts + useRuleAlerts.ts) ────────────
const HTF_MAP: Record<string, [string, string]> = {
  "5m": ["15m", "1h"],
  "15m": ["1h", "4h"],
  "1h": ["4h", "1d"],
  "4h": ["1d", "1w"],
};
const [HTF_NEAR, HTF_FAR] = HTF_MAP[tfKey] || ["1h", "4h"];

console.log(`\n=== BACKTEST MY RULE ===`);
console.log(`File:       ${rulePath}`);
console.log(`Label:      ${ruleFile.label}`);
console.log(`TF:         ${tfKey}   HTF near/far: ${HTF_NEAR}/${HTF_FAR}`);
console.log(`Force side: ${forceSide || "BOTH"}`);
console.log(`Candles:    ${argCandles}`);
console.log(`TP/SL:      +${cfg.targetPct}% / -${cfg.stopPct}%   (x${cfg.leverage} lev = +${(cfg.targetPct * cfg.leverage).toFixed(0)}% / -${(cfg.stopPct * cfg.leverage).toFixed(0)}% PnL)`);
console.log(`Thresholds: StochOS=${cfg.stochOSLevel} StochOB=${cfg.stochOBLevel} · RsiOS=${cfg.rsiOSLevel} RsiOB=${cfg.rsiOBLevel}`);
if (cfg.requiredConditions?.length) console.log(`Required:   ${cfg.requiredConditions.join(", ")}`);
if (cfg.weights) console.log(`Weights:    ${JSON.stringify(cfg.weights)}   minWeightedScore=${cfg.minWeightedScore}`);
if (!cfg.requiredConditions?.length && !cfg.weights) console.log(`minScore:   ${cfg.minScore}`);
if (cfg.htfTrendFilter) console.log(`HTF trend filter: ${JSON.stringify(cfg.htfTrendFilter)}`);
if (cfg.htfRsiFilter) console.log(`HTF RSI filter:   ${cfg.htfRsiFilter.tf} RSI ${cfg.htfRsiFilter.op} ${cfg.htfRsiFilter.value}`);
if (cfg.htfFilters?.length) {
  console.log(`HTF filters (${cfg.htfFilters.length}):`);
  for (const f of cfg.htfFilters) console.log(`    · ${formatHtfFilter(f)}`);
}
console.log("");

function formatHtfFilter(f: HtfFilter): string {
  switch (f.type) {
    case "trend": return `${f.tf || "near"} trend = ${f.direction.toUpperCase()}`;
    case "rsi": return `${f.tf} RSI ${f.op} ${f.value}`;
    case "slope": return `${f.tf} ${f.indicator} ${f.direction} (lookback ${f.lookback ?? 3})`;
    case "compare": return `${f.tf} ${f.left} ${f.op} ${typeof f.right === "number" ? f.right : f.right}`;
    case "stochRange": {
      const parts: string[] = [];
      if (f.kMin !== undefined) parts.push(`K≥${f.kMin}`);
      if (f.kMax !== undefined) parts.push(`K≤${f.kMax}`);
      if (f.dMin !== undefined) parts.push(`D≥${f.dMin}`);
      if (f.dMax !== undefined) parts.push(`D≤${f.dMax}`);
      return `${f.tf} stoch range [${parts.join(" ")}]`;
    }
    case "cross": return `${f.tf} stoch ${f.direction}`;
  }
}

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

// ── HTF trend via EMA50 ─────────────────────────────────────────────────────
type Trend = "UP" | "DOWN" | "FLAT";
function calcEMASeries(closes: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = ema;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}
function trendFromPrice(price: number, ema: number | null): Trend {
  if (ema === null) return "FLAT";
  const diffPct = ((price - ema) / ema) * 100;
  if (diffPct > 0.3) return "UP";
  if (diffPct < -0.3) return "DOWN";
  return "FLAT";
}

/** Build a per-candle trend array for an HTF. For each entry-TF candle, we
 *  look up the most-recent HTF candle that closed before it and take its trend. */
function buildHTFTrendArray(entryCandles: Candle[], htfCandles: Candle[]): Trend[] {
  const htfCloses = htfCandles.map((c) => c.close);
  const htfEma = calcEMASeries(htfCloses, 50);
  const htfTrends: Trend[] = htfCandles.map((c, i) => trendFromPrice(c.close, htfEma[i]));
  const out: Trend[] = new Array(entryCandles.length).fill("FLAT");
  let j = 0;
  for (let i = 0; i < entryCandles.length; i++) {
    while (j + 1 < htfCandles.length && htfCandles[j + 1].time <= entryCandles[i].time) j++;
    out[i] = htfTrends[j] || "FLAT";
  }
  return out;
}

/** Build a per-entry-candle RSI array for an HTF. For each entry-TF candle,
 *  find the most recent CLOSED HTF candle (htf.time <= entry.time) and use the
 *  RSI computed from closes up to and including that candle. This mirrors the
 *  realtime behaviour: while a 1H candle is still forming, the app can only
 *  rely on the most recent CLOSED 1H bar. */
function buildHTFRsiArray(entryCandles: Candle[], htfCandles: Candle[]): (number | null)[] {
  // Precompute RSI at every HTF bar index (closes[0..i])
  const htfRsis: (number | null)[] = new Array(htfCandles.length).fill(null);
  for (let i = 0; i < htfCandles.length; i++) {
    const closes = htfCandles.slice(0, i + 1).map((c) => c.close);
    htfRsis[i] = closes.length >= 15 ? calcRSI(closes) : null;
  }
  const out: (number | null)[] = new Array(entryCandles.length).fill(null);
  let j = 0;
  for (let i = 0; i < entryCandles.length; i++) {
    while (j + 1 < htfCandles.length && htfCandles[j + 1].time <= entryCandles[i].time) j++;
    // If the j-th HTF candle started AFTER this entry candle, no closed HTF yet.
    if (htfCandles[j] && htfCandles[j].time <= entryCandles[i].time) {
      out[i] = htfRsis[j];
    }
  }
  return out;
}

function evalHtfRsiFilter(
  filter: HtfRsiFilter,
  nearRsi: number | null,
  farRsi: number | null,
  htfNearKey: string,
  htfFarKey: string,
): boolean {
  let rsi: number | null = null;
  if (filter.tf === htfNearKey) rsi = nearRsi;
  else if (filter.tf === htfFarKey) rsi = farRsi;
  else return false; // unknown HTF → reject
  if (rsi === null) return false;
  switch (filter.op) {
    case ">":  return rsi >  filter.value;
    case "<":  return rsi <  filter.value;
    case ">=": return rsi >= filter.value;
    case "<=": return rsi <= filter.value;
  }
}

// ── HTF full-indicator series (RSI + StochK + StochD per HTF bar) ───────────
interface HtfIndSeries {
  rsi: (number | null)[];
  stochK: (number | null)[];
  stochD: (number | null)[];
}
/** Compute RSI / StochK / StochD at every HTF bar using closes[0..i]. */
function computeHtfIndSeries(htfCandles: Candle[]): HtfIndSeries {
  const n = htfCandles.length;
  const rsi: (number | null)[] = new Array(n).fill(null);
  const stochK: (number | null)[] = new Array(n).fill(null);
  const stochD: (number | null)[] = new Array(n).fill(null);
  for (let i = 14; i < n; i++) {
    const closes = htfCandles.slice(0, i + 1).map((c) => c.close);
    rsi[i] = calcRSI(closes);
    const s = calcStochRSI(closes);
    stochK[i] = s.k;
    stochD[i] = s.d;
  }
  return { rsi, stochK, stochD };
}
/** For each entry candle, record the index of the most-recent CLOSED HTF bar
 *  (or -1 if none yet). Used to look up the realtime-safe HTF indicator snapshot. */
function buildHtfAlignment(entryCandles: Candle[], htfCandles: Candle[]): number[] {
  const out: number[] = new Array(entryCandles.length).fill(-1);
  let j = 0;
  for (let i = 0; i < entryCandles.length; i++) {
    while (j + 1 < htfCandles.length && htfCandles[j + 1].time <= entryCandles[i].time) j++;
    if (htfCandles[j] && htfCandles[j].time <= entryCandles[i].time) out[i] = j;
  }
  return out;
}

/** Bundle of HTF data keyed by TF name (e.g. "1h", "4h"). */
interface HtfBundle {
  indicators: HtfIndSeries;
  alignment: number[]; // entryIdx → htfIdx (-1 if none)
  trends: Trend[];     // per entry candle
}

function applyCompOp(left: number, op: CompOp, right: number): boolean {
  switch (op) {
    case ">":  return left >  right;
    case "<":  return left <  right;
    case ">=": return left >= right;
    case "<=": return left <= right;
  }
}
function readInd(ind: HtfIndSeries, name: IndName, idx: number): number | null {
  return (name === "rsi" ? ind.rsi : name === "stochK" ? ind.stochK : ind.stochD)[idx];
}

/** Evaluate a single HtfFilter at a given entry candle index. */
function evalHtfFilter(
  filter: HtfFilter,
  htfBundles: Record<string, HtfBundle>,
  entryIdx: number,
  side: "LONG" | "SHORT",
  htfNearKey: string,
  htfFarKey: string,
): boolean {
  // Resolve TF key — "trend" filter without tf defaults to near
  const tf = (filter as any).tf || htfNearKey;
  const bundle = htfBundles[tf];
  if (!bundle) return false;
  const htfIdx = bundle.alignment[entryIdx];
  if (htfIdx < 0) return false;

  switch (filter.type) {
    case "trend": {
      const want: Trend = filter.direction === "up" ? "UP" : filter.direction === "down" ? "DOWN" : "FLAT";
      // Auto-follow side for trend filter when direction isn't explicitly set to match
      // Keep literal match: direction up = UP regardless of side (user choice).
      return bundle.trends[entryIdx] === want;
    }
    case "rsi": {
      const v = bundle.indicators.rsi[htfIdx];
      if (v === null) return false;
      return applyCompOp(v, filter.op, filter.value);
    }
    case "slope": {
      const lb = filter.lookback ?? 3;
      if (htfIdx - lb < 0) return false;
      const now = readInd(bundle.indicators, filter.indicator, htfIdx);
      const past = readInd(bundle.indicators, filter.indicator, htfIdx - lb);
      if (now === null || past === null) return false;
      const slope = now - past;
      return filter.direction === "rising" ? slope > 0 : slope < 0;
    }
    case "compare": {
      const leftV = readInd(bundle.indicators, filter.left, htfIdx);
      if (leftV === null) return false;
      const rightV = typeof filter.right === "number" ? filter.right : readInd(bundle.indicators, filter.right, htfIdx);
      if (rightV === null) return false;
      return applyCompOp(leftV, filter.op, rightV);
    }
    case "stochRange": {
      const k = bundle.indicators.stochK[htfIdx];
      const d = bundle.indicators.stochD[htfIdx];
      if (k === null) return false;
      if (filter.kMin !== undefined && k < filter.kMin) return false;
      if (filter.kMax !== undefined && k > filter.kMax) return false;
      if (filter.dMin !== undefined && (d === null || d < filter.dMin)) return false;
      if (filter.dMax !== undefined && (d === null || d > filter.dMax)) return false;
      return true;
    }
    case "cross": {
      const k = bundle.indicators.stochK[htfIdx];
      const d = bundle.indicators.stochD[htfIdx];
      if (k === null || d === null) return false;
      if (filter.direction === "k_above_d") return k > d;
      if (filter.direction === "k_below_d") return k < d;
      // crosses need previous bar
      if (htfIdx < 1) return false;
      const prevK = bundle.indicators.stochK[htfIdx - 1];
      const prevD = bundle.indicators.stochD[htfIdx - 1];
      if (prevK === null || prevD === null) return false;
      if (filter.direction === "bullish_cross") return prevK <= prevD && k > d;
      if (filter.direction === "bearish_cross") return prevK >= prevD && k < d;
      return false;
    }
  }
}

// ── Per-candle condition evaluation (mirrors useRuleAlerts/backtester) ──────
const MIN_LOOKBACK = 50;

interface CandleConds {
  longConds: EntryConditions;
  shortConds: EntryConditions;
  // direction-agnostic raw values for debug
  rsi: number | null;
  stochK: number | null;
}

function computeConditionsAt(candles: Candle[], idx: number, cfg: BacktestConfig): CandleConds {
  const empty = { stochExtreme: false, rsiExtreme: false, divergence: false, bollingerTouch: false, macdCross: false };
  if (idx < MIN_LOOKBACK) return { longConds: empty, shortConds: empty, rsi: null, stochK: null };
  const closes = candles.slice(0, idx + 1).map((c) => c.close);
  const price = candles[idx].close;
  const rsi = calcRSI(closes);
  if (rsi === null) return { longConds: empty, shortConds: empty, rsi: null, stochK: null };
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
  return { longConds, shortConds, rsi, stochK: stoch.k };
}

// ── Entry test for one side ─────────────────────────────────────────────────
function ruleFires(
  conds: EntryConditions,
  cfg: BacktestConfig,
  htfNear: Trend,
  htfFar: Trend,
  htfNearRsi: number | null,
  htfFarRsi: number | null,
  htfNearKey: string,
  htfFarKey: string,
  htfBundles: Record<string, HtfBundle>,
  entryIdx: number,
  side: "LONG" | "SHORT",
): boolean {
  const want: Trend = side === "LONG" ? "UP" : "DOWN";
  // HTF trend filter (EMA-based)
  if ((cfg as any).htfTrendFilter) {
    const f = (cfg as any).htfTrendFilter;
    const mode = f.mode || f;
    if (mode === "near_match" && htfNear !== want) return false;
    if (mode === "far_match" && htfFar !== want) return false;
    if (mode === "both_match" && (htfNear !== want || htfFar !== want)) return false;
  }
  // HTF RSI filter (legacy schema, realtime-safe)
  if ((cfg as any).htfRsiFilter) {
    const f = (cfg as any).htfRsiFilter as HtfRsiFilter;
    if (!evalHtfRsiFilter(f, htfNearRsi, htfFarRsi, htfNearKey, htfFarKey)) return false;
  }
  // New extensible htfFilters[] — all must pass (AND semantics)
  const htfFilters = (cfg as any).htfFilters as HtfFilter[] | undefined;
  if (htfFilters?.length) {
    for (const f of htfFilters) {
      if (!evalHtfFilter(f, htfBundles, entryIdx, side, htfNearKey, htfFarKey)) return false;
    }
  }
  // Required conditions (hard AND)
  if (cfg.requiredConditions?.length) {
    for (const k of cfg.requiredConditions) {
      if (!conds[k]) return false;
    }
  }
  // Weighted score
  if (cfg.weights) {
    let s = 0;
    for (const k of Object.keys(cfg.weights) as (keyof EntryConditions)[]) {
      if (conds[k]) s += cfg.weights[k] || 0;
    }
    if (s < (cfg.minWeightedScore || 1)) return false;
  } else {
    const cnt = Object.values(conds).filter(Boolean).length;
    if (cnt < (cfg.minScore || 1)) return false;
  }
  return true;
}

// ── Trade simulation ────────────────────────────────────────────────────────
interface TradeOutcome {
  entryIdx: number;
  entryTime: number;
  side: "LONG" | "SHORT";
  entryPrice: number;
  outcome: "WIN" | "LOSS" | "TIMEOUT";
  exitPrice: number;
  pnlPct: number;
  holdBars: number;
}

function simulateTrade(
  candles: Candle[],
  entryIdx: number,
  side: "LONG" | "SHORT",
  cfg: BacktestConfig,
): TradeOutcome {
  const entryPrice = candles[entryIdx].close;
  const maxIdx = Math.min(entryIdx + cfg.maxHoldBars, candles.length - 1);
  for (let i = entryIdx + 1; i <= maxIdx; i++) {
    const c = candles[i];
    const highPct = ((c.high - entryPrice) / entryPrice) * 100;
    const lowPct = ((c.low - entryPrice) / entryPrice) * 100;
    if (side === "LONG") {
      if (lowPct <= -cfg.stopPct) {
        return {
          entryIdx, entryTime: candles[entryIdx].time, side, entryPrice,
          outcome: "LOSS",
          exitPrice: entryPrice * (1 - cfg.stopPct / 100),
          pnlPct: -cfg.stopPct,
          holdBars: i - entryIdx,
        };
      }
      if (highPct >= cfg.targetPct) {
        return {
          entryIdx, entryTime: candles[entryIdx].time, side, entryPrice,
          outcome: "WIN",
          exitPrice: entryPrice * (1 + cfg.targetPct / 100),
          pnlPct: cfg.targetPct,
          holdBars: i - entryIdx,
        };
      }
    } else {
      if (highPct >= cfg.stopPct) {
        return {
          entryIdx, entryTime: candles[entryIdx].time, side, entryPrice,
          outcome: "LOSS",
          exitPrice: entryPrice * (1 + cfg.stopPct / 100),
          pnlPct: -cfg.stopPct,
          holdBars: i - entryIdx,
        };
      }
      if (lowPct <= -cfg.targetPct) {
        return {
          entryIdx, entryTime: candles[entryIdx].time, side, entryPrice,
          outcome: "WIN",
          exitPrice: entryPrice * (1 - cfg.targetPct / 100),
          pnlPct: cfg.targetPct,
          holdBars: i - entryIdx,
        };
      }
    }
  }
  const finalPct = side === "LONG"
    ? ((candles[maxIdx].close - entryPrice) / entryPrice) * 100
    : ((entryPrice - candles[maxIdx].close) / entryPrice) * 100;
  return {
    entryIdx, entryTime: candles[entryIdx].time, side, entryPrice,
    outcome: "TIMEOUT",
    exitPrice: candles[maxIdx].close,
    pnlPct: finalPct,
    holdBars: maxIdx - entryIdx,
  };
}

// ── Main ────────────────────────────────────────────────────────────────────
(async () => {
  // Determine every TF referenced by the rule (entry + HTF_NEAR + HTF_FAR + any
  // TF appearing in htfFilters[], even if it's a LOWER TF than entry — e.g. 5m
  // confluence on a 15m entry rule).
  const wantBundles = new Set<string>();
  wantBundles.add(HTF_NEAR);
  wantBundles.add(HTF_FAR);
  if (cfg.htfFilters?.length) {
    for (const f of cfg.htfFilters) {
      const tf = (f as any).tf || HTF_NEAR;
      wantBundles.add(tf);
    }
  }
  // Remove entry TF from the bundle set — entry candles are fetched separately.
  wantBundles.delete(tfKey);

  // Budget per-TF fetch count so we don't hammer the API when requesting many
  // lower/higher TFs at once. Keep entry TF at argCandles, everything else
  // scales down.
  const bundleTFs = Array.from(wantBundles);
  console.log(`Fetching klines...`);
  const entryCandles = await fetchKlines(tfKey, argCandles);
  const bundleCandlesArr = await Promise.all(bundleTFs.map((tf) =>
    fetchKlines(tf, Math.min(argCandles, tf === HTF_FAR ? 2000 : 5000)),
  ));
  const candlesByTF: Record<string, Candle[]> = { [tfKey]: entryCandles };
  bundleTFs.forEach((tf, i) => { candlesByTF[tf] = bundleCandlesArr[i]; });
  console.log(`  ${tfKey}: ${entryCandles.length} candles  (entry)`);
  for (const tf of bundleTFs) {
    console.log(`  ${tf}: ${candlesByTF[tf].length} candles`);
  }
  const htfNearCandles = candlesByTF[HTF_NEAR];
  const htfFarCandles = candlesByTF[HTF_FAR];
  const period = {
    from: new Date(entryCandles[0].time).toISOString().slice(0, 10),
    to: new Date(entryCandles[entryCandles.length - 1].time).toISOString().slice(0, 10),
  };
  console.log(`  Period: ${period.from} → ${period.to}\n`);

  // Build HTF trend arrays aligned to entry candles
  const nearTrends = buildHTFTrendArray(entryCandles, htfNearCandles);
  const farTrends = buildHTFTrendArray(entryCandles, htfFarCandles);

  console.log(`Computing HTF indicator series (RSI/StochK/StochD)...`);
  const htfBundles: Record<string, HtfBundle> = {};
  // Only build bundles for TFs actually referenced by htfFilters[] (save CPU).
  const referencedByFilters = new Set<string>();
  if (cfg.htfFilters?.length) {
    for (const f of cfg.htfFilters) {
      referencedByFilters.add((f as any).tf || HTF_NEAR);
    }
  }
  for (const tf of referencedByFilters) {
    const tfCandles = candlesByTF[tf];
    if (!tfCandles) continue;
    const tfTrends = tf === HTF_FAR ? farTrends : buildHTFTrendArray(entryCandles, tfCandles);
    htfBundles[tf] = {
      indicators: computeHtfIndSeries(tfCandles),
      alignment: buildHtfAlignment(entryCandles, tfCandles),
      trends: tfTrends,
    };
  }
  // Also make trend data available even if no indicator bundle was requested,
  // so legacy htfTrendFilter keeps working without bundle lookup.

  // Build HTF RSI arrays (only if rule uses legacy htfRsiFilter)
  const nearRsis = cfg.htfRsiFilter ? buildHTFRsiArray(entryCandles, htfNearCandles) : [];
  const farRsis = cfg.htfRsiFilter ? buildHTFRsiArray(entryCandles, htfFarCandles) : [];

  // Scan each candle for entries
  console.log(`Scanning ${entryCandles.length} candles...`);
  const trades: TradeOutcome[] = [];
  const sidesToCheck: ("LONG" | "SHORT")[] = forceSide ? [forceSide] : ["LONG", "SHORT"];
  let lastEntryIdx = -cfg.maxHoldBars; // avoid re-entering during open trade

  for (let i = MIN_LOOKBACK; i < entryCandles.length - cfg.maxHoldBars - 1; i++) {
    if (i - lastEntryIdx < cfg.maxHoldBars) continue; // still in prev trade

    const c = computeConditionsAt(entryCandles, i, cfg);
    for (const side of sidesToCheck) {
      const sc = side === "LONG" ? c.longConds : c.shortConds;
      const nearRsi = cfg.htfRsiFilter ? nearRsis[i] : null;
      const farRsi = cfg.htfRsiFilter ? farRsis[i] : null;
      if (ruleFires(sc, cfg, nearTrends[i], farTrends[i], nearRsi, farRsi, HTF_NEAR, HTF_FAR, htfBundles, i, side)) {
        const trade = simulateTrade(entryCandles, i, side, cfg);
        trades.push(trade);
        lastEntryIdx = i;
        break;
      }
    }
  }

  // Compute stats
  const wins = trades.filter((t) => t.outcome === "WIN").length;
  const losses = trades.filter((t) => t.outcome === "LOSS").length;
  const timeouts = trades.filter((t) => t.outcome === "TIMEOUT").length;
  const winRate = trades.length > 0 ? (wins / trades.length) * 100 : 0;
  const avgWin = wins > 0 ? trades.filter((t) => t.outcome === "WIN").reduce((s, t) => s + t.pnlPct, 0) / wins : 0;
  const avgLoss = losses > 0 ? Math.abs(trades.filter((t) => t.outcome === "LOSS").reduce((s, t) => s + t.pnlPct, 0) / losses) : 0;
  const grossWin = trades.filter((t) => t.pnlPct > 0).reduce((s, t) => s + t.pnlPct, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.pnlPct < 0).reduce((s, t) => s + t.pnlPct, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 999 : 0);
  const avgHold = trades.length > 0 ? trades.reduce((s, t) => s + t.holdBars, 0) / trades.length : 0;

  // Net PnL after fee (approximate: fee × 2 × leverage per trade)
  const feePnLPerTrade = argFee * 2 * cfg.leverage;
  const grossPnLWithLev = trades.reduce((s, t) => s + t.pnlPct * cfg.leverage, 0);
  const netPnL = grossPnLWithLev - trades.length * feePnLPerTrade;

  console.log(`\n────────────────────────────────────────`);
  console.log(`RESULTS`);
  console.log(`────────────────────────────────────────`);
  console.log(`Trades:       ${trades.length}`);
  console.log(`Wins:         ${wins}   (${winRate.toFixed(1)}%)`);
  console.log(`Losses:       ${losses}`);
  console.log(`Timeouts:     ${timeouts}`);
  console.log(`Avg win:      +${avgWin.toFixed(2)}%`);
  console.log(`Avg loss:     -${avgLoss.toFixed(2)}%`);
  console.log(`Profit Fac:   ${pf === 999 ? "∞" : pf.toFixed(2)}`);
  console.log(`Avg hold:     ${avgHold.toFixed(1)} bars`);
  console.log(`Gross PnL:    ${grossPnLWithLev.toFixed(0)}% (with x${cfg.leverage} lev)`);
  console.log(`Fee:          ${(trades.length * feePnLPerTrade).toFixed(0)}%  (${argFee}% × 2 × ${cfg.leverage} × ${trades.length})`);
  console.log(`NET PnL:      ${netPnL.toFixed(0)}%`);
  console.log(`────────────────────────────────────────\n`);

  // ── Accept / reject decision ──────────────────────────────────────────────
  // Smart criteria: ALL of
  //   (a) trades >= MIN_TRADES (enough sample)
  //   (b) NET PnL > 0 (actually profitable after fees)
  //   (c) EITHER WR >= MIN_WR  OR  PF >= MIN_PF
  //       — high WR rules AND high-R:R rules both qualify.
  console.log(`Thresholds: trades ≥ ${MIN_TRADES}  AND  NET PnL > 0  AND  (WR ≥ ${MIN_WR}%  OR  PF ≥ ${MIN_PF})`);
  if (trades.length < MIN_TRADES) {
    console.log(`❌ REJECT: Too few trades (${trades.length} < ${MIN_TRADES}) — not enough signal.\n`);
    process.exit(0);
  }
  if (netPnL <= 0) {
    console.log(`❌ REJECT: NET PnL ${netPnL.toFixed(0)}% ≤ 0 — losing money after fees. Rule NOT saved.\n`);
    process.exit(0);
  }
  const wrPass = winRate >= MIN_WR;
  const pfPass = pf >= MIN_PF;
  if (!wrPass && !pfPass) {
    console.log(`❌ REJECT: Neither criteria met — WR ${winRate.toFixed(1)}% < ${MIN_WR}% AND PF ${pf.toFixed(2)} < ${MIN_PF}. Rule NOT saved.\n`);
    process.exit(0);
  }
  const viaWR = wrPass ? ` [WR ${winRate.toFixed(1)}% ≥ ${MIN_WR}%]` : "";
  const viaPF = pfPass ? ` [PF ${pf.toFixed(2)} ≥ ${MIN_PF}]` : "";
  console.log(`✅ ACCEPT:${viaWR}${viaPF}  NET PnL +${netPnL.toFixed(0)}%  (${trades.length} trades)`);

  if (DRY_RUN) {
    console.log(`  (--dry specified — not saving to hard_rules.json)\n`);
    process.exit(0);
  }

  // ── Inject into hard_rules.json ───────────────────────────────────────────
  const hardPath = join(__dirname, "..", "assets", "hard_rules.json");
  const hard = JSON.parse(readFileSync(hardPath, "utf8"));
  if (!hard.tfs[tfKey]) {
    hard.tfs[tfKey] = {
      interval: tfKey,
      label: tfKey.toUpperCase(),
      candles_used: entryCandles.length,
      price_range: {
        min: Math.min(...entryCandles.map((c) => c.close)),
        max: Math.max(...entryCandles.map((c) => c.close)),
        first: entryCandles[0].close,
        last: entryCandles[entryCandles.length - 1].close,
      },
      rules: [],
    };
  }
  const rules = hard.tfs[tfKey].rules as any[];

  // Strip any previous MYRULE with same label so we replace
  const existingIdx = rules.findIndex((r) => r.source === "MYRULE" && r.label === ruleFile.label);
  if (existingIdx >= 0) rules.splice(existingIdx, 1);

  // Determine next rank (append at end, then re-rank after)
  const nextRank = rules.length > 0 ? Math.max(...rules.map((r) => r.rank || 0)) + 1 : 1;
  const newRule = {
    rank: nextRank,
    source: "MYRULE",
    label: ruleFile.label,
    config: { ...cfg, forceSide: forceSide || cfg.forceSide },
    stats: {
      winRate: parseFloat(winRate.toFixed(1)),
      profitFactor: pf === 999 ? 999 : parseFloat(pf.toFixed(2)),
      trades: trades.length,
      avgWinPct: parseFloat(avgWin.toFixed(2)),
      avgLossPct: parseFloat(avgLoss.toFixed(2)),
      avgHoldBars: parseFloat(avgHold.toFixed(1)),
      wins, losses, timeouts,
      side: forceSide,
      grossPnL: parseFloat(grossPnLWithLev.toFixed(0)),
      feeCost: parseFloat((trades.length * feePnLPerTrade).toFixed(0)),
      netPnL: parseFloat(netPnL.toFixed(0)),
      feeRatePct: argFee,
    },
  };
  rules.push(newRule);
  hard.generated_at = new Date().toISOString();
  writeFileSync(hardPath, JSON.stringify(hard, null, 2));
  console.log(`\n💾 SAVED to ${hardPath} as rank #${nextRank} (source=MYRULE)`);
  console.log(`   Rebuild APK to see it in the app.\n`);
})();
