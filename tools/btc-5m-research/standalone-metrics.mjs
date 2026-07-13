import { simulateStandaloneTrade } from "./standalone.mjs";

const FIVE_MINUTES_MS = 5 * 60_000;
const ONE_HOUR_MS = 60 * 60_000;

export const METRIC_STANDALONE_CONFIGS = Object.freeze([
  ...[0.0025, 0.005].flatMap((oiThreshold) => [1.5, 2].map((tpAtr) => Object.freeze({
    id: `PC_O${oiThreshold === 0.0025 ? "025" : "05"}_T${String(tpAtr).replace(".", "")}`,
    family: "POSITION_BACKED_CONTINUATION",
    oiThreshold,
    tpAtr,
    slAtr: 1,
    maxHoldBars: 48,
  }))),
  ...[0.0025, 0.005].flatMap((oiThreshold) => [1.5, 2].map((tpAtr) => Object.freeze({
    id: `LR_O${oiThreshold === 0.0025 ? "025" : "05"}_T${String(tpAtr).replace(".", "")}`,
    family: "LONG_LIQUIDATION_RECLAIM",
    oiThreshold,
    tpAtr,
    slAtr: 1,
    maxHoldBars: 48,
  }))),
]);

function lastAtOrBefore(rows, time) {
  let low = 0;
  let high = rows.length - 1;
  let answer = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (rows[middle].time <= time) {
      answer = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return answer;
}

export function buildMetricFeaturesByBar(bars, metrics) {
  if (!Array.isArray(bars) || !bars.length || !Array.isArray(metrics) || !metrics.length) {
    throw new Error("STANDALONE_METRIC_FEATURE_INPUT_INVALID");
  }
  return Object.freeze(bars.map((bar) => {
    const latestIndex = lastAtOrBefore(metrics, bar.time);
    if (latestIndex < 11) return Object.freeze({ available: false, reason: "LATEST_MISSING" });
    const latest = metrics[latestIndex];
    if (bar.time - latest.time > 6 * 60_000) {
      return Object.freeze({ available: false, reason: "LATEST_STALE" });
    }
    const priorTarget = latest.time - ONE_HOUR_MS;
    const priorIndex = lastAtOrBefore(metrics, priorTarget);
    const prior = metrics[priorIndex];
    if (
      priorIndex < 0 ||
      priorTarget - prior.time > 6 * 60_000 ||
      !Number.isFinite(latest.openInterest) ||
      !Number.isFinite(prior.openInterest)
    ) {
      return Object.freeze({ available: false, reason: "OI_WINDOW_INCOMPLETE" });
    }
    const recent = metrics.slice(latestIndex - 11, latestIndex + 1);
    const span = recent.at(-1).time - recent[0].time;
    if (
      span < 50 * 60_000 ||
      span > 70 * 60_000 ||
      recent.some((row) => !Number.isFinite(row.takerRatio))
    ) {
      return Object.freeze({ available: false, reason: "TAKER_WINDOW_INCOMPLETE" });
    }
    return Object.freeze({
      available: true,
      latestMetricTime: latest.time,
      openInterest: latest.openInterest,
      oiChange1h: latest.openInterest / prior.openInterest - 1,
      takerRatio1h: Math.exp(
        recent.reduce((total, row) => total + Math.log(row.takerRatio), 0) / recent.length,
      ),
    });
  }));
}

export function positioningSignal({ bars, index, bias, atr, feature, config }) {
  if (
    !Array.isArray(bars) ||
    !Number.isSafeInteger(index) ||
    index < 12 ||
    !["LONG", "SHORT"].includes(bias) ||
    !Number.isFinite(atr) ||
    atr <= 0 ||
    !feature?.available ||
    !Number.isFinite(feature.oiChange1h) ||
    !Number.isFinite(feature.takerRatio1h) ||
    !config?.family ||
    !Number.isFinite(config.oiThreshold)
  ) {
    return null;
  }
  const priceMoveAtr = (bars[index].close - bars[index - 12].close) / atr;
  if (config.family === "POSITION_BACKED_CONTINUATION") {
    if (feature.oiChange1h < config.oiThreshold) return null;
    if (bias === "LONG" && priceMoveAtr >= 1 && feature.takerRatio1h > 1) return "LONG";
    if (bias === "SHORT" && priceMoveAtr <= -1 && feature.takerRatio1h < 1) return "SHORT";
    return null;
  }
  if (config.family === "LONG_LIQUIDATION_RECLAIM") {
    const row = bars[index];
    return bias === "LONG" &&
      priceMoveAtr <= -1 &&
      feature.oiChange1h <= -config.oiThreshold &&
      feature.takerRatio1h < 1 &&
      row.close > row.open &&
      row.close > bars[index - 1].high
      ? "LONG"
      : null;
  }
  throw new Error(`STANDALONE_METRIC_FAMILY_INVALID:${config.family}`);
}

function fundingSlice(funding, start, end) {
  const output = [];
  for (const record of funding) {
    if (record.time < start) continue;
    if (record.time > end) break;
    output.push(record);
  }
  return output;
}

export function runMetricStandaloneConfig({
  bars,
  funding,
  config,
  scenario,
  biasByIndex,
  atrByIndex,
  metricFeaturesByIndex,
  startTime,
  endTime,
}) {
  if (
    !Array.isArray(bars) ||
    !Array.isArray(funding) ||
    !METRIC_STANDALONE_CONFIGS.includes(config) ||
    !scenario ||
    !Array.isArray(biasByIndex) ||
    !Array.isArray(atrByIndex) ||
    !Array.isArray(metricFeaturesByIndex) ||
    !Number.isSafeInteger(startTime) ||
    !Number.isSafeInteger(endTime)
  ) {
    throw new Error("STANDALONE_METRIC_RUN_INPUT_INVALID");
  }
  const trades = [];
  for (let index = 12; index < bars.length - 1; index += 1) {
    if (bars[index].time < startTime) continue;
    const lastExitTime = bars[index + 1].time + config.maxHoldBars * FIVE_MINUTES_MS;
    if (lastExitTime > endTime) break;
    const atr = atrByIndex[index];
    const side = positioningSignal({
      bars,
      index,
      bias: biasByIndex[index],
      atr,
      feature: metricFeaturesByIndex[index],
      config,
    });
    if (!side) continue;
    const entryIndex = index + 1;
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
      funding: fundingSlice(funding, bars[entryIndex].time, lastExitTime),
    });
    trades.push(Object.freeze({
      configId: config.id,
      family: config.family,
      signalTime: bars[entryIndex].time,
      year: new Date(bars[entryIndex].time).getUTCFullYear(),
      ...trade,
    }));
    const exitIndex = lastAtOrBefore(bars, trade.exitTime);
    index = Math.max(index, Math.min(exitIndex, bars.length - 2));
  }
  return Object.freeze(trades);
}

