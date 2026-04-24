/**
 * backtest-active-3y.ts
 *
 * Backtest TẤT CẢ active rules (15m / 1h / 4h) trong assets/hard_rules.json
 * trên 3 năm dữ liệu Binance BTCUSDT.
 *
 * - Dùng precomputed indicator series (O(N) thay vì O(N²)) → chạy nhanh
 * - Hỗ trợ HTF filters (legacy + extensible schema) — dùng lại logic
 *   từ tools/backtest-my-rule.ts
 * - Output:
 *   • assets/backtest_active_3y.json — raw data
 *   • assets/backtest_active_3y_report.html — bảng đẹp, sort theo NET PnL
 *
 * Usage:
 *   npx tsx tools/backtest-active-3y.ts
 *   npx tsx tools/backtest-active-3y.ts --years=3 --fee=0.05
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { Candle, EntryConditions, BacktestConfig } from "../utils/backtester";
import {
  calcRSISeriesAligned,
  calcStochRSISeries,
  calcMACDSeries,
  calcBollingerSeries,
} from "../utils/indicators";

const BINANCE_REST = "https://api.binance.com/api/v3";

// ─── CLI ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const YEARS = parseFloat(args.find((a) => a.startsWith("--years="))?.replace("--years=", "") || "1");
const CAPITAL = parseFloat(args.find((a) => a.startsWith("--capital="))?.replace("--capital=", "") || "10000");
const MARGIN = parseFloat(args.find((a) => a.startsWith("--margin="))?.replace("--margin=", "") || "30");
const LEVERAGE = parseFloat(args.find((a) => a.startsWith("--lev="))?.replace("--lev=", "") || "100");
const FEE_PER_SIDE = parseFloat(args.find((a) => a.startsWith("--fee="))?.replace("--fee=", "") || "0.05");

const ENTRY_TFS = ["5m", "15m", "1h", "4h", "1d", "1w"];
// HTF map (must match scan-tpsl-htf.ts + useRuleAlerts.ts)
const HTF_MAP: Record<string, [string, string]> = {
  "5m": ["15m", "1h"],
  "15m": ["1h", "4h"],
  "1h": ["4h", "1d"],
  "4h": ["1d", "1w"],
  "1d": ["1w", "1w"],
  "1w": ["1w", "1w"],
};
// Set of every TF needed (entry + all HTFs)
const ALL_TFS = new Set<string>();
for (const tf of ENTRY_TFS) {
  ALL_TFS.add(tf);
  HTF_MAP[tf].forEach((h) => ALL_TFS.add(h));
}

// Bars per year (approx)
const BARS_PER_YEAR: Record<string, number> = {
  "5m": 365 * 24 * 12,
  "15m": 365 * 24 * 4,
  "1h": 365 * 24,
  "4h": 365 * 6,
  "1d": 365,
  "1w": 52,
};

const MIN_LOOKBACK = 50;

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

// ─── Fetch klines ───────────────────────────────────────────────────────────
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
    if (!Array.isArray(data) || data.length === 0) break;
    const batch: Candle[] = data.map((k) => ({
      time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
      low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
    }));
    all.unshift(...batch);
    endTime = batch[0].time - 1;
    await new Promise((r) => setTimeout(r, 80));
  }
  // Dedupe + sort
  const byTime = new Map<number, Candle>();
  for (const c of all) byTime.set(c.time, c);
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

// ─── Precomputed indicator series per TF ────────────────────────────────────
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

function precomputeSeries(candles: Candle[]): IndSeries {
  const closes = candles.map((c) => c.close);
  const rsi = calcRSISeriesAligned(closes);
  const stoch = calcStochRSISeries(closes);
  const macd = calcMACDSeries(closes);
  const bb = calcBollingerSeries(closes);
  const ema50 = calcEMASeries(closes, 50);
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

// Divergence at idx using precomputed RSI (look at last 30 of price+rsi)
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

// HTF trend at idx (entry-aligned)
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

// Map entry idx → most-recent HTF idx
function buildHTFAlignment(entryCandles: Candle[], htfCandles: Candle[]): number[] {
  const out: number[] = new Array(entryCandles.length).fill(-1);
  let j = 0;
  for (let i = 0; i < entryCandles.length; i++) {
    while (j + 1 < htfCandles.length && htfCandles[j + 1].time <= entryCandles[i].time) j++;
    if (htfCandles[j] && htfCandles[j].time <= entryCandles[i].time) out[i] = j;
  }
  return out;
}

// Bundle per HTF (used in htfFilters[])
interface HtfBundle {
  series: IndSeries;
  alignment: number[];
  trends: Trend[];
}

// HTF RSI per entry candle
function buildHTFRsiAtEntry(alignment: number[], htfRsi: (number | null)[]): (number | null)[] {
  return alignment.map((idx) => (idx >= 0 ? htfRsi[idx] : null));
}

// ─── Filter eval ────────────────────────────────────────────────────────────
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

// ─── Trade simulate ─────────────────────────────────────────────────────────
interface TradeOutcome { entryIdx: number; entryTime: number; side: "LONG" | "SHORT"; entryPrice: number; outcome: "WIN" | "LOSS" | "TIMEOUT"; exitPrice: number; pnlPct: number; holdBars: number; }

function simulateTrade(candles: Candle[], entryIdx: number, side: "LONG" | "SHORT", cfg: BacktestConfig): TradeOutcome {
  const entryPrice = candles[entryIdx].close;
  const maxIdx = Math.min(entryIdx + cfg.maxHoldBars, candles.length - 1);
  for (let i = entryIdx + 1; i <= maxIdx; i++) {
    const c = candles[i];
    const highPct = ((c.high - entryPrice) / entryPrice) * 100;
    const lowPct = ((c.low - entryPrice) / entryPrice) * 100;
    if (side === "LONG") {
      if (lowPct <= -cfg.stopPct)
        return { entryIdx, entryTime: candles[entryIdx].time, side, entryPrice, outcome: "LOSS", exitPrice: entryPrice * (1 - cfg.stopPct / 100), pnlPct: -cfg.stopPct, holdBars: i - entryIdx };
      if (highPct >= cfg.targetPct)
        return { entryIdx, entryTime: candles[entryIdx].time, side, entryPrice, outcome: "WIN", exitPrice: entryPrice * (1 + cfg.targetPct / 100), pnlPct: cfg.targetPct, holdBars: i - entryIdx };
    } else {
      if (highPct >= cfg.stopPct)
        return { entryIdx, entryTime: candles[entryIdx].time, side, entryPrice, outcome: "LOSS", exitPrice: entryPrice * (1 + cfg.stopPct / 100), pnlPct: -cfg.stopPct, holdBars: i - entryIdx };
      if (lowPct <= -cfg.targetPct)
        return { entryIdx, entryTime: candles[entryIdx].time, side, entryPrice, outcome: "WIN", exitPrice: entryPrice * (1 - cfg.targetPct / 100), pnlPct: cfg.targetPct, holdBars: i - entryIdx };
    }
  }
  const finalPct = side === "LONG"
    ? ((candles[maxIdx].close - entryPrice) / entryPrice) * 100
    : ((entryPrice - candles[maxIdx].close) / entryPrice) * 100;
  return { entryIdx, entryTime: candles[entryIdx].time, side, entryPrice, outcome: "TIMEOUT", exitPrice: candles[maxIdx].close, pnlPct: finalPct, holdBars: maxIdx - entryIdx };
}

// ─── Per-rule backtest ──────────────────────────────────────────────────────
interface RuleResult {
  rank: number; source: string; label: string; tfKey: string;
  forceSide?: "LONG" | "SHORT" | "BOTH";
  trades: number; wins: number; losses: number; timeouts: number;
  winRate: number; profitFactor: number; avgHold: number;
  netPnL: number; grossPnL: number;
  equityCurve: number[];           // cumulative NET % per trade, downsampled to ≤100 pts
  equityTrend: "UP" | "FLAT" | "DOWN"; // slope of last 30% vs earlier
  maxDrawdownPct: number;          // largest peak-to-trough drop in NET %
  // Compare with stored stats from hard_rules.json
  storedWR: number | null; storedPF: number | null; storedTrades: number | null;
  // Per-trade detail for portfolio simulation (entry/exit timestamps + raw pnl%)
  tradesDetail?: { entryTime: number; exitTime: number; side: "LONG" | "SHORT"; pnlPct: number; outcome: "WIN" | "LOSS" | "TIMEOUT" }[];
}

/** Build equity curve, drawdown, and trend label from raw trade list. */
function computeEquityStats(
  trades: { pnlPct: number }[],
  leverage: number,
  feePerSide: number,
): { curve: number[]; trend: "UP" | "FLAT" | "DOWN"; maxDD: number } {
  if (trades.length === 0) return { curve: [], trend: "FLAT", maxDD: 0 };
  const perTradeNet = trades.map((t) => t.pnlPct * leverage - feePerSide * 2 * leverage);
  const cum: number[] = [];
  let running = 0;
  for (const v of perTradeNet) { running += v; cum.push(running); }

  // Drawdown
  let peak = cum[0], maxDD = 0;
  for (const v of cum) {
    if (v > peak) peak = v;
    const dd = peak - v;
    if (dd > maxDD) maxDD = dd;
  }

  // Trend: compare avg slope of last 30% vs first 70%
  const n = cum.length;
  let trend: "UP" | "FLAT" | "DOWN" = "FLAT";
  if (n >= 6) {
    const splitIdx = Math.floor(n * 0.7);
    const earlySlope = (cum[splitIdx - 1] - cum[0]) / Math.max(1, splitIdx - 1);
    const lateSlope = (cum[n - 1] - cum[splitIdx - 1]) / Math.max(1, n - splitIdx);
    const range = Math.max(1, Math.abs(cum[n - 1]));
    const lateNorm = lateSlope / range * 100; // % of total per trade
    if (lateSlope > earlySlope * 0.5 && lateNorm > 0.05) trend = "UP";
    else if (lateSlope < 0 && Math.abs(lateNorm) > 0.05) trend = "DOWN";
    else trend = "FLAT";
  } else {
    trend = cum[n - 1] > 0 ? "UP" : cum[n - 1] < 0 ? "DOWN" : "FLAT";
  }

  // Downsample to ≤100 points
  const MAX_PTS = 100;
  let curve: number[];
  if (n <= MAX_PTS) {
    curve = cum.map((v) => Math.round(v));
  } else {
    curve = [];
    for (let i = 0; i < MAX_PTS; i++) {
      const idx = Math.floor((i / (MAX_PTS - 1)) * (n - 1));
      curve.push(Math.round(cum[idx]));
    }
  }
  return { curve, trend, maxDD: Math.round(maxDD) };
}

