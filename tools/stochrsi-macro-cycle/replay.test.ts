import assert from "node:assert/strict";
import test from "node:test";

import { HOUR_MS, type CampaignSignal, type Candle } from "./core";
import {
  buildVariantLegs,
  minimumWalletToSurvive,
  runVariant,
  settleLeg,
  summarizeVariant,
} from "./replay";

function campaignWithEpisodeCount(count: number): CampaignSignal {
  return {
    armTime: 100,
    episodeEntries: Array.from({ length: count }, (_, index) => 200 + index * 100),
    dailyOversoldEntries: Array.from({ length: count }, (_, index) => 200 + index * 100),
    exitTime: 1_000,
    exitReason: "MACRO_OVERBOUGHT",
  };
}

function bar(time: number, open: number, close = open): Candle {
  return {
    time,
    open,
    high: Math.max(open, close),
    low: Math.min(open, close),
    close,
    volume: 1,
  };
}

test("fills include adverse slippage and both fees", () => {
  const leg = settleLeg({ qty: 0.001, entryOpen: 100, exitOpen: 110, funding: [] });

  assert.equal(leg.entryPrice, 100.02);
  assert.equal(leg.exitPrice, 109.978);
  assert.equal(leg.fees, (100.02 + 109.978) * 0.001 * 0.0004);
});

test("positive funding is paid by a long", () => {
  const leg = settleLeg({
    qty: 1,
    entryOpen: 100,
    exitOpen: 110,
    funding: [{ time: 1, rate: 0.001, mark: 105 }],
  });

  assert.equal(leg.fundingPnl, -0.105);
});

test("full-at-arm matches episode qty and is simulated", () => {
  const result = buildVariantLegs(campaignWithEpisodeCount(3), "WINDOW_FULL_AT_ARM");

  assert.equal(result.legs[0].qty, 0.003);
  assert.equal(result.simulatedNotTradable, true);
});

test("minimum wallet covers worst maintenance minus pre-wallet PnL", () => {
  assert.equal(
    minimumWalletToSurvive([
      { pnlBeforeWallet: -20, maintenance: 2 },
      { pnlBeforeWallet: -35, maintenance: 3 },
    ]),
    38,
  );
});

test("all frozen variants build their prescribed entry schedules", () => {
  const campaign = campaignWithEpisodeCount(3);
  campaign.dailyOversoldEntries = [200, 300, 400, 500];

  assert.deepEqual(buildVariantLegs(campaign, "MACRO_ONCE").legs, [
    { entryTime: 100, qty: 0.001 },
  ]);
  assert.deepEqual(buildVariantLegs(campaign, "DAILY_EPISODE").legs, [
    { entryTime: 200, qty: 0.001 },
    { entryTime: 300, qty: 0.001 },
    { entryTime: 400, qty: 0.001 },
  ]);
  assert.equal(buildVariantLegs(campaign, "DAILY_EVERY_BAR").legs.length, 4);
  assert.deepEqual(buildVariantLegs(campaign, "WINDOW_FULL_AT_ARM").legs, [
    { entryTime: 100, qty: 0.003 },
  ]);
});

test("negative funding credits a long using the latest causal hourly close fallback", () => {
  const start = Date.UTC(2022, 0, 1);
  const leg = settleLeg({
    qty: 1,
    entryOpen: 100,
    exitOpen: 110,
    entryTime: start,
    exitTime: start + 3 * HOUR_MS,
    hourly: [bar(start, 100, 101), bar(start + HOUR_MS, 200, 202)],
    funding: [{ time: start + HOUR_MS, rate: -0.001 }],
  });

  assert.equal(leg.fundingPnl, 0.101);
});

test("funding at the exit timestamp is excluded after exit priority", () => {
  const start = Date.UTC(2022, 0, 1);
  const leg = settleLeg({
    qty: 1,
    entryOpen: 100,
    exitOpen: 110,
    entryTime: start,
    exitTime: start + HOUR_MS,
    hourly: [bar(start, 100, 101)],
    funding: [{ time: start + HOUR_MS, rate: 0.001, mark: 105 }],
  });

  assert.equal(leg.fundingPnl, 0);
});

