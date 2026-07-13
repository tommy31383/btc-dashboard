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

export function summarizeFilteredMethod(rows, scenario, method) {
  if (!Array.isArray(rows) || !rows.length) throw new Error("FILTER_SUMMARY_ROWS_EMPTY");
  const projected = rows.map((row) => {
    const baseline = row.scenarios?.[scenario]?.A;
    const value = row.scenarios?.[scenario]?.[method];
    const qty = SETUP_QTY[row.setup];
    if (!baseline || !value || !Number.isFinite(qty) || !Number.isFinite(baseline.netPnl)) {
      throw new Error(`FILTER_SUMMARY_ROW_INVALID:${row.setup}:${row.signalTime}:${scenario}:${method}`);
    }
    const retained = value.skipped === false;
    if (retained && (!Number.isFinite(value.netPnl) || !Number.isSafeInteger(value.exitTime))) {
      throw new Error(`FILTER_SUMMARY_RESULT_INVALID:${row.setup}:${row.signalTime}:${method}`);
    }
    return {
      row,
      baselinePnl: baseline.netPnl * qty,
      retained,
      value,
      pnl: retained ? value.netPnl * qty : 0,
    };
  });
  const retained = projected.filter((item) => item.retained);
  const pnl = projected.map((item) => item.pnl);
  const orderedPnl = [...retained]
    .sort((left, right) => left.value.exitTime - right.value.exitTime || left.row.signalTime - right.row.signalTime)
    .map((item) => item.pnl);
  const gains = pnl.filter((value) => value > 0).reduce((total, value) => total + value, 0);
  const losses = -pnl.filter((value) => value < 0).reduce((total, value) => total + value, 0);
  const byMonth = {};
  for (const item of projected) {
    const key = monthKey(item.row.signalTime);
    byMonth[key] ??= { sourceCount: 0, retainedCount: 0, netPnl: 0 };
    byMonth[key].sourceCount += 1;
    byMonth[key].retainedCount += item.retained ? 1 : 0;
    byMonth[key].netPnl += item.pnl;
  }
  return Object.freeze({
    sourceCount: rows.length,
    retainedCount: retained.length,
    retainedFraction: retained.length / rows.length,
    netPnl: pnl.reduce((total, value) => total + value, 0),
    winRate: retained.length ? retained.filter((item) => item.pnl > 0).length / retained.length : null,
    profitFactor: losses > 0 ? gains / losses : gains > 0 ? Infinity : null,
    maxRealizedDrawdown: maxRealizedDrawdown(orderedPnl),
    dropTop20NetPnl: dropTopFraction(pnl, 0.2),
    skippedBaselinePnl: projected
      .filter((item) => !item.retained)
      .reduce((total, item) => total + item.baselinePnl, 0),
    meanEntryImprovementAtr: mean(retained.map((item) => item.value.entryImprovementAtr)),
    meanMfe24Atr: mean(retained.map((item) => item.value.mfe24Atr)),
    meanMae24Atr: mean(retained.map((item) => item.value.mae24Atr)),
    byMonth,
  });
}

export function selectFilter(baseline, candidates) {
  if (
    !baseline ||
    !Number.isFinite(baseline.netPnl) ||
    !Number.isFinite(baseline.maxRealizedDrawdown) ||
    !Number.isFinite(baseline.dropTop20NetPnl)
  ) {
    throw new Error("FILTER_SELECTION_BASELINE_INVALID");
  }
  const rows = Object.entries(candidates).map(([method, value]) => {
    const qualifies =
      value.retainedFraction >= 0.8 &&
      value.netPnl > baseline.netPnl &&
      value.maxRealizedDrawdown <= baseline.maxRealizedDrawdown &&
      value.dropTop20NetPnl > baseline.dropTop20NetPnl &&
      value.skippedBaselinePnl <= 0;
    return {
      method,
      qualifies,
      netDelta: value.netPnl - baseline.netPnl,
      drawdownDelta: value.maxRealizedDrawdown - baseline.maxRealizedDrawdown,
      dropTopDelta: value.dropTop20NetPnl - baseline.dropTop20NetPnl,
      retainedFraction: value.retainedFraction,
      skippedBaselinePnl: value.skippedBaselinePnl,
    };
  });
  const qualified = rows.filter((row) => row.qualifies).sort((left, right) => right.netDelta - left.netDelta);
  return Object.freeze({ method: qualified[0]?.method ?? null, candidates: Object.freeze(rows) });
}

