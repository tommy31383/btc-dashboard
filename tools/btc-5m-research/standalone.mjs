const FIVE_MINUTES_MS = 5 * 60_000;

function freezeConfig(config) {
  return Object.freeze({ maxHoldBars: 48, ...config });
}

export const STANDALONE_CONFIGS = Object.freeze([
  ...[6, 12].flatMap((lookbackBars) => [[1.5, 1], [2, 1]].map(([tpAtr, slAtr]) =>
    freezeConfig({
      id: `LS_L${lookbackBars}_T${String(tpAtr).replace(".", "")}_S${String(slAtr).replace(".", "")}`,
      family: "LIQUIDITY_SWEEP_RECLAIM",
      lookbackBars,
      tpAtr,
      slAtr,
    }))),
  ...[6, 12].flatMap((compressionBars) => [0.2, 0.3].map((rangePercentile) =>
    freezeConfig({
      id: `CE_C${compressionBars}_P${Math.round(rangePercentile * 10)}`,
      family: "COMPRESSION_EXPANSION",
      compressionBars,
      rangePercentile,
      compressionLookbackBars: 288,
      tpAtr: 2,
      slAtr: 1,
    }))),
  ...[1.5, 2].flatMap((impulseAtr) => [3, 6].map((pullbackBars) =>
    freezeConfig({
      id: `IP_I${String(impulseAtr).replace(".", "")}_P${pullbackBars}`,
      family: "IMPULSE_PULLBACK_CONTINUATION",
      impulseAtr,
      pullbackBars,
      tpAtr: 2,
      slAtr: 1,
    }))),
]);

export function resampleCompleteBars(bars, intervalMs) {
  if (
    !Array.isArray(bars) ||
    !bars.length ||
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < FIVE_MINUTES_MS ||
    intervalMs % FIVE_MINUTES_MS !== 0
  ) {
    throw new Error("RESAMPLE_INPUT_INVALID");
  }
  const expected = intervalMs / FIVE_MINUTES_MS;
  const groups = new Map();
  for (const row of bars) {
    const bucket = Math.floor(row.time / intervalMs) * intervalMs;
    const group = groups.get(bucket) ?? [];
    group.push(row);
    groups.set(bucket, group);
  }
  const output = [];
  for (const [time, group] of [...groups.entries()].sort(([left], [right]) => left - right)) {
    if (
      group.length !== expected ||
      group[0].time !== time ||
      group.at(-1).time !== time + intervalMs - FIVE_MINUTES_MS
    ) continue;
    output.push(Object.freeze({
      time,
      closeTime: time + intervalMs,
      open: group[0].open,
      high: Math.max(...group.map((row) => row.high)),
      low: Math.min(...group.map((row) => row.low)),
      close: group.at(-1).close,
      volume: group.reduce((total, row) => total + row.volume, 0),
    }));
  }
  return Object.freeze(output);
}

function emaSeries(values, period) {
  const output = new Array(values.length).fill(null);
  if (!values.length) return output;
  const alpha = 2 / (period + 1);
  let ema = values[0];
  output[0] = ema;
  for (let index = 1; index < values.length; index += 1) {
    ema = alpha * values[index] + (1 - alpha) * ema;
    output[index] = ema;
  }
  return output;
}

export function buildBiasSeries(bars) {
  const hourly = resampleCompleteBars(bars, 60 * 60_000);
  const fourHourly = resampleCompleteBars(bars, 4 * 60 * 60_000);
  const hourlyCloses = hourly.map((row) => row.close);
  const fourHourlyCloses = fourHourly.map((row) => row.close);
  const ema50 = emaSeries(hourlyCloses, 50);
  const ema200 = emaSeries(hourlyCloses, 200);
  const ema20Four = emaSeries(fourHourlyCloses, 20);
  const output = new Array(bars.length).fill(null);
  let hourIndex = -1;
  let fourHourIndex = -1;
  for (let index = 0; index < bars.length; index += 1) {
    const decisionTime = bars[index].time + FIVE_MINUTES_MS;
    while (hourIndex + 1 < hourly.length && hourly[hourIndex + 1].closeTime <= decisionTime) {
      hourIndex += 1;
    }
    while (
      fourHourIndex + 1 < fourHourly.length &&
      fourHourly[fourHourIndex + 1].closeTime <= decisionTime
    ) {
      fourHourIndex += 1;
    }
    if (hourIndex < 199 || fourHourIndex < 20) continue;
    const hourDirection = ema50[hourIndex] > ema200[hourIndex]
      ? "LONG"
      : ema50[hourIndex] < ema200[hourIndex] ? "SHORT" : null;
    const fourDirection = ema20Four[fourHourIndex] > ema20Four[fourHourIndex - 1]
      ? "LONG"
      : ema20Four[fourHourIndex] < ema20Four[fourHourIndex - 1] ? "SHORT" : null;
    if (hourDirection === fourDirection) output[index] = hourDirection;
  }
  return output;
}

