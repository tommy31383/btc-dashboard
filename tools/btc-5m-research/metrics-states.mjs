const FIVE_MINUTES_MS = 5 * 60_000;
const ONE_HOUR_MS = 60 * 60_000;
const SEVEN_DAYS_MS = 7 * 24 * ONE_HOUR_MS;
const MIN_RANK_OBSERVATIONS = 1_800;

function lastAtOrBefore(rows, time) {
  let low = 0;
  let high = rows.length - 1;
  let answer = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (rows[middle].time <= time) {
      answer = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return answer;
}

function unavailable(metricCutoff, reason) {
  return Object.freeze({ available: false, metricCutoff, reason });
}

function strictRank(values, current) {
  return values.filter((value) => value < current).length / values.length;
}

export function classifyMetricsStates(features) {
  const fields = [
    "priceChange1h",
    "oiChange1h",
    "takerRatio1h",
    "accountRank7d",
    "topPositionRank7d",
  ];
  if (!features || fields.some((field) => !Number.isFinite(features[field]))) {
    throw new Error("METRICS_STATE_FEATURES_INVALID");
  }
  return Object.freeze({
    SHORT_COVERING_RALLY: features.priceChange1h > 0 && features.oiChange1h < 0,
    BUY_ABSORPTION: features.takerRatio1h > 1 && features.priceChange1h <= 0,
    CROWDED_LONG:
      features.oiChange1h > 0 &&
      features.accountRank7d >= 0.75 &&
      features.topPositionRank7d >= 0.75,
  });
}

export function computeMetricsFeatures({ metrics, bars5m, signalIndex }) {
  if (
    !Array.isArray(metrics) ||
    !metrics.length ||
    !Array.isArray(bars5m) ||
    !Number.isSafeInteger(signalIndex) ||
    signalIndex < 13 ||
    !Number.isSafeInteger(bars5m[signalIndex]?.time)
  ) {
    throw new Error("METRICS_FEATURE_INPUT_INVALID");
  }
  const signalTime = bars5m[signalIndex].time;
  const metricCutoff = signalTime - FIVE_MINUTES_MS;
  const latestIndex = lastAtOrBefore(metrics, metricCutoff);
  if (latestIndex < 11) return unavailable(metricCutoff, "LATEST_MISSING");
  const latest = metrics[latestIndex];
  if (metricCutoff - latest.time > 6 * 60_000) {
    return unavailable(metricCutoff, "LATEST_STALE");
  }
  const priorTarget = latest.time - ONE_HOUR_MS;
  const priorIndex = lastAtOrBefore(metrics, priorTarget);
  if (priorIndex < 0 || priorTarget - metrics[priorIndex].time > 6 * 60_000) {
    return unavailable(metricCutoff, "PRIOR_OI_STALE");
  }
  const prior = metrics[priorIndex];
  const recent = metrics.slice(latestIndex - 11, latestIndex + 1);
  const recentSpan = recent.at(-1).time - recent[0].time;
  if (
    recentSpan < 50 * 60_000 ||
    recentSpan > 70 * 60_000 ||
    recent.some((row) => !Number.isFinite(row.takerRatio))
  ) {
    return unavailable(metricCutoff, "TAKER_WINDOW_INCOMPLETE");
  }
  if (
    !Number.isFinite(latest.openInterest) ||
    !Number.isFinite(prior.openInterest) ||
    !Number.isFinite(latest.accountRatio) ||
    !Number.isFinite(latest.topPositionRatio)
  ) {
    return unavailable(metricCutoff, "POSITION_METRIC_MISSING");
  }
  const rankWindow = metrics.filter(
    (row) => row.time >= latest.time - SEVEN_DAYS_MS && row.time < latest.time,
  );
  const accountHistory = rankWindow.map((row) => row.accountRatio).filter(Number.isFinite);
  const topPositionHistory = rankWindow.map((row) => row.topPositionRatio).filter(Number.isFinite);
  if (
    accountHistory.length < MIN_RANK_OBSERVATIONS ||
    topPositionHistory.length < MIN_RANK_OBSERVATIONS
  ) {
    return unavailable(metricCutoff, "RANK_HISTORY_INCOMPLETE");
  }
  const currentClose = bars5m[signalIndex - 1]?.close;
  const priorClose = bars5m[signalIndex - 13]?.close;
  if (!Number.isFinite(currentClose) || !Number.isFinite(priorClose) || priorClose <= 0) {
    return unavailable(metricCutoff, "PRICE_WINDOW_INCOMPLETE");
  }
  const features = {
    available: true,
    reason: null,
    metricCutoff,
    latestMetricTime: latest.time,
    priceChange1h: currentClose / priorClose - 1,
    oiChange1h: latest.openInterest / prior.openInterest - 1,
    takerRatio1h: Math.exp(
      recent.reduce((total, row) => total + Math.log(row.takerRatio), 0) / recent.length,
    ),
    accountRank7d: strictRank(accountHistory, latest.accountRatio),
    topPositionRank7d: strictRank(topPositionHistory, latest.topPositionRatio),
    rankObservations: Math.min(accountHistory.length, topPositionHistory.length),
  };
  return Object.freeze({
    ...features,
    states: classifyMetricsStates(features),
  });
}
