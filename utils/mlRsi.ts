import type { SignalForgeKline } from "./signalForge";

export type MlRsiSide = "long" | "short";
export type MlRsiDirection = -1 | 0 | 1;

export interface MlRsiFeatureVector {
  value: number;
  slope: number;
  accel: number;
  mid: number;
  pct: number;
  churn: number;
  spread: number;
  regime: number;
}

export type MlRsiWeights = MlRsiFeatureVector;

export interface MlRsiConfig {
  rsiBase: number;
  memoryDepth: number;
  kNeighbors: number;
  winLen: number;
  spacingBars: number;
  horizonBars: number;
  gateRank: number;
  gateConf: number;
  useTrendGate: boolean;
  useVolBand: boolean;
  volBandLo: number;
  useChop: boolean;
  atrFactor: number;
  trendLen: number;
  chopCut: number;
  volBandHi: number;
  autoWeightsOn: boolean;
  autoSpeed: number;
  autoFloor: number;
  autoMinRows: number;
  stMultBase: number;
  stMlResp: number;
  stAtrLen: number;
  smoothLen: number;
  cooldownBars: number;
  lastBarIsClosed: boolean;
  manualWeights: MlRsiWeights;
}

export type MlRsiConfigInput = Partial<Omit<MlRsiConfig, "manualWeights">> & {
  manualWeights?: Partial<MlRsiWeights>;
};

export interface MlRsiBankRow {
  sourceIndex: number;
  features: MlRsiFeatureVector;
  outcome: number;
}

export interface MlRsiNeighbor {
  row: MlRsiBankRow;
  gap: number;
}

export interface MlRsiSignal {
  index: number;
  time: number;
  price: number;
  side: MlRsiSide;
  rank: number;
  confidence: number;
}

export interface MlRsiSignalInputBar {
  index: number;
  time: number;
  price: number;
  biasDir: MlRsiDirection;
  rank: number;
  confidence: number;
  gatesPass: boolean;
  confirmed: boolean;
}

export interface MlRsiBarResult extends MlRsiSignalInputBar {
  mlRsiValue: number | null;
  signalLine: number | null;
  supertrend: number | null;
  supertrendDirection: MlRsiDirection | null;
  analogScore: number;
  agreeFrac: number;
  gapTight: number;
  neighborCount: number;
  chop: boolean;
  volHealthy: boolean;
  trendAligned: boolean;
  weights: MlRsiWeights;
}

export interface MlRsiResult {
  bars: MlRsiBarResult[];
  mlRsiValue: (number | null)[];
  signalLine: (number | null)[];
  supertrend: (number | null)[];
  supertrendDirection: (MlRsiDirection | null)[];
  rank: (number | null)[];
  confidence: (number | null)[];
  signals: MlRsiSignal[];
  weightsByBar: MlRsiWeights[];
  config: MlRsiConfig;
}

const FEATURE_KEYS = ["value", "slope", "accel", "mid", "pct", "churn", "spread", "regime"] as const;
type FeatureKey = (typeof FEATURE_KEYS)[number];

const UNIT_WEIGHTS: MlRsiWeights = {
  value: 1,
  slope: 1,
  accel: 1,
  mid: 1,
  pct: 1,
  churn: 1,
  spread: 1,
  regime: 1,
};

export const DEFAULT_ML_RSI_CONFIG: MlRsiConfig = {
  rsiBase: 14,
  memoryDepth: 500,
  kNeighbors: 8,
  winLen: 100,
  spacingBars: 4,
  horizonBars: 4,
  gateRank: 60,
  gateConf: 50,
  useTrendGate: true,
  useVolBand: true,
  volBandLo: 20,
  useChop: true,
  atrFactor: 0.5,
  trendLen: 50,
  chopCut: 0.5,
  volBandHi: 85,
  autoWeightsOn: true,
  autoSpeed: 1,
  autoFloor: 0.5,
  autoMinRows: 60,
  stMultBase: 1.5,
  stMlResp: 1,
  stAtrLen: 10,
  smoothLen: 10,
  cooldownBars: 5,
  lastBarIsClosed: true,
  manualWeights: UNIT_WEIGHTS,
};

