/**
 * trend.ts — Trend Direction Index (xu hướng chart, đa-TF)
 *
 * TÁCH BIỆT khỏi RCI: RCI = reversal timing (đỉnh/đáy), Trend = DIRECTION (lên/xuống).
 * Theo framework đã validate (general-trend-method-framework):
 *   DIRECTION follow trend đa-TF, ADX/DI là king, mean-rev thua.
 *
 * Nguồn xu hướng (4h primary + 1h confirm):
 *   1. EMA stack alignment (EMA20 > EMA50 > EMA200 = up, đảo = down)
 *   2. Giá so với EMA50 (above = bull bias)
 *   3. ADX/DI: DI+ > DI- + ADX>25 = trend mạnh có hướng
 *   4. EMA50 slope (dốc lên/xuống)
 *   5. 1h EMA20 vs EMA50 confirm (cùng hướng = cộng điểm)
 *
 * Score dương = UP, âm = DOWN. |ADX| quyết định STRONG vs thường.
 */
import { calcEMA, calcEMASeries } from "./indicators";

export interface TrendInput {
  closes4h: number[];
  closes1h: number[];
  klines4h: { high: number; low: number; close: number }[];
}

export type TrendZone = "STRONG_DOWN" | "DOWN" | "RANGE" | "UP" | "STRONG_UP";

export interface TrendResult {
  value: number | null;       // trend score (dương=up, âm=down)
  zone: TrendZone;
  adx: number | null;         // ADX(14) 4h
  diPlus: number | null;
  diMinus: number | null;
  components: {
    emaStack: number;   // EMA alignment 4h
    priceVsEma: number; // giá vs EMA50 4h
    di: number;         // DI+ vs DI- (gated by ADX)
    slope: number;      // EMA50 slope 4h
    confirm1h: number;  // 1h EMA confirm
  };
}

/** Wilder ADX + DI+/DI- (4h). Trả ADX hiện tại + DI cuối. */
function calcADXDI(
  bars: { high: number; low: number; close: number }[],
  period = 14
): { adx: number | null; diPlus: number | null; diMinus: number | null } {
  const n = bars.length;
  if (n < period * 3) return { adx: null, diPlus: null, diMinus: null };
  const tr: number[] = [0], pdm: number[] = [0], ndm: number[] = [0];
  for (let i = 1; i < n; i++) {
    const up = bars[i].high - bars[i - 1].high;
    const dn = bars[i - 1].low - bars[i].low;
    pdm.push(up > dn && up > 0 ? up : 0);
    ndm.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close),
    ));
  }
  let atr = tr.slice(1, period + 1).reduce((a, b) => a + b, 0);
  let sp = pdm.slice(1, period + 1).reduce((a, b) => a + b, 0);
  let sn = ndm.slice(1, period + 1).reduce((a, b) => a + b, 0);
  const dx: number[] = [];
  let lastPDI = 0, lastNDI = 0;
  for (let i = period + 1; i < n; i++) {
    atr = atr - atr / period + tr[i];
    sp = sp - sp / period + pdm[i];
    sn = sn - sn / period + ndm[i];
    const pDI = atr > 0 ? (100 * sp) / atr : 0;
    const nDI = atr > 0 ? (100 * sn) / atr : 0;
    lastPDI = pDI; lastNDI = nDI;
    const sum = pDI + nDI;
    dx.push(sum > 0 ? (100 * Math.abs(pDI - nDI)) / sum : 0);
  }
  if (dx.length < period) return { adx: null, diPlus: null, diMinus: null };
  let adx = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dx.length; i++) {
    adx = (adx * (period - 1) + dx[i]) / period;
  }
  return { adx, diPlus: lastPDI, diMinus: lastNDI };
}

