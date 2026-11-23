import { readFile } from "node:fs/promises";

import { calcEMASeries, calcStochRSISeries } from "../utils/indicators";
import {
  aggregateCandles,
  buildStochPoints,
  DAY_MS,
  HOUR_MS,
  WEEK_MS,
  type Candle,
  type StochPoint,
} from "./stochrsi-macro-cycle/core";
import { settleLong, triggeredExitPrice } from "./backtest-4h-entry-lane-7y-fill";
import {
  higherLowReclaim,
  isOversoldEpisodeStart,
  pullbackZoneTouched,
  shouldFireEpisodeEntry,
  shouldFireMacroBackedEntry,
  type EpisodeState,
} from "./pullback-entry-research";

const sourcePath = process.env.PULLBACK_DATA ?? ".cache/binance-futures-btcusdt-1h-7y.json";
const FEE_RATE = 0.0004;
const SLIP_RATE = 0.0002;
const STOP_ATR = Number(process.env.PULLBACK_STOP_ATR ?? "2");
const TARGET_ATR = Number(process.env.PULLBACK_TARGET_ATR ?? "4");
const MAX_HOLD = Math.max(1, Number(process.env.PULLBACK_MAX_HOLD ?? "48"));
const START_MS = process.env.PULLBACK_START ? Date.parse(process.env.PULLBACK_START) : Number.NEGATIVE_INFINITY;
const END_MS = process.env.PULLBACK_END ? Date.parse(process.env.PULLBACK_END) : Number.POSITIVE_INFINITY;

type Mode =
  | "EMA20_RECLAIM"
  | "EMA50_RECLAIM"
  | "PULLBACK_FIRST_TOUCH"
  | "K10_1D_RECOVER"
  | "K20_1D_RECOVER"
  | "K10_4H_RECOVER"
  | "K20_4H_RECOVER"
  | "HL_RECLAIM";

interface Trade {
  entryTime: number;
  exitTime: number;
  pnl: number;
  reason: string;
  delayHours: number;
}

interface Signal {
  index: number;
  touchIndex: number;
}

const ALL_MODES: Mode[] = [
  "EMA20_RECLAIM",
  "EMA50_RECLAIM",
  "PULLBACK_FIRST_TOUCH",
  "K10_1D_RECOVER",
  "K20_1D_RECOVER",
  "K10_4H_RECOVER",
  "K20_4H_RECOVER",
  "HL_RECLAIM",
];

function aggregateFixed(source: Candle[], spanMs: number, asOfMs: number): Candle[] {
  const buckets = new Map<number, Candle[]>();
  for (const bar of source) {
    const start = Math.floor(bar.time / spanMs) * spanMs;
    const bucket = buckets.get(start) ?? [];
    bucket.push(bar);
    buckets.set(start, bucket);
  }
  return [...buckets.entries()]
    .filter(([start, bars]) => {
      if (start + spanMs > asOfMs || bars.length !== spanMs / HOUR_MS) return false;
      return bars.every((bar, index) => bar.time === start + index * HOUR_MS);
    })
    .map(([time, bars]) => ({
      time,
      open: bars[0].open,
      high: Math.max(...bars.map((bar) => bar.high)),
      low: Math.min(...bars.map((bar) => bar.low)),
      close: bars.at(-1)!.close,
      volume: bars.reduce((sum, bar) => sum + bar.volume, 0),
    }));
}

function atrSeries(bars: Candle[], period: number): (number | null)[] {
  const output: (number | null)[] = new Array(bars.length).fill(null);
  for (let index = period; index < bars.length; index += 1) {
    let sum = 0;
    for (let offset = index - period + 1; offset <= index; offset += 1) {
      const previousClose = bars[offset - 1]?.close ?? bars[offset].open;
      const bar = bars[offset];
      sum += Math.max(bar.high - bar.low, Math.abs(bar.high - previousClose), Math.abs(bar.low - previousClose));
    }
    output[index] = sum / period;
  }
  return output;
}

