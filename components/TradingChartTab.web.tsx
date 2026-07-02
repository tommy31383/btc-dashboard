import React, { useEffect, useRef, useState } from "react";
import { View, StyleSheet, Text } from "react-native";
import { createChart, IChartApi, ISeriesApi, IPriceLine, ColorType, LineStyle, CandlestickSeries, HistogramSeries, LineSeries, UTCTimestamp, CandlestickData, HistogramData, LineData } from "lightweight-charts";
import { COLORS, TIMEFRAMES, TimeframeKey } from "../utils/constants";
import { P } from "../utils/v2Theme";
import { RawKlinesMap, closedKlines as getClosedKlines } from "../hooks/useBinanceKlines";
import { calcEMASeries, calcBollingerSeries, calcRSISeriesAligned, calcStochRSISeries, calcMACDSeries } from "../utils/indicators";
import { klinesToCandlestickData, klinesToVolumeData } from "../utils/chartDataMapper";
import { detectSRLevels } from "../utils/supportResistance";
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
  const rsiSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const stochKSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const stochDSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const macdHistSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const alertLinesRef = useRef<IPriceLine[]>([]);
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
    const rsi = chart.addSeries(LineSeries, { color: "#e91e63", lineWidth: 1, title: "RSI" }, 1);
    const stochK = chart.addSeries(LineSeries, { color: "#4caf50", lineWidth: 1, title: "StochK" }, 2);
    const stochD = chart.addSeries(LineSeries, { color: "#ff9800", lineWidth: 1, title: "StochD" }, 2);
    const macdHist = chart.addSeries(HistogramSeries, { title: "MACD" }, 3);

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    ema9SeriesRef.current = ema9;
    ema21SeriesRef.current = ema21;
    bbUpperSeriesRef.current = bbUpper;
    bbLowerSeriesRef.current = bbLower;
    rsiSeriesRef.current = rsi;
    stochKSeriesRef.current = stochK;
    stochDSeriesRef.current = stochD;
    macdHistSeriesRef.current = macdHist;
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

    const rsiVals = calcRSISeriesAligned(closes);
    const stoch = calcStochRSISeries(closes);
    const macd = calcMACDSeries(closes);

    rsiSeriesRef.current?.setData(
      times.map((t, i) => ({ time: t, value: rsiVals[i] })).filter((p): p is LineData<UTCTimestamp> => p.value !== null)
    );
    stochKSeriesRef.current?.setData(
      times.map((t, i) => ({ time: t, value: stoch.kSeries[i] })).filter((p): p is LineData<UTCTimestamp> => p.value !== null)
    );
    stochDSeriesRef.current?.setData(
      times.map((t, i) => ({ time: t, value: stoch.dSeries[i] })).filter((p): p is LineData<UTCTimestamp> => p.value !== null)
    );
    macdHistSeriesRef.current?.setData(
      times
        .map((t, i) => ({ time: t, value: macd.histogram[i] }))
        .filter((p): p is { time: UTCTimestamp; value: number } => p.value !== null)
        .map((p) => ({ ...p, color: p.value >= 0 ? COLORS.bull : COLORS.bear } as HistogramData<UTCTimestamp>))
    );

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
  }, [ready, rawKlines, selectedTF]);

  // Draw rule entry/TP/SL overlay for the active timeframe
  useEffect(() => {
    if (!ready || !candleSeriesRef.current) return;
    alertLinesRef.current.forEach((line) => candleSeriesRef.current?.removePriceLine(line));
    alertLinesRef.current = [];

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
  }, [ready, activeAlerts, selectedTF]);

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
