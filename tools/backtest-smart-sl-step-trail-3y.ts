/**
 * backtest-smart-sl-step-trail-3y.ts
 *
 * 3-year LIVE engine backtest comparing 4 modes:
 *   - Mode E0   : baseline (current Mode E, no smart SL, no trailing)
 *   - Mode E-S  : Mode E + Smart SL placement (S/R 1h + 1d) only (no trailing)
 *   - Mode E-T15: Mode E + Step-based trailing on 15m TF only (no smart SL)
 *   - Mode E-ST : Mode E + Smart SL + Step trailing 15m
 *
 * Feature 1: SMART SL PLACEMENT (apply ALL TFs)
 *   - When opening entry, after computing initial SL:
 *     LONG  → find nearest 1h/1d support BELOW current SL price
 *     SHORT → find nearest 1h/1d resistance ABOVE current SL price
 *     If nearest S/R within 0.5% of computed SL → push SL PAST S/R by 0.2% buffer:
 *       LONG : newSL = min(originalSL, support × 0.998)
 *       SHORT: newSL = max(originalSL, resistance × 1.002)
 *     Use 30-bar pivot 1h S/R + 30-bar pivot 1d S/R.
 *
 * Feature 2: STEP-BASED TRAILING (15m TF ONLY)
 *   - Replace continuous trailing with discrete step trailing.
 *   - Steps (% of TP distance from entry):
 *       50, 100, 150, 200, 250, 300, 350, 400, 450, 500
 *   - LONG: when price reaches entry + step×(tp-entry) → SL = entry + step×(tp-entry)
 *   - SHORT: when price reaches entry - step×(entry-tp) → SL = entry - step×(entry-tp)
 *   - Track lastTrailStep per entry (0..10).
 *   - HTF (1h/4h/1d/1w) → NO trailing (keep fixed TP/SL).
 *
 * Reuses .cache/binance-{tf}-3y.json. Mode E logic = backtest-trailing-3y.ts.
 *
 * Output:
 *   - assets/backtest_smart_sl_step_3y.json
 *   - assets/backtest_smart_sl_step_3y.html
 *
 * Usage:
 *   npx tsx tools/backtest-smart-sl-step-trail-3y.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  Candle,
  EntryConditions,
  BacktestConfig,
  findLtfConfirmIndex,
  DEFAULT_LTF_CONFIRM,
  LtfConfirmConfig,
} from "../utils/backtester";
import {
  calcRSISeriesAligned,
  calcStochRSISeries,
  calcMACDSeries,
  calcBollingerSeries,
} from "../utils/indicators";

// ─── Config ─────────────────────────────────────────────────────────────────
const YEARS = 3;
const FEE_PER_SIDE = 0.05;
const CONFIRM_WINDOW = 60;
const SR_LOOKBACK_15M = 50;
const MIN_LOOKBACK = 50;

// Smart SL spec
const SMART_SL_PIVOT_LB = 30;       // 30-bar pivot for 1h+1d S/R
const SMART_SL_PROXIMITY_PCT = 0.5; // S/R within 0.5% of computed SL → push past
const SMART_SL_BUFFER_PCT = 0.2;    // push 0.2% past the S/R level

// Step trailing spec (15m only)
const STEP_TRAIL_STEPS = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0]; // multiples of TP distance
const STEP_TRAIL_TFS = new Set<string>(["15m"]); // 15m ONLY

// LIVE PRESET B
const LIVE_STACK_CFG = {
  stackMaxPerSide: 50,
  stackPerSideSpacingMin: 0,
  stackMinEntryDistPct: 0,
  stackMaxNotionalUsd: 200_000,
  perRuleCooldownMin: 10,
  marginUsd: 1,
  leverage: 100,
  equityDdPausePct: 30,
  equityDdPauseHours: 4,
};

const LTF_CFG: LtfConfirmConfig = {
  ...DEFAULT_LTF_CONFIRM,
  stochOSLevel: 20,
  stochObLevel: 80,
  srProximityPct: 0.4,
  maxWaitBars: CONFIRM_WINDOW,
};

const ENTRY_TFS_FULL = ["5m", "15m", "1h", "4h", "1d", "1w"];
const EXCLUDE_5M_BASELINE_IDS = new Set<string>(["5m:1"]);

const HTF_MAP: Record<string, [string, string]> = {
  "5m": ["15m", "1h"],
  "15m": ["1h", "4h"],
  "1h": ["4h", "1d"],
  "4h": ["1d", "1w"],
  "1d": ["1w", "1w"],
  "1w": ["1w", "1w"],
};

const ALL_TFS = new Set<string>(["5m", "15m", "1h", "1d"]);
for (const tf of ENTRY_TFS_FULL) {
  ALL_TFS.add(tf);
  HTF_MAP[tf].forEach((h) => ALL_TFS.add(h));
}

// ─── Types ──────────────────────────────────────────────────────────────────
type CompOp = ">" | "<" | ">=" | "<=";
type IndName = "rsi" | "stochK" | "stochD";
type Trend = "UP" | "DOWN" | "FLAT";
interface HtfRsiFilter { tf: string; op: CompOp; value: number; }
type HtfFilter =
  | { type: "trend"; tf?: string; direction: "up" | "down" | "flat" }
  | { type: "rsi"; tf: string; op: CompOp; value: number }
  | { type: "slope"; tf: string; indicator: IndName; direction: "rising" | "falling"; lookback?: number }
  | { type: "compare"; tf: string; left: IndName; op: CompOp; right: IndName | number }
  | { type: "stochRange"; tf: string; kMin?: number; kMax?: number; dMin?: number; dMax?: number }
  | { type: "cross"; tf: string; direction: "k_above_d" | "k_below_d" | "bullish_cross" | "bearish_cross" };

interface RuleEntry {
  rank: number;
  source: string;
  label?: string;
  config: BacktestConfig & {
    htfTrendFilter?: { mode: string } | string;
    htfRsiFilter?: HtfRsiFilter;
    htfFilters?: HtfFilter[];
  };
  stats: any;
}

interface IndSeries {
  rsi: (number | null)[];
  stochK: (number | null)[];
  stochD: (number | null)[];
  bbUpper: (number | null)[];
  bbLower: (number | null)[];
  macdHist: (number | null)[];
  ema50: (number | null)[];
  atrPct: (number | null)[];
}

interface HtfBundle {
  series: IndSeries;
  alignment: number[];
  trends: Trend[];
}

// ─── Cache loaders ──────────────────────────────────────────────────────────
function loadCachedKlines(interval: string): Candle[] {
  const cachePath = join(__dirname, "..", ".cache", `binance-${interval}-${YEARS}y.json`);
  if (!existsSync(cachePath)) throw new Error(`Missing cache ${cachePath}`);
  return JSON.parse(readFileSync(cachePath, "utf8")) as Candle[];
}

// ─── Indicator series ───────────────────────────────────────────────────────
function calcATRPctSeries(candles: Candle[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length < period + 1) return out;
  let sum = 0;
  for (let i = 1; i <= period; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    );
    sum += tr;
  }
  let atr = sum / period;
  out[period] = (atr / candles[period].close) * 100;
  for (let i = period + 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    );
    atr = (atr * (period - 1) + tr) / period;
    out[i] = (atr / candles[i].close) * 100;
  }
  return out;
}

function calcEMASeriesLocal(closes: number[], period: number): (number | null)[] {
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

function precomputeSeries(candles: Candle[]): IndSeries {
  const closes = candles.map((c) => c.close);
  const rsi = calcRSISeriesAligned(closes);
  const stoch = calcStochRSISeries(closes);
  const macd = calcMACDSeries(closes);
  const bb = calcBollingerSeries(closes);
  const ema50 = calcEMASeriesLocal(closes, 50);
  return {
    rsi,
    stochK: stoch.kSeries,
    stochD: stoch.dSeries,
    bbUpper: bb.upper,
    bbLower: bb.lower,
    macdHist: macd.histogram,
    ema50,
    atrPct: calcATRPctSeries(candles, 14),
  };
}

function detectDivAt(closes: number[], rsi: (number | null)[], idx: number, lookback = 30): "BULLISH_DIV" | "BEARISH_DIV" | null {
  if (idx < lookback) return null;
  const start = idx - lookback + 1;
  const half = Math.floor(lookback / 2);
  let firstPriceHigh = -Infinity, firstPriceLow = Infinity;
  let secondPriceHigh = -Infinity, secondPriceLow = Infinity;
  let firstRsiHigh = -Infinity, firstRsiLow = Infinity;
  let secondRsiHigh = -Infinity, secondRsiLow = Infinity;
  for (let i = 0; i < lookback; i++) {
    const p = closes[start + i];
    const r = rsi[start + i];
    if (i < half) {
      if (p > firstPriceHigh) firstPriceHigh = p;
      if (p < firstPriceLow) firstPriceLow = p;
      if (r !== null) {
        if (r > firstRsiHigh) firstRsiHigh = r;
        if (r < firstRsiLow) firstRsiLow = r;
      }
    } else {
      if (p > secondPriceHigh) secondPriceHigh = p;
      if (p < secondPriceLow) secondPriceLow = p;
      if (r !== null) {
        if (r > secondRsiHigh) secondRsiHigh = r;
        if (r < secondRsiLow) secondRsiLow = r;
      }
    }
  }
  if (firstRsiHigh === -Infinity || secondRsiHigh === -Infinity) return null;
  if (secondPriceHigh > firstPriceHigh && secondRsiHigh < firstRsiHigh) return "BEARISH_DIV";
  if (secondPriceLow < firstPriceLow && secondRsiLow > firstRsiLow) return "BULLISH_DIV";
  return null;
}

function buildHTFTrendArray(entryCandles: Candle[], htfCandles: Candle[], htfEma50: (number | null)[]): Trend[] {
  const out: Trend[] = new Array(entryCandles.length).fill("FLAT");
  let j = 0;
  for (let i = 0; i < entryCandles.length; i++) {
    while (j + 1 < htfCandles.length && htfCandles[j + 1].time <= entryCandles[i].time) j++;
    const ema = htfEma50[j];
    if (ema === null) { out[i] = "FLAT"; continue; }
    const price = htfCandles[j].close;
    const diffPct = ((price - ema) / ema) * 100;
    out[i] = diffPct > 0.3 ? "UP" : diffPct < -0.3 ? "DOWN" : "FLAT";
  }
  return out;
}

function buildHTFAlignment(entryCandles: Candle[], htfCandles: Candle[]): number[] {
  const out: number[] = new Array(entryCandles.length).fill(-1);
  let j = 0;
  for (let i = 0; i < entryCandles.length; i++) {
    while (j + 1 < htfCandles.length && htfCandles[j + 1].time <= entryCandles[i].time) j++;
    if (htfCandles[j] && htfCandles[j].time <= entryCandles[i].time) out[i] = j;
  }
  return out;
}

function buildHTFRsiAtEntry(alignment: number[], htfRsi: (number | null)[]): (number | null)[] {
  return alignment.map((idx) => (idx >= 0 ? htfRsi[idx] : null));
}

// ─── Filter helpers ─────────────────────────────────────────────────────────
type FeatFilter = { op: ">" | "<" | ">=" | "<=" | "between"; value?: number; min?: number; max?: number };
function evalFeatFilter(v: number | null, f: FeatFilter | undefined): boolean {
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

function applyOp(left: number, op: CompOp, right: number): boolean {
  switch (op) {
    case ">":  return left >  right;
    case "<":  return left <  right;
    case ">=": return left >= right;
    case "<=": return left <= right;
  }
}
function readInd(s: IndSeries, name: IndName, idx: number): number | null {
  return name === "rsi" ? s.rsi[idx] : name === "stochK" ? s.stochK[idx] : s.stochD[idx];
}

function evalHtfFilter(
  filter: HtfFilter,
  bundles: Record<string, HtfBundle>,
  entryIdx: number,
  htfNearKey: string,
): boolean {
  const tf = (filter as any).tf || htfNearKey;
  const bundle = bundles[tf];
  if (!bundle) return false;
  const htfIdx = bundle.alignment[entryIdx];
  if (htfIdx < 0) return false;
  switch (filter.type) {
    case "trend": {
      const want: Trend = filter.direction === "up" ? "UP" : filter.direction === "down" ? "DOWN" : "FLAT";
      return bundle.trends[entryIdx] === want;
    }
    case "rsi": {
      const v = bundle.series.rsi[htfIdx];
      if (v === null) return false;
      return applyOp(v, filter.op, filter.value);
    }
    case "slope": {
      const lb = filter.lookback ?? 3;
      if (htfIdx - lb < 0) return false;
      const now = readInd(bundle.series, filter.indicator, htfIdx);
      const past = readInd(bundle.series, filter.indicator, htfIdx - lb);
      if (now === null || past === null) return false;
      return filter.direction === "rising" ? now - past > 0 : now - past < 0;
    }
    case "compare": {
      const l = readInd(bundle.series, filter.left, htfIdx);
      if (l === null) return false;
      const r = typeof filter.right === "number" ? filter.right : readInd(bundle.series, filter.right, htfIdx);
      if (r === null) return false;
      return applyOp(l, filter.op, r);
    }
    case "stochRange": {
      const k = bundle.series.stochK[htfIdx];
      const d = bundle.series.stochD[htfIdx];
      if (k === null) return false;
      if (filter.kMin !== undefined && k < filter.kMin) return false;
      if (filter.kMax !== undefined && k > filter.kMax) return false;
      if (filter.dMin !== undefined && (d === null || d < filter.dMin)) return false;
      if (filter.dMax !== undefined && (d === null || d > filter.dMax)) return false;
      return true;
    }
    case "cross": {
      const k = bundle.series.stochK[htfIdx];
      const d = bundle.series.stochD[htfIdx];
      if (k === null || d === null) return false;
      if (filter.direction === "k_above_d") return k > d;
      if (filter.direction === "k_below_d") return k < d;
      if (htfIdx < 1) return false;
      const pk = bundle.series.stochK[htfIdx - 1];
      const pd = bundle.series.stochD[htfIdx - 1];
      if (pk === null || pd === null) return false;
      if (filter.direction === "bullish_cross") return pk <= pd && k > d;
      if (filter.direction === "bearish_cross") return pk >= pd && k < d;
      return false;
    }
  }
}

// ─── S/R 15m precompute ─────────────────────────────────────────────────────
function precomputeSR(candles: Candle[], lookback: number) {
  const n = candles.length;
  const sup: (number | null)[] = new Array(n).fill(null);
  const res: (number | null)[] = new Array(n).fill(null);
  for (let i = lookback; i < n; i++) {
    let lo = Infinity, hi = -Infinity;
    for (let j = i - lookback; j < i; j++) {
      if (candles[j].low < lo) lo = candles[j].low;
      if (candles[j].high > hi) hi = candles[j].high;
    }
    sup[i] = lo === Infinity ? null : lo;
    res[i] = hi === -Infinity ? null : hi;
  }
  return { sup, res };
}

function srAtTime(
  candles: Candle[],
  sup: (number | null)[],
  res: (number | null)[],
  t: number,
): { support: number | null; resistance: number | null } {
  let lo = 0, hi = candles.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (idx < 0) return { support: null, resistance: null };
  return { support: sup[idx], resistance: res[idx] };
}

// ─── Smart SL placement ─────────────────────────────────────────────────────
/**
 * Compute smart SL based on nearest 1h/1d S/R proximity.
 * Returns [newSL, wasMoved, distanceMovedPct].
 *
 * LONG : look for 1h/1d support BELOW current SL price.
 *        If support within SMART_SL_PROXIMITY_PCT (0.5%) of SL → push SL DOWN past support (buffer 0.2%).
 *        newSL = min(originalSL, support × (1 - 0.2%))
 * SHORT: look for 1h/1d resistance ABOVE current SL price.
 *        If resistance within 0.5% of SL → push SL UP past resistance (buffer 0.2%).
 *        newSL = max(originalSL, resistance × (1 + 0.2%))
 */
