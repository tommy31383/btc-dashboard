/**
 * backtest-live-rules.ts
 *
 * Backtest TẤT CẢ active rules trong assets/hard_rules.json over 3 năm BTC data,
 * áp dụng đầy đủ logic của LIVE engine:
 *   - Phase 2 LTF confirm (Stoch5m K extreme HOẶC sát S/R 15m)
 *   - SMART STACK gates (max per side, spacing, dist, notional cap)
 *   - Per-rule cooldown 10 phút
 *   - Plan B TP/SL monitor (giả định fill 100%)
 *
 * Hai mode chạy SONG SONG trong cùng 1 lần:
 *   • SOLO  — mỗi rule backtest độc lập (no shared state)
 *   • COMBO — toàn bộ signal sort theo time, share trackedPositions, áp SMART STACK
 *
 * Output:
 *   • assets/live_backtest_3y.json
 *   • assets/live_backtest_3y_report.html
 *
 * Usage:
 *   npx tsx tools/backtest-live-rules.ts
 *   npx tsx tools/backtest-live-rules.ts --years=3 --fee=0.05 --maxHold=200 --confirmWindow=60
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
const MAX_HOLD_OVERRIDE = parseFloat(args.find((a) => a.startsWith("--maxHold="))?.replace("--maxHold=", "") || "200");
const CONFIRM_WINDOW = parseFloat(args.find((a) => a.startsWith("--confirmWindow="))?.replace("--confirmWindow=", "") || "60");

// LIVE-matching defaults (xem utils/liveTraderEngine.ts DEFAULT_SETTINGS)
// Anh Tommy có thể override qua CLI: --stackMax=30 --stackNotional=100000 ...
const STACK_CFG = {
  stackMaxPerSide: parseFloat(args.find((a) => a.startsWith("--stackMax="))?.replace("--stackMax=", "") || "15"),
  stackPerSideSpacingMin: parseFloat(args.find((a) => a.startsWith("--stackSpacing="))?.replace("--stackSpacing=", "") || "10"),
  stackMinEntryDistPct: parseFloat(args.find((a) => a.startsWith("--stackDist="))?.replace("--stackDist=", "") || "0.3"),
  stackMaxNotionalUsd: parseFloat(args.find((a) => a.startsWith("--stackNotional="))?.replace("--stackNotional=", "") || "50000"),
  perRuleCooldownMin: 10,
  marginUsd: 1,
  leverage: 100, // mỗi entry: 1 × 100 = $100 notional
};

const LTF_CFG: LtfConfirmConfig = {
  ...DEFAULT_LTF_CONFIRM,
  stochOSLevel: 20,
  stochObLevel: 80,
  srProximityPct: 0.4,
  maxWaitBars: CONFIRM_WINDOW,
};

// ENTRY TFs — TẤT CẢ TF có rule trong hard_rules.json (anh Tommy v4.6.3: thêm 1d+1w cho đủ 57 rules)
const ENTRY_TFS = ["5m", "15m", "1h", "4h", "1d", "1w"];

// HTF map (match useRuleAlerts.ts)
const HTF_MAP: Record<string, [string, string]> = {
  "5m": ["15m", "1h"],
  "15m": ["1h", "4h"],
  "1h": ["4h", "1d"],
  "4h": ["1d", "1w"],
  "1d": ["1w", "1w"],
  "1w": ["1w", "1w"],
};

const ALL_TFS = new Set<string>(["5m"]); // 5m luôn cần cho LTF confirm
for (const tf of ENTRY_TFS) {
  ALL_TFS.add(tf);
  HTF_MAP[tf].forEach((h) => ALL_TFS.add(h));
}
ALL_TFS.add("15m"); // S/R pivot

const BARS_PER_YEAR: Record<string, number> = {
  "5m": 365 * 24 * 12,
  "15m": 365 * 24 * 4,
  "1h": 365 * 24,
  "4h": 365 * 6,
  "1d": 365,
  "1w": 52,
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

// ─── S/R 15m precompute ─────────────────────────────────────────────────────
/**
 * Precompute rolling pivot S/R: tại mỗi candle 15m, dùng 50 candle closed phía trước
 * để lấy min(low) làm support, max(high) làm resistance.
 */
function precomputeSR15m(candles15m: Candle[], lookback = SR_LOOKBACK_15M): { support: (number | null)[]; resistance: (number | null)[] } {
  const n = candles15m.length;
  const support: (number | null)[] = new Array(n).fill(null);
  const resistance: (number | null)[] = new Array(n).fill(null);
  for (let i = lookback; i < n; i++) {
    let lo = Infinity, hi = -Infinity;
    // window [i-lookback, i-1] inclusive (loại trừ chính candle i — mimic LIVE pivotSR exclude in-progress bar)
    for (let j = i - lookback; j < i; j++) {
      if (candles15m[j].low < lo) lo = candles15m[j].low;
      if (candles15m[j].high > hi) hi = candles15m[j].high;
    }
    support[i] = lo === Infinity ? null : lo;
    resistance[i] = hi === -Infinity ? null : hi;
  }
  return { support, resistance };
}

