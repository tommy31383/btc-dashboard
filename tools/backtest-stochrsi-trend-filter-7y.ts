import { readFile } from "node:fs/promises";

import { calcEMASeries } from "../utils/indicators";
import { aggregateCandles, buildStochPoints, HOUR_MS, WEEK_MS, type CampaignSignal, type Candle, type StochPoint } from "./stochrsi-macro-cycle/core";
import { runVariant, type FundingPayment } from "./stochrsi-macro-cycle/replay";

type TrendFilter = "ANY" | "WEEK_ABOVE_EMA20" | "EMA20_RISING" | "ABOVE_AND_RISING";
type ExitMode = "WEEK_CROSS_DOWN" | "TWO_WEEK_CROSS_DOWN";
type EntryMode = "2W_BULL_CROSS" | "2W_SLOPE_TURN_UP";

const hourlyPath = process.env.STOCHRSI_HOURLY ?? ".cache/binance-futures-btcusdt-1h-7y.json";
const fundingPath = process.env.STOCHRSI_FUNDING ?? ".cache/binance-futures-btcusdt-funding-7y.json";

function parseFunding(value: any): FundingPayment {
  return value.mark === null ? { time: Number(value.time), rate: Number(value.rate) } : { time: Number(value.time), rate: Number(value.rate), mark: Number(value.mark) };
}

function bullCross(points: StochPoint[], i: number): boolean {
  const p = points[i]; const q = points[i - 1];
  return p.k !== null && p.d !== null && q.k !== null && q.d !== null && q.k <= q.d && p.k > p.d;
}

function bearCross(points: StochPoint[], i: number): boolean {
  const p = points[i]; const q = points[i - 1];
  return p.k !== null && p.d !== null && q.k !== null && q.d !== null && q.k >= q.d && p.k < p.d;
}

function makeEvents(two: StochPoint[], weekly: StochPoint[], ema: (number | null)[], filter: TrendFilter, entryMode: EntryMode): number[] {
  const events: number[] = [];
  for (let i = 2; i < two.length; i += 1) {
    const cross = bullCross(two, i);
    const currentTwoK = two[i].k;
    const previousTwoKForSlope = two[i - 1].k;
    const priorTwoKForSlope = two[i - 2].k;
    const slopeTurn = currentTwoK !== null && previousTwoKForSlope !== null && priorTwoKForSlope !== null && priorTwoKForSlope >= previousTwoKForSlope && currentTwoK > previousTwoKForSlope;
    if (!(entryMode === "2W_BULL_CROSS" ? cross : slopeTurn) || two[i].k === null || two[i - 1].k === null || two[i - 2].k === null) continue;
    const wi = weekly.findIndex((p) => p.closeTime === two[i].closeTime);
    const weeklyPoint = wi >= 0 ? weekly[wi] : undefined;
    const previousWeeklyPoint = wi >= 1 ? weekly[wi - 1] : undefined;
    const previousTwoK = two[i - 1].k;
    const priorTwoK = two[i - 2].k;
    if (weeklyPoint?.k === null || weeklyPoint?.k === undefined || previousWeeklyPoint?.k === null || previousWeeklyPoint?.k === undefined || weeklyPoint.k <= previousWeeklyPoint.k) continue;
    if (previousTwoK === null || priorTwoK === null || Math.min(previousTwoK, priorTwoK) >= 20) continue;
    const above = ema[wi] !== null && weekly[wi].close > ema[wi]!;
    const rising = ema[wi] !== null && ema[wi - 1] !== null && ema[wi]! > ema[wi - 1]!;
    if (filter === "WEEK_ABOVE_EMA20" && !above) continue;
    if (filter === "EMA20_RISING" && !rising) continue;
    if (filter === "ABOVE_AND_RISING" && (!above || !rising)) continue;
    events.push(two[i].closeTime);
  }
  return events;
}

function makeCampaigns(events: number[], weekly: StochPoint[], twoWeekly: StochPoint[], exitMode: ExitMode): CampaignSignal[] {
  const result: CampaignSignal[] = [];
  let blockedUntil = -Infinity;
  const exitPoints = exitMode === "WEEK_CROSS_DOWN" ? weekly : twoWeekly;
  for (const entry of events) {
    if (entry < blockedUntil) continue;
    const exit = exitPoints.find((p, i) => p.closeTime > entry && bearCross(exitPoints, i));
    result.push({ armTime: entry, episodeEntries: [entry], episodeRecoveryTimes: [null], dailyOversoldEntries: [entry], ...(exit ? { exitTime: exit.closeTime } : {}) });
    blockedUntil = exit?.closeTime ?? Number.POSITIVE_INFINITY;
  }
  return result;
}

async function main(): Promise<void> {
  const hourly = (JSON.parse(await readFile(hourlyPath, "utf8")) as any[]).map((r) => ({ time: Number(r.time), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume) } satisfies Candle));
  const funding = (JSON.parse(await readFile(fundingPath, "utf8")) as any[]).map(parseFunding);
  const asOf = hourly.at(-1)!.time + HOUR_MS;
  const weekly = buildStochPoints(aggregateCandles(hourly, "1w", asOf), WEEK_MS);
  const two = buildStochPoints(aggregateCandles(hourly, "2w", asOf), 2 * WEEK_MS);
  const ema = calcEMASeries(weekly.map((p) => p.close), 20);
  for (const entryMode of ["2W_BULL_CROSS", "2W_SLOPE_TURN_UP"] as EntryMode[]) {
    for (const filter of ["ANY", "WEEK_ABOVE_EMA20", "EMA20_RISING", "ABOVE_AND_RISING"] as TrendFilter[]) {
      for (const exitMode of ["WEEK_CROSS_DOWN", "TWO_WEEK_CROSS_DOWN"] as ExitMode[]) {
        const campaigns = makeCampaigns(makeEvents(two, weekly, ema, filter, entryMode), weekly, two, exitMode);
        const run = runVariant("DAILY_EPISODE", campaigns, hourly, funding);
        const closed = run.campaigns.filter((c) => c.closed && c.legs.length > 0);
        const wins = closed.filter((c) => c.netPnl > 0).length;
        const values = run.campaigns.map((c) => c.netPnl).sort((a, b) => b - a);
        console.log(`${entryMode} + ${filter} + ${exitMode}: events=${campaigns.length} WR=${closed.length ? (wins / closed.length * 100).toFixed(1) : "0.0"}% net=$${run.netPnl.toFixed(2)} withoutBest=$${(run.netPnl - (values[0] ?? 0)).toFixed(2)} maxDD=$${(-run.maxDrawdown).toFixed(2)} ${run.campaigns.map((c) => `${new Date(c.armTime).toISOString().slice(0, 10)}:${c.netPnl.toFixed(2)}`).join(" ")}`);
      }
    }
  }
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode = 1; });
