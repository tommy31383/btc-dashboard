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

export type HybridKillCheckId =
  | "ENTRY_PARITY"
  | "PEAK_QUANTITY"
  | "CLOSED_NET_PNL_POSITIVE"
  | "TOTAL_NET_PNL_POSITIVE"
  | "BEATS_MATCHED_PEAK"
  | "TACTICAL_NET_PNL_POSITIVE"
  | "FIXED_WALLETS_SURVIVE"
  | "CAMPAIGN_CONSISTENCY";

export interface HybridKillCheck {
  id: HybridKillCheckId;
  passed: boolean;
  actual: unknown;
  requirement: unknown;
}

export interface HybridMechanicalVerdict {
  verdict: "PASS" | "KILL";
  checks: HybridKillCheck[];
}

export type TacticalOnlyKillCheckId =
  | "ENTRY_PARITY"
  | "TOTAL_NET_PNL_POSITIVE"
  | "TACTICAL_NET_PNL_POSITIVE"
  | "PEAK_QUANTITY"
  | "FIXED_WALLETS_SURVIVE"
  | "BEATS_HYBRID_LITE"
  | "POSITIVE_COMPLETED_CAMPAIGNS"
  | "UNRESOLVED_LEGS_CAUSAL";

export interface TacticalOnlyKillCheck {
  id: TacticalOnlyKillCheckId;
  passed: boolean;
  actual: unknown;
  requirement: unknown;
}

export interface TacticalOnlyMechanicalVerdict {
  verdict: "PASS" | "KILL";
  researchStatus: "POST_HOC_EXPLORATORY_NOT_VALIDATION";
  checks: TacticalOnlyKillCheck[];
}

