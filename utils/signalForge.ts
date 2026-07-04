export type SignalForgeState = "Bullish" | "Bearish" | "Neutral";
export type SignalForgeSide = "long" | "short";

export interface SignalForgeKline {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export const SIGNAL_FORGE_INDICATOR_KEYS = [
  "sma",
  "rsi",
  "macd",
  "supertrend",
  "stoch",
  "bb",
  "ema",
  "ao",
  "sar",
  "cci",
  "adx",
] as const;

export type SignalForgeIndicatorKey = (typeof SIGNAL_FORGE_INDICATOR_KEYS)[number];

export const SIGNAL_FORGE_INDICATOR_LABELS: Record<SignalForgeIndicatorKey, string> = {
  sma: "SMA Cross",
  rsi: "RSI",
  macd: "MACD",
  supertrend: "Supertrend",
  stoch: "Stochastic",
  bb: "BB Trend",
  ema: "EMA Cross",
  ao: "AO",
  sar: "Parabolic SAR",
  cci: "CCI",
  adx: "ADX + DI",
};

export interface SignalForgeConfig {
  logic: {
    requireAll: boolean;
  };
  risk: {
    atrLength: number;
    enableTp: boolean;
    tpMultiplier: number;
    enableSl: boolean;
    slMultiplier: number;
    enableTs: boolean;
    tsMultiplier: number;
  };
  indicators: {
    sma: { enabled: boolean; fastLength: number; slowLength: number };
    rsi: { enabled: boolean; length: number; longLevel: number; shortLevel: number };
    macd: { enabled: boolean; fastLength: number; slowLength: number; signalLength: number };
    supertrend: { enabled: boolean; factor: number; length: number };
    stoch: { enabled: boolean; kLength: number; dLength: number; smooth: number };
    bb: { enabled: boolean; length: number; multiplier: number };
    ema: { enabled: boolean; fastLength: number; slowLength: number };
    ao: { enabled: boolean };
    sar: { enabled: boolean; start: number; increment: number; max: number };
    cci: { enabled: boolean; length: number; longLevel: number; shortLevel: number };
    adx: { enabled: boolean; adxLength: number; diLength: number; threshold: number };
  };
}

export const DEFAULT_SIGNAL_FORGE_CONFIG: SignalForgeConfig = {
  logic: {
    requireAll: true,
  },
  risk: {
    atrLength: 14,
    enableTp: false,
    tpMultiplier: 2,
    enableSl: false,
    slMultiplier: 1.5,
    enableTs: false,
    tsMultiplier: 1,
  },
  indicators: {
    sma: { enabled: true, fastLength: 10, slowLength: 20 },
    rsi: { enabled: false, length: 14, longLevel: 50, shortLevel: 50 },
    macd: { enabled: false, fastLength: 12, slowLength: 26, signalLength: 9 },
    supertrend: { enabled: false, factor: 3, length: 10 },
    stoch: { enabled: false, kLength: 14, dLength: 3, smooth: 3 },
    bb: { enabled: false, length: 20, multiplier: 2 },
    ema: { enabled: false, fastLength: 10, slowLength: 20 },
    ao: { enabled: false },
    sar: { enabled: false, start: 0.02, increment: 0.02, max: 0.2 },
    cci: { enabled: false, length: 20, longLevel: 0, shortLevel: 0 },
    adx: { enabled: false, adxLength: 14, diLength: 14, threshold: 20 },
  },
};

export function cloneSignalForgeConfig(config: SignalForgeConfig = DEFAULT_SIGNAL_FORGE_CONFIG): SignalForgeConfig {
  return {
    logic: { ...config.logic },
    risk: { ...config.risk },
    indicators: {
      sma: { ...config.indicators.sma },
      rsi: { ...config.indicators.rsi },
      macd: { ...config.indicators.macd },
      supertrend: { ...config.indicators.supertrend },
      stoch: { ...config.indicators.stoch },
      bb: { ...config.indicators.bb },
      ema: { ...config.indicators.ema },
      ao: { ...config.indicators.ao },
      sar: { ...config.indicators.sar },
      cci: { ...config.indicators.cci },
      adx: { ...config.indicators.adx },
    },
  };
}

export type SignalForgeStates = Record<SignalForgeIndicatorKey, SignalForgeState>;
export type PartialSignalForgeStates = Partial<Record<SignalForgeIndicatorKey, SignalForgeState>>;

export interface SignalForgeCompositeSignal {
  long: boolean;
  short: boolean;
}

export interface SignalForgeBarResult {
  index: number;
  time: number;
  close: number;
  states: SignalForgeStates;
  composite: SignalForgeCompositeSignal;
  compositeSide: SignalForgeSide | null;
  atr: number | null;
}

export interface SignalForgeMarker {
  time: number;
  price: number;
  side: SignalForgeSide;
}

export interface SignalForgeActiveRisk {
  entryPrice: number;
  side: SignalForgeSide;
  tpPrice: number | null;
  slPrice: number | null;
  trailingStop: number | null;
}

export interface SignalForgeTrade {
  id: number;
  side: SignalForgeSide;
  entryIndex: number;
  entryTime: number;
  entryPrice: number;
  exitIndex: number | null;
  exitTime: number | null;
  exitPrice: number | null;
  exitReason: "takeProfit" | "stopLoss" | "trailingStop" | "oppositeSignal" | "endOfData" | null;
  pnlPct: number | null;
  tpPrice: number | null;
  slPrice: number | null;
  trailingStop: number | null;
}

export interface SignalForgeStats {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number | null;
  netPnlPct: number;
  grossProfitPct: number;
  grossLossPct: number;
}

export interface SignalForgeIndicatorSummary extends SignalForgeStats {
  key: SignalForgeIndicatorKey;
  label: string;
  enabled: boolean;
  state: SignalForgeState;
}

export interface SignalForgeResult {
  bars: SignalForgeBarResult[];
  enabledIndicatorKeys: SignalForgeIndicatorKey[];
  latestStates: SignalForgeStates;
  indicatorSummaries: SignalForgeIndicatorSummary[];
  compositeStats: SignalForgeStats;
  compositeTrades: SignalForgeTrade[];
  activeCompositeTrade: SignalForgeTrade | null;
  activeRisk: SignalForgeActiveRisk | null;
  markers: SignalForgeMarker[];
}

interface NumericSeriesBundle {
  atr: (number | null)[];
  statesByKey: Record<SignalForgeIndicatorKey, SignalForgeState[]>;
}

interface MutableTrade extends SignalForgeTrade {
  highestSinceEntry: number;
  lowestSinceEntry: number;
}

function emptyStates(): SignalForgeStates {
  return Object.fromEntries(SIGNAL_FORGE_INDICATOR_KEYS.map((key) => [key, "Neutral"])) as SignalForgeStates;
}

function enabledIndicatorKeys(config: SignalForgeConfig): SignalForgeIndicatorKey[] {
  return SIGNAL_FORGE_INDICATOR_KEYS.filter((key) => config.indicators[key].enabled);
}

function stateFromPair(isBullish: boolean, isBearish: boolean): SignalForgeState {
  if (isBullish && !isBearish) return "Bullish";
  if (isBearish && !isBullish) return "Bearish";
  return "Neutral";
}

function fixedNumber(value: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(6)) : value;
}