export function atrSeries(bars, period = 14) {
  const output = new Array(bars.length).fill(null);
  const tr = new Array(bars.length).fill(null);
  for (let index = 1; index < bars.length; index += 1) {
    tr[index] = Math.max(
      bars[index].high - bars[index].low,
      Math.abs(bars[index].high - bars[index - 1].close),
      Math.abs(bars[index].low - bars[index - 1].close),
    );
  }
  let sum = 0;
  for (let index = 1; index < bars.length; index += 1) {
    sum += tr[index];
    if (index > period) sum -= tr[index - period];
    if (index >= period) output[index] = sum / period;
  }
  return output;
}

function lowerBound(sorted, value) {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sorted[middle] < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function compressionFlags(bars, compressionBars, percentile, lookback = 288) {
  const widths = new Array(bars.length).fill(null);
  for (let index = compressionBars - 1; index < bars.length; index += 1) {
    const window = bars.slice(index - compressionBars + 1, index + 1);
    widths[index] = (
      Math.max(...window.map((bar) => bar.high)) - Math.min(...window.map((bar) => bar.low))
    ) / bars[index].close;
  }
  const output = new Array(bars.length).fill(false);
  const first = compressionBars - 1 + lookback;
  if (first >= bars.length) return output;
  const sorted = widths.slice(first - lookback, first).sort((left, right) => left - right);
  for (let index = first; index < bars.length; index += 1) {
    const threshold = sorted[Math.floor((lookback - 1) * percentile)];
    output[index] = widths[index] <= threshold;
    const removeValue = widths[index - lookback];
    const removeIndex = lowerBound(sorted, removeValue);
    sorted.splice(removeIndex, 1);
    sorted.splice(lowerBound(sorted, widths[index]), 0, widths[index]);
  }
  return output;
}

export function liquiditySweepSignal(bars, index, lookbackBars, bias) {
  if (
    !Array.isArray(bars) ||
    !Number.isSafeInteger(index) ||
    !Number.isSafeInteger(lookbackBars) ||
    index < lookbackBars ||
    !["LONG", "SHORT"].includes(bias)
  ) {
    throw new Error("SWEEP_SIGNAL_INPUT_INVALID");
  }
  const row = bars[index];
  const prior = bars.slice(index - lookbackBars, index);
  const body = Math.abs(row.close - row.open);
  if (bias === "LONG") {
    const priorLow = Math.min(...prior.map((bar) => bar.low));
    const lowerWick = Math.min(row.open, row.close) - row.low;
    return row.low < priorLow && row.close > priorLow && lowerWick >= body ? "LONG" : null;
  }
  const priorHigh = Math.max(...prior.map((bar) => bar.high));
  const upperWick = row.high - Math.max(row.open, row.close);
  return row.high > priorHigh && row.close < priorHigh && upperWick >= body ? "SHORT" : null;
}

export function compressionExpansionSignal(
  bars,
  index,
  compressionBars,
  compressed,
  bias,
) {
  if (
    !Array.isArray(bars) ||
    !Number.isSafeInteger(index) ||
    !Number.isSafeInteger(compressionBars) ||
    index < compressionBars ||
    typeof compressed !== "boolean" ||
    !["LONG", "SHORT"].includes(bias)
  ) {
    throw new Error("COMPRESSION_SIGNAL_INPUT_INVALID");
  }
  if (!compressed) return null;
  const prior = bars.slice(index - compressionBars, index);
  if (bias === "LONG") {
    return bars[index].close > Math.max(...prior.map((bar) => bar.high)) ? "LONG" : null;
  }
  return bars[index].close < Math.min(...prior.map((bar) => bar.low)) ? "SHORT" : null;
}

export function impulsePullbackSignal(
  bars,
  index,
  pullbackBars,
  impulseAtr,
  atrByIndex,
  bias,
) {
  if (
    !Array.isArray(bars) ||
    !Array.isArray(atrByIndex) ||
    !Number.isSafeInteger(index) ||
    !Number.isSafeInteger(pullbackBars) ||
    index < pullbackBars ||
    !Number.isFinite(impulseAtr) ||
    impulseAtr <= 0 ||
    !["LONG", "SHORT"].includes(bias)
  ) {
    throw new Error("IMPULSE_SIGNAL_INPUT_INVALID");
  }
  const impulseIndex = index - pullbackBars;
  const impulse = bars[impulseIndex];
  const atr = atrByIndex[impulseIndex];
  if (!Number.isFinite(atr) || atr <= 0) return null;
  const body = impulse.close - impulse.open;
  const midpoint = (impulse.open + impulse.close) / 2;
  const pullback = bars.slice(impulseIndex + 1, index + 1);
  const beforeTrigger = bars.slice(impulseIndex + 1, index);
  if (bias === "LONG") {
    const protectedMidpoint = pullback.every((bar) => bar.low >= midpoint);
    const breakout = beforeTrigger.length > 0 && bars[index].close > Math.max(...beforeTrigger.map((bar) => bar.high));
    return body >= impulseAtr * atr && protectedMidpoint && breakout ? "LONG" : null;
  }
  const protectedMidpoint = pullback.every((bar) => bar.high <= midpoint);
  const breakout = beforeTrigger.length > 0 && bars[index].close < Math.min(...beforeTrigger.map((bar) => bar.low));
  return -body >= impulseAtr * atr && protectedMidpoint && breakout ? "SHORT" : null;
}

function exitFill(raw, side, slippageRate) {
  return side === "LONG" ? raw * (1 - slippageRate) : raw * (1 + slippageRate);
}

export function simulateStandaloneTrade({
  bars,
  entryIndex,
  side,
  atr,
  tpAtr,
  slAtr,
  maxHoldBars,
  feeBps,
  slippageBps,
  intrabarOrder,
  funding,
}) {
  if (
    !Array.isArray(bars) ||
    !Number.isSafeInteger(entryIndex) ||
    entryIndex < 0 ||
    !["LONG", "SHORT"].includes(side) ||
    ![atr, tpAtr, slAtr, feeBps, slippageBps].every(Number.isFinite) ||
    atr <= 0 ||
    tpAtr <= 0 ||
    slAtr <= 0 ||
    !Number.isSafeInteger(maxHoldBars) ||
    maxHoldBars < 1 ||
    !["ADVERSE_FIRST", "FAVORABLE_FIRST"].includes(intrabarOrder) ||
    !Array.isArray(funding)
  ) {
    throw new Error("STANDALONE_TRADE_INPUT_INVALID");
  }
  const slippageRate = slippageBps / 10_000;
  const feeRate = feeBps / 10_000;
  const rawEntry = bars[entryIndex]?.open;
  if (!Number.isFinite(rawEntry)) throw new Error("STANDALONE_ENTRY_MISSING");
  const entryPrice = side === "LONG"
    ? rawEntry * (1 + slippageRate)
    : rawEntry * (1 - slippageRate);
  const tp = side === "LONG" ? entryPrice + tpAtr * atr : entryPrice - tpAtr * atr;
  const sl = side === "LONG" ? entryPrice - slAtr * atr : entryPrice + slAtr * atr;
  let exitTime = null;
  let rawExit = null;
  let exitReason = null;
  let maxPrice = entryPrice;
  let minPrice = entryPrice;
  const lastIndex = Math.min(bars.length - 1, entryIndex + maxHoldBars - 1);
  for (let index = entryIndex; index <= lastIndex; index += 1) {
    const row = bars[index];
    maxPrice = Math.max(maxPrice, row.high);
    minPrice = Math.min(minPrice, row.low);
    if (side === "LONG" && row.open <= sl) {
      rawExit = row.open; exitReason = "SL_GAP";
    } else if (side === "LONG" && row.open >= tp) {
      rawExit = row.open; exitReason = "TP_GAP";
    } else if (side === "SHORT" && row.open >= sl) {
      rawExit = row.open; exitReason = "SL_GAP";
    } else if (side === "SHORT" && row.open <= tp) {
      rawExit = row.open; exitReason = "TP_GAP";
    } else {
      const adverseFirst = intrabarOrder === "ADVERSE_FIRST";
      const events = side === "LONG"
        ? (adverseFirst ? [[row.low, "SL", sl], [row.high, "TP", tp]] : [[row.high, "TP", tp], [row.low, "SL", sl]])
        : (adverseFirst ? [[row.high, "SL", sl], [row.low, "TP", tp]] : [[row.low, "TP", tp], [row.high, "SL", sl]]);
      for (const [price, reason, level] of events) {
        const hit = reason === "SL"
          ? (side === "LONG" ? price <= level : price >= level)
          : (side === "LONG" ? price >= level : price <= level);
        if (hit) {
          rawExit = level;
          exitReason = reason;
          break;
        }
      }
    }
    if (exitReason) {
      exitTime = row.time;
      break;
    }
  }
  if (!exitReason) {
    const row = bars[lastIndex];
    rawExit = row.close;
    exitTime = row.time + FIVE_MINUTES_MS;
    exitReason = "TIME";
  }
  const exitPrice = exitFill(rawExit, side, slippageRate);
  const grossReturn = side === "LONG"
    ? exitPrice / entryPrice - 1
    : entryPrice / exitPrice - 1;
  const fundingReturn = funding.reduce((total, record) => {
    if (record.time < bars[entryIndex].time || record.time > exitTime) return total;
    const signed = side === "LONG" ? -record.rate : record.rate;
    const markScale = Number.isFinite(record.mark) && record.mark > 0 ? record.mark / entryPrice : 1;
    return total + signed * markScale;
  }, 0);
  const fees = feeRate * (1 + exitPrice / entryPrice);
  return Object.freeze({
    side,
    entryTime: bars[entryIndex].time,
    entryPrice,
    exitTime,
    exitPrice,
    exitReason,
    grossReturn,
    fundingReturn,
    fees,
    netReturn: grossReturn + fundingReturn - fees,
    mfeAtr: side === "LONG" ? (maxPrice - entryPrice) / atr : (entryPrice - minPrice) / atr,
    maeAtr: side === "LONG" ? (entryPrice - minPrice) / atr : (maxPrice - entryPrice) / atr,
  });
}

function fundingSlice(funding, start, end) {
  let low = 0;
  let high = funding.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (funding[middle].time < start) low = middle + 1;
    else high = middle;
  }
  const output = [];
  for (let index = low; index < funding.length && funding[index].time <= end; index += 1) {
    output.push(funding[index]);
  }
  return output;
}

