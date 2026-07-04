export type IndicatorKey =
  | "ema"
  | "bb"
  | "supertrend"
  | "vwap"
  | "rsi"
  | "stochRsi"
  | "macd"
  | "adx"
  | "mlRsi"
  | "smc"
  | "sr"
  | "rules"
  | "signalForge"
  | "volumeCandle";

export type IndicatorPlacement = "overlay" | "pane" | "priceLine";

export interface IndicatorDef {
  key: IndicatorKey;
  label: string;
  group: "overlay" | "oscillator";
  placement: IndicatorPlacement;
}

// Order here is the fixed pane-assignment order for "pane" placement
// indicators — pane index is 1 + position among *currently enabled*
// pane indicators, recomputed on every toggle.
export const INDICATORS: IndicatorDef[] = [
  { key: "ema", label: "EMA 9 / 21", group: "overlay", placement: "overlay" },
  { key: "bb", label: "Bollinger Bands (20,2)", group: "overlay", placement: "overlay" },
  { key: "supertrend", label: "SuperTrend (10,3)", group: "overlay", placement: "overlay" },
  { key: "vwap", label: "VWAP (daily anchor)", group: "overlay", placement: "overlay" },
  { key: "sr", label: "Support/Resistance", group: "overlay", placement: "priceLine" },
  { key: "rules", label: "Rule Entry/TP/SL", group: "overlay", placement: "priceLine" },
  { key: "signalForge", label: "Signal Forge", group: "overlay", placement: "priceLine" },
  { key: "smc", label: "Smart Money Concepts", group: "overlay", placement: "priceLine" },
  { key: "volumeCandle", label: "Volume Candle", group: "overlay", placement: "overlay" },
  { key: "rsi", label: "RSI (14)", group: "oscillator", placement: "pane" },
  { key: "mlRsi", label: "ML RSI (Zeiierman)", group: "oscillator", placement: "pane" },
  { key: "stochRsi", label: "Stoch RSI (14,14,3,3)", group: "oscillator", placement: "pane" },
  { key: "macd", label: "MACD (12,26,9)", group: "oscillator", placement: "pane" },
  { key: "adx", label: "ADX / DMI (14)", group: "oscillator", placement: "pane" },
];

export const DEFAULT_ENABLED_INDICATORS: IndicatorKey[] = ["ema", "supertrend", "sr", "rules"];

const VALID_KEYS = new Set<IndicatorKey>(INDICATORS.map((i) => i.key));

// Defensive parse for AsyncStorage payload: invalid JSON, non-array, or
// empty-after-filtering all fall back to the default set. Unknown keys
// (from a prior app version) are dropped; duplicates are deduped.
export function parseStoredIndicators(raw: string | null): IndicatorKey[] {
  if (!raw) return DEFAULT_ENABLED_INDICATORS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_ENABLED_INDICATORS;
  }
  if (!Array.isArray(parsed)) return DEFAULT_ENABLED_INDICATORS;
  // A genuinely empty stored array means the user deliberately disabled
  // every indicator — that's a valid preference, not corrupted data, so
  // it must round-trip as [] rather than snapping back to the default set.
  if (parsed.length === 0) return [];
  const filtered = Array.from(new Set(parsed)).filter((k): k is IndicatorKey => VALID_KEYS.has(k as IndicatorKey));
  // Only fall back to default when the array had content but NONE of it
  // matched a known key (e.g. all-stale keys from a removed prior version).
  return filtered.length > 0 ? filtered : DEFAULT_ENABLED_INDICATORS;
}

export const CHART_INDICATORS_STORAGE_KEY = "@chart_indicators_v1";
