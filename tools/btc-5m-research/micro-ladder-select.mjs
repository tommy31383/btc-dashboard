function parsePreference(method) {
  const match = /^M(50|70)_O(025|05)_T(15|30)$/.exec(method);
  if (!match) return { immediate: 0, timeout: Infinity, offset: Infinity };
  return {
    immediate: Number(match[1]),
    timeout: Number(match[3]),
    offset: match[2] === "025" ? 0.25 : 0.5,
  };
}

export function selectMicroLadder(stats) {
  const baseline = stats?.A;
  if (
    !baseline ||
    ![baseline.netPnl, baseline.maxRealizedDrawdown, baseline.dropTop20NetPnl]
      .every(Number.isFinite)
  ) {
    throw new Error("MICRO_SELECTION_BASELINE_INVALID");
  }
  const candidates = Object.entries(stats)
    .filter(([method]) => method !== "A")
    .map(([method, value]) => {
      if (
        !value ||
        ![value.netPnl, value.maxRealizedDrawdown, value.dropTop20NetPnl]
          .every(Number.isFinite)
      ) {
        throw new Error(`MICRO_SELECTION_METHOD_INVALID:${method}`);
      }
      const netDelta = value.netPnl - baseline.netPnl;
      const drawdownRatio = baseline.maxRealizedDrawdown > 0
        ? value.maxRealizedDrawdown / baseline.maxRealizedDrawdown
        : value.maxRealizedDrawdown === 0 ? 1 : Infinity;
      const dropTopDelta = value.dropTop20NetPnl - baseline.dropTop20NetPnl;
      return Object.freeze({
        method,
        netDelta,
        drawdownRatio,
        dropTopDelta,
        qualifies: netDelta > 0 && drawdownRatio <= 1.1 && dropTopDelta > 0,
      });
    });
  if (candidates.length !== 8) {
    throw new Error(`MICRO_SELECTION_GRID_INVALID:${candidates.length}`);
  }
  const qualifying = candidates.filter((candidate) => candidate.qualifies);
  if (qualifying.length < 6) {
    return Object.freeze({
      method: null,
      qualifyingCount: qualifying.length,
      familyMedianNetDelta: null,
      candidates: Object.freeze(candidates),
    });
  }
  const ordered = qualifying.map((candidate) => candidate.netDelta).sort((a, b) => a - b);
  const middle = ordered.length / 2;
  const familyMedianNetDelta = ordered.length % 2
    ? ordered[Math.floor(middle)]
    : (ordered[middle - 1] + ordered[middle]) / 2;
  const representative = [...qualifying].sort((left, right) => {
    const distance = Math.abs(left.netDelta - familyMedianNetDelta) -
      Math.abs(right.netDelta - familyMedianNetDelta);
    if (distance) return distance;
    const leftPreference = parsePreference(left.method);
    const rightPreference = parsePreference(right.method);
    return rightPreference.immediate - leftPreference.immediate ||
      leftPreference.timeout - rightPreference.timeout ||
      leftPreference.offset - rightPreference.offset ||
      left.method.localeCompare(right.method);
  })[0];
  return Object.freeze({
    method: representative.method,
    qualifyingCount: qualifying.length,
    familyMedianNetDelta,
    candidates: Object.freeze(candidates),
  });
}
