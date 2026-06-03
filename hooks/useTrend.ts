import { useMemo } from "react";
import { computeTrend, TrendResult } from "../utils/trend";
import { RawKlinesMap } from "./useBinanceKlines";

/** Trend Direction Index từ klines 4h + 1h (đa-TF, không cần funding). */
export function useTrend(rawKlines: RawKlinesMap): TrendResult {
  return useMemo(() => {
    const k4 = rawKlines["4h"] ?? [];
    const k1 = rawKlines["1h"] ?? [];
    return computeTrend({
      closes4h: k4.map((k) => k.close),
      closes1h: k1.map((k) => k.close),
      klines4h: k4,
    });
  }, [rawKlines]);
}
