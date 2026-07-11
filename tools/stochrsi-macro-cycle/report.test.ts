import assert from "node:assert/strict";
import test from "node:test";

import type { CampaignSignal, Candle } from "./core";
import type { Provenance } from "./io";
import { runFrozenVariants } from "./replay";
import {
  JSON_OUTPUT_PATH,
  MARKDOWN_OUTPUT_PATH,
  buildReport,
  renderMarkdown,
  serializeReport,
  type BuildReportInput,
} from "./report";

const START = Date.UTC(2022, 0, 1);

function bar(time: number, price: number): Candle {
  return {
    time,
    open: price,
    high: price + 2,
    low: price - 2,
    close: price + 1,
    volume: 10,
  };
}

function input(completedCampaigns: number): BuildReportInput {
  const hourly = Array.from({ length: completedCampaigns * 3 + 2 }, (_, index) =>
    bar(START + index * 3_600_000, 20_000 + index * 100),
  );
  const campaigns: CampaignSignal[] = Array.from(
    { length: completedCampaigns },
    (_, index) => {
      const armTime = START + index * 3 * 3_600_000;
      return {
        armTime,
        episodeEntries: index === 0 ? [] : [armTime],
        episodeRecoveryTimes: index === 0 ? [] : [null],
        dailyOversoldEntries: index === 0 ? [] : [armTime, armTime + 3_600_000],
        exitTime: armTime + 2 * 3_600_000,
        exitReason: "MACRO_OVERBOUGHT",
      };
    },
  );
  const provenance: Provenance = {
    source: "https://fapi.binance.com",
    symbol: "BTCUSDT",
    interval: "1h",
    refreshedAt: "2026-07-11T12:34:56.789Z",
    asOfMs: Date.UTC(2026, 6, 11, 12),
    gitSha: "abc123",
    gitDirty: false,
    evaluatorVersion: "stochrsi-macro-cycle/v1",
    hourly: {
      path: ".cache/binance-futures-btcusdt-1h-7y.json",
      sha256: "a".repeat(64),
      range: {
        firstTime: hourly[0].time,
        lastTime: hourly.at(-1)!.time,
        rowCount: hourly.length,
      },
    },
    funding: {
      path: ".cache/binance-futures-btcusdt-funding-7y.json",
      sha256: "b".repeat(64),
      range: { firstTime: null, lastTime: null, rowCount: 0 },
    },
    gaps: [],
  };
  return {
    provenance,
    campaigns,
    variants: runFrozenVariants(campaigns, hourly, []),
    warmupRange: {
      firstDailyValidTime: START,
      firstWeeklyValidTime: START,
      firstTwoWeeklyValidTime: START,
      firstAllIndicatorsValidTime: START,
      lastCompletedHourTime: hourly.at(-1)!.time,
    },
  };
}

function hybridPassInput(): BuildReportInput {
  const reportInput = input(3);
  const campaigns: CampaignSignal[] = Array.from({ length: 3 }, (_, index) => {
    const armTime = START + index * 4 * 3_600_000;
    return {
      armTime,
      episodeEntries: [armTime, armTime + 3_600_000],
      episodeRecoveryTimes: [null, armTime + 2 * 3_600_000],
      dailyOversoldEntries: [armTime, armTime + 3_600_000],
      exitTime: armTime + 3 * 3_600_000,
      exitReason: "MACRO_OVERBOUGHT",
    };
  });
  const hourly = campaigns.flatMap((campaign) => [
    bar(campaign.armTime, 100),
    bar(campaign.armTime + 3_600_000, 100),
    bar(campaign.armTime + 2 * 3_600_000, 120),
    bar(campaign.armTime + 3 * 3_600_000, 110),
  ]);
  reportInput.campaigns = campaigns;
  reportInput.variants = runFrozenVariants(campaigns, hourly, []);
  reportInput.provenance.hourly.range = {
    firstTime: hourly[0].time,
    lastTime: hourly.at(-1)!.time,
    rowCount: hourly.length,
  };
  reportInput.warmupRange.lastCompletedHourTime = hourly.at(-1)!.time;
  return reportInput;
}