function backtestOneRule(
  rule: RuleEntry,
  tfKey: string,
  entryCandles: Candle[],
  entrySeries: IndSeries,
  htfBundles: Record<string, HtfBundle>,
  htfNearKey: string,
  htfFarKey: string,
  htfNearTrends: Trend[],
  htfFarTrends: Trend[],
  htfNearRsisAtEntry: (number | null)[],
  htfFarRsisAtEntry: (number | null)[],
): RuleResult {
  const cfg = rule.config;
  const forceSide = (cfg.forceSide || (rule as any).forceSide) as "LONG" | "SHORT" | undefined;
  const sidesToCheck: ("LONG" | "SHORT")[] = forceSide ? [forceSide] : ["LONG", "SHORT"];
  const closes = entryCandles.map((c) => c.close);

  const trades: TradeOutcome[] = [];
  let blockedUntilIdx = -1;

  for (let i = MIN_LOOKBACK; i < entryCandles.length - cfg.maxHoldBars - 1; i++) {
    if (i <= blockedUntilIdx) continue;

    const rsiV = entrySeries.rsi[i];
    const stochKV = entrySeries.stochK[i];
    const bbU = entrySeries.bbUpper[i];
    const bbL = entrySeries.bbLower[i];
    const macdH = entrySeries.macdHist[i];
    const prevMacdH = entrySeries.macdHist[i - 1];
    const price = closes[i];
    if (rsiV === null || stochKV === null || bbU === null || bbL === null || macdH === null || prevMacdH === null) continue;
    const div = detectDivAt(closes, entrySeries.rsi, i);

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

      // HTF trend (legacy)
      const want: Trend = side === "LONG" ? "UP" : "DOWN";
      if ((cfg as any).htfTrendFilter) {
        const f = (cfg as any).htfTrendFilter;
        const mode = f.mode || f;
        if (mode === "near_match" && htfNearTrends[i] !== want) continue;
        if (mode === "far_match" && htfFarTrends[i] !== want) continue;
        if (mode === "both_match" && (htfNearTrends[i] !== want || htfFarTrends[i] !== want)) continue;
      }

      // HTF RSI legacy
      if (cfg.htfRsiFilter) {
        const f = cfg.htfRsiFilter;
        let v: number | null = null;
        if (f.tf === htfNearKey) v = htfNearRsisAtEntry[i];
        else if (f.tf === htfFarKey) v = htfFarRsisAtEntry[i];
        if (v === null || !applyOp(v, f.op, f.value)) continue;
      }

      // Feature filters on entry TF (atr / rsi range / emaDist) — used by GPT high-WR rules
      const cfgX = cfg as any;
      if (cfgX.atrFilter && !evalFeatFilter(entrySeries.atrPct[i], cfgX.atrFilter)) continue;
      if (cfgX.rsiFilter && !evalFeatFilter(rsiV, cfgX.rsiFilter)) continue;
      if (cfgX.emaDistFilter) {
        const ema = entrySeries.ema50[i];
        const dist = ema !== null && ema > 0 ? ((price - ema) / ema) * 100 : null;
        if (!evalFeatFilter(dist, cfgX.emaDistFilter)) continue;
      }
      // bodyPctFilter
      if (cfgX.bodyPctFilter) {
        const c2 = entryCandles[i];
        const body = c2.open ? Math.abs(c2.close - c2.open) / c2.open * 100 : null;
        if (!evalFeatFilter(body, cfgX.bodyPctFilter)) continue;
      }
      // bbPercentFilter
      if (cfgX.bbPercentFilter) {
        const u = entrySeries.bbUpper[i], l = entrySeries.bbLower[i];
        const bbP = (u != null && l != null && u !== l) ? (price - l) / (u - l) : null;
        if (!evalFeatFilter(bbP, cfgX.bbPercentFilter)) continue;
      }
      // reversalFilter — 2-candle pattern (CONT / UP_REV / DOWN_REV)
      if (cfgX.reversalFilter && i >= 1) {
        const prev = entryCandles[i - 1], curr = entryCandles[i];
        const prevBull = prev.close >= prev.open;
        const currBull = curr.close >= curr.open;
        const rev = prevBull === currBull ? "CONT" : (!prevBull && currBull ? "UP_REV" : "DOWN_REV");
        if (rev !== cfgX.reversalFilter.kind) continue;
      }

      // Extensible htfFilters[]
      if (cfg.htfFilters?.length) {
        let ok = true;
        for (const f of cfg.htfFilters) {
          if (!evalHtfFilter(f, htfBundles, i, htfNearKey)) { ok = false; break; }
        }
        if (!ok) continue;
      }

      // Required conditions
      if (cfg.requiredConditions?.length) {
        let ok = true;
        for (const k of cfg.requiredConditions) { if (!conds[k]) { ok = false; break; } }
        if (!ok) continue;
      }

      // Score
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

      const t = simulateTrade(entryCandles, i, side, cfg);
      trades.push(t);
      blockedUntilIdx = i + t.holdBars;
      break;
    }
  }

  const wins = trades.filter((t) => t.outcome === "WIN").length;
  const losses = trades.filter((t) => t.outcome === "LOSS").length;
  const timeouts = trades.filter((t) => t.outcome === "TIMEOUT").length;
  const winRate = trades.length ? (wins / trades.length) * 100 : 0;
  const grossWin = trades.filter((t) => t.pnlPct > 0).reduce((s, t) => s + t.pnlPct, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.pnlPct < 0).reduce((s, t) => s + t.pnlPct, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 999 : 0);
  const avgHold = trades.length ? trades.reduce((s, t) => s + t.holdBars, 0) / trades.length : 0;
  const grossPnL = trades.reduce((s, t) => s + t.pnlPct * cfg.leverage, 0);
  const fee = trades.length * FEE_PER_SIDE * 2 * cfg.leverage;
  const netPnL = grossPnL - fee;
  const eq = computeEquityStats(trades, cfg.leverage, FEE_PER_SIDE);

  return {
    rank: rule.rank,
    source: rule.source,
    label: rule.label || `r${rule.rank}`,
    tfKey,
    forceSide: (forceSide as any) || "BOTH",
    trades: trades.length, wins, losses, timeouts,
    winRate: parseFloat(winRate.toFixed(1)),
    profitFactor: pf === 999 ? 999 : parseFloat(pf.toFixed(2)),
    avgHold: parseFloat(avgHold.toFixed(1)),
    grossPnL: Math.round(grossPnL),
    netPnL: Math.round(netPnL),
    equityCurve: eq.curve,
    equityTrend: eq.trend,
    maxDrawdownPct: eq.maxDD,
    storedWR: rule.stats?.winRate ?? null,
    storedPF: rule.stats?.profitFactor ?? null,
    storedTrades: rule.stats?.trades ?? null,
    tradesDetail: trades.map((t) => {
      const exitIdx = Math.min(t.entryIdx + t.holdBars, entryCandles.length - 1);
      return {
        entryTime: t.entryTime,
        exitTime: entryCandles[exitIdx].time,
        side: t.side,
        pnlPct: t.pnlPct,
        outcome: t.outcome,
      };
    }),
  };
}

