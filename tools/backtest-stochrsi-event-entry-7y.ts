import { readFile } from "node:fs/promises";

import {
  aggregateCandles,
  buildStochPoints,
  HOUR_MS,
  WEEK_MS,
  type CampaignSignal,
  type Candle,
  type StochPoint,
} from "./stochrsi-macro-cycle/core";
import { runVariant, type FundingPayment } from "./stochrsi-macro-cycle/replay";

const hourlyPath = process.env.STOCHRSI_HOURLY ?? ".cache/binance-futures-btcusdt-1h-7y.json";
const fundingPath = process.env.STOCHRSI_FUNDING ?? ".cache/binance-futures-btcusdt-funding-7y.json";

type EntryMode = "CROSS_FROM_OS" | "CROSS_FROM_OS_WITH_1W_RISING" | "2W_TURN_UP_FROM_OS_WITH_1W_RISING";
type ExitMode = "WEEK_CROSS_DOWN" | "TWO_WEEK_CROSS_DOWN";

function parseFunding(value: any): FundingPayment {
  return value.mark === null
    ? { time: Number(value.time), rate: Number(value.rate) }
    : { time: Number(value.time), rate: Number(value.rate), mark: Number(value.mark) };
}

function bearishCross(points: StochPoint[], index: number): boolean {
  const point = points[index];
  const previous = points[index - 1];
  return point.k !== null && point.d !== null && previous.k !== null && previous.d !== null && previous.k >= previous.d && point.k < point.d;
}

function bullishCross(points: StochPoint[], index: number): boolean {
  const point = points[index];
  const previous = points[index - 1];
  return point.k !== null && point.d !== null && previous.k !== null && previous.d !== null && previous.k <= previous.d && point.k > point.d;
}

function buildEvents(twoWeekly: StochPoint[], weekly: StochPoint[], mode: EntryMode, oversoldThreshold: number): number[] {
  const weeklyByClose = new Map(weekly.map((point) => [point.closeTime, point]));
  const events: number[] = [];
  for (let i = 2; i < twoWeekly.length; i += 1) {
    const point = twoWeekly[i];
    const previous = twoWeekly[i - 1];
    const prior = twoWeekly[i - 2];
    if (!bullishCross(twoWeekly, i) || point.k === null || previous.k === null || prior.k === null) continue;
    const weeklyPoint = weeklyByClose.get(point.closeTime);
    const weeklyIndex = weekly.indexOf(weeklyPoint!);
    const weeklyPrevious = weeklyIndex > 0 ? weekly[weeklyIndex - 1] : undefined;
    const weeklyRising = Boolean(weeklyPoint && weeklyPrevious && weeklyPoint.k !== null && weeklyPrevious.k !== null && weeklyPoint.k > weeklyPrevious.k);
    const oversoldSeen = Math.min(prior.k, previous.k) < oversoldThreshold;
    const twoWeekTurnUp = prior.k >= previous.k && point.k > previous.k;
    if (!oversoldSeen) continue;
    if (mode === "CROSS_FROM_OS_WITH_1W_RISING" && !weeklyRising) continue;
    if (mode === "2W_TURN_UP_FROM_OS_WITH_1W_RISING" && (!weeklyRising || !twoWeekTurnUp)) continue;
    events.push(point.closeTime);
  }
  return events;
}

function buildCampaigns(
  events: number[],
  weekly: StochPoint[],
  twoWeekly: StochPoint[],
  exitMode: ExitMode,
): CampaignSignal[] {
  const exitPoints = exitMode === "WEEK_CROSS_DOWN" ? weekly : twoWeekly;
  const result: CampaignSignal[] = [];
  let nextAvailable = -Infinity;
  for (const entry of events) {
    if (entry < nextAvailable) continue;
    const exitPoint = exitPoints.find((point, index) => point.closeTime > entry && bearishCross(exitPoints, index));
    const exitTime = exitPoint?.closeTime;
    result.push({
      armTime: entry,
      episodeEntries: [entry],
      episodeRecoveryTimes: [null],
      dailyOversoldEntries: [entry],
      ...(exitTime === undefined ? {} : { exitTime }),
    });
    nextAvailable = exitTime ?? Number.POSITIVE_INFINITY;
  }
  return result;
}

function money(value: number): string {
  return `${value >= 0 ? "+" : ""}$${value.toFixed(2)}`;
}

function printResult(entryMode: EntryMode, exitMode: ExitMode, threshold: number, campaigns: CampaignSignal[], hourly: Candle[], funding: FundingPayment[]): void {
  const result = runVariant("DAILY_EPISODE", campaigns, hourly, funding);
  const closed = result.campaigns.filter((campaign) => campaign.closed);
  const wins = closed.filter((campaign) => campaign.netPnl > 0).length;
  const ordered = result.campaigns.map((campaign) => campaign.netPnl).sort((a, b) => b - a);
  const withoutBest = result.netPnl - (ordered[0] ?? 0);
  const pre2023 = result.campaigns.filter((campaign) => campaign.closed && campaign.armTime < Date.UTC(2023, 0, 1)).reduce((sum, campaign) => sum + campaign.netPnl, 0);
  const post2023 = result.campaigns.filter((campaign) => campaign.closed && campaign.armTime >= Date.UTC(2023, 0, 1)).reduce((sum, campaign) => sum + campaign.netPnl, 0);
  console.log(`\nK<${threshold} ${entryMode} + ${exitMode}`);
  console.log(`  events=${campaigns.length} closed=${closed.length} WR=${closed.length ? (wins / closed.length * 100).toFixed(1) : "0.0"}% net=${money(result.netPnl)} withoutBest=${money(withoutBest)} maxDD=${money(-result.maxDrawdown)} pre2023=${money(pre2023)} post2023=${money(post2023)}`);
  console.log(`  trades=${result.campaigns.map((campaign) => `${new Date(campaign.armTime).toISOString().slice(0, 10)}:${money(campaign.netPnl)}`).join(" ")}`);
}

async function main(): Promise<void> {
  const hourly = (JSON.parse(await readFile(hourlyPath, "utf8")) as any[]).map((row) => ({
    time: Number(row.time), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume),
  } satisfies Candle)).sort((a, b) => a.time - b.time);
  const funding = (JSON.parse(await readFile(fundingPath, "utf8")) as any[]).map(parseFunding);
  const asOfMs = hourly.at(-1)!.time + HOUR_MS;
  const weekly = buildStochPoints(aggregateCandles(hourly, "1w", asOfMs), WEEK_MS);
  const twoWeekly = buildStochPoints(aggregateCandles(hourly, "2w", asOfMs), 2 * WEEK_MS);
  for (const threshold of [10, 20, 30]) {
    for (const entryMode of ["CROSS_FROM_OS", "CROSS_FROM_OS_WITH_1W_RISING", "2W_TURN_UP_FROM_OS_WITH_1W_RISING"] as EntryMode[]) {
      const events = buildEvents(twoWeekly, weekly, entryMode, threshold);
      for (const exitMode of ["WEEK_CROSS_DOWN", "TWO_WEEK_CROSS_DOWN"] as ExitMode[]) {
        printResult(entryMode, exitMode, threshold, buildCampaigns(events, weekly, twoWeekly, exitMode), hourly, funding);
      }
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
