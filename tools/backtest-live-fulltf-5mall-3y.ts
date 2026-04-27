/**
 * backtest-live-fulltf-5mall-3y.ts
 *
 * 5-mode 3-year LIVE engine backtest combining HTF rules from hard_rules.json
 * with the 5m ALL Engine (per-preset). Goal: compare current production
 * (rules-only) vs proposed (rules + 5m ALL Engine per preset).
 *
 *   • Mode A — baseline: Full TF rules (5m/15m/1h/4h/1d/1w) + Phase 2 LTF confirm
 *               for HTF (1h+) + PA A2 skip for LTF (5m/15m). LIVE PRESET B stack
 *               settings, equityDdPause 30%/4h.
 *   • Mode B — HTF rules only (1h/4h/1d/1w) + 5m ALL Engine BALANCED preset.
 *   • Mode C — HTF rules only + 5m ALL Engine WHALE.
 *   • Mode D — HTF rules only + 5m ALL Engine TURTLE.
 *   • Mode E — Full TF rules EXCLUDING the 5m baseline rule (5m:1). Same config
 *               as Mode A otherwise. Tests whether removing the 5m baseline lifts
 *               NET (per Mode A perSource breakdown the 5m bucket dragged
 *               -332,756% on 34,580 trades, PF 1.01).
 *
 * 5m ALL Engine signal source (each closed 5m bar, evaluated per preset):
 *   - Stoch K < preset.stochLongLevel  → LONG
 *   - Stoch K > preset.stochShortLevel → SHORT
 *   - else fallback S/R 15m: close ≤ support × (1 + srProx%) → LONG, etc.
 *   - Build alert (tfKey="5mall", tpPct/slPct from preset) → decideEntry → executeAction
 *     (PA A2 skip — no Phase 2 wait), then go through SHARED LIVE PRESET B stack gates.
 *
 * Hedge mode preserved (LONG+SHORT independent stacks, partial close on hit).
 * Stack gates use LIVE PRESET B (not the 5m ALL preset's own stack settings).
 *
 * Output:
 *   - assets/backtest_live_fulltf_5mall_3y.json
 *   - assets/backtest_live_fulltf_5mall_3y_report.html
 *
 * Usage:
 *   npx tsx tools/backtest-live-fulltf-5mall-3y.ts
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
const MAX_HOLD_BARS_DEFAULT = 200;
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
  leverage: 100, // 1 × 100 = $100 notional / entry
  equityDdPausePct: 30,
  equityDdPauseHours: 4,
};

// 5m ALL Engine PRESETS (from utils/all5mAccount.ts)
type PresetKey = "WHALE" | "BALANCED" | "TURTLE";
interface All5mPreset {
  key: PresetKey;
  emoji: string;
  tpPct: number;
  slPct: number;
  cooldownMin: number;
  stochLongLevel: number;
  stochShortLevel: number;
  srProximityPct: number;
  srLookback15m: number;
}
const ALL5M_PRESETS: Record<PresetKey, All5mPreset> = {
  WHALE: {
    key: "WHALE", emoji: "🔴",
    tpPct: 5, slPct: 2.5,
    cooldownMin: 5,
    stochLongLevel: 10, stochShortLevel: 90,
    srProximityPct: 0.4, srLookback15m: 30,
  },
  BALANCED: {
    key: "BALANCED", emoji: "🟡",
    tpPct: 5, slPct: 2.5,
    cooldownMin: 5,
    stochLongLevel: 15, stochShortLevel: 85,
    srProximityPct: 0.4, srLookback15m: 50,
  },
  TURTLE: {
    key: "TURTLE", emoji: "🟢",
    tpPct: 3.5, slPct: 2,
    cooldownMin: 15,
    stochLongLevel: 10, stochShortLevel: 90,
    srProximityPct: 0.4, srLookback15m: 80,
  },
};

const LTF_CFG: LtfConfirmConfig = {
  ...DEFAULT_LTF_CONFIRM,
  stochOSLevel: 20,
  stochObLevel: 80,
  srProximityPct: 0.4,
  maxWaitBars: CONFIRM_WINDOW,
};

const ENTRY_TFS_FULL = ["5m", "15m", "1h", "4h", "1d", "1w"];
const ENTRY_TFS_HTF = ["1h", "4h", "1d", "1w"];
// 5m baseline rule(s) to exclude in Mode E. Matches `${tf}:${rank}`.
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

const BARS_PER_YEAR: Record<string, number> = {
  "5m": 365 * 24 * 12,
  "15m": 365 * 24 * 4,
  "1h": 365 * 24,
  "4h": 365 * 6,
  "1d": 365,
  "1w": 52,
};

// ─── Types (mirroring backtest-live-rules.ts) ───────────────────────────────
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
  if (!existsSync(cachePath)) throw new Error(`Missing cache ${cachePath} — run backtest-live-rules.ts first to populate`);
  const data = JSON.parse(readFileSync(cachePath, "utf8")) as Candle[];
  return data;
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

// Divergence
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

// ─── S/R 15m precompute (parametric lookback) ───────────────────────────────
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
  source: string;        // ruleId or "5mall:STOCH" / "5mall:SR"
  tfKey: string;         // "5m"|"15m"|"1h"|"4h"|"1d"|"1w"|"5mall"
  side: "LONG" | "SHORT";
  fireTime: number;
  entryIdx5m: number;
  entryTime: number;
  entryPrice: number;
  outcome: "WIN" | "LOSS" | "TIMEOUT";
  exitPrice: number;
  pnlPct: number;        // raw price %
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

// ─── 5m ALL Engine signal detection (per preset) ────────────────────────────
interface All5mSignal {
  bar5mIdx: number;
  bar5mTime: number;
  side: "LONG" | "SHORT";
  source: "stoch_long" | "stoch_short" | "sr_long" | "sr_short";
  entryPrice: number;
}

function detect5mAllSignals(
  preset: All5mPreset,
  candles5m: Candle[],
  stochK: (number | null)[],
  candles15m: Candle[],
): All5mSignal[] {
  const { sup, res } = precomputeSR15m(candles15m, preset.srLookback15m);
  const out: All5mSignal[] = [];
  for (let i = preset.srLookback15m; i < candles5m.length; i++) {
    const bar = candles5m[i];
    const k = stochK[i];
    let side: "LONG" | "SHORT" | null = null;
    let source: All5mSignal["source"] | null = null;

    if (k !== null && k < preset.stochLongLevel) { side = "LONG"; source = "stoch_long"; }
    else if (k !== null && k > preset.stochShortLevel) { side = "SHORT"; source = "stoch_short"; }
    else {
      const sr = srAtTime(candles15m, sup, res, bar.time);
      if (sr.support !== null && sr.resistance !== null) {
        const distSup = ((bar.close - sr.support) / sr.support) * 100;
        const distRes = ((sr.resistance - bar.close) / bar.close) * 100;
        if (distSup >= 0 && distSup <= preset.srProximityPct) { side = "LONG"; source = "sr_long"; }
        else if (distRes >= 0 && distRes <= preset.srProximityPct) { side = "SHORT"; source = "sr_short"; }
      }
    }
    if (!side || !source) continue;
    out.push({ bar5mIdx: i, bar5mTime: bar.time, side, source, entryPrice: bar.close });
  }
  return out;
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

// ─── SMART STACK virtual state ──────────────────────────────────────────────
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
  }
  return null;
}

// ─── Candidate types ────────────────────────────────────────────────────────
interface Candidate {
  source: string;        // ruleId or "5mall:STOCH" / "5mall:SR"
  tfKey: string;
  side: "LONG" | "SHORT";
  fireTime: number;
  entryIdx5m: number;
  entryTime: number;
  entryPrice: number;
  tpPct: number;
  slPct: number;
  maxHold5m: number;
  // For per-rule cooldown grouping
  cooldownKey: string;
}

// Convert HTF maxHoldBars → 5m bars
const TF_TO_5M_MULT: Record<string, number> = {
  "5m": 1, "15m": 3, "1h": 12, "4h": 48, "1d": 288, "1w": 2016,
};

// ─── Signal pipeline per mode ───────────────────────────────────────────────
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
    // PA A2: 5m/15m skip Phase 2; HTF (1h+) require Phase 2 LTF confirm
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

function build5mAllCandidates(
  preset: All5mPreset,
  candles5m: Candle[],
  stochK: (number | null)[],
  candles15m: Candle[],
): Candidate[] {
  const sigs = detect5mAllSignals(preset, candles5m, stochK, candles15m);
  // Plan B monitor: max 200 5m bars hold (matches default)
  const maxHold5m = MAX_HOLD_BARS_DEFAULT;
  return sigs.map((s) => ({
    source: `5mall:${s.source.startsWith("stoch") ? "STOCH" : "SR"}`,
    tfKey: "5mall",
    side: s.side,
    fireTime: s.bar5mTime,
    entryIdx5m: s.bar5mIdx,
    entryTime: s.bar5mTime,
    entryPrice: s.entryPrice,
    tpPct: preset.tpPct,
    slPct: preset.slPct,
    maxHold5m,
    cooldownKey: `5mall:${preset.key}`, // 5m ALL engine has its own cooldown bucket
  }));
}

// ─── Run mode ───────────────────────────────────────────────────────────────
interface ModeResult {
  modeName: string;
  description: string;
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
  candidates: Candidate[],
  candles5m: Candle[],
  ruleCooldownMin: number,
  perSourceCooldownOverrides: Record<string, number> = {},
): ModeResult {
  const sorted = [...candidates].sort((a, b) => a.entryTime - b.entryTime);
  const trades: TradeOutcome[] = [];
  const lastEntryByCooldownKey: Record<string, number> = {};
  let positions: VirtualPosition[] = [];
  let blockedByCooldown = 0;
  let blockedByStack = 0;

  // Equity DD pause
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

    const cdMin = perSourceCooldownOverrides[c.cooldownKey] ?? ruleCooldownMin;
    const last = lastEntryByCooldownKey[c.cooldownKey];
    if (last && nowMs - last < cdMin * 60_000) {
      blockedByCooldown++;
      continue;
    }

    const block = checkStackGateVirtual(positions, c.side, c.entryPrice, nowMs);
    if (block) { blockedByStack++; continue; }

    const sim = simulateTradeOnLtf(
      candles5m, c.entryIdx5m, c.side, c.entryPrice,
      c.tpPct, c.slPct, c.maxHold5m,
    );
    const exitIdx5m = Math.min(c.entryIdx5m + sim.holdBars, candles5m.length - 1);
    const exitMs = candles5m[exitIdx5m].time;
    const qty = (LIVE_STACK_CFG.marginUsd * LIVE_STACK_CFG.leverage) / c.entryPrice;
    positions.push({ side: c.side, entryPrice: c.entryPrice, qty, entryMs: nowMs, exitMs });
    lastEntryByCooldownKey[c.cooldownKey] = nowMs;

    const trade: TradeOutcome = {
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
    };
    trades.push(trade);

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

  // Metrics
  const eq = computeEquityStats(trades);
  const wins = trades.filter((t) => t.outcome === "WIN").length;
  const losses = trades.filter((t) => t.outcome === "LOSS").length;
  const timeouts = trades.filter((t) => t.outcome === "TIMEOUT").length;
  const winRate = trades.length ? (wins / trades.length) * 100 : 0;
  const avgHoldBars = trades.length ? trades.reduce((s, t) => s + t.holdBars, 0) / trades.length : 0;

  // Per-source breakdown — group by simplified source bucket
  const perSourceBuckets: Record<string, TradeOutcome[]> = {};
  for (const t of trades) {
    let bucket: string;
    if (t.tfKey === "5mall") {
      bucket = "5mall";
    } else if (t.tfKey === "5m" || t.tfKey === "15m") {
      bucket = `LTF rules (${t.tfKey})`;
    } else {
      bucket = `HTF rules (${t.tfKey})`;
    }
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
    modeName,
    description,
    totalCandidates: sorted.length,
    blockedByCooldown,
    blockedByStack,
    blockedByDd,
    ddPauseTriggers,
    trades,
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
function bigEquityOverlaySvg(modes: ModeResult[], width = 900, height = 280): string {
  const palette: Record<string, string> = {
    "Mode A": "#F7931A",
    "Mode B": "#10b981",
    "Mode C": "#ef4444",
    "Mode D": "#3b82f6",
    "Mode E": "#a855f7",
  };
  const allVals: number[] = [];
  for (const m of modes) {
    for (const v of m.metrics.equityCurve) allVals.push(v);
  }
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
    return `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6"/>`;
  }).join("\n");

  const zeroY = height - ((0 - min) / range) * height;
  const legend = modes.map((m, idx) => {
    const color = palette[m.modeName] || "#999";
    const x = 12 + idx * 170;
    return `<rect x="${x}" y="6" width="14" height="3" fill="${color}"/>
            <text x="${x + 20}" y="13" fill="#cfc6bc" font-size="11">${m.modeName}: ${m.metrics.netPctLev >= 0 ? "+" : ""}${m.metrics.netPctLev.toFixed(0)}% lev</text>`;
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
  const periodInfo = Object.entries(periods).map(([tf, p]) =>
    `<span><b>${tf}</b>: ${p.n.toLocaleString()} candles · ${p.from} → ${p.to}</span>`
  ).join(" · ");

  const overlay = bigEquityOverlaySvg(modes, 900, 280);

  const cardHtml = modes.map((m) => {
    const netColor = m.metrics.netPctLev > 0 ? "#10b981" : "#ffb4ab";
    const trendBadge = m.metrics.equityTrend === "UP" ? "🟢↑" : m.metrics.equityTrend === "DOWN" ? "🔴↓" : "⚪→";
    const pfStr = m.metrics.profitFactor === 999 ? "∞" : m.metrics.profitFactor.toFixed(2);
    const perSourceRows = Object.entries(m.perSource)
      .sort(([, a], [, b]) => b.netPctLev - a.netPctLev)
      .map(([k, v]) => `<tr><td>${k}</td><td>${v.trades}</td><td>${v.wins}/${v.losses}</td><td>${v.pf === 999 ? "∞" : v.pf.toFixed(2)}</td><td style="color:${v.netPctLev > 0 ? "#10b981" : "#ffb4ab"}">${v.netPctLev >= 0 ? "+" : ""}${v.netPctLev.toFixed(0)}%</td></tr>`).join("\n");
    return `<div class="card">
      <h2>${m.modeName} — ${m.description}</h2>
      <div class="grid">
        <div class="stat"><span>Trades</span><b>${m.metrics.trades.toLocaleString()}</b></div>
        <div class="stat"><span>WR</span><b>${m.metrics.winRate.toFixed(1)}%</b></div>
        <div class="stat"><span>NET %lev</span><b style="color:${netColor}">${m.metrics.netPctLev >= 0 ? "+" : ""}${m.metrics.netPctLev.toFixed(0)}%</b></div>
        <div class="stat"><span>MaxDD</span><b style="color:#ffb4ab">-${m.metrics.maxDD.toFixed(0)}%</b></div>
        <div class="stat"><span>PF</span><b>${pfStr}</b></div>
        <div class="stat"><span>Sharpe-like</span><b>${m.metrics.sharpeLike.toFixed(1)}</b></div>
        <div class="stat"><span>Trend</span><b>${trendBadge}</b></div>
        <div class="stat"><span>AvgHold</span><b>${m.metrics.avgHoldBars} bars</b></div>
      </div>
      <div class="info">
        Candidates: ${m.totalCandidates.toLocaleString()} · Blocked CD ${m.blockedByCooldown} · Stack ${m.blockedByStack} · DD ${m.blockedByDd} · DD pauses ${m.ddPauseTriggers} · W/L/TO: ${m.metrics.wins}/${m.metrics.losses}/${m.metrics.timeouts}
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
      <td><b>${m.modeName}</b></td>
      <td style="font-size:11px">${m.description}</td>
      <td>${m.metrics.trades.toLocaleString()}</td>
      <td>${m.metrics.winRate.toFixed(1)}%</td>
      <td style="color:${m.metrics.netPctLev > 0 ? "#10b981" : "#ffb4ab"}">${m.metrics.netPctLev >= 0 ? "+" : ""}${m.metrics.netPctLev.toFixed(0)}%</td>
      <td style="color:#ffb4ab">-${m.metrics.maxDD.toFixed(0)}%</td>
      <td>${pfStr}</td>
      <td>${m.metrics.sharpeLike.toFixed(1)}</td>
    </tr>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="vi"><head><meta charset="UTF-8"/>
<title>LIVE FullTF + 5m ALL Engine · 3y Backtest · BTC/USDT</title>
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
  .compare-table th { font-size:11px; }
</style>
</head>
<body>
<h1>📊 LIVE FULL TF + 5m ALL ENGINE · 3-YEAR BACKTEST · BTC/USDT</h1>
<div class="info">${periodInfo}<br>
Generated: ${new Date().toISOString()} · Fee/side: ${FEE_PER_SIDE}% · Margin $${LIVE_STACK_CFG.marginUsd} × ${LIVE_STACK_CFG.leverage}x = $${LIVE_STACK_CFG.marginUsd * LIVE_STACK_CFG.leverage}/lệnh<br>
LIVE PRESET B stack: ${LIVE_STACK_CFG.stackMaxPerSide}/side · spacing ${LIVE_STACK_CFG.stackPerSideSpacingMin}m · dist ${LIVE_STACK_CFG.stackMinEntryDistPct}% · notional cap $${(LIVE_STACK_CFG.stackMaxNotionalUsd / 1000).toFixed(0)}k · DD pause ${LIVE_STACK_CFG.equityDdPausePct}%/${LIVE_STACK_CFG.equityDdPauseHours}h<br>
HTF rules use Phase 2 LTF confirm (5m Stoch 20/80 OR 15m S/R 0.4%, max wait ${CONFIRM_WINDOW} bars). LTF rules (5m/15m) use PA A2 skip (entry at HTF close).
</div>

<div class="card">
  <h2>📈 EQUITY OVERLAY · 5 modes (Mode E = full TF rules NO 5m baseline)</h2>
  ${overlay}
</div>

<div class="card">
  <h2>🏆 COMPARISON · sorted by NET %lev</h2>
  <table class="compare-table">
    <thead><tr><th>Rank</th><th>Mode</th><th>Description</th><th>Trades</th><th>WR</th><th>NET %lev</th><th>MaxDD</th><th>PF</th><th>Sharpe</th></tr></thead>
    <tbody>${compRows}</tbody>
  </table>
</div>

${cardHtml}

</body></html>`;
}

// ─── Main ───────────────────────────────────────────────────────────────────
let modeBResult: ModeResult | undefined;
let modeCResult: ModeResult | undefined;
let modeDResult: ModeResult | undefined;
let modeEResult: ModeResult | undefined;

(async () => {
  console.log(`\n=== LIVE FullTF + 5m ALL Engine BACKTEST 3Y · BTC/USDT ===`);
  console.log(`Fee/side: ${FEE_PER_SIDE}% · LIVE PRESET B stack ${LIVE_STACK_CFG.stackMaxPerSide}/side · DD pause ${LIVE_STACK_CFG.equityDdPausePct}%/${LIVE_STACK_CFG.equityDdPauseHours}h\n`);

  const hard = JSON.parse(readFileSync(join(__dirname, "..", "assets", "hard_rules.json"), "utf8"));

  // Load cached candles for all TFs
  const tfsToFetch = Array.from(ALL_TFS);
  console.log(`Loading cached ${YEARS}y candles: ${tfsToFetch.join(", ")}`);
  const candlesByTF: Record<string, Candle[]> = {};
  for (const tf of tfsToFetch) {
    candlesByTF[tf] = loadCachedKlines(tf);
    console.log(`  ${tf}: ${candlesByTF[tf].length.toLocaleString()} candles`);
  }

  // Indicator series
  console.log(`\nPrecomputing indicator series...`);
  const seriesByTF: Record<string, IndSeries> = {};
  for (const tf of tfsToFetch) {
    const t0 = Date.now();
    seriesByTF[tf] = precomputeSeries(candlesByTF[tf]);
    console.log(`  ${tf}: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  // S/R 15m baseline (used by HTF Phase 2 confirm + Mode A reference)
  console.log(`\nPrecomputing S/R 15m (lookback ${SR_LOOKBACK_15M})...`);
  const candles15m = candlesByTF["15m"];
  const { sup: srSupportBaseline, res: srResistanceBaseline } = precomputeSR15m(candles15m, SR_LOOKBACK_15M);

  const candles5m = candlesByTF["5m"];
  const stoch5mSeries = seriesByTF["5m"].stochK;

  // Periods
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
    const bundles: Record<string, HtfBundle> = {
      [nearKey]: { series: nearS, alignment: nearAlign, trends: nearTrends },
      [farKey]: { series: farS, alignment: farAlign, trends: farTrends },
    };
    bundlesByEntryTF[tf] = { bundles, nearKey, farKey, nearTrends, farTrends, nearRsis, farRsis };
  }

  // Active rules grouped by full TF list and HTF-only list
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
  const htfOnlyRules = collectActiveRules(ENTRY_TFS_HTF);
  // Mode E pool: full TF rules MINUS 5m baseline rule(s) (id 5m:1)
  const fullTfNoBaselineRules = fullTfRules.filter(
    ({ tf, rule }) => !EXCLUDE_5M_BASELINE_IDS.has(`${tf}:${rule.rank}`),
  );
  const excludedRuleIds = fullTfRules
    .filter(({ tf, rule }) => EXCLUDE_5M_BASELINE_IDS.has(`${tf}:${rule.rank}`))
    .map(({ tf, rule }) => `${tf}:${rule.rank}`);

  console.log(`\nRules loaded: full TF ${fullTfRules.length} (${ENTRY_TFS_FULL.map((tf) => `${tf}:${fullTfRules.filter((r) => r.tf === tf).length}`).join(", ")})`);
  console.log(`              HTF only ${htfOnlyRules.length} (${ENTRY_TFS_HTF.map((tf) => `${tf}:${htfOnlyRules.filter((r) => r.tf === tf).length}`).join(", ")})`);
  console.log(`              full TF NO 5m baseline ${fullTfNoBaselineRules.length} (excluded: ${excludedRuleIds.join(", ") || "none"})`);

  // Build candidates for each pool
  console.log(`\nBuilding rule candidates (full TF, with Phase 2 LTF confirm)...`);
  const t1 = Date.now();
  const fullTfCandidates = buildRuleCandidates(
    fullTfRules, candlesByTF, seriesByTF, bundlesByEntryTF,
    candles5m, stoch5mSeries, candles15m, srSupportBaseline, srResistanceBaseline,
  );
  console.log(`  full TF candidates: ${fullTfCandidates.length.toLocaleString()} (${((Date.now() - t1) / 1000).toFixed(1)}s)`);

  console.log(`Building rule candidates (HTF only)...`);
  const t2 = Date.now();
  const htfOnlyCandidates = buildRuleCandidates(
    htfOnlyRules, candlesByTF, seriesByTF, bundlesByEntryTF,
    candles5m, stoch5mSeries, candles15m, srSupportBaseline, srResistanceBaseline,
  );
  console.log(`  HTF only candidates: ${htfOnlyCandidates.length.toLocaleString()} (${((Date.now() - t2) / 1000).toFixed(1)}s)`);

  // Mode E candidate pool = full TF candidates with 5m baseline rule sources stripped.
  // Filter from already-built fullTfCandidates (cheaper than rebuilding).
  const fullTfNoBaselineCandidates = fullTfCandidates.filter(
    (c) => !EXCLUDE_5M_BASELINE_IDS.has(c.source),
  );
  console.log(`  full TF NO 5m baseline candidates: ${fullTfNoBaselineCandidates.length.toLocaleString()} (after filtering ${(fullTfCandidates.length - fullTfNoBaselineCandidates.length).toLocaleString()} from ${[...EXCLUDE_5M_BASELINE_IDS].join(",")})`);

  // 5m ALL Engine candidates per preset
  const all5mCandidatesByPreset: Record<PresetKey, Candidate[]> = { WHALE: [], BALANCED: [], TURTLE: [] };
  for (const key of Object.keys(ALL5M_PRESETS) as PresetKey[]) {
    const t = Date.now();
    const preset = ALL5M_PRESETS[key];
    all5mCandidatesByPreset[key] = build5mAllCandidates(preset, candles5m, stoch5mSeries, candles15m);
    console.log(`5m ALL ${key} candidates: ${all5mCandidatesByPreset[key].length.toLocaleString()} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
  }

  // Run modes
  console.log(`\n[Mode A] Full TF rules only (baseline)...`);
  const modeA = runModeSimulation(
    "Mode A",
    "Baseline · Full TF rules + Phase 2 LTF + LIVE PRESET B",
    fullTfCandidates,
    candles5m,
    LIVE_STACK_CFG.perRuleCooldownMin,
  );
  console.log(`  ${modeA.metrics.trades} trades · NET ${modeA.metrics.netPctLev}% · MaxDD -${modeA.metrics.maxDD}% · PF ${modeA.metrics.profitFactor === 999 ? "∞" : modeA.metrics.profitFactor}`);

  for (const key of ["BALANCED", "WHALE", "TURTLE"] as PresetKey[]) {
    const modeName = key === "BALANCED" ? "Mode B" : key === "WHALE" ? "Mode C" : "Mode D";
    const presetEmoji = ALL5M_PRESETS[key].emoji;
    console.log(`\n[${modeName}] HTF rules + 5m ALL ${presetEmoji} ${key}...`);
    // Use 5m ALL preset's own cooldown for the 5mall bucket
    const cdOverrides = { [`5mall:${key}`]: ALL5M_PRESETS[key].cooldownMin };
    const merged = [...htfOnlyCandidates, ...all5mCandidatesByPreset[key]];
    const m = runModeSimulation(
      modeName,
      `HTF rules + 5m ALL ${presetEmoji} ${key} (TP${ALL5M_PRESETS[key].tpPct}/SL${ALL5M_PRESETS[key].slPct}, stoch ${ALL5M_PRESETS[key].stochLongLevel}/${ALL5M_PRESETS[key].stochShortLevel}, cd ${ALL5M_PRESETS[key].cooldownMin}m)`,
      merged,
      candles5m,
      LIVE_STACK_CFG.perRuleCooldownMin,
      cdOverrides,
    );
    console.log(`  ${m.metrics.trades} trades · NET ${m.metrics.netPctLev}% · MaxDD -${m.metrics.maxDD}% · PF ${m.metrics.profitFactor === 999 ? "∞" : m.metrics.profitFactor}`);
    if (modeName === "Mode B") modeBResult = m;
    else if (modeName === "Mode C") modeCResult = m;
    else modeDResult = m;
  }

  console.log(`\n[Mode E] Full TF rules NO 5m baseline (${excludedRuleIds.join(",") || "none excluded"})...`);
  modeEResult = runModeSimulation(
    "Mode E",
    `Full TF rules EXCLUDING 5m baseline (${excludedRuleIds.join(",") || "none"}) + Phase 2 LTF + LIVE PRESET B`,
    fullTfNoBaselineCandidates,
    candles5m,
    LIVE_STACK_CFG.perRuleCooldownMin,
  );
  console.log(`  ${modeEResult.metrics.trades} trades · NET ${modeEResult.metrics.netPctLev}% · MaxDD -${modeEResult.metrics.maxDD}% · PF ${modeEResult.metrics.profitFactor === 999 ? "∞" : modeEResult.metrics.profitFactor}`);

  function strip(m: ModeResult) {
    // Avoid dumping every trade in JSON (would balloon file). Keep summary + curve only.
    return {
      modeName: m.modeName,
      description: m.description,
      totalCandidates: m.totalCandidates,
      blockedByCooldown: m.blockedByCooldown,
      blockedByStack: m.blockedByStack,
      blockedByDd: m.blockedByDd,
      ddPauseTriggers: m.ddPauseTriggers,
      metrics: m.metrics,
      perSource: m.perSource,
    };
  }

  const modes = [modeA, modeBResult!, modeCResult!, modeDResult!, modeEResult!];

  const out = {
    generatedAt: Date.now(),
    config: {
      years: YEARS,
      fee: FEE_PER_SIDE,
      maxHoldBars5mAll: MAX_HOLD_BARS_DEFAULT,
      ltfConfirm: LTF_CFG,
      liveStack: LIVE_STACK_CFG,
      all5mPresets: ALL5M_PRESETS,
      entryTfsFull: ENTRY_TFS_FULL,
      entryTfsHtf: ENTRY_TFS_HTF,
      excludeFor5mBaseline: [...EXCLUDE_5M_BASELINE_IDS],
    },
    periods,
    activeRuleCounts: {
      fullTf: fullTfRules.length,
      htfOnly: htfOnlyRules.length,
      fullTfNoBaseline: fullTfNoBaselineRules.length,
    },
    modes: modes.map(strip),
    modeEvsA: {
      excludedRules: excludedRuleIds,
      deltaNetPctLev: Math.round((modeEResult!.metrics.netPctLev - modeA.metrics.netPctLev) * 100) / 100,
      deltaMaxDD: Math.round((modeEResult!.metrics.maxDD - modeA.metrics.maxDD) * 100) / 100,
      deltaTrades: modeEResult!.metrics.trades - modeA.metrics.trades,
      deltaWinRate: Math.round((modeEResult!.metrics.winRate - modeA.metrics.winRate) * 100) / 100,
      deltaProfitFactor: Math.round((modeEResult!.metrics.profitFactor - modeA.metrics.profitFactor) * 100) / 100,
    },
  };

  const jsonPath = join(__dirname, "..", "assets", "backtest_live_fulltf_5mall_3y.json");
  writeFileSync(jsonPath, JSON.stringify(out, null, 2));
  console.log(`\n💾 JSON: ${jsonPath}`);

  const htmlPath = join(__dirname, "..", "assets", "backtest_live_fulltf_5mall_3y_report.html");
  writeFileSync(htmlPath, renderHtml(modes, periods));
  console.log(`💾 HTML: ${htmlPath}`);

  // Final summary
  console.log(`\n=== Summary ===`);
  console.log(`Mode A (baseline full TF rules): NET ${modeA.metrics.netPctLev}%, MaxDD -${modeA.metrics.maxDD}%, ${modeA.metrics.trades} trades, WR ${modeA.metrics.winRate}%, PF ${modeA.metrics.profitFactor === 999 ? "∞" : modeA.metrics.profitFactor}, Sharpe ${modeA.metrics.sharpeLike}`);
  for (const m of [modeBResult!, modeCResult!, modeDResult!, modeEResult!]) {
    console.log(`${m.modeName} (${m.description.slice(0, 60)}): NET ${m.metrics.netPctLev}%, MaxDD -${m.metrics.maxDD}%, ${m.metrics.trades} trades, WR ${m.metrics.winRate}%, PF ${m.metrics.profitFactor === 999 ? "∞" : m.metrics.profitFactor}, Sharpe ${m.metrics.sharpeLike}`);
  }
  const sortedByNet = [...modes].sort((a, b) => b.metrics.netPctLev - a.metrics.netPctLev);
  const sortedBySharpe = [...modes].sort((a, b) => b.metrics.sharpeLike - a.metrics.sharpeLike);
  const sortedByDd = [...modes].sort((a, b) => a.metrics.maxDD - b.metrics.maxDD);
  console.log(`\nBest by NET:    ${sortedByNet[0].modeName} (${sortedByNet[0].metrics.netPctLev}%)`);
  console.log(`Best by Sharpe: ${sortedBySharpe[0].modeName} (${sortedBySharpe[0].metrics.sharpeLike})`);
  console.log(`Best by MaxDD:  ${sortedByDd[0].modeName} (-${sortedByDd[0].metrics.maxDD}%)`);
  console.log(`\n=== Mode E vs Mode A (5m baseline removal) ===`);
  console.log(`Excluded rules: ${excludedRuleIds.join(",") || "none"}`);
  console.log(`Δ NET   = ${(modeEResult!.metrics.netPctLev - modeA.metrics.netPctLev).toFixed(2)}% lev (E ${modeEResult!.metrics.netPctLev}% vs A ${modeA.metrics.netPctLev}%)`);
  console.log(`Δ MaxDD = ${(modeEResult!.metrics.maxDD - modeA.metrics.maxDD).toFixed(2)}% lev (E -${modeEResult!.metrics.maxDD}% vs A -${modeA.metrics.maxDD}%)`);
  console.log(`Δ Trades = ${modeEResult!.metrics.trades - modeA.metrics.trades} (E ${modeEResult!.metrics.trades} vs A ${modeA.metrics.trades})`);
  console.log(`Δ WR    = ${(modeEResult!.metrics.winRate - modeA.metrics.winRate).toFixed(2)}pp (E ${modeEResult!.metrics.winRate}% vs A ${modeA.metrics.winRate}%)`);
  console.log(`Δ PF    = ${(modeEResult!.metrics.profitFactor - modeA.metrics.profitFactor).toFixed(2)} (E ${modeEResult!.metrics.profitFactor} vs A ${modeA.metrics.profitFactor})`);
})();
