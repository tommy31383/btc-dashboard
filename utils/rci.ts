/**
 * rci.ts — Reversal Confluence Index (RCI v3)
 *
 * Một đường oscillator âm/dương xác định thời điểm giá quay đầu (đỉnh/đáy).
 *   Dương (+) = bearish pressure (đỉnh sắp quay đầu xuống)
 *   Âm  (−)  = bullish pressure (đáy sắp quay đầu lên)
 *
 * Backtest 7y/3y (docs/rci-indicator-research-2026-06-03.md):
 *   Funding rate extreme >0.05%/8h = 64.3% precision (signal mạnh nhất)
 *   RCI v3 combined thr=4.0 = 60% precision (~5 signal/yr)
 *
 * Weight: Funding ×2.0-2.5 (crowding) + RSI ×1.5 + Stoch ×0.8 + BB ×0.8 + MACD ×0.4
 */
import { calcRSISeries, calcBollinger, calcMACD } from "./indicators";

export interface RCIInput {
  closes4h: number[];
  closes1h: number[];
  klines4h: { high: number; low: number; close: number; volume: number }[];
  fundingRate: number | null; // current funding rate (decimal, 0.0005 = 0.05%)
}

export interface RCIResult {
  value: number | null;        // RCI score (smoothed)
  zone: "BEAR_STRONG" | "BEAR_WATCH" | "NEUTRAL" | "BULL_WATCH" | "BULL_STRONG";
  components: {
    rsi: number;
    stoch: number;
    bollinger: number;
    macd: number;
    funding: number;
  };
  fundingPct: number | null;   // funding in % for display
}

/** Raw Stochastic %K (price-based, NOT StochRSI). */
function calcStochRaw(
  klines: { high: number; low: number; close: number }[],
  period = 14
): number | null {
  if (klines.length < period) return null;
  const slice = klines.slice(-period);
  const hi = Math.max(...slice.map((k) => k.high));
  const lo = Math.min(...slice.map((k) => k.low));
  const close = klines[klines.length - 1].close;
  return hi > lo ? (100 * (close - lo)) / (hi - lo) : 50;
}

/** Bollinger %B — 0 = lower band, 1 = upper band. */
function calcBollingerPctB(closes: number[], period = 20, mult = 2): number | null {
  const bb = calcBollinger(closes, period, mult);
  if (bb.upper === null || bb.lower === null) return null;
  const close = closes[closes.length - 1];
  const range = bb.upper - bb.lower;
  return range > 0 ? (close - bb.lower) / range : 0.5;
}

/** Compute RCI v3 score from current market state. */
export function computeRCI(input: RCIInput): RCIResult {
  const { closes4h, closes1h, klines4h, fundingRate } = input;

  const comp = { rsi: 0, stoch: 0, bollinger: 0, macd: 0, funding: 0 };

  // Need enough data
  if (closes4h.length < 30 || klines4h.length < 30) {
    return { value: null, zone: "NEUTRAL", components: comp, fundingPct: null };
  }

  // ── Layer 1: RSI (4h primary + 1h secondary) ──
  const rsi4Series = calcRSISeries(closes4h, 14);
  const r4 = rsi4Series[rsi4Series.length - 1];
  const r4p = rsi4Series[rsi4Series.length - 2];
  if (r4 !== undefined) {
    if (r4 > 75) comp.rsi += 1.5;
    else if (r4 > 70) comp.rsi += 1.0;
    else if (r4 < 25) comp.rsi -= 1.5;
    else if (r4 < 30) comp.rsi -= 1.0;
    if (r4p !== undefined) {
      if (r4p > 70 && r4 < r4p) comp.rsi += 0.5;
      if (r4p < 30 && r4 > r4p) comp.rsi -= 0.5;
    }
  }
  if (closes1h.length >= 20) {
    const rsi1Series = calcRSISeries(closes1h, 14);
    const r1 = rsi1Series[rsi1Series.length - 1];
    if (r1 !== undefined) {
      if (r1 > 75) comp.rsi += 0.8;
      else if (r1 > 70) comp.rsi += 0.4;
      else if (r1 < 25) comp.rsi -= 0.8;
      else if (r1 < 30) comp.rsi -= 0.4;
    }
  }

  // ── Layer 2: Stochastic (4h) ──
  const sk4 = calcStochRaw(klines4h, 14);
  const sk4p = calcStochRaw(klines4h.slice(0, -1), 14);
  if (sk4 !== null && sk4p !== null) {
    if (sk4 > 80 && sk4 < sk4p) comp.stoch += 0.8;
    if (sk4 < 20 && sk4 > sk4p) comp.stoch -= 0.8;
  }

  // ── Layer 3: Bollinger %B (4h) ──
  const bb = calcBollingerPctB(closes4h, 20, 2);
  if (bb !== null) {
    if (bb > 1.1) comp.bollinger += 0.8;
    else if (bb > 0.95) comp.bollinger += 0.4;
    else if (bb < -0.1) comp.bollinger -= 0.8;
    else if (bb < 0.05) comp.bollinger -= 0.4;
  }

  // ── Layer 4: MACD histogram declining (4h) ──
  const macdNow = calcMACD(closes4h);
  const macdPrev = calcMACD(closes4h.slice(0, -1));
  const macdPrev2 = calcMACD(closes4h.slice(0, -2));
  if (
    macdNow.histogram !== null &&
    macdPrev.histogram !== null &&
    macdPrev2.histogram !== null
  ) {
    const m = macdNow.histogram, mp = macdPrev.histogram, mpp = macdPrev2.histogram;
    if (m > 0 && m < mp && mp < mpp) comp.macd += 0.4; // bearish momentum fade
    if (m < 0 && m > mp && mp > mpp) comp.macd -= 0.4; // bullish momentum fade
  }

  // ── Layer 5: Funding rate (crowding — strongest signal) ──
  let fundingPct: number | null = null;
  if (fundingRate !== null) {
    fundingPct = fundingRate * 100;
    const fr = fundingRate;
    if (fr > 0.0005) comp.funding += 2.0;      // very extreme (~180% APR) → LONGS crowded
    else if (fr > 0.0003) comp.funding += 1.5; // extreme
    else if (fr > 0.0001) comp.funding += 0.8; // elevated
    if (fr < -0.0001) comp.funding -= 1.5;     // SHORTS crowded → bullish
    else if (fr < -0.00005) comp.funding -= 0.8;
  }

  const raw =
    comp.rsi + comp.stoch + comp.bollinger + comp.macd + comp.funding;

  let zone: RCIResult["zone"] = "NEUTRAL";
  if (raw > 4.0) zone = "BEAR_STRONG";
  else if (raw > 3.0) zone = "BEAR_WATCH";
  else if (raw < -2.5) zone = "BULL_STRONG";
  else if (raw < -1.5) zone = "BULL_WATCH";

  return { value: raw, zone, components: comp, fundingPct };
}

export function zoneLabel(zone: RCIResult["zone"]): string {
  switch (zone) {
    case "BEAR_STRONG": return "ĐỈNH — áp lực quay đầu MẠNH";
    case "BEAR_WATCH":  return "Cảnh báo đỉnh — giảm size";
    case "BULL_STRONG": return "ĐÁY — áp lực bật lên MẠNH";
    case "BULL_WATCH":  return "Cảnh báo đáy — chờ entry";
    default:            return "Trung tính";
  }
}
