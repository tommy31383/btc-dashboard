/**
 * useRuleAlerts — SMART live rule evaluator.
 *
 * For each TRACKED rule, checks live candle data against rule conditions.
 * When all conditions match → emit alert + push notification.
 *
 * PERFORMANCE OPTIMIZATIONS (v4.3):
 *   1. HTF early-exit: check HTF trend BEFORE computing expensive indicators.
 *      If trend doesn't match, skip rule immediately (saves ~70% CPU).
 *   2. Side pre-filter: if no SHORT signals at all, skip all SHORT rules.
 *   3. Condition bitmask: O(1) matching instead of iterating arrays.
 *   4. Per-TF indicator cache: compute RSI/MACD/etc ONCE per TF, reuse
 *      across all rules that share the same TF.
 *   5. Candle-time throttle: skip re-eval if no new candle arrived.
 *   6. HTF trend cache: compute EMA50 trend ONCE per HTF key, reuse.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Candle, EntryConditions } from "../utils/backtester";
import { calcRSI, calcStochRSI, calcMACD, calcBollinger, detectDivergence, detectCandleReversal, calcATRPct } from "../utils/indicators";
import { getHardRulesForTF, HardRule } from "../utils/hardRules";
import { TrackedRuleId, parseRuleId } from "./useTrackedRules";
import { Kline, RawKlinesMap } from "./useBinanceKlines";
import { notifyRuleFire } from "../utils/notifications";

const MIN_LOOKBACK = 50;

type Trend = "UP" | "DOWN" | "FLAT";

/** HTF mapping: which higher TFs to use for each entry TF.
 *  [near, far] — must match scan-tpsl-htf.ts HTF_MAP. */
const HTF_MAP: Record<string, [string, string]> = {
  "5m":  ["15m", "1h"],
  "15m": ["1h",  "4h"],
  "1h":  ["4h",  "1d"],
  "4h":  ["1d",  "1w"],
};

/** Bitmask for fast condition matching */
const COND_BIT: Record<string, number> = {
  stochExtreme:   0b00001,
  rsiExtreme:     0b00010,
  divergence:     0b00100,
  bollingerTouch: 0b01000,
  macdCross:      0b10000,
};

export interface RuleAlert {
  id: TrackedRuleId;
  rule: HardRule;
  tfKey: string;
  side: "LONG" | "SHORT" | "BOTH";
  firedAt: number;
  currentPrice: number;
  entryPrice: number;
  tpPrice: number;
  slPrice: number;
  htfStatus?: { trend1h: Trend; trend4h: Trend };
}

