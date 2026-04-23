// RSI — Wilder's smoothing
export function calcRSI(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gains = 0,
    losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

// EMA
export function calcEMA(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

// MACD — O(n) incremental EMA (was O(n³) before)
export function calcMACD(
  closes: number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9
): { macd: number | null; signal: number | null; histogram: number | null } {
  if (closes.length < slow + signalPeriod)
    return { macd: null, signal: null, histogram: null };

  const kFast = 2 / (fast + 1);
  const kSlow = 2 / (slow + 1);
  // Seed with SMA for the first `fast`/`slow` bars
  let sumFast = 0;
  for (let i = 0; i < fast; i++) sumFast += closes[i];
  let emaFast = sumFast / fast;

  let sumSlow = 0;
  for (let i = 0; i < slow; i++) sumSlow += closes[i];
  let emaSlow = sumSlow / slow;

  // Walk through once and collect MACD line values (from index slow-1 onward)
  const macdLine: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i >= fast) emaFast = closes[i] * kFast + emaFast * (1 - kFast);
    if (i >= slow) emaSlow = closes[i] * kSlow + emaSlow * (1 - kSlow);
    if (i >= slow - 1) macdLine.push(emaFast - emaSlow);
  }

  if (macdLine.length < signalPeriod)
    return {
      macd: macdLine[macdLine.length - 1] ?? null,
      signal: null,
      histogram: null,
    };

  const kSig = 2 / (signalPeriod + 1);
  let seedSig = 0;
  for (let i = 0; i < signalPeriod; i++) seedSig += macdLine[i];
  let sigEma = seedSig / signalPeriod;
  for (let i = signalPeriod; i < macdLine.length; i++) {
    sigEma = macdLine[i] * kSig + sigEma * (1 - kSig);
  }
  const macdVal = macdLine[macdLine.length - 1];
  return { macd: macdVal, signal: sigEma, histogram: macdVal - sigEma };
}

// Bollinger Bands
export function calcBollinger(
  closes: number[],
  period = 20,
  mult = 2
): { upper: number | null; middle: number | null; lower: number | null; width: number | null } {
  if (closes.length < period)
    return { upper: null, middle: null, lower: null, width: null };
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance =
    slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  const upper = mean + mult * std;
  const lower = mean - mult * std;
  return { upper, middle: mean, lower, width: upper - lower };
}

// RSI Series (for StochRSI and divergence)
export function calcRSISeries(
  closes: number[],
  period = 14
): number[] {
  const rsiValues: number[] = [];
  if (closes.length < period + 1) return rsiValues;

  let gains = 0,
    losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  if (avgLoss === 0) rsiValues.push(100);
  else rsiValues.push(100 - 100 / (1 + avgGain / avgLoss));

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
    if (avgLoss === 0) rsiValues.push(100);
    else rsiValues.push(100 - 100 / (1 + avgGain / avgLoss));
  }
  return rsiValues;
}

// Stochastic RSI
export function calcStochRSI(
  closes: number[],
  rsiPeriod = 14,
  stochPeriod = 14,
  kSmooth = 3,
  dSmooth = 3
): { k: number | null; d: number | null } {
  const rsiSeries = calcRSISeries(closes, rsiPeriod);
  if (rsiSeries.length < stochPeriod)
    return { k: null, d: null };

  // Calculate raw stochastic of RSI
  const rawK: number[] = [];
  for (let i = stochPeriod - 1; i < rsiSeries.length; i++) {
    const window = rsiSeries.slice(i - stochPeriod + 1, i + 1);
    const min = Math.min(...window);
    const max = Math.max(...window);
    rawK.push(max === min ? 50 : ((rsiSeries[i] - min) / (max - min)) * 100);
  }

  // Smooth K with SMA
  if (rawK.length < kSmooth) return { k: null, d: null };
  const smoothedK: number[] = [];
  for (let i = kSmooth - 1; i < rawK.length; i++) {
    const sum = rawK.slice(i - kSmooth + 1, i + 1).reduce((a, b) => a + b, 0);
    smoothedK.push(sum / kSmooth);
  }

  // Smooth D with SMA of K
  if (smoothedK.length < dSmooth) return { k: smoothedK[smoothedK.length - 1], d: null };
  const dValues: number[] = [];
  for (let i = dSmooth - 1; i < smoothedK.length; i++) {
    const sum = smoothedK.slice(i - dSmooth + 1, i + 1).reduce((a, b) => a + b, 0);
    dValues.push(sum / dSmooth);
  }

  return {
    k: smoothedK[smoothedK.length - 1],
    d: dValues[dValues.length - 1],
  };
}

// Volume Analysis
export function calcVolumeAnalysis(
  volumes: number[],
  period = 20
): { current: number; avg: number; isHigh: boolean } | null {
  if (volumes.length < period) return null;
  const current = volumes[volumes.length - 1];
  const avg =
    volumes.slice(-period).reduce((a, b) => a + b, 0) / period;
  return { current, avg, isHigh: current > avg * 1.5 };
}