// ─── HTML report ────────────────────────────────────────────────────────────
function renderHtml(results: RuleResult[], periods: Record<string, { from: string; to: string; n: number }>): string {
  const rows = results.map((r) => {
    const wrColor = r.winRate >= 60 ? "#10b981" : r.winRate >= 45 ? "#ffb874" : "#ffb4ab";
    const netColor = r.netPnL > 0 ? "#10b981" : "#ffb4ab";
    const pfStr = r.profitFactor === 999 ? "∞" : r.profitFactor.toFixed(2);
    const wrDelta = r.storedWR !== null ? (r.winRate - r.storedWR).toFixed(1) : "—";
    const wrDeltaColor = r.storedWR !== null
      ? (r.winRate - r.storedWR >= -5 ? "#9f8e80" : "#ffb4ab")
      : "#9f8e80";
    return `<tr>
<td>${r.tfKey}</td>
<td>#${r.rank}</td>
<td title="${r.source}">${r.source.slice(0, 10)}</td>
<td style="font-size:10px">${(r.label || "").slice(0, 60)}</td>
<td>${r.forceSide}</td>
<td>${r.trades}</td>
<td style="color:${wrColor};font-weight:700">${r.winRate.toFixed(1)}%</td>
<td style="color:${wrDeltaColor};font-size:10px">${wrDelta}${r.storedWR !== null ? `% (was ${r.storedWR})` : ""}</td>
<td>${pfStr}</td>
<td>${r.avgHold.toFixed(1)}</td>
<td style="color:${netColor};font-weight:700">${r.netPnL >= 0 ? "+" : ""}${r.netPnL}%</td>
</tr>`;
  }).join("\n");

  const periodInfo = Object.entries(periods).map(([tf, p]) =>
    `<span><b>${tf}</b>: ${p.n.toLocaleString()} candles · ${p.from} → ${p.to}</span>`
  ).join(" · ");

  return `<!DOCTYPE html>
<html lang="vi"><head><meta charset="UTF-8"/>
<title>Backtest 3-Year Active Rules · BTC Dashboard</title>
<style>
  body { background:#131313; color:#e5e2e1; font-family:'JetBrains Mono',monospace; font-size:12px; padding:20px; }
  h1 { color:#ffdcc0; font-size:18px; letter-spacing:1px; }
  .info { color:#9f8e80; font-size:11px; margin-bottom:16px; line-height:1.6; }
  table { border-collapse:collapse; width:100%; }
  th, td { border:1px solid #2a2a2a; padding:6px 10px; text-align:left; }
  th { background:#1c1b1b; color:#ffb874; font-size:10px; letter-spacing:1px; text-transform:uppercase; }
  tr:nth-child(even) { background:#1a1a1a; }
  .legend { color:#9f8e80; font-size:10px; margin-top:12px; line-height:1.6; }
</style></head>
<body>
<h1>📊 BACKTEST 3-YEAR · ALL ACTIVE RULES (15m / 1h / 4h)</h1>
<div class="info">${periodInfo}<br>
Sort theo NET PnL giảm dần · Fee per side: ${FEE_PER_SIDE}% · Leverage lấy từ rule config<br>
Generated: ${new Date().toISOString()}</div>
<table>
<tr>
<th>TF</th><th>Rank</th><th>Source</th><th>Label</th><th>Side</th>
<th>Trades</th><th>WR</th><th>WR Δ vs stored</th>
<th>PF</th><th>Avg hold</th><th>NET PnL (×lev)</th>
</tr>
${rows}
</table>
<div class="legend">
🟢 WR ≥ 60% — strong &nbsp;&nbsp; 🟡 WR 45-60% — meh &nbsp;&nbsp; 🔴 WR < 45% — degraded<br>
WR Δ: chênh lệch giữa WR 3-năm vs stored stats. Nếu Δ ≤ -5% → rule có dấu hiệu degrade.<br>
NET PnL = grossPnL × leverage - (trades × fee × 2 × leverage). Có thể âm dù WR cao nếu trades nhiều + fee ăn lời.
</div>
</body></html>`;
}

