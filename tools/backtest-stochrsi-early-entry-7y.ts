import { readFile } from "node:fs/promises";

import { calcEMASeries } from "../utils/indicators";
import {
  aggregateCandles,
  buildCampaignSignals,
  buildStochPoints,
  DAY_MS,
  HOUR_MS,
  WEEK_MS,
  type CampaignSignal,
  type Candle,
  type StochPoint,
} from "./stochrsi-macro-cycle/core";
import { runVariant, type FundingPayment } from "./stochrsi-macro-cycle/replay";

const hourlyPath = process.env.STOCHRSI_HOURLY ?? ".cache/binance-futures-btcusdt-1h-7y.json";
const fundingPath = process.env.STOCHRSI_FUNDING ?? ".cache/binance-futures-btcusdt-funding-7y.json";

type EntryMode = "MACRO_ARM" | "DAILY_K10" | "DAILY_K20" | "DAILY_K20_RECLAIM" | "DAILY_STRUCTURE";
type ExitMode = "MACRO_OVERBOUGHT" | "TWO_WEEK_CROSS_DOWN" | "WEEK_CROSS_DOWN" | "WEEKLY_EMA20_BREAK";

interface CampaignWithEntry extends CampaignSignal {
  sourceEntry: number | null;
}

function parseFunding(value: any): FundingPayment {
  return value.mark === null
    ? { time: Number(value.time), rate: Number(value.rate) }
    : { time: Number(value.time), rate: Number(value.rate), mark: Number(value.mark) };
}

function firstEntry(
  campaign: CampaignSignal,
  daily: StochPoint[],
  dailyEma20: (number | null)[],
  mode: EntryMode,
): number | null {
  if (mode === "MACRO_ARM") return campaign.armTime;
  const exitTime = campaign.exitTime ?? Number.POSITIVE_INFINITY;
  const candidates = daily.filter((point) => point.closeTime > campaign.armTime && point.closeTime < exitTime);
  let oversoldSeen = false;
  for (let i = 1; i < candidates.length; i += 1) {
    const point = candidates[i];
    const previous = candidates[i - 1];
    if (point.k === null || previous.k === null) continue;
    if (mode === "DAILY_K10" && point.k < 10) return point.closeTime;
    if (mode === "DAILY_K20" && point.k < 20) return point.closeTime;
    if (point.k < 20) oversoldSeen = true;
    if (mode === "DAILY_K20_RECLAIM" && oversoldSeen && point.k > previous.k && point.k < 50) {
      return point.closeTime;
    }
    const ema = dailyEma20[daily.indexOf(point)];
    const previousEma = dailyEma20[daily.indexOf(previous)];
    if (
      mode === "DAILY_STRUCTURE" &&
      oversoldSeen &&
      point.close > previous.high &&
      ema !== null &&
      previousEma !== null &&
      point.close > ema
    ) {
      return point.closeTime;
    }
  }
  return null;
}

function buildCampaigns(
  campaigns: CampaignSignal[],
  daily: StochPoint[],
  dailyEma20: (number | null)[],
  mode: EntryMode,
  weekly: StochPoint[],
  twoWeekly: StochPoint[],
  weeklyEma20: (number | null)[],
  exitMode: ExitMode,
): CampaignWithEntry[] {
  return campaigns.map((campaign) => {
    const entry = firstEntry(campaign, daily, dailyEma20, mode);
    const exit = entry === null
      ? campaign.exitTime
      : findExit(entry, campaign.exitTime, weekly, twoWeekly, weeklyEma20, exitMode);
    return {
      ...campaign,
      exitTime: exit,
      exitReason: exit === campaign.exitTime ? campaign.exitReason : undefined,
      sourceEntry: entry,
      episodeEntries: entry === null ? [] : [entry],
      episodeRecoveryTimes: entry === null ? [] : [null],
      dailyOversoldEntries: entry === null ? [] : [entry],
    };
  });
}

