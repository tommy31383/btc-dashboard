import { readFile } from "node:fs/promises";

import { aggregateCandles, buildStochPoints, HOUR_MS, type Candle, type StochPoint } from "./stochrsi-macro-cycle/core";
import { settleLong, triggeredExitPrice } from "./backtest-4h-entry-lane-7y-fill";
import { signalGapAllowed } from "./early-entry-sensitivity";

const sourcePath = process.env.STOCHRSI_HOURLY ?? ".cache/binance-futures-btcusdt-1h-7y.json";
const FOUR_H_MS = 4 * HOUR_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const FEE_RATE = 0.0004;
const SLIP_RATE = 0.0002;
const STOP_ATR = Number(process.env.STOCHRSI_STOP_ATR ?? "1.5");
const TARGET_ATR = Number(process.env.STOCHRSI_TARGET_ATR ?? "3");
const MAX_HOLD = Number(process.env.STOCHRSI_MAX_HOLD ?? "30");
const EXIT_MODE = process.env.STOCHRSI_EXIT_MODE === "TIME" ? "TIME" : "BEAR_CROSS";
const MIN_SIGNAL_GAP = Math.max(0, Number(process.env.STOCHRSI_MIN_SIGNAL_GAP ?? "0"));
const TRADE_START_MS = process.env.STOCHRSI_TRADE_START ? Date.parse(process.env.STOCHRSI_TRADE_START) : Number.NEGATIVE_INFINITY;
const TRADE_END_MS = process.env.STOCHRSI_TRADE_END ? Date.parse(process.env.STOCHRSI_TRADE_END) : Number.POSITIVE_INFINITY;

type Mode = "K10" | "K20" | "K30" | "K10_1D_RISING" | "K10_2W_RISING" | "K20_1D_RISING" | "K20_2W_RISING" | "K20_WEEK_ABOVE_EMA20" | "K20_WEEK_ABOVE_RISING" | "K20_ATR_HIGH";

interface Trade { entryTime: number; exitTime: number; pnl: number; reason: string; }

function aggregate4H(source: Candle[], asOfMs: number): Candle[] {
  const buckets = new Map<number, Candle[]>();
  for (const bar of source) {
    const start = Math.floor(bar.time / FOUR_H_MS) * FOUR_H_MS;
    const bucket = buckets.get(start) ?? [];
    bucket.push(bar);
    buckets.set(start, bucket);
  }
  return [...buckets.entries()]
    .filter(([start, bars]) => start + FOUR_H_MS <= asOfMs && bars.length === 4 && bars[0].time === start && bars[3].time === start + 3 * HOUR_MS)
    .map(([time, bars]) => ({
      time,
      open: bars[0].open,
      high: Math.max(...bars.map((bar) => bar.high)),
      low: Math.min(...bars.map((bar) => bar.low)),
      close: bars[3].close,
      volume: bars.reduce((sum, bar) => sum + bar.volume, 0),
    }));
}

function ema(values: number[], period: number): (number | null)[] {
  const output: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return output;
  let value = values.slice(0, period).reduce((sum, current) => sum + current, 0) / period;
  output[period - 1] = value;
  const alpha = 2 / (period + 1);
  for (let i = period; i < values.length; i += 1) {
    value = values[i] * alpha + value * (1 - alpha);
    output[i] = value;
  }
  return output;
}

function atrSeries(bars: Candle[], period: number): (number | null)[] {
  return bars.map((_, index) => {
    if (index < period) return null;
    const values = bars.slice(index - period + 1, index + 1).map((bar, offset) => {
      const previous = bars[index - period + offset];
      return Math.max(bar.high - bar.low, Math.abs(bar.high - previous.close), Math.abs(bar.low - previous.close));
    });
    return values.reduce((sum, value) => sum + value, 0) / period;
  });
}

function risingAt(points: StochPoint[], closeTime: number): boolean {
  let current: StochPoint | undefined;
  let previous: StochPoint | undefined;
  for (const point of points) {
    if (point.closeTime > closeTime) break;
    previous = current;
    current = point;
  }
  return current?.k !== null && current?.k !== undefined && previous?.k !== null && previous?.k !== undefined && current.k > previous.k;
}