function sma(values: number[], length: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (length <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= length) sum -= values[i - length];
    if (i >= length - 1) out[i] = sum / length;
  }
  return out;
}

function smaNullable(values: (number | null)[], length: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (length <= 0) return out;
  let sum = 0;
  let count = 0;
  const window: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (value === null) {
      window.length = 0;
      sum = 0;
      count = 0;
      continue;
    }
    window.push(value);
    sum += value;
    count++;
    if (count > length) {
      sum -= window.shift()!;
      count--;
    }
    if (count === length) out[i] = sum / length;
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

function rmaNullable(values: (number | null)[], length: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (length <= 0) return out;
  let sum = 0;
  let count = 0;
  let current: number | null = null;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (value === null) continue;
    if (current === null) {
      sum += value;
      count++;
      if (count === length) {
        current = sum / length;
        out[i] = current;
      }
      continue;
    }
    current = (current * (length - 1) + value) / length;
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
  const tr = trueRange(candles);
  return rma(tr, length);
}

function macd(closes: number[], fastLength: number, slowLength: number, signalLength: number) {
  const fast = ema(closes, fastLength);
  const slow = ema(closes, slowLength);
  const macdLine = closes.map((_, i) => (fast[i] === null || slow[i] === null ? null : fast[i]! - slow[i]!));
  const signalInput = macdLine.map((value) => value ?? 0);
  const rawSignal = ema(signalInput, signalLength);
  const signalLine = closes.map((_, i) => (macdLine[i] === null ? null : rawSignal[i]));
  return { macdLine, signalLine };
}

function stochastic(candles: SignalForgeKline[], length: number, smooth: number, dLength: number) {
  const raw: (number | null)[] = new Array(candles.length).fill(null);
  if (length <= 0) return { k: raw, d: new Array(candles.length).fill(null) as (number | null)[] };
  for (let i = length - 1; i < candles.length; i++) {
    const window = candles.slice(i - length + 1, i + 1);
    const low = Math.min(...window.map((c) => c.low));
    const high = Math.max(...window.map((c) => c.high));
    raw[i] = high === low ? 0 : ((candles[i].close - low) / (high - low)) * 100;
  }
  const k = smaNullable(raw, smooth);
  return { k, d: smaNullable(k, dLength) };
}

function bollingerMiddle(closes: number[], length: number): (number | null)[] {
  return sma(closes, length);
}

function supertrend(candles: SignalForgeKline[], factor: number, length: number): (SignalForgeState | null)[] {
  const out: (SignalForgeState | null)[] = new Array(candles.length).fill(null);
  const atrValues = atr(candles, length);
  let finalUpper: number | null = null;
  let finalLower: number | null = null;
  let direction: 1 | -1 = 1;

  for (let i = 0; i < candles.length; i++) {
    const currentAtr = atrValues[i];
    if (currentAtr === null) continue;

    const candle = candles[i];
    const hl2 = (candle.high + candle.low) / 2;
    const basicUpper = hl2 + factor * currentAtr;
    const basicLower = hl2 - factor * currentAtr;
    const prevClose = i > 0 ? candles[i - 1].close : candle.close;

    if (finalUpper === null || finalLower === null) {
      finalUpper = basicUpper;
      finalLower = basicLower;
      direction = candle.close >= hl2 ? -1 : 1;
    } else {
      finalUpper = basicUpper < finalUpper || prevClose > finalUpper ? basicUpper : finalUpper;
      finalLower = basicLower > finalLower || prevClose < finalLower ? basicLower : finalLower;
      if (direction === -1 && candle.close < finalLower) direction = 1;
      else if (direction === 1 && candle.close > finalUpper) direction = -1;
    }

    out[i] = direction === -1 ? "Bullish" : "Bearish";
  }

  return out;
}

function parabolicSar(candles: SignalForgeKline[], start: number, increment: number, max: number): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length < 2) return out;

  let isLong = candles[1].close >= candles[0].close;
  let sar = isLong ? candles[0].low : candles[0].high;
  let extreme = isLong ? Math.max(candles[0].high, candles[1].high) : Math.min(candles[0].low, candles[1].low);
  let acceleration = start;
  out[1] = sar;

  for (let i = 2; i < candles.length; i++) {
    sar = sar + acceleration * (extreme - sar);
    const prev = candles[i - 1];
    const prev2 = candles[i - 2];

    if (isLong) {
      sar = Math.min(sar, prev.low, prev2.low);
      if (candles[i].low < sar) {
        isLong = false;
        sar = extreme;
        extreme = candles[i].low;
        acceleration = start;
      } else if (candles[i].high > extreme) {
        extreme = candles[i].high;
        acceleration = Math.min(acceleration + increment, max);
      }
    } else {
      sar = Math.max(sar, prev.high, prev2.high);
      if (candles[i].high > sar) {
        isLong = true;
        sar = extreme;
        extreme = candles[i].high;
        acceleration = start;
      } else if (candles[i].low < extreme) {
        extreme = candles[i].low;
        acceleration = Math.min(acceleration + increment, max);
      }
    }

    out[i] = sar;
  }

  return out;
}