function resolveConfig(input: MlRsiConfigInput = {}): MlRsiConfig {
  const merged = { ...DEFAULT_ML_RSI_CONFIG, ...input };
  return {
    ...merged,
    rsiBase: Math.max(2, Math.round(merged.rsiBase)),
    memoryDepth: Math.max(1, Math.round(merged.memoryDepth)),
    kNeighbors: Math.max(1, Math.round(merged.kNeighbors)),
    winLen: Math.max(2, Math.round(merged.winLen)),
    spacingBars: Math.max(1, Math.round(merged.spacingBars)),
    horizonBars: Math.max(1, Math.round(merged.horizonBars)),
    trendLen: Math.max(2, Math.round(merged.trendLen)),
    stAtrLen: Math.max(1, Math.round(merged.stAtrLen)),
    smoothLen: Math.max(1, Math.round(merged.smoothLen)),
    cooldownBars: Math.max(0, Math.round(merged.cooldownBars)),
    manualWeights: sanitizeWeights({ ...UNIT_WEIGHTS, ...input.manualWeights }),
  };
}

function sanitizeWeights(weights: MlRsiWeights): MlRsiWeights {
  const out = { ...UNIT_WEIGHTS };
  for (const key of FEATURE_KEYS) out[key] = Number.isFinite(weights[key]) && weights[key] > 0 ? weights[key] : 1;
  return out;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function fixed(value: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(6)) : value;
}

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function rma(values: number[], length: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (length <= 0 || values.length < length) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (i < length) {
      sum += value;
      if (i === length - 1) out[i] = sum / length;
      continue;
    }
    out[i] = ((out[i - 1] ?? 0) * (length - 1) + value) / length;
  }
  return out;
}

function ema(values: number[], length: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (length <= 0 || values.length === 0) return out;
  const alpha = 2 / (length + 1);
  let current = values[0];
  out[0] = current;
  for (let i = 1; i < values.length; i++) {
    current = alpha * values[i] + (1 - alpha) * current;
    out[i] = current;
  }
  return out;
}

function emaNullable(values: (number | null)[], length: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (length <= 0) return out;
  const alpha = 2 / (length + 1);
  let current: number | null = null;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (value === null) continue;
    current = current === null ? value : alpha * value + (1 - alpha) * current;
    out[i] = current;
  }
  return out;
}

function rsi(closes: number[], length: number): (number | null)[] {
  const gains = new Array(closes.length).fill(0) as number[];
  const losses = new Array(closes.length).fill(0) as number[];
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains[i] = Math.max(diff, 0);
    losses[i] = Math.max(-diff, 0);
  }
  const avgGain = rma(gains.slice(1), length);
  const avgLoss = rma(losses.slice(1), length);
  const out: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = 1; i < closes.length; i++) {
    const gain = avgGain[i - 1];
    const loss = avgLoss[i - 1];
    if (gain === null || loss === null) continue;
    if (loss === 0) out[i] = 100;
    else if (gain === 0) out[i] = 0;
    else out[i] = 100 - 100 / (1 + gain / loss);
  }
  return out;
}

function trueRange(candles: SignalForgeKline[]): number[] {
  return candles.map((candle, i) => {
    if (i === 0) return candle.high - candle.low;
    const prevClose = candles[i - 1].close;
    return Math.max(candle.high - candle.low, Math.abs(candle.high - prevClose), Math.abs(candle.low - prevClose));
  });
}

function atr(candles: SignalForgeKline[], length: number): (number | null)[] {
  return rma(trueRange(candles), length);
}

function stdevNullable(values: (number | null)[], length: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    const window = values.slice(Math.max(0, i - length + 1), i + 1).filter((value): value is number => value !== null);
    if (window.length === 0 || values[i] === null) continue;
    const mean = window.reduce((sum, value) => sum + value, 0) / window.length;
    const variance = window.reduce((sum, value) => sum + (value - mean) ** 2, 0) / window.length;
    out[i] = Math.sqrt(variance);
  }
  return out;
}