function applySmartSL(
  side: "LONG" | "SHORT",
  origSL: number,
  sup1h: number | null,
  res1h: number | null,
  sup1d: number | null,
  res1d: number | null,
): { newSL: number; moved: boolean; distMovedPct: number; level: number | null; tf: "1h" | "1d" | null } {
  if (side === "LONG") {
    // Candidates: 1h/1d supports BELOW origSL (i.e., support < origSL — we're worried about wick down past origSL hitting then bouncing off support)
    // Actually: support BELOW SL means SL is above support. Wick can touch SL then bounce off support.
    // We want to find supports near SL (within 0.5%) and push SL DOWN past them.
    // "BELOW current SL price" → support <= origSL.
    let nearest: { level: number; tf: "1h" | "1d" } | null = null;
    let nearestDist = Infinity;
    for (const [lvl, tfTag] of [[sup1h, "1h"], [sup1d, "1d"]] as [number | null, "1h" | "1d"][]) {
      if (lvl === null) continue;
      if (lvl > origSL) continue; // must be BELOW SL
      const distPct = Math.abs(origSL - lvl) / origSL * 100;
      if (distPct < nearestDist) {
        nearestDist = distPct;
        nearest = { level: lvl, tf: tfTag };
      }
    }
    if (!nearest || nearestDist > SMART_SL_PROXIMITY_PCT) {
      return { newSL: origSL, moved: false, distMovedPct: 0, level: null, tf: null };
    }
    const candidate = nearest.level * (1 - SMART_SL_BUFFER_PCT / 100);
    const newSL = Math.min(origSL, candidate);
    const moved = newSL < origSL;
    const distMovedPct = moved ? (origSL - newSL) / origSL * 100 : 0;
    return { newSL, moved, distMovedPct, level: nearest.level, tf: nearest.tf };
  } else {
    // SHORT: resistance ABOVE SL → resistance >= origSL
    let nearest: { level: number; tf: "1h" | "1d" } | null = null;
    let nearestDist = Infinity;
    for (const [lvl, tfTag] of [[res1h, "1h"], [res1d, "1d"]] as [number | null, "1h" | "1d"][]) {
      if (lvl === null) continue;
      if (lvl < origSL) continue;
      const distPct = Math.abs(lvl - origSL) / origSL * 100;
      if (distPct < nearestDist) {
        nearestDist = distPct;
        nearest = { level: lvl, tf: tfTag };
      }
    }
    if (!nearest || nearestDist > SMART_SL_PROXIMITY_PCT) {
      return { newSL: origSL, moved: false, distMovedPct: 0, level: null, tf: null };
    }
    const candidate = nearest.level * (1 + SMART_SL_BUFFER_PCT / 100);
    const newSL = Math.max(origSL, candidate);
    const moved = newSL > origSL;
    const distMovedPct = moved ? (newSL - origSL) / origSL * 100 : 0;
    return { newSL, moved, distMovedPct, level: nearest.level, tf: nearest.tf };
  }
}