/**
 * Lookup S/R 15m tại 1 timestamp bất kỳ — trả về S/R của 15m bar gần nhất ≤ t.
 */
function srAtTime(
  candles15m: Candle[],
  srSupport: (number | null)[],
  srResistance: (number | null)[],
  t: number,
): { support: number | null; resistance: number | null } {
  // Binary search: tìm idx lớn nhất sao cho candles15m[idx].time ≤ t
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

// ─── Trade simulate (TP/SL/timeout) — Plan B monitor mỗi candle ─────────────
interface TradeOutcome {
  ruleId: string;
  tfKey: string;
  side: "LONG" | "SHORT";
  htfFireTime: number;
  entryIdx5m: number;
  entryTime: number;
  entryPrice: number;
  outcome: "WIN" | "LOSS" | "TIMEOUT";
  exitPrice: number;
  pnlPct: number;     // raw price %
  holdBars: number;   // số 5m candle giữ
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

// ─── Detect raw signal at HTF candle i (theo logic useRuleAlerts.ts) ────────
interface RawSignal {
  htfIdx: number;       // index trong entry TF candles
  htfTime: number;
  side: "LONG" | "SHORT";
}

function detectRuleSignals(
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
): RawSignal[] {
  const cfg = rule.config;
  const forceSide = (cfg.forceSide || (rule as any).forceSide) as "LONG" | "SHORT" | undefined;
  const sidesToCheck: ("LONG" | "SHORT")[] = forceSide ? [forceSide] : ["LONG", "SHORT"];
  const closes = entryCandles.map((c) => c.close);
  const signals: RawSignal[] = [];
  // Anh Tommy v4.6.3 fix: chỉ fire khi RISING EDGE (prev=false, curr=true).
  // Trước đây fire mỗi candle match → 1 rule có thể fire 6900 lần/3y, sai logic LIVE.
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

      // Feature filters
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

      // Side này pass tất cả checks → marked match candle này
      matchedThisCandle[side] = true;
      // RISING EDGE: chỉ fire nếu candle TRƯỚC chưa match side này
      if (!prevMatched[side]) {
        signals.push({ htfIdx: i, htfTime: entryCandles[i].time, side });
      }
      break; // 1 candle → 1 side max (giống LIVE)
    }
    // Cuối iteration: update prevMatched theo matchedThisCandle
    // Side không match candle này → reset prev = false để rising edge fire sau khi match lại
    prevMatched.LONG = matchedThisCandle.LONG;
    prevMatched.SHORT = matchedThisCandle.SHORT;
  }
  return signals;
}

// ─── SMART STACK virtual state ──────────────────────────────────────────────
interface VirtualPosition {
  side: "LONG" | "SHORT";
  entryPrice: number;
  qty: number;       // = marginUsd × leverage / entryPrice
  entryMs: number;
  exitMs: number;    // khi nào TP/SL fire → remove
}

/** Mimic checkStackGate from utils/liveTraderEngine.ts */
function checkStackGateVirtual(
  positions: VirtualPosition[],
  side: "LONG" | "SHORT",
  entryPrice: number,
  nowMs: number,
): string | null {
  const sameSide = positions.filter((p) => p.side === side);
  if (sameSide.length >= STACK_CFG.stackMaxPerSide) {
    return `stack full ${sameSide.length}/${STACK_CFG.stackMaxPerSide} ${side}`;
  }
  if (STACK_CFG.stackMaxNotionalUsd > 0) {
    const currentNotional = sameSide.reduce((sum, p) => sum + p.qty * p.entryPrice, 0);
    const newOrderNotional = STACK_CFG.marginUsd * STACK_CFG.leverage;
    if (currentNotional + newOrderNotional > STACK_CFG.stackMaxNotionalUsd) {
      return `notional cap ${side}`;
    }
  }
  if (sameSide.length > 0) {
    const lastSame = sameSide.reduce((a, b) => (a.entryMs > b.entryMs ? a : b));
    if (nowMs - lastSame.entryMs < STACK_CFG.stackPerSideSpacingMin * 60_000) {
      return `spacing ${side}`;
    }
    const distPct = Math.abs(entryPrice - lastSame.entryPrice) / lastSame.entryPrice * 100;
    if (distPct < STACK_CFG.stackMinEntryDistPct) {
      return `dist too close ${side}`;
    }
  }
  return null;
}