export function summarizeStandalone(trades) {
  if (!Array.isArray(trades) || !trades.length) {
    return Object.freeze({
      count: 0,
      netReturn: 0,
      winRate: null,
      profitFactor: null,
      maxRealizedDrawdown: 0,
      dropTop20NetReturn: 0,
      byYear: {},
      byMonth: {},
      bySide: {},
    });
  }
  const returns = trades.map((trade) => trade.netReturn);
  if (returns.some((value) => !Number.isFinite(value))) throw new Error("STANDALONE_RETURN_INVALID");
  const ordered = [...trades]
    .sort((left, right) => left.exitTime - right.exitTime || left.signalTime - right.signalTime)
    .map((trade) => trade.netReturn);
  const gains = returns.filter((value) => value > 0).reduce((total, value) => total + value, 0);
  const losses = -returns.filter((value) => value < 0).reduce((total, value) => total + value, 0);
  const groupedTrades = (keyFor) => {
    const groups = new Map();
    for (const trade of trades) {
      const key = keyFor(trade);
      const group = groups.get(key) ?? [];
      group.push(trade.netReturn);
      groups.set(key, group);
    }
    return Object.fromEntries([...groups.entries()].sort(([left], [right]) => String(left).localeCompare(String(right))).map(
      ([key, values]) => [key, {
        count: values.length,
        netReturn: values.reduce((total, value) => total + value, 0),
        winRate: values.filter((value) => value > 0).length / values.length,
      }],
    ));
  };
  return Object.freeze({
    count: trades.length,
    netReturn: returns.reduce((total, value) => total + value, 0),
    winRate: returns.filter((value) => value > 0).length / returns.length,
    profitFactor: losses > 0 ? gains / losses : gains > 0 ? Infinity : null,
    medianTradeReturn: median(returns),
    maxRealizedDrawdown: maxRealizedDrawdown(ordered),
    dropTop20NetReturn: dropTopFraction(returns, 0.2),
    meanMfeAtr: mean(trades.map((trade) => trade.mfeAtr)),
    meanMaeAtr: mean(trades.map((trade) => trade.maeAtr)),
    byYear: groupedTrades((trade) => String(new Date(trade.signalTime).getUTCFullYear())),
    byMonth: groupedTrades((trade) => monthKey(trade.signalTime)),
    bySide: groupedTrades((trade) => trade.side),
  });
}

export function selectStandalone(results) {
  if (!Array.isArray(results) || !results.length) throw new Error("STANDALONE_SELECTION_EMPTY");
  const groupedResults = new Map();
  for (const result of results) {
    if (
      !result?.config?.id ||
      !result?.config?.family ||
      !Number.isFinite(result?.summary?.netReturn) ||
      !Number.isFinite(result?.summary?.dropTop20NetReturn)
    ) {
      throw new Error("STANDALONE_SELECTION_ROW_INVALID");
    }
    const group = groupedResults.get(result.config.family) ?? [];
    group.push(result);
    groupedResults.set(result.config.family, group);
  }
  const families = [];
  for (const [family, group] of groupedResults) {
    const qualifying = group.filter(
      (result) => result.summary.netReturn > 0 && result.summary.dropTop20NetReturn > 0,
    );
    if (qualifying.length < Math.ceil(group.length * 0.75)) continue;
    const orderedNet = group.map((result) => result.summary.netReturn).sort((left, right) => left - right);
    const familyMedian = orderedNet.length % 2
      ? orderedNet[Math.floor(orderedNet.length / 2)]
      : (orderedNet[orderedNet.length / 2 - 1] + orderedNet[orderedNet.length / 2]) / 2;
    const representative = [...qualifying].sort(
      (left, right) =>
        Math.abs(left.summary.netReturn - familyMedian) - Math.abs(right.summary.netReturn - familyMedian) ||
        left.config.id.localeCompare(right.config.id),
    )[0];
    families.push({ family, familyMedian, representative });
  }
  if (!families.length) return Object.freeze({ configId: null, family: null, families: [] });
  families.sort((left, right) => right.familyMedian - left.familyMedian);
  return Object.freeze({
    configId: families[0].representative.config.id,
    family: families[0].family,
    families: Object.freeze(families),
  });
}
