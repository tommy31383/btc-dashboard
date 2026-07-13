const DAY_MS = 24 * 60 * 60_000;
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

function parseMetric(field, index) {
  const normalized = field.replace(/^"|"$/g, "");
  if (normalized === "") return null;
  const value = Number(normalized);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`METRICS_ROW_VALUE_INVALID:${index}`);
  }
  return value === 0 ? null : value;
}

export function parseMetricsCsv(text) {
  if (typeof text !== "string") throw new Error("METRICS_CSV_INVALID");
  const lines = text.trim().split(/\r?\n/);
  if (lines.shift() !== HEADER) throw new Error("METRICS_HEADER_INVALID");
  const rows = [];
  const byTime = new Map();
  lines.forEach((line, index) => {
    const fields = line.split(",");
    if (fields.length !== 8 || fields[1] !== "BTCUSDT") {
      throw new Error(`METRICS_ROW_SCHEMA_INVALID:${index}`);
    }
    const time = Date.parse(`${fields[0].replace(" ", "T")}Z`);
    const values = fields.slice(2).map((field) => parseMetric(field, index));
    if (!Number.isSafeInteger(time)) {
      throw new Error(`METRICS_ROW_VALUE_INVALID:${index}`);
    }
    const row = Object.freeze({
      time,
      openInterest: values[0],
      openInterestValue: values[1],
      topAccountRatio: values[2],
      topPositionRatio: values[3],
      accountRatio: values[4],
      takerRatio: values[5],
    });
    const prior = byTime.get(time);
    if (prior) {
      if (JSON.stringify(prior) !== JSON.stringify(row)) {
        throw new Error(`METRICS_DUPLICATE_CONFLICT:${time}`);
      }
      return;
    }
    byTime.set(time, row);
    rows.push(row);
  });
  return Object.freeze(rows);
}

function utcDate(time) {
  return new Date(time).toISOString().slice(0, 10);
}

export function metricDateRange(startDate, endDate) {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start > end ||
    utcDate(start) !== startDate ||
    utcDate(end) !== endDate
  ) {
    throw new Error("METRICS_DATE_RANGE_INVALID");
  }
  const dates = [];
  for (let time = start; time <= end; time += DAY_MS) dates.push(utcDate(time));
  return Object.freeze(dates);
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