function currentAt(points: StochPoint[], closeTime: number): StochPoint | undefined {
  let current: StochPoint | undefined;
  for (const point of points) {
    if (point.closeTime > closeTime) break;
    current = point;
  }
  return current;
}

function signals(
  points: StochPoint[],
  daily: StochPoint[],
  twoWeekly: StochPoint[],
  weekly: StochPoint[],
  weeklyEma20: (number | null)[],
  atr: (number | null)[],
  mode: Mode,
): number[] {
  const threshold = mode === "K10" || mode === "K10_1D_RISING" || mode === "K10_2W_RISING" ? 10 : 20;
  const output: number[] = [];
  let inEpisode = false;
  let entryTaken = false;
  let lastSignal = -1;
  for (let i = 1; i < points.length; i += 1) {
    const point = points[i];
    if (point.k === null || point.k === undefined) continue;
    if (point.k >= threshold) { inEpisode = false; entryTaken = false; }
    const firstOversold = point.k < threshold && !inEpisode && !entryTaken;
    if (point.k < threshold) inEpisode = true;
    if (!firstOversold) continue;
    const dailyOk = mode !== "K20_1D_RISING" && mode !== "K10_1D_RISING" || risingAt(daily, point.closeTime);
    const twoWeeklyOk = mode !== "K20_2W_RISING" && mode !== "K10_2W_RISING" || risingAt(twoWeekly, point.closeTime);
    const weeklyPoint = currentAt(weekly, point.closeTime);
    const weeklyIndex = weeklyPoint === undefined ? -1 : weekly.indexOf(weeklyPoint);
    const aboveWeeklyEma = weeklyIndex >= 0 && weeklyEma20[weeklyIndex] !== null && weeklyPoint!.close > weeklyEma20[weeklyIndex]!;
    const weeklyEmaRising = weeklyIndex > 0 && weeklyEma20[weeklyIndex] !== null && weeklyEma20[weeklyIndex - 1] !== null && weeklyEma20[weeklyIndex]! > weeklyEma20[weeklyIndex - 1]!;
    const weeklyOk = mode !== "K20_WEEK_ABOVE_EMA20" && mode !== "K20_WEEK_ABOVE_RISING" || (mode === "K20_WEEK_ABOVE_EMA20" ? aboveWeeklyEma : aboveWeeklyEma && weeklyEmaRising);
    const recentAtr = atr.slice(Math.max(0, i - 90), i).filter((value): value is number => value !== null);
    const medianAtr = recentAtr.length ? [...recentAtr].sort((a, b) => a - b)[Math.floor(recentAtr.length / 2)] : null;
    const volatilityOk = mode !== "K20_ATR_HIGH" || (atr[i] !== null && medianAtr !== null && atr[i]! >= medianAtr);
    if (dailyOk && twoWeeklyOk && weeklyOk && volatilityOk) {
      if (signalGapAllowed(i, lastSignal, MIN_SIGNAL_GAP)) {
        output.push(i);
        lastSignal = i;
      }
      entryTaken = true;
      inEpisode = false;
    }
  }
  return output;
}

function bearishCross(points: StochPoint[], index: number): boolean {
  const point = points[index];
  const previous = points[index - 1];
  return point.k !== null && point.d !== null && previous.k !== null && previous.d !== null && previous.k >= previous.d && point.k < point.d;
}