function cci(closes: number[], length: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  const basis = sma(closes, length);
  for (let i = length - 1; i < closes.length; i++) {
    const mean = basis[i];
    if (mean === null) continue;
    const window = closes.slice(i - length + 1, i + 1);
    const meanDeviation = window.reduce((sum, value) => sum + Math.abs(value - mean), 0) / length;
    out[i] = meanDeviation === 0 ? 0 : (closes[i] - mean) / (0.015 * meanDeviation);
  }
  return out;
}

function dmi(candles: SignalForgeKline[], diLength: number, adxLength: number) {
  const n = candles.length;
  const plusDM = new Array(n).fill(0) as number[];
  const minusDM = new Array(n).fill(0) as number[];
  const tr = trueRange(candles);

  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }

  const trRma = rma(tr, diLength);
  const plusRma = rma(plusDM, diLength);
  const minusRma = rma(minusDM, diLength);
  const plusDI: (number | null)[] = new Array(n).fill(null);
  const minusDI: (number | null)[] = new Array(n).fill(null);
  const dx: (number | null)[] = new Array(n).fill(null);

  for (let i = 0; i < n; i++) {
    if (trRma[i] === null || plusRma[i] === null || minusRma[i] === null) continue;
    plusDI[i] = trRma[i] === 0 ? 0 : (100 * plusRma[i]!) / trRma[i]!;
    minusDI[i] = trRma[i] === 0 ? 0 : (100 * minusRma[i]!) / trRma[i]!;
    const sum = plusDI[i]! + minusDI[i]!;
    dx[i] = sum === 0 ? 0 : (100 * Math.abs(plusDI[i]! - minusDI[i]!)) / sum;
  }

  const adx = rmaNullable(dx, adxLength);

  return { plusDI, minusDI, adx };
}

