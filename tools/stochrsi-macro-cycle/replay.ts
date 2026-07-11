import { HOUR_MS, type CampaignSignal, type Candle } from "./core";

export const QTY_PER_LEG = 0.001;
export const FEE_RATE = 0.0004;
export const SLIPPAGE_RATE = 0.0002;
export const MAINTENANCE_RATE = 0.004;
export const PRE_POST_SPLIT_MS = Date.UTC(2023, 0, 1);
export const FIXED_WALLET_SIZES = [100, 250, 500, 1_000] as const;

export type VariantName =
  | "MACRO_ONCE"
  | "DAILY_EPISODE"
  | "DAILY_EVERY_BAR"
  | "WINDOW_FULL_AT_ARM"
  | "HYBRID_LITE";

export const VARIANT_NAMES: VariantName[] = [
  "MACRO_ONCE",
  "DAILY_EPISODE",
  "DAILY_EVERY_BAR",
  "WINDOW_FULL_AT_ARM",
  "HYBRID_LITE",
];

export interface FundingPayment {
  time: number;
  rate: number;
  mark?: number;
}

interface ResolvedFundingPayment {
  time: number;
  cumulativePnlPerBtc: number;
}

export type LegRole = "BASE" | "CORE" | "TACTICAL" | "SIMULATED";
export type LegExitReason = "MACRO_OVERBOUGHT" | "DAILY_RECOVERY";

export interface LegIntent {
  entryTime: number;
  qty: number;
  exitTime?: number;
  role: LegRole;
  exitReason?: LegExitReason;
}

export interface VariantLegs {
  legs: LegIntent[];
  simulatedNotTradable: boolean;
}

export interface SettleLegInput {
  qty: number;
  entryOpen: number;
  exitOpen: number;
  funding: FundingPayment[];
  entryTime?: number;
  exitTime?: number;
  hourly?: Candle[];
}

export interface SettledLeg {
  qty: number;
  entryPrice: number;
  exitPrice: number;
  grossPnl: number;
  fees: number;
  slippageCost: number;
  fundingPnl: number;
  netPnl: number;
}

export interface ReplayLeg extends Omit<SettledLeg, "exitPrice"> {
  entryTime: number;
  exitTime?: number;
  role: LegRole;
  exitReason?: LegExitReason;
  exitPrice?: number;
  entryFee: number;
  exitFee: number;
  closed: boolean;
}

export interface CampaignReplay {
  armTime: number;
  exitTime?: number;
  markTime: number;
  markPrice: number;
  closed: boolean;
  legs: ReplayLeg[];
  grossPnl: number;
  fees: number;
  slippageCost: number;
  fundingPnl: number;
  netPnl: number;
  returnPct: number;
  weightedAverageEntry: number | null;
  holdHours: number;
  underwaterHours: number;
  maxDrawdown: number;
  worstUnrealizedPnl: number;
  suppressedDuplicateDailyEntries: number;
}

export interface AccountPathPoint {
  time: number;
  close: number;
  riskPrice: number;
  realizedPnl: number;
  unrealizedPnl: number;
  fundingPnl: number;
  feesPaid: number;
  pnlBeforeWallet: number;
  equity: number;
  maintenance: number;
  quantity: number;
  notional: number;
  drawdown: number;
}

export interface WalletScenario {
  label: "FIXED_WALLET" | "LIVE_WALLET_SCALE_FEASIBILITY";
  basis: "FULL_HISTORY_SCALE_TEST";
  startingWallet: number;
  snapshotTime?: number;
  scaleTestRoiPct: number | null;
  outcome: "SURVIVED" | "LIQUIDATED_PATH_INVALID";
  liquidated: boolean;
  liquidationCount: number;
  minimumBuffer: number;
}

export interface LiveWalletSnapshot {
  amount: number;
  timestamp: number;
}

export interface RunVariantOptions {
  walletSizes?: number[];
  liveWallet?: LiveWalletSnapshot;
}

export interface VariantRun {
  name: VariantName;
  simulatedNotTradable: boolean;
  campaigns: CampaignReplay[];
  accountPath: AccountPathPoint[];
  openCampaign?: CampaignReplay;
  walletScenarios: WalletScenario[];
  netPnl: number;
  maxDrawdown: number;
  worstUnrealizedPnl: number;
  maxQuantity: number;
  maxNotional: number;
  minimumWallet: number;
}