/** Compute EMA at the LAST candle only (faster than full series) */
function calcLastEMA(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

function trendFromEMA(price: number, ema: number | null): Trend {
  if (ema === null) return "FLAT";
  const diffPct = ((price - ema) / ema) * 100;
  if (diffPct > 0.3) return "UP";
  if (diffPct < -0.3) return "DOWN";
  return "FLAT";
}

/**
 * Cached RAW indicator values for one TF — computed ONCE per TF, reused by
 * all rules. The KEY FIX: we no longer pre-evaluate boolean conditions with
 * hardcoded thresholds here. Instead we store the raw numbers so each rule
 * can apply its OWN thresholds (cfg.stochOSLevel, cfg.rsiOSLevel, etc).
 */
interface TFIndicatorCache {
  rsi: number | null;
  stochK: number | null;
  stochD: number | null;
  macdHistogram: number | null;
  prevMacdHistogram: number | null;
  bbUpper: number | null;
  bbLower: number | null;
  price: number;
  divergence: "BULLISH_DIV" | "BEARISH_DIV" | null;
  lastCandle: Kline | null;
  /** 2 cây liên tiếp ngược màu → REVERSAL_4H_UP/DOWN rule check */
  candleReversal: "UP_REVERSAL" | "DOWN_REVERSAL" | null;
  /** EMA50 at last closed candle — for candleReversalFilter EMA position check */
  ema50: number | null;
  /** ATR% of entry TF (ATR / close × 100) — for atrFilter */
  atrPct: number | null;
  /** Distance of price to EMA50 in % — for emaDistFilter (positive = above EMA) */
  emaDistPct: number | null;
}

/** Compute raw indicator values at the LATEST candle (expensive, done once) */
function computeTFIndicators(klines: Kline[]): TFIndicatorCache | null {
  if (klines.length < MIN_LOOKBACK) return null;
  const closes = klines.map((k) => k.close);
  const idx = closes.length - 1;
  const price = closes[idx];

  const rsi = calcRSI(closes);
  if (rsi === null) return null;
  const stoch = calcStochRSI(closes);
  const macd = calcMACD(closes);
  const bb = calcBollinger(closes);
  const div = closes.length >= 44 ? detectDivergence(closes) : null;
  const prevCloses = closes.slice(0, idx);
  const prevMacd = prevCloses.length >= 35 ? calcMACD(prevCloses) : null;

  const reversal = detectCandleReversal(klines);
  // EMA50 for reversal rules that filter by price vs EMA position
  let ema50: number | null = null;
  if (closes.length >= 50) {
    const k = 2 / 51;
    let e = closes.slice(0, 50).reduce((a, b) => a + b, 0) / 50;
    for (let i = 50; i < closes.length; i++) e = closes[i] * k + e * (1 - k);
    ema50 = e;
  }
  const emaDistPct = ema50 !== null && ema50 > 0 ? ((price - ema50) / ema50) * 100 : null;
  const atrPct = calcATRPct(klines);

  return {
    rsi,
    stochK: stoch.k,
    stochD: stoch.d,
    macdHistogram: macd.histogram,
    prevMacdHistogram: prevMacd?.histogram ?? null,
    bbUpper: bb.upper,
    bbLower: bb.lower,
    price,
    divergence: div as "BULLISH_DIV" | "BEARISH_DIV" | null,
    lastCandle: klines[klines.length - 1],
    candleReversal: reversal,
    ema50,
    atrPct,
    emaDistPct,
  };
}

/**
 * Evaluate entry conditions for a specific SIDE using per-rule thresholds.
 * This is cheap (just comparisons) — called once per rule, not per TF.
 */
function evalConditionsForRule(
  ind: TFIndicatorCache,
  side: "LONG" | "SHORT",
  cfg: any,
): { conds: EntryConditions; bits: number } {
  let conds: EntryConditions;
  if (side === "LONG") {
    conds = {
      stochExtreme: ind.stochK !== null && ind.stochK < (cfg.stochOSLevel ?? 5),
      rsiExtreme: ind.rsi !== null && ind.rsi < (cfg.rsiOSLevel ?? 25),
      divergence: ind.divergence === "BULLISH_DIV",
      bollingerTouch: ind.bbLower !== null && ind.price <= ind.bbLower,
      macdCross: ind.macdHistogram !== null && ind.prevMacdHistogram !== null && (
        (ind.prevMacdHistogram < 0 && ind.macdHistogram >= 0) || (ind.macdHistogram > ind.prevMacdHistogram)
      ),
    };
  } else {
    conds = {
      stochExtreme: ind.stochK !== null && ind.stochK > (cfg.stochOBLevel ?? 95),
      rsiExtreme: ind.rsi !== null && ind.rsi > (cfg.rsiOBLevel ?? 75),
      divergence: ind.divergence === "BEARISH_DIV",
      bollingerTouch: ind.bbUpper !== null && ind.price >= ind.bbUpper,
      macdCross: ind.macdHistogram !== null && ind.prevMacdHistogram !== null && (
        (ind.prevMacdHistogram > 0 && ind.macdHistogram <= 0) || (ind.macdHistogram < ind.prevMacdHistogram)
      ),
    };
  }
  // Build bitmask
  let bits = 0;
  for (const k of Object.keys(COND_BIT) as (keyof EntryConditions)[]) {
    if (conds[k]) bits |= COND_BIT[k];
  }
  return { conds, bits };
}

/** Build required-condition bitmask from rule config */
function buildReqBitmask(requiredConditions?: string[]): number {
  if (!requiredConditions || requiredConditions.length === 0) return 0;
  let mask = 0;
  for (const k of requiredConditions) mask |= (COND_BIT[k] || 0);
  return mask;
}

// ──────────────────────────────────────────────────────────────────────────
// v4.3.15 — Feature filters (atrFilter, macdHistFilter, emaDistFilter)
// Operate on entry-TF indicators already in tfCache.
// Supported ops: ">", "<", ">=", "<=", "between" (min/max inclusive).
// ──────────────────────────────────────────────────────────────────────────
export type FeatFilterOp = ">" | "<" | ">=" | "<=" | "between";
export interface FeatFilter {
  op: FeatFilterOp;
  value?: number;   // for non-between
  min?: number;     // for "between"
  max?: number;     // for "between"
}

function evalFeatFilter(value: number | null, f: FeatFilter | undefined): boolean {
  if (!f) return true;
  if (value === null) return false;
  switch (f.op) {
    case ">":  return value >  (f.value ?? 0);
    case "<":  return value <  (f.value ?? 0);
    case ">=": return value >= (f.value ?? 0);
    case "<=": return value <= (f.value ?? 0);
    case "between": {
      const lo = f.min ?? -Infinity;
      const hi = f.max ?? Infinity;
      return value >= lo && value <= hi;
    }
  }
  return false;
}

function formatFeatFilter(name: string, f: FeatFilter): string {
  if (f.op === "between") return `${name} ∈ [${f.min ?? "-∞"}, ${f.max ?? "+∞"}]`;
  return `${name} ${f.op} ${f.value ?? 0}`;
}

// ──────────────────────────────────────────────────────────────────────────
// v4.3.15 iter4 — Multi-TF weighted score (tuned v2 scheme từ
// tools/multi-tf-score-scan-v2.ts). Mirror để runtime eval khớp backtest.
// ──────────────────────────────────────────────────────────────────────────
export interface MultiTfInputs {
  atr1h: number | null;
  emaDist1h: number | null;
  rsi1h: number | null;
  macdHist: number | null;
  prevMacdHist: number | null;
  t4Trend: Trend | null;
  r4: number | null;
  t1dTrend: Trend | null;
  r1d: number | null;
  t1wTrend: Trend | null;
}

export function computeMultiTfScore(side: "LONG" | "SHORT", x: MultiTfInputs): number {
  let L = 0, S = 0;
  // 4h trend + RSI
  if (x.t4Trend === "FLAT") L += 30;
  if (x.t4Trend === "DOWN") L -= 20;
  if (x.t4Trend === "UP")   S += 25;
  if (x.t4Trend === "DOWN") S -= 20;
  // 1d trend + RSI
  if (x.t1dTrend === "FLAT" || x.t1dTrend === "UP") L += 10;
  if (x.r1d !== null) {
    if (x.r1d > 75) L -= 25;
    if (x.r1d > 65) S += 15;
    if (x.r1d < 40) S -= 15;
  }
  // 1w trend
  if (x.t1wTrend === "UP" || x.t1wTrend === "FLAT") L += 8;
  if (x.t1wTrend === "UP") S += 10;
  // 1h local
  if (x.atr1h !== null && x.atr1h < 0.3) L += 25;
  if (x.emaDist1h !== null) {
    if (x.emaDist1h >= -0.5 && x.emaDist1h <= 0.5) L += 20;
    if (x.emaDist1h > 2) S += 20;
  }
  if (x.rsi1h !== null) {
    if (x.rsi1h < 60) L += 10;
    if (x.rsi1h > 70) { L -= 30; S += 20; }
    if (x.rsi1h < 50) S -= 15;
  }
  return side === "LONG" ? L : S;
}

/** Count bits set (popcount for score check) */
function popcount(n: number): number {
  let c = 0;
  while (n) { c += n & 1; n >>= 1; }
  return c;
}

/** Evaluate an HTF RSI filter against the cached HTF RSI value. */
function evalHtfRsiFilterLive(
  filter: { tf: string; op: ">" | "<" | ">=" | "<="; value: number },
  htfRsiCache: Record<string, number | null>,
): boolean {
  const rsi = htfRsiCache[filter.tf];
  if (rsi === null || rsi === undefined) return false;
  switch (filter.op) {
    case ">":  return rsi >  filter.value;
    case "<":  return rsi <  filter.value;
    case ">=": return rsi >= filter.value;
    case "<=": return rsi <= filter.value;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// htfFilters[] schema — mirror of tools/backtest-my-rule.ts
// Supports 6 filter types: trend, rsi, slope, compare, stochRange, cross.
// Each HTF referenced gets a short "indicator history" (last N+1 snapshots)
// so slope filters with lookback N and cross filters can be evaluated.
// ──────────────────────────────────────────────────────────────────────────
type CompOp = ">" | "<" | ">=" | "<=";
type IndName = "rsi" | "stochK" | "stochD";

export type HtfFilter =
  | { type: "trend"; tf?: string; direction: "up" | "down" | "flat" }
  | { type: "rsi"; tf: string; op: CompOp; value: number }
  | { type: "slope"; tf: string; indicator: IndName; direction: "rising" | "falling"; lookback?: number }
  | { type: "compare"; tf: string; left: IndName; op: CompOp; right: IndName | number }
  | { type: "stochRange"; tf: string; kMin?: number; kMax?: number; dMin?: number; dMax?: number }
  | { type: "cross"; tf: string; direction: "k_above_d" | "k_below_d" | "bullish_cross" | "bearish_cross" };

/** HTF indicator history: last N+1 bars worth of RSI/StochK/StochD.
 *  Index convention: last element (length-1) = now, earlier = older. */
interface HtfIndSeries {
  rsi: (number | null)[];
  stochK: (number | null)[];
  stochD: (number | null)[];
}

/** Compute the LAST `historyBars+1` snapshots (slope needs now + now-lookback;
 *  cross needs now + now-1). Runs calcRSI/calcStochRSI on closes[0..upto] for
 *  upto ∈ {N-historyBars, …, N}. */
function computeHtfIndLive(klines: Kline[], historyBars: number): HtfIndSeries {
  const needed = historyBars + 1;
  const rsi: (number | null)[] = new Array(needed).fill(null);
  const stochK: (number | null)[] = new Array(needed).fill(null);
  const stochD: (number | null)[] = new Array(needed).fill(null);
  if (klines.length < 15) return { rsi, stochK, stochD };
  const closes = klines.map((k) => k.close);
  for (let back = 0; back <= historyBars; back++) {
    const upto = closes.length - back;
    if (upto < 15) continue;
    const window = closes.slice(0, upto);
    const idx = historyBars - back; // 0 = oldest, historyBars = now
    rsi[idx] = calcRSI(window);
    const s = calcStochRSI(window);
    stochK[idx] = s.k;
    stochD[idx] = s.d;
  }
  return { rsi, stochK, stochD };
}

function applyCompOpLive(left: number, op: CompOp, right: number): boolean {
  switch (op) {
    case ">":  return left >  right;
    case "<":  return left <  right;
    case ">=": return left >= right;
    case "<=": return left <= right;
  }
}

function readIndLive(ind: HtfIndSeries, name: IndName, idx: number): number | null {
  const arr = name === "rsi" ? ind.rsi : name === "stochK" ? ind.stochK : ind.stochD;
  if (idx < 0 || idx >= arr.length) return null;
  return arr[idx];
}

/** Evaluate a single HtfFilter using the live cache. */
function evalHtfFilterLive(
  filter: HtfFilter,
  htfIndCache: Record<string, HtfIndSeries>,
  htfTrendsByTF: Record<string, Trend>,
  defaultTrendTF: string,
): boolean {
  const tf = (filter as any).tf || defaultTrendTF;

  if (filter.type === "trend") {
    const want: Trend = filter.direction === "up" ? "UP" : filter.direction === "down" ? "DOWN" : "FLAT";
    return (htfTrendsByTF[tf] || "FLAT") === want;
  }

  const ind = htfIndCache[tf];
  if (!ind) return false;
  const nowIdx = ind.rsi.length - 1;

  switch (filter.type) {
    case "rsi": {
      const v = ind.rsi[nowIdx];
      if (v === null) return false;
      return applyCompOpLive(v, filter.op, filter.value);
    }
    case "slope": {
      const lb = filter.lookback ?? 3;
      if (nowIdx - lb < 0) return false;
      const now = readIndLive(ind, filter.indicator, nowIdx);
      const past = readIndLive(ind, filter.indicator, nowIdx - lb);
      if (now === null || past === null) return false;
      const slope = now - past;
      return filter.direction === "rising" ? slope > 0 : slope < 0;
    }
    case "compare": {
      const leftV = readIndLive(ind, filter.left, nowIdx);
      if (leftV === null) return false;
      const rightV = typeof filter.right === "number"
        ? filter.right
        : readIndLive(ind, filter.right, nowIdx);
      if (rightV === null) return false;
      return applyCompOpLive(leftV, filter.op, rightV);
    }
    case "stochRange": {
      const k = ind.stochK[nowIdx];
      const d = ind.stochD[nowIdx];
      if (k === null) return false;
      if (filter.kMin !== undefined && k < filter.kMin) return false;
      if (filter.kMax !== undefined && k > filter.kMax) return false;
      if (filter.dMin !== undefined && (d === null || d < filter.dMin)) return false;
      if (filter.dMax !== undefined && (d === null || d > filter.dMax)) return false;
      return true;
    }
    case "cross": {
      const k = ind.stochK[nowIdx];
      const d = ind.stochD[nowIdx];
      if (k === null || d === null) return false;
      if (filter.direction === "k_above_d") return k > d;
      if (filter.direction === "k_below_d") return k < d;
      if (nowIdx < 1) return false;
      const prevK = ind.stochK[nowIdx - 1];
      const prevD = ind.stochD[nowIdx - 1];
      if (prevK === null || prevD === null) return false;
      if (filter.direction === "bullish_cross") return prevK <= prevD && k > d;
      if (filter.direction === "bearish_cross") return prevK >= prevD && k < d;
      return false;
    }
  }
  return false;
}

/** Human-readable label for UI display. */
function formatHtfFilterLive(f: HtfFilter): string {
  switch (f.type) {
    case "trend":
      return `${f.tf || "near"} trend = ${f.direction.toUpperCase()}`;
    case "rsi":
      return `${f.tf} RSI ${f.op} ${f.value}`;
    case "slope":
      return `${f.tf} ${f.indicator} ${f.direction === "rising" ? "↑" : "↓"} (lb ${f.lookback ?? 3})`;
    case "compare":
      return `${f.tf} ${f.left} ${f.op} ${typeof f.right === "number" ? f.right : f.right}`;
    case "stochRange": {
      const parts: string[] = [];
      if (f.kMin !== undefined) parts.push(`K≥${f.kMin}`);
      if (f.kMax !== undefined) parts.push(`K≤${f.kMax}`);
      if (f.dMin !== undefined) parts.push(`D≥${f.dMin}`);
      if (f.dMax !== undefined) parts.push(`D≤${f.dMax}`);
      return `${f.tf} stoch ${parts.join(" · ")}`;
    }
    case "cross":
      return `${f.tf} stoch ${f.direction}`;
  }
}

/** Return current value snippet for a filter (for UI display). */
function filterLiveValueSnippet(
  f: HtfFilter,
  htfIndCache: Record<string, HtfIndSeries>,
  htfTrendsByTF: Record<string, Trend>,
  defaultTrendTF: string,
): string {
  const tf = (f as any).tf || defaultTrendTF;
  if (f.type === "trend") return htfTrendsByTF[tf] || "—";
  const ind = htfIndCache[tf];
  if (!ind) return "—";
  const nowIdx = ind.rsi.length - 1;
  const fmt = (v: number | null) => (v === null ? "—" : v.toFixed(1));
  switch (f.type) {
    case "rsi":
      return `RSI=${fmt(ind.rsi[nowIdx])}`;
    case "slope": {
      const lb = f.lookback ?? 3;
      const now = readIndLive(ind, f.indicator, nowIdx);
      const past = nowIdx - lb >= 0 ? readIndLive(ind, f.indicator, nowIdx - lb) : null;
      if (now === null || past === null) return "—";
      const slope = now - past;
      return `${f.indicator}: ${fmt(past)}→${fmt(now)} (Δ${slope >= 0 ? "+" : ""}${slope.toFixed(1)})`;
    }
    case "compare": {
      const leftV = readIndLive(ind, f.left, nowIdx);
      const rightV = typeof f.right === "number" ? f.right : readIndLive(ind, f.right, nowIdx);
      return `${f.left}=${fmt(leftV)} vs ${typeof f.right === "number" ? f.right : `${f.right}=${fmt(rightV as number | null)}`}`;
    }
    case "stochRange":
      return `K=${fmt(ind.stochK[nowIdx])} D=${fmt(ind.stochD[nowIdx])}`;
    case "cross":
      return `K=${fmt(ind.stochK[nowIdx])} D=${fmt(ind.stochD[nowIdx])}`;
  }
}

/** SMART rule matching — evaluates conditions PER-RULE with its own thresholds */
function ruleMatchesSmart(
  rule: HardRule,
  ind: TFIndicatorCache,
  trendNear: Trend,
  trendFar: Trend,
  htfRsiCache: Record<string, number | null>,
  htfIndCache: Record<string, HtfIndSeries>,
  htfTrendsByTF: Record<string, Trend>,
  defaultTrendTF: string,
  multiTfScoreSnap?: { long: number | null; short: number | null } | null,
): { matches: boolean; effectiveSide: "LONG" | "SHORT"; conds: EntryConditions; bits: number; skipReason?: string } {
  const cfg = rule.config as any;
  const stats = rule.stats as any;
  // 2026-04-22: skip rules marked disabled (via apply-rescue.ts — DEAD rules)
  // hoặc delegatedTo khác (ví dụ "useRiskRadar" — golden rules đã handle native).
  if (cfg.disabled === true || cfg.delegatedTo) {
    return { matches: false, effectiveSide: "LONG", conds: {} as any, bits: 0, skipReason: "disabled/delegated" };
  }
  const ruleSide: "LONG" | "SHORT" | undefined = stats.side || cfg.forceSide;
  const sidesToCheck: ("LONG" | "SHORT")[] = ruleSide ? [ruleSide] : ["LONG", "SHORT"];

  // 2026-04-22 P1: track most-progressed skip reason per side, report the best one.
  // Priority order matches the FAST PATH chain — later stages = more progress.
  const reasonPriority: Record<string, number> = {
    "candleReversal": 1, "emaPos": 2, "zeroCond": 3, "htfTrend": 4,
    "atr": 5, "macdHist": 6, "emaDist": 7, "multiTfScore": 8,
    "htfRsi": 9, "htfFilters": 10, "required": 11, "score": 12,
  };
  type ReasonRec = { code: string; detail: string; side: "LONG" | "SHORT" };
  const reasonBox: { cur: ReasonRec | null } = { cur: null };
  const setReason = (code: string, detail: string, side: "LONG" | "SHORT") => {
    const prio = reasonPriority[code] ?? 0;
    const bestPrio = reasonBox.cur ? (reasonPriority[reasonBox.cur.code] ?? 0) : -1;
    if (prio > bestPrio) reasonBox.cur = { code, detail, side };
  };

  for (const side of sidesToCheck) {
    // FAST PATH 0a: candleReversalFilter — rule REVERSAL_4H_UP/DOWN đòi 2 cây
    // liên tiếp ngược màu ngay tại entry TF. Nếu không match → skip luôn.
    if (cfg.candleReversalFilter) {
      // 2026-04-22: flipped rule → invert reversal direction để replicate backtest semantic.
      const invCR = cfg.candleReversalFilter.invertedFromFlip === true;
      const baseCR = side === "LONG" ? "UP_REVERSAL" : "DOWN_REVERSAL";
      const want = invCR ? (baseCR === "UP_REVERSAL" ? "DOWN_REVERSAL" : "UP_REVERSAL") : baseCR;
      if (ind.candleReversal !== want) { setReason("candleReversal", `cần ${want}, đang ${ind.candleReversal ?? "—"}`, side); continue; }
    }
    // FAST PATH 0b: emaPosFilter — "dưới EMA50 4h" hay "trên EMA50 4h"
    if (cfg.emaPosFilter) {
      if (ind.ema50 === null) { setReason("emaPos", "EMA50 chưa có", side); continue; }
      const above = ind.price >= ind.ema50;
      if (cfg.emaPosFilter === "above" && !above) { setReason("emaPos", "giá dưới EMA50 (cần trên)", side); continue; }
      if (cfg.emaPosFilter === "below" && above) { setReason("emaPos", "giá trên EMA50 (cần dưới)", side); continue; }
    }

    // Evaluate conditions using THIS RULE's thresholds (not hardcoded!)
    const { conds, bits } = evalConditionsForRule(ind, side, cfg);

    // FAST PATH 1: if zero conditions fired for this side, skip immediately
    // EXCEPT for candleReversal-only rules (no traditional conditions needed)
    if (bits === 0 && !cfg.candleReversalFilter) { setReason("zeroCond", "0 condition khớp cho side này", side); continue; }

    // FAST PATH 2a: HTF trend filter (EMA-based) — check BEFORE weighted score
    if (cfg.htfTrendFilter) {
      const mode = cfg.htfTrendFilter.mode || cfg.htfTrendFilter;
      // 2026-04-22 flipped rules: HTF filter semantic giữ nguyên theo ORIGINAL side
      //   → khi forceSide flipped, want phải invert để replicate backtest.
      const inverted = cfg.htfTrendFilter.invertedFromFlip === true;
      const baseWant: Trend = side === "LONG" ? "UP" : "DOWN";
      const want: Trend = inverted ? (baseWant === "UP" ? "DOWN" : "UP") : baseWant;
      const modeStr = typeof mode === "string" ? mode : JSON.stringify(mode);
      if (mode === "near_match" && trendNear !== want) { setReason("htfTrend", `HTF gần cần ${want}, đang ${trendNear}`, side); continue; }
      else if (mode === "far_match" && trendFar !== want) { setReason("htfTrend", `HTF xa cần ${want}, đang ${trendFar}`, side); continue; }
      else if (mode === "both_match" && (trendNear !== want || trendFar !== want)) { setReason("htfTrend", `cần ${want} cả 2 HTF (gần=${trendNear}, xa=${trendFar})`, side); continue; }
      else if (mode === "near_flat" && trendNear !== "FLAT") { setReason("htfTrend", `HTF gần cần FLAT, đang ${trendNear}`, side); continue; }
      else if (mode === "far_flat" && trendFar !== "FLAT") { setReason("htfTrend", `HTF xa cần FLAT, đang ${trendFar}`, side); continue; }
      else if (mode === "both_flat" && (trendNear !== "FLAT" || trendFar !== "FLAT")) { setReason("htfTrend", `cần FLAT cả 2 HTF`, side); continue; }
      else if (typeof mode === "object" && mode.want) {
        const w = mode.want as Trend;
        const tfSel = mode.tf === "far" ? trendFar : trendNear;
        if (tfSel !== w) { setReason("htfTrend", `HTF ${mode.tf || "near"} cần ${w}, đang ${tfSel}`, side); continue; }
      }
    }

    // v4.3.15 — FAST PATH 2d: atrFilter on entry TF
    if (cfg.atrFilter && !evalFeatFilter(ind.atrPct, cfg.atrFilter)) { setReason("atr", `ATR% ngoài range (đang ${ind.atrPct?.toFixed(2) ?? "—"}%)`, side); continue; }
    // v4.3.15 — FAST PATH 2e: macdHistFilter on entry TF
    if (cfg.macdHistFilter && !evalFeatFilter(ind.macdHistogram, cfg.macdHistFilter)) { setReason("macdHist", `MACD hist ngoài range (đang ${ind.macdHistogram?.toFixed(1) ?? "—"})`, side); continue; }
    // v4.3.15 — FAST PATH 2f: emaDistFilter on entry TF
    if (cfg.emaDistFilter && !evalFeatFilter(ind.emaDistPct, cfg.emaDistFilter)) { setReason("emaDist", `EMA dist% ngoài range (đang ${ind.emaDistPct?.toFixed(2) ?? "—"}%)`, side); continue; }

    // v4.3.15 iter4 — FAST PATH 2g: multiTfScoreFilter
    if (cfg.multiTfScoreFilter && multiTfScoreSnap) {
      const f = cfg.multiTfScoreFilter;
      const sc = f.side === "LONG" ? multiTfScoreSnap.long : multiTfScoreSnap.short;
      if (sc === null || sc < (f.threshold ?? 70)) { setReason("multiTfScore", `score ${f.side} = ${sc ?? "—"} < ${f.threshold ?? 70}`, side); continue; }
    } else if (cfg.multiTfScoreFilter && !multiTfScoreSnap) {
      setReason("multiTfScore", "score snapshot chưa sẵn sàng", side);
      continue;
    }

    // FAST PATH 2b: HTF RSI filter (momentum-based, realtime-safe)
    if (cfg.htfRsiFilter) {
      if (!evalHtfRsiFilterLive(cfg.htfRsiFilter, htfRsiCache)) {
        const f = cfg.htfRsiFilter;
        const v = htfRsiCache[f.tf];
        setReason("htfRsi", `${f.tf} RSI ${f.op} ${f.value} (đang ${v?.toFixed(1) ?? "—"})`, side);
        continue;
      }
    }

    // FAST PATH 2c: extensible htfFilters[] — all must pass
    if (Array.isArray(cfg.htfFilters) && cfg.htfFilters.length > 0) {
      let failedLabel = "";
      for (const f of cfg.htfFilters as HtfFilter[]) {
        if (!evalHtfFilterLive(f, htfIndCache, htfTrendsByTF, defaultTrendTF)) {
          failedLabel = formatHtfFilterLive(f);
          break;
        }
      }
      if (failedLabel) { setReason("htfFilters", `${failedLabel} không khớp`, side); continue; }
    }

    // FAST PATH 3: required conditions — O(1) bitmask check
    const reqMask = buildReqBitmask(cfg.requiredConditions);
    if (reqMask && (bits & reqMask) !== reqMask) {
      const missing = (cfg.requiredConditions || []).filter((k: any) => !(conds as any)[k]);
      setReason("required", `thiếu: ${missing.join(", ") || "?"}`, side);
      continue;
    }

    // Score check (skip for candleReversal-only rules — reversal IS the signal)
    if (cfg.weights) {
      let score = 0;
      for (const k of Object.keys(cfg.weights) as (keyof EntryConditions)[]) {
        if (conds[k]) score += cfg.weights[k] || 0;
      }
      if (score < (cfg.minWeightedScore || 1)) { setReason("score", `weighted score ${score}/${cfg.minWeightedScore || 1}`, side); continue; }
    } else if (!cfg.candleReversalFilter) {
      const firedCount = popcount(bits);
      if (firedCount < (cfg.minScore || 1)) { setReason("score", `minScore ${firedCount}/${cfg.minScore || 1}`, side); continue; }
    }

    return { matches: true, effectiveSide: side, conds, bits };
  }
  // Return default empty conds for the primary side when no match
  const fallbackSide = ruleSide || "LONG";
  const { conds: fallbackConds, bits: fallbackBits } = evalConditionsForRule(ind, fallbackSide, cfg);
  const reasonText = reasonBox.cur
    ? (sidesToCheck.length > 1 ? `[${reasonBox.cur.side}] ${reasonBox.cur.detail}` : reasonBox.cur.detail)
    : undefined;
  return { matches: false, effectiveSide: fallbackSide, conds: fallbackConds, bits: fallbackBits, skipReason: reasonText };
}

/** Per-TF live indicator snapshot — exported for UI display */
export interface LiveCondSnapshot {
  rsi: number | null;
  stochK: number | null;
  stochD: number | null;
  price: number;
}

/** Per-filter status for display in RuleAlertBanner */
export interface HtfFilterStatus {
  label: string;        // "1h RSI ≥ 50"
  match: boolean;       // passes right now?
  liveValue: string;    // "RSI=52.3" or "stochK: 38→44 (Δ+6.0)"
}

/** Per-rule detailed match info */
export interface RuleMatchDetail {
  status: "ARMED" | "FIRED" | "OFF";
  /** Which conditions the rule needs vs which are currently true */
  matched: number;    // how many of rule's conditions are currently met
  required: number;   // how many the rule needs to fire
  /** Individual condition status: true = currently met */
  condDetail: Record<string, boolean>;
  /** HTF trend filter status */
  htfMatch: boolean | null; // null = no HTF trend filter, true = matches, false = blocked
  /** HTF RSI filter status (for new htfRsiFilter rules) */
  htfRsiMatch: boolean | null; // null = no htfRsiFilter, true/false = pass/block
  htfRsiValue: number | null;  // current HTF RSI value (for display)
  htfRsiFilter: { tf: string; op: string; value: number } | null; // for display
  /** Extensible htfFilters[] status list (slope / compare / stochRange / etc.) */
  htfFiltersStatus: HtfFilterStatus[] | null;
  /** v4.3.15 — Feature-filter status list (atr, macdHist, emaDist) */
  featFiltersStatus: HtfFilterStatus[] | null;
  side: "LONG" | "SHORT" | "BOTH";
  /** 2026-04-22 P1: lý do rule không FIRE (chỉ set khi status=ARMED).
   * Giúp user nhìn thấy filter nào đang block (minScore / multiTfScore / atr / etc). */
  skipReason?: string;
}

export interface UseRuleAlertsResult {
  activeAlerts: RuleAlert[];
  lastEvaluated: number;
  ruleStatus: Record<TrackedRuleId, "ARMED" | "FIRED" | "OFF">;
  /** Detailed per-rule match info for UI */
  ruleMatchDetails: Record<TrackedRuleId, RuleMatchDetail>;
  /** Per-TF live conditions snapshot */
  liveConditions: Record<string, LiveCondSnapshot>;
}

export interface RuleAlertOptions {
  notifyEnabled?: boolean;
  notifyMinScore?: number;
}

function klineFingerprint(kline: Kline | undefined): string {
  if (!kline) return "0";
  return [kline.time, kline.open, kline.high, kline.low, kline.close, kline.volume].join(":");
}

export function useRuleAlerts(
  rawKlines: RawKlinesMap | undefined,
  trackedIds: Set<TrackedRuleId>,
  options: boolean | RuleAlertOptions = true,
): UseRuleAlertsResult {
  const notifyEnabled = typeof options === "boolean" ? options : options.notifyEnabled ?? true;
  const notifyMinScore = typeof options === "boolean" ? 1 : options.notifyMinScore ?? 1;
  const [activeAlerts, setActiveAlerts] = useState<RuleAlert[]>([]);
  const [lastEvaluated, setLastEvaluated] = useState(0);
  const [ruleStatus, setRuleStatus] = useState<Record<TrackedRuleId, "ARMED" | "FIRED" | "OFF">>({});
  const [ruleMatchDetails, setRuleMatchDetails] = useState<Record<TrackedRuleId, RuleMatchDetail>>({});
  const [liveConditions, setLiveConditions] = useState<Record<string, LiveCondSnapshot>>({});

  const lastFireCandleTimeRef = useRef<Record<TrackedRuleId, number>>({});
  const lastEvalFingerprintsRef = useRef<Record<string, string>>({});

  const trackedIdsArr = useMemo(() => Array.from(trackedIds), [trackedIds]);

  useEffect(() => {
    if (!rawKlines || trackedIdsArr.length === 0) {
      setActiveAlerts([]);
      setRuleStatus({});
      return;
    }

    // ── Phase 1: Collect needed TFs + check if any rule needs HTF ──
    const neededTFs = new Set<string>();
    const htfNeededTFs = new Set<string>(); // TFs with EMA-trend HTF-filtered rules
    const htfRsiKeys = new Set<string>();   // HTF keys where we need RSI (e.g. "1h", "4h")
    /** htfFilters[] — per HTF key, the max historyBars needed (lookback or cross=1). */
    const htfIndNeeds: Record<string, number> = {};
    /** HTF keys that need an EMA-trend computed (from htfFilters[].type="trend"). */
    const htfTrendKeys = new Set<string>();
    const rulesByTF: Record<string, ReturnType<typeof getHardRulesForTF>> = {};

    for (const id of trackedIdsArr) {
      const { tfKey, rank } = parseRuleId(id);
      neededTFs.add(tfKey);
      if (!(tfKey in rulesByTF)) rulesByTF[tfKey] = getHardRulesForTF(tfKey);
      const rule = rulesByTF[tfKey].find((r) => r.rank === rank);
      if (rule) {
        const cfg = rule.config as any;
        if (cfg.htfTrendFilter) htfNeededTFs.add(tfKey);
        if (cfg.htfRsiFilter && cfg.htfRsiFilter.tf) htfRsiKeys.add(cfg.htfRsiFilter.tf);
        // Extensible htfFilters[] — collect every referenced TF + required history
        if (Array.isArray(cfg.htfFilters)) {
          const [nearTF] = HTF_MAP[tfKey] || ["1h", "4h"];
          for (const f of cfg.htfFilters as HtfFilter[]) {
            const tf = (f as any).tf || nearTF;
            let need = 0;
            if (f.type === "slope") need = f.lookback ?? 3;
            else if (f.type === "cross") need = 1;
            if (f.type === "trend") {
              htfTrendKeys.add(tf);
            } else {
              htfIndNeeds[tf] = Math.max(htfIndNeeds[tf] ?? 0, need);
            }
          }
        }
      }
    }

    // ── Phase 2: Throttle — skip only if live candle content is unchanged ──
    let advanced = false;
    for (const tfKey of neededTFs) {
      const klines = rawKlines[tfKey] || [];
      if (klines.length === 0) continue;
      const fingerprint = klineFingerprint(klines[klines.length - 1]);
      if (fingerprint !== (lastEvalFingerprintsRef.current[tfKey] || "")) {
        advanced = true; break;
      }
    }
    if (!advanced && lastEvaluated > 0) return;
    for (const tfKey of neededTFs) {
      const klines = rawKlines[tfKey] || [];
      if (klines.length > 0) lastEvalFingerprintsRef.current[tfKey] = klineFingerprint(klines[klines.length - 1]);
    }

    // Detect whether any rule needs multi-TF score → pre-fetch 4h/1d/1w data
    let needMultiTfScore = false;
    for (const id of trackedIdsArr) {
      const { tfKey, rank } = parseRuleId(id);
      const rule = rulesByTF[tfKey]?.find((r) => r.rank === rank);
      if (rule && (rule.config as any).multiTfScoreFilter) { needMultiTfScore = true; break; }
    }
    if (needMultiTfScore) {
      // Ensure raw klines for 4h, 1d, 1w are available
      for (const t of ["4h", "1d", "1w"]) neededTFs.add(t);
    }

    // ── Phase 3: Compute raw indicators ONCE per TF (most expensive step) ──
    const tfCache: Record<string, TFIndicatorCache | null> = {};
    for (const tfKey of neededTFs) {
      tfCache[tfKey] = computeTFIndicators(rawKlines[tfKey] || []);
    }

    // Compute multiTfScoreSnap once (uses 1h + 4h + 1d + 1w caches)
    let multiTfScoreSnap: { long: number | null; short: number | null } | null = null;
    if (needMultiTfScore) {
      const ind1h = tfCache["1h"] ?? null;
      const r4raw = rawKlines["4h"] || [];
      const r1draw = rawKlines["1d"] || [];
      const r1wraw = rawKlines["1w"] || [];
      const t4T = r4raw.length > 0 ? trendFromEMA(r4raw[r4raw.length-1].close, calcLastEMA(r4raw.map((k) => k.close), 50)) : null;
      const t1dT = r1draw.length > 0 ? trendFromEMA(r1draw[r1draw.length-1].close, calcLastEMA(r1draw.map((k) => k.close), 50)) : null;
      const t1wT = r1wraw.length > 0 ? trendFromEMA(r1wraw[r1wraw.length-1].close, calcLastEMA(r1wraw.map((k) => k.close), 50)) : null;
      const r4v = r4raw.length >= 15 ? calcRSI(r4raw.map((k) => k.close)) : null;
      const r1dv = r1draw.length >= 15 ? calcRSI(r1draw.map((k) => k.close)) : null;
      const inputs: MultiTfInputs = {
        atr1h: ind1h?.atrPct ?? null,
        emaDist1h: ind1h?.emaDistPct ?? null,
        rsi1h: ind1h?.rsi ?? null,
        macdHist: ind1h?.macdHistogram ?? null,
        prevMacdHist: ind1h?.prevMacdHistogram ?? null,
        t4Trend: t4T, r4: r4v,
        t1dTrend: t1dT, r1d: r1dv,
        t1wTrend: t1wT,
      };
      multiTfScoreSnap = {
        long: computeMultiTfScore("LONG", inputs),
        short: computeMultiTfScore("SHORT", inputs),
      };
    }

    // ── Phase 4: Compute HTF trends (cheap — only EMA50) ──
    const htfTrends: Record<string, { near: Trend; far: Trend }> = {};
    if (htfNeededTFs.size > 0) {
      const trendCache: Record<string, Trend> = {};
      const getTrend = (tfKey: string): Trend => {
        if (tfKey in trendCache) return trendCache[tfKey];
        const klines = rawKlines[tfKey] || [];
        if (klines.length === 0) { trendCache[tfKey] = "FLAT"; return "FLAT"; }
        const closes = klines.map((k) => k.close);
        const t = trendFromEMA(closes[closes.length - 1], calcLastEMA(closes, 50));
        trendCache[tfKey] = t;
        return t;
      };
      for (const entryTF of htfNeededTFs) {
        const [nearTF, farTF] = HTF_MAP[entryTF] || ["1h", "4h"];
        htfTrends[entryTF] = { near: getTrend(nearTF), far: getTrend(farTF) };
      }
    }

    // ── Phase 4b: Compute HTF RSI cache (for htfRsiFilter rules) ──
    // Reuse tfCache when the HTF is also an entry TF; otherwise compute RSI
    // directly from the raw HTF klines. This is the realtime-safe counterpart
    // of backtest-my-rule's buildHTFRsiArray: it uses whatever the latest bar
    // produces (which on unclosed candles is still a best-effort signal).
    const htfRsiCache: Record<string, number | null> = {};
    for (const htfKey of htfRsiKeys) {
      if (tfCache[htfKey]) {
        htfRsiCache[htfKey] = tfCache[htfKey]!.rsi;
      } else {
        const klines = rawKlines[htfKey] || [];
        if (klines.length >= 15) {
          const closes = klines.map((k) => k.close);
          htfRsiCache[htfKey] = calcRSI(closes);
        } else {
          htfRsiCache[htfKey] = null;
        }
      }
    }

    // ── Phase 4c: Compute HTF indicator history (for htfFilters[]) ──
    // Per referenced HTF, compute historyBars+1 snapshots of RSI/StochK/StochD.
    // historyBars = max(lookback across slope filters, 1 if any cross filter).
    const htfIndCache: Record<string, HtfIndSeries> = {};
    for (const htfKey of Object.keys(htfIndNeeds)) {
      const klines = rawKlines[htfKey] || [];
      htfIndCache[htfKey] = computeHtfIndLive(klines, htfIndNeeds[htfKey]);
    }

    // ── Phase 4d: Compute per-HTF EMA trends referenced by htfFilters[] ──
    const htfTrendsByTF: Record<string, Trend> = {};
    for (const htfKey of htfTrendKeys) {
      const klines = rawKlines[htfKey] || [];
      if (klines.length === 0) {
        htfTrendsByTF[htfKey] = "FLAT";
      } else {
        const closes = klines.map((k) => k.close);
        htfTrendsByTF[htfKey] = trendFromEMA(closes[closes.length - 1], calcLastEMA(closes, 50));
      }
    }

    // ── Phase 5: Match each tracked rule + build detailed match info ──
    const newAlerts: RuleAlert[] = [];
    const newStatus: Record<TrackedRuleId, "ARMED" | "FIRED" | "OFF"> = {};
    const newDetails: Record<TrackedRuleId, RuleMatchDetail> = {};

    // Export live indicator snapshots per TF
    const newLiveConds: Record<string, LiveCondSnapshot> = {};
    for (const tfKey of neededTFs) {
      const ind = tfCache[tfKey];
      if (ind) newLiveConds[tfKey] = { rsi: ind.rsi, stochK: ind.stochK, stochD: ind.stochD, price: ind.price };
    }

    for (const id of trackedIdsArr) {
      const { tfKey, rank } = parseRuleId(id);
      const rule = rulesByTF[tfKey]?.find((r) => r.rank === rank);
      if (!rule) {
        newStatus[id] = "OFF";
        newDetails[id] = { status: "OFF", matched: 0, required: 0, condDetail: {}, htfMatch: null, htfRsiMatch: null, htfRsiValue: null, htfRsiFilter: null, htfFiltersStatus: null, featFiltersStatus: null, side: "BOTH" };
        continue;
      }

      const ind = tfCache[tfKey];
      if (!ind) {
        newStatus[id] = "OFF";
        newDetails[id] = { status: "OFF", matched: 0, required: 0, condDetail: {}, htfMatch: null, htfRsiMatch: null, htfRsiValue: null, htfRsiFilter: null, htfFiltersStatus: null, featFiltersStatus: null, side: "BOTH" };
        continue;
      }

      // HTF trends for this TF
      const tfHTF = htfTrends[tfKey] || { near: "FLAT" as Trend, far: "FLAT" as Trend };
      const [nearTFKey] = HTF_MAP[tfKey] || ["1h", "4h"];

      // Match using per-rule thresholds (the core fix!)
      const { matches, effectiveSide, conds, bits, skipReason } = ruleMatchesSmart(
        rule, ind, tfHTF.near, tfHTF.far, htfRsiCache,
        htfIndCache, htfTrendsByTF, nearTFKey,
        multiTfScoreSnap,
      );

      const cfg = rule.config as any;
      const stats = rule.stats as any;
      const ruleSide: "LONG" | "SHORT" | undefined = stats.side || cfg.forceSide;

      // Build condition detail from per-rule evaluated conditions
      const condDetail: Record<string, boolean> = {};
      const condKeys = ["stochExtreme", "rsiExtreme", "divergence", "bollingerTouch", "macdCross"];
      for (const k of condKeys) condDetail[k] = !!(conds as any)[k];

      // Count matched vs required
      let matched = 0, required = 0;
      if (cfg.candleReversalFilter) {
        // Reversal rule: required = 1 (the reversal itself), matched = 1 if reversal detected + ema filter pass
        required = 1;
        const invCR = cfg.candleReversalFilter.invertedFromFlip === true;
        const baseCR = (ruleSide || "LONG") === "LONG" ? "UP_REVERSAL" : "DOWN_REVERSAL";
        const want = invCR ? (baseCR === "UP_REVERSAL" ? "DOWN_REVERSAL" : "UP_REVERSAL") : baseCR;
        const reversalOK = ind.candleReversal === want;
        let emaOK = true;
        if (cfg.emaPosFilter && ind.ema50 !== null) {
          const above = ind.price >= ind.ema50;
          emaOK = cfg.emaPosFilter === "above" ? above : !above;
        }
        matched = (reversalOK && emaOK) ? 1 : 0;
        // Display candle reversal in condDetail for UI
        condDetail["candleReversal"] = reversalOK;
        if (cfg.emaPosFilter) condDetail[`price_${cfg.emaPosFilter}_ema50`] = emaOK;
      } else if (cfg.weights) {
        for (const k of Object.keys(cfg.weights) as (keyof EntryConditions)[]) {
          const w = cfg.weights[k] || 0;
          if (w > 0) required += w;
          if (conds[k] && w > 0) matched += w;
        }
        required = cfg.minWeightedScore || required;
      } else if (cfg.requiredConditions?.length) {
        required = cfg.requiredConditions.length;
        for (const k of cfg.requiredConditions) if ((conds as any)[k]) matched++;
      } else {
        required = cfg.minScore || 1;
        matched = popcount(bits);
      }

      // HTF trend filter match check
      let htfMatch: boolean | null = null;
      if (cfg.htfTrendFilter) {
        const mode = cfg.htfTrendFilter.mode || cfg.htfTrendFilter;
        // 2026-04-22 flipped rules: khi forceSide flipped, invert want để giữ semantic gốc.
        const inverted = cfg.htfTrendFilter.invertedFromFlip === true;
        const baseWant: Trend = effectiveSide === "LONG" ? "UP" : "DOWN";
        const want: Trend = inverted ? (baseWant === "UP" ? "DOWN" : "UP") : baseWant;
        if (mode === "near_match") htfMatch = tfHTF.near === want;
        else if (mode === "far_match") htfMatch = tfHTF.far === want;
        else if (mode === "both_match") htfMatch = tfHTF.near === want && tfHTF.far === want;
        else if (mode === "near_flat") htfMatch = tfHTF.near === "FLAT";
        else if (mode === "far_flat") htfMatch = tfHTF.far === "FLAT";
        else if (mode === "both_flat") htfMatch = tfHTF.near === "FLAT" && tfHTF.far === "FLAT";
        else if (typeof mode === "object" && mode.want) {
          const tfSel = mode.tf === "far" ? tfHTF.far : tfHTF.near;
          htfMatch = tfSel === mode.want;
        }
      }

      // v4.3.15 — Feature filter status (for UI display)
      const featFiltersStatus: HtfFilterStatus[] = [];
      if (cfg.atrFilter) {
        const v = ind.atrPct;
        featFiltersStatus.push({
          label: formatFeatFilter("ATR%", cfg.atrFilter),
          match: evalFeatFilter(v, cfg.atrFilter),
          liveValue: v === null ? "—" : `ATR=${v.toFixed(2)}%`,
        });
      }
      if (cfg.macdHistFilter) {
        const v = ind.macdHistogram;
        featFiltersStatus.push({
          label: formatFeatFilter("MACD Hist", cfg.macdHistFilter),
          match: evalFeatFilter(v, cfg.macdHistFilter),
          liveValue: v === null ? "—" : `Hist=${v.toFixed(1)}`,
        });
      }
      if (cfg.emaDistFilter) {
        const v = ind.emaDistPct;
        featFiltersStatus.push({
          label: formatFeatFilter("EMA Dist%", cfg.emaDistFilter),
          match: evalFeatFilter(v, cfg.emaDistFilter),
          liveValue: v === null ? "—" : `Dist=${v >= 0 ? "+" : ""}${v.toFixed(2)}%`,
        });
      }

      // HTF RSI filter match check
      let htfRsiMatch: boolean | null = null;
      let htfRsiValue: number | null = null;
      let htfRsiFilter: { tf: string; op: string; value: number } | null = null;
      if (cfg.htfRsiFilter) {
        htfRsiFilter = { tf: cfg.htfRsiFilter.tf, op: cfg.htfRsiFilter.op, value: cfg.htfRsiFilter.value };
        htfRsiValue = htfRsiCache[cfg.htfRsiFilter.tf] ?? null;
        htfRsiMatch = evalHtfRsiFilterLive(cfg.htfRsiFilter, htfRsiCache);
      }

      // htfFilters[] status — one entry per filter for UI display
      let htfFiltersStatus: HtfFilterStatus[] | null = null;
      if (Array.isArray(cfg.htfFilters) && cfg.htfFilters.length > 0) {
        htfFiltersStatus = (cfg.htfFilters as HtfFilter[]).map((f) => ({
          label: formatHtfFilterLive(f),
          match: evalHtfFilterLive(f, htfIndCache, htfTrendsByTF, nearTFKey),
          liveValue: filterLiveValueSnippet(f, htfIndCache, htfTrendsByTF, nearTFKey),
        }));
      }

      newDetails[id] = {
        status: matches ? "FIRED" : "ARMED",
        matched, required,
        condDetail,
        htfMatch,
        htfRsiMatch,
        htfRsiValue,
        htfRsiFilter,
        htfFiltersStatus,
        featFiltersStatus: featFiltersStatus.length > 0 ? featFiltersStatus : null,
        side: ruleSide || "BOTH",
        skipReason: matches ? undefined : skipReason,
      };

      if (!matches) { newStatus[id] = "ARMED"; continue; }

      const lastCandle = ind.lastCandle;
      if (!lastCandle) { newStatus[id] = "OFF"; continue; }
      const prevFireTime = lastFireCandleTimeRef.current[id] || 0;
      const isNewFire = lastCandle.time > prevFireTime;

      const entryPrice = lastCandle.close;
      const tpPrice = effectiveSide === "LONG"
        ? entryPrice * (1 + cfg.targetPct / 100)
        : entryPrice * (1 - cfg.targetPct / 100);
      const slPrice = effectiveSide === "LONG"
        ? entryPrice * (1 - cfg.stopPct / 100)
        : entryPrice * (1 + cfg.stopPct / 100);

      const alert: RuleAlert = {
        id, rule, tfKey,
        side: effectiveSide,
        firedAt: lastCandle.time,
        currentPrice: entryPrice,
        entryPrice, tpPrice, slPrice,
        htfStatus: { trend1h: tfHTF.near, trend4h: tfHTF.far },
      };
      newAlerts.push(alert);
      newStatus[id] = "FIRED";

      if (isNewFire) {
        lastFireCandleTimeRef.current[id] = lastCandle.time;
        const notifyScore = cfg.candleReversalFilter ? 1 : popcount(bits);
        if (notifyEnabled && notifyScore >= notifyMinScore) {
          notifyRuleFire(rule, effectiveSide, entryPrice, tpPrice, slPrice).catch(() => {});
        }
      }
    }

    setActiveAlerts(newAlerts);
    setRuleStatus(newStatus);
    setRuleMatchDetails(newDetails);
    setLiveConditions(newLiveConds);
    setLastEvaluated(Date.now());
  }, [rawKlines, trackedIdsArr.join(","), notifyEnabled, notifyMinScore]);

  return { activeAlerts, lastEvaluated, ruleStatus, ruleMatchDetails, liveConditions };
}
