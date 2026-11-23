import { readFile } from "node:fs/promises";

import {
  aggregateCandles,
  buildCampaignSignals,
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

type Mode = "FOUR_H_K20_RECLAIM" | "FOUR_H_STRUCTURE";

function funding(value: any): FundingPayment {
  return value.mark === null ? { time: Number(value.time), rate: Number(value.rate) } : { time: Number(value.time), rate: Number(value.rate), mark: Number(value.mark) };
}

function bearishWeeklyExit(entry: number, macroExit: number | undefined, weekly: StochPoint[]): number | undefined {
  for (let i = 1; i < weekly.length; i += 1) {
    if (weekly[i].closeTime <= entry || (macroExit !== undefined && weekly[i].closeTime >= macroExit)) continue;
    const point = weekly[i];
    const previous = weekly[i - 1];
    if (point.k !== null && point.d !== null && previous.k !== null && previous.d !== null && previous.k >= previous.d && point.k < point.d) return point.closeTime;
  }
  return macroExit;
}

function aggregate4H(source: Candle[], asOfMs: number): Candle[] {
  const span = 4 * HOUR_MS;
  const buckets = new Map<number, Candle[]>();
  for (const bar of source) {
    const start = Math.floor(bar.time / span) * span;
    const bucket = buckets.get(start) ?? [];
    bucket.push(bar);
    buckets.set(start, bucket);
  }
  return [...buckets.entries()]
    .filter(([start, bars]) => start + span <= asOfMs && bars.length === 4 && bars[0].time === start && bars[3].time === start + 3 * HOUR_MS)
    .map(([time, bars]) => ({ time, open: bars[0].open, high: Math.max(...bars.map((bar) => bar.high)), low: Math.min(...bars.map((bar) => bar.low)), close: bars[3].close, volume: bars.reduce((sum, bar) => sum + bar.volume, 0) }));
}

function entryFor(campaign: CampaignSignal, points: StochPoint[], mode: Mode): number | null {
  const end = campaign.exitTime ?? Number.POSITIVE_INFINITY;
  let oversoldSeen = false;
  for (let i = 1; i < points.length; i += 1) {
    const point = points[i];
    const previous = points[i - 1];
    if (point.closeTime <= campaign.armTime || point.closeTime >= end || point.k === null || previous.k === null) continue;
    if (point.k < 20) oversoldSeen = true;
    if (!oversoldSeen) continue;
    if (mode === "FOUR_H_K20_RECLAIM" && point.k > previous.k && point.k < 50) return point.closeTime;
    if (mode === "FOUR_H_STRUCTURE" && point.close > previous.high) return point.closeTime;
  }
  return null;
}

function print(mode: Mode, campaigns: CampaignSignal[], hourly: Candle[], fundingData: FundingPayment[]): void {
  const result = runVariant("DAILY_EPISODE", campaigns, hourly, fundingData);
  const closed = result.campaigns.filter((campaign) => campaign.closed);
  const wins = closed.filter((campaign) => campaign.netPnl > 0).length;
  const p = result.campaigns.map((campaign) => campaign.netPnl).sort((a, b) => b - a);
  console.log(`\n${mode}: entries=${campaigns.filter((c) => c.episodeEntries.length).length}/${campaigns.length} closed=${closed.length} WR=${closed.length ? (wins / closed.length * 100).toFixed(1) : "0.0"}% net=$${result.netPnl.toFixed(2)} withoutBest=$${(result.netPnl - (p[0] ?? 0)).toFixed(2)} maxDD=$${(-result.maxDrawdown).toFixed(2)}`);
  console.log(result.campaigns.map((campaign) => `${new Date(campaign.armTime).toISOString().slice(0, 10)}:${campaign.legs[0] ? `$${campaign.netPnl.toFixed(2)}` : "NO_ENTRY"}`).join(" "));
}

async function main(): Promise<void> {
  const hourly = (JSON.parse(await readFile(hourlyPath, "utf8")) as any[]).map((row) => ({
    time: Number(row.time), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume),
  } satisfies Candle)).sort((a, b) => a.time - b.time);
  const fundingData = (JSON.parse(await readFile(fundingPath, "utf8")) as any[]).map(funding);
  const asOfMs = hourly.at(-1)!.time + HOUR_MS;
  const macro = buildCampaignSignals(hourly, asOfMs);
  const fourH = buildStochPoints(aggregateCandles(hourly, "1d", asOfMs), 24 * HOUR_MS);
  const weekly = buildStochPoints(aggregateCandles(hourly, "1w", asOfMs), WEEK_MS);
  // The core aggregate API currently exposes 1d/1w/2w. Use hourly buckets for 4H without changing production code.
  const fourHPoints = buildStochPoints(aggregate4H(hourly, asOfMs), 4 * HOUR_MS);
  void fourH;
  for (const mode of ["FOUR_H_K20_RECLAIM", "FOUR_H_STRUCTURE"] as Mode[]) {
    const campaigns = macro.map((campaign) => {
      const entry = entryFor(campaign, fourHPoints, mode);
      const exitTime = entry === null ? campaign.exitTime : bearishWeeklyExit(entry, campaign.exitTime, weekly);
      return {
        ...campaign,
        exitTime,
        exitReason: exitTime === campaign.exitTime ? campaign.exitReason : undefined,
        episodeEntries: entry === null ? [] : [entry],
        episodeRecoveryTimes: entry === null ? [] : [null],
        dailyOversoldEntries: entry === null ? [] : [entry],
      };
    });
    print(mode, campaigns, hourly, fundingData);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