function scale01Series(values: (number | null)[], length: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    const current = values[i];
    if (current === null) continue;
    const window = values.slice(Math.max(0, i - length + 1), i + 1).filter((value): value is number => value !== null);
    if (window.length === 0) continue;
    const lo = Math.min(...window);
    const hi = Math.max(...window);
    out[i] = hi === lo ? 0.5 : (current - lo) / (hi - lo);
  }
  return out;
}

function percentRankSeries(values: (number | null)[], length: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    const current = values[i];
    if (current === null) continue;
    const window = values.slice(Math.max(0, i - length + 1), i + 1).filter((value): value is number => value !== null);
    if (window.length === 0) continue;
    const rank = window.filter((value) => value <= current).length;
    out[i] = rank / window.length;
  }
  return out;
}

interface FeatureBundle {
  features: (MlRsiFeatureVector | null)[];
  rsi: (number | null)[];
  slopeRaw: (number | null)[];
  regimeRaw: (number | null)[];
}

function calculateFeatureBundle(candles: SignalForgeKline[], cfg: MlRsiConfig): FeatureBundle {
  const closes = candles.map((candle) => candle.close);
  const rOsc = rsi(closes, cfg.rsiBase);
  const rOscF = rsi(closes, Math.max(2, Math.round(cfg.rsiBase / 2)));
  const rOscS = rsi(closes, cfg.rsiBase * 2);
  const stepLen = 3;

  const slopeRaw = rOsc.map((value, i) => (value === null || rOsc[i - stepLen] === undefined || rOsc[i - stepLen] === null ? null : value - rOsc[i - stepLen]!));
  const accelRaw = rOsc.map((value, i) => {
    if (value === null || rOsc[i - stepLen] === undefined || rOsc[i - stepLen] === null || rOsc[i - 2 * stepLen] === undefined || rOsc[i - 2 * stepLen] === null) {
      return null;
    }
    return value - rOsc[i - stepLen]! - (rOsc[i - stepLen]! - rOsc[i - 2 * stepLen]!);
  });
  const churnRaw = stdevNullable(rOsc, 14);
  const spreadRaw = rOsc.map((_, i) => (rOscF[i] === null || rOscS[i] === null ? null : rOscF[i]! - rOscS[i]!));
  const emaRsi = emaNullable(rOsc, 20);
  const regimeRaw = emaRsi.map((value) => (value === null ? null : value - 50));

  const slope = scale01Series(slopeRaw, cfg.winLen);
  const accel = scale01Series(accelRaw, cfg.winLen);
  const pct = percentRankSeries(rOsc, cfg.winLen);
  const churn = scale01Series(churnRaw, cfg.winLen);
  const spread = scale01Series(spreadRaw, cfg.winLen);
  const regime = scale01Series(regimeRaw, cfg.winLen);

  const features: (MlRsiFeatureVector | null)[] = new Array(candles.length).fill(null);
  for (let i = 0; i < candles.length; i++) {
    const r = rOsc[i];
    if (r === null || slope[i] === null || accel[i] === null || pct[i] === null || churn[i] === null || spread[i] === null || regime[i] === null) {
      continue;
    }
    features[i] = {
      value: clamp(r / 100, 0, 1),
      slope: clamp(slope[i]!, 0, 1),
      accel: clamp(accel[i]!, 0, 1),
      mid: clamp(Math.abs(r - 50) / 50, 0, 1),
      pct: clamp(pct[i]!, 0, 1),
      churn: clamp(churn[i]!, 0, 1),
      spread: clamp(spread[i]!, 0, 1),
      regime: clamp(regime[i]!, 0, 1),
    };
  }

  return { features, rsi: rOsc, slopeRaw, regimeRaw };
}

export function calculateMlRsiFeatureSeries(candles: SignalForgeKline[], config: MlRsiConfigInput = {}): (MlRsiFeatureVector | null)[] {
  const cfg = resolveConfig(config);
  return calculateFeatureBundle(candles, cfg).features;
}

function compress(diff: number): number {
  return Math.log(1 + Math.abs(diff));
}

