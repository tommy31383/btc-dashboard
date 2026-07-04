export const BULLISH_LEG = 1 as const;
export const BEARISH_LEG = 0 as const;
export const BULLISH = 1 as const;
export const BEARISH = -1 as const;

export type SmcLeg = typeof BULLISH_LEG | typeof BEARISH_LEG;
export type SmcTrendBias = typeof BULLISH | typeof BEARISH | 0;
export type SmcBias = "bullish" | "bearish";
export type SmcScope = "internal" | "swing";
export type SmcStructureType = "BOS" | "CHoCH";
export type SmcEqualLevelKind = "EQH" | "EQL";

export interface SmcCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface SmcConfig {
  swingsLength: number;
  internalSize: number;
  showInternal: boolean;
  showSwing: boolean;
  showOrderBlocks: boolean;
  showEqualHighLow: boolean;
  showPremiumDiscountZones: boolean;
  equalHighsLowsThreshold: number;
  equalHighsLowsLength: number;
  maxOrderBlocks: number;
}

export type SmcConfigInput = Partial<SmcConfig>;

export interface SmcStructureEvent {
  type: SmcStructureType;
  scope: SmcScope;
  bias: SmcBias;
  barIndex: number;
  barTime: number;
  pivotIndex: number;
  pivotTime: number;
  priceLevel: number;
}

export interface SmcOrderBlock {
  scope: SmcScope;
  bias: SmcBias;
  top: number;
  bottom: number;
  barIndex: number;
  barTime: number;
  createdAtIndex: number;
  createdAtTime: number;
}

export interface SmcEqualLevel {
  kind: SmcEqualLevelKind;
  barIndex: number;
  barTime: number;
  previousPivotIndex: number;
  previousPivotTime: number;
  currentPivotIndex: number;
  currentPivotTime: number;
  priceLevel: number;
}

export interface SmcZoneBand {
  top: number;
  bottom: number;
}

export interface SmcPremiumDiscountZones {
  top: number;
  bottom: number;
  premium: SmcZoneBand;
  equilibrium: SmcZoneBand;
  discount: SmcZoneBand;
}

export interface SmcResult {
  structureEvents: SmcStructureEvent[];
  orderBlocks: SmcOrderBlock[];
  equalLevels: SmcEqualLevel[];
  zones: SmcPremiumDiscountZones | null;
}

interface PivotState {
  currentLevel: number | null;
  lastLevel: number | null;
  lastBarIndex: number;
  lastBarTime: number;
  crossed: boolean;
  barIndex: number;
  barTime: number;
}

interface StructureState {
  high: PivotState;
  low: PivotState;
  trendBias: SmcTrendBias;
  leg: SmcLeg;
}

interface ParsedRange {
  high: number;
  low: number;
}

const DEFAULT_SMC_CONFIG: SmcConfig = {
  swingsLength: 50,
  internalSize: 5,
  showInternal: true,
  showSwing: true,
  showOrderBlocks: true,
  showEqualHighLow: true,
  showPremiumDiscountZones: true,
  equalHighsLowsThreshold: 0.1,
  equalHighsLowsLength: 3,
  maxOrderBlocks: 5,
};

export { DEFAULT_SMC_CONFIG };

function resolveConfig(input: SmcConfigInput = {}): SmcConfig {
  const merged = { ...DEFAULT_SMC_CONFIG, ...input };
  return {
    ...merged,
    swingsLength: Math.max(1, Math.round(merged.swingsLength)),
    internalSize: Math.max(1, Math.round(merged.internalSize)),
    equalHighsLowsLength: Math.max(1, Math.round(merged.equalHighsLowsLength)),
    equalHighsLowsThreshold: Math.max(0, merged.equalHighsLowsThreshold),
    maxOrderBlocks: Math.max(1, Math.round(merged.maxOrderBlocks)),
  };
}

function createPivotState(): PivotState {
  return {
    currentLevel: null,
    lastLevel: null,
    lastBarIndex: -1,
    lastBarTime: 0,
    crossed: false,
    barIndex: -1,
    barTime: 0,
  };
}