export interface StabilitySummary {
  campaigns: number;
  legs: number;
  netPnl: number;
  winRate: number;
}

export interface VariantSummary {
  name: VariantName;
  simulatedNotTradable: boolean;
  totalCampaigns: number;
  closedCampaigns: number;
  openCampaigns: number;
  zeroEntryCampaigns: number;
  oneEntryCampaigns: number;
  multipleEntryCampaigns: number;
  suppressedDuplicateDailyEntries: number;
  closedLegs: number;
  totalLegs: number;
  campaignWinRate: number;
  legWinRate: number;
  netExpectancy: number;
  averageReturnPct: number;
  medianReturnPct: number;
  grossPnl: number;
  fees: number;
  slippageCost: number;
  fundingPnl: number;
  closedNetPnl: number;
  totalNetPnl: number;
  averageLegsPerCampaign: number;
  medianLegsPerCampaign: number;
  averageHoldHours: number;
  averageUnderwaterHours: number;
  weightedAverageEntry: number | null;
  weightedEntryImprovementVsMacroOncePct: number | null;
  closedWeightedAverageEntry: number | null;
  closedWeightedEntryImprovementVsMacroOncePct: number | null;
  monthlyEntries: Record<string, number>;
  monthlyPnl: Record<string, number>;
  yearlyEntries: Record<string, number>;
  yearlyPnl: Record<string, number>;
  bestCampaign: CampaignReplay | null;
  worstCampaign: CampaignReplay | null;
  concentration: {
    bestOnePnl: number;
    bestThreePnl: number;
    bestOneSharePct: number | null;
    bestThreeSharePct: number | null;
    netPnlWithoutBestOne: number;
    netPnlWithoutBestThree: number;
  };
  pre2023: StabilitySummary;
  post2023: StabilitySummary;
  openCampaign?: CampaignReplay;
  maxDrawdown: number;
  worstUnrealizedPnl: number;
  maxQuantity: number;
  maxNotional: number;
  minimumWallet: number;
  walletScenarios: WalletScenario[];
}

function stableNumber(value: number): number {
  return Number(value.toPrecision(15));
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

function monthKey(time: number): string {
  return new Date(time).toISOString().slice(0, 7);
}

function yearKey(time: number): string {
  return new Date(time).toISOString().slice(0, 4);
}

function addMetric(target: Record<string, number>, key: string, value: number): void {
  target[key] = (target[key] ?? 0) + value;
}

function resolveFunding(
  fundingInput: FundingPayment[],
  hourlyInput: Candle[],
): ResolvedFundingPayment[] {
  const funding = [...fundingInput].sort((left, right) => left.time - right.time);
  const hourly = [...hourlyInput].sort((left, right) => left.time - right.time);
  let candleIndex = -1;
  let cumulativePnlPerBtc = 0;
  return funding.map((payment) => {
    assertFinite(payment.rate, "Funding rate");
    if (payment.mark !== undefined) {
      assertFinite(payment.mark, "Funding mark");
      if (payment.mark < 0) throw new Error("Funding mark must not be negative");
    }
    while (
      candleIndex + 1 < hourly.length &&
      hourly[candleIndex + 1].time + HOUR_MS <= payment.time
    ) {
      candleIndex += 1;
    }
    const mark = payment.mark !== undefined && payment.mark > 0
      ? payment.mark
      : hourly[candleIndex]?.close;
    if (mark === undefined) throw new Error(`Funding mark fallback unavailable at ${payment.time}`);
    assertFinite(mark, "Funding mark");
    cumulativePnlPerBtc += -mark * payment.rate;
    return { time: payment.time, cumulativePnlPerBtc };
  });
}

function firstFundingIndex(
  funding: ResolvedFundingPayment[],
  time: number,
  includeEqual: boolean,
): number {
  let low = 0;
  let high = funding.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const belongsLeft = includeEqual
      ? funding[middle].time >= time
      : funding[middle].time > time;
    if (belongsLeft) high = middle;
    else low = middle + 1;
  }
  return low;
}