function calculateSeries(candles: SignalForgeKline[], config: SignalForgeConfig): NumericSeriesBundle {
  const closes = candles.map((c) => c.close);
  const hl2 = candles.map((c) => (c.high + c.low) / 2);
  const statesByKey = Object.fromEntries(
    SIGNAL_FORGE_INDICATOR_KEYS.map((key) => [key, new Array(candles.length).fill("Neutral")])
  ) as Record<SignalForgeIndicatorKey, SignalForgeState[]>;

  const smaFast = sma(closes, config.indicators.sma.fastLength);
  const smaSlow = sma(closes, config.indicators.sma.slowLength);
  for (let i = 0; i < candles.length; i++) {
    statesByKey.sma[i] = stateFromPair(smaFast[i] !== null && smaSlow[i] !== null && smaFast[i]! > smaSlow[i]!, smaFast[i] !== null && smaSlow[i] !== null && smaFast[i]! < smaSlow[i]!);
  }

  const rsiValues = rsi(closes, config.indicators.rsi.length);
  for (let i = 0; i < candles.length; i++) {
    statesByKey.rsi[i] = stateFromPair(rsiValues[i] !== null && rsiValues[i]! > config.indicators.rsi.longLevel, rsiValues[i] !== null && rsiValues[i]! < config.indicators.rsi.shortLevel);
  }

  const macdValues = macd(closes, config.indicators.macd.fastLength, config.indicators.macd.slowLength, config.indicators.macd.signalLength);
  for (let i = 0; i < candles.length; i++) {
    statesByKey.macd[i] = stateFromPair(
      macdValues.macdLine[i] !== null && macdValues.signalLine[i] !== null && macdValues.macdLine[i]! > macdValues.signalLine[i]!,
      macdValues.macdLine[i] !== null && macdValues.signalLine[i] !== null && macdValues.macdLine[i]! < macdValues.signalLine[i]!
    );
  }

  const stValues = supertrend(candles, config.indicators.supertrend.factor, config.indicators.supertrend.length);
  for (let i = 0; i < candles.length; i++) statesByKey.supertrend[i] = stValues[i] ?? "Neutral";

  const stochValues = stochastic(candles, config.indicators.stoch.kLength, config.indicators.stoch.smooth, config.indicators.stoch.dLength);
  for (let i = 0; i < candles.length; i++) {
    statesByKey.stoch[i] = stateFromPair(stochValues.k[i] !== null && stochValues.k[i]! > 50, stochValues.k[i] !== null && stochValues.k[i]! < 50);
  }

  const bbMiddle = bollingerMiddle(closes, config.indicators.bb.length);
  for (let i = 0; i < candles.length; i++) {
    statesByKey.bb[i] = stateFromPair(bbMiddle[i] !== null && closes[i] > bbMiddle[i]!, bbMiddle[i] !== null && closes[i] < bbMiddle[i]!);
  }

  const emaFast = ema(closes, config.indicators.ema.fastLength);
  const emaSlow = ema(closes, config.indicators.ema.slowLength);
  for (let i = 0; i < candles.length; i++) {
    statesByKey.ema[i] = stateFromPair(emaFast[i] !== null && emaSlow[i] !== null && emaFast[i]! > emaSlow[i]!, emaFast[i] !== null && emaSlow[i] !== null && emaFast[i]! < emaSlow[i]!);
  }

  const aoFast = sma(hl2, 5);
  const aoSlow = sma(hl2, 34);
  for (let i = 0; i < candles.length; i++) {
    const ao = aoFast[i] !== null && aoSlow[i] !== null ? aoFast[i]! - aoSlow[i]! : null;
    statesByKey.ao[i] = stateFromPair(ao !== null && ao > 0, ao !== null && ao < 0);
  }

  const sarValues = parabolicSar(candles, config.indicators.sar.start, config.indicators.sar.increment, config.indicators.sar.max);
  for (let i = 0; i < candles.length; i++) {
    statesByKey.sar[i] = stateFromPair(sarValues[i] !== null && closes[i] > sarValues[i]!, sarValues[i] !== null && closes[i] < sarValues[i]!);
  }

  const cciValues = cci(closes, config.indicators.cci.length);
  for (let i = 0; i < candles.length; i++) {
    statesByKey.cci[i] = stateFromPair(cciValues[i] !== null && cciValues[i]! > config.indicators.cci.longLevel, cciValues[i] !== null && cciValues[i]! < config.indicators.cci.shortLevel);
  }

  const dmiValues = dmi(candles, config.indicators.adx.diLength, config.indicators.adx.adxLength);
  for (let i = 0; i < candles.length; i++) {
    const adxOk = dmiValues.adx[i] !== null && dmiValues.adx[i]! > config.indicators.adx.threshold;
    statesByKey.adx[i] = stateFromPair(
      adxOk && dmiValues.plusDI[i] !== null && dmiValues.minusDI[i] !== null && dmiValues.plusDI[i]! > dmiValues.minusDI[i]!,
      adxOk && dmiValues.plusDI[i] !== null && dmiValues.minusDI[i] !== null && dmiValues.minusDI[i]! > dmiValues.plusDI[i]!
    );
  }

  return {
    atr: atr(candles, config.risk.atrLength),
    statesByKey,
  };
}

