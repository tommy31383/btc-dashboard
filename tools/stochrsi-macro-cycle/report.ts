import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  DAY_MS,
  HOUR_MS,
  WEEK_MS,
  aggregateCandles,
  buildStochPoints,
  type CampaignSignal,
  type Candle,
} from "./core";
import type { DataRange, Provenance } from "./io";
import {
  FEE_RATE,
  MAINTENANCE_RATE,
  QTY_PER_LEG,
  SLIPPAGE_RATE,
  VARIANT_NAMES,
  summarizeVariant,
  type CampaignReplay,
  type VariantName,
  type VariantRun,
  type VariantSummary,
} from "./replay";

export const JSON_OUTPUT_PATH = "assets/backtest_btc_stochrsi_macro_cycle_7y.json";
export const MARKDOWN_OUTPUT_PATH = "docs/backtest-btc-stochrsi-macro-cycle-2026-07-11.md";

export interface WarmupRange {
  firstDailyValidTime: number;
  firstWeeklyValidTime: number;
  firstTwoWeeklyValidTime: number;
  firstAllIndicatorsValidTime: number;
  lastCompletedHourTime: number;
}

type StableProvenance = Omit<Provenance, "refreshedAt" | "asOfMs">;

export interface ReportVariant extends VariantSummary {
  warning: "SIMULATED_NOT_TRADABLE" | null;
  campaigns: CampaignReplay[];
}

export interface MacroCycleReport {
  schemaVersion: "btc-stochrsi-macro-cycle-report/v1";
  generatedAt: string;
  verdict: "INSUFFICIENT_SAMPLE" | "EVALUATED";
  sampleLimitation: string;
  strategy: {
    asset: "BTCUSDT";
    primaryVariant: "DAILY_EPISODE";
    indicator: {
      rsiPeriod: 14;
      stochasticLookback: 14;
      kSma: 3;
      dSma: 3;
      source: "close";
      scale: "0..100";
    };
    macroArm: string;
    dailyEntry: string;
    macroExit: string;
    fill: "NEXT_AVAILABLE_DAILY_OPEN";
    quantityPerLegBtc: number;
    feeRatePerSide: number;
    adverseSlippageRatePerSide: number;
    funding: "HISTORICAL_APPLIED_TO_EACH_OPEN_LEG";
    maintenanceRate: number;
    stopLoss: null;
    partialClose: false;
    maximumHoldExit: false;
    frozenVariants: VariantName[];
  };
  data: {
    rawRange: DataRange;
    fundingRange: DataRange;
    warmupRange: WarmupRange;
    dataCutoffTime: number;
    provenance: StableProvenance;
  };
  campaigns: {
    totalMacroCycles: number;
    completed: number;
    open: number;
    zeroDailyEpisodeEntries: number;
    oneDailyEpisodeEntry: number;
    multipleDailyEpisodeEntries: number;
    signals: CampaignSignal[];
  };
  variants: ReportVariant[];
}

export interface BuildReportInput {
  provenance: Provenance;
  campaigns: CampaignSignal[];
  variants: VariantRun[];
  warmupRange: WarmupRange;
}

export interface BuildReportOptions {
  generatedAt?: string;
}

function firstValidTime(
  hourly: Candle[],
  asOfMs: number,
  span: "1d" | "1w" | "2w",
  spanMs: number,
): number | undefined {
  return buildStochPoints(aggregateCandles(hourly, span, asOfMs), spanMs)
    .find((point) => point.k !== null && point.d !== null)?.closeTime;
}