// ─── Main ───────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n=== BACKTEST 3-YEAR · ACTIVE RULES (15m/1h/4h) ===`);
  const hard = JSON.parse(readFileSync(join(__dirname, "..", "assets", "hard_rules.json"), "utf8"));

  const allRules: { tf: string; rule: RuleEntry }[] = [];
  for (const tf of ENTRY_TFS) {
    if (!hard.tfs[tf]?.rules) continue;
    for (const r of hard.tfs[tf].rules) allRules.push({ tf, rule: r });
  }
  console.log(`Active rules: ${allRules.length} (${ENTRY_TFS.map((tf) => `${tf}:${hard.tfs[tf]?.rules?.length ?? 0}`).join(", ")})`);

  // ─── Fetch all needed TFs ─────────────────────────────────────────────────
  const tfsToFetch = Array.from(ALL_TFS);
  console.log(`\nFetching ${YEARS}-year candles for: ${tfsToFetch.join(", ")}...`);
  const candlesByTF: Record<string, Candle[]> = {};
  for (const tf of tfsToFetch) {
    const target = Math.ceil(BARS_PER_YEAR[tf] * YEARS);
    process.stdout.write(`  ${tf}: target ${target.toLocaleString()} candles... `);
    const t0 = Date.now();
    candlesByTF[tf] = await fetchKlines(tf, target);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`got ${candlesByTF[tf].length.toLocaleString()} (${elapsed}s)`);
  }

  // ─── Precompute series per TF ─────────────────────────────────────────────
  console.log(`\nPrecomputing indicator series...`);
  const seriesByTF: Record<string, IndSeries> = {};
  for (const tf of tfsToFetch) {
    const t0 = Date.now();
    seriesByTF[tf] = precomputeSeries(candlesByTF[tf]);
    console.log(`  ${tf}: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  // ─── Backtest each rule ───────────────────────────────────────────────────
  const periods: Record<string, { from: string; to: string; n: number }> = {};
  for (const tf of ENTRY_TFS) {
    const c = candlesByTF[tf];
    periods[tf] = {
      from: new Date(c[0].time).toISOString().slice(0, 10),
      to: new Date(c[c.length - 1].time).toISOString().slice(0, 10),
      n: c.length,
    };
  }

  console.log(`\nBacktesting ${allRules.length} rules...`);
  const results: RuleResult[] = [];
  // Pre-build HTF bundles per entry-TF (alignment + trends to entry)
  const bundlesByEntryTF: Record<string, { bundles: Record<string, HtfBundle>; nearTrends: Trend[]; farTrends: Trend[]; nearRsis: (number | null)[]; farRsis: (number | null)[] }> = {};
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
    bundlesByEntryTF[tf] = { bundles, nearTrends, farTrends, nearRsis, farRsis };
  }

  let n = 0;
  for (const { tf, rule } of allRules) {
    n++;
    const t0 = Date.now();
    const [nearKey, farKey] = HTF_MAP[tf];
    const ctx = bundlesByEntryTF[tf];
    const res = backtestOneRule(
      rule, tf, candlesByTF[tf], seriesByTF[tf],
      ctx.bundles, nearKey, farKey,
      ctx.nearTrends, ctx.farTrends, ctx.nearRsis, ctx.farRsis,
    );
    results.push(res);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  [${n}/${allRules.length}] ${tf} #${res.rank} ${res.source}: ${res.trades} trades, WR ${res.winRate}%, NET ${res.netPnL >= 0 ? "+" : ""}${res.netPnL}% (${elapsed}s)`);
  }

  // Sort by NET PnL desc
  results.sort((a, b) => b.netPnL - a.netPnL);

  const outJson = {
    generated_at: new Date().toISOString(),
    years: YEARS,
    fee_per_side_pct: FEE_PER_SIDE,
    periods,
    results,
  };
  // ─── PORTFOLIO SIMULATION ───────────────────────────────────────────────
  console.log(`\n=== PORTFOLIO SIM · capital=${CAPITAL}U · margin=${MARGIN}U/lệnh · lev=${LEVERAGE}x ===`);

  // Flatten all trades with rule attribution
  type FlatTrade = {
    entryTime: number; exitTime: number; side: "LONG" | "SHORT"; pnlPct: number;
    outcome: "WIN" | "LOSS" | "TIMEOUT"; ruleKey: string; tf: string; ruleLeverage: number;
  };
  const flatTrades: FlatTrade[] = [];
  for (const r of results) {
    if (!r.tradesDetail) continue;
    const ruleCfg = allRules.find((x) => x.tf === r.tfKey && x.rule.rank === r.rank)?.rule.config;
    const ruleLev = ruleCfg?.leverage ?? 100;
    for (const t of r.tradesDetail) {
      flatTrades.push({
        entryTime: t.entryTime, exitTime: t.exitTime, side: t.side, pnlPct: t.pnlPct,
        outcome: t.outcome, ruleKey: `${r.tfKey}#${r.rank}`, tf: r.tfKey, ruleLeverage: ruleLev,
      });
    }
  }
  flatTrades.sort((a, b) => a.entryTime - b.entryTime);
  console.log(`Total flat trades across ${results.length} rules: ${flatTrades.length.toLocaleString()}`);

  // Event-driven sim: process entries + exits in chrono order
  type Event = { time: number; kind: "ENTRY" | "EXIT"; tradeIdx: number };
  const events: Event[] = [];
  flatTrades.forEach((t, i) => {
    events.push({ time: t.entryTime, kind: "ENTRY", tradeIdx: i });
    events.push({ time: t.exitTime, kind: "EXIT", tradeIdx: i });
  });
  events.sort((a, b) => a.time - b.time || (a.kind === "EXIT" ? -1 : 1));

  // Override leverage if user passed --lev (else use rule's own lev)
  const useUserLev = args.some((a) => a.startsWith("--lev="));

  let cash = CAPITAL;            // free margin
  let lockedMargin = 0;          // sum margin in open trades
  let equity = CAPITAL;
  let peakEquity = CAPITAL;
  let maxDD_USD = 0;
  let maxDD_pct = 0;
  let openCount = 0;
  let maxConcurrent = 0;
  let entries = 0, skippedNoMargin = 0, exitsWin = 0, exitsLoss = 0, exitsTo = 0;
  let liquidations = 0;

  // Per-rule contribution USD
  const ruleContrib: Record<string, { net: number; trades: number; wins: number; losses: number; tf: string }> = {};

  // Equity curve points (downsampled later)
  const equityPoints: { time: number; equity: number; locked: number; openCount: number }[] = [];
  const openByIdx: Record<number, boolean> = {};

  for (const ev of events) {
    const t = flatTrades[ev.tradeIdx];
    if (ev.kind === "ENTRY") {
      if (cash >= MARGIN) {
        cash -= MARGIN;
        lockedMargin += MARGIN;
        openByIdx[ev.tradeIdx] = true;
        openCount++;
        if (openCount > maxConcurrent) maxConcurrent = openCount;
        entries++;
      } else {
        skippedNoMargin++;
        continue; // can't enter — skip this trade entirely
      }
    } else {
      // EXIT: only process if we actually entered this trade
      if (!openByIdx[ev.tradeIdx]) continue;
      delete openByIdx[ev.tradeIdx];
      openCount--;
      lockedMargin -= MARGIN;

      const lev = useUserLev ? LEVERAGE : t.ruleLeverage;
      // PnL_USD = margin × pnlPct × lev / 100, capped at -margin (full liquidation)
      let pnlUSD = MARGIN * t.pnlPct * lev / 100;
      if (pnlUSD < -MARGIN) { pnlUSD = -MARGIN; liquidations++; }
      // Fee: 0.05% × 2 sides × notional = 0.001 × margin × lev
      const feeUSD = MARGIN * lev * (FEE_PER_SIDE / 100) * 2;
      const netUSD = pnlUSD - feeUSD;
      cash += MARGIN + netUSD; // return margin + net pnl

      if (t.outcome === "WIN") exitsWin++;
      else if (t.outcome === "LOSS") exitsLoss++;
      else exitsTo++;

      const k = t.ruleKey;
      if (!ruleContrib[k]) ruleContrib[k] = { net: 0, trades: 0, wins: 0, losses: 0, tf: t.tf };
      ruleContrib[k].net += netUSD;
      ruleContrib[k].trades++;
      if (t.outcome === "WIN") ruleContrib[k].wins++;
      else if (t.outcome === "LOSS") ruleContrib[k].losses++;
    }
    equity = cash + lockedMargin;
    if (equity > peakEquity) peakEquity = equity;
    const ddUSD = peakEquity - equity;
    if (ddUSD > maxDD_USD) {
      maxDD_USD = ddUSD;
      maxDD_pct = (ddUSD / peakEquity) * 100;
    }
    equityPoints.push({ time: ev.time, equity, locked: lockedMargin, openCount });
    if (equity <= 0) {
      console.log(`💀 BANKRUPT at ${new Date(ev.time).toISOString()}`);
      break;
    }
  }

  const finalEquity = equity;
  const roi = ((finalEquity - CAPITAL) / CAPITAL) * 100;
  console.log(`\nFinal equity:        ${finalEquity.toFixed(2)} USD`);
  console.log(`ROI:                 ${roi >= 0 ? "+" : ""}${roi.toFixed(2)}%`);
  console.log(`Peak equity:         ${peakEquity.toFixed(2)} USD`);
  console.log(`Max drawdown (USD):  -${maxDD_USD.toFixed(2)}  (${maxDD_pct.toFixed(2)}%)`);
  console.log(`Trades entered:      ${entries.toLocaleString()}  (skipped no-margin: ${skippedNoMargin})`);
  console.log(`  Wins:              ${exitsWin}  (${entries ? (exitsWin / entries * 100).toFixed(1) : 0}%)`);
  console.log(`  Losses:            ${exitsLoss}`);
  console.log(`  Timeouts:          ${exitsTo}`);
  console.log(`  Liquidations:      ${liquidations}`);
  console.log(`Max concurrent open: ${maxConcurrent}`);

  // Top/bottom rules
  const ruleArr = Object.entries(ruleContrib).map(([k, v]) => ({ key: k, ...v }));
  ruleArr.sort((a, b) => b.net - a.net);
  console.log(`\nTop 5 contributors (USD):`);
  ruleArr.slice(0, 5).forEach((r) => console.log(`  ${r.key.padEnd(10)}  +${r.net.toFixed(2)}U   trades=${r.trades}  WR=${(r.wins/(r.wins+r.losses||1)*100).toFixed(1)}%`));
  console.log(`Bottom 5 contributors (USD):`);
  ruleArr.slice(-5).reverse().forEach((r) => console.log(`  ${r.key.padEnd(10)}  ${r.net >= 0 ? "+" : ""}${r.net.toFixed(2)}U   trades=${r.trades}  WR=${(r.wins/(r.wins+r.losses||1)*100).toFixed(1)}%`));

  // Downsample equity curve to 300 pts
  const MAX_PTS = 300;
  let curve: { t: number; eq: number; locked: number; open: number }[];
  if (equityPoints.length <= MAX_PTS) {
    curve = equityPoints.map((p) => ({ t: p.time, eq: p.equity, locked: p.locked, open: p.openCount }));
  } else {
    curve = [];
    for (let i = 0; i < MAX_PTS; i++) {
      const idx = Math.floor((i / (MAX_PTS - 1)) * (equityPoints.length - 1));
      const p = equityPoints[idx];
      curve.push({ t: p.time, eq: p.equity, locked: p.locked, open: p.openCount });
    }
  }

  // Save
  const portfolioPath = join(__dirname, "..", "assets", "portfolio_backtest_1y.json");
  writeFileSync(portfolioPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    config: { years: YEARS, capital: CAPITAL, marginPerTrade: MARGIN, leverage: LEVERAGE, useUserLev, feePerSidePct: FEE_PER_SIDE },
    summary: {
      finalEquity, roi, peakEquity, maxDD_USD, maxDD_pct,
      entries, skippedNoMargin, wins: exitsWin, losses: exitsLoss, timeouts: exitsTo, liquidations,
      maxConcurrent, ruleCount: results.length, totalRuleTrades: flatTrades.length,
    },
    equityCurve: curve,
    rulesContrib: ruleArr,
  }, null, 2));
  console.log(`\n💾 Portfolio JSON: ${portfolioPath}`);

  // Also dump per-rule analytic JSON (without trade details to keep size sane)
  const outJsonSlim = {
    ...outJson,
    results: results.map((r) => { const { tradesDetail, ...rest } = r; return rest; }),
  };
  const jsonPath = join(__dirname, "..", "assets", "backtest_active_1y.json");
  writeFileSync(jsonPath, JSON.stringify(outJsonSlim, null, 2));
  console.log(`💾 Per-rule JSON: ${jsonPath}`);
})();