function createStructureState(): StructureState {
  return {
    high: createPivotState(),
    low: createPivotState(),
    trendBias: 0,
    leg: BEARISH_LEG,
  };
}

function trueRange(candles: SmcCandle[]): number[] {
  return candles.map((candle, index) => {
    if (index === 0) return candle.high - candle.low;
    const previousClose = candles[index - 1].close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose)
    );
  });
}

function atr(candles: SmcCandle[], length: number): (number | null)[] {
  const ranges = trueRange(candles);
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (length <= 0 || candles.length === 0) return out;

  // Stays null until `length` samples are available — a partial early
  // average would make the volatile-bar filter active too soon compared to
  // Pine's ta.atr, which also warms up over the full length (Codex-caught P2).
  let seed = 0;
  for (let i = 0; i < ranges.length; i++) {
    if (i < length) {
      seed += ranges[i];
      if (i === length - 1) out[i] = seed / length;
      continue;
    }
    out[i] = ((out[i - 1] ?? ranges[i]) * (length - 1) + ranges[i]) / length;
  }
  return out;
}

function highestHigh(candles: SmcCandle[], startIndex: number, endIndex: number): number {
  let high = -Infinity;
  for (let i = startIndex; i <= endIndex; i++) high = Math.max(high, candles[i].high);
  return high;
}

function lowestLow(candles: SmcCandle[], startIndex: number, endIndex: number): number {
  let low = Infinity;
  for (let i = startIndex; i <= endIndex; i++) low = Math.min(low, candles[i].low);
  return low;
}

function nextLegAt(candles: SmcCandle[], index: number, size: number, previousLeg: SmcLeg): SmcLeg {
  if (index < size) return previousLeg;
  const pivotIndex = index - size;
  const futureStart = pivotIndex + 1;
  const futureEnd = index;
  const newLegHigh = candles[pivotIndex].high > highestHigh(candles, futureStart, futureEnd);
  const newLegLow = candles[pivotIndex].low < lowestLow(candles, futureStart, futureEnd);

  if (newLegHigh) return BEARISH_LEG;
  if (newLegLow) return BULLISH_LEG;
  return previousLeg;
}

export function calculateSmcLegs(candles: SmcCandle[], size: number): SmcLeg[] {
  const safeSize = Math.max(1, Math.round(size));
  const legs: SmcLeg[] = new Array(candles.length).fill(BEARISH_LEG);
  let currentLeg: SmcLeg = BEARISH_LEG;

  for (let index = 0; index < candles.length; index++) {
    currentLeg = nextLegAt(candles, index, safeSize, currentLeg);
    legs[index] = currentLeg;
  }

  return legs;
}

function updatePivot(pivot: PivotState, level: number, barIndex: number, barTime: number): void {
  pivot.lastLevel = pivot.currentLevel;
  pivot.lastBarIndex = pivot.barIndex;
  pivot.lastBarTime = pivot.barTime;
  pivot.currentLevel = level;
  pivot.crossed = false;
  pivot.barIndex = barIndex;
  pivot.barTime = barTime;
}

function parsedRange(candle: SmcCandle, atrValue: number | null): ParsedRange {
  const volatile = atrValue !== null && candle.high - candle.low >= 2 * atrValue;
  return volatile ? { high: candle.low, low: candle.high } : { high: candle.high, low: candle.low };
}