// EMA Series — returns array aligned to input (null-padded at start)
export function calcEMASeries(
  closes: number[],
  period: number
): (number | null)[] {
  const result: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period) return result;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result[period - 1] = ema;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    result[i] = ema;
  }
  return result;
}

// StochRSI Series — returns { kSeries, dSeries } aligned to closes length (null-padded)
export function calcStochRSISeries(
  closes: number[],
  rsiPeriod = 14,
  stochPeriod = 14,
  kSmooth = 3,
  dSmooth = 3
): { kSeries: (number | null)[]; dSeries: (number | null)[] } {
  const n = closes.length;
  const kSeries: (number | null)[] = new Array(n).fill(null);
  const dSeries: (number | null)[] = new Array(n).fill(null);

  const rsiSeries = calcRSISeries(closes, rsiPeriod);
  if (rsiSeries.length < stochPeriod) return { kSeries, dSeries };

  // rsiSeries[0] corresponds to closes[rsiPeriod]
  const rsiOffset = rsiPeriod;

  // Raw stochastic of RSI
  const rawK: number[] = [];
  for (let i = stochPeriod - 1; i < rsiSeries.length; i++) {
    const window = rsiSeries.slice(i - stochPeriod + 1, i + 1);
    const min = Math.min(...window);
    const max = Math.max(...window);
    rawK.push(max === min ? 50 : ((rsiSeries[i] - min) / (max - min)) * 100);
  }
  const rawKOffset = rsiOffset + stochPeriod - 1;

  // Smooth K with SMA
  if (rawK.length < kSmooth) return { kSeries, dSeries };
  const smoothedK: number[] = [];
  for (let i = kSmooth - 1; i < rawK.length; i++) {
    const sum = rawK.slice(i - kSmooth + 1, i + 1).reduce((a, b) => a + b, 0);
    smoothedK.push(sum / kSmooth);
  }
  const kOffset = rawKOffset + kSmooth - 1;

  // Write K values
  for (let i = 0; i < smoothedK.length; i++) {
    const idx = kOffset + i;
    if (idx < n) kSeries[idx] = smoothedK[i];
  }

  // Smooth D with SMA of K
  if (smoothedK.length < dSmooth) return { kSeries, dSeries };
  const dValues: number[] = [];
  for (let i = dSmooth - 1; i < smoothedK.length; i++) {
    const sum = smoothedK.slice(i - dSmooth + 1, i + 1).reduce((a, b) => a + b, 0);
    dValues.push(sum / dSmooth);
  }
  const dOffset = kOffset + dSmooth - 1;

  for (let i = 0; i < dValues.length; i++) {
    const idx = dOffset + i;
    if (idx < n) dSeries[idx] = dValues[i];
  }

  return { kSeries, dSeries };
}

// RSI Series aligned to closes length (null-padded at start)
export function calcRSISeriesAligned(
  closes: number[],
  period = 14
): (number | null)[] {
  const result: (number | null)[] = new Array(closes.length).fill(null);
  const raw = calcRSISeries(closes, period);
  // raw[0] corresponds to closes[period]
  for (let i = 0; i < raw.length; i++) {
    result[period + i] = raw[i];
  }
  return result;
}

// Bollinger Bands Series (aligned with closes)
export function calcBollingerSeries(
  closes: number[],
  period = 20,
  mult = 2
): { upper: (number | null)[]; middle: (number | null)[]; lower: (number | null)[] } {
  const upper: (number | null)[] = [];
  const middle: (number | null)[] = [];
  const lower: (number | null)[] = [];

  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      upper.push(null);
      middle.push(null);
      lower.push(null);
    } else {
      const slice = closes.slice(i - period + 1, i + 1);
      const mean = slice.reduce((a, b) => a + b, 0) / period;
      const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
      const std = Math.sqrt(variance);
      upper.push(mean + mult * std);
      middle.push(mean);
      lower.push(mean - mult * std);
    }
  }
  return { upper, middle, lower };
}

// MACD Series (aligned with closes)
export function calcMACDSeries(
  closes: number[],
  fast = 12,
  slow = 26,
  signal = 9
): { macdLine: (number | null)[]; signalLine: (number | null)[]; histogram: (number | null)[] } {
  const macdLine: (number | null)[] = new Array(closes.length).fill(null);
  const signalLine: (number | null)[] = new Array(closes.length).fill(null);
  const histogram: (number | null)[] = new Array(closes.length).fill(null);

  if (closes.length < slow) return { macdLine, signalLine, histogram };

  // Calc EMA series for fast and slow
  const kFast = 2 / (fast + 1);
  const kSlow = 2 / (slow + 1);
  const emaFastArr: number[] = [];
  const emaSlowArr: number[] = [];

  let emaFast = closes.slice(0, fast).reduce((a, b) => a + b, 0) / fast;
  let emaSlow = closes.slice(0, slow).reduce((a, b) => a + b, 0) / slow;

  for (let i = 0; i < closes.length; i++) {
    if (i < fast) {
      emaFast = closes.slice(0, i + 1).reduce((a, b) => a + b, 0) / (i + 1);
    } else {
      emaFast = closes[i] * kFast + emaFast * (1 - kFast);
    }
    emaFastArr.push(emaFast);

    if (i < slow) {
      emaSlow = closes.slice(0, i + 1).reduce((a, b) => a + b, 0) / (i + 1);
    } else {
      emaSlow = closes[i] * kSlow + emaSlow * (1 - kSlow);
    }
    emaSlowArr.push(emaSlow);
  }

  const rawMacd: number[] = [];
  for (let i = slow - 1; i < closes.length; i++) {
    const m = emaFastArr[i] - emaSlowArr[i];
    rawMacd.push(m);
    macdLine[i] = m;
  }

  if (rawMacd.length >= signal) {
    const kSig = 2 / (signal + 1);
    let sigEma = rawMacd.slice(0, signal).reduce((a, b) => a + b, 0) / signal;
    for (let i = 0; i < rawMacd.length; i++) {
      if (i < signal) {
        sigEma = rawMacd.slice(0, i + 1).reduce((a, b) => a + b, 0) / (i + 1);
      } else {
        sigEma = rawMacd[i] * kSig + sigEma * (1 - kSig);
      }
      const idx = slow - 1 + i;
      signalLine[idx] = sigEma;
      histogram[idx] = rawMacd[i] - sigEma;
    }
  }

  return { macdLine, signalLine, histogram };
}