test("funding at the entry timestamp is excluded because the leg was not already open", () => {
  const start = Date.UTC(2022, 0, 1);
  const leg = settleLeg({
    qty: 1,
    entryOpen: 100,
    exitOpen: 110,
    entryTime: start,
    exitTime: start + 2 * HOUR_MS,
    hourly: [bar(start, 100, 101)],
    funding: [{ time: start, rate: 0.001, mark: 100 }],
  });

  assert.equal(leg.fundingPnl, 0);
});

test("full-at-arm does not use partial future exposure for an open campaign", () => {
  const campaign = campaignWithEpisodeCount(2);
  delete campaign.exitTime;
  delete campaign.exitReason;

  assert.deepEqual(buildVariantLegs(campaign, "WINDOW_FULL_AT_ARM").legs, []);
});

test("runVariant fails closed when a next-open fill is unavailable", () => {
  const campaign = campaignWithEpisodeCount(1);

  assert.throws(
    () => runVariant("DAILY_EPISODE", [campaign], [bar(0, 100)], []),
    /next-open fill unavailable/i,
  );
});

test("open final campaign is marked at the last hourly close without exit costs", () => {
  const start = Date.UTC(2024, 0, 1);
  const campaign: CampaignSignal = {
    armTime: start,
    episodeEntries: [start],
    dailyOversoldEntries: [start],
  };
  const run = runVariant(
    "DAILY_EPISODE",
    [campaign],
    [bar(start, 100, 105), bar(start + HOUR_MS, 105, 110)],
    [],
  );
  const replay = run.campaigns[0];

  assert.equal(replay.closed, false);
  assert.equal(replay.markPrice, 110);
  assert.equal(replay.legs[0].exitPrice, undefined);
  assert.equal(replay.legs[0].fees, 100.02 * 0.001 * 0.0004);
  assert.equal(replay.netPnl, (110 - 100.02) * 0.001 - replay.legs[0].fees);
  assert.equal(run.openCampaign?.armTime, start);
});

test("hourly account path tracks equity, maintenance, drawdown, and wallet liquidation", () => {
  const start = Date.UTC(2022, 0, 1);
  const campaign: CampaignSignal = {
    armTime: start,
    episodeEntries: [start],
    dailyOversoldEntries: [start],
    exitTime: start + 3 * HOUR_MS,
    exitReason: "MACRO_OVERBOUGHT",
  };
  const run = runVariant(
    "DAILY_EPISODE",
    [campaign],
    [
      bar(start, 100_000, 100_000),
      bar(start + HOUR_MS, 100_000, 10_000),
      bar(start + 2 * HOUR_MS, 10_000, 110_000),
      bar(start + 3 * HOUR_MS, 110_000, 110_000),
    ],
    [],
    { walletSizes: [50, 100] },
  );

  assert.equal(run.accountPath.length, 4);
  assert.equal(run.maxQuantity, 0.001);
  assert.equal(run.maxNotional, 110);
  assert.ok(run.maxDrawdown > 90);
  assert.ok(run.worstUnrealizedPnl < -90);
  assert.ok(run.minimumWallet > 90);
  assert.equal(run.walletScenarios.find((item) => item.startingWallet === 100)?.liquidated, false);
  assert.equal(run.walletScenarios.find((item) => item.startingWallet === 50)?.liquidated, true);
});

