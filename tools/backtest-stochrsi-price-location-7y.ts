import { readFile } from "node:fs/promises";

import { calcEMASeries } from "../utils/indicators";
import { aggregateCandles, buildCampaignSignals, buildStochPoints, HOUR_MS, WEEK_MS, type Candle, type CampaignSignal, type StochPoint } from "./stochrsi-macro-cycle/core";
import { runVariant, type FundingPayment } from "./stochrsi-macro-cycle/replay";

function parseFunding(value: any): FundingPayment {
  return value.mark === null ? { time: Number(value.time), rate: Number(value.rate) } : { time: Number(value.time), rate: Number(value.rate), mark: Number(value.mark) };
}

function weeklyBearishExit(entry: number, macroExit: number | undefined, weekly: StochPoint[]): number | undefined {
  for (let i = 1; i < weekly.length; i += 1) {
    const point = weekly[i];
    const previous = weekly[i - 1];
    if (point.closeTime <= entry || (macroExit !== undefined && point.closeTime >= macroExit)) continue;
    if (point.k !== null && point.d !== null && previous.k !== null && previous.d !== null && previous.k >= previous.d && point.k < point.d) return point.closeTime;
  }
  return macroExit;
}

function build(campaigns: CampaignSignal[], weekly: StochPoint[], ema: (number | null)[], maxDistance: number): CampaignSignal[] {
  return campaigns.map((campaign) => {
    const index = weekly.findIndex((point) => point.closeTime === campaign.armTime);
    const priceDistance = index >= 0 && ema[index] !== null ? weekly[index].close / ema[index]! - 1 : 0;
    if (priceDistance > maxDistance) return { ...campaign, episodeEntries: [], episodeRecoveryTimes: [], dailyOversoldEntries: [] };
    const exitTime = weeklyBearishExit(campaign.armTime, campaign.exitTime, weekly);
    return { ...campaign, exitTime, exitReason: exitTime === campaign.exitTime ? campaign.exitReason : undefined, episodeEntries: [campaign.armTime], episodeRecoveryTimes: [null], dailyOversoldEntries: [campaign.armTime] };
  });
}

async function main(): Promise<void> {
  const hourly = (JSON.parse(await readFile(".cache/binance-futures-btcusdt-1h-7y.json", "utf8")) as any[]).map((row) => ({ time: Number(row.time), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume) } satisfies Candle));
  const funding = (JSON.parse(await readFile(".cache/binance-futures-btcusdt-funding-7y.json", "utf8")) as any[]).map(parseFunding);
  const asOfMs = hourly.at(-1)!.time + HOUR_MS;
  const macro = buildCampaignSignals(hourly, asOfMs);
  const weekly = buildStochPoints(aggregateCandles(hourly, "1w", asOfMs), WEEK_MS);
  const ema = calcEMASeries(weekly.map((point) => point.close), 20);
  for (const maxDistance of [Infinity, 0, 0.05, 0.08, 0.10, 0.15]) {
    const campaigns = build(macro, weekly, ema, maxDistance);
    const result = runVariant("DAILY_EPISODE", campaigns, hourly, funding);
    const closed = result.campaigns.filter((campaign) => campaign.closed && campaign.legs.length > 0);
    const wins = closed.filter((campaign) => campaign.netPnl > 0).length;
    const ordered = result.campaigns.map((campaign) => campaign.netPnl).sort((a, b) => b - a);
    console.log(`maxDist=${maxDistance === Infinity ? "ANY" : `${(maxDistance * 100).toFixed(0)}%`} entries=${campaigns.filter((campaign) => campaign.episodeEntries.length).length} closed=${closed.length} WR=${closed.length ? (wins / closed.length * 100).toFixed(1) : "0.0"}% net=$${result.netPnl.toFixed(2)} withoutBest=$${(result.netPnl - (ordered[0] ?? 0)).toFixed(2)} maxDD=$${(-result.maxDrawdown).toFixed(2)}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