test("buildReport emits the complete frozen schema and insufficient-sample verdict", () => {
  const report = buildReport(input(4), { generatedAt: "2026-07-11T13:00:00.000Z" });
  const primary = report.variants.find((variant) => variant.name === "DAILY_EPISODE")!;
  const simulated = report.variants.find((variant) => variant.name === "WINDOW_FULL_AT_ARM")!;
  const matched = report.variants.find((variant) => variant.name === "DAILY_EPISODE_MATCHED_PEAK")!;

  assert.equal(report.schemaVersion, "btc-stochrsi-macro-cycle-report/v3");
  assert.equal(report.verdict, "INSUFFICIENT_SAMPLE");
  assert.equal(report.hybridVerdict.verdict, "KILL");
  assert.deepEqual(report.hybridVerdict.checks.map((check) => check.id), [
    "ENTRY_PARITY",
    "PEAK_QUANTITY",
    "CLOSED_NET_PNL_POSITIVE",
    "TOTAL_NET_PNL_POSITIVE",
    "BEATS_MATCHED_PEAK",
    "TACTICAL_NET_PNL_POSITIVE",
    "FIXED_WALLETS_SURVIVE",
    "CAMPAIGN_CONSISTENCY",
  ]);
  assert.deepEqual(report.hybridVerdict.checks.map((check) => check.passed), [
    true,
    true,
    true,
    true,
    false,
    false,
    true,
    false,
  ]);
  for (const check of report.hybridVerdict.checks) {
    assert.equal(typeof check.passed, "boolean");
    assert.notEqual(check.actual, undefined);
    assert.notEqual(check.requirement, undefined);
  }
  assert.equal(
    (report.hybridVerdict.checks[0].actual as { dailyEpisodeEntryCount: number }).dailyEpisodeEntryCount,
    3,
  );
  assert.equal(
    (report.hybridVerdict.checks[0].actual as { hybridEntryCount: number }).hybridEntryCount,
    3,
  );
  assert.equal(
    (report.hybridVerdict.checks[0].actual as { orderedTimestampsEqual: boolean }).orderedTimestampsEqual,
    true,
  );
  assert.deepEqual(
    (report.hybridVerdict.checks[0].actual as {
      dailyEpisodeEntryTimes: number[];
      hybridEntryTimes: number[];
    }).dailyEpisodeEntryTimes,
    (report.hybridVerdict.checks[0].actual as {
      dailyEpisodeEntryTimes: number[];
      hybridEntryTimes: number[];
    }).hybridEntryTimes,
  );
  assert.deepEqual(report.hybridVerdict.checks[6].actual, [
    { startingWallet: 250, liquidated: false },
    { startingWallet: 500, liquidated: false },
    { startingWallet: 1_000, liquidated: false },
  ]);
  assert.deepEqual(report.hybridVerdict.checks[7].requirement, {
    minimumPositiveCompletedCampaigns: 2,
  });
  assert.equal(report.campaigns.completed, 4);
  assert.equal(primary.zeroEntryCampaigns, 1);
  assert.equal(primary.walletScenarios.length, 4);
  assert.deepEqual(primary.walletScenarios.map((wallet) => wallet.startingWallet), [100, 250, 500, 1_000]);
  assert.equal(simulated.warning, "SIMULATED_NOT_TRADABLE");
  assert.equal(matched.warning, "SIMULATED_NOT_TRADABLE");
  assert.equal(report.strategy.stopLoss, null);
  assert.deepEqual(report.liveWalletFeasibility, {
    status: "NOT_SUPPLIED_TO_OFFLINE_EVALUATOR",
    reason: "Deterministic offline replay does not access live account state.",
  });
  assert.equal("refreshedAt" in report.data.provenance, false);
  assert.equal("asOfMs" in report.data.provenance, false);
  assert.equal(report.data.dataCutoffTime, report.data.rawRange.lastTime! + 3_600_000);
  assert.equal(JSON_OUTPUT_PATH, "assets/backtest_btc_stochrsi_macro_cycle_7y.json");
  assert.equal(MARKDOWN_OUTPUT_PATH, "docs/backtest-btc-stochrsi-macro-cycle-2026-07-11.md");
});

test("generatedAt is the only report field allowed to vary", () => {
  const reportInput = input(5);
  const first = buildReport(reportInput, { generatedAt: "2026-07-11T13:00:00.000Z" });
  const second = buildReport(reportInput, { generatedAt: "2026-07-11T14:00:00.000Z" });
  const { generatedAt: firstGeneratedAt, ...firstStable } = first;
  const { generatedAt: secondGeneratedAt, ...secondStable } = second;

  assert.notEqual(firstGeneratedAt, secondGeneratedAt);
  assert.deepEqual(firstStable, secondStable);
  assert.equal(first.verdict, "EVALUATED");
});

