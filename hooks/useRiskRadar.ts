/**
 * useRiskRadar — compute live market state vs các lesson-learn "nên tránh"
 * và "cơ hội vàng" từ scan-features.ts (LONG + SHORT, TP+5/SL-2).
 *
 * Mỗi lần rawKlines update (~60s), eval lại hết các warning + golden.
 * KHÔNG fetch thêm data — reuse klines sẵn có (15m, 1h, 4h).
 *
 * Lesson learn nguồn:
 *   - LONG baseline 1h WR 25% → cần filter mạnh
 *   - HTF 4h DOWN → LONG WR 15.7% (đừng LONG)
 *   - EMA50 > 2% (1h) → LONG WR 17.4%
 *   - RSI < 30 (1h) → LONG WR 17.6% (bắt đáy dao rơi)
 *   - 15m ATR<0.3% → LONG WR 9.5%
 *   - SHORT: HTF 4h UP → SHORT thua
 *   - SHORT: RSI > 70 (1h) → còn momentum
 *   - GOLDEN LONG: 1h ATR<0.3% + HTF 4h FLAT → WR 81% (N=84)
 *   - GOLDEN LONG triple: MACD 0-50 + EMA±0.5% + HTF FLAT → WR 95.2% (N=62)
 *   - GOLDEN SHORT triple: EMA±0.5% + ATR<0.3% + HTF UP → WR 86.7% (N=45)
 *
 * ⚠ FORWARD TEST 2026-04-22 (20K candles ~2.3Y, TP5/SL2):
 *   Scan claim WR 93-95% là OVERFIT. Actual WR rút gọn nhưng edge vẫn to vs
 *   baseline 35.5%:
 *     R1 macd+ema+FLAT  → WR 64.9% N=405 PF 3.90
 *     R2 macd+atr+FLAT  → WR 67.4% N=181 PF 3.82 (MỚI)
 *     R3 atr+ema+FLAT   → WR 60.4% N=323 PF 2.59
 *     QUADRUPLE (macd+ema+atr+FLAT) → WR 71.8% N=163 PF 4.69  🥇 MEGA
 *   Hiển thị con số FORWARD (honest), KHÔNG dùng claim 93-95%.
 *
 * ⚠ SHORT REVAMP 2026-04-22:
 *   Golden SHORT cũ (ema+atr+UP claim 86.7%) → verify bóc WR 34.36% (overfit).
 *   XÓA. Scan SHORT htf:DOWN thay thế, inject 3 rule có edge THẬT:
 *     SG1 ema20<ema50 + atr<0.3% + macd:-50..0 + DOWN → WR 69.6% N=46 PF 4.53
 *     SG2 ema20<ema50 + atr<0.3% + DOWN             → WR 64.9% N=174 PF 3.37
 *     SG3 macd:-50..0 + atr<0.3% + DOWN             → WR 62.9% N=62 PF 3.27
 *   Bài học: SHORT ăn khi XUÔI TREND DOWN, không phải chống trend UP.
 */
import { useMemo } from "react";
import { Kline, RawKlinesMap } from "./useBinanceKlines";
import { calcRSI, calcMACD, calcEMA, calcATRPct, calcBollinger } from "../utils/indicators";

export type WarningLevel = "danger" | "caution" | "safe";

export interface RiskWarning {
  id: string;
  level: WarningLevel;
  title: string;
  detail: string; // live value e.g. "HTF 4h EMA50 diff = -1.8%"
  lessonWR: string; // e.g. "WR 15.7%"
  active: boolean; // true = đang trigger (nên tránh)
}

export interface GoldenOpportunity {
  id: string;
  side: "LONG" | "SHORT";
  title: string;
  wr: string; // "WR 81% · N=84"
  conditions: { label: string; live: string; pass: boolean }[];
  allPass: boolean;
  tpSl: string; // "TP +5% / SL -2%"
}

export interface RiskRadarState {
  longWarnings: RiskWarning[];
  shortWarnings: RiskWarning[];
  goldens: GoldenOpportunity[];
  longScore: number; // 0-5: số "safe" trên tổng
  shortScore: number;
  verdict: "PREFER_LONG" | "PREFER_SHORT" | "NEUTRAL" | "AVOID_BOTH";
  liveSnapshot: {
    rsi1h: number | null;
    macdHist1h: number | null;
    atrPct1h: number | null;
    atrPct15m: number | null;
    atrPct4h: number | null;
    emaDist1h: number | null; // (price - EMA50)/EMA50 * 100
    emaDist4h: number | null;
    htf4hState: "UP" | "DOWN" | "FLAT" | "NA";
  };
}

