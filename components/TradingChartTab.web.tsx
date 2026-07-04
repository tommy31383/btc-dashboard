import React, { useEffect, useMemo, useRef, useState } from "react";
import { View, StyleSheet, Text, Pressable, ScrollView } from "react-native";
import { createChart, createSeriesMarkers, IChartApi, ISeriesApi, IPriceLine, ISeriesMarkersPluginApi, SeriesMarker, ColorType, LineStyle, CandlestickSeries, HistogramSeries, LineSeries, UTCTimestamp, CandlestickData, HistogramData, LineData, WhitespaceData } from "lightweight-charts";
import { COLORS, TIMEFRAMES, TimeframeKey } from "../utils/constants";
import { P } from "../utils/v2Theme";
import { RawKlinesMap, closedKlines as getClosedKlines } from "../hooks/useBinanceKlines";
import { calcEMASeries, calcBollingerSeries, calcRSISeriesAligned, calcStochRSISeries, calcMACDSeries, calcADXSeries, calcSuperTrendSeries, calcVWAPSeries } from "../utils/indicators";
import { klinesToCandlestickData, klinesToVolumeData, klinesToVolumeCandleData } from "../utils/chartDataMapper";
import { useSymbolKlines } from "../hooks/useSymbolKlines";
import { VolumeCandleSeries } from "./volumeCandleSeries";
import { detectSRLevels } from "../utils/supportResistance";
import { RuleAlert } from "../hooks/useRuleAlerts";
import DebugLabel from "./DebugLabel";
import ChartIndicatorPanelWeb from "./ChartIndicatorPanel.web";
import { useChartIndicators } from "../hooks/useChartIndicators";
import { IndicatorKey } from "../utils/chartIndicators";
import {
  cloneSignalForgeConfig,
  DEFAULT_SIGNAL_FORGE_CONFIG,
  runSignalForge,
  SIGNAL_FORGE_INDICATOR_KEYS,
  SignalForgeConfig,
  SignalForgeIndicatorKey,
  SignalForgeResult,
  SignalForgeState,
  SignalForgeStats,
} from "../utils/signalForge";
import { runMlRsi } from "../utils/mlRsi";

interface Props {
  rawKlines: RawKlinesMap;
  selectedTF: TimeframeKey;
  onSelectTF: (tf: TimeframeKey) => void;
  activeAlerts: RuleAlert[];
}

interface OverlaySeriesRefs {
  ema9SeriesRef: React.MutableRefObject<ISeriesApi<"Line"> | null>;
  ema21SeriesRef: React.MutableRefObject<ISeriesApi<"Line"> | null>;
  bbUpperSeriesRef: React.MutableRefObject<ISeriesApi<"Line"> | null>;
  bbLowerSeriesRef: React.MutableRefObject<ISeriesApi<"Line"> | null>;
  superTrendSeriesRef: React.MutableRefObject<ISeriesApi<"Line"> | null>;
  mlSuperTrendUpSeriesRef: React.MutableRefObject<ISeriesApi<"Line"> | null>;
  mlSuperTrendDownSeriesRef: React.MutableRefObject<ISeriesApi<"Line"> | null>;
  vwapSeriesRef: React.MutableRefObject<ISeriesApi<"Line"> | null>;
}

type SignalForgeRiskToggleKey = "enableTp" | "enableSl" | "enableTs";
type SignalForgeRiskNumberKey = "tpMultiplier" | "slMultiplier" | "tsMultiplier";
type LineOrWhitespace = LineData<UTCTimestamp> | WhitespaceData<UTCTimestamp>;

// Add/remove overlay (main-pane) series to match enabledIndicators.
// forceRecreate=true unconditionally removes+re-adds every currently-
// enabled overlay series (used after a candle-series swap, to restore
// correct z-order above the freshly-created candle series); forceRecreate
// =false (the normal path) only add/removes what actually changed.
function reconcileOverlaySeries(
  chart: IChartApi,
  enabledIndicators: IndicatorKey[],
  refs: OverlaySeriesRefs,
  forceRecreate: boolean
): void {
  const has = (k: IndicatorKey) => enabledIndicators.includes(k);
  const {
    ema9SeriesRef,
    ema21SeriesRef,
    bbUpperSeriesRef,
    bbLowerSeriesRef,
    superTrendSeriesRef,
    mlSuperTrendUpSeriesRef,
    mlSuperTrendDownSeriesRef,
    vwapSeriesRef,
  } = refs;

  if (forceRecreate) {
    (
      [
        ema9SeriesRef,
        ema21SeriesRef,
        bbUpperSeriesRef,
        bbLowerSeriesRef,
        superTrendSeriesRef,
        mlSuperTrendUpSeriesRef,
        mlSuperTrendDownSeriesRef,
        vwapSeriesRef,
      ] as const
    ).forEach((ref) => {
      if (ref.current) {
        chart.removeSeries(ref.current);
        ref.current = null;
      }
    });
  }

  if (has("ema") && !ema9SeriesRef.current) {
    ema9SeriesRef.current = chart.addSeries(LineSeries, { color: "#f7931a", lineWidth: 1, title: "EMA9" });
    ema21SeriesRef.current = chart.addSeries(LineSeries, { color: "#00bcd4", lineWidth: 1, title: "EMA21" });
  } else if (!has("ema") && ema9SeriesRef.current) {
    chart.removeSeries(ema9SeriesRef.current);
    chart.removeSeries(ema21SeriesRef.current!);
    ema9SeriesRef.current = null;
    ema21SeriesRef.current = null;
  }

  if (has("bb") && !bbUpperSeriesRef.current) {
    bbUpperSeriesRef.current = chart.addSeries(LineSeries, { color: "#888", lineWidth: 1, title: "BB Upper" });
    bbLowerSeriesRef.current = chart.addSeries(LineSeries, { color: "#888", lineWidth: 1, title: "BB Lower" });
  } else if (!has("bb") && bbUpperSeriesRef.current) {
    chart.removeSeries(bbUpperSeriesRef.current);
    chart.removeSeries(bbLowerSeriesRef.current!);
    bbUpperSeriesRef.current = null;
    bbLowerSeriesRef.current = null;
  }

  if (has("supertrend") && !superTrendSeriesRef.current) {
    superTrendSeriesRef.current = chart.addSeries(LineSeries, { color: COLORS.bull, lineWidth: 2, title: "SuperTrend" });
  } else if (!has("supertrend") && superTrendSeriesRef.current) {
    chart.removeSeries(superTrendSeriesRef.current);
    superTrendSeriesRef.current = null;
  }

  if (has("mlRsi") && !mlSuperTrendUpSeriesRef.current) {
    mlSuperTrendUpSeriesRef.current = chart.addSeries(LineSeries, { color: "#31d07f", lineWidth: 2, title: "ML ST Up" });
    mlSuperTrendDownSeriesRef.current = chart.addSeries(LineSeries, { color: "#ff5d73", lineWidth: 2, title: "ML ST Down" });
  } else if (!has("mlRsi") && mlSuperTrendUpSeriesRef.current) {
    chart.removeSeries(mlSuperTrendUpSeriesRef.current);
    chart.removeSeries(mlSuperTrendDownSeriesRef.current!);
    mlSuperTrendUpSeriesRef.current = null;
    mlSuperTrendDownSeriesRef.current = null;
  }

  if (has("vwap") && !vwapSeriesRef.current) {
    vwapSeriesRef.current = chart.addSeries(LineSeries, { color: "#ba68c8", lineWidth: 1, title: "VWAP" });
  } else if (!has("vwap") && vwapSeriesRef.current) {
    chart.removeSeries(vwapSeriesRef.current);
    vwapSeriesRef.current = null;
  }
}

