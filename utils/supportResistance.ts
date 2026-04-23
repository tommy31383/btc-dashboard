/**
 * Support/Resistance detection via swing highs/lows + clustering.
 *
 * Algorithm:
 *   1. Find all swing highs (high > left N bars AND > right N bars)
 *      and swing lows (low < left N bars AND < right N bars).
 *   2. Cluster nearby swings (within tolerance %) into a single level.
 *      The cluster's price = weighted avg of its swings (recency-weighted).
 *   3. Count TOUCHES — how many times price came within tolerance of the level.
 *      More touches = stronger level.
 *   4. Sort by strength, return top K support (below current) + top K resistance (above current).
 */
import { Kline } from "../hooks/useBinanceKlines";

export type SRKind = "support" | "resistance";

export interface SRLevel {
  price: number;
  kind: SRKind;
  touches: number;           // how many times price tested this level
  lastTouchIdx: number;      // most recent candle index touching this
  firstFormedIdx: number;    // when this level was first established
  strength: number;          // 0..1 normalized score (touches + recency)
}

export interface SRDetectConfig {
  leftBars?: number;         // how many bars to the left must be lower (for swing high)
  rightBars?: number;        // how many bars to the right must be lower
  tolerancePct?: number;     // % tolerance to cluster swings + count touches (default 0.15%)
  maxPerSide?: number;       // max levels to return per side
  minTouches?: number;       // only return levels with ≥ this many touches
}

const DEFAULTS: Required<SRDetectConfig> = {
  leftBars: 3,
  rightBars: 3,
  tolerancePct: 0.3,
  maxPerSide: 4,
  minTouches: 2,
};

/**
 * Main entry: detect S/R levels around current price.
 * Returns combined array sorted by distance from current price (closest first).
 */
export function detectSRLevels(klines: Kline[], currentPrice: number, cfg?: SRDetectConfig): SRLevel[] {
  const config = { ...DEFAULTS, ...cfg };
  if (klines.length < config.leftBars + config.rightBars + 5) return [];

  const swings = findSwings(klines, config.leftBars, config.rightBars);
  const clusters = clusterSwings(swings, klines, config.tolerancePct);
  const withTouches = countTouches(clusters, klines, config.tolerancePct);

  // Split support / resistance by current price
  const supports = withTouches
    .filter((l) => l.price < currentPrice && l.touches >= config.minTouches)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, config.maxPerSide)
    .map((l) => ({ ...l, kind: "support" as SRKind }));

  const resistances = withTouches
    .filter((l) => l.price > currentPrice && l.touches >= config.minTouches)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, config.maxPerSide)
    .map((l) => ({ ...l, kind: "resistance" as SRKind }));

  return [...supports, ...resistances];
}

// ── Step 1: find swings ────────────────────────────────────────────────────
interface Swing {
  idx: number;
  price: number;
  kind: "high" | "low";
}

function findSwings(klines: Kline[], left: number, right: number): Swing[] {
  const out: Swing[] = [];
  for (let i = left; i < klines.length - right; i++) {
    const k = klines[i];
    // swing high
    let isHigh = true;
    for (let j = 1; j <= left; j++) {
      if (klines[i - j].high >= k.high) { isHigh = false; break; }
    }
    if (isHigh) {
      for (let j = 1; j <= right; j++) {
        if (klines[i + j].high >= k.high) { isHigh = false; break; }
      }
    }
    if (isHigh) out.push({ idx: i, price: k.high, kind: "high" });

    // swing low
    let isLow = true;
    for (let j = 1; j <= left; j++) {
      if (klines[i - j].low <= k.low) { isLow = false; break; }
    }
    if (isLow) {
      for (let j = 1; j <= right; j++) {
        if (klines[i + j].low <= k.low) { isLow = false; break; }
      }
    }
    if (isLow) out.push({ idx: i, price: k.low, kind: "low" });
  }
  return out;
}

// ── Step 2: cluster swings within tolerance ───────────────────────────────
interface Cluster {
  price: number;
  swingIndices: number[];    // indices in klines
  firstIdx: number;
  lastIdx: number;
}

function clusterSwings(swings: Swing[], klines: Kline[], tolPct: number): Cluster[] {
  // Sort swings by price
  const sorted = [...swings].sort((a, b) => a.price - b.price);
  const clusters: Cluster[] = [];
  const total = klines.length;

  for (const s of sorted) {
    const tolAbs = s.price * (tolPct / 100);
    // Find a cluster within tolerance
    const existing = clusters.find((c) => Math.abs(c.price - s.price) <= tolAbs);
    if (existing) {
      // Recency-weighted: later swings pull price more (recentWeight = idx/total)
      const existingWeight = existing.swingIndices.reduce((sum, i) => sum + (i / total + 0.5), 0);
      const newWeight = s.idx / total + 0.5;
      existing.price = (existing.price * existingWeight + s.price * newWeight) / (existingWeight + newWeight);
      existing.swingIndices.push(s.idx);
      if (s.idx < existing.firstIdx) existing.firstIdx = s.idx;
      if (s.idx > existing.lastIdx) existing.lastIdx = s.idx;
    } else {
      clusters.push({ price: s.price, swingIndices: [s.idx], firstIdx: s.idx, lastIdx: s.idx });
    }
  }
  return clusters;
}

// ── Step 3: count touches across all klines ───────────────────────────────
function countTouches(clusters: Cluster[], klines: Kline[], tolPct: number): SRLevel[] {
  const total = klines.length;
  return clusters.map((c) => {
    const tolAbs = c.price * (tolPct / 100);
    let touches = 0;
    let lastTouchIdx = c.lastIdx;
    for (let i = 0; i < klines.length; i++) {
      const k = klines[i];
      // Price touched if high >= level - tol AND low <= level + tol
      if (k.high >= c.price - tolAbs && k.low <= c.price + tolAbs) {
        touches++;
        lastTouchIdx = i;
      }
    }
    // Strength = normalized touches + recency
    const recencyScore = lastTouchIdx / total;
    const touchScore = Math.min(1, touches / 10);
    const strength = touchScore * 0.6 + recencyScore * 0.4;
    return {
      price: c.price,
      kind: "support" as SRKind, // re-labeled by caller
      touches,
      lastTouchIdx,
      firstFormedIdx: c.firstIdx,
      strength,
    };
  });
}

/**
 * Format a level price for display on chart (short: "73.9K")
 */
export function formatSRPrice(p: number): string {
  if (p >= 10000) return (p / 1000).toFixed(1) + "K";
  return p.toFixed(0);
}