function findExit(
  entry: number,
  macroExit: number | undefined,
  weekly: StochPoint[],
  twoWeekly: StochPoint[],
  weeklyEma20: (number | null)[],
  mode: ExitMode,
): number | undefined {
  if (mode === "MACRO_OVERBOUGHT") return macroExit;
  const points = mode === "TWO_WEEK_CROSS_DOWN" ? twoWeekly : weekly;
  for (let i = 1; i < points.length; i += 1) {
    const point = points[i];
    const previous = points[i - 1];
    if (point.closeTime <= entry || (macroExit !== undefined && point.closeTime >= macroExit)) continue;
    if (mode === "WEEKLY_EMA20_BREAK") {
      if (weeklyEma20[i] !== null && point.close < weeklyEma20[i]!) return point.closeTime;
      continue;
    }
    if (point.k === null || previous.k === null || point.d === null || previous.d === null) continue;
    const bearishCross = previous.k >= previous.d && point.k < point.d;
    if (bearishCross) return point.closeTime;
  }
  return macroExit;
}

function money(value: number): string {
  return `${value >= 0 ? "+" : ""}$${value.toFixed(2)}`;
}

function date(value: number | null): string {
  return value === null ? "-" : new Date(value).toISOString().slice(0, 10);
}

function printMode(
  mode: EntryMode,
  exitMode: ExitMode,
  campaigns: CampaignWithEntry[],
  hourly: Candle[],
  funding: FundingPayment[],
): void {
  const result = runVariant("DAILY_EPISODE", campaigns, hourly, funding);
  const closed = result.campaigns.filter((campaign) => campaign.closed);
  const closedWins = closed.filter((campaign) => campaign.netPnl > 0).length;
  const entries = campaigns.filter((campaign) => campaign.sourceEntry !== null);
  const maxMae = Math.min(...result.campaigns.flatMap((campaign) => campaign.legs.map((leg) => leg.netPnl)));
  console.log(`\n${mode} + ${exitMode}`);
  console.log(`  entries=${entries.length}/${campaigns.length} closed=${closed.length} closedWR=${closed.length ? (closedWins / closed.length * 100).toFixed(1) : "0.0"}% net=${money(result.netPnl)} maxDD=${money(-result.maxDrawdown)} worstLeg=${money(maxMae)}`);
  for (let i = 0; i < campaigns.length; i += 1) {
    const replay = result.campaigns[i];
    console.log(`  ${date(campaigns[i].armTime)} entry=${date(campaigns[i].sourceEntry)} exit=${date(campaigns[i].exitTime ?? null)} pnl=${money(replay.netPnl)} closed=${replay.closed}`);
  }
}

async function main(): Promise<void> {
  const hourly = (JSON.parse(await readFile(hourlyPath, "utf8")) as any[])
    .map((row) => ({
      time: Number(row.time),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume),
    } satisfies Candle))
    .sort((left, right) => left.time - right.time);
  const funding = (JSON.parse(await readFile(fundingPath, "utf8")) as any[]).map(parseFunding);
  const asOfMs = hourly.at(-1)!.time + HOUR_MS;
  const daily = buildStochPoints(aggregateCandles(hourly, "1d", asOfMs), DAY_MS);
  const dailyEma20 = calcEMASeries(daily.map((point) => point.close), 20);
  const weekly = buildStochPoints(aggregateCandles(hourly, "1w", asOfMs), WEEK_MS);
  const twoWeekly = buildStochPoints(aggregateCandles(hourly, "2w", asOfMs), 2 * WEEK_MS);
  const weeklyEma20 = calcEMASeries(weekly.map((point) => point.close), 20);
  const macro = buildCampaignSignals(hourly, asOfMs);
  console.log(`BTC early-entry replay: hourly=${hourly.length}, macroCampaigns=${macro.length}, last=${new Date(asOfMs).toISOString()}`);
  for (const mode of ["MACRO_ARM", "DAILY_K20"] as EntryMode[]) {
    for (const exitMode of ["MACRO_OVERBOUGHT", "TWO_WEEK_CROSS_DOWN", "WEEK_CROSS_DOWN", "WEEKLY_EMA20_BREAK"] as ExitMode[]) {
      printMode(
        mode,
        exitMode,
        buildCampaigns(macro, daily, dailyEma20, mode, weekly, twoWeekly, weeklyEma20, exitMode),
        hourly,
        funding,
      );
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
