function methodId(immediateWeight, offsetAtr5, timeoutMinutes) {
  const weight = Math.round(immediateWeight * 100);
  const offset = offsetAtr5 === 0.25 ? "025" : "05";
  return `M${weight}_O${offset}_T${timeoutMinutes}`;
}

const methods = {
  A: Object.freeze({ id: "A", immediateWeight: 1, limitWeight: 0, offsetAtr5: 0, timeoutBars: 0 }),
};
for (const immediateWeight of [0.5, 0.7]) {
  for (const offsetAtr5 of [0.25, 0.5]) {
    for (const timeoutMinutes of [15, 30]) {
      const id = methodId(immediateWeight, offsetAtr5, timeoutMinutes);
      methods[id] = Object.freeze({
        id,
        immediateWeight,
        limitWeight: 1 - immediateWeight,
        offsetAtr5,
        timeoutBars: timeoutMinutes / 5,
      });
    }
  }
}
export const MICRO_METHODS = Object.freeze(methods);

function marketChild(bars, index, method, weight, reason) {
  const row = bars[index];
  if (!row) throw new Error(`MICRO_ENTRY_BAR_MISSING:${index}`);
  return Object.freeze({
    method,
    weight,
    fillTime: row.time,
    rawFillPrice: row.open,
    fillKind: "MARKET",
    fillReason: reason,
    fillPhase: "OPEN",
  });
}

export function buildMicroPlan(bars, signalIndex, atr5, method) {
  if (
    !Array.isArray(bars) ||
    !Number.isSafeInteger(signalIndex) ||
    signalIndex < 0 ||
    !Number.isFinite(atr5) ||
    atr5 <= 0 ||
    !method ||
    MICRO_METHODS[method.id] !== method
  ) {
    throw new Error("MICRO_PLAN_INPUT_INVALID");
  }
  if (method.id === "A") {
    return Object.freeze([marketChild(bars, signalIndex, method.id, 1, "MARKET_NOW")]);
  }
  if (signalIndex + method.timeoutBars >= bars.length) {
    throw new Error("MICRO_TIMEOUT_BAR_MISSING");
  }
  const immediate = marketChild(
    bars,
    signalIndex,
    method.id,
    method.immediateWeight,
    "MARKET_NOW_PARTIAL",
  );
  const limitPrice = bars[signalIndex].open - method.offsetAtr5 * atr5;
  let delayed = null;
  for (let index = signalIndex; index < signalIndex + method.timeoutBars; index += 1) {
    const row = bars[index];
    if (row.open <= limitPrice) {
      delayed = Object.freeze({
        method: method.id,
        weight: method.limitWeight,
        fillTime: row.time,
        rawFillPrice: limitPrice,
        fillKind: "LIMIT",
        fillReason: "MICRO_LIMIT_OPEN_THROUGH",
        fillPhase: "OPEN",
      });
      break;
    }
    if (row.low <= limitPrice) {
      delayed = Object.freeze({
        method: method.id,
        weight: method.limitWeight,
        fillTime: row.time,
        rawFillPrice: limitPrice,
        fillKind: "LIMIT",
        fillReason: "MICRO_LIMIT_TOUCH",
        fillPhase: "LOW",
      });
      break;
    }
  }
  delayed ??= marketChild(
    bars,
    signalIndex + method.timeoutBars,
    method.id,
    method.limitWeight,
    "TIMEOUT_MARKET",
  );
  const plan = Object.freeze([immediate, delayed]);
  const total = plan.reduce((sum, child) => sum + child.weight, 0);
  if (Math.abs(total - 1) > 1e-12) throw new Error(`MICRO_WEIGHT_INVALID:${total}`);
  return plan;
}
