/**
 * backtest-compare-3y.ts
 *
 * So sánh 2 entry strategy SOLO mỗi rule, side-by-side:
 *   • NORMAL — entry NGAY tại HTF close (không Phase 2 LTF confirm)
 *   • LIVE   — Phase 2 LTF confirm (Stoch5m K extreme HOẶC sát S/R 15m), entry tại 5m close
 *
 * Cả 2 đều áp:
 *   - Per-rule cooldown 10m
 *   - Block-while-position-open (1 rule không vào lệnh thêm khi lệnh trước chưa exit)
 *   - Plan B TP/SL monitor mỗi 5m candle
 *
 * Output:
 *   • assets/backtest_compare_3y.json
 *   • assets/backtest_compare_3y_report.html
 *
 * Usage:
 *   npx tsx tools/backtest-compare-3y.ts
 *   npx tsx tools/backtest-compare-3y.ts --years=3 --fee=0.05 --confirmWindow=60
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

const BINANCE_REST = "https://api.binance.com/api/v3";

// ─── CLI ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const YEARS = parseFloat(args.find((a) => a.startsWith("--years="))?.replace("--years=", "") || "3");
const FEE_PER_SIDE = parseFloat(args.find((a) => a.startsWith("--fee="))?.replace("--fee=", "") || "0.05");
const CONFIRM_WINDOW = parseFloat(args.find((a) => a.startsWith("--confirmWindow="))?.replace("--confirmWindow=", "") || "60");

const STACK_CFG = {
  perRuleCooldownMin: 10,
  marginUsd: 1,
  leverage: 100,
};

const LTF_CFG: LtfConfirmConfig = {
  ...DEFAULT_LTF_CONFIRM,
  stochOSLevel: 20,
  stochObLevel: 80,
  srProximityPct: 0.4,
  maxWaitBars: CONFIRM_WINDOW,
};

const ENTRY_TFS = ["5m", "15m", "1h", "4h", "1d", "1w"];

const HTF_MAP: Record<string, [string, string]> = {
  "5m": ["15m", "1h"],
  "15m": ["1h", "4h"],
  "1h": ["4h", "1d"],
  "4h": ["1d", "1w"],
  "1d": ["1w", "1w"],
  "1w": ["1w", "1w"],
};

const ALL_TFS = new Set<string>(["5m"]);
for (const tf of ENTRY_TFS) {
  ALL_TFS.add(tf);
  HTF_MAP[tf].forEach((h) => ALL_TFS.add(h));
}
ALL_TFS.add("15m");

const BARS_PER_YEAR: Record<string, number> = {
  "5m": 365 * 24 * 12,
  "15m": 365 * 24 * 4,
  "1h": 365 * 24,
  "4h": 365 * 6,
  "1d": 365,
  "1w": 52,
};

const TF_TO_5M_MULT: Record<string, number> = {
  "5m": 1, "15m": 3, "1h": 12, "4h": 48, "1d": 288, "1w": 2016,
};

const MIN_LOOKBACK = 50;
const SR_LOOKBACK_15M = 50;

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

// ─── Fetch klines (with disk cache) ─────────────────────────────────────────
async function fetchKlinesRaw(interval: string, total: number): Promise<Candle[]> {
  const all: Candle[] = [];
  let endTime: number | undefined;
  while (all.length < total) {
    const remaining = total - all.length;
    const limit = Math.min(1000, remaining);
    const params = new URLSearchParams({ symbol: "BTCUSDT", interval, limit: String(limit) });
    if (endTime) params.set("endTime", String(endTime));
    const res = await fetch(`${BINANCE_REST}/klines?${params.toString()}`);
    const data: any[] = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;
    const batch: Candle[] = data.map((k) => ({
      time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
      low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
    }));
    all.unshift(...batch);
    endTime = batch[0].time - 1;
    await new Promise((r) => setTimeout(r, 200));
  }
  const byTime = new Map<number, Candle>();
  for (const c of all) byTime.set(c.time, c);
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

async function fetchKlinesCached(interval: string, total: number, years: number): Promise<Candle[]> {
  const cacheDir = join(__dirname, "..", ".cache");
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
  const cachePath = join(cacheDir, `binance-${interval}-${years}y.json`);
  if (existsSync(cachePath)) {
    try {
      const data = JSON.parse(readFileSync(cachePath, "utf8")) as Candle[];
      if (Array.isArray(data) && data.length >= total * 0.9) {
        return data;
      }
    } catch {}
  }
  const fetched = await fetchKlinesRaw(interval, total);
  writeFileSync(cachePath, JSON.stringify(fetched));
  return fetched;
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
function precomputeSR15m(candles15m: Candle[], lookback = SR_LOOKBACK_15M): { support: (number | null)[]; resistance: (number | null)[] } {
  const n = candles15m.length;
  const support: (number | null)[] = new Array(n).fill(null);
  const resistance: (number | null)[] = new Array(n).fill(null);
  for (let i = lookback; i < n; i++) {
    let lo = Infinity, hi = -Infinity;
    for (let j = i - lookback; j < i; j++) {
      if (candles15m[j].low < lo) lo = candles15m[j].low;
      if (candles15m[j].high > hi) hi = candles15m[j].high;
    }
    support[i] = lo === Infinity ? null : lo;
    resistance[i] = hi === -Infinity ? null : hi;
  }
  return { support, resistance };
}

function srAtTime(
  candles15m: Candle[],
  srSupport: (number | null)[],
  srResistance: (number | null)[],
  t: number,
): { support: number | null; resistance: number | null } {
  let lo = 0, hi = candles15m.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles15m[mid].time <= t) {
      idx = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (idx < 0) return { support: null, resistance: null };
  return { support: srSupport[idx], resistance: srResistance[idx] };
}

// ─── Trade simulate ─────────────────────────────────────────────────────────
interface TradeOutcome {
  ruleId: string;
  side: "LONG" | "SHORT";
  entryTime: number;
  entryPrice: number;
  outcome: "WIN" | "LOSS" | "TIMEOUT";
  exitPrice: number;
  pnlPct: number;
  holdBars: number;
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
  const maxIdx = Math.min(entryIdx + maxHoldBars, ltfCandles.length - 1);
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
  const finalPct = side === "LONG"
    ? ((ltfCandles[maxIdx].close - entryPrice) / entryPrice) * 100
    : ((entryPrice - ltfCandles[maxIdx].close) / entryPrice) * 100;
  return { outcome: "TIMEOUT", exitPrice: ltfCandles[maxIdx].close, pnlPct: finalPct, holdBars: maxIdx - entryIdx, exitIdx: maxIdx };
}

// ─── Detect raw HTF rule fires ──────────────────────────────────────────────
interface RawSignal {
  htfIdx: number;
  htfTime: number;
  htfClose: number;
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
        signals.push({ htfIdx: i, htfTime: entryCandles[i].time, htfClose: price, side });
      }
      break;
    }
    prevMatched.LONG = matchedThisCandle.LONG;
    prevMatched.SHORT = matchedThisCandle.SHORT;
  }
  return signals;
}

// ─── Equity stats ───────────────────────────────────────────────────────────
function computeEquityStats(trades: { pnlPct: number }[], leverage: number, fee: number) {
  if (trades.length === 0) return { curve: [] as number[], trend: "FLAT" as const, maxDD: 0, netPctLev: 0, profitFactor: 0 };
  const perTradeNet = trades.map((t) => t.pnlPct * leverage - fee * 2 * leverage);
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

  const MAX_PTS = 100;
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

  return {
    curve,
    trend,
    maxDD: Math.round(maxDD * 100) / 100,
    netPctLev: Math.round(running * 100) / 100,
    profitFactor: profitFactor === 999 ? 999 : Math.round(profitFactor * 100) / 100,
  };
}

// ─── Result types ───────────────────────────────────────────────────────────
interface RuleStats {
  trades: number;
  wins: number;
  losses: number;
  timeouts: number;
  winRate: number;
  netPctLev: number;
  profitFactor: number;
  maxDrawdownPct: number;
  equityCurve: number[];
  equityTrend: "UP" | "FLAT" | "DOWN";
}

interface CompareRule {
  ruleId: string;
  tfKey: string;
  side?: "LONG" | "SHORT";
  ruleName?: string;
  totalSignals: number;
  normal: RuleStats;
  live: RuleStats;
  diff: {
    tradesDelta: number;
    winRateDelta: number;
    netPctLevDelta: number;
    pfDelta: number;
  };
}

function summarizeStats(trades: TradeOutcome[]): RuleStats {
  const wins = trades.filter((t) => t.outcome === "WIN").length;
  const losses = trades.filter((t) => t.outcome === "LOSS").length;
  const timeouts = trades.filter((t) => t.outcome === "TIMEOUT").length;
  const winRate = trades.length ? (wins / trades.length) * 100 : 0;
  const eq = computeEquityStats(trades, STACK_CFG.leverage, FEE_PER_SIDE);
  return {
    trades: trades.length,
    wins,
    losses,
    timeouts,
    winRate: Math.round(winRate * 100) / 100,
    netPctLev: eq.netPctLev,
    profitFactor: eq.profitFactor,
    maxDrawdownPct: eq.maxDD,
    equityCurve: eq.curve,
    equityTrend: eq.trend,
  };
}

// Find first 5m candle index whose time ≥ targetTime (binary search)
function find5mIndexAtOrAfter(candles5m: Candle[], targetTime: number): number {
  let lo = 0, hi = candles5m.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles5m[mid].time >= targetTime) {
      idx = mid;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  return idx;
}

// ─── HTML report ────────────────────────────────────────────────────────────
function sparklineSvg(curve: number[], width = 110, height = 26, color = "#F7931A"): string {
  if (curve.length < 2) return `<svg width="${width}" height="${height}"></svg>`;
  const min = Math.min(...curve, 0);
  const max = Math.max(...curve, 0);
  const range = max - min || 1;
  const pts = curve.map((v, i) => {
    const x = (i / (curve.length - 1)) * width;
    const y = height - ((v - min) / range) * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const zeroY = height - ((0 - min) / range) * height;
  return `<svg width="${width}" height="${height}" style="display:block">
    <line x1="0" y1="${zeroY.toFixed(1)}" x2="${width}" y2="${zeroY.toFixed(1)}" stroke="#444" stroke-dasharray="2,2" stroke-width="0.5"/>
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.2"/>
  </svg>`;
}

function bigCompareSvg(curveA: number[], curveB: number[], width = 700, height = 180): string {
  const all = [...curveA, ...curveB, 0];
  if (all.length < 2) return `<svg width="${width}" height="${height}"></svg>`;
  const min = Math.min(...all);
  const max = Math.max(...all);
  const range = max - min || 1;
  const toPts = (curve: number[]) => curve.map((v, i) => {
    const x = curve.length > 1 ? (i / (curve.length - 1)) * width : 0;
    const y = height - ((v - min) / range) * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const zeroY = height - ((0 - min) / range) * height;
  return `<svg width="${width}" height="${height}">
    <line x1="0" y1="${zeroY.toFixed(1)}" x2="${width}" y2="${zeroY.toFixed(1)}" stroke="#666" stroke-dasharray="3,3" stroke-width="0.7"/>
    ${curveA.length >= 2 ? `<polyline points="${toPts(curveA)}" fill="none" stroke="#F7931A" stroke-width="1.6"/>` : ""}
    ${curveB.length >= 2 ? `<polyline points="${toPts(curveB)}" fill="none" stroke="#10b981" stroke-width="1.6"/>` : ""}
    <text x="6" y="14" fill="#F7931A" font-size="10">NORMAL</text>
    <text x="60" y="14" fill="#10b981" font-size="10">LIVE</text>
    <text x="6" y="${height - 4}" fill="#9f8e80" font-size="10">range ${min.toFixed(1)}% → ${max.toFixed(1)}%</text>
  </svg>`;
}

function deltaCell(delta: number, suffix = "", betterPositive = true): string {
  const good = betterPositive ? delta > 0 : delta < 0;
  const bad = betterPositive ? delta < 0 : delta > 0;
  const color = good ? "#10b981" : bad ? "#ffb4ab" : "#9f8e80";
  const sign = delta > 0 ? "+" : "";
  return `<td style="color:${color};font-weight:700">${sign}${delta.toFixed(2)}${suffix}</td>`;
}

function renderRows(results: CompareRule[]): string {
  return results.map((r, idx) => {
    const detailId = `cmp-detail-${idx}`;
    const wrColor = (wr: number) => wr >= 60 ? "#10b981" : wr >= 45 ? "#ffb874" : "#ffb4ab";
    const netColor = (n: number) => n > 0 ? "#10b981" : "#ffb4ab";
    const pf = (n: number) => n === 999 ? "∞" : n.toFixed(2);
    const N = r.normal, L = r.live;
    const sparkN = sparklineSvg(N.equityCurve, 80, 22, N.netPctLev > 0 ? "#F7931A" : "#ffb4ab");
    const sparkL = sparklineSvg(L.equityCurve, 80, 22, L.netPctLev > 0 ? "#10b981" : "#ffb4ab");
    return `<tr class="row" onclick="toggle('${detailId}')">
<td>${idx + 1}</td>
<td>${r.ruleId}</td>
<td>${r.side || "BOTH"}</td>
<td style="font-size:10px;max-width:160px;overflow:hidden;text-overflow:ellipsis">${(r.ruleName || "").slice(0, 50)}</td>
<td>${r.totalSignals}</td>
<td>${N.trades}</td>
<td style="color:${wrColor(N.winRate)};font-weight:700">${N.winRate.toFixed(1)}%</td>
<td style="color:${netColor(N.netPctLev)};font-weight:700">${N.netPctLev >= 0 ? "+" : ""}${N.netPctLev.toFixed(0)}%</td>
<td>${pf(N.profitFactor)}</td>
<td>${sparkN}</td>
<td>${L.trades}</td>
<td style="color:${wrColor(L.winRate)};font-weight:700">${L.winRate.toFixed(1)}%</td>
<td style="color:${netColor(L.netPctLev)};font-weight:700">${L.netPctLev >= 0 ? "+" : ""}${L.netPctLev.toFixed(0)}%</td>
<td>${pf(L.profitFactor)}</td>
<td>${sparkL}</td>
${deltaCell(r.diff.netPctLevDelta, "%")}
${deltaCell(r.diff.tradesDelta, "", false)}
${deltaCell(r.diff.winRateDelta, "pp")}
</tr>
<tr id="${detailId}" class="detail" style="display:none">
<td colspan="18" style="background:#0f0f0f;padding:14px">
  <div style="display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap">
    <div>${bigCompareSvg(N.equityCurve, L.equityCurve, 700, 180)}</div>
    <div style="font-size:11px;line-height:1.7;color:#cfc6bc">
      <b style="color:#ffdcc0">${r.ruleId}</b> · ${r.tfKey} · ${r.side || "BOTH"}<br>
      <span style="color:#F7931A">NORMAL</span> trades ${N.trades} · WR ${N.winRate.toFixed(1)}% · NET ${N.netPctLev.toFixed(1)}% · PF ${pf(N.profitFactor)} · MaxDD -${N.maxDrawdownPct.toFixed(1)}% · ${N.equityTrend}<br>
      <span style="color:#10b981">LIVE</span>   trades ${L.trades} · WR ${L.winRate.toFixed(1)}% · NET ${L.netPctLev.toFixed(1)}% · PF ${pf(L.profitFactor)} · MaxDD -${L.maxDrawdownPct.toFixed(1)}% · ${L.equityTrend}<br>
      <b>Δ</b> trades ${r.diff.tradesDelta >= 0 ? "+" : ""}${r.diff.tradesDelta} · WR ${r.diff.winRateDelta >= 0 ? "+" : ""}${r.diff.winRateDelta.toFixed(2)}pp · NET ${r.diff.netPctLevDelta >= 0 ? "+" : ""}${r.diff.netPctLevDelta.toFixed(1)}% · PF ${r.diff.pfDelta >= 0 ? "+" : ""}${r.diff.pfDelta.toFixed(2)}
    </div>
  </div>
</td>
</tr>`;
  }).join("\n");
}

function renderHtml(
  results: CompareRule[],
  summary: any,
  periods: Record<string, { from: string; to: string; n: number }>,
): string {
  const periodInfo = Object.entries(periods).map(([tf, p]) =>
    `<span><b>${tf}</b>: ${p.n.toLocaleString()} candles · ${p.from} → ${p.to}</span>`
  ).join(" · ");

  return `<!DOCTYPE html>
<html lang="vi"><head><meta charset="UTF-8"/>
<title>Compare NORMAL vs LIVE Backtest 3y · BTC Dashboard</title>
<style>
  body { background:#131313; color:#e5e2e1; font-family:'JetBrains Mono','Menlo',monospace; font-size:12px; padding:18px; }
  h1 { color:#F7931A; font-size:18px; letter-spacing:1px; margin:0 0 6px 0; }
  h2 { color:#ffdcc0; font-size:14px; letter-spacing:1px; margin:24px 0 10px 0; border-bottom:1px solid #2a2a2a; padding-bottom:4px; }
  .info { color:#9f8e80; font-size:11px; margin-bottom:16px; line-height:1.7; }
  .card { background:#1a1a1a; border:1px solid #2a2a2a; padding:12px 16px; border-radius:6px; margin-bottom:14px; }
  table { border-collapse:collapse; width:100%; }
  th, td { border:1px solid #2a2a2a; padding:5px 7px; text-align:left; vertical-align:middle; }
  th { background:#1c1b1b; color:#F7931A; font-size:10px; letter-spacing:1px; text-transform:uppercase; cursor:pointer; user-select:none; }
  th.normal-h { background:#2a1f12; color:#F7931A; }
  th.live-h { background:#0f2a1d; color:#10b981; }
  th.delta-h { background:#1a1a2a; color:#a8a8ff; }
  th:hover { background:#252422; }
  tr.row:nth-child(4n+1) { background:#181818; }
  tr.row:hover { background:#222; cursor:pointer; }
  .legend { color:#9f8e80; font-size:10px; margin-top:10px; line-height:1.6; }
  .agg { display:flex; gap:24px; align-items:center; flex-wrap:wrap; }
  .stat { color:#cfc6bc; }
  .stat b { color:#ffdcc0; font-size:14px; }
  .pos { color:#10b981; }
  .neg { color:#ffb4ab; }
  .pill { display:inline-block; padding:2px 8px; border-radius:10px; font-size:10px; font-weight:700; }
  .pill-n { background:#2a1f12; color:#F7931A; }
  .pill-l { background:#0f2a1d; color:#10b981; }
</style>
<script>
function toggle(id){
  var el = document.getElementById(id);
  if (!el) return;
  el.style.display = el.style.display === 'none' ? 'table-row' : 'none';
}
function sortTable(tableId, colIdx, numeric){
  var t = document.getElementById(tableId);
  var tbody = t.tBodies[0];
  var pairs = [];
  for (var i = 0; i < tbody.rows.length; i += 2) {
    pairs.push([tbody.rows[i], tbody.rows[i+1]]);
  }
  pairs.sort(function(a, b){
    var ax = a[0].cells[colIdx].innerText.replace(/[%+,∞pP]/g, '').trim();
    var bx = b[0].cells[colIdx].innerText.replace(/[%+,∞pP]/g, '').trim();
    if (numeric) { return parseFloat(bx) - parseFloat(ax); }
    return ax < bx ? -1 : ax > bx ? 1 : 0;
  });
  pairs.forEach(function(p){ tbody.appendChild(p[0]); tbody.appendChild(p[1]); });
}
</script>
</head>
<body>
<h1>📊 COMPARE BACKTEST · NORMAL vs LIVE · 3 YEAR · BTC/USDT</h1>
<div class="info">${periodInfo}<br>
Generated: ${new Date().toISOString()} · Fee/side: ${FEE_PER_SIDE}% · Confirm window: ${CONFIRM_WINDOW} bars (5m)<br>
<span class="pill pill-n">NORMAL</span> entry tại HTF close (no LTF confirm) · <span class="pill pill-l">LIVE</span> chờ Phase 2 LTF confirm (Stoch5m HOẶC S/R 15m ±0.4%)<br>
Cả 2 áp per-rule cooldown 10m + block-while-position-open · Margin $${STACK_CFG.marginUsd} × ${STACK_CFG.leverage}x = $${STACK_CFG.marginUsd * STACK_CFG.leverage} notional/lệnh</div>

<div class="card">
  <h2 style="margin-top:0">⚡ AGGREGATE — toàn bộ ${summary.rulesCount} rule</h2>
  <div class="agg">
    <div class="stat"><span class="pill pill-n">NORMAL</span></div>
    <div class="stat">Trades: <b>${summary.normal.totalTrades}</b></div>
    <div class="stat">Profitable: <b>${summary.normal.profitable}/${summary.rulesCount}</b></div>
    <div class="stat">Total NET: <b class="${summary.normal.totalNet >= 0 ? 'pos' : 'neg'}">${summary.normal.totalNet >= 0 ? "+" : ""}${summary.normal.totalNet.toFixed(0)}%</b></div>
    <div class="stat">Avg WR: <b>${summary.normal.avgWR.toFixed(1)}%</b></div>
  </div>
  <div class="agg" style="margin-top:10px">
    <div class="stat"><span class="pill pill-l">LIVE</span></div>
    <div class="stat">Trades: <b>${summary.live.totalTrades}</b></div>
    <div class="stat">Profitable: <b>${summary.live.profitable}/${summary.rulesCount}</b></div>
    <div class="stat">Total NET: <b class="${summary.live.totalNet >= 0 ? 'pos' : 'neg'}">${summary.live.totalNet >= 0 ? "+" : ""}${summary.live.totalNet.toFixed(0)}%</b></div>
    <div class="stat">Avg WR: <b>${summary.live.avgWR.toFixed(1)}%</b></div>
  </div>
  <div class="agg" style="margin-top:10px">
    <div class="stat"><b>Δ (LIVE - NORMAL)</b></div>
    <div class="stat">Trades: <b class="${summary.live.totalTrades - summary.normal.totalTrades >= 0 ? 'pos' : 'neg'}">${summary.live.totalTrades - summary.normal.totalTrades >= 0 ? "+" : ""}${summary.live.totalTrades - summary.normal.totalTrades}</b></div>
    <div class="stat">NET: <b class="${summary.live.totalNet - summary.normal.totalNet >= 0 ? 'pos' : 'neg'}">${summary.live.totalNet - summary.normal.totalNet >= 0 ? "+" : ""}${(summary.live.totalNet - summary.normal.totalNet).toFixed(0)}%</b></div>
    <div class="stat">Avg WR: <b class="${summary.live.avgWR - summary.normal.avgWR >= 0 ? 'pos' : 'neg'}">${summary.live.avgWR - summary.normal.avgWR >= 0 ? "+" : ""}${(summary.live.avgWR - summary.normal.avgWR).toFixed(2)}pp</b></div>
  </div>
</div>

<h2>🎯 PER-RULE COMPARE — sortable, click row để xem detail equity overlay</h2>
<table id="cmp-table">
<thead><tr>
<th>#</th>
<th onclick="sortTable('cmp-table',1,false)">Rule</th>
<th>Side</th><th>Name</th>
<th onclick="sortTable('cmp-table',4,true)">Signals</th>
<th class="normal-h" onclick="sortTable('cmp-table',5,true)">N Trades</th>
<th class="normal-h" onclick="sortTable('cmp-table',6,true)">N WR</th>
<th class="normal-h" onclick="sortTable('cmp-table',7,true)">N NET</th>
<th class="normal-h" onclick="sortTable('cmp-table',8,true)">N PF</th>
<th class="normal-h">N Curve</th>
<th class="live-h" onclick="sortTable('cmp-table',10,true)">L Trades</th>
<th class="live-h" onclick="sortTable('cmp-table',11,true)">L WR</th>
<th class="live-h" onclick="sortTable('cmp-table',12,true)">L NET</th>
<th class="live-h" onclick="sortTable('cmp-table',13,true)">L PF</th>
<th class="live-h">L Curve</th>
<th class="delta-h" onclick="sortTable('cmp-table',15,true)">Δ NET</th>
<th class="delta-h" onclick="sortTable('cmp-table',16,true)">Δ Trades</th>
<th class="delta-h" onclick="sortTable('cmp-table',17,true)">Δ WR</th>
</tr></thead>
<tbody>
${renderRows(results)}
</tbody></table>

<div class="legend">
🟢 WR ≥ 60% · 🟡 45-60% · 🔴 &lt;45% · click row để xem 2 equity curves overlaid · click header sort.<br>
NORMAL entry HTF close, LIVE wait LTF confirm. Δ cell xanh = LIVE tốt hơn, đỏ = LIVE tệ hơn.<br>
Cả 2 mode SOLO (mỗi rule độc lập), cooldown 10m + block-while-open. Plan B TP/SL: monitor mỗi 5m candle, fill 100% khi hit.
</div>
</body></html>`;
}

// ─── Main ───────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n=== COMPARE BACKTEST 3Y · NORMAL vs LIVE · BTC/USDT ===`);
  console.log(`Years: ${YEARS} · Fee/side: ${FEE_PER_SIDE}% · ConfirmWin: ${CONFIRM_WINDOW}`);

  const hard = JSON.parse(readFileSync(join(__dirname, "..", "assets", "hard_rules.json"), "utf8"));

  const INCLUDE_ALL = args.includes("--includeAll");
  const EXCLUDED_TFS = INCLUDE_ALL ? new Set<string>() : new Set(["5m"]);

  const allRules: { tf: string; rule: RuleEntry }[] = [];
  let disabledSkipped = 0;
  let excludedTfSkipped = 0;
  for (const tf of ENTRY_TFS) {
    if (!hard.tfs[tf]?.rules) continue;
    for (const r of hard.tfs[tf].rules) {
      const cfg = r.config as any;
      if (cfg.disabled === true || cfg.delegatedTo) { disabledSkipped++; continue; }
      if ((r as any).stats?.disabledAt) { disabledSkipped++; continue; }
      if (EXCLUDED_TFS.has(tf)) { excludedTfSkipped++; continue; }
      allRules.push({ tf, rule: r });
    }
  }
  console.log(`Active rules: ${allRules.length} · Skipped ${disabledSkipped} disabled, ${excludedTfSkipped} in excludedTfs`);

  const tfsToFetch = Array.from(ALL_TFS);
  console.log(`\nFetching ${YEARS}-year candles (cached): ${tfsToFetch.join(", ")}...`);
  const candlesByTF: Record<string, Candle[]> = {};
  for (const tf of tfsToFetch) {
    const target = Math.ceil(BARS_PER_YEAR[tf] * YEARS);
    process.stdout.write(`  ${tf}: target ${target.toLocaleString()}... `);
    const t0 = Date.now();
    candlesByTF[tf] = await fetchKlinesCached(tf, target, YEARS);
    console.log(`got ${candlesByTF[tf].length.toLocaleString()} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
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
  const { support: srSupport, resistance: srResistance } = precomputeSR15m(candles15m, SR_LOOKBACK_15M);

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
  for (const tf of ENTRY_TFS) {
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

  // ─── Per-rule: detect signals → simulate BOTH modes ──────────────────────
  console.log(`\nProcessing ${allRules.length} rules (NORMAL + LIVE per rule)...`);
  const PER_RULE_COOLDOWN_MS = 10 * 60_000;

  const compareResults: CompareRule[] = [];
  let n = 0;
  for (const { tf, rule } of allRules) {
    n++;
    const ruleId = `${tf}:${rule.rank}`;
    const ruleName = rule.label || (rule.config as any).label || rule.source;
    const forceSide = (rule.config.forceSide || (rule as any).forceSide) as "LONG" | "SHORT" | undefined;
    const ctx = bundlesByEntryTF[tf];
    const entryCandles = candlesByTF[tf];
    const entrySeries = seriesByTF[tf];

    const t0 = Date.now();
    const rawSignals = detectRuleSignals(
      rule, entryCandles, entrySeries,
      ctx.bundles, ctx.nearKey, ctx.farKey,
      ctx.nearTrends, ctx.farTrends, ctx.nearRsis, ctx.farRsis,
    );

    const ruleMaxHoldHtf = (rule.config as any).maxHoldBars || 100;
    const maxHold5m = ruleMaxHoldHtf * (TF_TO_5M_MULT[tf] || 12);
    const tpPct = rule.config.targetPct;
    const slPct = rule.config.stopPct;

    // ── NORMAL mode: entry tại HTF close → simulate trên 5m bắt đầu từ 5m candle ≥ HTF close time
    const normalTrades: TradeOutcome[] = [];
    {
      let lastEntryMs = 0;
      let blockedUntilMs = 0;
      for (const sig of rawSignals) {
        // HTF close time = sig.htfTime is the OPEN time of HTF candle.
        // Close time = next HTF candle open time. But we just need first 5m bar at-or-after the bar boundary.
        // Use sig.htfTime + (TF length) as close timestamp; safer: use entryCandles[sig.htfIdx+1].time when available.
        const nextHtf = entryCandles[sig.htfIdx + 1];
        const htfCloseTime = nextHtf ? nextHtf.time : sig.htfTime;

        if (htfCloseTime < blockedUntilMs) continue;
        if (htfCloseTime - lastEntryMs < PER_RULE_COOLDOWN_MS) continue;

        const idx5m = find5mIndexAtOrAfter(candles5m, htfCloseTime);
        if (idx5m < 0 || idx5m >= candles5m.length) continue;
        const entryPrice = candles5m[idx5m].close;
        const entryTime = candles5m[idx5m].time;

        const sim = simulateTradeOnLtf(
          candles5m, idx5m, sig.side, entryPrice,
          tpPct, slPct, maxHold5m,
        );
        normalTrades.push({
          ruleId, side: sig.side,
          entryTime, entryPrice,
          outcome: sim.outcome, exitPrice: sim.exitPrice,
          pnlPct: sim.pnlPct, holdBars: sim.holdBars,
        });
        lastEntryMs = entryTime;
        const exitIdx5m = Math.min(idx5m + sim.holdBars, candles5m.length - 1);
        blockedUntilMs = candles5m[exitIdx5m].time;
      }
    }

    // ── LIVE mode: Phase 2 LTF confirm → entry tại 5m close
    const liveTrades: TradeOutcome[] = [];
    {
      let lastEntryMs = 0;
      let blockedUntilMs = 0;
      for (const sig of rawSignals) {
        const { support, resistance } = srAtTime(candles15m, srSupport, srResistance, sig.htfTime);
        const ltfIdx = findLtfConfirmIndex(
          candles5m, stoch5mSeries, sig.htfTime, sig.side,
          support, resistance, LTF_CFG,
        );
        if (ltfIdx === null) continue;
        const entryPrice = candles5m[ltfIdx].close;
        const entryTime = candles5m[ltfIdx].time;

        if (entryTime < blockedUntilMs) continue;
        if (entryTime - lastEntryMs < PER_RULE_COOLDOWN_MS) continue;

        const sim = simulateTradeOnLtf(
          candles5m, ltfIdx, sig.side, entryPrice,
          tpPct, slPct, maxHold5m,
        );
        liveTrades.push({
          ruleId, side: sig.side,
          entryTime, entryPrice,
          outcome: sim.outcome, exitPrice: sim.exitPrice,
          pnlPct: sim.pnlPct, holdBars: sim.holdBars,
        });
        lastEntryMs = entryTime;
        const exitIdx5m = Math.min(ltfIdx + sim.holdBars, candles5m.length - 1);
        blockedUntilMs = candles5m[exitIdx5m].time;
      }
    }

    const normal = summarizeStats(normalTrades);
    const live = summarizeStats(liveTrades);
    compareResults.push({
      ruleId, tfKey: tf, side: forceSide, ruleName,
      totalSignals: rawSignals.length,
      normal, live,
      diff: {
        tradesDelta: live.trades - normal.trades,
        winRateDelta: Math.round((live.winRate - normal.winRate) * 100) / 100,
        netPctLevDelta: Math.round((live.netPctLev - normal.netPctLev) * 100) / 100,
        pfDelta: Math.round(((live.profitFactor === 999 ? 999 : live.profitFactor) - (normal.profitFactor === 999 ? 999 : normal.profitFactor)) * 100) / 100,
      },
    });

    process.stdout.write(`\r  [${n}/${allRules.length}] ${ruleId} ${(ruleName || "").slice(0, 28)}: ${rawSignals.length} sig · N ${normalTrades.length}T NET ${normal.netPctLev.toFixed(0)}% · L ${liveTrades.length}T NET ${live.netPctLev.toFixed(0)}% (${((Date.now() - t0) / 1000).toFixed(1)}s)             `);
  }
  console.log("");

  // Sort by netPctLevDelta desc (biggest LIVE wins first)
  compareResults.sort((a, b) => b.diff.netPctLevDelta - a.diff.netPctLevDelta);

  // ─── Aggregate summary ──────────────────────────────────────────────────
  const normalProfitable = compareResults.filter((r) => r.normal.netPctLev > 0).length;
  const liveProfitable = compareResults.filter((r) => r.live.netPctLev > 0).length;
  const summary = {
    rulesCount: compareResults.length,
    normal: {
      totalTrades: compareResults.reduce((s, r) => s + r.normal.trades, 0),
      profitable: normalProfitable,
      totalNet: Math.round(compareResults.reduce((s, r) => s + r.normal.netPctLev, 0) * 100) / 100,
      avgWR: compareResults.length
        ? Math.round((compareResults.reduce((s, r) => s + r.normal.winRate, 0) / compareResults.length) * 100) / 100
        : 0,
    },
    live: {
      totalTrades: compareResults.reduce((s, r) => s + r.live.trades, 0),
      profitable: liveProfitable,
      totalNet: Math.round(compareResults.reduce((s, r) => s + r.live.netPctLev, 0) * 100) / 100,
      avgWR: compareResults.length
        ? Math.round((compareResults.reduce((s, r) => s + r.live.winRate, 0) / compareResults.length) * 100) / 100
        : 0,
    },
  };

  const out = {
    generatedAt: Date.now(),
    config: {
      years: YEARS,
      fee: FEE_PER_SIDE,
      confirmWindow: CONFIRM_WINDOW,
      ltfConfirm: LTF_CFG,
      perRuleCooldownMin: STACK_CFG.perRuleCooldownMin,
      marginUsd: STACK_CFG.marginUsd,
      leverage: STACK_CFG.leverage,
    },
    periods,
    rules: compareResults,
    summary,
  };

  const jsonPath = join(__dirname, "..", "assets", "backtest_compare_3y.json");
  writeFileSync(jsonPath, JSON.stringify(out, null, 2));
  console.log(`\n💾 JSON: ${jsonPath}`);

  const htmlPath = join(__dirname, "..", "assets", "backtest_compare_3y_report.html");
  writeFileSync(htmlPath, renderHtml(compareResults, summary, periods));
  console.log(`💾 HTML: ${htmlPath}`);

  console.log(`\nSummary:`);
  console.log(`  NORMAL  profitable: ${normalProfitable}/${compareResults.length} · trades ${summary.normal.totalTrades} · totalNET ${summary.normal.totalNet.toFixed(0)}% · avgWR ${summary.normal.avgWR.toFixed(1)}%`);
  console.log(`  LIVE    profitable: ${liveProfitable}/${compareResults.length} · trades ${summary.live.totalTrades} · totalNET ${summary.live.totalNet.toFixed(0)}% · avgWR ${summary.live.avgWR.toFixed(1)}%`);
  console.log(`  Δ (LIVE - NORMAL): trades ${summary.live.totalTrades - summary.normal.totalTrades >= 0 ? "+" : ""}${summary.live.totalTrades - summary.normal.totalTrades} · NET ${summary.live.totalNet - summary.normal.totalNet >= 0 ? "+" : ""}${(summary.live.totalNet - summary.normal.totalNet).toFixed(0)}% · avgWR ${(summary.live.avgWR - summary.normal.avgWR).toFixed(2)}pp`);
  console.log(`\n  Top 5 rules where LIVE beats NORMAL by NET:`);
  compareResults.slice(0, 5).forEach((r) => console.log(`    ${r.ruleId} ${r.side || "BOTH"}: ΔNET ${r.diff.netPctLevDelta >= 0 ? "+" : ""}${r.diff.netPctLevDelta.toFixed(0)}% (N ${r.normal.netPctLev.toFixed(0)}% → L ${r.live.netPctLev.toFixed(0)}%)`));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