function preference(config) {
  return [config.oiThreshold === 0.005 ? 0 : 1, config.tpAtr === 1.5 ? 0 : 1];
}

export function selectMetricStandalone(stats) {
  const families = [];
  for (const family of ["POSITION_BACKED_CONTINUATION", "LONG_LIQUIDATION_RECLAIM"]) {
    const configs = METRIC_STANDALONE_CONFIGS.filter((config) => config.family === family);
    const rows = configs.map((config) => {
      const value = stats?.[config.id];
      if (!value) throw new Error(`STANDALONE_METRIC_STATS_MISSING:${config.id}`);
      return {
        config,
        value,
        qualifies:
          value.count >= 30 &&
          value.netReturn > 0 &&
          value.profitFactor > 1 &&
          value.dropTop20NetReturn > 0,
      };
    });
    const qualifying = rows.filter((row) => row.qualifies);
    if (qualifying.length < 3) continue;
    const ordered = qualifying.map((row) => row.value.netReturn).sort((a, b) => a - b);
    const median = ordered.length % 2
      ? ordered[Math.floor(ordered.length / 2)]
      : (ordered[ordered.length / 2 - 1] + ordered[ordered.length / 2]) / 2;
    const representative = [...qualifying].sort((left, right) => {
      const distance = Math.abs(left.value.netReturn - median) - Math.abs(right.value.netReturn - median);
      if (distance) return distance;
      const a = preference(left.config);
      const b = preference(right.config);
      return a[0] - b[0] || a[1] - b[1];
    })[0];
    families.push({ family, median, representative, rows });
  }
  if (!families.length) return Object.freeze({ family: null, method: null, families: [] });
  families.sort((left, right) => right.median - left.median);
  return Object.freeze({
    family: families[0].family,
    method: families[0].representative.config.id,
    families: Object.freeze(families),
  });
}
