export const SETUP_QTY = Object.freeze({ S12: 0.005, S13: 0.003, S14: 0.005 });

function mean(values) {
  return values.length
    ? values.reduce((total, value) => total + value, 0) / values.length
    : null;
}

function median(values) {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

function monthKey(time) {
  const date = new Date(time);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function maxRealizedDrawdown(pnl) {
  let equity = 0;
  let peak = 0;
  let maximum = 0;
  for (const value of pnl) {
    if (!Number.isFinite(value)) throw new Error("DRAWDOWN_VALUE_INVALID");
    equity += value;
    peak = Math.max(peak, equity);
    maximum = Math.max(maximum, peak - equity);
  }
  return maximum;
}

export function dropTopFraction(values, fraction = 0.2) {
  if (
    !Array.isArray(values) ||
    !values.length ||
    !Number.isFinite(fraction) ||
    fraction <= 0 ||
    fraction >= 1
  ) {
    throw new Error("DROP_TOP_INPUT_INVALID");
  }
  const remove = Math.max(1, Math.ceil(values.length * fraction));
  return [...values]
    .sort((left, right) => right - left)
    .slice(remove)
    .reduce((total, value) => total + value, 0);
}

function grouped(rows, valueFor, keyFor) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFor(row);
    const group = groups.get(key) ?? [];
    group.push(valueFor(row));
    groups.set(key, group);
  }
  return Object.fromEntries(
    [...groups.entries()]
      .sort(([left], [right]) => String(left).localeCompare(String(right)))
      .map(([key, values]) => [key, {
        count: values.length,
        netPnl: values.reduce((total, value) => total + value, 0),
        winRate: values.filter((value) => value > 0).length / values.length,
      }]),
  );
}

export function summarizeMethod(rows, scenario, method) {
  if (!Array.isArray(rows) || !rows.length) throw new Error("SUMMARY_ROWS_EMPTY");
  const projected = rows.map((row) => {
    const value = row.scenarios?.[scenario]?.[method];
    const qty = SETUP_QTY[row.setup];
    if (
      !value ||
      !Number.isFinite(qty) ||
      !Number.isFinite(value.netPnl) ||
      !Number.isSafeInteger(value.exitTime)
    ) {
      throw new Error(`SUMMARY_ROW_INVALID:${row.setup}:${row.signalTime}:${scenario}:${method}`);
    }
    return { row, value, pnl: value.netPnl * qty };
  });
  const pnl = projected.map((item) => item.pnl);
  const orderedPnl = [...projected]
    .sort((left, right) => left.value.exitTime - right.value.exitTime || left.row.signalTime - right.row.signalTime)
    .map((item) => item.pnl);
  const gains = pnl.filter((value) => value > 0).reduce((total, value) => total + value, 0);
  const losses = -pnl.filter((value) => value < 0).reduce((total, value) => total + value, 0);
  const valueFor = (row) => row.scenarios[scenario][method].netPnl * SETUP_QTY[row.setup];
  return Object.freeze({
    count: rows.length,
    netPnl: pnl.reduce((total, value) => total + value, 0),
    winRate: pnl.filter((value) => value > 0).length / pnl.length,
    profitFactor: losses > 0 ? gains / losses : gains > 0 ? Infinity : null,
    medianTradePnl: median(pnl),
    maxRealizedDrawdown: maxRealizedDrawdown(orderedPnl),
    dropTop20NetPnl: dropTopFraction(pnl, 0.2),
    meanEntryImprovementAtr: mean(projected.map((item) => item.value.entryImprovementAtr)),
    timeoutRate: mean(projected.map((item) => item.value.timedOut ? 1 : 0)),
    meanMfe24Atr: mean(projected.map((item) => item.value.mfe24Atr)),
    meanMae24Atr: mean(projected.map((item) => item.value.mae24Atr)),
    meanHoldHours: mean(projected.map((item) => item.value.holdMs / 3_600_000)),
    fees: projected.reduce((total, item) => total + item.value.fees * SETUP_QTY[item.row.setup], 0),
    fundingPnl: projected.reduce((total, item) => total + item.value.fundingPnl * SETUP_QTY[item.row.setup], 0),
    byYear: grouped(rows, valueFor, (row) => String(new Date(row.signalTime).getUTCFullYear())),
    byMonth: grouped(rows, valueFor, (row) => monthKey(row.signalTime)),
    bySetup: grouped(rows, valueFor, (row) => row.setup),
  });
}

export function evaluateTimingRows(rows) {
  const methods = Object.keys(rows[0]?.scenarios?.primaryLowHigh ?? {});
  const scenarios = Object.keys(rows[0]?.scenarios ?? {});
  return Object.freeze(Object.fromEntries(
    ["discovery", "oos", "full"].map((split) => {
      const selected = split === "full" ? rows : rows.filter((row) => row.split === split);
      return [split, Object.fromEntries(
        scenarios.map((scenario) => [scenario, Object.fromEntries(
          methods.map((method) => [method, summarizeMethod(selected, scenario, method)]),
        )]),
      )];
    }),
  ));
}

const TIMING_FAMILIES = Object.freeze({
  EMA20_RECLAIM_FALLBACK: Object.freeze(["E30", "E60"]),
  SWEEP_RECLAIM_FALLBACK: Object.freeze(["S6_30", "S6_60", "S12_30", "S12_60"]),
});

export function selectPlateau(stats) {
  const baseline = stats?.A;
  if (
    !baseline ||
    ![baseline.netPnl, baseline.maxRealizedDrawdown, baseline.dropTop20NetPnl].every(Number.isFinite)
  ) {
    throw new Error("PLATEAU_BASELINE_INVALID");
  }
  const families = [];
  for (const [family, methods] of Object.entries(TIMING_FAMILIES)) {
    const rows = methods.map((method) => {
      const value = stats[method];
      if (!value) throw new Error(`PLATEAU_METHOD_MISSING:${method}`);
      const result = {
        method,
        netDelta: value.netPnl - baseline.netPnl,
        drawdownRatio: baseline.maxRealizedDrawdown > 0
          ? value.maxRealizedDrawdown / baseline.maxRealizedDrawdown
          : value.maxRealizedDrawdown === 0 ? 1 : Infinity,
        dropTopDelta: value.dropTop20NetPnl - baseline.dropTop20NetPnl,
      };
      result.qualifies = result.netDelta > 0 && result.drawdownRatio <= 1.1 && result.dropTopDelta > 0;
      return result;
    });
    const required = Math.ceil(methods.length * 0.75);
    const qualifying = rows.filter((row) => row.qualifies);
    if (qualifying.length < required) continue;
    const sortedDelta = rows.map((row) => row.netDelta).sort((left, right) => left - right);
    const familyMedian = sortedDelta.length % 2
      ? sortedDelta[Math.floor(sortedDelta.length / 2)]
      : (sortedDelta[sortedDelta.length / 2 - 1] + sortedDelta[sortedDelta.length / 2]) / 2;
    const representative = [...qualifying].sort(
      (left, right) =>
        Math.abs(left.netDelta - familyMedian) - Math.abs(right.netDelta - familyMedian) ||
        methods.indexOf(left.method) - methods.indexOf(right.method),
    )[0];
    families.push({ family, familyMedian, representative, rows });
  }
  if (!families.length) return Object.freeze({ method: null, family: null, families: [] });
  families.sort((left, right) => right.familyMedian - left.familyMedian);
  return Object.freeze({
    method: families[0].representative.method,
    family: families[0].family,
    families: Object.freeze(families),
  });
}
