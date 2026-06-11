import { useMemo } from "react";
import { computeTrend, TrendResult } from "../utils/trend";
import { RawKlinesMap } from "./useBinanceKlines";

/** Trend Direction Index từ klines 4h + 1h (đa-TF, không cần funding). */
export function useTrend(rawKlines: RawKlinesMap): TrendResult {
  return useMemo(() => {
    const k4 = rawKlines["4h"] ?? [];
    const k1 = rawKlines["1h"] ?? [];
    return computeTrend({
      klines4h: k4,
      klines1h: k1,
    });
  }, [rawKlines]);
}