// ─── Trade simulation ───────────────────────────────────────────────────────
type HitType = "TP" | "ORIG_SL" | "STEP_SL" | "TIME";
interface TradeOutcome {
  source: string;
  tfKey: string;
  side: "LONG" | "SHORT";
  fireTime: number;
  entryIdx5m: number;
  entryTime: number;
  entryPrice: number;
  outcome: "WIN" | "LOSS" | "TIMEOUT";
  hitType: HitType;
  exitPrice: number;
  pnlPct: number;
  holdBars: number;
  exitTime: number;
  // Smart SL telemetry
  smartSLMoved: boolean;
  smartSLDistMovedPct: number;
  smartSLTf: "1h" | "1d" | null;
  // Step trail telemetry
  lastTrailStep: number; // 0 = never reached step 1
  stepClosedAt: number;  // step index that closed the trade (0 if none)
}

/**
 * Simulate trade with optional Smart SL + step trailing (15m only).
 * targetPct/stopPct positive %.
 * LONG : tp = entry × (1 + tp%); origSL = entry × (1 - sl%).
 * SHORT: tp = entry × (1 - tp%); origSL = entry × (1 + sl%).
 *
 * Step trailing (LONG): when high >= entry + step×(tp-entry) → SL = entry + step×(tp-entry).
 * Step trailing (SHORT): when low <= entry - step×(entry-tp) → SL = entry - step×(entry-tp).
 *
 * Original TP triggers close ONLY when no step trailing applied (step trail replaces TP at step 1.0).
 * Actually spec: at step 100% (price = TP), SL = TP (replaces original TP, breakeven from peak).
 * → If trailing enabled, original TP no longer closes at step 1; instead the step SL = TP keeps trade open.
 * → If trailing disabled, original TP closes as usual.
 *
 * Within-bar order resolution: if both TP-tp-step1 hit and original SL hit in same bar:
 *   With trailing → first check if any new step level passed by high (LONG) / low (SHORT);
 *   then check SL hit at the EFFECTIVE SL prior to step update.
 *   Conservative: SL evaluated BEFORE step bump.
 */
function simulateTradeStepTrail(
  ltfCandles: Candle[],
  entryIdx: number,
  side: "LONG" | "SHORT",
  entryPrice: number,
  targetPct: number,
  origSLPrice: number,
  maxHoldBars: number,
  trailing: boolean,
): {
  outcome: "WIN" | "LOSS" | "TIMEOUT";
  hitType: HitType;
  exitPrice: number;
  pnlPct: number;
  holdBars: number;
  exitIdx: number;
  lastTrailStep: number;
  stepClosedAt: number;
} {
  if (entryIdx < 0 || entryIdx >= ltfCandles.length || !Number.isFinite(maxHoldBars)) {
    return {
      outcome: "TIMEOUT", hitType: "TIME", exitPrice: entryPrice, pnlPct: 0, holdBars: 0,
      exitIdx: Math.max(0, Math.min(entryIdx, ltfCandles.length - 1)),
      lastTrailStep: 0, stepClosedAt: 0,
    };
  }
  let maxIdx = Math.min(entryIdx + Math.max(1, Math.floor(maxHoldBars)), ltfCandles.length - 1);
  if (!Number.isFinite(maxIdx) || maxIdx < entryIdx) maxIdx = entryIdx;

  const tp = side === "LONG"
    ? entryPrice * (1 + targetPct / 100)
    : entryPrice * (1 - targetPct / 100);
  const tpDist = side === "LONG" ? tp - entryPrice : entryPrice - tp;

  // Step price levels
  const stepPrices = STEP_TRAIL_STEPS.map((s) =>
    side === "LONG" ? entryPrice + s * tpDist : entryPrice - s * tpDist,
  );

  let lastStep = 0; // 1..10 once first step crossed; 0 = never crossed step 1

  for (let i = entryIdx + 1; i <= maxIdx; i++) {
    const c = ltfCandles[i];

    // Effective SL at start of bar (based on prior trail state)
    let effectiveSL = origSLPrice;
    if (trailing && lastStep >= 1) {
      effectiveSL = stepPrices[lastStep - 1];
    }

    if (side === "LONG") {
      const hitSL = c.low <= effectiveSL;
      const hitTpFixed = !trailing && c.high >= tp;

      // Determine if any new step is crossed this bar (high reaches stepPrice)
      let newStepReached = lastStep;
      if (trailing) {
        for (let s = lastStep + 1; s <= STEP_TRAIL_STEPS.length; s++) {
          if (c.high >= stepPrices[s - 1]) newStepReached = s;
          else break;
        }
      }

      if (hitSL && hitTpFixed) {
        // Both: assume SL first (conservative)
        const slPnl = ((effectiveSL - entryPrice) / entryPrice) * 100;
        const ht: HitType = lastStep === 0 ? "ORIG_SL" : "STEP_SL";
        return {
          outcome: slPnl >= 0 ? "WIN" : "LOSS", hitType: ht, exitPrice: effectiveSL,
          pnlPct: slPnl, holdBars: i - entryIdx, exitIdx: i,
          lastTrailStep: lastStep, stepClosedAt: lastStep,
        };
      }
      if (hitSL) {
        const slPnl = ((effectiveSL - entryPrice) / entryPrice) * 100;
        const ht: HitType = lastStep === 0 ? "ORIG_SL" : "STEP_SL";
        return {
          outcome: slPnl >= 0 ? "WIN" : "LOSS", hitType: ht, exitPrice: effectiveSL,
          pnlPct: slPnl, holdBars: i - entryIdx, exitIdx: i,
          lastTrailStep: lastStep, stepClosedAt: lastStep,
        };
      }
      if (hitTpFixed) {
        return {
          outcome: "WIN", hitType: "TP", exitPrice: tp, pnlPct: targetPct,
          holdBars: i - entryIdx, exitIdx: i, lastTrailStep: 0, stepClosedAt: 0,
        };
      }
      // No exit this bar — bump trail step
      if (trailing && newStepReached > lastStep) {
        lastStep = newStepReached;
      }
    } else {
      // SHORT
      const hitSL = c.high >= effectiveSL;
      const hitTpFixed = !trailing && c.low <= tp;

      let newStepReached = lastStep;
      if (trailing) {
        for (let s = lastStep + 1; s <= STEP_TRAIL_STEPS.length; s++) {
          if (c.low <= stepPrices[s - 1]) newStepReached = s;
          else break;
        }
      }

      if (hitSL && hitTpFixed) {
        const slPnl = ((entryPrice - effectiveSL) / entryPrice) * 100;
        const ht: HitType = lastStep === 0 ? "ORIG_SL" : "STEP_SL";
        return {
          outcome: slPnl >= 0 ? "WIN" : "LOSS", hitType: ht, exitPrice: effectiveSL,
          pnlPct: slPnl, holdBars: i - entryIdx, exitIdx: i,
          lastTrailStep: lastStep, stepClosedAt: lastStep,
        };
      }
      if (hitSL) {
        const slPnl = ((entryPrice - effectiveSL) / entryPrice) * 100;
        const ht: HitType = lastStep === 0 ? "ORIG_SL" : "STEP_SL";
        return {
          outcome: slPnl >= 0 ? "WIN" : "LOSS", hitType: ht, exitPrice: effectiveSL,
          pnlPct: slPnl, holdBars: i - entryIdx, exitIdx: i,
          lastTrailStep: lastStep, stepClosedAt: lastStep,
        };
      }
      if (hitTpFixed) {
        return {
          outcome: "WIN", hitType: "TP", exitPrice: tp, pnlPct: targetPct,
          holdBars: i - entryIdx, exitIdx: i, lastTrailStep: 0, stepClosedAt: 0,
        };
      }
      if (trailing && newStepReached > lastStep) {
        lastStep = newStepReached;
      }
    }
  }
  if (!ltfCandles[maxIdx]) {
    return { outcome: "TIMEOUT", hitType: "TIME", exitPrice: entryPrice, pnlPct: 0, holdBars: 0, exitIdx: entryIdx, lastTrailStep: lastStep, stepClosedAt: 0 };
  }
  const finalPct = side === "LONG"
    ? ((ltfCandles[maxIdx].close - entryPrice) / entryPrice) * 100
    : ((entryPrice - ltfCandles[maxIdx].close) / entryPrice) * 100;
  return {
    outcome: "TIMEOUT", hitType: "TIME", exitPrice: ltfCandles[maxIdx].close, pnlPct: finalPct,
    holdBars: maxIdx - entryIdx, exitIdx: maxIdx, lastTrailStep: lastStep, stepClosedAt: 0,
  };
}

// ─── Rule signal detection ──────────────────────────────────────────────────
interface RawSignal { htfIdx: number; htfTime: number; side: "LONG" | "SHORT"; }