function gapTo(current: MlRsiFeatureVector, row: MlRsiBankRow, weights: MlRsiWeights): number {
  return FEATURE_KEYS.reduce((sum, key) => sum + weights[key] * compress(current[key] - row.features[key]), 0);
}

export function selectNearestMlRsiNeighbors(
  current: MlRsiFeatureVector,
  rows: MlRsiBankRow[],
  weights: MlRsiWeights,
  kNeighbors: number,
  spacingBars: number
): MlRsiNeighbor[] {
  const nearest: MlRsiNeighbor[] = [];
  const step = Math.max(1, Math.round(spacingBars));
  const k = Math.max(1, Math.round(kNeighbors));
  for (let i = 0; i < rows.length; i += step) {
    const row = rows[i];
    const gap = gapTo(current, row, weights);
    nearest.push({ row, gap });
    nearest.sort((a, b) => a.gap - b.gap);
    if (nearest.length > k) nearest.pop();
  }
  return nearest;
}

interface EngineResult {
  analogScore: number;
  biasDir: MlRsiDirection;
  agreeFrac: number;
  gapTight: number;
  neighborCount: number;
  avgGap: number;
}

function evaluateEngine(current: MlRsiFeatureVector | null, bank: MlRsiBankRow[], weights: MlRsiWeights, cfg: MlRsiConfig): EngineResult {
  if (current === null || bank.length === 0) {
    return { analogScore: 0, biasDir: 0, agreeFrac: 0, gapTight: 0, neighborCount: 0, avgGap: 0 };
  }

  const neighbors = selectNearestMlRsiNeighbors(current, bank, weights, cfg.kNeighbors, cfg.spacingBars);
  let bull = 0;
  let bear = 0;
  let score = 0;
  let total = 0;
  let gapSum = 0;
  for (const neighbor of neighbors) {
    const weight = 1 / (1 + neighbor.gap);
    total += weight;
    score += neighbor.row.outcome * weight;
    gapSum += neighbor.gap;
    if (neighbor.row.outcome > 0) bull += weight;
    else if (neighbor.row.outcome < 0) bear += weight;
  }

  const analogScore = total > 0 ? score / total : 0;
  const biasDir: MlRsiDirection = analogScore > 0.15 ? 1 : analogScore < -0.15 ? -1 : 0;
  const agreeFrac = total > 0 ? (biasDir === 1 ? bull : biasDir === -1 ? bear : 0) / total : 0;
  const avgGap = neighbors.length > 0 ? gapSum / neighbors.length : 0;
  const weightSum = FEATURE_KEYS.reduce((sum, key) => sum + weights[key], 0);
  const gapScale = weightSum * 0.45;
  const gapTight = gapScale > 0 ? clamp(1 - avgGap / gapScale, 0, 1) : 0;

  return {
    analogScore,
    biasDir,
    agreeFrac: clamp(agreeFrac, 0, 1),
    gapTight,
    neighborCount: neighbors.length,
    avgGap,
  };
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function variance(values: number[], m: number): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + (value - m) ** 2, 0) / values.length;
}

function optimizeWeights(bank: MlRsiBankRow[], previous: MlRsiWeights, cfg: MlRsiConfig): MlRsiWeights {
  if (!cfg.autoWeightsOn) return cfg.manualWeights;
  const bull = bank.filter((row) => row.outcome > 0);
  const bear = bank.filter((row) => row.outcome < 0);
  if (bank.length < cfg.autoMinRows || bull.length === 0 || bear.length === 0) return previous;

  const fisher = FEATURE_KEYS.map((key) => {
    const bullValues = bull.map((row) => row.features[key]);
    const bearValues = bear.map((row) => row.features[key]);
    const mBull = mean(bullValues);
    const mBear = mean(bearValues);
    return (mBull - mBear) ** 2 / (variance(bullValues, mBull) + variance(bearValues, mBear) + 1e-6);
  });
  const avgFisher = mean(fisher.filter((value) => value > 0));
  if (!Number.isFinite(avgFisher) || avgFisher <= 0) return previous;

  const alpha = clamp(2 / (Math.max(1, cfg.autoSpeed) + 1), 0.01, 1);
  const out = { ...previous };
  for (let i = 0; i < FEATURE_KEYS.length; i++) {
    const key = FEATURE_KEYS[i];
    const target = clamp(Math.max(cfg.autoFloor, fisher[i] / avgFisher), cfg.autoFloor, 3);
    out[key] = previous[key] * (1 - alpha) + target * alpha;
  }
  return out;
}

