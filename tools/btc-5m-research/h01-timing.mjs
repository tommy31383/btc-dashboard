const FIVE_MINUTES_MS = 5 * 60_000;

export const METHODS = Object.freeze({
  A: Object.freeze({ id: "A", family: "IMMEDIATE", timeoutBars: 0 }),
  E30: Object.freeze({ id: "E30", family: "EMA20_RECLAIM_FALLBACK", timeoutBars: 6, emaPeriod: 20 }),
  E60: Object.freeze({ id: "E60", family: "EMA20_RECLAIM_FALLBACK", timeoutBars: 12, emaPeriod: 20 }),
  S6_30: Object.freeze({ id: "S6_30", family: "SWEEP_RECLAIM_FALLBACK", timeoutBars: 6, lookbackBars: 6 }),
  S6_60: Object.freeze({ id: "S6_60", family: "SWEEP_RECLAIM_FALLBACK", timeoutBars: 12, lookbackBars: 6 }),
  S12_30: Object.freeze({ id: "S12_30", family: "SWEEP_RECLAIM_FALLBACK", timeoutBars: 6, lookbackBars: 12 }),
  S12_60: Object.freeze({ id: "S12_60", family: "SWEEP_RECLAIM_FALLBACK", timeoutBars: 12, lookbackBars: 12 }),
});

const PARITY_FIELDS = Object.freeze([
  "fillTime",
  "fillPrice",
  "exitTime",
  "exitPrice",
  "fees",
  "fundingPnl",
  "netPnl",
]);

export function assertBaselineParity(actualRows, expectedRows, scenarios) {
  if (
    !Array.isArray(actualRows) ||
    !Array.isArray(expectedRows) ||
    actualRows.length !== expectedRows.length ||
    !Array.isArray(scenarios)
  ) {
    throw new Error("BASELINE_PARITY_INPUT_INVALID");
  }
  const expectedByKey = new Map(
    expectedRows.map((row) => [`${row.setup}|${row.signalTime}`, row]),
  );
  for (const row of actualRows) {
    const key = `${row.setup}|${row.signalTime}`;
    const expected = expectedByKey.get(key);
    if (!expected) throw new Error(`BASELINE_PARITY_MISSING:${key}`);
    for (const scenario of scenarios) {
      const left = row.scenarios?.[scenario]?.A;
      const right = expected.scenarios?.[scenario]?.methods?.A?.children?.[0];
      for (const field of PARITY_FIELDS) {
        const a = left?.[field];
        const b = right?.[field];
        const equal = Number.isFinite(a) && Number.isFinite(b)
          ? Math.abs(a - b) <= 1e-9
          : a === b;
        if (!equal) {
          throw new Error(`BASELINE_PARITY_MISMATCH:${key}:${scenario}:${field}:${a}:${b}`);
        }
      }
    }
  }
  return true;
}

function assertWindow(bars, signalIndex, timeoutBars) {
  if (
    !Array.isArray(bars) ||
    !Number.isSafeInteger(signalIndex) ||
    signalIndex < 0 ||
    !Number.isSafeInteger(timeoutBars) ||
    timeoutBars < 1 ||
    signalIndex + timeoutBars >= bars.length
  ) {
    throw new Error("TIMING_WINDOW_INVALID");
  }
  for (let index = Math.max(0, signalIndex - 1); index <= signalIndex + timeoutBars; index += 1) {
    const row = bars[index];
    if (
      !Number.isSafeInteger(row?.time) ||
      ![row.open, row.high, row.low, row.close, row.volume].every(Number.isFinite) ||
      (index > 0 && bars[index - 1] && row.time !== bars[index - 1].time + FIVE_MINUTES_MS)
    ) {
      throw new Error(`TIMING_BAR_INVALID:${index}`);
    }
  }
}

export function causalEma(values, period, endIndex) {
  if (
    !Array.isArray(values) ||
    !Number.isSafeInteger(period) ||
    period < 2 ||
    !Number.isSafeInteger(endIndex) ||
    endIndex < 0 ||
    endIndex >= values.length
  ) {
    throw new Error("EMA_INPUT_INVALID");
  }
  const alpha = 2 / (period + 1);
  let value = values[0];
  for (let index = 1; index <= endIndex; index += 1) {
    if (!Number.isFinite(values[index])) throw new Error(`EMA_VALUE_INVALID:${index}`);
    value = alpha * values[index] + (1 - alpha) * value;
  }
  return value;
}

