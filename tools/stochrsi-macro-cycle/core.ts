import { calcStochRSISeries } from "../../utils/indicators";

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
export const WEEK_MS = 7 * DAY_MS;
export const MONDAY_ANCHOR_MS = Date.UTC(1970, 0, 5);

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type AggregateSpan = "1d" | "1w" | "2w";

export interface StochPoint extends Candle {
  closeTime: number;
  k: number | null;
  d: number | null;
}

export interface KdValue {
  k: number | null;
  d: number | null;
}

export interface MacroLatch {
  oversoldSeen: boolean;
  reboundConfirmed: boolean;
  previousK: number | null;
  previousD: number | null;
}

export interface CampaignPoints {
  daily: StochPoint[];
  weekly: StochPoint[];
  twoWeekly: StochPoint[];
}

export interface CampaignSignal {
  armTime: number;
  episodeEntries: number[];
  dailyOversoldEntries: number[];
  exitTime?: number;
  exitReason?: "MACRO_OVERBOUGHT";
}

function spanMs(span: AggregateSpan): number {
  switch (span) {
    case "1d":
      return DAY_MS;
    case "1w":
      return WEEK_MS;
    case "2w":
      return 2 * WEEK_MS;
  }
}

function bucketStart(time: number, span: AggregateSpan): number {
  if (span === "1d") return Math.floor(time / DAY_MS) * DAY_MS;

  const size = spanMs(span);
  return MONDAY_ANCHOR_MS + Math.floor((time - MONDAY_ANCHOR_MS) / size) * size;
}

export function aggregateCandles(source: Candle[], span: AggregateSpan, asOfMs: number): Candle[] {
  const completedSource = source.filter((bar) => bar.time + HOUR_MS <= asOfMs);
  const buckets = new Map<number, Candle>();

  for (const bar of completedSource) {
    const time = bucketStart(bar.time, span);
    const existing = buckets.get(time);
    if (existing) {
      existing.high = Math.max(existing.high, bar.high);
      existing.low = Math.min(existing.low, bar.low);
      existing.close = bar.close;
      existing.volume += bar.volume;
    } else {
      buckets.set(time, { ...bar, time });
    }
  }

  const targetSpanMs = spanMs(span);
  return [...buckets.values()]
    .filter((bar) => bar.time + targetSpanMs <= asOfMs)
    .sort((left, right) => left.time - right.time);
}

export function buildStochPoints(bars: Candle[], spanMs: number): StochPoint[] {
  const { kSeries, dSeries } = calcStochRSISeries(bars.map((bar) => bar.close), 14, 14, 3, 3);
  return bars.map((bar, index) => ({
    ...bar,
    closeTime: bar.time + spanMs,
    k: kSeries[index],
    d: dSeries[index],
  }));
}

export function emptyMacroLatch(): MacroLatch {
  return {
    oversoldSeen: false,
    reboundConfirmed: false,
    previousK: null,
    previousD: null,
  };
}

export function advanceMacroLatch(state: MacroLatch, value: KdValue): MacroLatch {
  if (value.k === null || value.d === null) return state;

  let oversoldSeen = state.oversoldSeen || value.k < 20 || value.d < 20;
  let reboundConfirmed = state.reboundConfirmed;
  if (
    oversoldSeen &&
    state.previousK !== null &&
    state.previousD !== null &&
    state.previousK <= state.previousD &&
    value.k > value.d
  ) {
    reboundConfirmed = true;
  }
  if (!reboundConfirmed && value.k >= 80) oversoldSeen = false;

  return {
    oversoldSeen,
    reboundConfirmed,
    previousK: value.k,
    previousD: value.d,
  };
}

interface TimedPoints {
  daily: StochPoint[];
  weekly: StochPoint[];
  twoWeekly: StochPoint[];
}