function fundingPnlFromResolved(
  qty: number,
  funding: ResolvedFundingPayment[],
  entryTime?: number,
  exitTime?: number,
  throughTime = Number.POSITIVE_INFINITY,
): number {
  if (funding.length === 0) return 0;
  const first = entryTime === undefined ? 0 : firstFundingIndex(funding, entryTime, false);
  const throughEnd = firstFundingIndex(funding, throughTime, false);
  const exitEnd = exitTime === undefined
    ? funding.length
    : firstFundingIndex(funding, exitTime, true);
  const end = Math.min(throughEnd, exitEnd);
  if (end <= first) return 0;
  const cumulativeBefore = first === 0 ? 0 : funding[first - 1].cumulativePnlPerBtc;
  return qty * (funding[end - 1].cumulativePnlPerBtc - cumulativeBefore);
}

function fundingPnlFor(
  qty: number,
  funding: FundingPayment[],
  hourly: Candle[],
  entryTime?: number,
  exitTime?: number,
): number {
  return fundingPnlFromResolved(qty, resolveFunding(funding, hourly), entryTime, exitTime);
}

export function buildVariantLegs(
  campaign: CampaignSignal,
  variant: VariantName,
): VariantLegs {
  const campaignExit = {
    ...(campaign.exitTime === undefined ? {} : { exitTime: campaign.exitTime }),
    ...(campaign.exitReason === undefined ? {} : { exitReason: campaign.exitReason }),
  };
  switch (variant) {
    case "MACRO_ONCE":
      return {
        legs: [{
          entryTime: campaign.armTime,
          qty: QTY_PER_LEG,
          role: "BASE",
          ...campaignExit,
        }],
        simulatedNotTradable: false,
      };
    case "DAILY_EPISODE":
      return {
        legs: campaign.episodeEntries.map((entryTime) => ({
          entryTime,
          qty: QTY_PER_LEG,
          role: "BASE",
          ...campaignExit,
        })),
        simulatedNotTradable: false,
      };
    case "DAILY_EVERY_BAR":
      return {
        legs: campaign.dailyOversoldEntries.map((entryTime) => ({
          entryTime,
          qty: QTY_PER_LEG,
          role: "BASE",
          ...campaignExit,
        })),
        simulatedNotTradable: false,
      };
    case "WINDOW_FULL_AT_ARM":
      return {
        legs:
          campaign.exitTime === undefined || campaign.episodeEntries.length === 0
            ? []
            : [{
              entryTime: campaign.armTime,
              qty: campaign.episodeEntries.length * QTY_PER_LEG,
              role: "SIMULATED",
              ...campaignExit,
            }],
        simulatedNotTradable: true,
      };
    case "HYBRID_LITE":
      return {
        legs: campaign.episodeEntries.map((entryTime, index) => {
          if (index === 0) {
            return {
              entryTime,
              qty: QTY_PER_LEG,
              role: "CORE" as const,
              ...campaignExit,
            };
          }
          const recoveryTime = campaign.episodeRecoveryTimes[index] ?? null;
          const macroWins =
            campaign.exitTime !== undefined &&
            (recoveryTime === null || campaign.exitTime <= recoveryTime);
          const exitTime = macroWins ? campaign.exitTime : recoveryTime ?? undefined;
          const exitReason = exitTime === undefined
            ? undefined
            : macroWins
              ? "MACRO_OVERBOUGHT" as const
              : "DAILY_RECOVERY" as const;
          return {
            entryTime,
            qty: QTY_PER_LEG,
            exitTime,
            role: "TACTICAL" as const,
            exitReason,
          };
        }),
        simulatedNotTradable: false,
      };
  }
}

export function settleLeg(input: SettleLegInput): SettledLeg {
  assertFinite(input.qty, "Quantity");
  assertFinite(input.entryOpen, "Entry open");
  assertFinite(input.exitOpen, "Exit open");
  if (input.qty <= 0) throw new Error("Quantity must be positive");

  const entryPrice = stableNumber(input.entryOpen * (1 + SLIPPAGE_RATE));
  const exitPrice = stableNumber(input.exitOpen * (1 - SLIPPAGE_RATE));
  const grossPnl = (input.exitOpen - input.entryOpen) * input.qty;
  const fees = (entryPrice + exitPrice) * input.qty * FEE_RATE;
  const slippageCost =
    (entryPrice - input.entryOpen + input.exitOpen - exitPrice) * input.qty;
  const fundingPnl = fundingPnlFor(
    input.qty,
    input.funding,
    input.hourly ?? [],
    input.entryTime,
    input.exitTime,
  );
  return {
    qty: input.qty,
    entryPrice,
    exitPrice,
    grossPnl,
    fees,
    slippageCost,
    fundingPnl,
    netPnl: grossPnl - fees - slippageCost + fundingPnl,
  };
}