function replay(bars: Candle[], points: StochPoint[], entrySignals: number[], atr: (number | null)[]): Trade[] {
  const trades: Trade[] = [];
  let blockedUntil = -1;
  for (const signal of entrySignals) {
    const entryIndex = signal + 1;
    if (entryIndex >= bars.length || entryIndex <= blockedUntil || atr[signal] === null) continue;
    if (bars[entryIndex].time < TRADE_START_MS || bars[entryIndex].time > TRADE_END_MS) continue;
    const entry = bars[entryIndex].open;
    const stop = entry - STOP_ATR * atr[signal]!;
    const target = entry + TARGET_ATR * atr[signal]!;
    let exitIndex = Math.min(bars.length - 1, entryIndex + MAX_HOLD);
    let reason = "MAX_HOLD";
    for (let index = entryIndex; index <= exitIndex; index += 1) {
      const bar = bars[index];
      if (bar.low <= stop) { exitIndex = index; reason = "SL"; break; }
      if (bar.high >= target) { exitIndex = index; reason = "TP"; break; }
      if (EXIT_MODE === "BEAR_CROSS" && index > entryIndex && bearishCross(points, index)) { exitIndex = Math.min(index + 1, bars.length - 1); reason = "BEAR_CROSS"; break; }
    }
    const exit = reason === "SL" || reason === "TP"
      ? triggeredExitPrice(reason, bars[exitIndex].open, reason === "SL" ? stop : target)
      : bars[exitIndex].open;
    trades.push({ entryTime: bars[entryIndex].time, exitTime: bars[exitIndex].time, pnl: settleLong(entry, exit, FEE_RATE, SLIP_RATE), reason });
    blockedUntil = exitIndex;
  }
  return trades;
}

function report(mode: Mode, trades: Trade[]): void {
  const wins = trades.filter((trade) => trade.pnl > 0);
  const gain = wins.reduce((sum, trade) => sum + trade.pnl, 0);
  const loss = -trades.filter((trade) => trade.pnl < 0).reduce((sum, trade) => sum + trade.pnl, 0);
  let equity = 0; let peak = 0; let maxDd = 0;
  for (const trade of trades) { equity += trade.pnl; peak = Math.max(peak, equity); maxDd = Math.max(maxDd, peak - equity); }
  const ordered = [...trades].sort((a, b) => b.pnl - a.pnl);
  const withoutBest = equity - (ordered[0]?.pnl ?? 0);
  const years = new Map<number, number>();
  for (const trade of trades) { const year = new Date(trade.entryTime).getUTCFullYear(); years.set(year, (years.get(year) ?? 0) + trade.pnl); }
  console.log(`${mode}: n=${trades.length} WR=${trades.length ? (wins.length / trades.length * 100).toFixed(1) : "0.0"}% PF=${loss ? (gain / loss).toFixed(2) : "inf"} netR=${equity.toFixed(3)} withoutBest=${withoutBest.toFixed(3)} maxDD=${maxDd.toFixed(3)} years=${JSON.stringify(Object.fromEntries(years))}`);
}

async function main(): Promise<void> {
  const raw = JSON.parse(await readFile(sourcePath, "utf8")) as any[];
  const hourly = raw.map((row) => ({ time: Number(row.time), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume) } satisfies Candle)).sort((a, b) => a.time - b.time);
  const asOfMs = hourly.at(-1)!.time + HOUR_MS;
  const bars = aggregate4H(hourly, asOfMs);
  const points = buildStochPoints(bars, FOUR_H_MS);
  const daily = buildStochPoints(aggregateCandles(hourly, "1d", asOfMs), DAY_MS);
  const weekly = buildStochPoints(aggregateCandles(hourly, "1w", asOfMs), WEEK_MS);
  const twoWeekly = buildStochPoints(aggregateCandles(hourly, "2w", asOfMs), 2 * WEEK_MS);
  const weeklyEma20 = ema(weekly.map((point) => point.close), 20);
  const atr = atrSeries(bars, 14);
  console.log(`4H early-entry sweep: ${sourcePath}, bars=${bars.length}, last=${new Date(asOfMs).toISOString()}, stop=${STOP_ATR}ATR target=${TARGET_ATR}ATR hold=${MAX_HOLD} exit=${EXIT_MODE} minSignalGap=${MIN_SIGNAL_GAP} window=${process.env.STOCHRSI_TRADE_START ?? "begin"}..${process.env.STOCHRSI_TRADE_END ?? "end"}`);
  for (const mode of ["K10", "K20", "K30", "K10_1D_RISING", "K10_2W_RISING", "K20_1D_RISING", "K20_2W_RISING", "K20_WEEK_ABOVE_EMA20", "K20_WEEK_ABOVE_RISING", "K20_ATR_HIGH"] as Mode[]) {
    report(mode, replay(bars, points, signals(points, daily, twoWeekly, weekly, weeklyEma20, atr, mode), atr));
  }
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode = 1; });