type ChartSymbol = "BTC" | "ETH" | "ETHFI" | "SOL";
const CHART_SYMBOLS: ChartSymbol[] = ["BTC", "ETH", "ETHFI", "SOL"];
const SYMBOL_TO_BINANCE: Record<ChartSymbol, string> = {
  BTC: "BTCUSDT",
  ETH: "ETHUSDT",
  ETHFI: "ETHFIUSDT",
  SOL: "SOLUSDT",
};

function formatPct(value: number): string {
  if (value === Infinity) return "∞";
  if (!Number.isFinite(value)) return "--";
  return `${value.toFixed(1)}%`;
}

function formatNum(value: number): string {
  if (value === Infinity) return "∞";
  if (!Number.isFinite(value)) return "--";
  return value.toFixed(2);
}

function formatProfitFactor(value: number | null): string {
  return value === null ? "∞" : formatNum(value);
}

function signalText(signal: SignalForgeState): string {
  return signal;
}

function signalColor(signal: SignalForgeState): string {
  if (signal === "Bullish") return COLORS.bull;
  if (signal === "Bearish") return COLORS.bear;
  return P.dim;
}

const signalForgeInputStyle: React.CSSProperties = {
  width: 48,
  height: 22,
  border: `1px solid ${P.border}`,
  borderRadius: 4,
  background: P.bg,
  color: P.text,
  fontSize: 11,
  padding: "0 4px",
};

function statCells(stats: SignalForgeStats) {
  return [
    ["Trades", String(stats.totalTrades)],
    ["Wins", String(stats.wins)],
    ["Losses", String(stats.losses)],
    ["WR", formatPct(stats.winRate)],
    ["PF", formatProfitFactor(stats.profitFactor)],
    ["Net", formatPct(stats.netPnlPct)],
  ] as const;
}

interface SignalForgeDashboardProps {
  result: SignalForgeResult;
  config: SignalForgeConfig;
  summaryByKey: Map<SignalForgeIndicatorKey, SignalForgeResult["indicatorSummaries"][number]>;
  onToggleRequireAll: () => void;
  onToggleIndicator: (key: SignalForgeIndicatorKey) => void;
  onToggleRisk: (key: SignalForgeRiskToggleKey) => void;
  onRiskNumberChange: (key: SignalForgeRiskNumberKey, value: number) => void;
}