export function minimumWalletToSurvive(
  path: Array<{ pnlBeforeWallet: number; maintenance: number }>,
): number {
  const boundary = path.reduce(
    (minimum, point) => Math.max(minimum, point.maintenance - point.pnlBeforeWallet),
    0,
  );
  return stableNumber(boundary + 0.01);
}

function hourlyOpenAt(hourlyByTime: Map<number, Candle>, time: number): number {
  const candle = hourlyByTime.get(time);
  if (!candle) throw new Error(`Next-open fill unavailable at ${time}`);
  return candle.open;
}

function replayLeg(
  intent: LegIntent,
  markPrice: number,
  hourly: Candle[],
  hourlyByTime: Map<number, Candle>,
  funding: ResolvedFundingPayment[],
): ReplayLeg {
  const { exitTime } = intent;
  const entryOpen = hourlyOpenAt(hourlyByTime, intent.entryTime);
  const entryPrice = stableNumber(entryOpen * (1 + SLIPPAGE_RATE));
  const entryFee = entryPrice * intent.qty * FEE_RATE;

  if (exitTime !== undefined) {
    const settled = settleLeg({
      qty: intent.qty,
      entryOpen,
      exitOpen: hourlyOpenAt(hourlyByTime, exitTime),
      funding: [],
      entryTime: intent.entryTime,
      exitTime,
      hourly,
    });
    settled.fundingPnl = fundingPnlFromResolved(
      intent.qty,
      funding,
      intent.entryTime,
      exitTime,
    );
    settled.netPnl =
      settled.grossPnl - settled.fees - settled.slippageCost + settled.fundingPnl;
    const exitFee = settled.exitPrice * intent.qty * FEE_RATE;
    return {
      ...settled,
      entryTime: intent.entryTime,
      exitTime,
      role: intent.role,
      exitReason: intent.exitReason,
      entryFee,
      exitFee,
      closed: true,
    };
  }

  const fundingPnl = fundingPnlFromResolved(
    intent.qty,
    funding,
    intent.entryTime,
    undefined,
    hourly[hourly.length - 1].time + HOUR_MS,
  );
  const grossPnl = (markPrice - entryOpen) * intent.qty;
  const slippageCost = (entryPrice - entryOpen) * intent.qty;
  return {
    qty: intent.qty,
    entryTime: intent.entryTime,
    role: intent.role,
    exitReason: intent.exitReason,
    entryPrice,
    entryFee,
    exitFee: 0,
    closed: false,
    grossPnl,
    fees: entryFee,
    slippageCost,
    fundingPnl,
    netPnl: grossPnl - slippageCost - entryFee + fundingPnl,
  };
}

