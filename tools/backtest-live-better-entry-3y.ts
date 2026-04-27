/**
 * backtest-live-better-entry-3y.ts
 *
 * 4-mode 3-year LIVE engine backtest comparing `stackBetterEntryMode` variants
 * on top of the **production Mode E config** (Full TF rules EXCLUDING 5m:1,
 * 5m ALL Engine OFF, Phase 2 LTF confirm for HTF, PA A2 skip for LTF, LIVE
 * PRESET B stack 50/side · dist 0% · spacing 0, marginUsd $1 × 100x, equity DD
 * pause 30%/4h, per-rule cooldown 10m).
 *
 *   • Mode E1 — baseline · stackBetterEntryMode = "off"
 *   • Mode E2 — stackBetterEntryMode = "vs-last"
 *   • Mode E3 — stackBetterEntryMode = "vs-best"
 *   • Mode E4 — stackBetterEntryMode = "vs-avg" (current production default)
 *
 * Better-entry gate is enforced inside the SMART STACK virtual gate. After
 * spacing + dist filters pass, the gate computes a benchmark price from the
 * existing same-side virtual positions and rejects the new entry if it does
 * NOT improve vs the benchmark:
 *   - LONG  → require new entry < benchmark
 *   - SHORT → require new entry > benchmark
 *   - benchmark per mode:
 *       * vs-last → most recent same-side entry price
 *       * vs-best → min(entries) for LONG · max(entries) for SHORT
 *       * vs-avg  → count-weighted mean of same-side entry prices
 *   - "off" → bypass entirely
 *
 * Output:
 *   - assets/backtest_live_better_entry_3y.json
 *   - assets/backtest_live_better_entry_3y_report.html
 *
 * Usage:
 *   npx tsx tools/backtest-live-better-entry-3y.ts
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
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

// LIVE PRESET B (DEFAULT_SETTINGS in utils/liveTraderEngine.ts)
const LIVE_STACK_CFG = {
  stackMaxPerSide: 50,
  stackPerSideSpacingMin: 0,
  stackMinEntryDistPct: 0,
  stackMaxNotionalUsd: 200_000,
  perRuleCooldownMin: 10,
  marginUsd: 1,
  leverage: 100, // $100 notional / entry
  equityDdPausePct: 30,
  equityDdPauseHours: 4,
};

type BetterEntryMode = "off" | "vs-last" | "vs-best" | "vs-avg";

const MODES: { key: string; label: string; mode: BetterEntryMode }[] = [
  { key: "E1", label: "Mode E1 (baseline · off)", mode: "off" },
  { key: "E2", label: "Mode E2 (vs-last)", mode: "vs-last" },
  { key: "E3", label: "Mode E3 (vs-best)", mode: "vs-best" },
  { key: "E4", label: "Mode E4 (vs-avg · current prod)", mode: "vs-avg" },
];

const LTF_CFG: LtfConfirmConfig = {
  ...DEFAULT_LTF_CONFIRM,
  stochOSLevel: 20,
  stochObLevel: 80,
  srProximityPct: 0.4,
  maxWaitBars: CONFIRM_WINDOW,
};

const ENTRY_TFS_FULL = ["5m", "15m", "1h", "4h", "1d", "1w"];
// 5m baseline rule(s) to exclude (5m:1 — production). Mode E config.
const EXCLUDE_5M_BASELINE_IDS = new Set<string>(["5m:1"]);

const HTF_MAP: Record<string, [string, string]> = {
  "5m": ["15m", "1h"],
  "15m": ["1h", "4h"],
  "1h": ["4h", "1d"],
  "4h": ["1d", "1w"],
  "1d": ["1w", "1w"],
  "1w": ["1w", "1w"],
};

const ALL_TFS = new Set<string>(["5m", "15m"]);
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
function precomputeSR15m(candles15m: Candle[], lookback: number) {
  const n = candles15m.length;
  const sup: (number | null)[] = new Array(n).fill(null);
  const res: (number | null)[] = new Array(n).fill(null);
  for (let i = lookback; i < n; i++) {
    let lo = Infinity, hi = -Infinity;
    for (let j = i - lookback; j < i; j++) {
      if (candles15m[j].low < lo) lo = candles15m[j].low;
      if (candles15m[j].high > hi) hi = candles15m[j].high;
    }
    sup[i] = lo === Infinity ? null : lo;
    res[i] = hi === -Infinity ? null : hi;
  }
  return { sup, res };
}

function srAtTime(
  candles15m: Candle[],
  sup: (number | null)[],
  res: (number | null)[],
  t: number,
): { support: number | null; resistance: number | null } {
  let lo = 0, hi = candles15m.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles15m[mid].time <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (idx < 0) return { support: null, resistance: null };
  return { support: sup[idx], resistance: res[idx] };
}

// ─── Trade simulation ───────────────────────────────────────────────────────
interface TradeOutcome {
  source: string;
  tfKey: string;
  side: "LONG" | "SHORT";
  fireTime: number;
  entryIdx5m: number;
  entryTime: number;
  entryPrice: number;
  outcome: "WIN" | "LOSS" | "TIMEOUT";
  exitPrice: number;
  pnlPct: number;
  holdBars: number;
  exitTime: number;
}

function simulateTradeOnLtf(
  ltfCandles: Candle[],
  entryIdx: number,
  side: "LONG" | "SHORT",
  entryPrice: number,
  targetPct: number,
  stopPct: number,
  maxHoldBars: number,
): { outcome: "WIN" | "LOSS" | "TIMEOUT"; exitPrice: number; pnlPct: number; holdBars: number; exitIdx: number } {
  if (entryIdx < 0 || entryIdx >= ltfCandles.length || !Number.isFinite(maxHoldBars)) {
    return { outcome: "TIMEOUT", exitPrice: entryPrice, pnlPct: 0, holdBars: 0, exitIdx: Math.max(0, Math.min(entryIdx, ltfCandles.length - 1)) };
  }
  let maxIdx = Math.min(entryIdx + Math.max(1, Math.floor(maxHoldBars)), ltfCandles.length - 1);
  if (!Number.isFinite(maxIdx) || maxIdx < entryIdx) maxIdx = entryIdx;
  for (let i = entryIdx + 1; i <= maxIdx; i++) {
    const c = ltfCandles[i];
    const highPct = ((c.high - entryPrice) / entryPrice) * 100;
    const lowPct = ((c.low - entryPrice) / entryPrice) * 100;
    if (side === "LONG") {
      if (lowPct <= -stopPct)
        return { outcome: "LOSS", exitPrice: entryPrice * (1 - stopPct / 100), pnlPct: -stopPct, holdBars: i - entryIdx, exitIdx: i };
      if (highPct >= targetPct)
        return { outcome: "WIN", exitPrice: entryPrice * (1 + targetPct / 100), pnlPct: targetPct, holdBars: i - entryIdx, exitIdx: i };
    } else {
      if (highPct >= stopPct)
        return { outcome: "LOSS", exitPrice: entryPrice * (1 + stopPct / 100), pnlPct: -stopPct, holdBars: i - entryIdx, exitIdx: i };
      if (lowPct <= -targetPct)
        return { outcome: "WIN", exitPrice: entryPrice * (1 - targetPct / 100), pnlPct: targetPct, holdBars: i - entryIdx, exitIdx: i };
    }
  }
  if (!ltfCandles[maxIdx]) {
    return { outcome: "TIMEOUT", exitPrice: entryPrice, pnlPct: 0, holdBars: 0, exitIdx: entryIdx };
  }
  const finalPct = side === "LONG"
    ? ((ltfCandles[maxIdx].close - entryPrice) / entryPrice) * 100
    : ((entryPrice - ltfCandles[maxIdx].close) / entryPrice) * 100;
  return { outcome: "TIMEOUT", exitPrice: ltfCandles[maxIdx].close, pnlPct: finalPct, holdBars: maxIdx - entryIdx, exitIdx: maxIdx };
}

// ─── Rule signal detection ──────────────────────────────────────────────────
interface RawSignal {
  htfIdx: number;
  htfTime: number;
  side: "LONG" | "SHORT";
}

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

// ─── SMART STACK virtual state with BETTER-ENTRY gate ───────────────────────
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
  betterEntryMode: BetterEntryMode,
): string | null {
  const sameSide = positions.filter((p) => p.side === side);
  if (sameSide.length >= LIVE_STACK_CFG.stackMaxPerSide) {
    return `stack full ${sameSide.length}/${LIVE_STACK_CFG.stackMaxPerSide} ${side}`;
  }
  if (LIVE_STACK_CFG.stackMaxNotionalUsd > 0) {
    const currentNotional = sameSide.reduce((sum, p) => sum + p.qty * p.entryPrice, 0);
    const newOrderNotional = LIVE_STACK_CFG.marginUsd * LIVE_STACK_CFG.leverage;
    if (currentNotional + newOrderNotional > LIVE_STACK_CFG.stackMaxNotionalUsd) {
      return `notional cap ${side}`;
    }
  }
  if (sameSide.length > 0) {
    const lastSame = sameSide.reduce((a, b) => (a.entryMs > b.entryMs ? a : b));
    if (LIVE_STACK_CFG.stackPerSideSpacingMin > 0 && nowMs - lastSame.entryMs < LIVE_STACK_CFG.stackPerSideSpacingMin * 60_000) {
      return `spacing ${side}`;
    }
    if (LIVE_STACK_CFG.stackMinEntryDistPct > 0) {
      const distPct = Math.abs(entryPrice - lastSame.entryPrice) / lastSame.entryPrice * 100;
      if (distPct < LIVE_STACK_CFG.stackMinEntryDistPct) {
        return `dist too close ${side}`;
      }
    }
    // ─── BETTER ENTRY ONLY (the gate under test) ───────────────────────────
    if (betterEntryMode !== "off") {
      let benchmark: number;
      if (betterEntryMode === "vs-last") {
        benchmark = lastSame.entryPrice;
      } else if (betterEntryMode === "vs-best") {
        benchmark = side === "LONG"
          ? Math.min(...sameSide.map((p) => p.entryPrice))
          : Math.max(...sameSide.map((p) => p.entryPrice));
      } else {
        // vs-avg: count-weighted mean
        const sum = sameSide.reduce((a, b) => a + b.entryPrice, 0);
        benchmark = sum / sameSide.length;
      }
      if (side === "LONG" && entryPrice >= benchmark) return `better-entry(${betterEntryMode}) ${side}`;
      if (side === "SHORT" && entryPrice <= benchmark) return `better-entry(${betterEntryMode}) ${side}`;
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
  srSupport: (number | null)[],
  srResistance: (number | null)[],
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
        const { support, resistance } = srAtTime(candles15m, srSupport, srResistance, sig.htfTime);
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

// ─── Run mode (with better-entry param) ────────────────────────────────────
interface ModeResult {
  modeKey: string;
  modeLabel: string;
  betterEntryMode: BetterEntryMode;
  totalCandidates: number;
  blockedByCooldown: number;
  blockedByStack: number;
  blockedByBetterEntry: number;
  blockedByDd: number;
  ddPauseTriggers: number;
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
  perSource: Record<string, {
    trades: number;
    wins: number;
    losses: number;
    netPctLev: number;
    pf: number;
  }>;
}

function runModeSimulation(
  modeKey: string,
  modeLabel: string,
  betterEntryMode: BetterEntryMode,
  candidates: Candidate[],
  candles5m: Candle[],
  ruleCooldownMin: number,
): ModeResult {
  const sorted = [...candidates].sort((a, b) => a.entryTime - b.entryTime);
  const trades: TradeOutcome[] = [];
  const lastEntryByCooldownKey: Record<string, number> = {};
  let positions: VirtualPosition[] = [];
  let blockedByCooldown = 0;
  let blockedByStack = 0;
  let blockedByBetterEntry = 0;

  const startCapital = LIVE_STACK_CFG.marginUsd * 100;
  let cumPnlUsd = 0;
  let peakEquity = startCapital;
  let ddPausedUntilMs = 0;
  let ddPauseTriggers = 0;
  let blockedByDd = 0;

  for (const c of sorted) {
    const nowMs = c.entryTime;

    if (LIVE_STACK_CFG.equityDdPausePct > 0 && nowMs < ddPausedUntilMs) {
      blockedByDd++;
      continue;
    }

    positions = positions.filter((p) => p.exitMs > nowMs);

    const last = lastEntryByCooldownKey[c.cooldownKey];
    if (last && nowMs - last < ruleCooldownMin * 60_000) {
      blockedByCooldown++;
      continue;
    }

    const block = checkStackGateVirtual(positions, c.side, c.entryPrice, nowMs, betterEntryMode);
    if (block) {
      if (block.startsWith("better-entry")) blockedByBetterEntry++;
      else blockedByStack++;
      continue;
    }

    const sim = simulateTradeOnLtf(
      candles5m, c.entryIdx5m, c.side, c.entryPrice,
      c.tpPct, c.slPct, c.maxHold5m,
    );
    const exitIdx5m = Math.min(c.entryIdx5m + sim.holdBars, candles5m.length - 1);
    const exitMs = candles5m[exitIdx5m].time;
    const qty = (LIVE_STACK_CFG.marginUsd * LIVE_STACK_CFG.leverage) / c.entryPrice;
    positions.push({ side: c.side, entryPrice: c.entryPrice, qty, entryMs: nowMs, exitMs });
    lastEntryByCooldownKey[c.cooldownKey] = nowMs;

    trades.push({
      source: c.source,
      tfKey: c.tfKey,
      side: c.side,
      fireTime: c.fireTime,
      entryIdx5m: c.entryIdx5m,
      entryTime: c.entryTime,
      entryPrice: c.entryPrice,
      outcome: sim.outcome,
      exitPrice: sim.exitPrice,
      pnlPct: sim.pnlPct,
      holdBars: sim.holdBars,
      exitTime: exitMs,
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

  const perSourceBuckets: Record<string, TradeOutcome[]> = {};
  for (const t of trades) {
    const bucket = (t.tfKey === "5m" || t.tfKey === "15m")
      ? `LTF rules (${t.tfKey})`
      : `HTF rules (${t.tfKey})`;
    if (!perSourceBuckets[bucket]) perSourceBuckets[bucket] = [];
    perSourceBuckets[bucket].push(t);
  }
  const perSource: ModeResult["perSource"] = {};
  for (const [bucket, ts] of Object.entries(perSourceBuckets)) {
    const w = ts.filter((t) => t.outcome === "WIN").length;
    const l = ts.filter((t) => t.outcome === "LOSS").length;
    const eqB = computeEquityStats(ts);
    perSource[bucket] = {
      trades: ts.length,
      wins: w,
      losses: l,
      netPctLev: eqB.netPctLev,
      pf: eqB.profitFactor,
    };
  }

  return {
    modeKey,
    modeLabel,
    betterEntryMode,
    totalCandidates: sorted.length,
    blockedByCooldown,
    blockedByStack,
    blockedByBetterEntry,
    blockedByDd,
    ddPauseTriggers,
    metrics: {
      trades: trades.length,
      wins,
      losses,
      timeouts,
      winRate: Math.round(winRate * 100) / 100,
      netPctLev: eq.netPctLev,
      maxDD: eq.maxDD,
      profitFactor: eq.profitFactor,
      sharpeLike: eq.sharpeLike,
      avgHoldBars: Math.round(avgHoldBars * 10) / 10,
      equityCurve: eq.curve,
      equityTrend: eq.trend,
    },
    perSource,
  };
}

// ─── HTML report ────────────────────────────────────────────────────────────
const MODE_COLORS: Record<string, string> = {
  E1: "#9f8e80",
  E2: "#10b981",
  E3: "#a78bfa",
  E4: "#F7931A",
};

function bigEquityOverlaySvg(modes: ModeResult[], width = 980, height = 320): string {
  const allVals: number[] = [];
  for (const m of modes) for (const v of m.metrics.equityCurve) allVals.push(v);
  if (allVals.length === 0) return `<svg width="${width}" height="${height}"></svg>`;
  const min = Math.min(...allVals, 0);
  const max = Math.max(...allVals, 0);
  const range = max - min || 1;

  const lines = modes.map((m) => {
    const curve = m.metrics.equityCurve;
    if (curve.length < 2) return "";
    const color = MODE_COLORS[m.modeKey] || "#999";
    const pts = curve.map((v, i) => {
      const x = (i / (curve.length - 1)) * width;
      const y = height - ((v - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
    return `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6">
      <title>${m.modeLabel} · NET ${m.metrics.netPctLev}% · DD ${m.metrics.maxDD}%</title>
    </polyline>`;
  }).join("\n");

  const zeroY = height - ((0 - min) / range) * height;
  const legend = modes.map((m, idx) => {
    const color = MODE_COLORS[m.modeKey] || "#999";
    const x = 12 + idx * 220;
    return `<rect x="${x}" y="6" width="14" height="3" fill="${color}"/>
            <text x="${x + 20}" y="13" fill="#cfc6bc" font-size="11">${m.modeKey} ${m.betterEntryMode}: ${m.metrics.netPctLev >= 0 ? "+" : ""}${m.metrics.netPctLev.toFixed(0)}%</text>`;
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
  const sortedByNet = [...modes].sort((a, b) => b.metrics.netPctLev - a.metrics.netPctLev);
  const sortedBySharpe = [...modes].sort((a, b) => b.metrics.sharpeLike - a.metrics.sharpeLike);
  const sortedByDd = [...modes].sort((a, b) => a.metrics.maxDD - b.metrics.maxDD);
  const baseline = modes.find((m) => m.modeKey === "E1")!;

  const periodInfo = Object.entries(periods).map(([tf, p]) =>
    `<span><b>${tf}</b>: ${p.n.toLocaleString()} candles · ${p.from} → ${p.to}</span>`
  ).join(" · ");

  const overlay = bigEquityOverlaySvg(modes, 980, 320);

  const cardHtml = modes.map((m) => {
    const netColor = m.metrics.netPctLev > 0 ? "#10b981" : "#ffb4ab";
    const trendBadge = m.metrics.equityTrend === "UP" ? "🟢↑" : m.metrics.equityTrend === "DOWN" ? "🔴↓" : "⚪→";
    const pfStr = m.metrics.profitFactor === 999 ? "∞" : m.metrics.profitFactor.toFixed(2);
    const delta = m.metrics.netPctLev - baseline.metrics.netPctLev;
    const deltaPct = baseline.metrics.netPctLev !== 0 ? (delta / Math.abs(baseline.metrics.netPctLev)) * 100 : 0;
    const isWinnerNet = m.modeKey === sortedByNet[0].modeKey;
    const isWinnerSharpe = m.modeKey === sortedBySharpe[0].modeKey;
    const isWinnerDd = m.modeKey === sortedByDd[0].modeKey;
    const winnerBadges: string[] = [];
    if (isWinnerNet) winnerBadges.push("🏆NET");
    if (isWinnerSharpe) winnerBadges.push("📈Sharpe");
    if (isWinnerDd) winnerBadges.push("🛡️DD");
    const winnerStr = winnerBadges.length ? ` <span style="color:#F7931A">${winnerBadges.join(" · ")}</span>` : "";
    const perSourceRows = Object.entries(m.perSource)
      .sort(([, a], [, b]) => b.netPctLev - a.netPctLev)
      .map(([k, v]) => `<tr><td>${k}</td><td>${v.trades}</td><td>${v.wins}/${v.losses}</td><td>${v.pf === 999 ? "∞" : v.pf.toFixed(2)}</td><td style="color:${v.netPctLev > 0 ? "#10b981" : "#ffb4ab"}">${v.netPctLev >= 0 ? "+" : ""}${v.netPctLev.toFixed(0)}%</td></tr>`).join("\n");
    return `<div class="card" style="border-left:4px solid ${MODE_COLORS[m.modeKey]}">
      <h2>${m.modeLabel}${winnerStr}</h2>
      <div class="grid">
        <div class="stat"><span>Trades</span><b>${m.metrics.trades.toLocaleString()}</b></div>
        <div class="stat"><span>WR</span><b>${m.metrics.winRate.toFixed(1)}%</b></div>
        <div class="stat"><span>NET %lev</span><b style="color:${netColor}">${m.metrics.netPctLev >= 0 ? "+" : ""}${m.metrics.netPctLev.toFixed(0)}%</b></div>
        <div class="stat"><span>vs E1</span><b style="color:${delta >= 0 ? "#10b981" : "#ffb4ab"}">${delta >= 0 ? "+" : ""}${delta.toFixed(0)}% (${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(1)}%)</b></div>
        <div class="stat"><span>MaxDD</span><b style="color:#ffb4ab">-${m.metrics.maxDD.toFixed(0)}%</b></div>
        <div class="stat"><span>PF</span><b>${pfStr}</b></div>
        <div class="stat"><span>Sharpe</span><b>${m.metrics.sharpeLike.toFixed(1)}</b></div>
        <div class="stat"><span>Trend</span><b>${trendBadge}</b></div>
      </div>
      <div class="info">
        Candidates: ${m.totalCandidates.toLocaleString()} · Blocked CD ${m.blockedByCooldown} · Stack ${m.blockedByStack} · BetterEntry ${m.blockedByBetterEntry} · DD ${m.blockedByDd} · DD pauses ${m.ddPauseTriggers} · W/L/TO: ${m.metrics.wins}/${m.metrics.losses}/${m.metrics.timeouts} · AvgHold ${m.metrics.avgHoldBars} bars
      </div>
      <table class="src">
        <thead><tr><th>Source bucket</th><th>Trades</th><th>W/L</th><th>PF</th><th>NET %lev</th></tr></thead>
        <tbody>${perSourceRows}</tbody>
      </table>
    </div>`;
  }).join("\n");

  const compRows = sortedByNet.map((m, i) => {
    const pfStr = m.metrics.profitFactor === 999 ? "∞" : m.metrics.profitFactor.toFixed(2);
    return `<tr>
      <td>#${i + 1}</td>
      <td><b style="color:${MODE_COLORS[m.modeKey]}">${m.modeKey}</b></td>
      <td>${m.betterEntryMode}</td>
      <td>${m.metrics.trades.toLocaleString()}</td>
      <td>${m.metrics.winRate.toFixed(1)}%</td>
      <td style="color:${m.metrics.netPctLev > 0 ? "#10b981" : "#ffb4ab"}">${m.metrics.netPctLev >= 0 ? "+" : ""}${m.metrics.netPctLev.toFixed(0)}%</td>
      <td style="color:#ffb4ab">-${m.metrics.maxDD.toFixed(0)}%</td>
      <td>${pfStr}</td>
      <td>${m.metrics.sharpeLike.toFixed(1)}</td>
      <td>${m.blockedByBetterEntry.toLocaleString()}</td>
    </tr>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="vi"><head><meta charset="UTF-8"/>
<title>LIVE Better-Entry 4-Mode · 3y Backtest · BTC/USDT</title>
<style>
  body { background:#131313; color:#e5e2e1; font-family:'JetBrains Mono','Menlo',monospace; font-size:12px; padding:18px; }
  h1 { color:#F7931A; font-size:18px; letter-spacing:1px; margin:0 0 6px 0; }
  h2 { color:#ffdcc0; font-size:14px; letter-spacing:1px; margin:0 0 10px 0; }
  .info { color:#9f8e80; font-size:11px; margin:6px 0 14px 0; line-height:1.7; }
  .card { background:#1a1a1a; border:1px solid #2a2a2a; padding:14px 16px; border-radius:6px; margin-bottom:14px; }
  .grid { display:grid; grid-template-columns:repeat(8, 1fr); gap:12px; margin-bottom:10px; }
  .stat { display:flex; flex-direction:column; gap:2px; }
  .stat span { color:#9f8e80; font-size:10px; text-transform:uppercase; }
  .stat b { color:#ffdcc0; font-size:14px; }
  table { border-collapse:collapse; width:100%; }
  th, td { border:1px solid #2a2a2a; padding:5px 8px; text-align:left; }
  th { background:#1c1b1b; color:#F7931A; font-size:10px; letter-spacing:1px; text-transform:uppercase; }
  table.src { font-size:11px; margin-top:8px; }
  .verdict { background:#0f0a05; padding:14px 18px; border-radius:6px; border:1px solid #4a3520; margin:14px 0; }
  .verdict b { color:#F7931A; }
</style>
</head>
<body>
<h1>📊 LIVE BETTER-ENTRY · 4-MODE · 3-YEAR BACKTEST · BTC/USDT</h1>
<div class="info">${periodInfo}<br>
Generated: ${new Date().toISOString()} · Fee/side: ${FEE_PER_SIDE}% · Margin $${LIVE_STACK_CFG.marginUsd} × ${LIVE_STACK_CFG.leverage}x = $${LIVE_STACK_CFG.marginUsd * LIVE_STACK_CFG.leverage}/lệnh<br>
LIVE PRESET B stack: ${LIVE_STACK_CFG.stackMaxPerSide}/side · spacing ${LIVE_STACK_CFG.stackPerSideSpacingMin}m · dist ${LIVE_STACK_CFG.stackMinEntryDistPct}% · notional cap $${(LIVE_STACK_CFG.stackMaxNotionalUsd / 1000).toFixed(0)}k · DD pause ${LIVE_STACK_CFG.equityDdPausePct}%/${LIVE_STACK_CFG.equityDdPauseHours}h · per-rule cooldown ${LIVE_STACK_CFG.perRuleCooldownMin}m<br>
Mode E config: Full TF rules EXCLUDING ${[...EXCLUDE_5M_BASELINE_IDS].join(",")} · 5m ALL Engine OFF · Phase 2 LTF confirm for HTF (1h+) · PA A2 skip for LTF (5m/15m).<br>
Better-entry benchmarks: <b>off</b> = no gate · <b>vs-last</b> = better than nearest same-side entry · <b>vs-best</b> = better than ALL same-side entries (LONG min · SHORT max) · <b>vs-avg</b> = better than count-weighted mean
</div>

<div class="verdict">
  <b>🏆 Best by NET</b>: ${sortedByNet[0].modeKey} ${sortedByNet[0].betterEntryMode} (NET ${sortedByNet[0].metrics.netPctLev.toFixed(0)}%) ·
  <b>📈 Best by Sharpe</b>: ${sortedBySharpe[0].modeKey} ${sortedBySharpe[0].betterEntryMode} (Sharpe ${sortedBySharpe[0].metrics.sharpeLike.toFixed(1)}) ·
  <b>🛡️ Best by MaxDD</b>: ${sortedByDd[0].modeKey} ${sortedByDd[0].betterEntryMode} (-${sortedByDd[0].metrics.maxDD.toFixed(0)}%)
</div>

<div class="card">
  <h2>📈 EQUITY OVERLAY · 4 modes</h2>
  ${overlay}
</div>

<div class="card">
  <h2>🏆 COMPARISON · sorted by NET %lev</h2>
  <table>
    <thead><tr><th>Rank</th><th>Mode</th><th>BetterEntry</th><th>Trades</th><th>WR</th><th>NET %lev</th><th>MaxDD</th><th>PF</th><th>Sharpe</th><th>BetterEntry blocks</th></tr></thead>
    <tbody>${compRows}</tbody>
  </table>
</div>

${cardHtml}

</body></html>`;
}

// ─── Main ───────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n=== LIVE BETTER-ENTRY 4-MODE BACKTEST 3Y · BTC/USDT ===`);
  console.log(`Fee/side: ${FEE_PER_SIDE}% · LIVE PRESET B stack ${LIVE_STACK_CFG.stackMaxPerSide}/side · DD pause ${LIVE_STACK_CFG.equityDdPausePct}%/${LIVE_STACK_CFG.equityDdPauseHours}h\n`);

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
  const { sup: srSupportBaseline, res: srResistanceBaseline } = precomputeSR15m(candles15m, SR_LOOKBACK_15M);

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
    const bundles: Record<string, HtfBundle> = {
      [nearKey]: { series: nearS, alignment: nearAlign, trends: nearTrends },
      [farKey]: { series: farS, alignment: farAlign, trends: farTrends },
    };
    bundlesByEntryTF[tf] = { bundles, nearKey, farKey, nearTrends, farTrends, nearRsis, farRsis };
  }

  // Active rules — Mode E pool: Full TF rules MINUS 5m baseline rule(s)
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
  const excludedRuleIds = fullTfRules
    .filter(({ tf, rule }) => EXCLUDE_5M_BASELINE_IDS.has(`${tf}:${rule.rank}`))
    .map(({ tf, rule }) => `${tf}:${rule.rank}`);

  console.log(`\nRules loaded: full TF ${fullTfRules.length} (${ENTRY_TFS_FULL.map((tf) => `${tf}:${fullTfRules.filter((r) => r.tf === tf).length}`).join(", ")})`);
  console.log(`              Mode E pool (no 5m baseline): ${fullTfNoBaselineRules.length} (excluded: ${excludedRuleIds.join(", ") || "none"})`);

  console.log(`\nBuilding rule candidates (full TF, Phase 2 LTF confirm)...`);
  const t1 = Date.now();
  const fullTfCandidates = buildRuleCandidates(
    fullTfRules, candlesByTF, seriesByTF, bundlesByEntryTF,
    candles5m, stoch5mSeries, candles15m, srSupportBaseline, srResistanceBaseline,
  );
  console.log(`  full TF candidates: ${fullTfCandidates.length.toLocaleString()} (${((Date.now() - t1) / 1000).toFixed(1)}s)`);

  // Filter to Mode E candidate pool
  const fullTfNoBaselineCandidates = fullTfCandidates.filter(
    (c) => !EXCLUDE_5M_BASELINE_IDS.has(c.source),
  );
  console.log(`  Mode E candidates (no 5m baseline): ${fullTfNoBaselineCandidates.length.toLocaleString()}`);

  // Run 4 modes — each with a different stackBetterEntryMode
  const results: ModeResult[] = [];
  for (const m of MODES) {
    const tStart = Date.now();
    console.log(`\n[${m.key}] ${m.label}...`);
    const r = runModeSimulation(
      m.key, m.label, m.mode,
      fullTfNoBaselineCandidates,
      candles5m,
      LIVE_STACK_CFG.perRuleCooldownMin,
    );
    results.push(r);
    const dt = ((Date.now() - tStart) / 1000).toFixed(1);
    console.log(`  ${r.metrics.trades.toLocaleString().padStart(6)} trades · NET ${r.metrics.netPctLev.toFixed(0)}% · MaxDD -${r.metrics.maxDD.toFixed(0)}% · WR ${r.metrics.winRate.toFixed(1)}% · PF ${r.metrics.profitFactor === 999 ? "∞" : r.metrics.profitFactor.toFixed(2)} · Sharpe ${r.metrics.sharpeLike.toFixed(1)} · BE blocks ${r.blockedByBetterEntry.toLocaleString()}  (${dt}s)`);
  }

  // Compute deltas vs E1 baseline
  const baseline = results.find((r) => r.modeKey === "E1")!;
  const deltas = results.map((r) => ({
    modeKey: r.modeKey,
    betterEntryMode: r.betterEntryMode,
    deltaNetPctLev: Math.round((r.metrics.netPctLev - baseline.metrics.netPctLev) * 100) / 100,
    deltaMaxDD: Math.round((r.metrics.maxDD - baseline.metrics.maxDD) * 100) / 100,
    deltaTrades: r.metrics.trades - baseline.metrics.trades,
    deltaWinRate: Math.round((r.metrics.winRate - baseline.metrics.winRate) * 100) / 100,
    deltaProfitFactor: Math.round((r.metrics.profitFactor - baseline.metrics.profitFactor) * 100) / 100,
    deltaSharpe: Math.round((r.metrics.sharpeLike - baseline.metrics.sharpeLike) * 100) / 100,
  }));

  const sortedByNet = [...results].sort((a, b) => b.metrics.netPctLev - a.metrics.netPctLev);
  const sortedBySharpe = [...results].sort((a, b) => b.metrics.sharpeLike - a.metrics.sharpeLike);
  const sortedByDd = [...results].sort((a, b) => a.metrics.maxDD - b.metrics.maxDD);

  function strip(m: ModeResult) {
    return {
      modeKey: m.modeKey,
      modeLabel: m.modeLabel,
      betterEntryMode: m.betterEntryMode,
      totalCandidates: m.totalCandidates,
      blockedByCooldown: m.blockedByCooldown,
      blockedByStack: m.blockedByStack,
      blockedByBetterEntry: m.blockedByBetterEntry,
      blockedByDd: m.blockedByDd,
      ddPauseTriggers: m.ddPauseTriggers,
      metrics: m.metrics,
      perSource: m.perSource,
    };
  }

  const out = {
    generatedAt: Date.now(),
    config: {
      years: YEARS,
      fee: FEE_PER_SIDE,
      ltfConfirm: LTF_CFG,
      liveStack: LIVE_STACK_CFG,
      entryTfsFull: ENTRY_TFS_FULL,
      excludeFor5mBaseline: [...EXCLUDE_5M_BASELINE_IDS],
      modes: MODES,
    },
    periods,
    activeRuleCounts: {
      fullTf: fullTfRules.length,
      fullTfNoBaseline: fullTfNoBaselineRules.length,
    },
    results: results.map(strip),
    deltasVsBaseline: deltas,
    bestByNet: sortedByNet[0].modeKey,
    bestBySharpe: sortedBySharpe[0].modeKey,
    bestByMaxDD: sortedByDd[0].modeKey,
  };

  const jsonPath = join(__dirname, "..", "assets", "backtest_live_better_entry_3y.json");
  writeFileSync(jsonPath, JSON.stringify(out, null, 2));
  console.log(`\n💾 JSON: ${jsonPath}`);

  const htmlPath = join(__dirname, "..", "assets", "backtest_live_better_entry_3y_report.html");
  writeFileSync(htmlPath, renderHtml(results, periods));
  console.log(`💾 HTML: ${htmlPath}`);

  // Final summary
  console.log(`\n=== Summary (4 modes) ===`);
  for (const r of results) {
    const pfStr = r.metrics.profitFactor === 999 ? "∞" : r.metrics.profitFactor.toFixed(2);
    console.log(`  ${r.modeKey} (${r.betterEntryMode.padEnd(8)}): NET ${r.metrics.netPctLev.toFixed(0).padStart(7)}% · DD -${r.metrics.maxDD.toFixed(0).padStart(5)}% · ${r.metrics.trades.toString().padStart(5)} trades · WR ${r.metrics.winRate.toFixed(1)}% · PF ${pfStr} · Sharpe ${r.metrics.sharpeLike.toFixed(1)} · BE blocks ${r.blockedByBetterEntry.toLocaleString()}`);
  }

  console.log(`\n=== Δ vs E1 baseline (off) ===`);
  for (const d of deltas) {
    if (d.modeKey === "E1") continue;
    console.log(`  ${d.modeKey} (${d.betterEntryMode}): ΔNET ${d.deltaNetPctLev >= 0 ? "+" : ""}${d.deltaNetPctLev.toFixed(0)}% · ΔDD ${d.deltaMaxDD >= 0 ? "+" : ""}${d.deltaMaxDD.toFixed(0)}% · ΔTrades ${d.deltaTrades >= 0 ? "+" : ""}${d.deltaTrades} · ΔWR ${d.deltaWinRate >= 0 ? "+" : ""}${d.deltaWinRate.toFixed(2)}pp · ΔSharpe ${d.deltaSharpe >= 0 ? "+" : ""}${d.deltaSharpe.toFixed(1)}`);
  }

  console.log(`\nBest by NET:    ${sortedByNet[0].modeKey} ${sortedByNet[0].betterEntryMode} (${sortedByNet[0].metrics.netPctLev.toFixed(0)}%)`);
  console.log(`Best by Sharpe: ${sortedBySharpe[0].modeKey} ${sortedBySharpe[0].betterEntryMode} (${sortedBySharpe[0].metrics.sharpeLike.toFixed(1)})`);
  console.log(`Best by MaxDD:  ${sortedByDd[0].modeKey} ${sortedByDd[0].betterEntryMode} (-${sortedByDd[0].metrics.maxDD.toFixed(0)}%)`);
})();
