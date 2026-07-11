import assert from "node:assert/strict";
import test from "node:test";

import type { CampaignSignal, Candle } from "./core";
import type { Provenance } from "./io";
import { runVariant, VARIANT_NAMES } from "./replay";
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
    variants: VARIANT_NAMES.map((name) => runVariant(name, campaigns, hourly, [])),
    warmupRange: {
      firstDailyValidTime: START,
      firstWeeklyValidTime: START,
      firstTwoWeeklyValidTime: START,
      firstAllIndicatorsValidTime: START,
      lastCompletedHourTime: hourly.at(-1)!.time,
    },
  };
}

test("buildReport emits the complete frozen schema and insufficient-sample verdict", () => {
  const report = buildReport(input(4), { generatedAt: "2026-07-11T13:00:00.000Z" });
  const primary = report.variants.find((variant) => variant.name === "DAILY_EPISODE")!;
  const simulated = report.variants.find((variant) => variant.name === "WINDOW_FULL_AT_ARM")!;

  assert.equal(report.verdict, "INSUFFICIENT_SAMPLE");
  assert.equal(report.campaigns.completed, 4);
  assert.equal(primary.zeroEntryCampaigns, 1);
  assert.equal(primary.walletScenarios.length, 4);
  assert.deepEqual(primary.walletScenarios.map((wallet) => wallet.startingWallet), [100, 250, 500, 1_000]);
  assert.equal(simulated.warning, "SIMULATED_NOT_TRADABLE");
  assert.equal(report.strategy.stopLoss, null);
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
  assert.match(markdown, /Monthly entries and realized PnL/);
  assert.match(markdown, /Pre-\/post-2023/);
  assert.match(markdown, /Entry \(all campaigns, exposure-matched\)/);
  assert.match(markdown, /Entry \(closed campaigns only, exposure-matched\)/);
});

test("serialization rejects malformed non-finite evidence instead of converting it to null", () => {
  const report = buildReport(input(5), { generatedAt: "2026-07-11T13:00:00.000Z" });
  report.variants[0].totalNetPnl = Number.POSITIVE_INFINITY;

  assert.throws(() => serializeReport(report), /Non-finite report value at .*totalNetPnl/);
});
