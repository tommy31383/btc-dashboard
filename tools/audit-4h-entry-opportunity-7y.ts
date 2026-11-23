import { readFile } from "node:fs/promises";

import { aggregateCandles, buildStochPoints, HOUR_MS, type Candle, type StochPoint } from "./stochrsi-macro-cycle/core";

const sourcePath = process.env.STOCHRSI_HOURLY ?? ".cache/binance-futures-btcusdt-1h-7y.json";
const FOUR_H_MS = 4 * HOUR_MS;
const DAY_MS = 24 * HOUR_MS;

type EntryMode = "K_RECLAIM" | "K_TURN_UP" | "PRICE_RECLAIM";

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
    .map(([time, bars]) => ({ time, open: bars[0].open, high: Math.max(...bars.map((bar) => bar.high)), low: Math.min(...bars.map((bar) => bar.low)), close: bars[3].close, volume: bars.reduce((sum, bar) => sum + bar.volume, 0) }));
}

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
}

function pct(value: number): string { return `${(value * 100).toFixed(2)}%`; }

function buildSignals(points: StochPoint[], mode: EntryMode, cooldownBars = 6): number[] {
  const signals: number[] = [];
  let oversoldSeen = false;
  let blockedUntil = -1;
  for (let i = 1; i < points.length; i += 1) {
    const point = points[i];
    const previous = points[i - 1];
    if (point.k === null || point.d === null || previous.k === null || previous.d === null) continue;
    if (point.k < 20) oversoldSeen = true;
    if (i < blockedUntil || !oversoldSeen) continue;
    const kReclaim = previous.k <= previous.d && point.k > point.d;
    const kTurnUp = point.k > previous.k;
    const priceReclaim = point.close > previous.high;
    const hit = mode === "K_RECLAIM" ? kReclaim : mode === "K_TURN_UP" ? kTurnUp : priceReclaim;
    if (!hit) continue;
    signals.push(i);
    blockedUntil = i + cooldownBars;
    oversoldSeen = false;
  }
  return signals;
}

function risingAt(points: StochPoint[], closeTime: number): boolean {
  const current = points.filter((point) => point.closeTime <= closeTime).at(-1);
  const previous = points.filter((point) => point.closeTime < (current?.closeTime ?? 0)).at(-1);
  return current?.k !== null && current?.k !== undefined && previous?.k !== null && previous?.k !== undefined && current.k > previous.k;
}

function report(mode: EntryMode, points: StochPoint[], signals: number[], daily: StochPoint[], weekly: StochPoint[], twoWeekly: StochPoint[]): void {
  console.log(`\n${mode}: signals=${signals.length}, bars=${points.length}`);
  const contexts: Array<[string, (index: number) => boolean]> = [
    ["ANY", () => true],
    ["1D_RISING", (index) => risingAt(daily, points[index].closeTime)],
    ["1W_RISING", (index) => risingAt(weekly, points[index].closeTime)],
    ["2W_RISING", (index) => risingAt(twoWeekly, points[index].closeTime)],
    ["ALL_HTF_RISING", (index) => risingAt(daily, points[index].closeTime) && risingAt(weekly, points[index].closeTime) && risingAt(twoWeekly, points[index].closeTime)],
  ];
  for (const [contextName, context] of contexts) {
    const eligible = signals.filter(context);
    const rows: string[] = [];
    for (const horizon of [1, 3, 6, 12]) {
      const returns = eligible.filter((index) => index + horizon < points.length).map((index) => points[index + horizon].close / points[index].close - 1);
      const wins = returns.filter((value) => value > 0).length;
      const mean = returns.reduce((sum, value) => sum + value, 0) / (returns.length || 1);
      rows.push(`+${horizon} n=${returns.length} up=${pct(wins / (returns.length || 1))} mean=${pct(mean)} med=${pct(median(returns))}`);
    }
    console.log(`  ${contextName}: ${rows.join(" | ")}`);
  }
  const dailyRising = signals.filter((index) => {
    const current = daily.filter((point) => point.closeTime <= points[index].closeTime).at(-1);
    const previous = daily.filter((point) => point.closeTime < (current?.closeTime ?? 0)).at(-1);
    return current?.k !== null && current?.k !== undefined && previous?.k !== null && previous?.k !== undefined && current.k > previous.k;
  });
  console.log(`  with latest completed 1D K rising: ${dailyRising.length}/${signals.length}`);
}

async function main(): Promise<void> {
  const raw = JSON.parse(await readFile(sourcePath, "utf8")) as any[];
  const hourly = raw.map((row) => ({ time: Number(row.time), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume) } satisfies Candle)).sort((a, b) => a.time - b.time);
  const asOfMs = hourly.at(-1)!.time + HOUR_MS;
  const fourH = buildStochPoints(aggregate4H(hourly, asOfMs), FOUR_H_MS);
  const daily = buildStochPoints(aggregateCandles(hourly, "1d", asOfMs), DAY_MS);
  const weekly = buildStochPoints(aggregateCandles(hourly, "1w", asOfMs), 7 * DAY_MS);
  const twoWeekly = buildStochPoints(aggregateCandles(hourly, "2w", asOfMs), 14 * DAY_MS);
  console.log(`4H entry opportunity audit: ${sourcePath}, bars=${fourH.length}, last=${new Date(asOfMs).toISOString()}`);
  for (const mode of ["K_RECLAIM", "K_TURN_UP", "PRICE_RECLAIM"] as EntryMode[]) report(mode, fourH, buildSignals(fourH, mode), daily, weekly, twoWeekly);
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode = 1; });