export function runStandaloneConfig({
  bars,
  funding,
  config,
  scenario,
  biasByIndex = buildBiasSeries(bars),
  atrByIndex = atrSeries(bars, 14),
  compressionByIndex = null,
}) {
  if (
    !Array.isArray(bars) ||
    !Array.isArray(funding) ||
    !config?.id ||
    !config?.family ||
    !scenario ||
    !Array.isArray(biasByIndex) ||
    !Array.isArray(atrByIndex)
  ) {
    throw new Error("STANDALONE_CONFIG_INPUT_INVALID");
  }
  const compressed = config.family === "COMPRESSION_EXPANSION"
    ? (compressionByIndex ?? compressionFlags(
      bars,
      config.compressionBars,
      config.rangePercentile,
      config.compressionLookbackBars,
    ))
    : null;
  const trades = [];
  const firstTime = bars[0].time;
  for (let index = 1; index < bars.length - 1; index += 1) {
    const bias = biasByIndex[index];
    const atr = atrByIndex[index];
    if (!["LONG", "SHORT"].includes(bias) || !Number.isFinite(atr) || atr <= 0) continue;
    let side = null;
    if (config.family === "LIQUIDITY_SWEEP_RECLAIM") {
      if (index < config.lookbackBars) continue;
      side = liquiditySweepSignal(bars, index, config.lookbackBars, bias);
    } else if (config.family === "COMPRESSION_EXPANSION") {
      if (index < config.compressionBars || index < 1) continue;
      side = compressionExpansionSignal(
        bars,
        index,
        config.compressionBars,
        compressed[index - 1],
        bias,
      );
    } else if (config.family === "IMPULSE_PULLBACK_CONTINUATION") {
      if (index < config.pullbackBars) continue;
      side = impulsePullbackSignal(
        bars,
        index,
        config.pullbackBars,
        config.impulseAtr,
        atrByIndex,
        bias,
      );
    } else {
      throw new Error(`STANDALONE_FAMILY_INVALID:${config.family}`);
    }
    if (!side) continue;
    const entryIndex = index + 1;
    const fundingWindow = fundingSlice(
      funding,
      bars[entryIndex].time,
      bars[entryIndex].time + config.maxHoldBars * FIVE_MINUTES_MS,
    );
    const trade = simulateStandaloneTrade({
      bars,
      entryIndex,
      side,
      atr,
      tpAtr: config.tpAtr,
      slAtr: config.slAtr,
      maxHoldBars: config.maxHoldBars,
      feeBps: scenario.feeBps,
      slippageBps: scenario.slippageBps,
      intrabarOrder: scenario.intrabarOrder,
      funding: fundingWindow,
    });
    trades.push(Object.freeze({
      configId: config.id,
      family: config.family,
      signalTime: bars[entryIndex].time,
      year: new Date(bars[entryIndex].time).getUTCFullYear(),
      ...trade,
    }));
    const exitIndex = Math.floor((trade.exitTime - firstTime) / FIVE_MINUTES_MS);
    index = Math.max(index, Math.min(exitIndex, bars.length - 2));
  }
  return Object.freeze(trades);
}