function classifyOutcome(moveFwd: number, bandFwd: number): number {
  if (moveFwd > 2 * bandFwd) return 3;
  if (moveFwd > bandFwd) return 2;
  if (moveFwd > 0) return 1;
  if (moveFwd < -2 * bandFwd) return -3;
  if (moveFwd < -bandFwd) return -2;
  if (moveFwd < 0) return -1;
  return 0;
}

function weightCopy(weights: MlRsiWeights): MlRsiWeights {
  return {
    value: fixed(weights.value),
    slope: fixed(weights.slope),
    accel: fixed(weights.accel),
    mid: fixed(weights.mid),
    pct: fixed(weights.pct),
    churn: fixed(weights.churn),
    spread: fixed(weights.spread),
    regime: fixed(weights.regime),
  };
}

function rankScore(args: {
  engine: EngineResult;
  biasAge: number;
  slopeFit: boolean;
  regimeFit: boolean;
  trendAligned: boolean;
  volHealthy: boolean;
  chop: boolean;
  convSmoothed: number;
  cfg: MlRsiConfig;
}): number {
  const { engine, biasAge, slopeFit, regimeFit, trendAligned, volHealthy, chop, convSmoothed, cfg } = args;
  if (engine.biasDir === 0 || engine.neighborCount === 0) return 0;

  const structPoints = slopeFit ? 10 : 0;
  const trendPoints = trendAligned ? 15 : 0;
  const volPoints = volHealthy ? 10 : 0;
  const regimePoints = regimeFit ? 10 : 0;
  const smoothPoints = 10 * clamp(Math.abs(convSmoothed), 0, 1);
  const holdPoints = 10 * clamp(biasAge / 5, 0, 1);
  const kShortagePenalty = engine.neighborCount < cfg.kNeighbors ? 15 * (1 - engine.neighborCount / cfg.kNeighbors) : 0;
  const penalties = (chop ? 15 : 0) + (!trendAligned ? 10 : 0) + (!slopeFit ? 5 : 0) + kShortagePenalty;

  return clamp(
    25 * engine.agreeFrac +
      15 * engine.gapTight +
      structPoints +
      trendPoints +
      volPoints +
      regimePoints +
      smoothPoints +
      holdPoints -
      penalties,
    0,
    100
  );
}

function confScore(args: { engine: EngineResult; biasAge: number; slopeFit: boolean; cfg: MlRsiConfig }): number {
  const { engine, biasAge, slopeFit, cfg } = args;
  if (engine.biasDir === 0 || engine.neighborCount === 0) return 0;
  const flipPenalty = biasAge <= 1 ? 10 : biasAge < 3 ? 5 : 0;
  const kShortagePenalty = engine.neighborCount < cfg.kNeighbors ? 20 * (1 - engine.neighborCount / cfg.kNeighbors) : 0;
  return clamp(40 * engine.agreeFrac + 25 * engine.gapTight + 15 * clamp(biasAge / 5, 0, 1) + 10 * (slopeFit ? 1 : 0) - flipPenalty - kShortagePenalty, 0, 100);
}

function confirmedAt(index: number, total: number, cfg: MlRsiConfig): boolean {
  return cfg.lastBarIsClosed || index < total - 1;
}