function groupByCloseTime(points: CampaignPoints): Map<number, TimedPoints> {
  const events = new Map<number, TimedPoints>();
  const add = (key: keyof TimedPoints, point: StochPoint) => {
    const atTime = events.get(point.closeTime) ?? { daily: [], weekly: [], twoWeekly: [] };
    atTime[key].push(point);
    events.set(point.closeTime, atTime);
  };

  for (const point of points.daily) add("daily", point);
  for (const point of points.weekly) add("weekly", point);
  for (const point of points.twoWeekly) add("twoWeekly", point);
  return events;
}

export function buildCampaignSignalsFromPoints(points: CampaignPoints): CampaignSignal[] {
  let weeklyLatch = emptyMacroLatch();
  let twoWeeklyLatch = emptyMacroLatch();
  let latestWeeklyK: number | null = null;
  let latestTwoWeeklyK: number | null = null;
  let dailyEpisodeActive = false;
  let activeCampaign: CampaignSignal | null = null;
  const campaigns: CampaignSignal[] = [];

  const events = groupByCloseTime(points);
  for (const closeTime of [...events.keys()].sort((left, right) => left - right)) {
    const event = events.get(closeTime)!;

    for (const value of event.weekly) {
      weeklyLatch = advanceMacroLatch(weeklyLatch, value);
      latestWeeklyK = value.k;
    }
    for (const value of event.twoWeekly) {
      twoWeeklyLatch = advanceMacroLatch(twoWeeklyLatch, value);
      latestTwoWeeklyK = value.k;
    }

    if (activeCampaign === null) {
      if (latestWeeklyK !== null && latestWeeklyK >= 80 && !twoWeeklyLatch.reboundConfirmed) {
        weeklyLatch = emptyMacroLatch();
      }
      if (latestTwoWeeklyK !== null && latestTwoWeeklyK >= 80 && !weeklyLatch.reboundConfirmed) {
        twoWeeklyLatch = emptyMacroLatch();
      }
    }

    const bothOverbought = latestWeeklyK !== null && latestTwoWeeklyK !== null && latestWeeklyK >= 80 && latestTwoWeeklyK >= 80;
    if (activeCampaign && bothOverbought) {
      activeCampaign.exitTime = closeTime;
      activeCampaign.exitReason = "MACRO_OVERBOUGHT";
      activeCampaign = null;
      weeklyLatch = emptyMacroLatch();
      twoWeeklyLatch = emptyMacroLatch();
      latestWeeklyK = null;
      latestTwoWeeklyK = null;
    }

    if (
      activeCampaign === null &&
      weeklyLatch.reboundConfirmed &&
      twoWeeklyLatch.reboundConfirmed &&
      latestWeeklyK !== null &&
      latestTwoWeeklyK !== null &&
      latestWeeklyK < 80 &&
      latestTwoWeeklyK < 80
    ) {
      activeCampaign = {
        armTime: closeTime,
        episodeEntries: [],
        dailyOversoldEntries: [],
      };
      campaigns.push(activeCampaign);
      dailyEpisodeActive = false;
    }

    for (const daily of event.daily) {
      const isOversold = daily.k !== null && daily.k < 10;
      if (activeCampaign && isOversold) {
        activeCampaign.dailyOversoldEntries.push(daily.closeTime);
        if (!dailyEpisodeActive) activeCampaign.episodeEntries.push(daily.closeTime);
      }
      dailyEpisodeActive = isOversold;
    }
  }

  return campaigns;
}

export function buildCampaignSignals(hourly: Candle[], asOfMs: number): CampaignSignal[] {
  return buildCampaignSignalsFromPoints({
    daily: buildStochPoints(aggregateCandles(hourly, "1d", asOfMs), DAY_MS),
    weekly: buildStochPoints(aggregateCandles(hourly, "1w", asOfMs), WEEK_MS),
    twoWeekly: buildStochPoints(aggregateCandles(hourly, "2w", asOfMs), 2 * WEEK_MS),
  });
}