function detectRuleSignals(
  rule: RuleEntry,
  entryCandles: Candle[],
  entrySeries: IndSeries,
  htfBundles: Record<string, HtfBundle>,
  htfNearKey: string,
  htfFarKey: string,
  htfNearTrends: Trend[],
  htfFarTrends: Trend[],
  htfNearRsisAtEntry: (number | null)[],
  htfFarRsisAtEntry: (number | null)[],
): RawSignal[] {
  const cfg = rule.config;
  const forceSide = (cfg.forceSide || (rule as any).forceSide) as "LONG" | "SHORT" | undefined;
  const sidesToCheck: ("LONG" | "SHORT")[] = forceSide ? [forceSide] : ["LONG", "SHORT"];
  const closes = entryCandles.map((c) => c.close);
  const signals: RawSignal[] = [];
  const prevMatched: Record<"LONG" | "SHORT", boolean> = { LONG: false, SHORT: false };

  for (let i = MIN_LOOKBACK; i < entryCandles.length - 1; i++) {
    const rsiV = entrySeries.rsi[i];
    const stochKV = entrySeries.stochK[i];
    const bbU = entrySeries.bbUpper[i];
    const bbL = entrySeries.bbLower[i];
    const macdH = entrySeries.macdHist[i];
    const prevMacdH = entrySeries.macdHist[i - 1];
    const price = closes[i];
    if (rsiV === null || stochKV === null || bbU === null || bbL === null || macdH === null || prevMacdH === null) continue;
    const div = detectDivAt(closes, entrySeries.rsi, i);
    const matchedThisCandle: Record<"LONG" | "SHORT", boolean> = { LONG: false, SHORT: false };

    for (const side of sidesToCheck) {
      const conds: EntryConditions = side === "LONG" ? {
        stochExtreme: stochKV < cfg.stochOSLevel,
        rsiExtreme: rsiV < cfg.rsiOSLevel,
        divergence: div === "BULLISH_DIV",
        bollingerTouch: price <= bbL,
        macdCross: (prevMacdH < 0 && macdH >= 0) || (macdH > prevMacdH),
      } : {
        stochExtreme: stochKV > cfg.stochOBLevel,
        rsiExtreme: rsiV > cfg.rsiOBLevel,
        divergence: div === "BEARISH_DIV",
        bollingerTouch: price >= bbU,
        macdCross: (prevMacdH > 0 && macdH <= 0) || (macdH < prevMacdH),
      };

      const want: Trend = side === "LONG" ? "UP" : "DOWN";
      if ((cfg as any).htfTrendFilter) {
        const f = (cfg as any).htfTrendFilter;
        const mode = f.mode || f;
        if (mode === "near_match" && htfNearTrends[i] !== want) continue;
        if (mode === "far_match" && htfFarTrends[i] !== want) continue;
        if (mode === "both_match" && (htfNearTrends[i] !== want || htfFarTrends[i] !== want)) continue;
      }

      if (cfg.htfRsiFilter) {
        const f = cfg.htfRsiFilter;
        let v: number | null = null;
        if (f.tf === htfNearKey) v = htfNearRsisAtEntry[i];
        else if (f.tf === htfFarKey) v = htfFarRsisAtEntry[i];
        if (v === null || !applyOp(v, f.op, f.value)) continue;
      }

      const cfgX = cfg as any;
      if (cfgX.atrFilter && !evalFeatFilter(entrySeries.atrPct[i], cfgX.atrFilter)) continue;
      if (cfgX.rsiFilter && !evalFeatFilter(rsiV, cfgX.rsiFilter)) continue;
      if (cfgX.emaDistFilter) {
        const ema = entrySeries.ema50[i];
        const dist = ema !== null && ema > 0 ? ((price - ema) / ema) * 100 : null;
        if (!evalFeatFilter(dist, cfgX.emaDistFilter)) continue;
      }
      if (cfgX.bodyPctFilter) {
        const c2 = entryCandles[i];
        const body = c2.open ? Math.abs(c2.close - c2.open) / c2.open * 100 : null;
        if (!evalFeatFilter(body, cfgX.bodyPctFilter)) continue;
      }
      if (cfgX.bbPercentFilter) {
        const u = entrySeries.bbUpper[i], l = entrySeries.bbLower[i];
        const bbP = (u != null && l != null && u !== l) ? (price - l) / (u - l) : null;
        if (!evalFeatFilter(bbP, cfgX.bbPercentFilter)) continue;
      }
      if (cfgX.reversalFilter && i >= 1) {
        const prev = entryCandles[i - 1], curr = entryCandles[i];
        const prevBull = prev.close >= prev.open;
        const currBull = curr.close >= curr.open;
        const rev = prevBull === currBull ? "CONT" : (!prevBull && currBull ? "UP_REV" : "DOWN_REV");
        if (rev !== cfgX.reversalFilter.kind) continue;
      }

      if (cfg.htfFilters?.length) {
        let ok = true;
        for (const f of cfg.htfFilters) {
          if (!evalHtfFilter(f, htfBundles, i, htfNearKey)) { ok = false; break; }
        }
        if (!ok) continue;
      }

      if (cfg.requiredConditions?.length) {
        let ok = true;
        for (const k of cfg.requiredConditions) { if (!conds[k]) { ok = false; break; } }
        if (!ok) continue;
      }

      if (cfg.weights) {
        let s = 0;
        for (const k of Object.keys(cfg.weights) as (keyof EntryConditions)[]) {
          if (conds[k]) s += (cfg.weights[k] || 0);
        }
        if (s < (cfg.minWeightedScore || 1)) continue;
      } else {
        const cnt = Object.values(conds).filter(Boolean).length;
        if (cnt < (cfg.minScore || 1)) continue;
      }

      matchedThisCandle[side] = true;
      if (!prevMatched[side]) {
        signals.push({ htfIdx: i, htfTime: entryCandles[i].time, side });
      }
      break;
    }
    prevMatched.LONG = matchedThisCandle.LONG;
    prevMatched.SHORT = matchedThisCandle.SHORT;
  }
  return signals;
}

// ─── Equity stats ───────────────────────────────────────────────────────────
function computeEquityStats(trades: TradeOutcome[]) {
  if (trades.length === 0) {
    return { curve: [] as number[], trend: "FLAT" as const, maxDD: 0, netPctLev: 0, profitFactor: 0, sharpeLike: 0 };
  }
  const fee = FEE_PER_SIDE;
  const lev = LIVE_STACK_CFG.leverage;
  const perTradeNet = trades.map((t) => t.pnlPct * lev - fee * 2 * lev);
  const cum: number[] = [];
  let running = 0;
  for (const v of perTradeNet) { running += v; cum.push(running); }

  let peak = cum[0], maxDD = 0;
  for (const v of cum) {
    if (v > peak) peak = v;
    const dd = peak - v;
    if (dd > maxDD) maxDD = dd;
  }

  const n = cum.length;
  let trend: "UP" | "FLAT" | "DOWN" = "FLAT";
  if (n >= 6) {
    const splitIdx = Math.floor(n * 0.7);
    const earlySlope = (cum[splitIdx - 1] - cum[0]) / Math.max(1, splitIdx - 1);
    const lateSlope = (cum[n - 1] - cum[splitIdx - 1]) / Math.max(1, n - splitIdx);
    const range = Math.max(1, Math.abs(cum[n - 1]));
    const lateNorm = lateSlope / range * 100;
    if (lateSlope > earlySlope * 0.5 && lateNorm > 0.05) trend = "UP";
    else if (lateSlope < 0 && Math.abs(lateNorm) > 0.05) trend = "DOWN";
    else trend = "FLAT";
  } else {
    trend = cum[n - 1] > 0 ? "UP" : cum[n - 1] < 0 ? "DOWN" : "FLAT";
  }

  const MAX_PTS = 200;
  let curve: number[];
  if (n <= MAX_PTS) {
    curve = cum.map((v) => Math.round(v * 100) / 100);
  } else {
    curve = [];
    for (let i = 0; i < MAX_PTS; i++) {
      const idx = Math.floor((i / (MAX_PTS - 1)) * (n - 1));
      curve.push(Math.round(cum[idx] * 100) / 100);
    }
  }

  const grossWin = trades.filter((t) => t.pnlPct > 0).reduce((s, t) => s + t.pnlPct, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.pnlPct < 0).reduce((s, t) => s + t.pnlPct, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 999 : 0);
  const sharpeLike = maxDD > 0 ? running / Math.sqrt(maxDD) : (running > 0 ? running : 0);

  return {
    curve,
    trend,
    maxDD: Math.round(maxDD * 100) / 100,
    netPctLev: Math.round(running * 100) / 100,
    profitFactor: profitFactor === 999 ? 999 : Math.round(profitFactor * 100) / 100,
    sharpeLike: Math.round(sharpeLike * 100) / 100,
  };
}

// ─── Stack gate ─────────────────────────────────────────────────────────────
interface VirtualPosition {
  side: "LONG" | "SHORT";
  entryPrice: number;
  qty: number;
  entryMs: number;
  exitMs: number;
}

function checkStackGateVirtual(
  positions: VirtualPosition[],
  side: "LONG" | "SHORT",
  entryPrice: number,
  nowMs: number,
): string | null {
  const sameSide = positions.filter((p) => p.side === side);
  if (sameSide.length >= LIVE_STACK_CFG.stackMaxPerSide) return `stack full ${side}`;
  if (LIVE_STACK_CFG.stackMaxNotionalUsd > 0) {
    const currentNotional = sameSide.reduce((sum, p) => sum + p.qty * p.entryPrice, 0);
    const newOrderNotional = LIVE_STACK_CFG.marginUsd * LIVE_STACK_CFG.leverage;
    if (currentNotional + newOrderNotional > LIVE_STACK_CFG.stackMaxNotionalUsd) return `notional cap ${side}`;
  }
  if (sameSide.length > 0) {
    const lastSame = sameSide.reduce((a, b) => (a.entryMs > b.entryMs ? a : b));
    if (LIVE_STACK_CFG.stackPerSideSpacingMin > 0 && nowMs - lastSame.entryMs < LIVE_STACK_CFG.stackPerSideSpacingMin * 60_000) return `spacing ${side}`;
    if (LIVE_STACK_CFG.stackMinEntryDistPct > 0) {
      const distPct = Math.abs(entryPrice - lastSame.entryPrice) / lastSame.entryPrice * 100;
      if (distPct < LIVE_STACK_CFG.stackMinEntryDistPct) return `dist ${side}`;
    }
  }
  return null;
}