function campaignRisk(
  legs: ReplayLeg[],
  hourly: Candle[],
  endTime: number,
  finalMarkPrice: number,
  finalNetPnl: number,
  funding: ResolvedFundingPayment[],
): { underwaterHours: number; maxDrawdown: number; worstUnrealizedPnl: number } {
  let underwater = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let worstUnrealizedPnl = 0;
  for (const candle of hourly) {
    if (candle.time >= endTime) break;
    const closed = legs.filter(
      (leg) => leg.exitTime !== undefined && leg.exitTime <= candle.time,
    );
    const active = legs.filter(
      (leg) =>
        leg.entryTime <= candle.time &&
        (leg.exitTime === undefined || leg.exitTime > candle.time),
    );
    if (active.length === 0 && closed.length === 0) continue;
    const realizedPnl = sum(closed.map((leg) => leg.netPnl));
    const fundingPnl = active.map((leg) =>
      fundingPnlFromResolved(
        leg.qty,
        funding,
        leg.entryTime,
        leg.exitTime,
        candle.time,
      ),
    );
    const pnlAt = (price: number): number =>
      realizedPnl + sum(
        active.map((leg, index) =>
          (price - leg.entryPrice) * leg.qty - leg.entryFee + fundingPnl[index]),
      );
    const unrealizedPnl = sum(
      active.map((leg) => (candle.low - leg.entryPrice) * leg.qty),
    );
    const openPnl = pnlAt(candle.open);
    const pnl = pnlAt(candle.low);
    const highPnl = pnlAt(candle.high);
    if (pnl < 0) underwater += 1;
    peak = Math.max(peak, openPnl);
    maxDrawdown = Math.max(maxDrawdown, peak - pnl);
    worstUnrealizedPnl = Math.min(worstUnrealizedPnl, unrealizedPnl);
    peak = Math.max(peak, highPnl);
  }
  const finalUnrealizedPnl = sum(
    legs
      .filter((leg) => leg.exitTime === undefined || leg.exitTime >= endTime)
      .map((leg) => (finalMarkPrice - leg.entryPrice) * leg.qty),
  );
  peak = Math.max(peak, finalNetPnl);
  maxDrawdown = Math.max(maxDrawdown, peak - finalNetPnl);
  worstUnrealizedPnl = Math.min(worstUnrealizedPnl, finalUnrealizedPnl);
  return { underwaterHours: underwater, maxDrawdown, worstUnrealizedPnl };
}

function replayCampaign(
  campaign: CampaignSignal,
  variant: VariantName,
  hourly: Candle[],
  hourlyByTime: Map<number, Candle>,
  funding: ResolvedFundingPayment[],
): CampaignReplay {
  const lastHourly = hourly[hourly.length - 1];
  const markTime = campaign.exitTime ?? lastHourly.time + HOUR_MS;
  const markPrice = campaign.exitTime
    ? hourlyOpenAt(hourlyByTime, campaign.exitTime)
    : lastHourly.close;
  const legs = buildVariantLegs(campaign, variant).legs.map((intent) =>
    replayLeg(intent, markPrice, hourly, hourlyByTime, funding),
  );
  const totalQty = sum(legs.map((leg) => leg.qty));
  const entryNotional = sum(legs.map((leg) => leg.entryPrice * leg.qty));
  const firstEntryTime =
    legs.length === 0 ? campaign.armTime : Math.min(...legs.map((leg) => leg.entryTime));
  const netPnl = sum(legs.map((leg) => leg.netPnl));
  const risk = campaignRisk(legs, hourly, markTime, markPrice, netPnl, funding);
  return {
    armTime: campaign.armTime,
    exitTime: campaign.exitTime,
    markTime,
    markPrice,
    closed: campaign.exitTime !== undefined,
    legs,
    grossPnl: sum(legs.map((leg) => leg.grossPnl)),
    fees: sum(legs.map((leg) => leg.fees)),
    slippageCost: sum(legs.map((leg) => leg.slippageCost)),
    fundingPnl: sum(legs.map((leg) => leg.fundingPnl)),
    netPnl,
    returnPct: entryNotional === 0 ? 0 : (netPnl / entryNotional) * 100,
    weightedAverageEntry: totalQty === 0 ? null : entryNotional / totalQty,
    holdHours: legs.length === 0 ? 0 : (markTime - firstEntryTime) / HOUR_MS,
    underwaterHours: risk.underwaterHours,
    maxDrawdown: risk.maxDrawdown,
    worstUnrealizedPnl: risk.worstUnrealizedPnl,
    suppressedDuplicateDailyEntries: Math.max(
      0,
      campaign.dailyOversoldEntries.length - campaign.episodeEntries.length,
    ),
  };
}

