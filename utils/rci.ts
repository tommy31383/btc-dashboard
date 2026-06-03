/**
 * rci.ts — Reversal Confluence Index (RCI v4)
 *
 * Một đường oscillator âm/dương xác định thời điểm giá quay đầu (đỉnh/đáy).
 *   Dương (+) = bearish pressure (đỉnh sắp quay đầu xuống)
 *   Âm  (−)  = bullish pressure (đáy sắp quay đầu lên)
 *
 * Backtest 7y (docs/rci-v4-research-2026-06-03.md):
 *   v4 = v3 + Group3 (ADX slope + Funding Accel + Vol Exhaustion)
 *   thr=2.5 → 63.2% precision, 16 signals/yr, 6/6 years robust
 *   OOS (2023-2026): 57.1% precision
 *
 * Weight: Funding ×2.0 + RSI ×1.5 + Stoch ×0.8 + BB ×0.8 + MACD ×0.4
 *       + ADX slope ×0.8 + Funding acceleration ×1.2 + Vol exhaustion ×0.8
 *
 * Rejected (Group1 HTF — too sticky, hurts precision):
 *   RSI-1d, BB%B-1w, EMA200 distance fire on 39.8% of bars → noise.
 */
import { calcRSISeries, calcBollinger, calcMACD } from "./indicators";

export interface RCIInput {
  closes4h: number[];
  closes1h: number[];
  klines4h: { high: number; low: number; close: number; volume: number }[];
  fundingRate: number | null;     // current funding rate (decimal, 0.0005 = 0.05%)
  prevFundingRate?: number | null; // previous 8h funding rate (for acceleration)
  adx4h?: number | null;          // ADX(14) current value
  adxPrev1?: number | null;       // ADX 1 bar ago
  adxPrev2?: number | null;       // ADX 2 bars ago
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
    adxSlope: number;      // v4 new
    fundingAccel: number;  // v4 new
    volExhaust: number;    // v4 new
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

/** Compute RCI v4 score from current market state. */
export function computeRCI(input: RCIInput): RCIResult {
  const { closes4h, closes1h, klines4h, fundingRate,
          prevFundingRate, adx4h, adxPrev1, adxPrev2 } = input;

  const comp = { rsi: 0, stoch: 0, bollinger: 0, macd: 0, funding: 0,
                 adxSlope: 0, fundingAccel: 0, volExhaust: 0 };

  // Need enough data
  if (closes4h.length < 30 || klines4h.length < 30) {
    return { value: null, zone: "NEUTRAL", components: comp, fundingPct: null };
  }

  // ── Layer 1: RSI (4h) — iter19-20 OOS audit: RSI>70 OOS 2023-26 prec=16% < base 27%
  // RSI weight CUT 50% — sustained bull market làm RSI overbought ≠ reversal OOS.
  // Giữ lại để display nhưng không dominant.
  const rsi4Series = calcRSISeries(closes4h, 14);
  const r4 = rsi4Series[rsi4Series.length - 1];
  const r4p = rsi4Series[rsi4Series.length - 2];
  if (r4 !== undefined) {
    if (r4 > 75) comp.rsi += 0.7;        // cut từ 1.5
    else if (r4 > 70) comp.rsi += 0.4;   // cut từ 1.0
    else if (r4 < 25) comp.rsi -= 0.7;
    else if (r4 < 30) comp.rsi -= 0.4;
    if (r4p !== undefined) {
      if (r4p > 70 && r4 < r4p) comp.rsi += 0.2;
      if (r4p < 30 && r4 > r4p) comp.rsi -= 0.2;
    }
  }
  if (closes1h.length >= 20) {
    const rsi1Series = calcRSISeries(closes1h, 14);
    const r1 = rsi1Series[rsi1Series.length - 1];
    if (r1 !== undefined) {
      if (r1 > 75) comp.rsi += 0.3;   // cut từ 0.8
      else if (r1 > 70) comp.rsi += 0.15;
      else if (r1 < 25) comp.rsi -= 0.3;
      else if (r1 < 30) comp.rsi -= 0.15;
    }
  }

  // ── Layer 2: Stochastic (4h) — iter20: Stoch>80 OOS 2023-26 prec=19% < base 27%
  // Weight cut 50%
  const sk4 = calcStochRaw(klines4h, 14);
  const sk4p = calcStochRaw(klines4h.slice(0, -1), 14);
  if (sk4 !== null && sk4p !== null) {
    if (sk4 > 80 && sk4 < sk4p) comp.stoch += 0.4;   // cut từ 0.8
    if (sk4 < 20 && sk4 > sk4p) comp.stoch -= 0.4;
  }

  // ── Layer 3: Bollinger %B (4h) — iter20: BB>0.95 OOS prec=20% < base 27%
  // Weight cut 50%
  const bb = calcBollingerPctB(closes4h, 20, 2);
  if (bb !== null) {
    if (bb > 1.1) comp.bollinger += 0.4;    // cut từ 0.8
    else if (bb > 0.95) comp.bollinger += 0.2;
    else if (bb < -0.1) comp.bollinger -= 0.4;
    else if (bb < 0.05) comp.bollinger -= 0.2;
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

  // ── Group3 NEW (v4): ADX slope + Funding acceleration + Volume exhaustion ──

  // ADX slope: ADX > 25 AND declining 3 bars (trend weakening)
  if (adx4h != null && adxPrev1 != null && adxPrev2 != null && adx4h > 25) {
    if (adx4h < adxPrev1 && adxPrev1 < adxPrev2) {
      const close = closes4h[closes4h.length - 1];
      const closePrev3 = closes4h.length >= 4 ? closes4h[closes4h.length - 4] : close;
      if (close > closePrev3) comp.adxSlope += 0.8;  // up-trend weakening = bearish
      else                    comp.adxSlope -= 0.8;  // down-trend weakening = bullish
    }
  }

  // Funding acceleration: funding > 0.03% AND > prev × 1.5
  if (fundingRate != null && prevFundingRate != null) {
    const fr = fundingRate; const pfr = prevFundingRate;
    if (fr > 0.0003 && pfr > 0 && fr > pfr * 1.5) comp.fundingAccel += 1.2;
    else if (fr < -0.0003 && pfr < 0 && fr < pfr * 1.5) comp.fundingAccel -= 1.2;
  }

  // Volume exhaustion: vol > vol_MA × 3 AND body < 20% of range
  if (klines4h.length >= 20) {
    const vols = klines4h.map((k) => k.volume);
    const volMa = vols.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const last = klines4h[klines4h.length - 1];
    const range = last.high - last.low;
    const body = Math.abs(last.close - (klines4h[klines4h.length - 2]?.close ?? last.close));
    if (last.volume > volMa * 3.0 && range > 0 && body / range < 0.20) {
      if (last.close > (klines4h[klines4h.length - 2]?.close ?? last.close))
        comp.volExhaust += 0.8;  // up-close climax = bearish
      else
        comp.volExhaust -= 0.8;  // down-close climax = bullish
    }
  }

  const raw =
    comp.rsi + comp.stoch + comp.bollinger + comp.macd + comp.funding +
    comp.adxSlope + comp.fundingAccel + comp.volExhaust;

  // v4 thresholds (calibrated to 7y backtest: thr=2.5 → 63.2% precision)
  let zone: RCIResult["zone"] = "NEUTRAL";
  if (raw > 3.0) zone = "BEAR_STRONG";
  else if (raw > 2.5) zone = "BEAR_WATCH";
  else if (raw < -3.0) zone = "BULL_STRONG";
  else if (raw < -2.5) zone = "BULL_WATCH";

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
