const DAY_MS = 24 * 60 * 60_000;
const FIVE_MINUTES_MS = 5 * 60_000;
const HEADER = [
  "create_time",
  "symbol",
  "sum_open_interest",
  "sum_open_interest_value",
  "count_toptrader_long_short_ratio",
  "sum_toptrader_long_short_ratio",
  "count_long_short_ratio",
  "sum_taker_long_short_vol_ratio",
].join(",");

export function parseMetricsCsv(text) {
  if (typeof text !== "string") throw new Error("METRICS_CSV_INVALID");
  const lines = text.trim().split(/\r?\n/);
  if (lines.shift() !== HEADER) throw new Error("METRICS_HEADER_INVALID");
  return Object.freeze(lines.map((line, index) => {
    const fields = line.split(",");
    if (fields.length !== 8 || fields[1] !== "BTCUSDT") {
      throw new Error(`METRICS_ROW_SCHEMA_INVALID:${index}`);
    }
    const time = Date.parse(`${fields[0].replace(" ", "T")}Z`);
    const values = fields.slice(2).map(Number);
    if (
      !Number.isSafeInteger(time) ||
      time % FIVE_MINUTES_MS !== 0 ||
      values.some((value) => !Number.isFinite(value) || value <= 0)
    ) {
      throw new Error(`METRICS_ROW_VALUE_INVALID:${index}`);
    }
    return Object.freeze({
      time,
      openInterest: values[0],
      openInterestValue: values[1],
      topAccountRatio: values[2],
      topPositionRatio: values[3],
      accountRatio: values[4],
      takerRatio: values[5],
    });
  }));
}

function utcDate(time) {
  return new Date(time).toISOString().slice(0, 10);
}

export function requiredMetricDates(signals) {
  if (!Array.isArray(signals) || signals.some((signal) => !Number.isSafeInteger(signal?.signalTime))) {
    throw new Error("METRICS_SIGNALS_INVALID");
  }
  const dates = new Set();
  for (const signal of signals) {
    const start = Date.UTC(
      new Date(signal.signalTime).getUTCFullYear(),
      new Date(signal.signalTime).getUTCMonth(),
      new Date(signal.signalTime).getUTCDate(),
    ) - 7 * DAY_MS;
    for (let offset = 0; offset <= 7; offset += 1) {
      dates.add(utcDate(start + offset * DAY_MS));
    }
  }
  return Object.freeze([...dates].sort());
}
