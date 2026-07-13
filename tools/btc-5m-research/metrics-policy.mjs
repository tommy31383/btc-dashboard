export const METRICS_STATES = Object.freeze([
  "SHORT_COVERING_RALLY",
  "BUY_ABSORPTION",
  "CROWDED_LONG",
]);

const LADDER = "M70_O025_T15";

export function buildMetricsPolicyRows(microRows, featuresByKey) {
  if (!Array.isArray(microRows) || !(featuresByKey instanceof Map)) {
    throw new Error("METRICS_POLICY_INPUT_INVALID");
  }
  return Object.freeze(microRows.flatMap((row) => {
    const key = `${row.setup}|${row.signalTime}`;
    const features = featuresByKey.get(key);
    if (!features?.available) return [];
    const scenarios = {};
    for (const [scenario, methods] of Object.entries(row.scenarios ?? {})) {
      if (!methods.A || !methods[LADDER]) {
        throw new Error(`METRICS_POLICY_METHOD_MISSING:${key}:${scenario}`);
      }
      const policies = { A: methods.A };
      for (const state of METRICS_STATES) {
        const flagged = features.states?.[state] === true;
        policies[state] = Object.freeze({
          ...(flagged ? methods[LADDER] : methods.A),
          stateFlagged: flagged,
        });
      }
      scenarios[scenario] = Object.freeze(policies);
    }
    return [Object.freeze({
      ...row,
      metricsFeatures: features,
      scenarios: Object.freeze(scenarios),
    })];
  }));
}

export function selectMetricsDiscovery(baseline, summaries) {
  if (
    !baseline ||
    ![baseline.netPnl, baseline.maxRealizedDrawdown, baseline.dropTop20NetPnl]
      .every(Number.isFinite)
  ) {
    throw new Error("METRICS_SELECTION_BASELINE_INVALID");
  }
  const rows = METRICS_STATES.map((state) => {
    const value = summaries?.[state];
    if (
      !value ||
      !Number.isSafeInteger(value.flaggedCount) ||
      ![value.netPnl, value.maxRealizedDrawdown, value.dropTop20NetPnl]
        .every(Number.isFinite)
    ) {
      throw new Error(`METRICS_SELECTION_STATE_INVALID:${state}`);
    }
    const result = {
      state,
      flaggedCount: value.flaggedCount,
      netDelta: value.netPnl - baseline.netPnl,
      drawdownDelta: value.maxRealizedDrawdown - baseline.maxRealizedDrawdown,
      dropTopDelta: value.dropTop20NetPnl - baseline.dropTop20NetPnl,
    };
    result.qualifies =
      result.flaggedCount >= 8 &&
      result.netDelta > 0 &&
      result.drawdownDelta <= 0 &&
      result.dropTopDelta > 0;
    return Object.freeze(result);
  });
  return Object.freeze({
    candidates: Object.freeze(rows.filter((row) => row.qualifies).map((row) => row.state)),
    rows: Object.freeze(rows),
  });
}