function buildAccountPath(
  legs: ReplayLeg[],
  hourly: Candle[],
  funding: ResolvedFundingPayment[],
): AccountPathPoint[] {
  const path: AccountPathPoint[] = [];
  let peak = 0;
  for (const candle of hourly) {
    const closedLegs = legs.filter(
      (leg) => leg.exitTime !== undefined && leg.exitTime <= candle.time,
    );
    const activeLegs = legs.filter(
      (leg) => leg.entryTime <= candle.time && (leg.exitTime === undefined || leg.exitTime > candle.time),
    );
    const realizedPnl = sum(closedLegs.map((leg) => leg.netPnl));
    const unrealizedPnl = sum(
      activeLegs.map((leg) => (candle.low - leg.entryPrice) * leg.qty),
    );
    const activeFundingPnl = sum(
      activeLegs.map((leg) =>
        fundingPnlFromResolved(
          leg.qty,
          funding,
          leg.entryTime,
          leg.exitTime,
          candle.time,
        ),
      ),
    );
    const feesPaid = sum(activeLegs.map((leg) => leg.entryFee));
    const pnlAt = (price: number): number =>
      realizedPnl +
      sum(activeLegs.map((leg) => (price - leg.entryPrice) * leg.qty)) +
      activeFundingPnl -
      feesPaid;
    const openPnl = pnlAt(candle.open);
    const pnlBeforeWallet = pnlAt(candle.low);
    const quantity = sum(activeLegs.map((leg) => leg.qty));
    const notional = quantity * candle.close;
    const maintenance = quantity * candle.low * MAINTENANCE_RATE;
    peak = Math.max(peak, openPnl);
    const drawdown = peak - pnlBeforeWallet;
    peak = Math.max(peak, pnlAt(candle.high));
    path.push({
      time: candle.time,
      close: candle.close,
      riskPrice: candle.low,
      realizedPnl,
      unrealizedPnl,
      fundingPnl: activeFundingPnl,
      feesPaid,
      pnlBeforeWallet,
      equity: pnlBeforeWallet,
      maintenance,
      quantity,
      notional,
      drawdown,
    });
  }
  return path;
}

function walletScenario(
  path: AccountPathPoint[],
  netPnl: number,
  startingWallet: number,
  liveWallet?: LiveWalletSnapshot,
): WalletScenario {
  assertFinite(startingWallet, "Starting wallet");
  if (startingWallet <= 0) throw new Error("Starting wallet must be positive");
  let liquidated = false;
  let liquidationCount = 0;
  let minimumBuffer = Number.POSITIVE_INFINITY;
  for (const point of path) {
    const buffer = startingWallet + point.pnlBeforeWallet - point.maintenance;
    minimumBuffer = Math.min(minimumBuffer, buffer);
    if (buffer <= 0 && !liquidated) {
      liquidated = true;
      liquidationCount = 1;
    }
  }
  return {
    label: liveWallet ? "LIVE_WALLET_SCALE_FEASIBILITY" : "FIXED_WALLET",
    basis: "FULL_HISTORY_SCALE_TEST",
    startingWallet,
    snapshotTime: liveWallet?.timestamp,
    scaleTestRoiPct: liquidated ? null : (netPnl / startingWallet) * 100,
    outcome: liquidated ? "LIQUIDATED_PATH_INVALID" : "SURVIVED",
    liquidated,
    liquidationCount,
    minimumBuffer: minimumBuffer === Number.POSITIVE_INFINITY ? startingWallet : minimumBuffer,
  };
}

export function runVariant(
  name: VariantName,
  campaigns: CampaignSignal[],
  hourlyInput: Candle[],
  fundingInput: FundingPayment[],
  options: RunVariantOptions = {},
): VariantRun {
  if (hourlyInput.length === 0) throw new Error("Hourly candles are required for replay");
  const hourly = [...hourlyInput].sort((left, right) => left.time - right.time);
  const funding = resolveFunding(fundingInput, hourly);
  const hourlyByTime = new Map(hourly.map((candle) => [candle.time, candle]));
  const replays = campaigns.map((campaign) =>
    replayCampaign(campaign, name, hourly, hourlyByTime, funding),
  );
  const allLegs = replays.flatMap((campaign) => campaign.legs);
  const accountPath = buildAccountPath(allLegs, hourly, funding);
  const netPnl = sum(replays.map((campaign) => campaign.netPnl));
  const walletSizes = [...new Set([
    ...FIXED_WALLET_SIZES,
    ...(options.walletSizes ?? []),
  ])];
  const walletScenarios = walletSizes.map((wallet) =>
    walletScenario(accountPath, netPnl, wallet),
  );
  if (options.liveWallet) {
    walletScenarios.push(
      walletScenario(accountPath, netPnl, options.liveWallet.amount, options.liveWallet),
    );
  }
  return {
    name,
    simulatedNotTradable: name === "WINDOW_FULL_AT_ARM",
    campaigns: replays,
    accountPath,
    openCampaign: replays.find((campaign) => !campaign.closed),
    walletScenarios,
    netPnl,
    maxDrawdown: Math.max(0, ...accountPath.map((point) => point.drawdown)),
    worstUnrealizedPnl: Math.min(0, ...accountPath.map((point) => point.unrealizedPnl)),
    maxQuantity: Math.max(0, ...accountPath.map((point) => point.quantity)),
    maxNotional: Math.max(0, ...accountPath.map((point) => point.notional)),
    minimumWallet: minimumWalletToSurvive(accountPath),
  };
}

