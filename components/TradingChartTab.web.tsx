import React, { useEffect, useRef, useState } from "react";
import { View, StyleSheet, Text, Pressable } from "react-native";
import { createChart, IChartApi, ISeriesApi, IPriceLine, ColorType, LineStyle, CandlestickSeries, HistogramSeries, LineSeries, UTCTimestamp, CandlestickData, HistogramData, LineData } from "lightweight-charts";
import { COLORS, TIMEFRAMES, TimeframeKey } from "../utils/constants";
import { P } from "../utils/v2Theme";
import { RawKlinesMap, closedKlines as getClosedKlines } from "../hooks/useBinanceKlines";
import { calcEMASeries, calcBollingerSeries, calcRSISeriesAligned, calcStochRSISeries, calcMACDSeries, calcADXSeries, calcSuperTrendSeries, calcVWAPSeries } from "../utils/indicators";
import { klinesToCandlestickData, klinesToVolumeData } from "../utils/chartDataMapper";
import { detectSRLevels } from "../utils/supportResistance";
import { RuleAlert } from "../hooks/useRuleAlerts";
import DebugLabel from "./DebugLabel";
import ChartIndicatorPanelWeb from "./ChartIndicatorPanel.web";
import { useChartIndicators } from "../hooks/useChartIndicators";
import { IndicatorKey } from "../utils/chartIndicators";

interface Props {
  rawKlines: RawKlinesMap;
  selectedTF: TimeframeKey;
  onSelectTF: (tf: TimeframeKey) => void;
  activeAlerts: RuleAlert[];
}

export default function TradingChartTab({ rawKlines, selectedTF, onSelectTF, activeAlerts }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const ema9SeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const ema21SeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const bbUpperSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const bbLowerSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const rsiSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const stochKSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const stochDSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const macdHistSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const superTrendSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const vwapSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const plusDISeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const minusDISeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const adxSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const alertLinesRef = useRef<IPriceLine[]>([]);
  const [ready, setReady] = useState(false);
  const [oscillatorReconcileTick, setOscillatorReconcileTick] = useState(0);
  const { enabled: enabledIndicators, toggle: toggleIndicator, reset: resetIndicators } = useChartIndicators();
  const [panelOpen, setPanelOpen] = useState(false);
  const indicatorBtnRef = useRef<View>(null);

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
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  // Reconcile overlay series (main pane 0) whenever the enabled set changes.
  // Overlay toggles never touch pane 1+, so no pane-index bug here — plain
  // add-if-missing / remove-if-present per key.
  useEffect(() => {
    if (!ready || !chartRef.current) return;
    const chart = chartRef.current;
    const has = (k: IndicatorKey) => enabledIndicators.includes(k);

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

    if (has("vwap") && !vwapSeriesRef.current) {
      vwapSeriesRef.current = chart.addSeries(LineSeries, { color: "#ba68c8", lineWidth: 1, title: "VWAP" });
    } else if (!has("vwap") && vwapSeriesRef.current) {
      chart.removeSeries(vwapSeriesRef.current);
      vwapSeriesRef.current = null;
    }
  }, [ready, enabledIndicators]);

  // Full reconcile for oscillator-pane indicators (rsi/stochRsi/macd/adx).
  // addSeries(..., paneIndex) does NOT insert a pane in the middle — if
  // paneIndex already exists it just adds the series to that existing pane.
  // Incrementally toggling one oscillator on/off while others stay enabled
  // can therefore land a re-enabled indicator in the wrong pane. Fix:
  // whenever the oscillator subset changes, remove ALL currently-mounted
  // oscillator series and re-add the enabled ones fresh, in fixed order
  // (rsi, stochRsi, macd, adx), pane 1..N sequential.
  const rsiEnabled = enabledIndicators.includes("rsi");
  const stochRsiEnabled = enabledIndicators.includes("stochRsi");
  const macdEnabled = enabledIndicators.includes("macd");
  const adxEnabled = enabledIndicators.includes("adx");

  useEffect(() => {
    if (!ready || !chartRef.current) return;
    const chart = chartRef.current;

    ([rsiSeriesRef, stochKSeriesRef, stochDSeriesRef, macdHistSeriesRef, plusDISeriesRef, minusDISeriesRef, adxSeriesRef] as const).forEach(
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
  }, [ready, rsiEnabled, stochRsiEnabled, macdEnabled, adxEnabled]);

  // Feed data whenever TF or klines change
  useEffect(() => {
    if (!ready || !candleSeriesRef.current) return;
    const klines = getClosedKlines(rawKlines[selectedTF] ?? []);
    if (klines.length === 0) {
      priceLinesRef.current.forEach((line) => candleSeriesRef.current?.removePriceLine(line));
      priceLinesRef.current = [];
      return;
    }

    candleSeriesRef.current.setData(
      klinesToCandlestickData(klines).map((p) => ({ ...p, time: p.time as UTCTimestamp })) as CandlestickData<UTCTimestamp>[]
    );
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
  }, [ready, rawKlines, selectedTF, enabledIndicators, oscillatorReconcileTick]);

  // Draw rule entry/TP/SL overlay for the active timeframe
  useEffect(() => {
    if (!ready || !candleSeriesRef.current) return;
    alertLinesRef.current.forEach((line) => candleSeriesRef.current?.removePriceLine(line));
    alertLinesRef.current = [];
    if (!enabledIndicators.includes("rules")) return;

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
  }, [ready, activeAlerts, selectedTF, enabledIndicators]);

  return (
    <View style={styles.container}>
      <DebugLabel name="TradingChartTab" />
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
  attribution: { color: P.dim, fontSize: 9, textAlign: "center", padding: 4 },
  indicatorBtn: {
    position: "absolute",
    top: 8,
    right: 8,
    zIndex: 40,
    paddingHorizontal: 10,
    paddingVertical: 5,
    backgroundColor: P.card,
    borderRadius: 8,
  },
  indicatorBtnLabel: { color: P.text, fontSize: 11, fontWeight: "600" },
});
