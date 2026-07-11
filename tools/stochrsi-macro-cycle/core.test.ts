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
  const input = Array.from({ length: 8 * 24 }, (_, i) => bar(monday + i * HOUR_MS, 100 + i));

  const out = aggregateCandles(input, "1w", monday + 7 * DAY_MS);

  assert.equal(out.length, 1);
  assert.equal(out[0].time, monday);
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