// ─── Candidate types ────────────────────────────────────────────────────────
interface Candidate {
  source: string;
  tfKey: string;
  side: "LONG" | "SHORT";
  fireTime: number;
  entryIdx5m: number;
  entryTime: number;
  entryPrice: number;
  tpPct: number;
  slPct: number;
  maxHold5m: number;
  cooldownKey: string;
}

const TF_TO_5M_MULT: Record<string, number> = {
  "5m": 1, "15m": 3, "1h": 12, "4h": 48, "1d": 288, "1w": 2016,
};

function buildRuleCandidates(
  rules: { tf: string; rule: RuleEntry }[],
  candlesByTF: Record<string, Candle[]>,
  seriesByTF: Record<string, IndSeries>,
  bundlesByEntryTF: Record<string, {
    bundles: Record<string, HtfBundle>;
    nearKey: string; farKey: string;
    nearTrends: Trend[]; farTrends: Trend[];
    nearRsis: (number | null)[]; farRsis: (number | null)[];
  }>,
  candles5m: Candle[],
  stoch5mSeries: (number | null)[],
  candles15m: Candle[],
  srSupport15m: (number | null)[],
  srResistance15m: (number | null)[],
): Candidate[] {
  const out: Candidate[] = [];
  for (const { tf, rule } of rules) {
    const ruleId = `${tf}:${rule.rank}`;
    const ctx = bundlesByEntryTF[tf];
    const entryCandles = candlesByTF[tf];
    const entrySeries = seriesByTF[tf];
    const rawSignals = detectRuleSignals(
      rule, entryCandles, entrySeries,
      ctx.bundles, ctx.nearKey, ctx.farKey,
      ctx.nearTrends, ctx.farTrends, ctx.nearRsis, ctx.farRsis,
    );
    const useLtfConfirm = tf === "1h" || tf === "4h" || tf === "1d" || tf === "1w";
    const ruleMaxHoldHtf = (rule.config as any).maxHoldBars || 100;
    const maxHold5m = ruleMaxHoldHtf * (TF_TO_5M_MULT[tf] || 12);

    for (const sig of rawSignals) {
      let ltfIdx: number | null;
      if (useLtfConfirm) {
        const { support, resistance } = srAtTime(candles15m, srSupport15m, srResistance15m, sig.htfTime);
        ltfIdx = findLtfConfirmIndex(
          candles5m, stoch5mSeries, sig.htfTime, sig.side,
          support, resistance, LTF_CFG,
        );
      } else {
        ltfIdx = candles5m.findIndex((c) => c.time >= sig.htfTime);
        if (ltfIdx < 0) ltfIdx = null;
      }
      if (ltfIdx === null) continue;
      out.push({
        source: ruleId,
        tfKey: tf,
        side: sig.side,
        fireTime: sig.htfTime,
        entryIdx5m: ltfIdx,
        entryTime: candles5m[ltfIdx].time,
        entryPrice: candles5m[ltfIdx].close,
        tpPct: rule.config.targetPct,
        slPct: rule.config.stopPct,
        maxHold5m,
        cooldownKey: ruleId,
      });
    }
  }
  return out;
}

// ─── Run mode ───────────────────────────────────────────────────────────────
interface ModeResult {
  modeName: string;
  description: string;
  smartSL: boolean;
  stepTrail: boolean;
  totalCandidates: number;
  blockedByCooldown: number;
  blockedByStack: number;
  blockedByDd: number;
  ddPauseTriggers: number;
  trades: TradeOutcome[];
  metrics: {
    trades: number;
    wins: number;
    losses: number;
    timeouts: number;
    winRate: number;
    netPctLev: number;
    maxDD: number;
    profitFactor: number;
    sharpeLike: number;
    avgHoldBars: number;
    equityCurve: number[];
    equityTrend: "UP" | "FLAT" | "DOWN";
  };
  hitTypeBreakdown: Record<HitType, { count: number; pct: number; netPctLev: number }>;
  // Smart SL telemetry
  smartSLMovedCount: number;
  smartSLMovedPct: number;
  smartSLAvgDistPct: number;
  smartSLByTf: { "1h": number; "1d": number };
  // Step trail telemetry
  stepCloseBuckets: { step: number; pctOfTpDist: number; count: number; avgLockedPct: number }[];
  perSource: Record<string, {
    trades: number;
    wins: number;
    losses: number;
    netPctLev: number;
    pf: number;
  }>;
}

function runModeSimulation(
  modeName: string,
  description: string,
  enableSmartSL: boolean,
  enableStepTrail: boolean,
  candidates: Candidate[],
  candles5m: Candle[],
  candles1h: Candle[],
  candles1d: Candle[],
  sup1h: (number | null)[],
  res1h: (number | null)[],
  sup1d: (number | null)[],
  res1d: (number | null)[],
  ruleCooldownMin: number,
): ModeResult {
  const sorted = [...candidates].sort((a, b) => a.entryTime - b.entryTime);
  const trades: TradeOutcome[] = [];
  const lastEntryByCooldownKey: Record<string, number> = {};
  let positions: VirtualPosition[] = [];
  let blockedByCooldown = 0;
  let blockedByStack = 0;

  const startCapital = LIVE_STACK_CFG.marginUsd * 100;
  let cumPnlUsd = 0;
  let peakEquity = startCapital;
  let ddPausedUntilMs = 0;
  let ddPauseTriggers = 0;
  let blockedByDd = 0;

  for (const c of sorted) {
    const nowMs = c.entryTime;
    if (LIVE_STACK_CFG.equityDdPausePct > 0 && nowMs < ddPausedUntilMs) {
      blockedByDd++; continue;
    }
    positions = positions.filter((p) => p.exitMs > nowMs);
    const last = lastEntryByCooldownKey[c.cooldownKey];
    if (last && nowMs - last < ruleCooldownMin * 60_000) {
      blockedByCooldown++; continue;
    }
    const block = checkStackGateVirtual(positions, c.side, c.entryPrice, nowMs);
    if (block) { blockedByStack++; continue; }

    // Compute original SL price
    const origSLPrice = c.side === "LONG"
      ? c.entryPrice * (1 - c.slPct / 100)
      : c.entryPrice * (1 + c.slPct / 100);

    // Smart SL adjustment
    let effectiveSLPrice = origSLPrice;
    let smartSLMoved = false;
    let smartSLDistMovedPct = 0;
    let smartSLTf: "1h" | "1d" | null = null;
    if (enableSmartSL) {
      const sr1h = srAtTime(candles1h, sup1h, res1h, c.entryTime);
      const sr1d = srAtTime(candles1d, sup1d, res1d, c.entryTime);
      const adj = applySmartSL(c.side, origSLPrice, sr1h.support, sr1h.resistance, sr1d.support, sr1d.resistance);
      effectiveSLPrice = adj.newSL;
      smartSLMoved = adj.moved;
      smartSLDistMovedPct = adj.distMovedPct;
      smartSLTf = adj.tf;
    }

    // Step trail enabled only on 15m TF
    const useStepTrail = enableStepTrail && STEP_TRAIL_TFS.has(c.tfKey);

    const sim = simulateTradeStepTrail(
      candles5m, c.entryIdx5m, c.side, c.entryPrice,
      c.tpPct, effectiveSLPrice, c.maxHold5m, useStepTrail,
    );
    const exitIdx5m = Math.min(c.entryIdx5m + sim.holdBars, candles5m.length - 1);
    const exitMs = candles5m[exitIdx5m].time;
    const qty = (LIVE_STACK_CFG.marginUsd * LIVE_STACK_CFG.leverage) / c.entryPrice;
    positions.push({ side: c.side, entryPrice: c.entryPrice, qty, entryMs: nowMs, exitMs });
    lastEntryByCooldownKey[c.cooldownKey] = nowMs;

    trades.push({
      source: c.source, tfKey: c.tfKey, side: c.side, fireTime: c.fireTime,
      entryIdx5m: c.entryIdx5m, entryTime: c.entryTime, entryPrice: c.entryPrice,
      outcome: sim.outcome, hitType: sim.hitType, exitPrice: sim.exitPrice,
      pnlPct: sim.pnlPct, holdBars: sim.holdBars, exitTime: exitMs,
      smartSLMoved, smartSLDistMovedPct, smartSLTf,
      lastTrailStep: sim.lastTrailStep, stepClosedAt: sim.stepClosedAt,
    });

    const pnlUsd = sim.pnlPct * LIVE_STACK_CFG.leverage * LIVE_STACK_CFG.marginUsd
                 - 2 * FEE_PER_SIDE * LIVE_STACK_CFG.leverage * LIVE_STACK_CFG.marginUsd / 100;
    cumPnlUsd += pnlUsd;
    const equity = startCapital + cumPnlUsd;
    peakEquity = Math.max(peakEquity, equity);
    if (LIVE_STACK_CFG.equityDdPausePct > 0 && peakEquity > 0) {
      const ddPct = ((peakEquity - equity) / peakEquity) * 100;
      if (ddPct >= LIVE_STACK_CFG.equityDdPausePct && ddPausedUntilMs < exitMs) {
        ddPausedUntilMs = exitMs + LIVE_STACK_CFG.equityDdPauseHours * 3600_000;
        ddPauseTriggers++;
      }
    }
  }

  const eq = computeEquityStats(trades);
  const wins = trades.filter((t) => t.outcome === "WIN").length;
  const losses = trades.filter((t) => t.outcome === "LOSS").length;
  const timeouts = trades.filter((t) => t.outcome === "TIMEOUT").length;
  const winRate = trades.length ? (wins / trades.length) * 100 : 0;
  const avgHoldBars = trades.length ? trades.reduce((s, t) => s + t.holdBars, 0) / trades.length : 0;

  const hitTypes: HitType[] = ["TP", "ORIG_SL", "STEP_SL", "TIME"];
  const hitTypeBreakdown: Record<HitType, { count: number; pct: number; netPctLev: number }> = {
    TP: { count: 0, pct: 0, netPctLev: 0 },
    ORIG_SL: { count: 0, pct: 0, netPctLev: 0 },
    STEP_SL: { count: 0, pct: 0, netPctLev: 0 },
    TIME: { count: 0, pct: 0, netPctLev: 0 },
  };
  for (const ht of hitTypes) {
    const sub = trades.filter((t) => t.hitType === ht);
    const eqSub = computeEquityStats(sub);
    hitTypeBreakdown[ht] = {
      count: sub.length,
      pct: trades.length ? Math.round((sub.length / trades.length) * 10000) / 100 : 0,
      netPctLev: eqSub.netPctLev,
    };
  }

  // Smart SL telemetry
  const movedTrades = trades.filter((t) => t.smartSLMoved);
  const smartSLMovedCount = movedTrades.length;
  const smartSLMovedPct = trades.length ? Math.round((smartSLMovedCount / trades.length) * 10000) / 100 : 0;
  const smartSLAvgDistPct = movedTrades.length
    ? Math.round((movedTrades.reduce((s, t) => s + t.smartSLDistMovedPct, 0) / movedTrades.length) * 1000) / 1000
    : 0;
  const smartSLByTf = {
    "1h": movedTrades.filter((t) => t.smartSLTf === "1h").length,
    "1d": movedTrades.filter((t) => t.smartSLTf === "1d").length,
  };

  // Step trail telemetry — per step bucket
  // Steps 1..10 → STEP_TRAIL_STEPS[0..9]
  // Trades closed by STEP_SL grouped by stepClosedAt
  const stepCloseBuckets: { step: number; pctOfTpDist: number; count: number; avgLockedPct: number }[] = [];
  for (let s = 1; s <= STEP_TRAIL_STEPS.length; s++) {
    const closed = trades.filter((t) => t.hitType === "STEP_SL" && t.stepClosedAt === s);
    const avgLocked = closed.length ? closed.reduce((sum, t) => sum + t.pnlPct, 0) / closed.length : 0;
    stepCloseBuckets.push({
      step: s,
      pctOfTpDist: STEP_TRAIL_STEPS[s - 1] * 100,
      count: closed.length,
      avgLockedPct: Math.round(avgLocked * 1000) / 1000,
    });
  }

  // Per-source breakdown
  const perSourceBuckets: Record<string, TradeOutcome[]> = {};
  for (const t of trades) {
    let bucket: string;
    if (t.tfKey === "5m" || t.tfKey === "15m") bucket = `LTF rules (${t.tfKey})`;
    else bucket = `HTF rules (${t.tfKey})`;
    if (!perSourceBuckets[bucket]) perSourceBuckets[bucket] = [];
    perSourceBuckets[bucket].push(t);
  }
  const perSource: ModeResult["perSource"] = {};
  for (const [bucket, ts] of Object.entries(perSourceBuckets)) {
    const w = ts.filter((t) => t.outcome === "WIN").length;
    const l = ts.filter((t) => t.outcome === "LOSS").length;
    const eqB = computeEquityStats(ts);
    perSource[bucket] = { trades: ts.length, wins: w, losses: l, netPctLev: eqB.netPctLev, pf: eqB.profitFactor };
  }

  return {
    modeName, description, smartSL: enableSmartSL, stepTrail: enableStepTrail,
    totalCandidates: sorted.length,
    blockedByCooldown, blockedByStack, blockedByDd, ddPauseTriggers,
    trades,
    metrics: {
      trades: trades.length, wins, losses, timeouts,
      winRate: Math.round(winRate * 100) / 100,
      netPctLev: eq.netPctLev, maxDD: eq.maxDD,
      profitFactor: eq.profitFactor, sharpeLike: eq.sharpeLike,
      avgHoldBars: Math.round(avgHoldBars * 10) / 10,
      equityCurve: eq.curve, equityTrend: eq.trend,
    },
    hitTypeBreakdown,
    smartSLMovedCount, smartSLMovedPct, smartSLAvgDistPct, smartSLByTf,
    stepCloseBuckets,
    perSource,
  };
}