function stabilitySummary(campaigns: CampaignReplay[]): StabilitySummary {
  return {
    campaigns: campaigns.length,
    legs: sum(campaigns.map((campaign) => campaign.legs.length)),
    netPnl: sum(campaigns.map((campaign) => campaign.netPnl)),
    winRate:
      campaigns.length === 0
        ? 0
        : campaigns.filter((campaign) => campaign.netPnl > 0).length / campaigns.length,
  };
}

function weightedEntryComparison(
  campaigns: CampaignReplay[],
  macroOnce?: VariantRun,
): {
  weightedAverageEntry: number | null;
  improvementVsMacroOncePct: number | null;
} {
  const totalQty = sum(campaigns.flatMap((campaign) => campaign.legs).map((leg) => leg.qty));
  if (totalQty === 0) {
    return { weightedAverageEntry: null, improvementVsMacroOncePct: null };
  }

  const entryNotional = sum(
    campaigns.flatMap((campaign) => campaign.legs).map((leg) => leg.entryPrice * leg.qty),
  );
  const weightedAverageEntry = entryNotional / totalQty;
  if (!macroOnce) return { weightedAverageEntry, improvementVsMacroOncePct: null };

  const macroByArmTime = new Map(
    macroOnce.campaigns.map((campaign) => [campaign.armTime, campaign.weightedAverageEntry]),
  );
  let macroExpandedNotional = 0;
  for (const campaign of campaigns) {
    const campaignQty = sum(campaign.legs.map((leg) => leg.qty));
    if (campaignQty === 0) continue;
    const macroEntry = macroByArmTime.get(campaign.armTime);
    if (macroEntry === undefined || macroEntry === null) {
      return { weightedAverageEntry, improvementVsMacroOncePct: null };
    }
    macroExpandedNotional += macroEntry * campaignQty;
  }

  return {
    weightedAverageEntry,
    improvementVsMacroOncePct:
      macroExpandedNotional === 0
        ? null
        : ((macroExpandedNotional - entryNotional) / macroExpandedNotional) * 100,
  };
}