/** Compute Trend Direction Index từ market state. */
export function computeTrend(input: TrendInput): TrendResult {
  const { closes4h, closes1h, klines4h } = input;
  const comp = { emaStack: 0, priceVsEma: 0, di: 0, slope: 0, confirm1h: 0 };

  if (closes4h.length < 200 || klines4h.length < 50) {
    return { value: null, zone: "RANGE", adx: null, diPlus: null, diMinus: null, components: comp };
  }

  const price = closes4h[closes4h.length - 1];
  const ema20 = calcEMA(closes4h, 20);
  const ema50 = calcEMA(closes4h, 50);
  const ema200 = calcEMA(closes4h, 200);

  // ── 1. EMA stack alignment (4h) ──
  if (ema20 != null && ema50 != null && ema200 != null) {
    if (ema20 > ema50 && ema50 > ema200) comp.emaStack += 1.5;       // full bull stack
    else if (ema20 > ema50) comp.emaStack += 0.7;                     // partial up
    if (ema20 < ema50 && ema50 < ema200) comp.emaStack -= 1.5;        // full bear stack
    else if (ema20 < ema50) comp.emaStack -= 0.7;                     // partial down
  }

  // ── 2. Giá vs EMA50 ──
  if (ema50 != null) {
    if (price > ema50) comp.priceVsEma += 0.8;
    else comp.priceVsEma -= 0.8;
  }

  // ── 3. ADX/DI (v3: trọng số DI tăng — backtest 7y, DI là driver phía down) ──
  const { adx, diPlus, diMinus } = calcADXDI(klines4h, 14);
  if (adx != null && diPlus != null && diMinus != null) {
    if (adx > 25) {
      if (diPlus > diMinus) comp.di += 2.0;   // trend mạnh hướng lên
      else comp.di -= 2.0;                      // trend mạnh hướng xuống
    } else if (adx > 18) {
      if (diPlus > diMinus) comp.di += 0.8;
      else comp.di -= 0.8;
    }
    // ADX < 18 = không có trend rõ → di = 0 (range)
  }

  // ── 4. EMA50 slope (4h, so 5 bar trước) ──
  const ema50Series = calcEMASeries(closes4h, 50);
  const e50now = ema50Series[ema50Series.length - 1];
  const e50prev = ema50Series[ema50Series.length - 6];
  if (e50now != null && e50prev != null && e50prev !== 0) {
    const slopePct = ((e50now - e50prev) / e50prev) * 100;
    if (slopePct > 0.5) comp.slope += 0.7;
    else if (slopePct > 0.1) comp.slope += 0.3;
    else if (slopePct < -0.5) comp.slope -= 0.7;
    else if (slopePct < -0.1) comp.slope -= 0.3;
  }

  // ── 5. 1h confirm (EMA20 vs EMA50) ──
  if (closes1h.length >= 50) {
    const e20_1h = calcEMA(closes1h, 20);
    const e50_1h = calcEMA(closes1h, 50);
    if (e20_1h != null && e50_1h != null) {
      if (e20_1h > e50_1h) comp.confirm1h += 0.5;
      else comp.confirm1h -= 0.5;
    }
  }

  const value =
    comp.emaStack + comp.priceVsEma + comp.di + comp.slope + comp.confirm1h;

  // ── Zone (v3: thresholds + gates calibrate 7y backtest, docs/trend-backtest-iter1-3) ──
  // Edge nằm ở 2 zone STRONG (excess ±0.65/0.83%/5d). STRONG cần xác nhận cấu trúc:
  //   STRONG_DOWN: ADX>25 + giá < EMA200 + EMA200 dốc xuống (bear thật, không phải dip)
  //   STRONG_UP:   ADX>25 + EMA200 dốc lên
  const strong = adx != null && adx > 25;
  const below200 = ema200 != null && price < ema200;
  // EMA200 slope (10 bar)
  let ema200Up = true, ema200Down = true;
  const e200Series = calcEMASeries(closes4h, 200);
  const e200now = e200Series[e200Series.length - 1];
  const e200prev = e200Series[e200Series.length - 11];
  if (e200now != null && e200prev != null && e200prev !== 0) {
    const s200 = ((e200now - e200prev) / e200prev) * 100;
    ema200Up = s200 > 0; ema200Down = s200 < 0;
  }

  let zone: TrendZone = "RANGE";
  if (value > 1.6) {
    zone = strong && value > 3.0 && ema200Up ? "STRONG_UP" : "UP";
  } else if (value < -1.6) {
    const strongDown = strong && value < -3.0 && below200 && ema200Down;
    zone = strongDown ? "STRONG_DOWN" : "DOWN";
  }

  return { value, zone, adx, diPlus, diMinus, components: comp };
}

export function trendLabel(zone: TrendZone): string {
  switch (zone) {
    case "STRONG_UP":   return "XU HƯỚNG TĂNG MẠNH ▲▲";
    case "UP":          return "Xu hướng tăng ▲";
    case "STRONG_DOWN": return "XU HƯỚNG GIẢM MẠNH ▼▼";
    case "DOWN":        return "Xu hướng giảm ▼";
    default:            return "Đi ngang / sideway ◆";
  }
}
