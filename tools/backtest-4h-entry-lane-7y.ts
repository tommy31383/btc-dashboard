import { readFile } from "node:fs/promises";

import { aggregateCandles, buildStochPoints, HOUR_MS, type Candle, type StochPoint } from "./stochrsi-macro-cycle/core";
import { settleLong, triggeredExitPrice } from "./backtest-4h-entry-lane-7y-fill";

const sourcePath = process.env.STOCHRSI_HOURLY ?? ".cache/binance-futures-btcusdt-1h-7y.json";
const FOUR_H_MS = 4 * HOUR_MS;
const DAY_MS = 24 * HOUR_MS;
const FEE_RATE = 0.0004;
const SLIP_RATE = 0.0002;
const STOP_ATR = Number(process.env.STOCHRSI_STOP_ATR ?? "1.5");
const TARGET_ATR = Number(process.env.STOCHRSI_TARGET_ATR ?? "3");
const MAX_HOLD = Number(process.env.STOCHRSI_MAX_HOLD ?? "30");

type SignalMode = "K_TURN_1D_RISING" | "K_RECLAIM_1D_RISING" | "K_TURN_ANY" | "K_FIRST_OVERSOLD" | "BB_RECLAIM" | "EMA20_RECLAIM" | "SWING_RECLAIM" | "BREAKOUT";

interface Trade { entryTime: number; exitTime: number; pnl: number; reason: string; }

function aggregate4H(source: Candle[], asOfMs: number): Candle[] {
  const buckets = new Map<number, Candle[]>();
  for (const bar of source) {
    const start = Math.floor(bar.time / FOUR_H_MS) * FOUR_H_MS;
    const bucket = buckets.get(start) ?? [];
    bucket.push(bar);
    buckets.set(start, bucket);
  }
  return [...buckets.entries()].filter(([start, bars]) => start + FOUR_H_MS <= asOfMs && bars.length === 4 && bars[0].time === start && bars[3].time === start + 3 * HOUR_MS).map(([time, bars]) => ({ time, open: bars[0].open, high: Math.max(...bars.map((bar) => bar.high)), low: Math.min(...bars.map((bar) => bar.low)), close: bars[3].close, volume: bars.reduce((sum, bar) => sum + bar.volume, 0) }));
}

function risingContextAt(points: StochPoint[], reference: StochPoint[]): boolean[] {
  const result: boolean[] = [];
  let cursor = -1;
  for (const point of reference) {
    while (cursor + 1 < points.length && points[cursor + 1].closeTime <= point.closeTime) cursor += 1;
    const current = points[cursor];
    const previous = points[cursor - 1];
    result.push(Boolean(current?.k !== null && current?.k !== undefined && previous?.k !== null && previous?.k !== undefined && current.k > previous.k));
  }
  return result;
}

function atrSeries(bars: Candle[], period: number): (number | null)[] {
  return bars.map((bar, index) => {
    if (index === 0 || index < period) return null;
    const values = bars.slice(index - period + 1, index + 1).map((current, offset) => {
      const previous = bars[index - period + offset];
      return Math.max(current.high - current.low, Math.abs(current.high - previous.close), Math.abs(current.low - previous.close));
    });
    return values.reduce((sum, value) => sum + value, 0) / period;
  });
}