export function summarizeVariant(
  run: VariantRun,
  macroOnce?: VariantRun,
): VariantSummary {
  const closed = run.campaigns.filter(
    (campaign) => campaign.closed && campaign.legs.length > 0,
  );
  const closedLegs = closed.flatMap((campaign) => campaign.legs);
  const allLegs = run.campaigns.flatMap((campaign) => campaign.legs);
  const monthlyEntries: Record<string, number> = {};
  const yearlyEntries: Record<string, number> = {};
  const monthlyPnl: Record<string, number> = {};
  const yearlyPnl: Record<string, number> = {};
  for (const leg of allLegs) {
    addMetric(monthlyEntries, monthKey(leg.entryTime), 1);
    addMetric(yearlyEntries, yearKey(leg.entryTime), 1);
  }
  for (const campaign of closed) {
    addMetric(monthlyPnl, monthKey(campaign.exitTime!), campaign.netPnl);
    addMetric(yearlyPnl, yearKey(campaign.exitTime!), campaign.netPnl);
  }

  const pnlDescending = closed
    .map((campaign) => campaign.netPnl)
    .sort((left, right) => right - left);
  const closedNetPnl = sum(pnlDescending);
  const bestOnePnl = pnlDescending[0] ?? 0;
  const bestThreePnl = sum(pnlDescending.slice(0, 3));
  const allEntryComparison = weightedEntryComparison(run.campaigns, macroOnce);
  const closedEntryComparison = weightedEntryComparison(closed, macroOnce);
  const legCounts = run.campaigns.map((campaign) => campaign.legs.length);
  const bestCampaign = closed.length === 0
    ? null
    : closed.reduce((best, campaign) => campaign.netPnl > best.netPnl ? campaign : best);
  const worstCampaign = closed.length === 0
    ? null
    : closed.reduce((worst, campaign) => campaign.netPnl < worst.netPnl ? campaign : worst);

  return {
    name: run.name,
    simulatedNotTradable: run.simulatedNotTradable,
    totalCampaigns: run.campaigns.length,
    closedCampaigns: closed.length,
    openCampaigns: run.campaigns.filter((campaign) => !campaign.closed).length,
    zeroEntryCampaigns: legCounts.filter((count) => count === 0).length,
    oneEntryCampaigns: legCounts.filter((count) => count === 1).length,
    multipleEntryCampaigns: legCounts.filter((count) => count > 1).length,
    suppressedDuplicateDailyEntries: sum(
      run.campaigns.map((campaign) => campaign.suppressedDuplicateDailyEntries),
    ),
    closedLegs: closedLegs.length,
    totalLegs: allLegs.length,
    campaignWinRate:
      closed.length === 0
        ? 0
        : closed.filter((campaign) => campaign.netPnl > 0).length / closed.length,
    legWinRate:
      closedLegs.length === 0
        ? 0
        : closedLegs.filter((leg) => leg.netPnl > 0).length / closedLegs.length,
    netExpectancy: closed.length === 0 ? 0 : closedNetPnl / closed.length,
    averageReturnPct:
      closed.length === 0
        ? 0
        : sum(closed.map((campaign) => campaign.returnPct)) / closed.length,
    medianReturnPct: median(closed.map((campaign) => campaign.returnPct)),
    grossPnl: sum(run.campaigns.map((campaign) => campaign.grossPnl)),
    fees: sum(run.campaigns.map((campaign) => campaign.fees)),
    slippageCost: sum(run.campaigns.map((campaign) => campaign.slippageCost)),
    fundingPnl: sum(run.campaigns.map((campaign) => campaign.fundingPnl)),
    closedNetPnl,
    totalNetPnl: run.netPnl,
    averageLegsPerCampaign: legCounts.length === 0 ? 0 : sum(legCounts) / legCounts.length,
    medianLegsPerCampaign: median(legCounts),
    averageHoldHours:
      run.campaigns.length === 0
        ? 0
        : sum(run.campaigns.map((campaign) => campaign.holdHours)) / run.campaigns.length,
    averageUnderwaterHours:
      run.campaigns.length === 0
        ? 0
        : sum(run.campaigns.map((campaign) => campaign.underwaterHours)) / run.campaigns.length,
    weightedAverageEntry: allEntryComparison.weightedAverageEntry,
    weightedEntryImprovementVsMacroOncePct: allEntryComparison.improvementVsMacroOncePct,
    closedWeightedAverageEntry: closedEntryComparison.weightedAverageEntry,
    closedWeightedEntryImprovementVsMacroOncePct:
      closedEntryComparison.improvementVsMacroOncePct,
    monthlyEntries,
    monthlyPnl,
    yearlyEntries,
    yearlyPnl,
    bestCampaign,
    worstCampaign,
    concentration: {
      bestOnePnl,
      bestThreePnl,
      bestOneSharePct: closedNetPnl <= 0 ? null : (bestOnePnl / closedNetPnl) * 100,
      bestThreeSharePct: closedNetPnl <= 0 ? null : (bestThreePnl / closedNetPnl) * 100,
      netPnlWithoutBestOne: closedNetPnl - bestOnePnl,
      netPnlWithoutBestThree: closedNetPnl - bestThreePnl,
    },
    pre2023: stabilitySummary(
      closed.filter((campaign) => campaign.armTime < PRE_POST_SPLIT_MS),
    ),
    post2023: stabilitySummary(
      closed.filter((campaign) => campaign.armTime >= PRE_POST_SPLIT_MS),
    ),
    openCampaign: run.openCampaign,
    maxDrawdown: run.maxDrawdown,
    worstUnrealizedPnl: run.worstUnrealizedPnl,
    maxQuantity: run.maxQuantity,
    maxNotional: run.maxNotional,
    minimumWallet: run.minimumWallet,
    walletScenarios: run.walletScenarios,
  };
}