export function buildWarmupRange(hourly: Candle[], asOfMs: number): WarmupRange {
  if (hourly.length === 0) throw new Error("Cannot derive warmup range without hourly candles");
  const firstDailyValidTime = firstValidTime(hourly, asOfMs, "1d", DAY_MS);
  const firstWeeklyValidTime = firstValidTime(hourly, asOfMs, "1w", WEEK_MS);
  const firstTwoWeeklyValidTime = firstValidTime(hourly, asOfMs, "2w", 2 * WEEK_MS);
  if (
    firstDailyValidTime === undefined ||
    firstWeeklyValidTime === undefined ||
    firstTwoWeeklyValidTime === undefined
  ) {
    throw new Error("Insufficient completed candles for 1D/1W/2W StochRSI warmup");
  }
  return {
    firstDailyValidTime,
    firstWeeklyValidTime,
    firstTwoWeeklyValidTime,
    firstAllIndicatorsValidTime: Math.max(
      firstDailyValidTime,
      firstWeeklyValidTime,
      firstTwoWeeklyValidTime,
    ),
    lastCompletedHourTime: hourly.at(-1)!.time,
  };
}

function requireVariant(variants: VariantRun[], name: VariantName): VariantRun {
  const matches = variants.filter((variant) => variant.name === name);
  if (matches.length !== 1) throw new Error(`Expected exactly one ${name} variant, received ${matches.length}`);
  return matches[0];
}

function validateGeneratedAt(generatedAt: string): void {
  if (!Number.isFinite(Date.parse(generatedAt))) throw new Error(`Invalid generatedAt: ${generatedAt}`);
}

export function buildReport(
  input: BuildReportInput,
  options: BuildReportOptions = {},
): MacroCycleReport {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  validateGeneratedAt(generatedAt);
  const orderedRuns = VARIANT_NAMES.map((name) => requireVariant(input.variants, name));
  if (input.variants.length !== VARIANT_NAMES.length) {
    throw new Error(`Expected ${VARIANT_NAMES.length} frozen variants, received ${input.variants.length}`);
  }
  const macroOnce = requireVariant(orderedRuns, "MACRO_ONCE");
  const dailyEpisode = requireVariant(orderedRuns, "DAILY_EPISODE");
  const completed = dailyEpisode.campaigns.filter((campaign) => campaign.closed).length;
  const episodeCounts = input.campaigns.map((campaign) => campaign.episodeEntries.length);
  const { refreshedAt: _refreshedAt, asOfMs: _asOfMs, ...stableProvenance } = input.provenance;
  const rawRange = input.provenance.hourly.range;
  if (rawRange.lastTime === null) throw new Error("Hourly provenance must include a last timestamp");

  return {
    schemaVersion: "btc-stochrsi-macro-cycle-report/v1",
    generatedAt,
    verdict: completed < 5 ? "INSUFFICIENT_SAMPLE" : "EVALUATED",
    sampleLimitation:
      `${completed} completed DAILY_EPISODE campaigns; fewer than 5 completed DAILY_EPISODE campaigns ` +
      "forces INSUFFICIENT_SAMPLE. " +
      "Historical results are evidence for this frozen hypothesis only and do not authorize live trading.",
    strategy: {
      asset: "BTCUSDT",
      primaryVariant: "DAILY_EPISODE",
      indicator: {
        rsiPeriod: 14,
        stochasticLookback: 14,
        kSma: 3,
        dSma: 3,
        source: "close",
        scale: "0..100",
      },
      macroArm:
        "Independently observe 1W and 2W %K or %D below 20, then a later bullish %K/%D cross; arm when both rebounds are confirmed and both %K are below 80.",
      dailyEntry:
        "While armed, buy once per distinct closed-1D %K < 10 episode; rearm only after closed-1D %K >= 10.",
      macroExit: "Close the whole campaign when latest completed 1W and 2W %K are both >= 80.",
      fill: "NEXT_AVAILABLE_DAILY_OPEN",
      quantityPerLegBtc: QTY_PER_LEG,
      feeRatePerSide: FEE_RATE,
      adverseSlippageRatePerSide: SLIPPAGE_RATE,
      funding: "HISTORICAL_APPLIED_TO_EACH_OPEN_LEG",
      maintenanceRate: MAINTENANCE_RATE,
      stopLoss: null,
      partialClose: false,
      maximumHoldExit: false,
      frozenVariants: [...VARIANT_NAMES],
    },
    data: {
      rawRange,
      fundingRange: input.provenance.funding.range,
      warmupRange: input.warmupRange,
      dataCutoffTime: rawRange.lastTime + HOUR_MS,
      provenance: stableProvenance,
    },
    campaigns: {
      totalMacroCycles: input.campaigns.length,
      completed,
      open: input.campaigns.filter((campaign) => campaign.exitTime === undefined).length,
      zeroDailyEpisodeEntries: episodeCounts.filter((count) => count === 0).length,
      oneDailyEpisodeEntry: episodeCounts.filter((count) => count === 1).length,
      multipleDailyEpisodeEntries: episodeCounts.filter((count) => count > 1).length,
      signals: input.campaigns,
    },
    variants: orderedRuns.map((run) => ({
      ...summarizeVariant(run, macroOnce),
      warning: run.name === "WINDOW_FULL_AT_ARM" ? "SIMULATED_NOT_TRADABLE" : null,
      campaigns: run.campaigns,
    })),
  };
}