export function evaluateCompositeSignal(
  states: PartialSignalForgeStates,
  enabledKeys: SignalForgeIndicatorKey[],
  requireAll: boolean
): SignalForgeCompositeSignal {
  if (enabledKeys.length === 0) return { long: false, short: false };
  if (requireAll) {
    return {
      long: enabledKeys.every((key) => states[key] === "Bullish"),
      short: enabledKeys.every((key) => states[key] === "Bearish"),
    };
  }
  return {
    long: enabledKeys.some((key) => states[key] === "Bullish"),
    short: enabledKeys.some((key) => states[key] === "Bearish"),
  };
}

function signalToSide(signal: SignalForgeCompositeSignal): SignalForgeSide | null {
  if (signal.long && !signal.short) return "long";
  if (signal.short && !signal.long) return "short";
  return null;
}

function isWinningPnl(pnlPct: number): boolean {
  return pnlPct > 0;
}

function pnlFor(side: SignalForgeSide, entry: number, exit: number): number {
  return side === "long" ? ((exit - entry) / entry) * 100 : ((entry - exit) / entry) * 100;
}

function closeTrade(trade: MutableTrade, candle: SignalForgeKline, index: number, exitPrice: number, reason: SignalForgeTrade["exitReason"]) {
  trade.exitIndex = index;
  trade.exitTime = candle.time;
  trade.exitPrice = exitPrice;
  trade.exitReason = reason;
  trade.pnlPct = pnlFor(trade.side, trade.entryPrice, exitPrice);
}

function openTrade(
  id: number,
  side: SignalForgeSide,
  candle: SignalForgeKline,
  index: number,
  currentAtr: number | null,
  config: SignalForgeConfig
): MutableTrade {
  const entryPrice = candle.close;
  const tpPrice =
    config.risk.enableTp && currentAtr !== null
      ? side === "long"
        ? entryPrice + currentAtr * config.risk.tpMultiplier
        : entryPrice - currentAtr * config.risk.tpMultiplier
      : null;
  const slPrice =
    config.risk.enableSl && currentAtr !== null
      ? side === "long"
        ? entryPrice - currentAtr * config.risk.slMultiplier
        : entryPrice + currentAtr * config.risk.slMultiplier
      : null;
  const trailingStop =
    config.risk.enableTs && currentAtr !== null
      ? side === "long"
        ? entryPrice - currentAtr * config.risk.tsMultiplier
        : entryPrice + currentAtr * config.risk.tsMultiplier
      : null;

  return {
    id,
    side,
    entryIndex: index,
    entryTime: candle.time,
    entryPrice,
    exitIndex: null,
    exitTime: null,
    exitPrice: null,
    exitReason: null,
    pnlPct: null,
    tpPrice,
    slPrice,
    trailingStop,
    highestSinceEntry: candle.high,
    lowestSinceEntry: candle.low,
  };
}