// ─── HTML report ────────────────────────────────────────────────────────────
function bigEquityOverlaySvg(modes: ModeResult[], width = 900, height = 280): string {
  const palette: Record<string, string> = {
    "Mode E0": "#a855f7",
    "Mode E-S": "#3b82f6",
    "Mode E-T15": "#10b981",
    "Mode E-ST": "#f7931a",
  };
  const allVals: number[] = [];
  for (const m of modes) for (const v of m.metrics.equityCurve) allVals.push(v);
  if (allVals.length === 0) return `<svg width="${width}" height="${height}"></svg>`;
  const min = Math.min(...allVals, 0);
  const max = Math.max(...allVals, 0);
  const range = max - min || 1;

  const lines = modes.map((m) => {
    const curve = m.metrics.equityCurve;
    if (curve.length < 2) return "";
    const color = palette[m.modeName] || "#999";
    const pts = curve.map((v, i) => {
      const x = (i / (curve.length - 1)) * width;
      const y = height - ((v - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
    return `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.8"/>`;
  }).join("\n");

  const zeroY = height - ((0 - min) / range) * height;
  const legend = modes.map((m, idx) => {
    const color = palette[m.modeName] || "#999";
    const x = 12 + idx * 220;
    return `<rect x="${x}" y="6" width="14" height="3" fill="${color}"/>
            <text x="${x + 20}" y="13" fill="#cfc6bc" font-size="11">${m.modeName}: ${m.metrics.netPctLev >= 0 ? "+" : ""}${m.metrics.netPctLev.toFixed(0)}% · DD -${m.metrics.maxDD.toFixed(0)}%</text>`;
  }).join("\n");

  return `<svg width="${width}" height="${height}" style="background:#0d0d0d;border:1px solid #2a2a2a;border-radius:6px">
    <line x1="0" y1="${zeroY.toFixed(1)}" x2="${width}" y2="${zeroY.toFixed(1)}" stroke="#444" stroke-dasharray="3,3" stroke-width="0.7"/>
    ${lines}
    ${legend}
    <text x="${width - 8}" y="14" text-anchor="end" fill="#9f8e80" font-size="10">max ${max.toFixed(0)}%</text>
    <text x="${width - 8}" y="${height - 4}" text-anchor="end" fill="#9f8e80" font-size="10">min ${min.toFixed(0)}%</text>
  </svg>`;
}

function renderHtml(modes: ModeResult[], periods: Record<string, { from: string; to: string; n: number }>) {
  const periodInfo = Object.entries(periods).map(([tf, p]) =>
    `<span><b>${tf}</b>: ${p.n.toLocaleString()} · ${p.from} → ${p.to}</span>`
  ).join(" · ");

  const overlay = bigEquityOverlaySvg(modes, 900, 280);
  const e0 = modes[0];

  const fmtPctI = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(0)}%`;
  const fmtN = (v: number) => v.toLocaleString();
  const fmtF = (v: number) => v === 999 ? "∞" : v.toFixed(2);

  // 4-mode side-by-side table
  const headers = ["Metric", ...modes.map((m) => m.modeName)].map((h) => `<th>${h}</th>`).join("");
  const row = (label: string, vals: any[], fmt: (v: any) => string, deltaColor?: (d: number) => string) => {
    const cells = vals.map((v, i) => {
      if (i === 0) return `<td>${fmt(v)}</td>`;
      const base = vals[0];
      const isNum = typeof v === "number" && typeof base === "number";
      const d = isNum ? v - base : 0;
      const color = deltaColor && isNum ? deltaColor(d) : (isNum ? (d >= 0 ? "#10b981" : "#ffb4ab") : "#cfc6bc");
      const dStr = isNum ? ` <span style="color:${color};font-size:10px">(${d >= 0 ? "+" : ""}${fmt(d).replace("+", "")})</span>` : "";
      return `<td>${fmt(v)}${dStr}</td>`;
    }).join("");
    return `<tr><td><b>${label}</b></td>${cells}</tr>`;
  };

  const renderHitTable = (m: ModeResult) => `
    <table>
      <thead><tr><th>Hit Type</th><th>Count</th><th>%</th><th>NET %lev</th></tr></thead>
      <tbody>
        ${(["TP", "ORIG_SL", "STEP_SL", "TIME"] as HitType[]).map((ht) => {
          const h = m.hitTypeBreakdown[ht];
          return `<tr><td>${ht}</td><td>${h.count.toLocaleString()}</td><td>${h.pct.toFixed(1)}%</td><td style="color:${h.netPctLev > 0 ? "#10b981" : h.netPctLev < 0 ? "#ffb4ab" : "#cfc6bc"}">${h.netPctLev >= 0 ? "+" : ""}${h.netPctLev.toFixed(0)}%</td></tr>`;
        }).join("")}
      </tbody>
    </table>`;

  const renderStepTable = (m: ModeResult) => `
    <table>
      <thead><tr><th>Step</th><th>% TP dist</th><th>Closed</th><th>Avg Locked %</th></tr></thead>
      <tbody>
        ${m.stepCloseBuckets.map((b) => `
          <tr><td>${b.step}</td><td>${b.pctOfTpDist.toFixed(0)}%</td>
              <td>${b.count.toLocaleString()}</td>
              <td style="color:${b.avgLockedPct > 0 ? "#10b981" : b.avgLockedPct < 0 ? "#ffb4ab" : "#cfc6bc"}">${b.avgLockedPct >= 0 ? "+" : ""}${b.avgLockedPct.toFixed(2)}%</td></tr>
        `).join("")}
      </tbody>
    </table>`;

  return `<!DOCTYPE html>
<html lang="vi"><head><meta charset="UTF-8"/>
<title>Smart SL + Step Trail · 3y Backtest · BTC/USDT</title>
<style>
  body { background:#131313; color:#e5e2e1; font-family:'JetBrains Mono','Menlo',monospace; font-size:12px; padding:18px; }
  h1 { color:#F7931A; font-size:18px; letter-spacing:1px; margin:0 0 6px 0; }
  h2 { color:#ffdcc0; font-size:14px; letter-spacing:1px; margin:0 0 10px 0; }
  .info { color:#9f8e80; font-size:11px; margin:6px 0 14px 0; line-height:1.7; }
  .card { background:#1a1a1a; border:1px solid #2a2a2a; padding:14px 16px; border-radius:6px; margin-bottom:14px; }
  table { border-collapse:collapse; width:100%; font-size:11px; margin-top:8px; }
  th, td { border:1px solid #2a2a2a; padding:5px 8px; text-align:left; }
  th { background:#1c1b1b; color:#F7931A; font-size:10px; letter-spacing:1px; text-transform:uppercase; }
  .two-col { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
  .four-col { display:grid; grid-template-columns:1fr 1fr 1fr 1fr; gap:14px; }
</style>
</head>
<body>
<h1>📈 SMART SL + STEP TRAIL · 3-YEAR BACKTEST · BTC/USDT</h1>
<div class="info">${periodInfo}<br>
Generated: ${new Date().toISOString()} · Fee/side: ${FEE_PER_SIDE}% · Margin $${LIVE_STACK_CFG.marginUsd} × ${LIVE_STACK_CFG.leverage}x = $${LIVE_STACK_CFG.marginUsd * LIVE_STACK_CFG.leverage}/lệnh<br>
LIVE PRESET B stack: ${LIVE_STACK_CFG.stackMaxPerSide}/side · cooldown ${LIVE_STACK_CFG.perRuleCooldownMin}m · DD pause ${LIVE_STACK_CFG.equityDdPausePct}%/${LIVE_STACK_CFG.equityDdPauseHours}h<br>
<b>Smart SL:</b> 30-bar pivot 1h+1d S/R · proximity ≤${SMART_SL_PROXIMITY_PCT}% → push past by ${SMART_SL_BUFFER_PCT}% buffer · <b>applies ALL TFs</b><br>
<b>Step trail:</b> 15m TF ONLY · steps ${STEP_TRAIL_STEPS.map(s => `${s * 100}%`).join(", ")} of TP distance · HTF (1h/4h/1d/1w) keep fixed TP/SL.
</div>

<div class="card">
  <h2>📊 EQUITY OVERLAY · 4 modes</h2>
  ${overlay}
</div>

<div class="card">
  <h2>🥊 SIDE-BY-SIDE METRICS (vs E0 baseline)</h2>
  <table>
    <thead><tr>${headers}</tr></thead>
    <tbody>
      ${row("Trades", modes.map((m) => m.metrics.trades), fmtN)}
      ${row("Win Rate", modes.map((m) => m.metrics.winRate), (v) => `${v.toFixed(2)}%`)}
      ${row("NET %lev", modes.map((m) => m.metrics.netPctLev), fmtPctI)}
      ${row("Max DD", modes.map((m) => m.metrics.maxDD), fmtPctI, (d) => d <= 0 ? "#10b981" : "#ffb4ab")}
      ${row("PF", modes.map((m) => m.metrics.profitFactor), fmtF)}
      ${row("Sharpe", modes.map((m) => m.metrics.sharpeLike), (v) => v.toFixed(2))}
      ${row("Avg Hold (5m)", modes.map((m) => m.metrics.avgHoldBars), (v) => v.toFixed(1))}
    </tbody>
  </table>
</div>

<div class="card">
  <h2>🎯 SMART SL IMPACT (per mode)</h2>
  <table>
    <thead><tr><th>Mode</th><th>SL Moved</th><th>%</th><th>Avg dist moved</th><th>By 1h</th><th>By 1d</th></tr></thead>
    <tbody>
      ${modes.map((m) => `<tr>
        <td>${m.modeName}</td>
        <td>${m.smartSLMovedCount.toLocaleString()}</td>
        <td>${m.smartSLMovedPct.toFixed(2)}%</td>
        <td>${m.smartSLAvgDistPct.toFixed(3)}%</td>
        <td>${m.smartSLByTf["1h"].toLocaleString()}</td>
        <td>${m.smartSLByTf["1d"].toLocaleString()}</td>
      </tr>`).join("")}
    </tbody>
  </table>
</div>

<div class="card">
  <h2>📊 HIT-TYPE BREAKDOWN (4 modes)</h2>
  <div class="four-col">
    ${modes.map((m) => `<div><h3 style="font-size:12px;margin:0 0 4px 0;color:#ffdcc0">${m.modeName}</h3>${renderHitTable(m)}</div>`).join("")}
  </div>
</div>

<div class="card">
  <h2>🪜 STEP TRAIL CLOSE DISTRIBUTION (15m only)</h2>
  <div class="two-col">
    ${modes.filter((m) => m.stepTrail).map((m) => `<div><h3 style="font-size:12px;margin:0 0 4px 0;color:#ffdcc0">${m.modeName}</h3>${renderStepTable(m)}</div>`).join("")}
  </div>
</div>

</body></html>`;
}

// ─── Main ───────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n=== SMART SL + STEP TRAIL BACKTEST 3Y · BTC/USDT ===`);
  console.log(`Smart SL: pivot ${SMART_SL_PIVOT_LB}-bar 1h+1d S/R, proximity ${SMART_SL_PROXIMITY_PCT}%, buffer ${SMART_SL_BUFFER_PCT}%`);
  console.log(`Step trail: 15m TF only, steps ${STEP_TRAIL_STEPS.map(s => s * 100 + "%").join(", ")}\n`);

  const hard = JSON.parse(readFileSync(join(__dirname, "..", "assets", "hard_rules.json"), "utf8"));

  const tfsToFetch = Array.from(ALL_TFS);
  console.log(`Loading cached ${YEARS}y candles: ${tfsToFetch.join(", ")}`);
  const candlesByTF: Record<string, Candle[]> = {};
  for (const tf of tfsToFetch) {
    candlesByTF[tf] = loadCachedKlines(tf);
    console.log(`  ${tf}: ${candlesByTF[tf].length.toLocaleString()} candles`);
  }

  console.log(`\nPrecomputing indicator series...`);
  const seriesByTF: Record<string, IndSeries> = {};
  for (const tf of tfsToFetch) {
    const t0 = Date.now();
    seriesByTF[tf] = precomputeSeries(candlesByTF[tf]);
    console.log(`  ${tf}: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  console.log(`\nPrecomputing S/R 15m (lookback ${SR_LOOKBACK_15M})...`);
  const candles15m = candlesByTF["15m"];
  const { sup: srSupport15m, res: srResistance15m } = precomputeSR(candles15m, SR_LOOKBACK_15M);

  console.log(`Precomputing S/R 1h (lookback ${SMART_SL_PIVOT_LB})...`);
  const candles1h = candlesByTF["1h"];
  const { sup: srSupport1h, res: srResistance1h } = precomputeSR(candles1h, SMART_SL_PIVOT_LB);

  console.log(`Precomputing S/R 1d (lookback ${SMART_SL_PIVOT_LB})...`);
  const candles1d = candlesByTF["1d"];
  const { sup: srSupport1d, res: srResistance1d } = precomputeSR(candles1d, SMART_SL_PIVOT_LB);

  const candles5m = candlesByTF["5m"];
  const stoch5mSeries = seriesByTF["5m"].stochK;

  const periods: Record<string, { from: string; to: string; n: number }> = {};
  for (const tf of tfsToFetch) {
    const c = candlesByTF[tf];
    periods[tf] = {
      from: new Date(c[0].time).toISOString().slice(0, 10),
      to: new Date(c[c.length - 1].time).toISOString().slice(0, 10),
      n: c.length,
    };
  }

  // HTF bundles per entry TF
  const bundlesByEntryTF: Record<string, {
    bundles: Record<string, HtfBundle>;
    nearKey: string; farKey: string;
    nearTrends: Trend[]; farTrends: Trend[];
    nearRsis: (number | null)[]; farRsis: (number | null)[];
  }> = {};
  for (const tf of ENTRY_TFS_FULL) {
    const [nearKey, farKey] = HTF_MAP[tf];
    const entry = candlesByTF[tf];
    const nearC = candlesByTF[nearKey], nearS = seriesByTF[nearKey];
    const farC = candlesByTF[farKey], farS = seriesByTF[farKey];
    const nearAlign = buildHTFAlignment(entry, nearC);
    const farAlign = buildHTFAlignment(entry, farC);
    const nearTrends = buildHTFTrendArray(entry, nearC, nearS.ema50);
    const farTrends = buildHTFTrendArray(entry, farC, farS.ema50);
    const nearRsis = buildHTFRsiAtEntry(nearAlign, nearS.rsi);
    const farRsis = buildHTFRsiAtEntry(farAlign, farS.rsi);
    bundlesByEntryTF[tf] = {
      bundles: {
        [nearKey]: { series: nearS, alignment: nearAlign, trends: nearTrends },
        [farKey]: { series: farS, alignment: farAlign, trends: farTrends },
      },
      nearKey, farKey, nearTrends, farTrends, nearRsis, farRsis,
    };
  }

  const collectActiveRules = (tfs: string[]) => {
    const out: { tf: string; rule: RuleEntry }[] = [];
    for (const tf of tfs) {
      if (!hard.tfs[tf]?.rules) continue;
      for (const r of hard.tfs[tf].rules) {
        const cfg = r.config as any;
        if (cfg.disabled === true || cfg.delegatedTo) continue;
        if ((r as any).stats?.disabledAt) continue;
        out.push({ tf, rule: r as RuleEntry });
      }
    }
    return out;
  };

  const fullTfRules = collectActiveRules(ENTRY_TFS_FULL);
  const fullTfNoBaselineRules = fullTfRules.filter(
    ({ tf, rule }) => !EXCLUDE_5M_BASELINE_IDS.has(`${tf}:${rule.rank}`),
  );
  console.log(`\nRules loaded: full TF ${fullTfRules.length} → Mode E pool ${fullTfNoBaselineRules.length} (excluded 5m:1)`);

  console.log(`\nBuilding Mode E candidates...`);
  const t1 = Date.now();
  const candidates = buildRuleCandidates(
    fullTfNoBaselineRules, candlesByTF, seriesByTF, bundlesByEntryTF,
    candles5m, stoch5mSeries, candles15m, srSupport15m, srResistance15m,
  );
  console.log(`  candidates: ${candidates.length.toLocaleString()} (${((Date.now() - t1) / 1000).toFixed(1)}s)`);

  // Run 4 modes
  const runDefs: { name: string; desc: string; smartSL: boolean; step: boolean }[] = [
    { name: "Mode E0",    desc: "Baseline · Mode E (no smart SL, no trailing)", smartSL: false, step: false },
    { name: "Mode E-S",   desc: "Mode E + Smart SL only (no trailing)",         smartSL: true,  step: false },
    { name: "Mode E-T15", desc: "Mode E + Step trail 15m only (no smart SL)",   smartSL: false, step: true  },
    { name: "Mode E-ST",  desc: "Mode E + Smart SL + Step trail 15m",           smartSL: true,  step: true  },
  ];
  const results: ModeResult[] = [];
  for (const def of runDefs) {
    console.log(`\n[${def.name}] ${def.desc}...`);
    const t = Date.now();
    const res = runModeSimulation(
      def.name, def.desc, def.smartSL, def.step, candidates,
      candles5m, candles1h, candles1d,
      srSupport1h, srResistance1h, srSupport1d, srResistance1d,
      LIVE_STACK_CFG.perRuleCooldownMin,
    );
    results.push(res);
    const m = res.metrics;
    console.log(`  ${m.trades} trades · NET ${m.netPctLev}% · DD -${m.maxDD}% · PF ${m.profitFactor === 999 ? "∞" : m.profitFactor} · WR ${m.winRate}% · Sharpe ${m.sharpeLike}  (${((Date.now() - t) / 1000).toFixed(1)}s)`);
    if (def.smartSL) {
      console.log(`  Smart SL moved on ${res.smartSLMovedCount} trades (${res.smartSLMovedPct.toFixed(2)}%) · avg dist ${res.smartSLAvgDistPct.toFixed(3)}% · by tf 1h=${res.smartSLByTf["1h"]} 1d=${res.smartSLByTf["1d"]}`);
    }
    if (def.step) {
      const stepTotal = res.stepCloseBuckets.reduce((s, b) => s + b.count, 0);
      console.log(`  Step trail closed ${stepTotal} trades (15m TF only):`);
      for (const b of res.stepCloseBuckets) {
        if (b.count === 0) continue;
        console.log(`    Step ${b.step} (${b.pctOfTpDist.toFixed(0)}% TP): ${b.count} closes · avg locked ${b.avgLockedPct >= 0 ? "+" : ""}${b.avgLockedPct.toFixed(2)}%`);
      }
    }
  }

  function strip(m: ModeResult) {
    return {
      modeName: m.modeName,
      description: m.description,
      smartSL: m.smartSL,
      stepTrail: m.stepTrail,
      totalCandidates: m.totalCandidates,
      blockedByCooldown: m.blockedByCooldown,
      blockedByStack: m.blockedByStack,
      blockedByDd: m.blockedByDd,
      ddPauseTriggers: m.ddPauseTriggers,
      metrics: m.metrics,
      hitTypeBreakdown: m.hitTypeBreakdown,
      smartSLMovedCount: m.smartSLMovedCount,
      smartSLMovedPct: m.smartSLMovedPct,
      smartSLAvgDistPct: m.smartSLAvgDistPct,
      smartSLByTf: m.smartSLByTf,
      stepCloseBuckets: m.stepCloseBuckets,
      perSource: m.perSource,
    };
  }

  const e0 = results[0];
  const out = {
    generatedAt: Date.now(),
    config: {
      years: YEARS,
      fee: FEE_PER_SIDE,
      ltfConfirm: LTF_CFG,
      liveStack: LIVE_STACK_CFG,
      smartSL: {
        pivotLookback: SMART_SL_PIVOT_LB,
        proximityPct: SMART_SL_PROXIMITY_PCT,
        bufferPct: SMART_SL_BUFFER_PCT,
        appliesTo: "ALL_TFS",
      },
      stepTrail: {
        steps: STEP_TRAIL_STEPS,
        appliesTo: [...STEP_TRAIL_TFS],
      },
      entryTfsFull: ENTRY_TFS_FULL,
      excludeFor5mBaseline: [...EXCLUDE_5M_BASELINE_IDS],
    },
    periods,
    activeRuleCounts: {
      fullTf: fullTfRules.length,
      modeEPool: fullTfNoBaselineRules.length,
    },
    modes: results.map(strip),
    deltasVsE0: results.map((m) => ({
      modeName: m.modeName,
      deltaNetPctLev: Math.round((m.metrics.netPctLev - e0.metrics.netPctLev) * 100) / 100,
      deltaMaxDD: Math.round((m.metrics.maxDD - e0.metrics.maxDD) * 100) / 100,
      deltaWinRate: Math.round((m.metrics.winRate - e0.metrics.winRate) * 100) / 100,
      deltaProfitFactor: Math.round((m.metrics.profitFactor - e0.metrics.profitFactor) * 100) / 100,
      deltaSharpe: Math.round((m.metrics.sharpeLike - e0.metrics.sharpeLike) * 100) / 100,
      deltaTrades: m.metrics.trades - e0.metrics.trades,
    })),
  };

  const assetsDir = join(__dirname, "..", "assets");
  if (!existsSync(assetsDir)) mkdirSync(assetsDir, { recursive: true });
  const jsonPath = join(assetsDir, "backtest_smart_sl_step_3y.json");
  writeFileSync(jsonPath, JSON.stringify(out, null, 2));
  console.log(`\n💾 JSON: ${jsonPath}`);

  const htmlPath = join(assetsDir, "backtest_smart_sl_step_3y.html");
  writeFileSync(htmlPath, renderHtml(results, periods));
  console.log(`💾 HTML: ${htmlPath}`);

  // Final summary
  console.log(`\n=== Summary ===`);
  for (const m of results) {
    console.log(`${m.modeName.padEnd(11)}: NET ${m.metrics.netPctLev}%, DD -${m.metrics.maxDD}%, ${m.metrics.trades} trades, WR ${m.metrics.winRate}%, PF ${m.metrics.profitFactor === 999 ? "∞" : m.metrics.profitFactor}, Sharpe ${m.metrics.sharpeLike}`);
  }
  console.log(`\n=== Δ vs E0 ===`);
  for (const d of out.deltasVsE0) {
    if (d.modeName === "Mode E0") continue;
    console.log(`${d.modeName.padEnd(11)}: ΔNET ${d.deltaNetPctLev >= 0 ? "+" : ""}${d.deltaNetPctLev}% · ΔDD ${d.deltaMaxDD >= 0 ? "+" : ""}${d.deltaMaxDD}% · ΔWR ${d.deltaWinRate >= 0 ? "+" : ""}${d.deltaWinRate}pp · ΔPF ${d.deltaProfitFactor >= 0 ? "+" : ""}${d.deltaProfitFactor} · ΔSharpe ${d.deltaSharpe >= 0 ? "+" : ""}${d.deltaSharpe} · ΔTrades ${d.deltaTrades >= 0 ? "+" : ""}${d.deltaTrades}`);
  }

  // Best by metric
  const bestNet = [...results].sort((a, b) => b.metrics.netPctLev - a.metrics.netPctLev)[0];
  const bestSharpe = [...results].sort((a, b) => b.metrics.sharpeLike - a.metrics.sharpeLike)[0];
  const bestDD = [...results].sort((a, b) => a.metrics.maxDD - b.metrics.maxDD)[0];
  console.log(`\nBest by NET    : ${bestNet.modeName} (+${bestNet.metrics.netPctLev}%)`);
  console.log(`Best by Sharpe : ${bestSharpe.modeName} (${bestSharpe.metrics.sharpeLike})`);
  console.log(`Best by MaxDD  : ${bestDD.modeName} (-${bestDD.metrics.maxDD}%)`);
})();