function latestIndexAt(points: StochPoint[], closeTime: number): number {
  let low = 0;
  let high = points.length - 1;
  let result = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (points[middle].closeTime <= closeTime) {
      result = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return result;
}

function pointAt(points: StochPoint[], closeTime: number): StochPoint | null {
  const index = latestIndexAt(points, closeTime);
  return index >= 0 ? points[index] : null;
}

function latestCandleIndexAt(bars: Candle[], closeTime: number): number {
  let low = 0;
  let high = bars.length - 1;
  let result = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (bars[middle].time + 4 * HOUR_MS <= closeTime) {
      result = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return result;
}

function macroBullish(
  closeTime: number,
  weekly: StochPoint[],
  twoWeekly: StochPoint[],
  weeklyEma20: (number | null)[],
): boolean {
  const weeklyIndex = latestIndexAt(weekly, closeTime);
  const twoWeeklyIndex = latestIndexAt(twoWeekly, closeTime);
  if (weeklyIndex < 1 || twoWeeklyIndex < 1) return false;
  const week = weekly[weeklyIndex];
  const priorWeek = weekly[weeklyIndex - 1];
  const twoWeek = twoWeekly[twoWeeklyIndex];
  const weekEma = weeklyEma20[weeklyIndex];
  const priorEma = weeklyEma20[weeklyIndex - 1];
  return weekEma !== null && priorEma !== null && week.close > weekEma && weekEma > priorEma &&
    twoWeek.k !== null && twoWeek.d !== null && twoWeek.k > twoWeek.d &&
    twoWeek.close >= twoWeekly[twoWeeklyIndex - 1].close;
}

function emaReclaimSignal(
  bars: Candle[],
  fourHour: Candle[],
  fourHourPoints: StochPoint[],
  ema: (number | null)[],
  weekly: StochPoint[],
  twoWeekly: StochPoint[],
  weeklyEma20: (number | null)[],
  mode: "EMA20_RECLAIM" | "EMA50_RECLAIM" | "PULLBACK_FIRST_TOUCH",
): Signal[] {
  const signals: Signal[] = [];
  const state: EpisodeState = { active: false, entered: false };
  let lastFourHourIndex = -1;
  let touchIndex = -1;
  for (let index = 1; index < bars.length - 1; index += 1) {
    const closeTime = bars[index].time + HOUR_MS;
    const fourHourIndex = latestIndexAt(fourHourPoints, closeTime);
    if (fourHourIndex < 1) continue;
    const fourBar = fourHour[fourHourIndex];
    const zone = ema[fourHourIndex];
    const priorZone = ema[fourHourIndex - 1];
    if (zone === null || priorZone === null) continue;
    if (fourHourIndex !== lastFourHourIndex) {
      lastFourHourIndex = fourHourIndex;
      if (macroBullish(closeTime, weekly, twoWeekly, weeklyEma20) && pullbackZoneTouched(fourBar.low, fourBar.high, zone)) {
        state.active = true;
        state.entered = false;
        touchIndex = index;
      } else if (state.active && fourBar.close < zone) {
        state.active = false;
        state.entered = false;
      }
    }
    if (!state.active || !macroBullish(closeTime, weekly, twoWeekly, weeklyEma20)) continue;
    const previous = bars[index - 1];
    const triggerReady = mode === "PULLBACK_FIRST_TOUCH"
      ? index === touchIndex
      : previous.close <= priorZone && bars[index].close > zone && bars[index].close > previous.close;
    if (shouldFireEpisodeEntry(state, triggerReady)) {
      signals.push({ index, touchIndex });
      state.entered = true;
    }
  }
  return signals;
}

function stochRecoverySignal(
  bars: Candle[],
  points: StochPoint[],
  weekly: StochPoint[],
  twoWeekly: StochPoint[],
  weeklyEma20: (number | null)[],
  threshold: number,
): Signal[] {
  const signals: Signal[] = [];
  const state: EpisodeState = { active: false, entered: false };
  let previousPointIndex = -1;
  let touchIndex = -1;
  for (let index = 1; index < bars.length - 1; index += 1) {
    const closeTime = bars[index].time + HOUR_MS;
    const pointIndex = latestIndexAt(points, closeTime);
    if (pointIndex < 1 || pointIndex === previousPointIndex) continue;
    previousPointIndex = pointIndex;
    const point = points[pointIndex];
    const previous = points[pointIndex - 1];
    if (point.k === null || previous.k === null) continue;
    if (macroBullish(closeTime, weekly, twoWeekly, weeklyEma20) && isOversoldEpisodeStart(previous.k, point.k, threshold)) {
      state.active = true;
      state.entered = false;
      touchIndex = index;
    } else if (point.k >= threshold) {
      state.active = false;
      state.entered = false;
    }
    const triggerReady = point.k > previous.k;
    if (shouldFireMacroBackedEntry(state, macroBullish(closeTime, weekly, twoWeekly, weeklyEma20), triggerReady)) {
      signals.push({ index, touchIndex });
      state.entered = true;
    }
  }
  return signals;
}

function higherLowSignal(
  bars: Candle[],
  fourHour: Candle[],
  weekly: StochPoint[],
  twoWeekly: StochPoint[],
  weeklyEma20: (number | null)[],
): Signal[] {
  const signals: Signal[] = [];
  let lastFourHourIndex = -1;
  let active = false;
  let touchIndex = -1;
  for (let index = 1; index < bars.length - 1; index += 1) {
    const closeTime = bars[index].time + HOUR_MS;
    const fourHourIndex = latestCandleIndexAt(fourHour, closeTime);
    if (fourHourIndex === lastFourHourIndex || fourHourIndex < 2) continue;
    lastFourHourIndex = fourHourIndex;
    const current = fourHour[fourHourIndex] ?? fourHour.at(-1);
    const prior = fourHour[fourHourIndex - 1];
    const priorPrior = fourHour[fourHourIndex - 2];
    if (!current || !prior || !priorPrior) continue;
    if (!macroBullish(closeTime, weekly, twoWeekly, weeklyEma20)) {
      active = false;
      continue;
    }
    if (current.low > priorPrior.low && current.low <= prior.high) {
      active = true;
      touchIndex = index;
    }
    if (active && higherLowReclaim(priorPrior.low, priorPrior.high, current.low, current.high) && current.close > prior.high) {
      signals.push({ index, touchIndex });
      active = false;
    }
  }
  return signals;
}

function buildSignals(
  mode: Mode,
  bars: Candle[],
  fourHour: Candle[],
  daily: StochPoint[],
  fourHourPoints: StochPoint[],
  weekly: StochPoint[],
  twoWeekly: StochPoint[],
  weeklyEma20: (number | null)[],
  ema20: (number | null)[],
  ema50: (number | null)[],
): Signal[] {
  if (mode === "EMA20_RECLAIM" || mode === "PULLBACK_FIRST_TOUCH") {
    return emaReclaimSignal(bars, fourHour, fourHourPoints, ema20, weekly, twoWeekly, weeklyEma20, mode);
  }
  if (mode === "EMA50_RECLAIM") {
    return emaReclaimSignal(bars, fourHour, fourHourPoints, ema50, weekly, twoWeekly, weeklyEma20, mode);
  }
  if (mode === "K10_1D_RECOVER" || mode === "K20_1D_RECOVER") {
    return stochRecoverySignal(bars, daily, weekly, twoWeekly, weeklyEma20, mode === "K10_1D_RECOVER" ? 10 : 20);
  }
  if (mode === "K10_4H_RECOVER" || mode === "K20_4H_RECOVER") {
    return stochRecoverySignal(bars, fourHourPoints, weekly, twoWeekly, weeklyEma20, mode === "K10_4H_RECOVER" ? 10 : 20);
  }
  return higherLowSignal(bars, fourHour, weekly, twoWeekly, weeklyEma20);
}

function replay(bars: Candle[], signals: Signal[], atr: (number | null)[]): Trade[] {
  const trades: Trade[] = [];
  let blockedUntil = -1;
  for (const signal of signals) {
    const entryIndex = signal.index + 1;
    if (entryIndex >= bars.length || entryIndex <= blockedUntil || atr[signal.index] === null) continue;
    if (bars[entryIndex].time < START_MS || bars[entryIndex].time > END_MS) continue;
    const entry = bars[entryIndex].open;
    const stop = entry - STOP_ATR * atr[signal.index]!;
    const target = entry + TARGET_ATR * atr[signal.index]!;
    const finalIndex = Math.min(bars.length - 1, entryIndex + MAX_HOLD);
    let exitIndex = finalIndex;
    let reason = "MAX_HOLD";
    for (let index = entryIndex; index <= finalIndex; index += 1) {
      const bar = bars[index];
      if (bar.open <= stop || bar.low <= stop) {
        exitIndex = index;
        reason = "SL";
        break;
      }
      if (bar.open >= target || bar.high >= target) {
        exitIndex = index;
        reason = "TP";
        break;
      }
    }
    const exit = reason === "SL" || reason === "TP"
      ? triggeredExitPrice(reason, bars[exitIndex].open, reason === "SL" ? stop : target)
      : bars[exitIndex].open;
    trades.push({
      entryTime: bars[entryIndex].time,
      exitTime: bars[exitIndex].time,
      pnl: settleLong(entry, exit, FEE_RATE, SLIP_RATE),
      reason,
      delayHours: Math.max(0, (bars[signal.index].time - bars[signal.touchIndex].time) / HOUR_MS),
    });
    blockedUntil = exitIndex;
  }
  return trades;
}

function report(mode: Mode, trades: Trade[]): void {
  const wins = trades.filter((trade) => trade.pnl > 0);
  const gains = wins.reduce((sum, trade) => sum + trade.pnl, 0);
  const losses = -trades.filter((trade) => trade.pnl < 0).reduce((sum, trade) => sum + trade.pnl, 0);
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const trade of trades) {
    equity += trade.pnl;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }
  const ordered = [...trades].sort((left, right) => right.pnl - left.pnl);
  const withoutBest = equity - (ordered[0]?.pnl ?? 0);
  const years = new Map<number, number>();
  for (const trade of trades) {
    const year = new Date(trade.entryTime).getUTCFullYear();
    years.set(year, (years.get(year) ?? 0) + trade.pnl);
  }
  const delays = trades.map((trade) => trade.delayHours).sort((left, right) => left - right);
  const medianDelay = delays.length ? delays[Math.floor(delays.length / 2)] : 0;
  console.log(`${mode}: n=${trades.length} WR=${trades.length ? (wins.length / trades.length * 100).toFixed(1) : "0.0"}% PF=${losses ? (gains / losses).toFixed(2) : "inf"} netR=${equity.toFixed(3)} withoutBest=${withoutBest.toFixed(3)} maxDD=${maxDd.toFixed(3)} medianDelayH=${medianDelay.toFixed(1)} years=${JSON.stringify(Object.fromEntries(years))}`);
}

async function main(): Promise<void> {
  const raw = JSON.parse(await readFile(sourcePath, "utf8")) as Array<Record<string, number>>;
  const hourly = raw.map((row) => ({
    time: Number(row.time),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
  } satisfies Candle)).sort((left, right) => left.time - right.time);
  if (hourly.length < 200) throw new Error(`Not enough hourly candles: ${hourly.length}`);
  const asOfMs = hourly.at(-1)!.time + HOUR_MS;
  const fourHour = aggregateFixed(hourly, 4 * HOUR_MS, asOfMs);
  const dailyBars = aggregateCandles(hourly, "1d", asOfMs);
  const weeklyBars = aggregateCandles(hourly, "1w", asOfMs);
  const twoWeeklyBars = aggregateCandles(hourly, "2w", asOfMs);
  const daily = buildStochPoints(dailyBars, DAY_MS);
  const fourHourPoints = buildStochPoints(fourHour, 4 * HOUR_MS);
  const weekly = buildStochPoints(weeklyBars, WEEK_MS);
  const twoWeekly = buildStochPoints(twoWeeklyBars, 2 * WEEK_MS);
  const weeklyEma20 = calcEMASeries(weekly.map((point) => point.close), 20);
  const ema20 = calcEMASeries(fourHour.map((bar) => bar.close), 20);
  const ema50 = calcEMASeries(fourHour.map((bar) => bar.close), 50);
  const atr = atrSeries(hourly, 14);
  const modes = process.env.PULLBACK_MODE ? [process.env.PULLBACK_MODE as Mode] : ALL_MODES;
  console.log(`pullback-entry-research: data=${sourcePath} hourly=${hourly.length} 4h=${fourHour.length} 1d=${daily.length} 1w=${weekly.length} 2w=${twoWeekly.length} last=${new Date(asOfMs).toISOString()} stop=${STOP_ATR}ATR target=${TARGET_ATR}ATR hold=${MAX_HOLD} window=${process.env.PULLBACK_START ?? "begin"}..${process.env.PULLBACK_END ?? "end"}`);
  for (const mode of modes) {
    if (!ALL_MODES.includes(mode)) throw new Error(`Unknown PULLBACK_MODE: ${mode}`);
    const signals = buildSignals(mode, hourly, fourHour, daily, fourHourPoints, weekly, twoWeekly, weeklyEma20, ema20, ema50);
    report(mode, replay(hourly, signals, atr));
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
