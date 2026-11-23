import { readFile } from "node:fs/promises";

import {
  aggregateCandles,
  buildStochPoints,
  HOUR_MS,
  WEEK_MS,
  type Candle,
  type StochPoint,
} from "./stochrsi-macro-cycle/core";

type ConditionName =
  | "ALL"
  | "K_RISING"
  | "K_FALLING"
  | "K_TURN_UP"
  | "BULL_CROSS"
  | "BULL_CROSS_FROM_OS"
  | "K_LT_20_RISING"
  | "K_GT_80_RISING";

const sourcePath = process.env.STOCHRSI_SOURCE ?? "/tmp/binance-futures-btcusdt-1h-current-20260715.json";

function finite(value: unknown, label: string): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) throw new Error(`Invalid ${label}: ${String(value)}`);
  return number;
}

function parseCandle(value: unknown, index: number): Candle {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid candle ${index}`);
  const row = value as Record<string, unknown>;
  return {
    time: finite(row.time, `candle[${index}].time`),
    open: finite(row.open, `candle[${index}].open`),
    high: finite(row.high, `candle[${index}].high`),
    low: finite(row.low, `candle[${index}].low`),
    close: finite(row.close, `candle[${index}].close`),
    volume: finite(row.volume, `candle[${index}].volume`),
  };
}

function date(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function condition(
  point: StochPoint,
  previous: StochPoint | undefined,
  previousPrevious: StochPoint | undefined,
  name: ConditionName,
): boolean {
  if (name === "ALL") return true;
  if (!previous || point.k === null || previous.k === null) return false;
  if (name === "K_RISING") return point.k > previous.k;
  if (name === "K_FALLING") return point.k < previous.k;
  if (name === "K_TURN_UP") {
    return Boolean(previousPrevious && previousPrevious.k !== null && previous.k <= previousPrevious.k && point.k > previous.k);
  }
  if (point.d === null || previous.d === null) return false;
  if (name === "BULL_CROSS") return previous.k <= previous.d && point.k > point.d;
  if (name === "BULL_CROSS_FROM_OS") return previous.k <= previous.d && point.k > point.d && previous.k < 20;
  if (name === "K_LT_20_RISING") return point.k < 20 && point.k > previous.k;
  return point.k > 80 && point.k > previous.k;
}

function report(points: StochPoint[], label: string, horizons: number[]): void {
  console.log(`\n${label}: ${points.length} completed bars, ${date(points[0].time)} -> ${date(points[points.length - 1].time)}`);
  const conditions: ConditionName[] = [
    "ALL",
    "K_RISING",
    "K_FALLING",
    "K_TURN_UP",
    "BULL_CROSS",
    "BULL_CROSS_FROM_OS",
    "K_LT_20_RISING",
    "K_GT_80_RISING",
  ];
  for (const name of conditions) {
    console.log(`  ${name}`);
    for (const horizon of horizons) {
      const returns: number[] = [];
      for (let i = 1; i + horizon < points.length; i += 1) {
        const current = points[i];
        if (current.k === null || !condition(current, points[i - 1], points[i - 2], name)) continue;
        returns.push(points[i + horizon].close / current.close - 1);
      }
      const wins = returns.filter((value) => value > 0).length;
      const mean = returns.reduce((sum, value) => sum + value, 0) / (returns.length || 1);
      console.log(`    +${horizon} bars n=${returns.length} up=${pct(wins / (returns.length || 1))} mean=${pct(mean)} median=${pct(median(returns))}`);
    }
  }

  const stabilityHorizon = horizons[horizons.length - 1];
  console.log(`  K_RISING yearly stability at +${stabilityHorizon} bars:`);
  const byYear = new Map<number, number[]>();
  for (let i = 1; i + stabilityHorizon < points.length; i += 1) {
    const current = points[i];
    if (current.k === null || !condition(current, points[i - 1], points[i - 2], "K_RISING")) continue;
    const year = new Date(current.closeTime).getUTCFullYear();
    const values = byYear.get(year) ?? [];
    values.push(points[i + stabilityHorizon].close / current.close - 1);
    byYear.set(year, values);
  }
  for (const [year, values] of byYear) {
    const wins = values.filter((value) => value > 0).length;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    console.log(`    ${year}: n=${values.length} up=${pct(wins / values.length)} mean=${pct(mean)}`);
  }
}

function reportJoint(weekly: StochPoint[], twoWeekly: StochPoint[]): void {
  const twoByClose = new Map(twoWeekly.map((point) => [point.closeTime, point]));
  const horizons = [1, 2, 4];
  console.log("\nJOINT 1W + 2W K_RISING (at aligned 2W closes)");
  for (const horizon of horizons) {
    const returns: number[] = [];
    for (let i = 1; i + horizon < twoWeekly.length; i += 1) {
      const point = twoWeekly[i];
      const previous = twoWeekly[i - 1];
      const week = weekly.find((candidate) => candidate.closeTime === point.closeTime);
      const previousWeek = weekly.find((candidate) => candidate.closeTime === previous.closeTime);
      if (!week || !previousWeek || point.k === null || previous.k === null || week.k === null || previousWeek.k === null) continue;
      if (!(point.k > previous.k && week.k > previousWeek.k)) continue;
      returns.push(twoWeekly[i + horizon].close / point.close - 1);
    }
    const wins = returns.filter((value) => value > 0).length;
    const mean = returns.reduce((sum, value) => sum + value, 0) / (returns.length || 1);
    console.log(`  +${horizon} 2W bars n=${returns.length} up=${pct(wins / (returns.length || 1))} mean=${pct(mean)} median=${pct(median(returns))}`);
  }
  console.log(`  aligned 2W points=${twoByClose.size}`);
}

async function main(): Promise<void> {
  const raw = JSON.parse(await readFile(sourcePath, "utf8")) as unknown;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("Source must be a non-empty candle array");
  const candles = raw.map(parseCandle).sort((left, right) => left.time - right.time);
  const asOfMs = candles[candles.length - 1].time + HOUR_MS;
  const weekly = buildStochPoints(aggregateCandles(candles, "1w", asOfMs), WEEK_MS);
  const twoWeekly = buildStochPoints(aggregateCandles(candles, "2w", asOfMs), 2 * WEEK_MS);
  report(weekly, "1W", [1, 2, 4, 8]);
  report(twoWeekly, "2W", [1, 2, 4, 8]);
  reportJoint(weekly, twoWeekly);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