test("summaries separate open campaigns and expose required stability views", () => {
  const before = Date.UTC(2022, 11, 1);
  const after = Date.UTC(2023, 1, 1);
  const open = Date.UTC(2024, 2, 1);
  const campaigns: CampaignSignal[] = [
    {
      armTime: before,
      episodeEntries: [before],
      dailyOversoldEntries: [before],
      exitTime: before + HOUR_MS,
      exitReason: "MACRO_OVERBOUGHT",
    },
    {
      armTime: after,
      episodeEntries: [after, after + HOUR_MS],
      dailyOversoldEntries: [after, after + HOUR_MS],
      exitTime: after + 2 * HOUR_MS,
      exitReason: "MACRO_OVERBOUGHT",
    },
    {
      armTime: open,
      episodeEntries: [open],
      dailyOversoldEntries: [open],
    },
  ];
  const hourly = [
    bar(before, 100, 100),
    bar(before + HOUR_MS, 110, 110),
    bar(after, 100, 100),
    bar(after + HOUR_MS, 90, 90),
    bar(after + 2 * HOUR_MS, 120, 120),
    bar(open, 100, 105),
  ];
  const run = runVariant("DAILY_EPISODE", campaigns, hourly, [], {
    walletSizes: [100, 250, 500, 1_000],
    liveWallet: { amount: 333, timestamp: open },
  });
  const summary = summarizeVariant(run);

  assert.equal(summary.closedCampaigns, 2);
  assert.equal(summary.openCampaigns, 1);
  assert.equal(summary.totalCampaigns, 3);
  assert.equal(summary.totalLegs, 4);
  assert.equal(summary.campaignWinRate, 1);
  assert.equal(summary.legWinRate, 1);
  assert.equal(summary.monthlyEntries["2023-02"], 2);
  assert.ok(summary.monthlyPnl["2023-02"] > 0);
  assert.ok(summary.yearlyPnl["2022"] > 0);
  assert.equal(summary.pre2023.campaigns, 1);
  assert.equal(summary.post2023.campaigns, 1);
  assert.ok(summary.concentration.netPnlWithoutBestOne <= summary.closedNetPnl);
  assert.ok(summary.concentration.netPnlWithoutBestThree <= summary.concentration.netPnlWithoutBestOne);
  assert.equal(summary.walletScenarios.length, 5);
  assert.equal(summary.walletScenarios[4].label, "LIVE_WALLET_FEASIBILITY");
  assert.equal(summary.openCampaign?.closed, false);
  assert.equal(summary.simulatedNotTradable, false);
  assert.equal(summary.suppressedDuplicateDailyEntries, 0);
  assert.ok(summary.bestCampaign!.maxDrawdown >= 0);
  assert.ok(summary.bestCampaign!.worstUnrealizedPnl <= 0);
});

test("summary counts repeated oversold bars suppressed by episode entry", () => {
  const start = Date.UTC(2022, 0, 1);
  const campaign: CampaignSignal = {
    armTime: start,
    episodeEntries: [start],
    dailyOversoldEntries: [start, start + HOUR_MS, start + 2 * HOUR_MS],
    exitTime: start + 3 * HOUR_MS,
    exitReason: "MACRO_OVERBOUGHT",
  };
  const hourly = [
    bar(start, 100, 90),
    bar(start + HOUR_MS, 90, 80),
    bar(start + 2 * HOUR_MS, 80, 110),
    bar(start + 3 * HOUR_MS, 110, 110),
  ];

  const summary = summarizeVariant(runVariant("DAILY_EPISODE", [campaign], hourly, []));

  assert.equal(summary.suppressedDuplicateDailyEntries, 2);
  assert.ok(summary.bestCampaign!.maxDrawdown > 0);
  assert.ok(summary.bestCampaign!.worstUnrealizedPnl < 0);
});

test("campaign drawdown includes an adverse gap at the exit open", () => {
  const start = Date.UTC(2022, 0, 1);
  const campaign: CampaignSignal = {
    armTime: start,
    episodeEntries: [start],
    dailyOversoldEntries: [start],
    exitTime: start + HOUR_MS,
    exitReason: "MACRO_OVERBOUGHT",
  };
  const run = runVariant(
    "DAILY_EPISODE",
    [campaign],
    [bar(start, 100, 100), bar(start + HOUR_MS, 50, 50)],
    [],
  );

  assert.ok(run.campaigns[0].maxDrawdown > 0.05);
  assert.ok(run.campaigns[0].worstUnrealizedPnl < -0.05);
});