function checkRiskExit(
  trade: MutableTrade,
  candle: SignalForgeKline,
  index: number,
  currentAtr: number | null,
  config: SignalForgeConfig
): void {
  if (trade.exitIndex !== null) return;

  trade.highestSinceEntry = Math.max(trade.highestSinceEntry, candle.high);
  trade.lowestSinceEntry = Math.min(trade.lowestSinceEntry, candle.low);

  // Check this bar's high/low against the stop computed as of the PREVIOUS
  // bar's close (trade.trailingStop / trade.slPrice already hold that value)
  // — using a trailing level derived from THIS bar's own close would let the
  // bar's own price action set the level it's then tested against
  // (intrabar lookahead, Codex-caught P1).
  const protectiveStops = [trade.slPrice, trade.trailingStop].filter((v): v is number => v !== null);
  const stopPrice = protectiveStops.length === 0 ? null : trade.side === "long" ? Math.max(...protectiveStops) : Math.min(...protectiveStops);

  if (trade.side === "long") {
    if (stopPrice !== null && candle.low <= stopPrice) {
      closeTrade(trade, candle, index, stopPrice, trade.trailingStop !== null && stopPrice === trade.trailingStop ? "trailingStop" : "stopLoss");
      return;
    }
    if (trade.tpPrice !== null && candle.high >= trade.tpPrice) closeTrade(trade, candle, index, trade.tpPrice, "takeProfit");
  } else {
    if (stopPrice !== null && candle.high >= stopPrice) {
      closeTrade(trade, candle, index, stopPrice, trade.trailingStop !== null && stopPrice === trade.trailingStop ? "trailingStop" : "stopLoss");
      return;
    }
    if (trade.tpPrice !== null && candle.low <= trade.tpPrice) closeTrade(trade, candle, index, trade.tpPrice, "takeProfit");
  }

  // Update the trailing stop AFTER this bar's exit check, using this bar's
  // close — takes effect starting next bar, not this one.
  if (trade.exitIndex === null && config.risk.enableTs && currentAtr !== null) {
    const nextTrailing =
      trade.side === "long"
        ? candle.close - currentAtr * config.risk.tsMultiplier
        : candle.close + currentAtr * config.risk.tsMultiplier;
    if (trade.trailingStop === null) trade.trailingStop = nextTrailing;
    else trade.trailingStop = trade.side === "long" ? Math.max(trade.trailingStop, nextTrailing) : Math.min(trade.trailingStop, nextTrailing);
  }
}

function statsFromTrades(trades: SignalForgeTrade[]): SignalForgeStats {
  const closed = trades.filter((trade) => trade.pnlPct !== null);
  const grossProfitPct = closed.filter((trade) => trade.pnlPct! > 0).reduce((sum, trade) => sum + trade.pnlPct!, 0);
  const grossLossPct = closed.filter((trade) => trade.pnlPct! < 0).reduce((sum, trade) => sum + trade.pnlPct!, 0);
  const wins = closed.filter((trade) => isWinningPnl(trade.pnlPct!)).length;
  const losses = closed.length - wins;
  const totalTrades = closed.length;
  return {
    totalTrades,
    wins,
    losses,
    winRate: totalTrades > 0 ? (wins / totalTrades) * 100 : 0,
    profitFactor: grossLossPct < 0 ? grossProfitPct / Math.abs(grossLossPct) : grossProfitPct > 0 ? null : 0,
    netPnlPct: grossProfitPct + grossLossPct,
    grossProfitPct,
    grossLossPct,
  };
}

