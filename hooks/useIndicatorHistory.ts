/**
 * useIndicatorHistory — lấy mẫu giá trị indicator (RSI/MACD H/ATR%/EMA Dist%)
 * trên mỗi TF mỗi 5 phút để LiveRulesSummary tính slope → project ETA.
 *
 * Buffer giữ tối đa 12 mẫu (≈1h history) — đủ để fit linear slope cho
 * ATR%/MACD/EMA Dist mà không bị nhiễu bởi 1 cây nến đột biến.
 */
import { useEffect, useRef, useState } from "react";
import { TFAnalysis } from "./useBinanceKlines";

export type IndKey = "atr" | "macdH" | "emaDist" | "rsi";
export interface IndSample { t: number; v: number }
export type IndHistory = Record<string /* tfKey */, Record<IndKey, IndSample[]>>;

const SAMPLE_INTERVAL_MS = 20 * 1000;     // 20s
const MAX_SAMPLES = 60;                   // ≈20 phút rolling window (60 × 20s)

function pushSample(arr: IndSample[], t: number, v: number | null) {
  if (v === null || !isFinite(v)) return;
  arr.push({ t, v });
  if (arr.length > MAX_SAMPLES) arr.shift();
}

export function useIndicatorHistory(tfData: TFAnalysis[]): IndHistory {
  const histRef = useRef<IndHistory>({});
  const [tick, setTick] = useState(0);
  const tfDataRef = useRef(tfData);
  tfDataRef.current = tfData;

  useEffect(() => {
    function sample() {
      const now = Date.now();
      for (const tf of tfDataRef.current) {
        if (!histRef.current[tf.key]) {
          histRef.current[tf.key] = { atr: [], macdH: [], emaDist: [], rsi: [] };
        }
        const h = histRef.current[tf.key];
        pushSample(h.atr,     now, tf.atrPct);
        pushSample(h.macdH,   now, tf.macdHistogram);
        pushSample(h.emaDist, now, tf.emaDistPct);
        pushSample(h.rsi,     now, tf.rsi);
      }
      setTick((n) => n + 1);
    }
    sample(); // immediate first sample on mount
    const id = setInterval(sample, SAMPLE_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  // tick is a re-render trigger (the ref content drives ETA computation)
  void tick;
  return histRef.current;
}

// ─── Helpers used by LiveRulesSummary ──────────────────────────────────────

export interface ParsedLabel {
  ind: IndKey;
  op: "<" | ">" | "<=" | ">=" | "between";
  val?: number;
  min?: number;
  max?: number;
}

/** Map label name prefix → IndKey */
function indFromName(name: string): IndKey | null {
  const n = name.trim().toUpperCase();
  if (n.startsWith("ATR")) return "atr";
  if (n.startsWith("MACD")) return "macdH";
  if (n.startsWith("EMA DIST")) return "emaDist";
  if (n.startsWith("RSI")) return "rsi";
  return null;
}

/**
 * Parse formatFeatFilter labels:
 *   "ATR% < 0.3"
 *   "MACD Hist > 100"
 *   "MACD Hist ∈ [0, 100]"
 *   "EMA Dist% >= -0.5"
 *   "RSI < 30"
 * Returns null nếu label không phải continuous-numeric (event filters).
 */
export function parseFilterLabel(label: string): ParsedLabel | null {
  // between: "<NAME> ∈ [<min>, <max>]"
  const between = label.match(/^(.+?)\s+∈\s+\[\s*([-+\d.∞]+)\s*,\s*([-+\d.∞]+)\s*\]\s*$/);
  if (between) {
    const ind = indFromName(between[1]);
    if (!ind) return null;
    const min = between[2] === "-∞" ? -Infinity : parseFloat(between[2]);
    const max = between[3] === "+∞" ?  Infinity : parseFloat(between[3]);
    if (isNaN(min) || isNaN(max)) return null;
    return { ind, op: "between", min, max };
  }
  // simple: "<NAME> <op> <value>"
  const simple = label.match(/^(.+?)\s+(<=|>=|<|>)\s+([-+\d.]+)\s*$/);
  if (simple) {
    const ind = indFromName(simple[1]);
    if (!ind) return null;
    const val = parseFloat(simple[3]);
    if (isNaN(val)) return null;
    return { ind, op: simple[2] as ParsedLabel["op"], val };
  }
  return null;
}

export interface ETAResult {
  direction: "approaching" | "away" | "stable" | "insufficient";
  etaMinutes?: number;          // only when "approaching"
  current?: number;
  slopePerHour?: number;
}

function linearSlope(samples: IndSample[]): { slope: number; intercept: number } | null {
  if (samples.length < 2) return null;
  const t0 = samples[0].t;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  const n = samples.length;
  for (const s of samples) {
    const x = (s.t - t0) / 60000; // minutes since first sample
    const y = s.v;
    sumX += x; sumY += y; sumXY += x * y; sumXX += x * x;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom; // value per minute
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

/** Compute ETA in minutes for a parsed label using sample history. */
export function estimateETA(
  history: IndHistory,
  tfKey: string,
  parsed: ParsedLabel,
): ETAResult {
  const tfHist = history[tfKey];
  if (!tfHist) return { direction: "insufficient" };
  const samples = tfHist[parsed.ind];
  if (!samples || samples.length < 3) return { direction: "insufficient" };
  const fit = linearSlope(samples);
  if (!fit) return { direction: "insufficient" };
  const current = samples[samples.length - 1].v;
  const slopePerMin = fit.slope;
  const slopePerHour = slopePerMin * 60;

  // STABLE: slope cực nhỏ so với scale của giá trị → coi như đứng yên
  const scale = Math.max(1, Math.abs(current));
  if (Math.abs(slopePerHour) < scale * 0.005) {
    return { direction: "stable", current, slopePerHour };
  }

  function project(targetGap: number, requiredSlopeSign: 1 | -1): ETAResult {
    if (Math.sign(slopePerMin) !== requiredSlopeSign) {
      return { direction: "away", current, slopePerHour };
    }
    const eta = targetGap / Math.abs(slopePerMin);
    return { direction: "approaching", etaMinutes: eta, current, slopePerHour };
  }

  switch (parsed.op) {
    case "<":
    case "<=": {
      const target = parsed.val!;
      const gap = current - target;
      if (gap <= 0) return { direction: "approaching", etaMinutes: 0, current, slopePerHour };
      return project(gap, -1);
    }
    case ">":
    case ">=": {
      const target = parsed.val!;
      const gap = target - current;
      if (gap <= 0) return { direction: "approaching", etaMinutes: 0, current, slopePerHour };
      return project(gap, 1);
    }
    case "between": {
      const min = parsed.min!;
      const max = parsed.max!;
      if (current >= min && current <= max) {
        return { direction: "approaching", etaMinutes: 0, current, slopePerHour };
      }
      if (current < min) return project(min - current, 1);
      return project(current - max, -1);
    }
  }
  return { direction: "insufficient" };
}

export function formatETA(eta: ETAResult): string {
  if (eta.direction === "insufficient") return "đang gom mẫu...";
  if (eta.direction === "away") return "↗ đang đi xa";
  if (eta.direction === "stable") return "→ đứng yên";
  const m = eta.etaMinutes ?? 0;
  if (m <= 1) return "≈ngay";
  if (m < 60) return `~${Math.round(m)}m`;
  if (m < 60 * 24) return `~${(m / 60).toFixed(1)}h`;
  if (m < 60 * 24 * 30) return `~${(m / (60 * 24)).toFixed(1)}d`;
  return ">30d";
}