export function evaluateMlRsiSignals(bars: MlRsiSignalInputBar[], config: MlRsiConfigInput = {}): MlRsiSignal[] {
  const cfg = resolveConfig(config);
  const signals: MlRsiSignal[] = [];
  let stanceState: MlRsiDirection = 0;
  let lastSignalIndex = -Infinity;

  for (const bar of bars) {
    if (!bar.confirmed || !bar.gatesPass || bar.biasDir === 0) continue;

    const previousStance = stanceState;
    if (bar.biasDir !== stanceState) stanceState = bar.biasDir;
    const flipped = stanceState !== previousStance;
    const qualifies = bar.rank >= cfg.gateRank && bar.confidence >= cfg.gateConf;
    const cooledDown = bar.index - lastSignalIndex >= cfg.cooldownBars;

    if (flipped && qualifies && cooledDown) {
      signals.push({
        index: bar.index,
        time: bar.time,
        price: fixed(bar.price),
        side: stanceState === 1 ? "long" : "short",
        rank: fixed(bar.rank),
        confidence: fixed(bar.confidence),
      });
      lastSignalIndex = bar.index;
    }
  }

  return signals;
}

export function runMlRsi(candles: SignalForgeKline[], config: MlRsiConfigInput = {}): MlRsiResult {
  const cfg = resolveConfig(config);
  const safeCandles = candles.filter((candle) =>
    [candle.open, candle.high, candle.low, candle.close, candle.time].every((value) => Number.isFinite(value))
  );
  const n = safeCandles.length;
  const featureBundle = calculateFeatureBundle(safeCandles, cfg);
  const atr14 = atr(safeCandles, 14);
  const stAtr = atr(safeCandles, cfg.stAtrLen);
  const closes = safeCandles.map((candle) => candle.close);
  const emaFast = ema(closes, 5);
  const emaSlow = ema(closes, cfg.trendLen);
  const atrPct = percentRankSeries(atr14, cfg.winLen);

  const mlRsiValue: (number | null)[] = new Array(n).fill(null);
  const supertrend: (number | null)[] = new Array(n).fill(null);
  const supertrendDirection: (MlRsiDirection | null)[] = new Array(n).fill(null);
  const rank: (number | null)[] = new Array(n).fill(null);
  const confidence: (number | null)[] = new Array(n).fill(null);
  const weightsByBar: MlRsiWeights[] = new Array(n);
  const bars: MlRsiBarResult[] = new Array(n);
  const signalInputs: MlRsiSignalInputBar[] = [];
  const bank: MlRsiBankRow[] = [];

  let weights = sanitizeWeights(cfg.autoWeightsOn ? UNIT_WEIGHTS : cfg.manualWeights);
  let convSmoothed: number | null = null;
  let stLong: number | null = null;
  let stShort: number | null = null;
  let stDir: MlRsiDirection = 1;
  let prevBias: MlRsiDirection = 0;
  let biasAge = 0;

  for (let i = 0; i < n; i++) {
    const candle = safeCandles[i];
    const isConfirmed = confirmedAt(i, n, cfg);

    if (isConfirmed && i >= cfg.horizonBars) {
      const sourceIndex = i - cfg.horizonBars;
      const sourceFeatures = featureBundle.features[sourceIndex];
      const sourceAtr = atr14[sourceIndex];
      if (sourceFeatures !== null && sourceAtr !== null) {
        bank.unshift({
          sourceIndex,
          features: sourceFeatures,
          outcome: classifyOutcome(candle.close - safeCandles[sourceIndex].close, cfg.atrFactor * sourceAtr),
        });
        if (bank.length > cfg.memoryDepth) bank.pop();
      }
    }

    weights = optimizeWeights(bank, weights, cfg);
    weightsByBar[i] = weightCopy(weights);

    const engine = evaluateEngine(featureBundle.features[i], bank, weights, cfg);
    if (engine.biasDir !== 0 && engine.biasDir === prevBias) biasAge += 1;
    else if (engine.biasDir !== 0) biasAge = 1;
    else biasAge = 0;
    prevBias = engine.biasDir;

    const atrForChop = atr14[i];
    const chop =
      emaFast[i] !== null &&
      emaSlow[i] !== null &&
      atrForChop !== null &&
      atrForChop > 0 &&
      Math.abs(emaFast[i]! - emaSlow[i]!) / atrForChop < cfg.chopCut;
    const volRank = atrPct[i];
    const volHealthy = volRank !== null && volRank >= cfg.volBandLo / 100 && volRank <= cfg.volBandHi / 100;

    const convInst = clamp(engine.analogScore / 1.5, -1, 1);
    const convAlpha = 2 / (cfg.smoothLen + 1);
    convSmoothed = convSmoothed === null ? convInst : convAlpha * convInst + (1 - convAlpha) * convSmoothed;
    if (featureBundle.features[i] !== null) mlRsiValue[i] = clamp(50 + convSmoothed * 50, 0, 100);

    let mlDrive = clamp(Math.abs(convSmoothed) * 0.5 + engine.gapTight * 0.3 + engine.agreeFrac * 0.2, 0, 1);
    if (chop) mlDrive *= 0.35;
    const currentStAtr = stAtr[i];
    if (currentStAtr !== null) {
      const hl2 = (candle.high + candle.low) / 2;
      const adaptMult = cfg.stMultBase * (1 + cfg.stMlResp * (1 - mlDrive));
      const upBand = hl2 - adaptMult * currentStAtr;
      const dnBand = hl2 + adaptMult * currentStAtr;
      const prevClose = i > 0 ? safeCandles[i - 1].close : candle.close;
      const prevLong: number | null = stLong;
      const prevShort: number | null = stShort;
      stLong = prevLong === null ? upBand : prevClose > prevLong ? Math.max(upBand, prevLong) : upBand;
      stShort = prevShort === null ? dnBand : prevClose < prevShort ? Math.min(dnBand, prevShort) : dnBand;
      if (prevLong === null || prevShort === null) stDir = candle.close >= hl2 ? 1 : -1;
      else if (stDir === -1 && candle.close > prevShort) stDir = 1;
      else if (stDir === 1 && candle.close < prevLong) stDir = -1;
      supertrend[i] = stDir === 1 ? stLong : stShort;
      supertrendDirection[i] = stDir;
    }

    const trendAligned = (engine.biasDir === 1 && supertrendDirection[i] === 1) || (engine.biasDir === -1 && supertrendDirection[i] === -1);
    const slope = featureBundle.slopeRaw[i];
    const slopeFit = engine.biasDir === 0 || slope === null ? false : engine.biasDir === 1 ? slope > 0 : slope < 0;
    const regime = featureBundle.regimeRaw[i];
    const regimeFit = engine.biasDir === 0 || regime === null ? false : engine.biasDir === 1 ? regime > 0 : regime < 0;
    const gatesPass =
      engine.biasDir !== 0 &&
      (!cfg.useTrendGate || trendAligned) &&
      (!cfg.useVolBand || volHealthy) &&
      (!cfg.useChop || !chop);
    const barRank = rankScore({
      engine,
      biasAge,
      slopeFit,
      regimeFit,
      trendAligned,
      volHealthy,
      chop,
      convSmoothed,
      cfg,
    });
    const barConf = confScore({ engine, biasAge, slopeFit, cfg });
    rank[i] = barRank;
    confidence[i] = barConf;

    const signalInput: MlRsiSignalInputBar = {
      index: i,
      time: candle.time,
      price: candle.close,
      biasDir: engine.biasDir,
      rank: barRank,
      confidence: barConf,
      gatesPass,
      confirmed: isConfirmed,
    };
    signalInputs.push(signalInput);

    bars[i] = {
      ...signalInput,
      mlRsiValue: mlRsiValue[i],
      signalLine: null,
      supertrend: finiteOrNull(supertrend[i] ?? NaN),
      supertrendDirection: supertrendDirection[i],
      analogScore: fixed(engine.analogScore),
      agreeFrac: fixed(engine.agreeFrac),
      gapTight: fixed(engine.gapTight),
      neighborCount: engine.neighborCount,
      chop,
      volHealthy,
      trendAligned,
      weights: weightsByBar[i],
    };
  }

  const signalLine = emaNullable(mlRsiValue, cfg.smoothLen);
  for (let i = 0; i < n; i++) bars[i].signalLine = signalLine[i];

  return {
    bars,
    mlRsiValue,
    signalLine,
    supertrend,
    supertrendDirection,
    rank,
    confidence,
    signals: evaluateMlRsiSignals(signalInputs, cfg),
    weightsByBar,
    config: cfg,
  };
}