export interface MacroCycleReport {
  schemaVersion: "btc-stochrsi-macro-cycle-report/v4";
  generatedAt: string;
  verdict: "INSUFFICIENT_SAMPLE" | "EVALUATED";
  hybridVerdict: HybridMechanicalVerdict;
  tacticalOnlyVerdict: TacticalOnlyMechanicalVerdict;
  sampleLimitation: string;
  liveWalletFeasibility: {
    status: "NOT_SUPPLIED_TO_OFFLINE_EVALUATOR";
    reason: "Deterministic offline replay does not access live account state.";
  };
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
    legClosure: "FULL_LEG_ONLY";
    hybridTacticalExit: "DAILY_RECOVERY_BEFORE_MACRO_EXIT";
    tacticalOnlyExit: "ALL_LEGS_DAILY_RECOVERY_BEFORE_MACRO_EXIT";
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

function buildHybridVerdict(
  dailyEpisode: VariantRun,
  hybrid: VariantRun,
  matchedPeak: VariantRun,
  hybridSummary: VariantSummary,
  matchedPeakSummary: VariantSummary,
): HybridMechanicalVerdict {
  const dailyEpisodeEntryTimes = dailyEpisode.campaigns.flatMap((campaign) =>
    campaign.legs.map((leg) => leg.entryTime),
  );
  const hybridEntryTimes = hybrid.campaigns.flatMap((campaign) =>
    campaign.legs.map((leg) => leg.entryTime),
  );
  const orderedTimestampsEqual =
    dailyEpisodeEntryTimes.length === hybridEntryTimes.length &&
    dailyEpisodeEntryTimes.every((time, index) => time === hybridEntryTimes[index]);
  const fixedWallets = [250, 500, 1_000].map((startingWallet) => {
    const scenario = hybrid.walletScenarios.find((wallet) =>
      wallet.label === "FIXED_WALLET" && wallet.startingWallet === startingWallet
    );
    return { startingWallet, liquidated: scenario?.liquidated ?? true };
  });
  const matchedByArmTime = new Map(
    matchedPeak.campaigns.filter((campaign) => campaign.closed).map((campaign) => [campaign.armTime, campaign]),
  );
  const campaignImprovements = hybrid.campaigns
    .filter((campaign) => campaign.closed)
    .flatMap((campaign) => {
      const matched = matchedByArmTime.get(campaign.armTime);
      return matched
        ? [{ armTime: campaign.armTime, improvement: campaign.netPnl - matched.netPnl }]
        : [];
    });
  const positiveCompletedCampaigns = campaignImprovements.filter(
    ({ improvement }) => improvement > 0,
  ).length;
  const matchedPeakImprovement = hybridSummary.totalNetPnl - matchedPeakSummary.totalNetPnl;
  const tacticalNetPnl = hybridSummary.roleAttribution.TACTICAL.netPnl;
  const checks: HybridKillCheck[] = [
    {
      id: "ENTRY_PARITY",
      passed: orderedTimestampsEqual,
      actual: {
        dailyEpisodeEntryCount: dailyEpisodeEntryTimes.length,
        hybridEntryCount: hybridEntryTimes.length,
        orderedTimestampsEqual,
        dailyEpisodeEntryTimes,
        hybridEntryTimes,
      },
      requirement: { sameEntryCount: true, sameOrderedTimestamps: true },
    },
    {
      id: "PEAK_QUANTITY",
      passed: hybrid.maxQuantity <= 0.002,
      actual: { maxQuantityBtc: hybrid.maxQuantity },
      requirement: { maximumQuantityBtc: 0.002 },
    },
    {
      id: "CLOSED_NET_PNL_POSITIVE",
      passed: hybridSummary.closedNetPnl > 0,
      actual: { closedNetPnl: hybridSummary.closedNetPnl },
      requirement: { greaterThan: 0 },
    },
    {
      id: "TOTAL_NET_PNL_POSITIVE",
      passed: hybridSummary.totalNetPnl > 0,
      actual: { totalNetPnl: hybridSummary.totalNetPnl },
      requirement: { greaterThan: 0 },
    },
    {
      id: "BEATS_MATCHED_PEAK",
      passed: matchedPeakImprovement > 0,
      actual: {
        hybridTotalNetPnl: hybridSummary.totalNetPnl,
        matchedPeakTotalNetPnl: matchedPeakSummary.totalNetPnl,
        improvement: matchedPeakImprovement,
      },
      requirement: { improvementGreaterThan: 0 },
    },
    {
      id: "TACTICAL_NET_PNL_POSITIVE",
      passed: tacticalNetPnl > 0,
      actual: { tacticalNetPnl },
      requirement: { greaterThan: 0 },
    },
    {
      id: "FIXED_WALLETS_SURVIVE",
      passed: fixedWallets.every((wallet) => !wallet.liquidated),
      actual: fixedWallets,
      requirement: { wallets: [250, 500, 1_000], liquidated: false },
    },
    {
      id: "CAMPAIGN_CONSISTENCY",
      passed: positiveCompletedCampaigns >= 2,
      actual: {
        positiveCompletedCampaigns,
        completedCampaignsCompared: campaignImprovements.length,
        campaignImprovements,
      },
      requirement: { minimumPositiveCompletedCampaigns: 2 },
    },
  ];
  return {
    verdict: checks.every((check) => check.passed) ? "PASS" : "KILL",
    checks,
  };
}

function buildTacticalOnlyVerdict(
  campaigns: CampaignSignal[],
  dailyEpisode: VariantRun,
  tacticalOnly: VariantRun,
  hybridSummary: VariantSummary,
  tacticalOnlySummary: VariantSummary,
): TacticalOnlyMechanicalVerdict {
  const dailyEpisodeEntryTimes = dailyEpisode.campaigns.flatMap((campaign) =>
    campaign.legs.map((leg) => leg.entryTime),
  );
  const tacticalOnlyEntryTimes = tacticalOnly.campaigns.flatMap((campaign) =>
    campaign.legs.map((leg) => leg.entryTime),
  );
  const orderedTimestampsEqual =
    dailyEpisodeEntryTimes.length === tacticalOnlyEntryTimes.length &&
    dailyEpisodeEntryTimes.every((time, index) => time === tacticalOnlyEntryTimes[index]);
  const fixedWallets = [250, 500, 1_000].map((startingWallet) => {
    const scenario = tacticalOnly.walletScenarios.find((wallet) =>
      wallet.label === "FIXED_WALLET" && wallet.startingWallet === startingWallet
    );
    return { startingWallet, liquidated: scenario?.liquidated ?? true };
  });
  const positiveCompletedCampaigns = tacticalOnly.campaigns.filter(
    (campaign) => campaign.closed && campaign.netPnl > 0,
  ).length;
  const completedCampaigns = tacticalOnly.campaigns.filter((campaign) => campaign.closed).length;
  const expectedOpenEntryTimes = campaigns.flatMap((campaign) =>
    campaign.exitTime === undefined
      ? campaign.episodeEntries.filter(
        (_entryTime, index) => campaign.episodeRecoveryTimes[index] === null,
      )
      : []
  );
  const candidateLegs = tacticalOnly.campaigns.flatMap((campaign) => campaign.legs);
  const actualOpenEntryTimes = candidateLegs
    .filter((leg) => !leg.closed)
    .map((leg) => leg.entryTime);
  const allRolesTactical = candidateLegs.every((leg) => leg.role === "TACTICAL");
  const unresolvedLegsCausal =
    allRolesTactical &&
    expectedOpenEntryTimes.length === actualOpenEntryTimes.length &&
    expectedOpenEntryTimes.every((time, index) => time === actualOpenEntryTimes[index]);
  const tacticalNetPnl = tacticalOnlySummary.roleAttribution.TACTICAL.netPnl;
  const improvementVsHybrid = tacticalOnlySummary.totalNetPnl - hybridSummary.totalNetPnl;
  const checks: TacticalOnlyKillCheck[] = [
    {
      id: "ENTRY_PARITY",
      passed: orderedTimestampsEqual,
      actual: {
        dailyEpisodeEntryCount: dailyEpisodeEntryTimes.length,
        tacticalOnlyEntryCount: tacticalOnlyEntryTimes.length,
        orderedTimestampsEqual,
        dailyEpisodeEntryTimes,
        tacticalOnlyEntryTimes,
      },
      requirement: { sameEntryCount: true, sameOrderedTimestamps: true },
    },
    {
      id: "TOTAL_NET_PNL_POSITIVE",
      passed: tacticalOnlySummary.totalNetPnl > 0,
      actual: { totalNetPnl: tacticalOnlySummary.totalNetPnl },
      requirement: { greaterThan: 0 },
    },
    {
      id: "TACTICAL_NET_PNL_POSITIVE",
      passed: tacticalNetPnl > 0,
      actual: { tacticalNetPnl },
      requirement: { greaterThan: 0 },
    },
    {
      id: "PEAK_QUANTITY",
      passed: tacticalOnly.maxQuantity <= 0.001,
      actual: { maxQuantityBtc: tacticalOnly.maxQuantity },
      requirement: { maximumQuantityBtc: 0.001 },
    },
    {
      id: "FIXED_WALLETS_SURVIVE",
      passed: fixedWallets.every((wallet) => !wallet.liquidated),
      actual: fixedWallets,
      requirement: { wallets: [250, 500, 1_000], liquidated: false },
    },
    {
      id: "BEATS_HYBRID_LITE",
      passed: improvementVsHybrid > 0,
      actual: {
        tacticalOnlyTotalNetPnl: tacticalOnlySummary.totalNetPnl,
        hybridTotalNetPnl: hybridSummary.totalNetPnl,
        improvement: improvementVsHybrid,
      },
      requirement: { improvementGreaterThan: 0 },
    },
    {
      id: "POSITIVE_COMPLETED_CAMPAIGNS",
      passed: positiveCompletedCampaigns >= 2,
      actual: { positiveCompletedCampaigns, completedCampaigns },
      requirement: { minimumPositiveCompletedCampaigns: 2 },
    },
    {
      id: "UNRESOLVED_LEGS_CAUSAL",
      passed: unresolvedLegsCausal,
      actual: { expectedOpenEntryTimes, actualOpenEntryTimes, allRolesTactical },
      requirement: {
        openLegsEqualUnrecoveredEpisodes: true,
        allRolesTactical: true,
      },
    },
  ];
  return {
    verdict: checks.every((check) => check.passed) ? "PASS" : "KILL",
    researchStatus: "POST_HOC_EXPLORATORY_NOT_VALIDATION",
    checks,
  };
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
  const hybrid = requireVariant(orderedRuns, "HYBRID_LITE");
  const tacticalOnly = requireVariant(orderedRuns, "TACTICAL_ONLY");
  const matchedPeak = requireVariant(orderedRuns, "DAILY_EPISODE_MATCHED_PEAK");
  const variantSummaries = orderedRuns.map((run) => summarizeVariant(run, macroOnce));
  const hybridSummary = variantSummaries.find((summary) => summary.name === "HYBRID_LITE")!;
  const tacticalOnlySummary = variantSummaries.find(
    (summary) => summary.name === "TACTICAL_ONLY",
  )!;
  const matchedPeakSummary = variantSummaries.find(
    (summary) => summary.name === "DAILY_EPISODE_MATCHED_PEAK",
  )!;
  const completed = dailyEpisode.campaigns.filter((campaign) => campaign.closed).length;
  const episodeCounts = input.campaigns.map((campaign) => campaign.episodeEntries.length);
  const { refreshedAt: _refreshedAt, asOfMs: _asOfMs, ...stableProvenance } = input.provenance;
  const rawRange = input.provenance.hourly.range;
  if (rawRange.lastTime === null) throw new Error("Hourly provenance must include a last timestamp");

  return {
    schemaVersion: "btc-stochrsi-macro-cycle-report/v4",
    generatedAt,
    verdict: completed < 5 ? "INSUFFICIENT_SAMPLE" : "EVALUATED",
    hybridVerdict: buildHybridVerdict(
      dailyEpisode,
      hybrid,
      matchedPeak,
      hybridSummary,
      matchedPeakSummary,
    ),
    tacticalOnlyVerdict: buildTacticalOnlyVerdict(
      input.campaigns,
      dailyEpisode,
      tacticalOnly,
      hybridSummary,
      tacticalOnlySummary,
    ),
    sampleLimitation:
      `${completed} completed DAILY_EPISODE campaigns; fewer than 5 completed DAILY_EPISODE campaigns ` +
      "forces INSUFFICIENT_SAMPLE. " +
      "Historical results are evidence for this frozen hypothesis only and do not authorize live trading.",
    liveWalletFeasibility: {
      status: "NOT_SUPPLIED_TO_OFFLINE_EVALUATOR",
      reason: "Deterministic offline replay does not access live account state.",
    },
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
      legClosure: "FULL_LEG_ONLY",
      hybridTacticalExit: "DAILY_RECOVERY_BEFORE_MACRO_EXIT",
      tacticalOnlyExit: "ALL_LEGS_DAILY_RECOVERY_BEFORE_MACRO_EXIT",
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
    variants: orderedRuns.map((run, index) => ({
      ...variantSummaries[index],
      warning: run.simulatedNotTradable ? "SIMULATED_NOT_TRADABLE" : null,
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

function formatPercent(value: number | null, digits = 4): string {
  return value === null ? "null" : `${formatNumber(value, digits)}%`;
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

function openMacroCampaignLabel(campaign: CampaignReplay | null | undefined): string {
  if (!campaign) return "Open macro campaign: null";
  if (campaign.legs.length === 0) {
    return `Open macro campaign (no legs executed): ${campaignLabel(campaign)}`;
  }
  const openLegs = campaign.legs.filter((leg) => !leg.closed).length;
  if (openLegs === 0) {
    return `Open macro campaign (all legs realized): ${campaignLabel(campaign)}`;
  }
  return `Open macro campaign (${openLegs} open ${openLegs === 1 ? "leg" : "legs"} marked at cutoff): ` +
    campaignLabel(campaign);
}

function realizedLegHoldSummary(variant: ReportVariant): {
  average: number;
  median: number;
  maximum: number;
} {
  const holds = variant.campaigns
    .flatMap((campaign) => campaign.legs)
    .filter((leg) => leg.closed)
    .map((leg) => (leg.exitTime! - leg.entryTime) / HOUR_MS)
    .sort((left, right) => left - right);
  if (holds.length === 0) return { average: 0, median: 0, maximum: 0 };
  const midpoint = Math.floor(holds.length / 2);
  return {
    average: holds.reduce((total, hold) => total + hold, 0) / holds.length,
    median: holds.length % 2 === 1
      ? holds[midpoint]
      : (holds[midpoint - 1] + holds[midpoint]) / 2,
    maximum: holds.at(-1)!,
  };
}

export function renderMarkdown(report: MacroCycleReport): string {
  assertFiniteReportValue(report, "$report");
  const hybridSummary = report.variants.find((variant) => variant.name === "HYBRID_LITE");
  if (!hybridSummary) throw new Error("HYBRID_LITE report variant is required");
  const tacticalOnlySummary = report.variants.find((variant) => variant.name === "TACTICAL_ONLY");
  if (!tacticalOnlySummary) throw new Error("TACTICAL_ONLY report variant is required");
  const lines: string[] = [
    "# BTC-only StochRSI Macro-cycle Backtest",
    "",
    `**Verdict: ${report.verdict}**`,
    "",
    `Sample limitation: ${report.sampleLimitation}`,
    "",
    `**Hybrid mechanical verdict: ${report.hybridVerdict.verdict}**`,
    "",
    "| Kill check | Result | Actual | Requirement |",
    "|---|---|---|---|",
    ...report.hybridVerdict.checks.map((check) =>
      `| ${check.id} | ${check.passed ? "PASS" : "KILL"} | ${JSON.stringify(check.actual)} | ` +
      `${JSON.stringify(check.requirement)} |`,
    ),
    "",
    `**Tactical-only exploratory verdict: ${report.tacticalOnlyVerdict.verdict}**`,
    "",
    `**Research status: ${report.tacticalOnlyVerdict.researchStatus}.** This follow-up was selected after ` +
      "the full sample was observed; a mechanical PASS does not authorize live trading.",
    "",
    "| Exploratory check | Result | Actual | Requirement |",
    "|---|---|---|---|",
    ...report.tacticalOnlyVerdict.checks.map((check) =>
      `| ${check.id} | ${check.passed ? "PASS" : "KILL"} | ${JSON.stringify(check.actual)} | ` +
      `${JSON.stringify(check.requirement)} |`,
    ),
    "",
    "## Frozen strategy",
    "",
    "BTCUSDT only. RSI 14, StochRSI 14, %K SMA 3, %D SMA 3, close source, 0..100 scale.",
    "1W and 2W each must first move below 20 in %K or %D and later produce a bullish cross. " +
      "The macro cycle arms only after both rebounds confirm while both %K values remain below 80.",
    "During the armed cycle, DAILY_EPISODE buys 0.001 BTC once per distinct closed-1D %K < 10 episode " +
      "at the next available daily open. It rearms after closed-1D %K >= 10.",
    "The whole campaign exits at the next available daily open after completed 1W and 2W %K are both >= 80.",
    "No stop loss and no maximum-hold exit. Each leg is fully closed; Hybrid tactical legs may exit before the macro campaign. " +
      "Historical funding applies to every open leg.",
    "TACTICAL_ONLY preserves every DAILY_EPISODE entry but makes every leg tactical: first causal closed-1D " +
      "%K >= 10 exits at the next daily open, while an earlier or same-time macro exit has priority.",
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
    `- Live-wallet snapshot: ${report.liveWalletFeasibility.status} (${report.liveWalletFeasibility.reason})`,
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
    "**DAILY_EPISODE_MATCHED_PEAK: SIMULATED_NOT_TRADABLE. Its full-history multiplier is an exposure control, not an executable strategy.**",
    "",
    "**WINDOW_FULL_AT_ARM: SIMULATED_NOT_TRADABLE. It uses the future DAILY_EPISODE leg count and is only an exposure-normalized timing counterfactual.**",
    "",
    "| Variant | Warning | Closed/open/zero | Realized legs / all legs | Closed campaign WR | Realized leg WR | Total gross | Total fees | Total slippage | Total funding | Closed net | Total net | Max DD | Worst unrealized | Min wallet | Max qty | Max notional |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...report.variants.map((variant) =>
      `| ${variant.name} | ${variant.warning ?? "TRADABLE_REPLAY"} | ` +
      `${variant.closedCampaigns}/${variant.openCampaigns}/${variant.zeroEntryCampaigns} | ` +
      `${variant.realizedLegs}/${variant.totalLegs} | ` +
      `${formatNumber(variant.closedCampaignWinRate * 100)}% | ` +
      `${formatNumber(variant.realizedLegWinRate * 100)}% | ` +
      `${formatNumber(variant.grossPnl)} | ${formatNumber(variant.fees)} | ${formatNumber(variant.slippageCost)} | ` +
      `${formatNumber(variant.fundingPnl)} | ${formatNumber(variant.closedNetPnl)} | ` +
      `${formatNumber(variant.totalNetPnl)} | ${formatNumber(variant.maxDrawdown)} | ` +
      `${formatNumber(variant.worstUnrealizedPnl)} | ${formatNumber(variant.minimumWallet)} | ` +
      `${formatNumber(variant.maxQuantity, 6)} | ${formatNumber(variant.maxNotional)} |`,
    ),
    "",
    "## Hybrid role attribution",
    "",
    "| Role | Entries | Realized | Open | Gross | Fees | Slippage | Funding | Net | Daily recovery | Macro overbought | Open mark |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...(["BASE", "CORE", "TACTICAL", "SIMULATED"] as const).map((role) => {
      const attribution = hybridSummary.roleAttribution[role];
      return `| ${role} | ${attribution.entries} | ${attribution.realized} | ${attribution.open} | ` +
        `${formatNumber(attribution.grossPnl)} | ${formatNumber(attribution.fees)} | ` +
        `${formatNumber(attribution.slippageCost)} | ${formatNumber(attribution.fundingPnl)} | ` +
        `${formatNumber(attribution.netPnl)} | ${attribution.exitReasons.DAILY_RECOVERY} | ` +
        `${attribution.exitReasons.MACRO_OVERBOUGHT} | ${attribution.exitReasons.OPEN_MARK} |`;
    }),
    "",
    "## Tactical-only role attribution",
    "",
    "| Role | Entries | Realized | Open | Gross | Fees | Slippage | Funding | Net | Daily recovery | Macro overbought | Open mark |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...(["BASE", "CORE", "TACTICAL", "SIMULATED"] as const).map((role) => {
      const attribution = tacticalOnlySummary.roleAttribution[role];
      return `| ${role} | ${attribution.entries} | ${attribution.realized} | ${attribution.open} | ` +
        `${formatNumber(attribution.grossPnl)} | ${formatNumber(attribution.fees)} | ` +
        `${formatNumber(attribution.slippageCost)} | ${formatNumber(attribution.fundingPnl)} | ` +
        `${formatNumber(attribution.netPnl)} | ${attribution.exitReasons.DAILY_RECOVERY} | ` +
        `${attribution.exitReasons.MACRO_OVERBOUGHT} | ${attribution.exitReasons.OPEN_MARK} |`;
    }),
  ];

  for (const variant of report.variants) {
    const realizedHold = realizedLegHoldSummary(variant);
    lines.push(
      "",
      `## ${variant.name}${variant.warning ? ` - ${variant.warning}` : ""}`,
      "",
      `Returns (closed campaigns only): expectancy ${formatNumber(variant.netExpectancy)} USDT; ` +
        `average ${formatNumber(variant.averageReturnPct)}%; ` +
        `median ${formatNumber(variant.medianReturnPct)}%.`,
      `Leg counts (all campaigns): average/median per campaign ` +
        `${formatNumber(variant.averageLegsPerCampaign)}/${formatNumber(variant.medianLegsPerCampaign)}.`,
      `Macro campaign timing: average span ${formatNumber(variant.averageHoldHours)}h; average underwater ` +
        `${formatNumber(variant.averageUnderwaterHours)}h; suppressed duplicate daily entries ` +
        `${variant.suppressedDuplicateDailyEntries}.`,
      `Realized leg hold: average/median/maximum ${formatNumber(realizedHold.average)}/` +
        `${formatNumber(realizedHold.median)}/${formatNumber(realizedHold.maximum)}h.`,
      `Entry (all campaigns, exposure-matched): weighted average ${formatNumber(variant.weightedAverageEntry)}; ` +
        `improvement vs MACRO_ONCE ${formatPercent(variant.weightedEntryImprovementVsMacroOncePct)}.`,
      `Entry (closed campaigns only, exposure-matched): weighted average ` +
        `${formatNumber(variant.closedWeightedAverageEntry)}; improvement vs MACRO_ONCE ` +
        `${formatPercent(variant.closedWeightedEntryImprovementVsMacroOncePct)}.`,
      `Best campaign: ${campaignLabel(variant.bestCampaign)}`,
      `Worst campaign: ${campaignLabel(variant.worstCampaign)}`,
      openMacroCampaignLabel(variant.openCampaign),
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
      "| Scenario | Basis | Snapshot | Wallet USDT | ROI | Outcome | Liquidated | Liquidations | Minimum buffer |",
      "|---|---|---|---:|---:|---|---|---:|---:|",
      ...variant.walletScenarios.map((wallet) =>
        `| ${wallet.label} | ${wallet.basis} | ${formatTime(wallet.snapshotTime)} | ` +
        `${formatNumber(wallet.startingWallet)} | ${formatPercent(wallet.scaleTestRoiPct)} | ` +
        `${wallet.outcome} | ${wallet.liquidated} | ${wallet.liquidationCount} | ` +
        `${formatNumber(wallet.minimumBuffer)} |`,
      ),
      "",
      "### Concentration",
      "",
      `Best one/three campaign PnL: ${formatNumber(variant.concentration.bestOnePnl)} / ` +
        `${formatNumber(variant.concentration.bestThreePnl)} USDT; shares: ` +
        `${formatPercent(variant.concentration.bestOneSharePct)} / ` +
        `${formatPercent(variant.concentration.bestThreeSharePct)}.`,
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
