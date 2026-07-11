import assert from "node:assert/strict";
import { test } from "node:test";
import {
  advanceMacroLatch,
  aggregateCandles,
  buildCampaignSignalsFromPoints,
  DAY_MS,
  emptyMacroLatch,
  HOUR_MS,
  MONDAY_ANCHOR_MS,
  WEEK_MS,
  type Candle,
  type StochPoint,
} from "./core";

function bar(time: number, close: number): Candle {
  return {
    time,
    open: close - 1,
    high: close + 1,
    low: close - 2,
    close,
    volume: 1,
  };
}

function hourlyBars(start: number, count: number): Candle[] {
  return Array.from({ length: count }, (_, index) => bar(start + index * HOUR_MS, 100 + index));
}

function point(closeTime: number, k: number | null, d: number | null = k): StochPoint {
  return {
    ...bar(closeTime - DAY_MS, 100),
    closeTime,
    k,
    d,
  };
}

function macroRecoveryPoints() {
  const start = Date.UTC(2026, 0, 1);
  return {
    weekly: [point(start + DAY_MS, 15, 18), point(start + 2 * DAY_MS, 22, 19)],
    twoWeekly: [point(start + DAY_MS, 15, 18), point(start + 2 * DAY_MS, 22, 19)],
    firstDailyClose: start + 3 * DAY_MS,
  };
}

function fixtureWithDailyK(dailyK: number[]) {
  const macro = macroRecoveryPoints();
  return {
    weekly: macro.weekly,
    twoWeekly: macro.twoWeekly,
    daily: dailyK.map((k, index) => point(macro.firstDailyClose + index * DAY_MS, k)),
  };
}

function fixtureExitAndOversoldTogether() {
  const macro = macroRecoveryPoints();
  const exitCloseTime = macro.firstDailyClose;
  return {
    weekly: [...macro.weekly, point(exitCloseTime, 80, 70)],
    twoWeekly: [...macro.twoWeekly, point(exitCloseTime, 80, 70)],
    daily: [point(exitCloseTime, 5)],
  };
}

test("1W starts Monday and drops the incomplete next week", () => {
  const monday = Date.UTC(2026, 0, 5);
  const input = hourlyBars(monday, 8 * 24);

  const out = aggregateCandles(input, "1w", monday + 7 * DAY_MS);

  assert.equal(out.length, 1);
  assert.equal(out[0].time, monday);
});

test("1D aggregation preserves its hourly OHLCV boundaries", () => {
  const start = Date.UTC(2026, 0, 5);

  const out = aggregateCandles(hourlyBars(start, 24), "1d", start + DAY_MS);

  assert.deepEqual(out, [{ ...bar(start, 100), time: start, high: 124, low: 98, close: 123, volume: 24 }]);
});

test("2W aggregation preserves its Monday-aligned OHLCV boundaries", () => {
  const start = Date.UTC(2026, 0, 5);

  const out = aggregateCandles(hourlyBars(start, 2 * 7 * 24), "2w", start + 2 * 7 * DAY_MS);

  assert.deepEqual(out, [{ ...bar(start, 100), time: start, high: 436, low: 98, close: 435, volume: 336 }]);
});

test("drops a complete 1W bucket when its first or final source hour is missing", () => {
  const start = Date.UTC(2026, 0, 5);
  const fullBucket = hourlyBars(start, 7 * 24);

  const bucketLengths = [0, fullBucket.length - 1].map((missingIndex) =>
    aggregateCandles(
      fullBucket.filter((_, index) => index !== missingIndex),
      "1w",
      start + WEEK_MS,
    ).length,
  );

  assert.deepEqual(bucketLengths, [0, 0]);
});

test("keeps a complete 1W bucket when only an internal source hour is missing", () => {
  const start = Date.UTC(2026, 0, 5);
  const out = aggregateCandles(
    hourlyBars(start, 7 * 24).filter((_, index) => index !== 72),
    "1w",
    start + WEEK_MS,
  );

  assert.equal(out.length, 1);
  assert.equal(out[0].volume, 167);
  assert.equal(out[0].close, 267);
});

test("2W anchor is stable", () => {
  assert.equal(MONDAY_ANCHOR_MS, Date.UTC(1970, 0, 5));
});

test("macro needs oversold before a later bullish K/D cross", () => {
  let state = emptyMacroLatch();
  state = advanceMacroLatch(state, { k: 15, d: 18 });
  state = advanceMacroLatch(state, { k: 22, d: 19 });

  assert.equal(state.reboundConfirmed, true);
});

test("overbought clears a confirmed latch before the other macro timeframe confirms", () => {
  const start = Date.UTC(2026, 0, 1);
  const campaigns = buildCampaignSignalsFromPoints({
    weekly: [
      point(start + DAY_MS, 15, 18),
      point(start + 2 * DAY_MS, 22, 19),
      point(start + 3 * DAY_MS, 80, 70),
      point(start + 4 * DAY_MS, 50, 55),
    ],
    twoWeekly: [point(start + 5 * DAY_MS, 15, 18), point(start + 6 * DAY_MS, 22, 19)],
    daily: [],
  });

  assert.equal(campaigns.length, 0);
});

test("multi-day daily oversold produces one entry", () => {
  const campaigns = buildCampaignSignalsFromPoints(fixtureWithDailyK([12, 8, 5, 7, 11, 9]));

  assert.equal(campaigns[0].episodeEntries.length, 2);
});

test("exit wins over same-time entry", () => {
  const campaign = buildCampaignSignalsFromPoints(fixtureExitAndOversoldTogether())[0];

  assert.equal(campaign.episodeEntries.length, 0);
  assert.equal(campaign.exitReason, "MACRO_OVERBOUGHT");
});

test("arms when 1W and 2W rebound confirmations close asynchronously", () => {
  const start = Date.UTC(2026, 0, 1);
  const armTime = start + 5 * DAY_MS;
  const campaigns = buildCampaignSignalsFromPoints({
    weekly: [point(start + DAY_MS, 15, 18), point(start + 2 * DAY_MS, 22, 19)],
    twoWeekly: [point(start + 4 * DAY_MS, 15, 18), point(armTime, 22, 19)],
    daily: [],
  });

  assert.equal(campaigns.length, 1);
  assert.equal(campaigns[0].armTime, armTime);
});

test("records a daily oversold intent at that daily close time", () => {
  const macro = macroRecoveryPoints();
  const dailyCloseTime = macro.firstDailyClose;
  const campaign = buildCampaignSignalsFromPoints({
    weekly: macro.weekly,
    twoWeekly: macro.twoWeekly,
    daily: [point(dailyCloseTime, 5)],
  })[0];

  assert.deepEqual(campaign.episodeEntries, [dailyCloseTime]);
  assert.equal(campaign.episodeEntries[0], dailyCloseTime);
});

test("leaves the final open campaign without an exit time", () => {
  const macro = macroRecoveryPoints();
  const campaign = buildCampaignSignalsFromPoints({
    weekly: macro.weekly,
    twoWeekly: macro.twoWeekly,
    daily: [],
  })[0];

  assert.equal(campaign.exitTime, undefined);
});