function findOrderBlock(
  candles: SmcCandle[],
  atr200: (number | null)[],
  pivot: PivotState,
  currentIndex: number,
  scope: SmcScope,
  bias: SmcBias
): SmcOrderBlock | null {
  if (pivot.barIndex < 0 || pivot.barIndex > currentIndex) return null;

  let selectedIndex = pivot.barIndex;
  let selectedValue = bias === "bearish" ? -Infinity : Infinity;
  for (let index = pivot.barIndex; index <= currentIndex; index++) {
    const parsed = parsedRange(candles[index], atr200[index]);
    if (bias === "bearish" && parsed.high > selectedValue) {
      selectedValue = parsed.high;
      selectedIndex = index;
    } else if (bias === "bullish" && parsed.low < selectedValue) {
      selectedValue = parsed.low;
      selectedIndex = index;
    }
  }

  const candle = candles[selectedIndex];
  const parsedSelected = parsedRange(candle, atr200[selectedIndex]);
  return {
    scope,
    bias,
    top: Math.max(parsedSelected.high, parsedSelected.low),
    bottom: Math.min(parsedSelected.high, parsedSelected.low),
    barIndex: selectedIndex,
    barTime: candle.time,
    createdAtIndex: currentIndex,
    createdAtTime: candles[currentIndex].time,
  };
}

function removeMitigatedOrderBlocks(blocks: SmcOrderBlock[], candle: SmcCandle): SmcOrderBlock[] {
  return blocks.filter((block) => {
    if (block.bias === "bullish") return candle.low >= block.bottom;
    return candle.high <= block.top;
  });
}

function pushOrderBlock(blocks: SmcOrderBlock[], block: SmcOrderBlock, maxOrderBlocks: number): void {
  blocks.push(block);
  while (blocks.length > maxOrderBlocks) blocks.shift();
}

function crossOver(previousClose: number | null, close: number, level: number): boolean {
  return previousClose === null ? close > level : previousClose <= level && close > level;
}

function crossUnder(previousClose: number | null, close: number, level: number): boolean {
  return previousClose === null ? close < level : previousClose >= level && close < level;
}

function displayStructure(
  candles: SmcCandle[],
  atr200: (number | null)[],
  state: StructureState,
  scope: SmcScope,
  index: number,
  orderBlocks: SmcOrderBlock[],
  events: SmcStructureEvent[],
  config: SmcConfig
): void {
  const candle = candles[index];
  const previousClose = index > 0 ? candles[index - 1].close : null;
  const highPivot = state.high;
  const lowPivot = state.low;

  if (highPivot.currentLevel !== null && !highPivot.crossed && crossOver(previousClose, candle.close, highPivot.currentLevel)) {
    const type: SmcStructureType = state.trendBias === BEARISH ? "CHoCH" : "BOS";
    highPivot.crossed = true;
    state.trendBias = BULLISH;
    events.push({
      type,
      scope,
      bias: "bullish",
      barIndex: index,
      barTime: candle.time,
      pivotIndex: highPivot.barIndex,
      pivotTime: highPivot.barTime,
      priceLevel: highPivot.currentLevel,
    });

    if (config.showOrderBlocks) {
      const block = findOrderBlock(candles, atr200, highPivot, index, scope, "bullish");
      if (block) pushOrderBlock(orderBlocks, block, config.maxOrderBlocks);
    }
  }

  if (lowPivot.currentLevel !== null && !lowPivot.crossed && crossUnder(previousClose, candle.close, lowPivot.currentLevel)) {
    const type: SmcStructureType = state.trendBias === BULLISH ? "CHoCH" : "BOS";
    lowPivot.crossed = true;
    state.trendBias = BEARISH;
    events.push({
      type,
      scope,
      bias: "bearish",
      barIndex: index,
      barTime: candle.time,
      pivotIndex: lowPivot.barIndex,
      pivotTime: lowPivot.barTime,
      priceLevel: lowPivot.currentLevel,
    });

    if (config.showOrderBlocks) {
      const block = findOrderBlock(candles, atr200, lowPivot, index, scope, "bearish");
      if (block) pushOrderBlock(orderBlocks, block, config.maxOrderBlocks);
    }
  }
}