function publicTrade(trade: MutableTrade): SignalForgeTrade {
  return {
    id: trade.id,
    side: trade.side,
    entryIndex: trade.entryIndex,
    entryTime: trade.entryTime,
    entryPrice: trade.entryPrice,
    exitIndex: trade.exitIndex,
    exitTime: trade.exitTime,
    exitPrice: trade.exitPrice,
    exitReason: trade.exitReason,
    pnlPct: trade.pnlPct,
    tpPrice: trade.tpPrice,
    slPrice: trade.slPrice,
    trailingStop: trade.trailingStop,
  };
}

function simulateSignals(
  candles: SignalForgeKline[],
  atrValues: (number | null)[],
  sides: (SignalForgeSide | null)[],
  config: SignalForgeConfig
) {
  const trades: SignalForgeTrade[] = [];
  const markers: SignalForgeMarker[] = [];
  let active: MutableTrade | null = null;
  let nextId = 1;
  let prevSide: SignalForgeSide | null = null;

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    const currentSide = sides[i];
    const currentAtr = atrValues[i];

    if (active) {
      checkRiskExit(active, candle, i, currentAtr, config);
      if (active.exitIndex !== null) {
        trades.push(publicTrade(active));
        active = null;
      }
    }

    if (active && currentSide !== null && currentSide !== active.side && currentSide !== prevSide) {
      closeTrade(active, candle, i, candle.close, "oppositeSignal");
      trades.push(publicTrade(active));
      active = null;
    }

    if (!active && currentSide !== null && currentSide !== prevSide) {
      active = openTrade(nextId++, currentSide, candle, i, currentAtr, config);
      markers.push({ time: candle.time, price: candle.close, side: currentSide });
    }

    prevSide = currentSide;
  }

  return { trades, activeTrade: active ? publicTrade(active) : null, markers };
}

function indicatorSides(states: SignalForgeState[]): (SignalForgeSide | null)[] {
  return states.map((state) => {
    if (state === "Bullish") return "long";
    if (state === "Bearish") return "short";
    return null;
  });
}

export function runSignalForge(candles: SignalForgeKline[], config: SignalForgeConfig = DEFAULT_SIGNAL_FORGE_CONFIG): SignalForgeResult {
  const safeCandles = candles.filter((candle) => Number.isFinite(candle.open) && Number.isFinite(candle.high) && Number.isFinite(candle.low) && Number.isFinite(candle.close));
  const enabledKeys = enabledIndicatorKeys(config);
  const series = calculateSeries(safeCandles, config);
  const compositeSides: (SignalForgeSide | null)[] = [];

  const bars: SignalForgeBarResult[] = safeCandles.map((candle, index) => {
    const states = emptyStates();
    for (const key of SIGNAL_FORGE_INDICATOR_KEYS) states[key] = series.statesByKey[key][index];
    const composite = evaluateCompositeSignal(states, enabledKeys, config.logic.requireAll);
    const compositeSide = signalToSide(composite);
    compositeSides.push(compositeSide);
    return {
      index,
      time: candle.time,
      close: candle.close,
      states,
      composite,
      compositeSide,
      atr: series.atr[index],
    };
  });

  const composite = simulateSignals(safeCandles, series.atr, compositeSides, config);
  const latestStates = bars[bars.length - 1]?.states ?? emptyStates();

  const indicatorSummaries = SIGNAL_FORGE_INDICATOR_KEYS.map((key) => {
    const indicator = simulateSignals(safeCandles, series.atr, indicatorSides(series.statesByKey[key]), config);
    const stats = statsFromTrades(indicator.trades);
    return {
      key,
      label: SIGNAL_FORGE_INDICATOR_LABELS[key],
      enabled: config.indicators[key].enabled,
      state: latestStates[key],
      ...stats,
    };
  });

  return {
    bars,
    enabledIndicatorKeys: enabledKeys,
    latestStates,
    indicatorSummaries,
    compositeStats: statsFromTrades(composite.trades),
    compositeTrades: composite.trades,
    activeCompositeTrade: composite.activeTrade,
    activeRisk: composite.activeTrade
      ? {
          entryPrice: composite.activeTrade.entryPrice,
          side: composite.activeTrade.side,
          tpPrice: composite.activeTrade.tpPrice,
          slPrice: composite.activeTrade.slPrice,
          trailingStop: composite.activeTrade.trailingStop,
        }
      : null,
    markers: composite.markers.map((marker) => ({ ...marker, price: fixedNumber(marker.price) })),
  };
}
