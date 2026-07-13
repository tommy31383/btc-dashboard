import { causalEma } from "./h01-timing.mjs";

export function causalAtr(bars, signalIndex, period = 14) {
  if (
    !Array.isArray(bars) ||
    !Number.isSafeInteger(signalIndex) ||
    !Number.isSafeInteger(period) ||
    period < 2 ||
    signalIndex <= period ||
    signalIndex > bars.length
  ) {
    throw new Error("ATR_INPUT_INVALID");
  }
  const values = [];
  for (let index = signalIndex - period; index < signalIndex; index += 1) {
    const row = bars[index];
    const previousClose = bars[index - 1]?.close;
    if (
      !row ||
      !Number.isFinite(previousClose) ||
      ![row.high, row.low, row.close].every(Number.isFinite)
    ) {
      throw new Error(`ATR_BAR_INVALID:${index}`);
    }
    values.push(Math.max(
      row.high - row.low,
      Math.abs(row.high - previousClose),
      Math.abs(row.low - previousClose),
    ));
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function classifyToxicity(
  bars,
  signalIndex,
  {
    observationBars = 3,
    atrPeriod = 14,
    emaPeriod = 20,
    volumePeriod = 20,
    lossAtrThreshold = -0.5,
    relativeVolumeThreshold = 1.5,
  } = {},
) {
  if (
    !Array.isArray(bars) ||
    signalIndex < Math.max(atrPeriod + 1, volumePeriod) ||
    signalIndex + observationBars >= bars.length
  ) {
    throw new Error("TOXICITY_WINDOW_INVALID");
  }
  const atr = causalAtr(bars, signalIndex, atrPeriod);
  const observed = bars.slice(signalIndex, signalIndex + observationBars);
  const entry = bars[signalIndex].open;
  const finalIndex = signalIndex + observationBars - 1;
  const finalClose = bars[finalIndex].close;
  const closes = bars.map((row) => row.close);
  const ema = causalEma(closes, emaPeriod, finalIndex);
  const priorVolume = bars
    .slice(signalIndex - volumePeriod, signalIndex)
    .reduce((total, row) => total + row.volume, 0) / volumePeriod;
  const observedVolume = observed.reduce((total, row) => total + row.volume, 0) / observationBars;
  const relativeVolume = priorVolume > 0 ? observedVolume / priorVolume : Infinity;
  const lossAtr = (finalClose - entry) / atr;
  const skip =
    lossAtr <= lossAtrThreshold &&
    finalClose < ema &&
    relativeVolume >= relativeVolumeThreshold;
  return Object.freeze({
    skip,
    fillIndex: signalIndex + observationBars,
    atr,
    ema,
    lossAtr,
    relativeVolume,
  });
}