function updateStructure(
  candles: SmcCandle[],
  state: StructureState,
  index: number,
  size: number,
  onPivot: (kind: "high" | "low", pivot: PivotState) => void
): void {
  const previousLeg = state.leg;
  const currentLeg = nextLegAt(candles, index, size, previousLeg);
  state.leg = currentLeg;
  if (currentLeg === previousLeg) return;

  const pivotIndex = index - size;
  const pivotCandle = candles[pivotIndex];
  if (currentLeg - previousLeg === 1) {
    updatePivot(state.low, pivotCandle.low, pivotIndex, pivotCandle.time);
    onPivot("low", state.low);
  } else {
    updatePivot(state.high, pivotCandle.high, pivotIndex, pivotCandle.time);
    onPivot("high", state.high);
  }
}

function maybeAddEqualLevel(
  equalLevels: SmcEqualLevel[],
  kind: SmcEqualLevelKind,
  pivot: PivotState,
  barIndex: number,
  barTime: number,
  atrValue: number | null,
  threshold: number
): void {
  if (pivot.currentLevel === null || pivot.lastLevel === null || atrValue === null) return;
  if (pivot.lastBarIndex < 0) return;
  if (Math.abs(pivot.currentLevel - pivot.lastLevel) >= threshold * atrValue) return;

  equalLevels.push({
    kind,
    barIndex,
    barTime,
    previousPivotIndex: pivot.lastBarIndex,
    previousPivotTime: pivot.lastBarTime,
    currentPivotIndex: pivot.barIndex,
    currentPivotTime: pivot.barTime,
    priceLevel: pivot.currentLevel,
  });
}

function zoneBand(a: number, b: number): SmcZoneBand {
  return { top: Math.max(a, b), bottom: Math.min(a, b) };
}

function premiumDiscountZones(top: number | null, bottom: number | null): SmcPremiumDiscountZones | null {
  if (top === null || bottom === null || top <= bottom) return null;
  return {
    top,
    bottom,
    premium: zoneBand(top, 0.95 * top + 0.05 * bottom),
    equilibrium: zoneBand(0.525 * bottom + 0.475 * top, 0.525 * top + 0.475 * bottom),
    discount: zoneBand(0.95 * bottom + 0.05 * top, bottom),
  };
}

export function runSmc(candles: SmcCandle[], input: SmcConfigInput = {}): SmcResult {
  const config = resolveConfig(input);
  const atr200 = atr(candles, 200);
  const internalState = createStructureState();
  const swingState = createStructureState();
  const equalState = createStructureState();
  const structureEvents: SmcStructureEvent[] = [];
  let orderBlocks: SmcOrderBlock[] = [];
  const equalLevels: SmcEqualLevel[] = [];
  let trailingTop: number | null = null;
  let trailingBottom: number | null = null;

  for (let index = 0; index < candles.length; index++) {
    if (config.showOrderBlocks) orderBlocks = removeMitigatedOrderBlocks(orderBlocks, candles[index]);

    updateStructure(candles, internalState, index, config.internalSize, () => undefined);
    updateStructure(candles, swingState, index, config.swingsLength, (kind, pivot) => {
      if (kind === "high") trailingTop = pivot.currentLevel;
      else trailingBottom = pivot.currentLevel;
    });

    if (config.showEqualHighLow) {
      updateStructure(candles, equalState, index, config.equalHighsLowsLength, (kind, pivot) => {
        maybeAddEqualLevel(
          equalLevels,
          kind === "high" ? "EQH" : "EQL",
          pivot,
          index,
          candles[index].time,
          atr200[index],
          config.equalHighsLowsThreshold
        );
      });
    }

    if (config.showInternal) {
      displayStructure(candles, atr200, internalState, "internal", index, orderBlocks, structureEvents, config);
    }
    if (config.showSwing) {
      displayStructure(candles, atr200, swingState, "swing", index, orderBlocks, structureEvents, config);
    }
  }

  return {
    structureEvents,
    orderBlocks: config.showOrderBlocks ? orderBlocks : [],
    equalLevels: config.showEqualHighLow ? equalLevels : [],
    zones: config.showPremiumDiscountZones ? premiumDiscountZones(trailingTop, trailingBottom) : null,
  };
}