function assertFiniteReportValue(value: unknown, path: string): void {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error(`Non-finite report value at ${path}`);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertFiniteReportValue(entry, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      assertFiniteReportValue(entry, `${path}.${key}`);
    }
  }
}

export function serializeReport(report: MacroCycleReport): string {
  assertFiniteReportValue(report, "$report");
  return `${JSON.stringify(report, null, 2)}\n`;
}

function formatNumber(value: number | null, digits = 4): string {
  if (value === null) return "null";
  if (!Number.isFinite(value)) throw new Error("Cannot render non-finite report number");
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
    useGrouping: false,
  });
}

function formatTime(value: number | null | undefined): string {
  return value === null || value === undefined ? "null" : new Date(value).toISOString();
}

function sortedKeys(...records: Array<Record<string, number>>): string[] {
  return [...new Set(records.flatMap((record) => Object.keys(record)))].sort();
}

function campaignLabel(campaign: CampaignReplay | null | undefined): string {
  if (!campaign) return "null";
  return `${formatTime(campaign.armTime)} -> ${formatTime(campaign.exitTime ?? campaign.markTime)}; ` +
    `${campaign.legs.length} legs; net ${formatNumber(campaign.netPnl)} USDT`;
}

export function renderMarkdown(report: MacroCycleReport): string {
  assertFiniteReportValue(report, "$report");
  const lines: string[] = [
    "# BTC-only StochRSI Macro-cycle Backtest",
    "",
    `**Verdict: ${report.verdict}**`,
    "",
    `Sample limitation: ${report.sampleLimitation}`,
    "",
    "## Frozen strategy",
    "",
    "BTCUSDT only. RSI 14, StochRSI 14, %K SMA 3, %D SMA 3, close source, 0..100 scale.",
    "1W and 2W each must first move below 20 in %K or %D and later produce a bullish cross. " +
      "The macro cycle arms only after both rebounds confirm while both %K values remain below 80.",
    "During the armed cycle, DAILY_EPISODE buys 0.001 BTC once per distinct closed-1D %K < 10 episode " +
      "at the next available daily open. It rearms after closed-1D %K >= 10.",
    "The whole campaign exits at the next available daily open after completed 1W and 2W %K are both >= 80.",
    "No stop loss. No partial close. No maximum-hold exit. Historical funding applies to every open leg.",
    `Costs: ${formatNumber(report.strategy.feeRatePerSide * 100)}% taker fee per side and ` +
      `${formatNumber(report.strategy.adverseSlippageRatePerSide * 100)}% adverse slippage per side.`,
    "",
    "## Data and provenance",
    "",
    `- Raw hourly range: ${formatTime(report.data.rawRange.firstTime)} to ${formatTime(report.data.rawRange.lastTime)} ` +
      `(${report.data.rawRange.rowCount} rows)`,
    `- All-indicator warmup completes: ${formatTime(report.data.warmupRange.firstAllIndicatorsValidTime)}`,
    `- Valid 1D / 1W / 2W: ${formatTime(report.data.warmupRange.firstDailyValidTime)} / ` +
      `${formatTime(report.data.warmupRange.firstWeeklyValidTime)} / ${formatTime(report.data.warmupRange.firstTwoWeeklyValidTime)}`,
    `- Deterministic data cutoff: ${formatTime(report.data.dataCutoffTime)}`,
    `- Hourly SHA-256: ${report.data.provenance.hourly.sha256}`,
    `- Funding SHA-256: ${report.data.provenance.funding.sha256}`,
    `- Evaluator: ${report.data.provenance.evaluatorVersion} at ${report.data.provenance.gitSha}; dirty=${report.data.provenance.gitDirty}`,
    `- Listed >3h source gaps: ${report.data.provenance.gaps.length}`,
    "",
    "## Campaign inventory",
    "",
    `Macro cycles: ${report.campaigns.totalMacroCycles}; completed: ${report.campaigns.completed}; open: ${report.campaigns.open}; ` +
      `zero/one/multiple DAILY_EPISODE entries: ${report.campaigns.zeroDailyEpisodeEntries}/` +
      `${report.campaigns.oneDailyEpisodeEntry}/${report.campaigns.multipleDailyEpisodeEntries}.`,
    "",
    "| Arm | Exit | Episode entries | Every-bar entries | Status |",
    "|---|---|---:|---:|---|",
    ...report.campaigns.signals.map((campaign) =>
      `| ${formatTime(campaign.armTime)} | ${formatTime(campaign.exitTime)} | ${campaign.episodeEntries.length} | ` +
      `${campaign.dailyOversoldEntries.length} | ${campaign.exitTime === undefined ? "OPEN" : "COMPLETED"} |`,
    ),
    "",
    "## Variant summary",
    "",
    "**WINDOW_FULL_AT_ARM: SIMULATED_NOT_TRADABLE. It uses the future DAILY_EPISODE leg count and is only an exposure-normalized timing counterfactual.**",
    "",
    "| Variant | Warning | Closed/open/zero | Legs | Campaign WR | Leg WR | Gross | Fees | Slippage | Funding | Net | Max DD | Worst unrealized | Min wallet | Max qty | Max notional |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...report.variants.map((variant) =>
      `| ${variant.name} | ${variant.warning ?? "TRADABLE_REPLAY"} | ` +
      `${variant.closedCampaigns}/${variant.openCampaigns}/${variant.zeroEntryCampaigns} | ${variant.totalLegs} | ` +
      `${formatNumber(variant.campaignWinRate * 100)}% | ${formatNumber(variant.legWinRate * 100)}% | ` +
      `${formatNumber(variant.grossPnl)} | ${formatNumber(variant.fees)} | ${formatNumber(variant.slippageCost)} | ` +
      `${formatNumber(variant.fundingPnl)} | ${formatNumber(variant.totalNetPnl)} | ${formatNumber(variant.maxDrawdown)} | ` +
      `${formatNumber(variant.worstUnrealizedPnl)} | ${formatNumber(variant.minimumWallet)} | ` +
      `${formatNumber(variant.maxQuantity, 6)} | ${formatNumber(variant.maxNotional)} |`,
    ),
  ];

  for (const variant of report.variants) {
    lines.push(
      "",
      `## ${variant.name}${variant.warning ? ` - ${variant.warning}` : ""}`,
      "",
      `Returns: expectancy ${formatNumber(variant.netExpectancy)} USDT; average ${formatNumber(variant.averageReturnPct)}%; ` +
        `median ${formatNumber(variant.medianReturnPct)}%. Average/median legs per campaign: ` +
        `${formatNumber(variant.averageLegsPerCampaign)}/${formatNumber(variant.medianLegsPerCampaign)}.`,
      `Timing: average hold ${formatNumber(variant.averageHoldHours)}h; average underwater ` +
        `${formatNumber(variant.averageUnderwaterHours)}h; suppressed duplicate daily entries ` +
        `${variant.suppressedDuplicateDailyEntries}.`,
      `Entry (all campaigns, exposure-matched): weighted average ${formatNumber(variant.weightedAverageEntry)}; ` +
        `improvement vs MACRO_ONCE ${formatNumber(variant.weightedEntryImprovementVsMacroOncePct)}%.`,
      `Entry (closed campaigns only, exposure-matched): weighted average ` +
        `${formatNumber(variant.closedWeightedAverageEntry)}; improvement vs MACRO_ONCE ` +
        `${formatNumber(variant.closedWeightedEntryImprovementVsMacroOncePct)}%.`,
      `Best campaign: ${campaignLabel(variant.bestCampaign)}`,
      `Worst campaign: ${campaignLabel(variant.worstCampaign)}`,
      `Open campaign marked to market: ${campaignLabel(variant.openCampaign)}`,
      "",
      "### Monthly entries and realized PnL",
      "",
      "| Month | Entries | Realized PnL USDT |",
      "|---|---:|---:|",
      ...sortedKeys(variant.monthlyEntries, variant.monthlyPnl).map((month) =>
        `| ${month} | ${variant.monthlyEntries[month] ?? 0} | ${formatNumber(variant.monthlyPnl[month] ?? 0)} |`,
      ),
      "",
      "### Fixed-wallet feasibility",
      "",
      "| Wallet USDT | ROI | Liquidated | Liquidations | Minimum buffer |",
      "|---:|---:|---|---:|---:|",
      ...variant.walletScenarios.map((wallet) =>
        `| ${formatNumber(wallet.startingWallet)} | ${formatNumber(wallet.scaleTestRoiPct)}% | ` +
        `${wallet.liquidated} | ${wallet.liquidationCount} | ${formatNumber(wallet.minimumBuffer)} |`,
      ),
      "",
      "### Concentration",
      "",
      `Best one/three campaign PnL: ${formatNumber(variant.concentration.bestOnePnl)} / ` +
        `${formatNumber(variant.concentration.bestThreePnl)} USDT; shares: ` +
        `${formatNumber(variant.concentration.bestOneSharePct)}% / ` +
        `${formatNumber(variant.concentration.bestThreeSharePct)}%.`,
      `Net without best one/three: ${formatNumber(variant.concentration.netPnlWithoutBestOne)} / ` +
        `${formatNumber(variant.concentration.netPnlWithoutBestThree)} USDT.`,
      "",
      "### Pre-/post-2023 stability",
      "",
      "| Period | Campaigns | Legs | Net PnL USDT | Win rate |",
      "|---|---:|---:|---:|---:|",
      `| Before 2023 | ${variant.pre2023.campaigns} | ${variant.pre2023.legs} | ` +
        `${formatNumber(variant.pre2023.netPnl)} | ${formatNumber(variant.pre2023.winRate * 100)}% |`,
      `| 2023 onward | ${variant.post2023.campaigns} | ${variant.post2023.legs} | ` +
        `${formatNumber(variant.post2023.netPnl)} | ${formatNumber(variant.post2023.winRate * 100)}% |`,
    );
  }

  return `${lines.join("\n")}\n`;
}

export async function writeGeneratedOutputs(
  report: MacroCycleReport,
  root = process.cwd(),
): Promise<void> {
  const jsonPath = join(root, JSON_OUTPUT_PATH);
  const markdownPath = join(root, MARKDOWN_OUTPUT_PATH);
  await Promise.all([mkdir(dirname(jsonPath), { recursive: true }), mkdir(dirname(markdownPath), { recursive: true })]);
  const json = serializeReport(report);
  const markdown = renderMarkdown(report);
  await Promise.all([writeFile(jsonPath, json), writeFile(markdownPath, markdown)]);
}