test("Hybrid mechanical verdict passes only when all eight frozen checks pass", () => {
  const report = buildReport(hybridPassInput(), { generatedAt: "2026-07-11T13:00:00.000Z" });

  assert.equal(report.verdict, "INSUFFICIENT_SAMPLE");
  assert.equal(report.hybridVerdict.verdict, "PASS");
  assert.equal(report.hybridVerdict.checks.length, 8);
  assert.equal(report.hybridVerdict.checks.every((check) => check.passed), true);
});

test("Markdown states the frozen strategy, no stop loss, sample limit, and simulated warning", () => {
  const markdown = renderMarkdown(
    buildReport(input(4), { generatedAt: "2026-07-11T13:00:00.000Z" }),
  );

  assert.match(markdown, /RSI 14.*StochRSI 14.*%K SMA 3.*%D SMA 3/s);
  assert.match(markdown, /1W and 2W.*below 20.*bullish cross/s);
  assert.match(markdown, /1D %K < 10/);
  assert.match(markdown, /No stop loss/);
  assert.match(markdown, /fewer than 5 completed DAILY_EPISODE campaigns/);
  assert.match(markdown, /WINDOW_FULL_AT_ARM: SIMULATED_NOT_TRADABLE/);
  assert.match(markdown, /DAILY_EPISODE_MATCHED_PEAK: SIMULATED_NOT_TRADABLE/);
  assert.match(markdown, /Hybrid mechanical verdict: KILL/);
  for (const id of [
    "ENTRY_PARITY",
    "PEAK_QUANTITY",
    "CLOSED_NET_PNL_POSITIVE",
    "TOTAL_NET_PNL_POSITIVE",
    "BEATS_MATCHED_PEAK",
    "TACTICAL_NET_PNL_POSITIVE",
    "FIXED_WALLETS_SURVIVE",
    "CAMPAIGN_CONSISTENCY",
  ]) assert.match(markdown, new RegExp(id));
  assert.match(markdown, /Hybrid role attribution/);
  assert.match(markdown, /CORE/);
  assert.match(markdown, /TACTICAL/);
  assert.match(markdown, /Monthly entries and realized PnL/);
  assert.match(markdown, /Pre-\/post-2023/);
  assert.match(markdown, /Entry \(all campaigns, exposure-matched\)/);
  assert.match(markdown, /Entry \(closed campaigns only, exposure-matched\)/);
  assert.match(markdown, /Realized legs \/ all legs/);
  assert.match(markdown, /Closed campaign WR/);
  assert.match(markdown, /Realized leg WR/);
  assert.match(markdown, /Closed net/);
  assert.match(
    markdown,
    /Returns \(closed campaigns only\):[^\n]+\nLeg counts \(all campaigns\):/,
  );
  assert.match(markdown, /Live-wallet snapshot: NOT_SUPPLIED_TO_OFFLINE_EVALUATOR/);
  assert.match(markdown, /Scenario \| Basis \| Snapshot/);
  assert.doesNotMatch(markdown, /No partial close/);
  assert.match(markdown, /Each leg is fully closed/);
  assert.match(markdown, /Hybrid tactical legs may exit before the macro campaign/);
});

test("serialization rejects malformed non-finite evidence instead of converting it to null", () => {
  const report = buildReport(input(5), { generatedAt: "2026-07-11T13:00:00.000Z" });
  report.variants[0].totalNetPnl = Number.POSITIVE_INFINITY;

  assert.throws(() => serializeReport(report), /Non-finite report value at .*totalNetPnl/);
});

test("Markdown marks post-liquidation ROI invalid without formatting null as a percent", () => {
  const report = buildReport(input(5), { generatedAt: "2026-07-11T13:00:00.000Z" });
  const wallet = report.variants[0].walletScenarios[0];
  wallet.liquidated = true;
  wallet.liquidationCount = 1;
  wallet.scaleTestRoiPct = null;
  wallet.outcome = "LIQUIDATED_PATH_INVALID";

  const markdown = renderMarkdown(report);

  assert.match(
    markdown,
    /\| FIXED_WALLET \| FULL_HISTORY_SCALE_TEST \| null \| 100 \| null \| LIQUIDATED_PATH_INVALID \| true \| 1 \|/,
  );
  assert.doesNotMatch(markdown, /null%/);
});