function emaSeries(values: number[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return result;
  let ema = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  result[period - 1] = ema;
  const alpha = 2 / (period + 1);
  for (let i = period; i < values.length; i += 1) { ema = values[i] * alpha + ema * (1 - alpha); result[i] = ema; }
  return result;
}

function lowerBand(bars: Candle[], period: number, multiplier: number): (number | null)[] {
  return bars.map((_, index) => {
    if (index < period - 1) return null;
    const values = bars.slice(index - period + 1, index + 1).map((bar) => bar.close);
    const mean = values.reduce((sum, value) => sum + value, 0) / period;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / period;
    return mean - multiplier * Math.sqrt(variance);
  });
}

function signalIndices(points: StochPoint[], bars: Candle[], daily: StochPoint[], mode: SignalMode, ema20: (number | null)[], bbLower: (number | null)[]): number[] {
  const dailyRising = risingContextAt(daily, points);
  const signals: number[] = [];
  let oversoldSeen = false;
  let firstOversoldTaken = false;
  let belowBandSeen = false;
  let belowEmaSeen = false;
  let blockedUntil = -1;
  for (let i = 1; i < points.length; i += 1) {
    const point = points[i]; const previous = points[i - 1];
    if (point.k === null || point.d === null || previous.k === null || previous.d === null) continue;
    if (mode === "K_FIRST_OVERSOLD" && point.k >= 20) { oversoldSeen = false; firstOversoldTaken = false; }
    const firstOversold = mode === "K_FIRST_OVERSOLD" && point.k < 20 && !oversoldSeen && !firstOversoldTaken;
    if (point.k < 20) oversoldSeen = true;
    if (bbLower[i] !== null && point.close < bbLower[i]!) belowBandSeen = true;
    if (ema20[i] !== null && point.close < ema20[i]!) belowEmaSeen = true;
    if (i < blockedUntil || (mode !== "K_FIRST_OVERSOLD" && !oversoldSeen)) continue;
    const turn = point.k > previous.k;
    const reclaim = previous.k <= previous.d && point.k > point.d;
    const context = mode === "K_TURN_ANY" || dailyRising[i];
    const bbReclaim = belowBandSeen && bbLower[i] !== null && point.close > bbLower[i]!;
    const emaReclaim = belowEmaSeen && ema20[i] !== null && point.close > ema20[i]!;
    const swingReclaim = i >= 6 && point.low <= Math.min(...bars.slice(i - 6, i).map((bar) => bar.low)) && point.close > previous.high;
    const breakout = i >= 12 && point.close > Math.max(...bars.slice(i - 12, i).map((bar) => bar.high));
    const hit = mode === "K_FIRST_OVERSOLD" ? firstOversold : mode === "BB_RECLAIM" ? bbReclaim : mode === "EMA20_RECLAIM" ? emaReclaim : mode === "SWING_RECLAIM" ? swingReclaim : mode === "BREAKOUT" ? breakout : mode === "K_RECLAIM_1D_RISING" ? reclaim : turn;
    const modeContext = mode === "K_TURN_1D_RISING" || mode === "K_RECLAIM_1D_RISING" ? dailyRising[i] : true;
    if (modeContext && hit) {
      signals.push(i);
      blockedUntil = i + 6;
      if (mode === "K_FIRST_OVERSOLD") firstOversoldTaken = true;
      oversoldSeen = false;
      belowBandSeen = false;
      belowEmaSeen = false;
    }
  }
  return signals;
}

function bearishCross(points: StochPoint[], index: number): boolean {
  const point = points[index]; const previous = points[index - 1];
  return point.k !== null && point.d !== null && previous.k !== null && previous.d !== null && previous.k >= previous.d && point.k < point.d;
}

function replay(bars: Candle[], points: StochPoint[], signals: number[], atr: (number | null)[]): Trade[] {
  const trades: Trade[] = [];
  let blockedUntil = -1;
  for (const signal of signals) {
    const entryIndex = signal + 1;
    if (entryIndex >= bars.length || entryIndex <= blockedUntil || atr[signal] === null) continue;
    const entryOpen = bars[entryIndex].open;
    const stop = entryOpen - STOP_ATR * atr[signal]!;
    const target = entryOpen + TARGET_ATR * atr[signal]!;
    let exitIndex = Math.min(bars.length - 1, entryIndex + MAX_HOLD);
    let reason = "MAX_HOLD";
    for (let index = entryIndex; index <= exitIndex; index += 1) {
      const bar = bars[index];
      if (bar.low <= stop) { exitIndex = index; reason = "SL"; break; }
      if (bar.high >= target) { exitIndex = index; reason = "TP"; break; }
      if (index > entryIndex && bearishCross(points, index)) {
        exitIndex = Math.min(index + 1, bars.length - 1);
        reason = "BEAR_CROSS";
        break;
      }
    }
    const exitPrice = reason === "SL" || reason === "TP"
      ? triggeredExitPrice(reason, bars[exitIndex].open, reason === "SL" ? stop : target)
      : bars[exitIndex].open;
    trades.push({ entryTime: bars[entryIndex].time, exitTime: bars[exitIndex].time, pnl: settleLong(entryOpen, exitPrice, FEE_RATE, SLIP_RATE), reason });
    blockedUntil = exitIndex;
  }
  return trades;
}

function report(mode: SignalMode, trades: Trade[]): void {
  const wins = trades.filter((trade) => trade.pnl > 0);
  const grossWins = wins.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLosses = -trades.filter((trade) => trade.pnl < 0).reduce((sum, trade) => sum + trade.pnl, 0);
  let equity = 0; let peak = 0; let maxDd = 0;
  for (const trade of trades) { equity += trade.pnl; peak = Math.max(peak, equity); maxDd = Math.max(maxDd, peak - equity); }
  const byReason = new Map<string, number>();
  for (const trade of trades) byReason.set(trade.reason, (byReason.get(trade.reason) ?? 0) + 1);
  const years = new Map<number, number>();
  for (const trade of trades) years.set(new Date(trade.entryTime).getUTCFullYear(), (years.get(new Date(trade.entryTime).getUTCFullYear()) ?? 0) + trade.pnl);
  console.log(`${mode}: trades=${trades.length} WR=${trades.length ? (wins.length / trades.length * 100).toFixed(1) : "0.0"}% netR=${equity.toFixed(3)} avgR=${(equity / (trades.length || 1)).toFixed(4)} PF=${grossLosses ? (grossWins / grossLosses).toFixed(2) : "inf"} maxDD_R=${maxDd.toFixed(3)} years=${JSON.stringify(Object.fromEntries(years))} reasons=${JSON.stringify(Object.fromEntries(byReason))}`);
}

async function main(): Promise<void> {
  const raw = JSON.parse(await readFile(sourcePath, "utf8")) as any[];
  const hourly = raw.map((row) => ({ time: Number(row.time), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume) } satisfies Candle)).sort((a, b) => a.time - b.time);
  const asOfMs = hourly.at(-1)!.time + HOUR_MS;
  const bars = aggregate4H(hourly, asOfMs);
  const points = buildStochPoints(bars, FOUR_H_MS);
  const daily = buildStochPoints(aggregateCandles(hourly, "1d", asOfMs), DAY_MS);
  const atr = atrSeries(bars, 14);
  const ema20 = emaSeries(bars.map((bar) => bar.close), 20);
  const bbLower = lowerBand(bars, 20, 2);
  console.log(`4H entry lane trade replay: ${sourcePath}, bars=${bars.length}, last=${new Date(asOfMs).toISOString()}, stop=${STOP_ATR}ATR, target=${TARGET_ATR}ATR, maxHold=${MAX_HOLD}`);
  for (const mode of ["K_TURN_1D_RISING", "K_RECLAIM_1D_RISING", "K_TURN_ANY", "K_FIRST_OVERSOLD", "BB_RECLAIM", "EMA20_RECLAIM", "SWING_RECLAIM", "BREAKOUT"] as SignalMode[]) report(mode, replay(bars, points, signalIndices(points, bars, daily, mode, ema20, bbLower), atr));
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode = 1; });