function timeoutEntry(bars, signalIndex, timeoutBars) {
  const fillIndex = signalIndex + timeoutBars;
  return Object.freeze({
    fillIndex,
    fillTime: bars[fillIndex].time,
    reason: "TIMEOUT_MARKET",
    timedOut: true,
  });
}

export function findEmaReclaimEntry(
  bars,
  { signalIndex, timeoutBars, emaPeriod },
) {
  assertWindow(bars, signalIndex, timeoutBars);
  const closes = bars.map((row) => row.close);
  for (let closedIndex = signalIndex; closedIndex < signalIndex + timeoutBars; closedIndex += 1) {
    const ema = causalEma(closes, emaPeriod, closedIndex);
    const row = bars[closedIndex];
    if (row.low <= ema && row.close > ema) {
      const fillIndex = closedIndex + 1;
      return Object.freeze({
        fillIndex,
        fillTime: bars[fillIndex].time,
        reason: "EMA20_RECLAIM",
        timedOut: false,
      });
    }
  }
  return timeoutEntry(bars, signalIndex, timeoutBars);
}

export function findSweepReclaimEntry(
  bars,
  { signalIndex, timeoutBars, lookbackBars },
) {
  assertWindow(bars, signalIndex, timeoutBars);
  if (!Number.isSafeInteger(lookbackBars) || lookbackBars < 2 || signalIndex < lookbackBars) {
    throw new Error("SWEEP_LOOKBACK_INVALID");
  }
  for (let closedIndex = signalIndex; closedIndex < signalIndex + timeoutBars; closedIndex += 1) {
    const row = bars[closedIndex];
    const priorLow = Math.min(
      ...bars.slice(closedIndex - lookbackBars, closedIndex).map((bar) => bar.low),
    );
    const lowerWick = Math.min(row.open, row.close) - row.low;
    const body = Math.abs(row.close - row.open);
    if (row.low < priorLow && row.close > priorLow && lowerWick >= body) {
      const fillIndex = closedIndex + 1;
      return Object.freeze({
        fillIndex,
        fillTime: bars[fillIndex].time,
        reason: "SWEEP_RECLAIM",
        timedOut: false,
      });
    }
  }
  return timeoutEntry(bars, signalIndex, timeoutBars);
}

export function buildTimingEntry(bars, timing, method) {
  const row = bars[timing?.fillIndex];
  if (
    !row ||
    row.time !== timing.fillTime ||
    typeof method !== "string" ||
    !method
  ) {
    throw new Error("TIMING_ENTRY_INVALID");
  }
  return Object.freeze({
    method,
    weight: 1,
    fillTime: row.time,
    rawFillPrice: row.open,
    fillKind: "MARKET",
    fillReason: timing.reason,
    fillPhase: "OPEN",
  });
}

export function buildMethodEntry(bars, signalIndex, method) {
  if (!method || METHODS[method.id] !== method) {
    throw new Error("TIMING_METHOD_INVALID");
  }
  if (method.family === "IMMEDIATE") {
    const row = bars[signalIndex];
    if (!row) throw new Error("TIMING_SIGNAL_BAR_MISSING");
    return buildTimingEntry(
      bars,
      {
        fillIndex: signalIndex,
        fillTime: row.time,
        reason: "MARKET_NOW",
        timedOut: false,
      },
      method.id,
    );
  }
  const timing = method.family === "EMA20_RECLAIM_FALLBACK"
    ? findEmaReclaimEntry(bars, {
      signalIndex,
      timeoutBars: method.timeoutBars,
      emaPeriod: method.emaPeriod,
    })
    : findSweepReclaimEntry(bars, {
      signalIndex,
      timeoutBars: method.timeoutBars,
      lookbackBars: method.lookbackBars,
    });
  return buildTimingEntry(bars, timing, method.id);
}