function SignalForgeDashboard({
  result,
  config,
  summaryByKey,
  onToggleRequireAll,
  onToggleIndicator,
  onToggleRisk,
  onRiskNumberChange,
}: SignalForgeDashboardProps) {
  const riskControls = [
    ["TP", "enableTp", "tpMultiplier", config.risk.tpMultiplier],
    ["SL", "enableSl", "slMultiplier", config.risk.slMultiplier],
    ["TS", "enableTs", "tsMultiplier", config.risk.tsMultiplier],
  ] as const;

  return (
    <View style={styles.signalForgePanel}>
      <View style={styles.signalForgeHeader}>
        <Text style={styles.signalForgeTitle}>Signal Forge</Text>
        <Pressable onPress={onToggleRequireAll} style={styles.signalForgeModeBtn}>
          <Text style={styles.signalForgeModeText}>{config.logic.requireAll ? "Require All" : "Any"}</Text>
        </Pressable>
      </View>

      <View style={styles.signalForgeStatsGrid}>
        {statCells(result.compositeStats).map(([label, value]) => (
          <View key={label} style={styles.signalForgeStatCell}>
            <Text style={styles.signalForgeStatLabel}>{label}</Text>
            <Text style={styles.signalForgeStatValue}>{value}</Text>
          </View>
        ))}
      </View>

      <View style={styles.signalForgeRiskRow}>
        {riskControls.map(([label, toggleKey, numberKey, value]) => (
          <View key={toggleKey} style={styles.signalForgeRiskControl}>
            <Pressable
              onPress={() => onToggleRisk(toggleKey)}
              style={[styles.signalForgeMiniToggle, config.risk[toggleKey] && styles.signalForgeMiniToggleActive]}
            >
              <Text style={[styles.signalForgeMiniToggleText, config.risk[toggleKey] && styles.signalForgeMiniToggleTextActive]}>{label}</Text>
            </Pressable>
            <input
              type="number"
              min="0.1"
              step="0.1"
              value={String(value)}
              onChange={(event) => onRiskNumberChange(numberKey, Number(event.currentTarget.value))}
              style={signalForgeInputStyle}
            />
          </View>
        ))}
      </View>

      <View style={styles.signalForgeTableHeader}>
        <Text style={[styles.signalForgeHeaderCell, styles.signalForgeNameCell]}>Indicator</Text>
        <Text style={[styles.signalForgeHeaderCell, styles.signalForgeStatusCell]}>State</Text>
        <Text style={[styles.signalForgeHeaderCell, styles.signalForgeNumCell]}>WR</Text>
        <Text style={[styles.signalForgeHeaderCell, styles.signalForgeNumCell]}>N</Text>
      </View>
      <ScrollView style={styles.signalForgeRows}>
        {SIGNAL_FORGE_INDICATOR_KEYS.map((key) => {
          const summary = summaryByKey.get(key);
          const enabled = config.indicators[key].enabled;
          const state = summary?.state ?? "Neutral";
          return (
            <View key={key} style={styles.signalForgeIndicatorRow}>
              <Pressable
                onPress={() => onToggleIndicator(key)}
                style={[styles.signalForgeMiniToggle, enabled && styles.signalForgeMiniToggleActive]}
              >
                <Text style={[styles.signalForgeMiniToggleText, enabled && styles.signalForgeMiniToggleTextActive]}>
                  {enabled ? "ON" : "OFF"}
                </Text>
              </Pressable>
              <Text style={[styles.signalForgeCellText, styles.signalForgeNameCell]} numberOfLines={1}>
                {summary?.label ?? key}
              </Text>
              <Text style={[styles.signalForgeCellText, styles.signalForgeStatusCell, { color: signalColor(state) }]}>
                {signalText(state)}
              </Text>
              <Text style={[styles.signalForgeCellText, styles.signalForgeNumCell]}>{formatPct(summary?.winRate ?? 0)}</Text>
              <Text style={[styles.signalForgeCellText, styles.signalForgeNumCell]}>{summary?.totalTrades ?? 0}</Text>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

export default function TradingChartTab({ rawKlines, selectedTF, onSelectTF, activeAlerts }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | ISeriesApi<"Custom"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const ema9SeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const ema21SeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const bbUpperSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const bbLowerSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const rsiSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const mlRsiSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const mlRsiSignalSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const stochKSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const stochDSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const macdHistSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const superTrendSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const mlSuperTrendUpSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const mlSuperTrendDownSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const vwapSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const plusDISeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const minusDISeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const adxSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const alertLinesRef = useRef<IPriceLine[]>([]);
  const signalForgeLinesRef = useRef<IPriceLine[]>([]);
  const signalForgeMarkersRef = useRef<ISeriesMarkersPluginApi<UTCTimestamp> | null>(null);
  const mlRsiMarkersRef = useRef<ISeriesMarkersPluginApi<UTCTimestamp> | null>(null);
  const [ready, setReady] = useState(false);
  const [oscillatorReconcileTick, setOscillatorReconcileTick] = useState(0);
  const [candleSwapTick, setCandleSwapTick] = useState(0);
  const { enabled: enabledIndicators, toggle: toggleIndicator, reset: resetIndicators } = useChartIndicators();
  const [signalForgeConfig, setSignalForgeConfig] = useState<SignalForgeConfig>(() => cloneSignalForgeConfig(DEFAULT_SIGNAL_FORGE_CONFIG));
  const [panelOpen, setPanelOpen] = useState(false);
  const indicatorBtnRef = useRef<View>(null);

  const [selectedSymbol, setSelectedSymbol] = useState<ChartSymbol>("BTC");
  const {
    rawKlines: fetchedKlines,
    loading: symbolLoading,
    error: symbolError,
  } = useSymbolKlines(selectedSymbol === "BTC" ? null : SYMBOL_TO_BINANCE[selectedSymbol]);

  // BTC reuses the rawKlines prop (already fetched app-wide for the rule
  // engine) — no second fetch. Non-BTC symbols use the standalone hook.
  // useSymbolKlines only returns non-empty rawKlines once they actually
  // belong to the selected symbol, so non-empty fetchedKlines here already
  // implies "matches selectedSymbol".
  const activeKlines = selectedSymbol === "BTC" ? rawKlines : fetchedKlines;
  const isSymbolDataReady = selectedSymbol === "BTC" || Object.keys(fetchedKlines).length > 0;
  const signalForgeEnabled = enabledIndicators.includes("signalForge");
  const signalForgeKlines = useMemo(
    () => (isSymbolDataReady ? getClosedKlines(activeKlines[selectedTF] ?? []) : []),
    [activeKlines, isSymbolDataReady, selectedTF]
  );
  const signalForgeAnalysis: SignalForgeResult | null = useMemo(
    () => (signalForgeEnabled && signalForgeKlines.length > 0 ? runSignalForge(signalForgeKlines, signalForgeConfig) : null),
    [signalForgeEnabled, signalForgeKlines, signalForgeConfig]
  );
  const signalForgeSummaryByKey = useMemo(
    () => new Map(signalForgeAnalysis?.indicatorSummaries.map((summary) => [summary.key, summary]) ?? []),
    [signalForgeAnalysis]
  );

  const toggleSignalForgeRequireAll = () => {
    setSignalForgeConfig((prev) => {
      const next = cloneSignalForgeConfig(prev);
      next.logic.requireAll = !next.logic.requireAll;
      return next;
    });
  };

  const toggleSignalForgeRisk = (key: SignalForgeRiskToggleKey) => {
    setSignalForgeConfig((prev) => {
      const next = cloneSignalForgeConfig(prev);
      next.risk[key] = !next.risk[key];
      return next;
    });
  };

  const toggleSignalForgeIndicator = (key: SignalForgeIndicatorKey) => {
    setSignalForgeConfig((prev) => {
      const next = cloneSignalForgeConfig(prev);
      next.indicators[key].enabled = !next.indicators[key].enabled;
      return next;
    });
  };

  const updateSignalForgeRiskNumber = (key: SignalForgeRiskNumberKey, value: number) => {
    if (!Number.isFinite(value) || value <= 0) return;
    setSignalForgeConfig((prev) => {
      const next = cloneSignalForgeConfig(prev);
      next.risk[key] = value;
      return next;
    });
  };

  // Mount chart once — only candlestick + volume. All indicator series are
  // managed reactively by the effects below, keyed on enabledIndicators.
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: { background: { type: ColorType.Solid, color: P.bg }, textColor: P.text },
      grid: { vertLines: { color: P.border }, horzLines: { color: P.border } },
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
      timeScale: { timeVisible: true, secondsVisible: false },
    });
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: COLORS.bull, downColor: COLORS.bear,
      borderUpColor: COLORS.bull, borderDownColor: COLORS.bear,
      wickUpColor: COLORS.bull, wickDownColor: COLORS.bear,
    });
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
    });
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    setReady(true);

    const handleResize = () => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth, height: containerRef.current.clientHeight });
      }
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      signalForgeMarkersRef.current?.detach();
      mlRsiMarkersRef.current?.detach();
      chart.remove();
      // chart.remove() disposes ALL series on it — every ref pointing at a
      // series on this chart must be cleared, not just chartRef/candleSeriesRef,
      // or a later remount's reconcile effects will call removeSeries() on a
      // stale series object from the disposed chart and throw ("Value is
      // undefined" — lightweight-charts' internal assertion).
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      ema9SeriesRef.current = null;
      ema21SeriesRef.current = null;
      bbUpperSeriesRef.current = null;
      bbLowerSeriesRef.current = null;
      rsiSeriesRef.current = null;
      mlRsiSeriesRef.current = null;
      mlRsiSignalSeriesRef.current = null;
      stochKSeriesRef.current = null;
      stochDSeriesRef.current = null;
      macdHistSeriesRef.current = null;
      superTrendSeriesRef.current = null;
      mlSuperTrendUpSeriesRef.current = null;
      mlSuperTrendDownSeriesRef.current = null;
      vwapSeriesRef.current = null;
      plusDISeriesRef.current = null;
      minusDISeriesRef.current = null;
      adxSeriesRef.current = null;
      priceLinesRef.current = [];
      alertLinesRef.current = [];
      signalForgeLinesRef.current = [];
      signalForgeMarkersRef.current = null;
      mlRsiMarkersRef.current = null;
    };
  }, []);

  // Reconcile overlay series (main pane 0) whenever the enabled set changes.
  // Overlay toggles never touch pane 1+, so no pane-index bug here — plain
  // add-if-missing / remove-if-present per key.
  useEffect(() => {
    if (!ready || !chartRef.current) return;
    reconcileOverlaySeries(chartRef.current, enabledIndicators, {
      ema9SeriesRef, ema21SeriesRef, bbUpperSeriesRef, bbLowerSeriesRef,
      superTrendSeriesRef, mlSuperTrendUpSeriesRef, mlSuperTrendDownSeriesRef, vwapSeriesRef,
    }, false);
  }, [ready, enabledIndicators]);

  // Full reconcile for oscillator-pane indicators (rsi/mlRsi/stochRsi/macd/adx).
  // addSeries(..., paneIndex) does NOT insert a pane in the middle — if
  // paneIndex already exists it just adds the series to that existing pane.
  // Incrementally toggling one oscillator on/off while others stay enabled
  // can therefore land a re-enabled indicator in the wrong pane. Fix:
  // whenever the oscillator subset changes, remove ALL currently-mounted
  // oscillator series and re-add the enabled ones fresh, in fixed order
  // (rsi, mlRsi, stochRsi, macd, adx), pane 1..N sequential.
  const rsiEnabled = enabledIndicators.includes("rsi");
  const mlRsiEnabled = enabledIndicators.includes("mlRsi");
  const stochRsiEnabled = enabledIndicators.includes("stochRsi");
  const macdEnabled = enabledIndicators.includes("macd");
  const adxEnabled = enabledIndicators.includes("adx");

  useEffect(() => {
    if (!ready || !chartRef.current) return;
    const chart = chartRef.current;

    ([rsiSeriesRef, mlRsiSeriesRef, mlRsiSignalSeriesRef, stochKSeriesRef, stochDSeriesRef, macdHistSeriesRef, plusDISeriesRef, minusDISeriesRef, adxSeriesRef] as const).forEach(
      (ref) => {
        if (ref.current) {
          chart.removeSeries(ref.current);
          ref.current = null;
        }
      }
    );

    let paneIndex = 1;
    if (rsiEnabled) {
      rsiSeriesRef.current = chart.addSeries(LineSeries, { color: "#e91e63", lineWidth: 1, title: "RSI" }, paneIndex);
      paneIndex++;
    }
    if (mlRsiEnabled) {
      mlRsiSeriesRef.current = chart.addSeries(LineSeries, { color: "#64d2ff", lineWidth: 2, title: "ML RSI" }, paneIndex);
      mlRsiSignalSeriesRef.current = chart.addSeries(LineSeries, { color: "#ffd166", lineWidth: 1, title: "ML RSI Signal" }, paneIndex);
      paneIndex++;
    }
    if (stochRsiEnabled) {
      stochKSeriesRef.current = chart.addSeries(LineSeries, { color: "#4caf50", lineWidth: 1, title: "StochK" }, paneIndex);
      stochDSeriesRef.current = chart.addSeries(LineSeries, { color: "#ff9800", lineWidth: 1, title: "StochD" }, paneIndex);
      paneIndex++;
    }
    if (macdEnabled) {
      macdHistSeriesRef.current = chart.addSeries(HistogramSeries, { title: "MACD" }, paneIndex);
      paneIndex++;
    }
    if (adxEnabled) {
      plusDISeriesRef.current = chart.addSeries(LineSeries, { color: COLORS.bull, lineWidth: 1, title: "+DI" }, paneIndex);
      minusDISeriesRef.current = chart.addSeries(LineSeries, { color: COLORS.bear, lineWidth: 1, title: "-DI" }, paneIndex);
      adxSeriesRef.current = chart.addSeries(LineSeries, { color: "#9e9e9e", lineWidth: 1, title: "ADX" }, paneIndex);
    }

    // Force the data-feed effect to re-populate the freshly (re)created
    // series — bump a counter so its dependency array sees a change even
    // when rawKlines/selectedTF haven't changed.
    setOscillatorReconcileTick((t) => t + 1);
  }, [ready, rsiEnabled, mlRsiEnabled, stochRsiEnabled, macdEnabled, adxEnabled]);

  // Swap the main candle series between regular Candlestick and the custom
  // variable-width Volume Candle renderer when the toggle changes. There is
  // no API to change a series' type in place — must removeSeries (loses its
  // price lines) then add a fresh one, then restore viewport + z-order.
  const volumeCandleEnabled = enabledIndicators.includes("volumeCandle");

  useEffect(() => {
    if (!ready || !chartRef.current || !candleSeriesRef.current) return;
    const chart = chartRef.current;
    const isCurrentlyCustom = candleSeriesRef.current.seriesType() === "Custom";
    const shouldBeCustom = volumeCandleEnabled;
    if (isCurrentlyCustom === shouldBeCustom) return;

    const savedRange = chart.timeScale().getVisibleLogicalRange();

    priceLinesRef.current.forEach((line) => candleSeriesRef.current?.removePriceLine(line));
    priceLinesRef.current = [];
    alertLinesRef.current.forEach((line) => candleSeriesRef.current?.removePriceLine(line));
    alertLinesRef.current = [];
    signalForgeLinesRef.current.forEach((line) => candleSeriesRef.current?.removePriceLine(line));
    signalForgeLinesRef.current = [];
    signalForgeMarkersRef.current?.detach();
    signalForgeMarkersRef.current = null;
    mlRsiMarkersRef.current?.detach();
    mlRsiMarkersRef.current = null;

    chart.removeSeries(candleSeriesRef.current);
    candleSeriesRef.current = shouldBeCustom
      ? chart.addCustomSeries(new VolumeCandleSeries(), {})
      : chart.addSeries(CandlestickSeries, {
          upColor: COLORS.bull, downColor: COLORS.bear,
          borderUpColor: COLORS.bull, borderDownColor: COLORS.bear,
          wickUpColor: COLORS.bull, wickDownColor: COLORS.bear,
        });

    if (savedRange) chart.timeScale().setVisibleLogicalRange(savedRange);

    reconcileOverlaySeries(chart, enabledIndicators, {
      ema9SeriesRef, ema21SeriesRef, bbUpperSeriesRef, bbLowerSeriesRef,
      superTrendSeriesRef, mlSuperTrendUpSeriesRef, mlSuperTrendDownSeriesRef, vwapSeriesRef,
    }, true);

    setCandleSwapTick((t) => t + 1);
  }, [ready, volumeCandleEnabled]);

  // Feed data whenever TF or klines change
  useEffect(() => {
    if (!ready || !candleSeriesRef.current) return;
    if (!isSymbolDataReady) return; // symbol switch in flight — chart clears via the loading overlay, not stale data
    const klines = getClosedKlines(activeKlines[selectedTF] ?? []);
    if (klines.length === 0) {
      priceLinesRef.current.forEach((line) => candleSeriesRef.current?.removePriceLine(line));
      priceLinesRef.current = [];
      signalForgeLinesRef.current.forEach((line) => candleSeriesRef.current?.removePriceLine(line));
      signalForgeLinesRef.current = [];
      signalForgeMarkersRef.current?.setMarkers([]);
      mlRsiSeriesRef.current?.setData([]);
      mlRsiSignalSeriesRef.current?.setData([]);
      mlSuperTrendUpSeriesRef.current?.setData([]);
      mlSuperTrendDownSeriesRef.current?.setData([]);
      mlRsiMarkersRef.current?.setMarkers([]);
      return;
    }

    if (candleSeriesRef.current.seriesType() === "Custom") {
      (candleSeriesRef.current as ISeriesApi<"Custom">).setData(
        klinesToVolumeCandleData(klines).map((p) => ({ ...p, time: p.time as UTCTimestamp }))
      );
    } else {
      (candleSeriesRef.current as ISeriesApi<"Candlestick">).setData(
        klinesToCandlestickData(klines).map((p) => ({ ...p, time: p.time as UTCTimestamp })) as CandlestickData<UTCTimestamp>[]
      );
    }
    volumeSeriesRef.current?.setData(
      klinesToVolumeData(klines, { upColor: COLORS.bull + "80", downColor: COLORS.bear + "80" }).map((p) => ({
        ...p,
        time: p.time as UTCTimestamp,
      })) as HistogramData<UTCTimestamp>[]
    );

    const closes = klines.map((k) => k.close);
    const times = klines.map((k) => Math.floor(k.time / 1000) as UTCTimestamp);

    if (enabledIndicators.includes("ema")) {
      const ema9Vals = calcEMASeries(closes, 9);
      const ema21Vals = calcEMASeries(closes, 21);
      ema9SeriesRef.current?.setData(
        times.map((t, i) => ({ time: t, value: ema9Vals[i] })).filter((p): p is LineData<UTCTimestamp> => p.value !== null)
      );
      ema21SeriesRef.current?.setData(
        times.map((t, i) => ({ time: t, value: ema21Vals[i] })).filter((p): p is LineData<UTCTimestamp> => p.value !== null)
      );
    }

    if (enabledIndicators.includes("bb")) {
      const bb = calcBollingerSeries(closes, 20, 2);
      bbUpperSeriesRef.current?.setData(
        times.map((t, i) => ({ time: t, value: bb.upper[i] })).filter((p): p is LineData<UTCTimestamp> => p.value !== null)
      );
      bbLowerSeriesRef.current?.setData(
        times.map((t, i) => ({ time: t, value: bb.lower[i] })).filter((p): p is LineData<UTCTimestamp> => p.value !== null)
      );
    }

    if (enabledIndicators.includes("rsi")) {
      const rsiVals = calcRSISeriesAligned(closes);
      rsiSeriesRef.current?.setData(
        times.map((t, i) => ({ time: t, value: rsiVals[i] })).filter((p): p is LineData<UTCTimestamp> => p.value !== null)
      );
    }

    if (enabledIndicators.includes("mlRsi")) {
      const mlRsi = runMlRsi(klines);
      mlRsiSeriesRef.current?.setData(
        times.map((t, i) => ({ time: t, value: mlRsi.mlRsiValue[i] })).filter((p): p is LineData<UTCTimestamp> => p.value !== null)
      );
      mlRsiSignalSeriesRef.current?.setData(
        times.map((t, i) => ({ time: t, value: mlRsi.signalLine[i] })).filter((p): p is LineData<UTCTimestamp> => p.value !== null)
      );
      const mlStUp: LineOrWhitespace[] = times.map((t, i) =>
        mlRsi.supertrend[i] !== null && mlRsi.supertrendDirection[i] === 1 ? { time: t, value: mlRsi.supertrend[i]! } : { time: t }
      );
      const mlStDown: LineOrWhitespace[] = times.map((t, i) =>
        mlRsi.supertrend[i] !== null && mlRsi.supertrendDirection[i] === -1 ? { time: t, value: mlRsi.supertrend[i]! } : { time: t }
      );
      mlSuperTrendUpSeriesRef.current?.setData(mlStUp);
      mlSuperTrendDownSeriesRef.current?.setData(mlStDown);

      const markers: SeriesMarker<UTCTimestamp>[] = mlRsi.signals.map((signal) => ({
        time: Math.floor(signal.time / 1000) as UTCTimestamp,
        position: signal.side === "long" ? "belowBar" : "aboveBar",
        shape: signal.side === "long" ? "arrowUp" : "arrowDown",
        color: signal.side === "long" ? COLORS.bull : COLORS.bear,
        text: signal.side === "long" ? "ML L" : "ML S",
        size: 1.4,
      }));
      mlRsiMarkersRef.current?.detach();
      mlRsiMarkersRef.current = createSeriesMarkers(
        candleSeriesRef.current as unknown as ISeriesApi<"Candlestick", UTCTimestamp>,
        markers,
        { zOrder: "top" }
      );
    } else {
      mlRsiMarkersRef.current?.detach();
      mlRsiMarkersRef.current = null;
    }

    if (enabledIndicators.includes("stochRsi")) {
      const stoch = calcStochRSISeries(closes);
      stochKSeriesRef.current?.setData(
        times.map((t, i) => ({ time: t, value: stoch.kSeries[i] })).filter((p): p is LineData<UTCTimestamp> => p.value !== null)
      );
      stochDSeriesRef.current?.setData(
        times.map((t, i) => ({ time: t, value: stoch.dSeries[i] })).filter((p): p is LineData<UTCTimestamp> => p.value !== null)
      );
    }

    if (enabledIndicators.includes("macd")) {
      const macd = calcMACDSeries(closes);
      macdHistSeriesRef.current?.setData(
        times
          .map((t, i) => ({ time: t, value: macd.histogram[i] }))
          .filter((p): p is { time: UTCTimestamp; value: number } => p.value !== null)
          .map((p) => ({ ...p, color: p.value >= 0 ? COLORS.bull : COLORS.bear } as HistogramData<UTCTimestamp>))
      );
    }

    if (enabledIndicators.includes("supertrend")) {
      const superTrend = calcSuperTrendSeries(klines, 10, 3);
      superTrendSeriesRef.current?.setData(
        times
          .map((t, i) => ({ time: t, value: superTrend.value[i], trend: superTrend.trend[i] }))
          .filter((p): p is { time: UTCTimestamp; value: number; trend: "up" | "down" } => p.value !== null)
          .map((p) => ({ time: p.time, value: p.value, color: p.trend === "up" ? COLORS.bull : COLORS.bear } as LineData<UTCTimestamp>))
      );
    }

    if (enabledIndicators.includes("vwap")) {
      // Daily-anchored VWAP loses meaning on coarse TFs (resets every bar on 1d/1w/1M)
      const showVwap = !["1d", "1w", "1M"].includes(selectedTF);
      const vwapVals = showVwap ? calcVWAPSeries(klines) : [];
      vwapSeriesRef.current?.setData(
        showVwap
          ? times.map((t, i) => ({ time: t, value: vwapVals[i] })).filter((p): p is LineData<UTCTimestamp> => p.value !== null)
          : []
      );
    }

    if (enabledIndicators.includes("adx")) {
      const adxRes = calcADXSeries(klines, 14);
      plusDISeriesRef.current?.setData(
        times.map((t, i) => ({ time: t, value: adxRes.plusDI[i] })).filter((p): p is LineData<UTCTimestamp> => p.value !== null)
      );
      minusDISeriesRef.current?.setData(
        times.map((t, i) => ({ time: t, value: adxRes.minusDI[i] })).filter((p): p is LineData<UTCTimestamp> => p.value !== null)
      );
      adxSeriesRef.current?.setData(
        times.map((t, i) => ({ time: t, value: adxRes.adx[i] })).filter((p): p is LineData<UTCTimestamp> => p.value !== null)
      );
    }

    if (enabledIndicators.includes("sr")) {
      const currentPrice = klines[klines.length - 1].close;
      const srLevels = detectSRLevels(klines, currentPrice);
      priceLinesRef.current.forEach((line) => candleSeriesRef.current?.removePriceLine(line));
      priceLinesRef.current = srLevels.map((lvl) =>
        candleSeriesRef.current!.createPriceLine({
          price: lvl.price,
          color: lvl.kind === "support" ? COLORS.bull : COLORS.bear,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          title: lvl.kind === "support" ? "S" : "R",
        })
      );
    } else {
      priceLinesRef.current.forEach((line) => candleSeriesRef.current?.removePriceLine(line));
      priceLinesRef.current = [];
    }
  }, [ready, activeKlines, isSymbolDataReady, selectedTF, enabledIndicators, oscillatorReconcileTick, candleSwapTick]);

  // Clear the candle/volume series AND every indicator series/price-line
  // while a symbol switch's fetch is still in flight — prevents briefly
  // showing the PREVIOUS symbol's candles OR indicator values (EMA/BB/
  // RSI/MACD/ADX/S-R) under the newly-selected symbol's label. Timeframe
  // switches (symbol unchanged) are unaffected: this only fires when
  // isSymbolDataReady flips to false, which happens on symbol change, not
  // TF change. (Codex-caught P1: original version only cleared
  // candle/volume, leaving indicator series showing the previous symbol's
  // stale values during the fetch.)
  useEffect(() => {
    if (!ready || !candleSeriesRef.current || isSymbolDataReady) return;
    candleSeriesRef.current.setData([]);
    volumeSeriesRef.current?.setData([]);
    ema9SeriesRef.current?.setData([]);
    ema21SeriesRef.current?.setData([]);
    bbUpperSeriesRef.current?.setData([]);
    bbLowerSeriesRef.current?.setData([]);
    superTrendSeriesRef.current?.setData([]);
    mlSuperTrendUpSeriesRef.current?.setData([]);
    mlSuperTrendDownSeriesRef.current?.setData([]);
    vwapSeriesRef.current?.setData([]);
    rsiSeriesRef.current?.setData([]);
    mlRsiSeriesRef.current?.setData([]);
    mlRsiSignalSeriesRef.current?.setData([]);
    stochKSeriesRef.current?.setData([]);
    stochDSeriesRef.current?.setData([]);
    macdHistSeriesRef.current?.setData([]);
    plusDISeriesRef.current?.setData([]);
    minusDISeriesRef.current?.setData([]);
    adxSeriesRef.current?.setData([]);
    priceLinesRef.current.forEach((line) => candleSeriesRef.current?.removePriceLine(line));
    priceLinesRef.current = [];
    signalForgeLinesRef.current.forEach((line) => candleSeriesRef.current?.removePriceLine(line));
    signalForgeLinesRef.current = [];
    signalForgeMarkersRef.current?.setMarkers([]);
    mlRsiMarkersRef.current?.setMarkers([]);
  }, [ready, isSymbolDataReady]);

  // Draw rule entry/TP/SL overlay for the active timeframe
  useEffect(() => {
    if (!ready || !candleSeriesRef.current) return;
    alertLinesRef.current.forEach((line) => candleSeriesRef.current?.removePriceLine(line));
    alertLinesRef.current = [];
    if (!enabledIndicators.includes("rules")) return;
    // Rule Entry/TP/SL lines come from activeAlerts, which is always BTC
    // rule data — suppress on non-BTC symbols rather than drawing BTC
    // price levels on an ETH/ETHFI/SOL chart. The Indicators checkbox
    // itself stays whatever the user left it (not auto-toggled off) — this
    // is a display suppression, not a preference change.
    if (selectedSymbol !== "BTC") return;

    const matching = activeAlerts.filter((a) => a.tfKey === selectedTF);
    const newLines: IPriceLine[] = [];
    for (const alert of matching) {
      const rank = alert.id.split(":")[1] ?? alert.id;
      newLines.push(
        candleSeriesRef.current!.createPriceLine({
          price: alert.entryPrice,
          color: P.text,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          title: `#${rank} ENTRY`,
        })
      );
      newLines.push(
        candleSeriesRef.current!.createPriceLine({
          price: alert.tpPrice,
          color: COLORS.bull,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          title: `#${rank} TP`,
        })
      );
      newLines.push(
        candleSeriesRef.current!.createPriceLine({
          price: alert.slPrice,
          color: COLORS.bear,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          title: `#${rank} SL`,
        })
      );
    }
    alertLinesRef.current = newLines;
  }, [ready, activeAlerts, selectedTF, enabledIndicators, candleSwapTick, selectedSymbol]);

  // Draw Signal Forge visual-only entries and active ATR risk levels. This
  // never touches the live rule engine or alert state.
  useEffect(() => {
    if (!ready || !candleSeriesRef.current) return;

    signalForgeLinesRef.current.forEach((line) => candleSeriesRef.current?.removePriceLine(line));
    signalForgeLinesRef.current = [];
    signalForgeMarkersRef.current?.detach();
    signalForgeMarkersRef.current = null;

    if (!signalForgeEnabled || !signalForgeAnalysis || !isSymbolDataReady) return;

    const markers: SeriesMarker<UTCTimestamp>[] = signalForgeAnalysis.markers.map((marker) => ({
      time: Math.floor(marker.time / 1000) as UTCTimestamp,
      position: marker.side === "long" ? "belowBar" : "aboveBar",
      shape: "circle",
      color: marker.side === "long" ? COLORS.bull : COLORS.bear,
      text: marker.side === "long" ? "SF L" : "SF S",
      size: 1.2,
    }));
    signalForgeMarkersRef.current = createSeriesMarkers(
      candleSeriesRef.current as unknown as ISeriesApi<"Candlestick", UTCTimestamp>,
      markers,
      { zOrder: "top" }
    );

    const risk = signalForgeAnalysis.activeRisk;
    if (!risk) return;

    const newLines: IPriceLine[] = [
      candleSeriesRef.current.createPriceLine({
        price: risk.entryPrice,
        color: P.text,
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        title: `SF ${risk.side === "long" ? "LONG" : "SHORT"}`,
      }),
    ];

    if (risk.tpPrice !== null) {
      newLines.push(
        candleSeriesRef.current.createPriceLine({
          price: risk.tpPrice,
          color: COLORS.bull,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          title: "SF TP",
        })
      );
    }
    if (risk.slPrice !== null) {
      newLines.push(
        candleSeriesRef.current.createPriceLine({
          price: risk.slPrice,
          color: COLORS.bear,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          title: "SF SL",
        })
      );
    }
    if (risk.trailingStop !== null) {
      newLines.push(
        candleSeriesRef.current.createPriceLine({
          price: risk.trailingStop,
          color: "#ffd166",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          title: "SF TS",
        })
      );
    }

    signalForgeLinesRef.current = newLines;
  }, [ready, signalForgeEnabled, signalForgeAnalysis, isSymbolDataReady, candleSwapTick]);

  return (
    <View style={styles.container}>
      <DebugLabel name="TradingChartTab" />
      <View style={styles.symbolRow}>
        {CHART_SYMBOLS.map((sym) => (
          <Text
            key={sym}
            onPress={() => setSelectedSymbol(sym)}
            style={[styles.symbolBtn, selectedSymbol === sym && styles.symbolBtnActive]}
          >
            {sym}
          </Text>
        ))}
        {selectedSymbol !== "BTC" && !isSymbolDataReady && symbolLoading && !symbolError && (
          <Text style={styles.symbolStatusText}>Đang tải {selectedSymbol}...</Text>
        )}
        {selectedSymbol !== "BTC" && symbolError && (
          <Text style={styles.symbolErrorText}>{symbolError}</Text>
        )}
      </View>
      <View style={styles.tfRow}>
        {TIMEFRAMES.map((tf) => (
          <Text
            key={tf.key}
            onPress={() => onSelectTF(tf.key)}
            style={[styles.tfBtn, selectedTF === tf.key && styles.tfBtnActive]}
          >
            {tf.label}
          </Text>
        ))}
      </View>
      <View style={{ flex: 1, width: "100%" }}>
        <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
        {/* Floating trigger, top-right of the chart area itself (not the TF
            row) — minimal footprint over the candlesticks rather than
            competing for space in the timeframe row. */}
        <Pressable ref={indicatorBtnRef} onPress={() => setPanelOpen((v) => !v)} style={styles.indicatorBtn}>
          <Text style={styles.indicatorBtnLabel}>⚙ Indicators</Text>
        </Pressable>
        <ChartIndicatorPanelWeb
          visible={panelOpen}
          onClose={() => setPanelOpen(false)}
          triggerNode={indicatorBtnRef.current as unknown as HTMLElement | null}
          enabled={enabledIndicators}
          onToggle={toggleIndicator}
          onReset={resetIndicators}
        />
        {signalForgeEnabled && signalForgeAnalysis && (
          <SignalForgeDashboard
            result={signalForgeAnalysis}
            config={signalForgeConfig}
            summaryByKey={signalForgeSummaryByKey}
            onToggleRequireAll={toggleSignalForgeRequireAll}
            onToggleIndicator={toggleSignalForgeIndicator}
            onToggleRisk={toggleSignalForgeRisk}
            onRiskNumberChange={updateSignalForgeRiskNumber}
          />
        )}
      </View>
      <Text style={styles.attribution}>Powered by TradingView Lightweight Charts</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: P.bg },
  tfRow: { flexDirection: "row", gap: 8, padding: 8 },
  tfBtn: { color: P.dim, fontSize: 12, paddingHorizontal: 8, paddingVertical: 4 },
  tfBtnActive: { color: P.primaryContainer, fontWeight: "700" },
  symbolRow: { flexDirection: "row", gap: 8, paddingHorizontal: 8, paddingTop: 8, alignItems: "center" },
  symbolBtn: { color: P.dim, fontSize: 12, paddingHorizontal: 8, paddingVertical: 4, fontWeight: "700" },
  symbolBtnActive: { color: P.primaryContainer },
  symbolStatusText: { color: P.dim, fontSize: 10, fontFamily: "monospace", marginLeft: 4 },
  symbolErrorText: { color: COLORS.bear, fontSize: 10, fontFamily: "monospace", marginLeft: 4 },
  attribution: { color: P.dim, fontSize: 9, textAlign: "center", padding: 4 },
  indicatorBtn: {
    position: "absolute",
    top: 8,
    left: 8,
    zIndex: 40,
    paddingHorizontal: 12,
    paddingVertical: 7,
    backgroundColor: P.elevated,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: P.primaryContainer,
    boxShadow: "0 2px 8px rgba(0,0,0,0.5)",
  },
  indicatorBtnLabel: { color: P.primaryContainer, fontSize: 12, fontWeight: "700" },
  signalForgePanel: {
    position: "absolute",
    top: 8,
    right: 8,
    zIndex: 35,
    width: 360,
    maxHeight: 470,
    backgroundColor: P.elevated,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: P.border,
    padding: 10,
    boxShadow: "0 4px 16px rgba(0,0,0,0.45)",
  },
  signalForgeHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  signalForgeTitle: { color: P.text, fontSize: 13, fontWeight: "800" },
  signalForgeModeBtn: {
    borderWidth: 1,
    borderColor: P.primaryContainer,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: P.bg,
  },
  signalForgeModeText: { color: P.primaryContainer, fontSize: 11, fontWeight: "800" },
  signalForgeStatsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    borderWidth: 1,
    borderColor: P.border,
    borderRadius: 6,
    overflow: "hidden",
    marginBottom: 8,
  },
  signalForgeStatCell: { width: "33.333%", paddingVertical: 5, paddingHorizontal: 6, borderColor: P.border, borderWidth: 0.5 },
  signalForgeStatLabel: { color: P.dim, fontSize: 9, fontWeight: "700" },
  signalForgeStatValue: { color: P.text, fontSize: 11, fontWeight: "800", marginTop: 1 },
  signalForgeRiskRow: { flexDirection: "row", gap: 8, alignItems: "center", marginBottom: 8 },
  signalForgeRiskControl: { flexDirection: "row", gap: 4, alignItems: "center" },
  signalForgeMiniToggle: {
    width: 34,
    height: 22,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: P.border,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: P.bg,
  },
  signalForgeMiniToggleActive: { borderColor: P.primaryContainer, backgroundColor: `${P.primaryContainer}22` },
  signalForgeMiniToggleText: { color: P.dim, fontSize: 9, fontWeight: "800" },
  signalForgeMiniToggleTextActive: { color: P.primaryContainer },
  signalForgeTableHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: P.border,
  },
  signalForgeHeaderCell: { color: P.dim, fontSize: 9, fontWeight: "800" },
  signalForgeRows: { maxHeight: 230 },
  signalForgeIndicatorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 28,
    borderBottomWidth: 1,
    borderBottomColor: `${P.border}99`,
  },
  signalForgeCellText: { color: P.text, fontSize: 10.5, fontWeight: "700" },
  signalForgeNameCell: { flex: 1, minWidth: 0 },
  signalForgeStatusCell: { width: 62, textAlign: "right" },
  signalForgeNumCell: { width: 42, textAlign: "right" },
});
