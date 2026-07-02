import React, { useEffect, useRef, useState } from "react";
import { View, StyleSheet, Text } from "react-native";
import { createChart, IChartApi, ISeriesApi, ColorType, CandlestickSeries, HistogramSeries, LineSeries, UTCTimestamp, CandlestickData, HistogramData, LineData } from "lightweight-charts";
import { COLORS, TIMEFRAMES, TimeframeKey } from "../utils/constants";
import { P } from "../utils/v2Theme";
import { RawKlinesMap, closedKlines as getClosedKlines } from "../hooks/useBinanceKlines";
import { calcEMASeries, calcBollingerSeries } from "../utils/indicators";
import { klinesToCandlestickData, klinesToVolumeData } from "../utils/chartDataMapper";
import { RuleAlert } from "../hooks/useRuleAlerts";
import DebugLabel from "./DebugLabel";

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
  const [ready, setReady] = useState(false);

  // Mount chart once
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
    const ema9 = chart.addSeries(LineSeries, { color: "#f7931a", lineWidth: 1, title: "EMA9" });
    const ema21 = chart.addSeries(LineSeries, { color: "#00bcd4", lineWidth: 1, title: "EMA21" });
    const bbUpper = chart.addSeries(LineSeries, { color: "#888", lineWidth: 1, title: "BB Upper" });
    const bbLower = chart.addSeries(LineSeries, { color: "#888", lineWidth: 1, title: "BB Lower" });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    ema9SeriesRef.current = ema9;
    ema21SeriesRef.current = ema21;
    bbUpperSeriesRef.current = bbUpper;
    bbLowerSeriesRef.current = bbLower;
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

  // Feed data whenever TF or klines change
  useEffect(() => {
    if (!ready || !candleSeriesRef.current) return;
    const klines = getClosedKlines(rawKlines[selectedTF] ?? []);
    if (klines.length === 0) return;

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
    const ema9Vals = calcEMASeries(closes, 9);
    const ema21Vals = calcEMASeries(closes, 21);
    const bb = calcBollingerSeries(closes, 20, 2);

    ema9SeriesRef.current?.setData(
      times.map((t, i) => ({ time: t, value: ema9Vals[i] })).filter((p): p is LineData<UTCTimestamp> => p.value !== null)
    );
    ema21SeriesRef.current?.setData(
      times.map((t, i) => ({ time: t, value: ema21Vals[i] })).filter((p): p is LineData<UTCTimestamp> => p.value !== null)
    );
    bbUpperSeriesRef.current?.setData(
      times.map((t, i) => ({ time: t, value: bb.upper[i] })).filter((p): p is LineData<UTCTimestamp> => p.value !== null)
    );
    bbLowerSeriesRef.current?.setData(
      times.map((t, i) => ({ time: t, value: bb.lower[i] })).filter((p): p is LineData<UTCTimestamp> => p.value !== null)
    );
  }, [ready, rawKlines, selectedTF]);

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
      <div ref={containerRef} style={{ flex: 1, width: "100%", height: "100%" }} />
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
});