// Divergence Detection
export type DivergenceType = "BEARISH_DIV" | "BULLISH_DIV" | null;

export function detectDivergence(
  closes: number[],
  rsiPeriod = 14,
  lookback = 30
): DivergenceType {
  const rsiSeries = calcRSISeries(closes, rsiPeriod);
  if (rsiSeries.length < lookback || closes.length < lookback) return null;

  const priceSlice = closes.slice(-lookback);
  const rsiSlice = rsiSeries.slice(-lookback);

  const half = Math.floor(lookback / 2);
  const firstPrices = priceSlice.slice(0, half);
  const secondPrices = priceSlice.slice(half);
  const firstRSI = rsiSlice.slice(0, half);
  const secondRSI = rsiSlice.slice(half);

  const firstPriceHigh = Math.max(...firstPrices);
  const secondPriceHigh = Math.max(...secondPrices);
  const firstRSIHigh = Math.max(...firstRSI);
  const secondRSIHigh = Math.max(...secondRSI);

  // Bearish: price higher high + RSI lower high
  if (secondPriceHigh > firstPriceHigh && secondRSIHigh < firstRSIHigh) {
    return "BEARISH_DIV";
  }

  const firstPriceLow = Math.min(...firstPrices);
  const secondPriceLow = Math.min(...secondPrices);
  const firstRSILow = Math.min(...firstRSI);
  const secondRSILow = Math.min(...secondRSI);

  // Bullish: price lower low + RSI higher low
  if (secondPriceLow < firstPriceLow && secondRSILow > firstRSILow) {
    return "BULLISH_DIV";
  }

  return null;
}

/**
 * calcATRPct — ATR (Average True Range) đơn vị %, 14 period Wilder smoothing.
 * Lấy ATR / close gần nhất → % volatility.
 *
 * Dùng cho Risk Radar + rule filter atrFilter (lesson learn: 1h ATR<0.3% +
 * HTF FLAT → LONG WR 81%; 15m ATR<0.3% → WR 9.5% → tuyệt đối không LONG 15m
 * volatility thấp).
 */
export function calcATRPct(
  candles: { open: number; high: number; low: number; close: number }[],
  period = 14
): number | null {
  if (candles.length < period + 1) return null;
  // Seed with simple average TR for first `period` bars
  let sum = 0;
  for (let j = 1; j <= period; j++) {
    const c = candles[j], prev = candles[j - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
    sum += tr;
  }
  let atr = sum / period;
  // Wilder smoothing for remaining bars
  for (let j = period + 1; j < candles.length; j++) {
    const c = candles[j], prev = candles[j - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
    atr = (atr * (period - 1) + tr) / period;
  }
  const lastClose = candles[candles.length - 1].close;
  return lastClose > 0 ? (atr / lastClose) * 100 : null;
}

/**
 * detectCandleReversal — phát hiện 2 nến liên tiếp ngược màu.
 *   - UP_REVERSAL: prev candle đỏ (close<open), curr candle xanh (close>open)
 *   - DOWN_REVERSAL: prev xanh, curr đỏ
 *   - null: không phải reversal
 *
 * Dùng cho rule REVERSAL_4H_UP: em scan 6000 nến 4H, thấy LONG mọi UP reversal
 * TP+5%/SL-3% cho NET +1700% (WR 36.1%, N=1588) qua 2.7 năm.
 *
 * @param candles - array of { open, close } — dùng index cuối cùng + cây trước
 */
export function detectCandleReversal(
  candles: { open: number; close: number }[]
): "UP_REVERSAL" | "DOWN_REVERSAL" | null {
  if (candles.length < 2) return null;
  const prev = candles[candles.length - 2];
  const curr = candles[candles.length - 1];
  const prevBull = prev.close >= prev.open;
  const currBull = curr.close >= curr.open;
  if (prevBull === currBull) return null;
  return !prevBull && currBull ? "UP_REVERSAL" : "DOWN_REVERSAL";
}