// ─── Equity stats (downsample to 100 pts) ───────────────────────────────────
function computeEquityStats(trades: { pnlPct: number }[], leverage: number, fee: number) {
  if (trades.length === 0) return { curve: [], trend: "FLAT" as const, maxDD: 0, netPctLev: 0, profitFactor: 0 };
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

// ─── Per-rule result type ───────────────────────────────────────────────────
interface RuleResult {
  ruleId: string;
  tfKey: string;
  side?: "LONG" | "SHORT";
  ruleName?: string;
  totalSignals: number;
  ltfConfirmed: number;
  blockedByStack: number;
  trades: number;
  wins: number;
  losses: number;
  timeouts: number;
  winRate: number;
  avgWinPct: number;
  avgLossPct: number;
  netPctLev: number;
  profitFactor: number;
  maxDrawdownPct: number;
  avgHoldBars: number;
  equityCurve: number[];
  equityTrend: "UP" | "FLAT" | "DOWN";
}

function summarizeTrades(
  ruleId: string,
  tfKey: string,
  side: "LONG" | "SHORT" | undefined,
  ruleName: string | undefined,
  totalSignals: number,
  ltfConfirmed: number,
  blockedByStack: number,
  trades: TradeOutcome[],
): RuleResult {
  const wins = trades.filter((t) => t.outcome === "WIN").length;
  const losses = trades.filter((t) => t.outcome === "LOSS").length;
  const timeouts = trades.filter((t) => t.outcome === "TIMEOUT").length;
  const winRate = trades.length ? (wins / trades.length) * 100 : 0;
  const avgWinPct = wins ? trades.filter((t) => t.outcome === "WIN").reduce((s, t) => s + t.pnlPct, 0) / wins : 0;
  const avgLossPct = losses ? trades.filter((t) => t.outcome === "LOSS").reduce((s, t) => s + t.pnlPct, 0) / losses : 0;
  const avgHold = trades.length ? trades.reduce((s, t) => s + t.holdBars, 0) / trades.length : 0;
  const eq = computeEquityStats(trades, STACK_CFG.leverage, FEE_PER_SIDE);

  return {
    ruleId,
    tfKey,
    side,
    ruleName,
    totalSignals,
    ltfConfirmed,
    blockedByStack,
    trades: trades.length,
    wins,
    losses,
    timeouts,
    winRate: Math.round(winRate * 100) / 100,
    avgWinPct: Math.round(avgWinPct * 1000) / 1000,
    avgLossPct: Math.round(avgLossPct * 1000) / 1000,
    netPctLev: eq.netPctLev,
    profitFactor: eq.profitFactor,
    maxDrawdownPct: eq.maxDD,
    avgHoldBars: Math.round(avgHold * 10) / 10,
    equityCurve: eq.curve,
    equityTrend: eq.trend,
  };
}

// ─── HTML report ────────────────────────────────────────────────────────────
function sparklineSvg(curve: number[], width = 120, height = 28, color = "#F7931A"): string {
  if (curve.length < 2) return `<svg width="${width}" height="${height}"></svg>`;
  const min = Math.min(...curve, 0);
  const max = Math.max(...curve, 0);
  const range = max - min || 1;
  const pts = curve.map((v, i) => {
    const x = (i / (curve.length - 1)) * width;
    const y = height - ((v - min) / range) * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  // Zero baseline
  const zeroY = height - ((0 - min) / range) * height;
  return `<svg width="${width}" height="${height}" style="display:block">
    <line x1="0" y1="${zeroY.toFixed(1)}" x2="${width}" y2="${zeroY.toFixed(1)}" stroke="#444" stroke-dasharray="2,2" stroke-width="0.5"/>
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.2"/>
  </svg>`;
}

function bigEquitySvg(curve: number[], width = 600, height = 160): string {
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
  return `<svg width="${width}" height="${height}">
    <line x1="0" y1="${zeroY.toFixed(1)}" x2="${width}" y2="${zeroY.toFixed(1)}" stroke="#666" stroke-dasharray="3,3" stroke-width="0.7"/>
    <polyline points="${pts}" fill="none" stroke="#F7931A" stroke-width="1.6"/>
    <text x="4" y="14" fill="#9f8e80" font-size="10">max ${max.toFixed(1)}%</text>
    <text x="4" y="${height - 4}" fill="#9f8e80" font-size="10">min ${min.toFixed(1)}%</text>
  </svg>`;
}

function renderRows(results: RuleResult[], modePrefix: string): string {
  return results.map((r, idx) => {
    const wrColor = r.winRate >= 60 ? "#10b981" : r.winRate >= 45 ? "#ffb874" : "#ffb4ab";
    const netColor = r.netPctLev > 0 ? "#10b981" : "#ffb4ab";
    const pfStr = r.profitFactor === 999 ? "∞" : r.profitFactor.toFixed(2);
    const trendBadge = r.equityTrend === "UP" ? "🟢↑" : r.equityTrend === "DOWN" ? "🔴↓" : "⚪→";
    const detailId = `${modePrefix}-detail-${idx}`;
    const trendSparkColor = r.netPctLev > 0 ? "#10b981" : r.netPctLev < 0 ? "#ffb4ab" : "#F7931A";
    return `<tr class="row" onclick="toggle('${detailId}')">
<td>${r.ruleId}</td>
<td>${r.tfKey}</td>
<td>${r.side || "BOTH"}</td>
<td style="font-size:10px;max-width:180px;overflow:hidden;text-overflow:ellipsis">${(r.ruleName || "").slice(0, 60)}</td>
<td>${r.totalSignals}</td>
<td>${r.ltfConfirmed}</td>
<td style="color:#ffb4ab">${r.blockedByStack}</td>
<td>${r.trades}</td>
<td style="color:${wrColor};font-weight:700">${r.winRate.toFixed(1)}%</td>
<td>${pfStr}</td>
<td>${r.avgHoldBars.toFixed(1)}</td>
<td style="color:${netColor};font-weight:700">${r.netPctLev >= 0 ? "+" : ""}${r.netPctLev.toFixed(0)}%</td>
<td style="color:#ffb4ab">-${r.maxDrawdownPct.toFixed(0)}%</td>
<td>${trendBadge}</td>
<td>${sparklineSvg(r.equityCurve, 120, 28, trendSparkColor)}</td>
</tr>
<tr id="${detailId}" class="detail" style="display:none">
<td colspan="15" style="background:#0f0f0f;padding:14px">
  <div style="display:flex;gap:24px;align-items:center;flex-wrap:wrap">
    <div>${bigEquitySvg(r.equityCurve, 600, 160)}</div>
    <div style="font-size:11px;line-height:1.7;color:#cfc6bc">
      <b style="color:#ffdcc0">${r.ruleId}</b> · ${r.tfKey} · ${r.side || "BOTH"}<br>
      Total signals: ${r.totalSignals}<br>
      LTF confirmed: ${r.ltfConfirmed} (${r.totalSignals ? ((r.ltfConfirmed / r.totalSignals) * 100).toFixed(1) : "0"}%)<br>
      Blocked by SMART STACK: ${r.blockedByStack}<br>
      Trades executed: ${r.trades} (W ${r.wins} / L ${r.losses} / TO ${r.timeouts})<br>
      Avg win raw: +${r.avgWinPct.toFixed(2)}% · Avg loss raw: ${r.avgLossPct.toFixed(2)}%<br>
      NET %lev: ${r.netPctLev.toFixed(2)}% · PF: ${pfStr} · MaxDD: -${r.maxDrawdownPct.toFixed(2)}%<br>
      Equity trend: ${r.equityTrend}
    </div>
  </div>
</td>
</tr>`;
  }).join("\n");
}

function renderHtml(
  solo: RuleResult[],
  combo: RuleResult[],
  comboAggregate: any,
  periods: Record<string, { from: string; to: string; n: number }>,
): string {
  const periodInfo = Object.entries(periods).map(([tf, p]) =>
    `<span><b>${tf}</b>: ${p.n.toLocaleString()} candles · ${p.from} → ${p.to}</span>`
  ).join(" · ");

  const aggSpark = sparklineSvg(comboAggregate.equityCurve || [], 320, 60, "#F7931A");

  return `<!DOCTYPE html>
<html lang="vi"><head><meta charset="UTF-8"/>
<title>LIVE-Logic Backtest 3-Year · BTC Dashboard</title>
<style>
  body { background:#131313; color:#e5e2e1; font-family:'JetBrains Mono','Menlo',monospace; font-size:12px; padding:18px; }
  h1 { color:#F7931A; font-size:18px; letter-spacing:1px; margin:0 0 6px 0; }
  h2 { color:#ffdcc0; font-size:14px; letter-spacing:1px; margin:24px 0 10px 0; border-bottom:1px solid #2a2a2a; padding-bottom:4px; }
  .info { color:#9f8e80; font-size:11px; margin-bottom:16px; line-height:1.7; }
  .card { background:#1a1a1a; border:1px solid #2a2a2a; padding:12px 16px; border-radius:6px; margin-bottom:14px; }
  table { border-collapse:collapse; width:100%; }
  th, td { border:1px solid #2a2a2a; padding:5px 8px; text-align:left; vertical-align:middle; }
  th { background:#1c1b1b; color:#F7931A; font-size:10px; letter-spacing:1px; text-transform:uppercase; cursor:pointer; user-select:none; }
  th:hover { background:#252422; }
  tr.row:nth-child(4n+1) { background:#181818; }
  tr.row:hover { background:#222; cursor:pointer; }
  .legend { color:#9f8e80; font-size:10px; margin-top:10px; line-height:1.6; }
  .agg { display:flex; gap:30px; align-items:center; }
  .stat { color:#cfc6bc; }
  .stat b { color:#ffdcc0; font-size:14px; }
  .pos { color:#10b981; }
  .neg { color:#ffb4ab; }
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
  // group rows in pairs (row + detail). collect main rows only.
  var pairs = [];
  for (var i = 0; i < tbody.rows.length; i += 2) {
    pairs.push([tbody.rows[i], tbody.rows[i+1]]);
  }
  pairs.sort(function(a, b){
    var ax = a[0].cells[colIdx].innerText.replace(/[%+,∞]/g, '').trim();
    var bx = b[0].cells[colIdx].innerText.replace(/[%+,∞]/g, '').trim();
    if (numeric) { return parseFloat(bx) - parseFloat(ax); }
    return ax < bx ? -1 : ax > bx ? 1 : 0;
  });
  pairs.forEach(function(p){ tbody.appendChild(p[0]); tbody.appendChild(p[1]); });
}
</script>
</head>
<body>
<h1>📊 LIVE-LOGIC BACKTEST · 3 YEAR · BTC/USDT</h1>
<div class="info">${periodInfo}<br>
Generated: ${new Date().toISOString()} · Fee/side: ${FEE_PER_SIDE}% · MaxHold: ${MAX_HOLD_OVERRIDE} bars (5m) · Confirm window: ${CONFIRM_WINDOW} bars (5h)<br>
Engine: Phase 2 LTF confirm + SMART STACK gates · Margin $${STACK_CFG.marginUsd} × ${STACK_CFG.leverage}x = $${STACK_CFG.marginUsd * STACK_CFG.leverage} notional/lệnh</div>

<div class="card">
  <h2 style="margin-top:0">⚡ COMBO AGGREGATE (toàn bộ rule chạy chung, share trackedPositions)</h2>
  <div class="agg">
    <div>${aggSpark}</div>
    <div class="stat">Trades: <b>${comboAggregate.trades}</b></div>
    <div class="stat">Win rate: <b class="${comboAggregate.winRate >= 50 ? 'pos' : 'neg'}">${(comboAggregate.winRate || 0).toFixed(1)}%</b></div>
    <div class="stat">NET %lev: <b class="${comboAggregate.netPctLev >= 0 ? 'pos' : 'neg'}">${(comboAggregate.netPctLev || 0).toFixed(0)}%</b></div>
    <div class="stat">PF: <b>${comboAggregate.profitFactor === 999 ? "∞" : (comboAggregate.profitFactor || 0).toFixed(2)}</b></div>
    <div class="stat">MaxDD: <b class="neg">-${(comboAggregate.maxDD || 0).toFixed(0)}%</b></div>
    <div class="stat">W/L: <b>${comboAggregate.wins}/${comboAggregate.losses}</b></div>
  </div>
</div>

<h2>🎯 SOLO MODE — mỗi rule chạy độc lập (no shared state)</h2>
<table id="solo-table">
<thead><tr>
<th onclick="sortTable('solo-table',0,false)">Rule</th>
<th>TF</th><th>Side</th><th>Name</th>
<th onclick="sortTable('solo-table',4,true)">Signals</th>
<th onclick="sortTable('solo-table',5,true)">LTF✓</th>
<th>Stack✗</th>
<th onclick="sortTable('solo-table',7,true)">Trades</th>
<th onclick="sortTable('solo-table',8,true)">WR</th>
<th onclick="sortTable('solo-table',9,true)">PF</th>
<th>AvgHold</th>
<th onclick="sortTable('solo-table',11,true)">NET %lev</th>
<th>MaxDD</th><th>Trend</th><th>Curve</th>
</tr></thead>
<tbody>
${renderRows(solo, "solo")}
</tbody></table>

<h2>🔥 COMBO MODE — toàn bộ rule chạy chung, áp SMART STACK gates</h2>
<table id="combo-table">
<thead><tr>
<th onclick="sortTable('combo-table',0,false)">Rule</th>
<th>TF</th><th>Side</th><th>Name</th>
<th onclick="sortTable('combo-table',4,true)">Signals</th>
<th onclick="sortTable('combo-table',5,true)">LTF✓</th>
<th onclick="sortTable('combo-table',6,true)">Stack✗</th>
<th onclick="sortTable('combo-table',7,true)">Trades</th>
<th onclick="sortTable('combo-table',8,true)">WR</th>
<th onclick="sortTable('combo-table',9,true)">PF</th>
<th>AvgHold</th>
<th onclick="sortTable('combo-table',11,true)">NET %lev</th>
<th>MaxDD</th><th>Trend</th><th>Curve</th>
</tr></thead>
<tbody>
${renderRows(combo, "combo")}
</tbody></table>

<div class="legend">
🟢 WR ≥ 60% · 🟡 45-60% · 🔴 &lt;45% · click row để xem detail equity curve · click header để sort.<br>
SOLO: rule chạy độc lập, signal nào confirm là vào lệnh. COMBO: 1 trackedPositions chung, áp 4 gate (max 15/side, spacing 10m, dist ≥0.3%, notional ≤$50k) + per-rule cooldown 10m.<br>
Plan B TP/SL: monitor mỗi 5m candle, fill 100% khi hit TP/SL (no slippage). Timeout = max ${MAX_HOLD_OVERRIDE} candle 5m.
</div>
</body></html>`;
}

// ─── Main ───────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n=== LIVE-LOGIC BACKTEST 3Y · BTC/USDT ===`);
  console.log(`Years: ${YEARS} · Fee/side: ${FEE_PER_SIDE}% · MaxHold: ${MAX_HOLD_OVERRIDE} (5m bars) · ConfirmWin: ${CONFIRM_WINDOW}`);

  const hard = JSON.parse(readFileSync(join(__dirname, "..", "assets", "hard_rules.json"), "utf8"));

  // Anh Tommy v4.6.7: mô phỏng LIVE excludedTfs default ["5m"] - rule 5m KHÔNG vào lệnh
  // Override: --includeAll để backtest cả 5m
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
  const activeByTf = ENTRY_TFS.map((tf) => {
    const list = hard.tfs[tf]?.rules || [];
    const cnt = list.filter((r: any) => !r.config?.disabled && !r.config?.delegatedTo && !r.stats?.disabledAt && !EXCLUDED_TFS.has(tf)).length;
    return `${tf}:${cnt}`;
  }).join(", ");
  console.log(`Active rules: ${allRules.length} (${activeByTf}) · Skipped ${disabledSkipped} disabled, ${excludedTfSkipped} in excludedTfs (${[...EXCLUDED_TFS].join(",") || "none"})`);
  if (!INCLUDE_ALL) console.log(`  → Use --includeAll to backtest 5m rules too`);

  // Fetch all TFs (with cache)
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

  // Precompute series
  console.log(`\nPrecomputing indicator series...`);
  const seriesByTF: Record<string, IndSeries> = {};
  for (const tf of tfsToFetch) {
    const t0 = Date.now();
    seriesByTF[tf] = precomputeSeries(candlesByTF[tf]);
    console.log(`  ${tf}: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  // S/R 15m (one-shot precompute)
  console.log(`\nPrecomputing S/R 15m (lookback ${SR_LOOKBACK_15M})...`);
  const candles15m = candlesByTF["15m"];
  const { support: srSupport, resistance: srResistance } = precomputeSR15m(candles15m, SR_LOOKBACK_15M);

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

  // ─── Step 1: detect raw signals + LTF confirm cho TỪNG rule ──────────────
  // Mỗi rule produce list of "candidateTrades" — đã pass LTF confirm,
  // mang theo entryIdx5m + entryPrice + tpPct/slPct (raw).
  console.log(`\nDetecting signals + LTF confirm for ${allRules.length} rules...`);

  interface CandidateTrade {
    ruleId: string;
    tfKey: string;
    ruleName?: string;
    side: "LONG" | "SHORT";
    htfTime: number;
    entryIdx5m: number;
    entryTime: number;
    entryPrice: number;
    tpPct: number;
    slPct: number;
    /** Anh Tommy v4.6.5 fix BUG #1: rule.maxHoldBars (HTF unit) → 5m bars để match LIVE Plan B monitor */
    maxHold5m: number;
  }
  // Convert HTF maxHoldBars → 5m bars (LIVE Plan B monitor scan từng tick mark price)
  const TF_TO_5M_MULT: Record<string, number> = {
    "5m": 1, "15m": 3, "1h": 12, "4h": 48, "1d": 288, "1w": 2016,
  };

  interface PerRule {
    ruleId: string;
    tfKey: string;
    ruleName?: string;
    forceSide?: "LONG" | "SHORT";
    totalSignals: number;
    candidates: CandidateTrade[]; // confirmed signals (sau LTF)
  }

  const perRuleData: PerRule[] = [];
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
      rule, tf, entryCandles, entrySeries,
      ctx.bundles, ctx.nearKey, ctx.farKey,
      ctx.nearTrends, ctx.farTrends, ctx.nearRsis, ctx.farRsis,
    );

    // Phase 2 LTF confirm — với mỗi raw signal, tìm 5m candle confirm
    // Anh Tommy v4.6.7 (PA A2): rule 5m/15m SKIP LTF confirm → entry HTF close ngay
    const useLtfConfirm = tf === "1h" || tf === "4h" || tf === "1d" || tf === "1w";
    const candidates: CandidateTrade[] = [];
    for (const sig of rawSignals) {
      let ltfIdx: number | null;
      if (useLtfConfirm) {
        const { support, resistance } = srAtTime(candles15m, srSupport, srResistance, sig.htfTime);
        ltfIdx = findLtfConfirmIndex(
          candles5m, stoch5mSeries, sig.htfTime, sig.side,
          support, resistance, LTF_CFG,
        );
      } else {
        // 5m/15m: entry tại 5m candle ≥ HTF close time (no Phase 2 wait)
        ltfIdx = candles5m.findIndex((c) => c.time >= sig.htfTime);
        if (ltfIdx < 0) ltfIdx = null;
      }
      if (ltfIdx === null) continue;
      const ruleMaxHoldHtf = (rule.config as any).maxHoldBars || 100; // default 100 HTF bars
      const maxHold5m = ruleMaxHoldHtf * (TF_TO_5M_MULT[tf] || 12);
      candidates.push({
        ruleId,
        tfKey: tf,
        ruleName,
        side: sig.side,
        htfTime: sig.htfTime,
        entryIdx5m: ltfIdx,
        entryTime: candles5m[ltfIdx].time,
        entryPrice: candles5m[ltfIdx].close,
        tpPct: rule.config.targetPct,
        slPct: rule.config.stopPct,
        maxHold5m,
      });
    }
    perRuleData.push({
      ruleId, tfKey: tf, ruleName, forceSide,
      totalSignals: rawSignals.length,
      candidates,
    });

    process.stdout.write(`\r  [${n}/${allRules.length}] ${ruleId} ${ruleName?.slice(0, 30)}: ${rawSignals.length} sig → ${candidates.length} confirm (${((Date.now() - t0) / 1000).toFixed(1)}s)             `);
  }
  console.log("");

  // ─── Step 2: SOLO MODE (anh Tommy v4.6.5 fix BUG #2: block-while-position-open) ────
  // Logic LIVE: trong khi 1 lệnh đang OPEN, rule fire lại → không vào lệnh thêm cùng rule.
  // (10m cooldown vẫn giữ nhưng redundant vs block-while-open vì hold trung bình > 10m)
  console.log(`\n[SOLO] simulating trades per rule (block-while-open + 10m cooldown)...`);
  const PER_RULE_COOLDOWN_MS = 10 * 60_000;
  const soloResults: RuleResult[] = [];
  for (const pr of perRuleData) {
    const trades: TradeOutcome[] = [];
    let lastEntryMs = 0;
    let blockedUntilMs = 0; // block-while-open
    let cooldownBlocked = 0;
    for (const c of pr.candidates) {
      // Block while position open (giống LIVE: trackedPositions chứa lệnh same rule chưa exit)
      if (c.entryTime < blockedUntilMs) {
        cooldownBlocked++;
        continue;
      }
      // Per-rule cooldown 10m (LIVE engine decideEntry gate ⑥)
      if (c.entryTime - lastEntryMs < PER_RULE_COOLDOWN_MS) {
        cooldownBlocked++;
        continue;
      }
      const sim = simulateTradeOnLtf(
        candles5m, c.entryIdx5m, c.side, c.entryPrice,
        c.tpPct, c.slPct, c.maxHold5m, // BUG #1 fix: dùng rule.maxHoldBars thật
      );
      trades.push({
        ruleId: c.ruleId, tfKey: c.tfKey, side: c.side,
        htfFireTime: c.htfTime,
        entryIdx5m: c.entryIdx5m, entryTime: c.entryTime,
        entryPrice: c.entryPrice,
        outcome: sim.outcome, exitPrice: sim.exitPrice,
        pnlPct: sim.pnlPct, holdBars: sim.holdBars,
      });
      lastEntryMs = c.entryTime;
      // Tính exit time để block các candidate kế tiếp
      const exitIdx5m = Math.min(c.entryIdx5m + sim.holdBars, candles5m.length - 1);
      blockedUntilMs = candles5m[exitIdx5m].time;
    }
    soloResults.push(summarizeTrades(
      pr.ruleId, pr.tfKey, pr.forceSide, pr.ruleName,
      pr.totalSignals, pr.candidates.length, cooldownBlocked, trades,
    ));
  }

  // ─── Step 3: COMBO MODE ─────────────────────────────────────────────────
  console.log(`\n[COMBO] simulating with SMART STACK gates...`);
  // Flatten + sort all candidates by entryTime (ascending = chronological)
  const allCandidates = perRuleData.flatMap((pr) => pr.candidates).sort((a, b) => a.entryTime - b.entryTime);

  // Track per-rule last entry time (for per-rule cooldown 10m)
  const lastEntryByRule: Record<string, number> = {};
  const tradesByRule: Record<string, TradeOutcome[]> = {};
  const blockedByRule: Record<string, number> = {};
  for (const pr of perRuleData) {
    tradesByRule[pr.ruleId] = [];
    blockedByRule[pr.ruleId] = 0;
  }

  // Anh Tommy v4.6.9: Equity DD Protection — track peak equity, pause khi drop > X%
  // Configurable via CLI: --ddPause=30 (default 30% drop) --ddHours=4 (default 4h pause)
  const EQUITY_DD_PAUSE_PCT = parseFloat(args.find((a) => a.startsWith("--ddPause="))?.replace("--ddPause=", "") || "30");
  const EQUITY_DD_PAUSE_HOURS = parseFloat(args.find((a) => a.startsWith("--ddHours="))?.replace("--ddHours=", "") || "4");
  const startCapital = STACK_CFG.marginUsd * 100; // $100 starting capital
  let cumPnlUsd = 0;
  let peakEquity = startCapital;
  let ddPausedUntilMs = 0;
  let ddPauseTriggers = 0;
  let ddBlockedCount = 0;

  let positions: VirtualPosition[] = [];
  const allComboTrades: TradeOutcome[] = [];

  for (const c of allCandidates) {
    const nowMs = c.entryTime;

    // Equity DD Protection: skip nếu đang trong pause window
    if (EQUITY_DD_PAUSE_PCT > 0 && nowMs < ddPausedUntilMs) {
      ddBlockedCount++;
      continue;
    }

    // Cleanup positions đã exit trước nowMs
    positions = positions.filter((p) => p.exitMs > nowMs);

    // Per-rule cooldown 10m
    const lastFire = lastEntryByRule[c.ruleId];
    if (lastFire && nowMs - lastFire < STACK_CFG.perRuleCooldownMin * 60_000) {
      blockedByRule[c.ruleId]++;
      continue;
    }

    // SMART STACK gates
    const block = checkStackGateVirtual(positions, c.side, c.entryPrice, nowMs);
    if (block) {
      blockedByRule[c.ruleId]++;
      continue;
    }

    // Pass → vào lệnh (BUG #1 fix: dùng rule.maxHold5m)
    const sim = simulateTradeOnLtf(
      candles5m, c.entryIdx5m, c.side, c.entryPrice,
      c.tpPct, c.slPct, c.maxHold5m,
    );
    const exitMs = candles5m[Math.min(c.entryIdx5m + sim.holdBars, candles5m.length - 1)].time;
    const qty = (STACK_CFG.marginUsd * STACK_CFG.leverage) / c.entryPrice;
    positions.push({
      side: c.side,
      entryPrice: c.entryPrice,
      qty,
      entryMs: nowMs,
      exitMs,
    });
    lastEntryByRule[c.ruleId] = nowMs;

    const trade: TradeOutcome = {
      ruleId: c.ruleId, tfKey: c.tfKey, side: c.side,
      htfFireTime: c.htfTime,
      entryIdx5m: c.entryIdx5m, entryTime: c.entryTime,
      entryPrice: c.entryPrice,
      outcome: sim.outcome, exitPrice: sim.exitPrice,
      pnlPct: sim.pnlPct, holdBars: sim.holdBars,
    };
    tradesByRule[c.ruleId].push(trade);
    allComboTrades.push(trade);

    // Update equity tracking + check DD trigger sau khi trade close (exitMs)
    const pnlUsd = sim.pnlPct * STACK_CFG.leverage * STACK_CFG.marginUsd - 2 * FEE_PER_SIDE * STACK_CFG.leverage * STACK_CFG.marginUsd / 100;
    cumPnlUsd += pnlUsd;
    const equity = startCapital + cumPnlUsd;
    peakEquity = Math.max(peakEquity, equity);
    if (EQUITY_DD_PAUSE_PCT > 0 && peakEquity > 0) {
      const ddPct = ((peakEquity - equity) / peakEquity) * 100;
      if (ddPct >= EQUITY_DD_PAUSE_PCT && ddPausedUntilMs < exitMs) {
        ddPausedUntilMs = exitMs + EQUITY_DD_PAUSE_HOURS * 3600_000;
        ddPauseTriggers++;
      }
    }
  }
  console.log(`  Equity DD: ${ddPauseTriggers} pause triggers, ${ddBlockedCount} candidates blocked by DD pause`);

  const comboResults: RuleResult[] = perRuleData.map((pr) => summarizeTrades(
    pr.ruleId, pr.tfKey, pr.forceSide, pr.ruleName,
    pr.totalSignals, pr.candidates.length,
    blockedByRule[pr.ruleId],
    tradesByRule[pr.ruleId],
  ));

  // Aggregate combo (sort theo entryTime — already in order)
  const aggSorted = [...allComboTrades].sort((a, b) => a.entryTime - b.entryTime);
  const aggEq = computeEquityStats(aggSorted, STACK_CFG.leverage, FEE_PER_SIDE);
  const aggWins = aggSorted.filter((t) => t.outcome === "WIN").length;
  const aggLosses = aggSorted.filter((t) => t.outcome === "LOSS").length;
  const comboAggregate = {
    trades: aggSorted.length,
    wins: aggWins,
    losses: aggLosses,
    winRate: aggSorted.length ? (aggWins / aggSorted.length) * 100 : 0,
    netPctLev: aggEq.netPctLev,
    profitFactor: aggEq.profitFactor,
    maxDD: aggEq.maxDD,
    equityCurve: aggEq.curve,
  };

  // Sort cho UI: theo netPctLev desc
  soloResults.sort((a, b) => b.netPctLev - a.netPctLev);
  comboResults.sort((a, b) => b.netPctLev - a.netPctLev);

  // ─── Output ─────────────────────────────────────────────────────────────
  const out = {
    generatedAt: Date.now(),
    config: {
      years: YEARS,
      fee: FEE_PER_SIDE,
      maxHoldBars: MAX_HOLD_OVERRIDE,
      ltfConfirm: LTF_CFG,
      stackGates: STACK_CFG,
    },
    periods,
    solo: soloResults,
    combo: comboResults,
    comboAggregate,
  };

  const jsonPath = join(__dirname, "..", "assets", "live_backtest_3y.json");
  writeFileSync(jsonPath, JSON.stringify(out, null, 2));
  console.log(`\n💾 JSON: ${jsonPath}`);

  const htmlPath = join(__dirname, "..", "assets", "live_backtest_3y_report.html");
  writeFileSync(htmlPath, renderHtml(soloResults, comboResults, comboAggregate, periods));
  console.log(`💾 HTML: ${htmlPath}`);

  // Summary
  const soloProfitable = soloResults.filter((r) => r.netPctLev > 0).length;
  const comboProfitable = comboResults.filter((r) => r.netPctLev > 0).length;
  console.log(`\nSummary:`);
  console.log(`  SOLO  profitable: ${soloProfitable}/${soloResults.length}`);
  console.log(`  COMBO profitable: ${comboProfitable}/${comboResults.length}`);
  console.log(`  COMBO aggregate: ${comboAggregate.trades} trades, WR ${comboAggregate.winRate.toFixed(1)}%, NET ${comboAggregate.netPctLev.toFixed(0)}%, PF ${comboAggregate.profitFactor === 999 ? "∞" : comboAggregate.profitFactor.toFixed(2)}, MaxDD -${comboAggregate.maxDD.toFixed(0)}%`);
  console.log(`  Top 5 SOLO by NET %lev:`);
  soloResults.slice(0, 5).forEach((r) => console.log(`    ${r.ruleId} ${r.side || "BOTH"}: NET ${r.netPctLev.toFixed(0)}%, WR ${r.winRate.toFixed(1)}%, ${r.trades}T`));
})();