/** Compute EMA50 distance % from price for latest candle */
function emaDistPct(klines: Kline[]): number | null {
  if (klines.length < 50) return null;
  const closes = klines.map((k) => k.close);
  const ema = calcEMA(closes, 50);
  if (ema === null) return null;
  const last = closes[closes.length - 1];
  return ((last - ema) / ema) * 100;
}

function htfStateFromDist(dist: number | null): "UP" | "DOWN" | "FLAT" | "NA" {
  if (dist === null) return "NA";
  if (dist > 0.5) return "UP";
  if (dist < -0.5) return "DOWN";
  return "FLAT";
}

export function useRiskRadar(rawKlines: RawKlinesMap): RiskRadarState {
  return useMemo(() => {
    const k15m = rawKlines["15m"] || [];
    const k1h = rawKlines["1h"] || [];
    const k4h = rawKlines["4h"] || [];

    // ── Live snapshot ──
    const closes1h = k1h.map((k) => k.close);
    const rsi1h = closes1h.length >= 15 ? calcRSI(closes1h) : null;
    const macd1h = closes1h.length >= 35 ? calcMACD(closes1h) : { histogram: null };
    const atrPct1h = calcATRPct(k1h);
    const atrPct15m = calcATRPct(k15m);
    const atrPct4h = calcATRPct(k4h);
    const emaDist1h = emaDistPct(k1h);
    const emaDist4h = emaDistPct(k4h);
    const htf4hState = htfStateFromDist(emaDist4h);

    // ── NEW features (Plan C — extended scan verified) ──
    // EMA20 vs EMA50 cross (1h)
    const ema20_1h = closes1h.length >= 20 ? calcEMA(closes1h, 20) : null;
    const ema50_1h = closes1h.length >= 50 ? calcEMA(closes1h, 50) : null;
    const emaCrossBull = ema20_1h !== null && ema50_1h !== null ? ema20_1h > ema50_1h : null;

    // Bollinger width % (1h, period 20, mult 2)
    const bb1h = closes1h.length >= 20 ? calcBollinger(closes1h, 20, 2) : { upper: null, middle: null, lower: null };
    const bbWidth1h = bb1h.upper !== null && bb1h.lower !== null && bb1h.middle !== null
      ? ((bb1h.upper - bb1h.lower) / bb1h.middle) * 100
      : null;

    // Candle body % (latest 1h)
    const lastBar = k1h[k1h.length - 1];
    const bodyPct1h = lastBar ? (Math.abs(lastBar.close - lastBar.open) / lastBar.open) * 100 : null;

    // 24h momentum % (close now vs close 24 bars ago)
    const mom24_1h = closes1h.length >= 25
      ? ((closes1h[closes1h.length - 1] - closes1h[closes1h.length - 25]) / closes1h[closes1h.length - 25]) * 100
      : null;

    // ── LONG warnings (đừng LONG khi thấy) ──
    const longWarnings: RiskWarning[] = [
      {
        id: "long_htf_down",
        level: htf4hState === "DOWN" ? "danger" : "safe",
        title: "HTF 4h DOWN",
        detail: emaDist4h !== null ? `EMA50 Δ = ${emaDist4h >= 0 ? "+" : ""}${emaDist4h.toFixed(2)}%` : "n/a",
        lessonWR: "WR 15.7%",
        active: htf4hState === "DOWN",
      },
      {
        id: "long_ema_far",
        level: emaDist1h !== null && emaDist1h > 2 ? "danger" : emaDist1h !== null && emaDist1h > 1.2 ? "caution" : "safe",
        title: "Giá 1h xa trên EMA50 (>2%)",
        detail: emaDist1h !== null ? `EMA50 Δ = +${emaDist1h.toFixed(2)}%` : "n/a",
        lessonWR: "WR 17.4%",
        active: emaDist1h !== null && emaDist1h > 2,
      },
      {
        id: "long_rsi_oversold",
        level: rsi1h !== null && rsi1h < 30 ? "danger" : rsi1h !== null && rsi1h < 35 ? "caution" : "safe",
        title: "RSI 1h < 30 (dao rơi)",
        detail: rsi1h !== null ? `RSI = ${rsi1h.toFixed(1)}` : "n/a",
        lessonWR: "WR 17.6%",
        active: rsi1h !== null && rsi1h < 30,
      },
      {
        id: "long_atr15m_low",
        level: atrPct15m !== null && atrPct15m < 0.3 ? "danger" : "safe",
        title: "15m ATR<0.3% (đừng LONG 15m)",
        detail: atrPct15m !== null ? `ATR = ${atrPct15m.toFixed(2)}%` : "n/a",
        lessonWR: "WR 9.5%",
        active: atrPct15m !== null && atrPct15m < 0.3,
      },
      {
        id: "long_macd_weak",
        level: macd1h.histogram !== null && macd1h.histogram < -50 ? "caution" : "safe",
        title: "MACD 1h Hist < -50 (momentum âm mạnh)",
        detail: macd1h.histogram !== null ? `MACD Hist = ${macd1h.histogram.toFixed(1)}` : "n/a",
        lessonWR: "WR 21.7%",
        active: macd1h.histogram !== null && macd1h.histogram < -50,
      },
      // NEW (Plan C extended scan verified on 2.3Y data)
      {
        id: "long_mom24_overheat",
        level: mom24_1h !== null && mom24_1h > 2 ? "danger" : mom24_1h !== null && mom24_1h > 1.2 ? "caution" : "safe",
        title: "24h momentum > +2% (overheat)",
        detail: mom24_1h !== null ? `Δ24h = ${mom24_1h >= 0 ? "+" : ""}${mom24_1h.toFixed(2)}%` : "n/a",
        lessonWR: "WR 23.1% (N=268)",
        active: mom24_1h !== null && mom24_1h > 2,
      },
      {
        id: "long_bb_expand",
        level: bbWidth1h !== null && bbWidth1h > 4 ? "danger" : bbWidth1h !== null && bbWidth1h > 3 ? "caution" : "safe",
        title: "BB width > 4% (breakout đã xong)",
        detail: bbWidth1h !== null ? `BB width = ${bbWidth1h.toFixed(2)}%` : "n/a",
        lessonWR: "WR 31.4% (N=344)",
        active: bbWidth1h !== null && bbWidth1h > 4,
      },
      {
        id: "long_body_big",
        level: bodyPct1h !== null && bodyPct1h > 1 ? "caution" : "safe",
        title: "Nến 1h body > 1% (chạy quá mạnh)",
        detail: bodyPct1h !== null ? `body = ${bodyPct1h.toFixed(2)}%` : "n/a",
        lessonWR: "WR 31.8% (N=88)",
        active: bodyPct1h !== null && bodyPct1h > 1,
      },
    ];

    // ── SHORT warnings (đừng SHORT khi thấy) ──
    const shortWarnings: RiskWarning[] = [
      {
        id: "short_htf_up",
        level: htf4hState === "UP" ? "danger" : "safe",
        title: "HTF 4h UP (đừng SHORT chống trend)",
        detail: emaDist4h !== null ? `EMA50 Δ = ${emaDist4h >= 0 ? "+" : ""}${emaDist4h.toFixed(2)}%` : "n/a",
        lessonWR: "edge -10%",
        active: htf4hState === "UP",
      },
      {
        id: "short_ema_low",
        level: emaDist1h !== null && emaDist1h < -2 ? "danger" : emaDist1h !== null && emaDist1h < -1.2 ? "caution" : "safe",
        title: "Giá 1h xa dưới EMA50 (<-2%)",
        detail: emaDist1h !== null ? `EMA50 Δ = ${emaDist1h.toFixed(2)}%` : "n/a",
        lessonWR: "rebound cao",
        active: emaDist1h !== null && emaDist1h < -2,
      },
      {
        id: "short_rsi_overbought",
        level: rsi1h !== null && rsi1h > 70 ? "danger" : rsi1h !== null && rsi1h > 65 ? "caution" : "safe",
        title: "RSI 1h > 70 (còn momentum)",
        detail: rsi1h !== null ? `RSI = ${rsi1h.toFixed(1)}` : "n/a",
        lessonWR: "SHORT WR thấp",
        active: rsi1h !== null && rsi1h > 70,
      },
    ];

    // ── GOLDEN opportunities ──
    // 2026-04-24: 8 golden LONG (quadruple/macd_flat/macd_atr_flat/atr_ema_flat/
    // atr_flat/cross_silent/doji_macd/bb_squeeze) đã xóa — backtest 1y per-rule
    // bóc NET = -$3,110/rule, WR 18.9%, PF 0.95 (engine không xử lý được features
    // array nên fallback sim default → 8 rule cùng kết quả LỖ).
    const goldens: GoldenOpportunity[] = [];

    // ⚠ 2026-04-22: Golden SHORT ema+atr+UP cũ (claim 86.7%) đã bị xóa vì
    // verify-all-goldens bóc actual WR 34.36% N=227 PF 1.01 (overfit).
    // Scan SHORT htf:DOWN thay thế đã tìm ra 3 rule CÓ edge THẬT (verified 2.3Y):

    // Golden SHORT #1 (🥇): emaCrossBear + atrLow + macdBear + htf:DOWN
    // Forward test 2.3Y: WR 69.57% · N=46 · PF 4.53 · Exp +1.84%/trade
    {
      const c1 = ema20_1h !== null && ema50_1h !== null && ema20_1h < ema50_1h;
      const c2 = atrPct1h !== null && atrPct1h < 0.3;
      const c3 = macd1h.histogram !== null && macd1h.histogram < 0 && macd1h.histogram > -50;
      const c4 = htf4hState === "DOWN";
      goldens.push({
        id: "golden_short_quadruple",
        side: "SHORT",
        title: "SHORT QUADRUPLE DOWN (🥇)",
        wr: "WR 69.6% · N=46 · PF 4.53",
        tpSl: "TP +5% / SL -2%",
        conditions: [
          { label: "EMA20 < EMA50 (1h)", live: ema20_1h !== null && ema50_1h !== null ? (ema20_1h < ema50_1h ? "BEAR" : "BULL") : "n/a", pass: c1 },
          { label: "ATR 1h < 0.3%", live: atrPct1h !== null ? `${atrPct1h.toFixed(2)}%` : "n/a", pass: c2 },
          { label: "MACD Hist 1h -50..0", live: macd1h.histogram !== null ? macd1h.histogram.toFixed(1) : "n/a", pass: c3 },
          { label: "HTF 4h DOWN", live: htf4hState, pass: c4 },
        ],
        allPass: c1 && c2 && c3 && c4,
      });
    }

    // Golden SHORT #2 (🥈): emaCrossBear + atrLow + htf:DOWN
    // Forward test 2.3Y: WR 64.94% · N=174 · PF 3.37 · Exp +1.67%/trade
    {
      const c1 = ema20_1h !== null && ema50_1h !== null && ema20_1h < ema50_1h;
      const c2 = atrPct1h !== null && atrPct1h < 0.3;
      const c3 = htf4hState === "DOWN";
      goldens.push({
        id: "golden_short_cross_silent",
        side: "SHORT",
        title: "SHORT EMA CROSS BEAR + SILENT",
        wr: "WR 64.9% · N=174 · PF 3.37",
        tpSl: "TP +5% / SL -2%",
        conditions: [
          { label: "EMA20 < EMA50 (1h)", live: ema20_1h !== null && ema50_1h !== null ? (ema20_1h < ema50_1h ? "BEAR" : "BULL") : "n/a", pass: c1 },
          { label: "ATR 1h < 0.3%", live: atrPct1h !== null ? `${atrPct1h.toFixed(2)}%` : "n/a", pass: c2 },
          { label: "HTF 4h DOWN", live: htf4hState, pass: c3 },
        ],
        allPass: c1 && c2 && c3,
      });
    }

    // Golden SHORT #3 (🥉): macdBear + atrLow + htf:DOWN
    // Forward test 2.3Y: WR 62.90% · N=62 · PF 3.27 · Exp +1.57%/trade
    {
      const c1 = macd1h.histogram !== null && macd1h.histogram < 0 && macd1h.histogram > -50;
      const c2 = atrPct1h !== null && atrPct1h < 0.3;
      const c3 = htf4hState === "DOWN";
      goldens.push({
        id: "golden_short_macd_silent",
        side: "SHORT",
        title: "SHORT MACD BEAR + SILENT",
        wr: "WR 62.9% · N=62 · PF 3.27",
        tpSl: "TP +5% / SL -2%",
        conditions: [
          { label: "MACD Hist 1h -50..0", live: macd1h.histogram !== null ? macd1h.histogram.toFixed(1) : "n/a", pass: c1 },
          { label: "ATR 1h < 0.3%", live: atrPct1h !== null ? `${atrPct1h.toFixed(2)}%` : "n/a", pass: c2 },
          { label: "HTF 4h DOWN", live: htf4hState, pass: c3 },
        ],
        allPass: c1 && c2 && c3,
      });
    }

    // ── Score & verdict ──
    const longSafeCount = longWarnings.filter((w) => !w.active).length;
    const shortSafeCount = shortWarnings.filter((w) => !w.active).length;
    const longScore = longSafeCount; // out of 5
    const shortScore = shortSafeCount; // out of 3

    let verdict: RiskRadarState["verdict"] = "NEUTRAL";
    const longPct = longSafeCount / longWarnings.length;
    const shortPct = shortSafeCount / shortWarnings.length;
    if (longPct >= 0.8 && shortPct < 0.5) verdict = "PREFER_LONG";
    else if (shortPct >= 0.8 && longPct < 0.5) verdict = "PREFER_SHORT";
    else if (longPct < 0.5 && shortPct < 0.5) verdict = "AVOID_BOTH";

    return {
      longWarnings,
      shortWarnings,
      goldens,
      longScore,
      shortScore,
      verdict,
      liveSnapshot: {
        rsi1h,
        macdHist1h: macd1h.histogram ?? null,
        atrPct1h,
        atrPct15m,
        atrPct4h,
        emaDist1h,
        emaDist4h,
        htf4hState,
      },
    };
  }, [rawKlines]);
}
