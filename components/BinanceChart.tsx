import React, { useState, useMemo, useCallback, useRef } from "react";
import DebugLabel from "./DebugLabel";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Dimensions,
  PanResponder,
} from "react-native";
import Svg, {
  Rect,
  Line,
  Text as SvgText,
  Polyline,
} from "react-native-svg";
import { COLORS, TIMEFRAMES, TimeframeKey } from "../utils/constants";
import { P } from "../utils/v2Theme";
import { Kline, RawKlinesMap } from "../hooks/useBinanceKlines";
import {
  calcRSISeriesAligned,
  calcStochRSISeries,
  calcEMASeries,
  calcBollingerSeries,
  calcMACDSeries,
} from "../utils/indicators";
import { detectSRLevels, formatSRPrice, SRLevel } from "../utils/supportResistance";

interface Props {
  rawKlines: RawKlinesMap;
  selectedTF: TimeframeKey;
  onSelectTF: (tf: TimeframeKey) => void;
}

const DEFAULT_CANDLE_W = 8;
const MIN_CANDLE_W = 3;
const MAX_CANDLE_W = 24;
const CANDLE_GAP_RATIO = 0.25;
const PRICE_AXIS_W = 58;
const CHART_H = 280;
const RSI_H = 90;
const STOCH_H = 90;
const MACD_H = 90;
const VOL_H = 50;
const PADDING_TOP = 10;
const PADDING_BOTTOM = 18;

function BinanceChartInner({ rawKlines, selectedTF, onSelectTF }: Props) {
  const [candleW, setCandleW] = useState(DEFAULT_CANDLE_W);
  const [showEma9, setShowEma9] = useState(true);
  const [showEma21, setShowEma21] = useState(true);
  const [showBB, setShowBB] = useState(false);
  const [showSR, setShowSR] = useState(true);
  const [showRSI, setShowRSI] = useState(true);
  const [showStoch, setShowStoch] = useState(true);
  const [showMACD, setShowMACD] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const pinchRef = useRef({ startDist: 0, startCandleW: DEFAULT_CANDLE_W });

  const candleGap = candleW * CANDLE_GAP_RATIO;
  const candleStep = candleW + candleGap;

  const klines = rawKlines[selectedTF] || [];
  const closes = useMemo(() => klines.map((k) => k.close), [klines]);

  // Indicator series
  const rsiSeries = useMemo(() => calcRSISeriesAligned(closes, 14), [closes]);
  const stochSeries = useMemo(() => calcStochRSISeries(closes, 14, 14, 3, 3), [closes]);
  const ema9 = useMemo(() => calcEMASeries(closes, 9), [closes]);
  const ema21 = useMemo(() => calcEMASeries(closes, 21), [closes]);
  const bbSeries = useMemo(() => calcBollingerSeries(closes, 20, 2), [closes]);
  const macdSeries = useMemo(() => calcMACDSeries(closes, 12, 26, 9), [closes]);

  // Support / Resistance levels — auto-tune params per TF
  const srLevels = useMemo<SRLevel[]>(() => {
    if (!showSR || klines.length < 30) return [];
    const last = klines[klines.length - 1];
    const currentPrice = last.close;
    // Tighter tolerance for shorter TFs (micro structure), looser for longer (macro)
    const tfTune: Record<string, { left: number; right: number; tol: number; minTouches: number }> = {
      "5m":  { left: 3, right: 3, tol: 0.15, minTouches: 2 },
      "15m": { left: 3, right: 3, tol: 0.25, minTouches: 2 },
      "1h":  { left: 4, right: 4, tol: 0.40, minTouches: 2 },
      "4h":  { left: 5, right: 5, tol: 0.60, minTouches: 2 },
      "1d":  { left: 5, right: 5, tol: 0.90, minTouches: 2 },
      "1w":  { left: 4, right: 4, tol: 1.50, minTouches: 2 },
      "1M":  { left: 3, right: 3, tol: 2.50, minTouches: 2 },
    };
    const t = tfTune[selectedTF] || tfTune["1h"];
    return detectSRLevels(klines, currentPrice, {
      leftBars: t.left,
      rightBars: t.right,
      tolerancePct: t.tol,
      minTouches: t.minTouches,
      maxPerSide: 4,
    });
  }, [klines, showSR, selectedTF]);

  const totalW = klines.length * candleStep + PRICE_AXIS_W;
  const chartContentW = klines.length * candleStep;

  // Price range
  const { priceMin, priceMax, volMax } = useMemo(() => {
    if (klines.length === 0) return { priceMin: 0, priceMax: 1, volMax: 1 };
    let lo = Infinity, hi = -Infinity, vm = 0;
    klines.forEach((k) => {
      if (k.low < lo) lo = k.low;
      if (k.high > hi) hi = k.high;
      if (k.volume > vm) vm = k.volume;
    });
    const pad = (hi - lo) * 0.05;
    return { priceMin: lo - pad, priceMax: hi + pad, volMax: vm };
  }, [klines]);

  const priceRange = priceMax - priceMin || 1;

  const priceToY = useCallback(
    (p: number) => PADDING_TOP + ((priceMax - p) / priceRange) * (CHART_H - PADDING_TOP - PADDING_BOTTOM - VOL_H),
    [priceMax, priceRange]
  );

  const rsiToY = useCallback((v: number) => 8 + ((100 - v) / 100) * (RSI_H - 16), []);
  const stochToY = useCallback((v: number) => 8 + ((100 - v) / 100) * (STOCH_H - 16), []);
  const volToY = useCallback((v: number) => CHART_H - PADDING_BOTTOM - (v / volMax) * VOL_H, [volMax]);

  // MACD Y mapper
  const macdRange = useMemo(() => {
    let maxVal = 0;
    macdSeries.histogram.forEach((v) => {
      if (v !== null && Math.abs(v) > maxVal) maxVal = Math.abs(v);
    });
    macdSeries.macdLine.forEach((v) => {
      if (v !== null && Math.abs(v) > maxVal) maxVal = Math.abs(v);
    });
    return maxVal || 1;
  }, [macdSeries]);

  const macdToY = useCallback(
    (v: number) => MACD_H / 2 - (v / macdRange) * (MACD_H / 2 - 8),
    [macdRange]
  );

  // Last candle data for axis display
  const lastData = useMemo(() => {
    if (klines.length === 0) return null;
    const idx = klines.length - 1;
    return {
      rsi: rsiSeries[idx],
      stochK: stochSeries.kSeries[idx],
      stochD: stochSeries.dSeries[idx],
      macdHist: macdSeries.histogram[idx],
    };
  }, [klines, rsiSeries, stochSeries, macdSeries]);

  const getTouchDist = (touches: any[]) => {
    if (touches.length < 2) return 0;
    const dx = touches[0].pageX - touches[1].pageX;
    const dy = touches[0].pageY - touches[1].pageY;
    return Math.sqrt(dx * dx + dy * dy);
  };

  // Only capture 2-finger pinch, let 1-finger pass through to ScrollView
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: (e) => e.nativeEvent.touches.length >= 2,
        onMoveShouldSetPanResponder: (e) => e.nativeEvent.touches.length >= 2,
        onPanResponderGrant: (e) => {
          const touches = e.nativeEvent.touches;
          if (touches.length >= 2) {
            pinchRef.current.startDist = getTouchDist(touches);
            pinchRef.current.startCandleW = candleW;
          }
        },
        onPanResponderMove: (e) => {
          const touches = e.nativeEvent.touches;
          if (touches.length >= 2) {
            const dist = getTouchDist(touches);
            if (pinchRef.current.startDist > 0) {
              const scale = dist / pinchRef.current.startDist;
              const newW = Math.min(MAX_CANDLE_W, Math.max(MIN_CANDLE_W, pinchRef.current.startCandleW * scale));
              setCandleW(Math.round(newW * 10) / 10);
            }
          }
        },
        onPanResponderRelease: () => {},
      }),
    [candleW]
  );

  const formatTime = useCallback(
    (time: number) => {
      const d = new Date(time);
      if (["1d", "1w", "1M"].includes(selectedTF)) return `${d.getMonth() + 1}/${d.getDate()}`;
      return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
    },
    [selectedTF]
  );

  const priceLabels = useMemo(() => {
    const count = 5;
    const labels: { y: number; text: string }[] = [];
    for (let i = 0; i <= count; i++) {
      const p = priceMax - (i / count) * priceRange;
      labels.push({ y: priceToY(p), text: p.toFixed(0) });
    }
    return labels;
  }, [priceMax, priceRange, priceToY]);

  // Memoize heavy SVG element arrays
  const { candleElements, volumeElements, timeLabels } = useMemo(() => {
    const candles: React.ReactNode[] = [];
    const volumes: React.ReactNode[] = [];
    const times: React.ReactNode[] = [];

    klines.forEach((k, i) => {
      const x = i * candleStep;
      const isGreen = k.close >= k.open;
      const color = isGreen ? COLORS.bull : COLORS.bear;
      const bodyTop = priceToY(Math.max(k.open, k.close));
      const bodyBot = priceToY(Math.min(k.open, k.close));
      const bodyH = Math.max(bodyBot - bodyTop, 1);

      candles.push(
        <Line key={`w${i}`} x1={x + candleW / 2} y1={priceToY(k.high)} x2={x + candleW / 2} y2={priceToY(k.low)} stroke={color} strokeWidth={1} />
      );
      candles.push(
        <Rect key={`b${i}`} x={x} y={bodyTop} width={candleW} height={bodyH} fill={color} stroke={color} strokeWidth={0.5} opacity={isGreen ? 1 : 0.9} />
      );
      volumes.push(
        <Rect key={`v${i}`} x={x} y={volToY(k.volume)} width={candleW} height={CHART_H - PADDING_BOTTOM - volToY(k.volume)} fill={color} opacity={0.25} />
      );
      if (i % 10 === 0) {
        times.push(
          <SvgText key={`t${i}`} x={x + candleW / 2} y={CHART_H - 2} fill={COLORS.textMuted} fontSize={8} fontFamily="monospace" textAnchor="middle">
            {formatTime(k.time)}
          </SvgText>
        );
      }
    });

    return { candleElements: candles, volumeElements: volumes, timeLabels: times };
  }, [klines, candleStep, candleW, priceToY, volToY, formatTime]);

  if (klines.length === 0) {
    return (
      <View style={styles.container}>
        <DebugLabel name="BinanceChart" />
        <Text style={styles.noData}>Đang tải biểu đồ...</Text>
      </View>
    );
  }

  const buildLine = (series: (number | null)[], color: string, key: string, toY: (v: number) => number, sw = 1, op = 0.7) => {
    const points: string[] = [];
    series.forEach((v, i) => {
      if (v !== null) points.push(`${i * candleStep + candleW / 2},${toY(v)}`);
    });
    if (points.length < 2) return null;
    return <Polyline key={key} points={points.join(" ")} fill="none" stroke={color} strokeWidth={sw} opacity={op} />;
  };

  // MACD histogram bars — memoized
  const macdBars = useMemo(() => {
    if (!showMACD) return [];
    const bars: React.ReactNode[] = [];
    macdSeries.histogram.forEach((v, i) => {
      if (v === null) return;
      const x = i * candleStep;
      const zeroY = macdToY(0);
      const barY = macdToY(v);
      const color = v >= 0 ? COLORS.bull : COLORS.bear;
      bars.push(
        <Rect
          key={`mh${i}`}
          x={x}
          y={Math.min(zeroY, barY)}
          width={candleW}
          height={Math.abs(barY - zeroY) || 1}
          fill={color}
          opacity={0.5}
        />
      );
    });
    return bars;
  }, [showMACD, macdSeries.histogram, candleStep, candleW, macdToY]);

  return (
    <View style={styles.container}>
      {/* TF Selector */}
      <View style={styles.tfRow}>
        {TIMEFRAMES.map((tf) => (
          <TouchableOpacity
            key={tf.key}
            style={[styles.tfBtn, selectedTF === tf.key && styles.tfBtnActive]}
            onPress={() => onSelectTF(tf.key as TimeframeKey)}
          >
            <Text style={[styles.tfText, selectedTF === tf.key && styles.tfTextActive]}>{tf.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Zoom */}
      <View style={styles.zoomRow}>
        <TouchableOpacity style={styles.zoomBtn} onPress={() => setCandleW((w) => Math.max(MIN_CANDLE_W, w - 2))}>
          <Text style={styles.zoomBtnText}>−</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setCandleW(DEFAULT_CANDLE_W)}>
          <Text style={styles.zoomLevel}>{Math.round((candleW / DEFAULT_CANDLE_W) * 100)}%</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.zoomBtn} onPress={() => setCandleW((w) => Math.min(MAX_CANDLE_W, w + 2))}>
          <Text style={styles.zoomBtnText}>+</Text>
        </TouchableOpacity>
      </View>

      {/* OHLCV — last candle info */}
      <View style={styles.ohlcRow}>
        {klines.length > 0 && (() => {
          const last = klines[klines.length - 1];
          return (
            <>
              <Text style={styles.ohlcLabel}>O <Text style={styles.ohlcVal}>{last.open.toFixed(2)}</Text></Text>
              <Text style={styles.ohlcLabel}>H <Text style={[styles.ohlcVal, { color: COLORS.bull }]}>{last.high.toFixed(2)}</Text></Text>
              <Text style={styles.ohlcLabel}>L <Text style={[styles.ohlcVal, { color: COLORS.bear }]}>{last.low.toFixed(2)}</Text></Text>
              <Text style={styles.ohlcLabel}>C <Text style={[styles.ohlcVal, { color: last.close >= last.open ? COLORS.bull : COLORS.bear }]}>{last.close.toFixed(2)}</Text></Text>
              <Text style={styles.ohlcLabel}>V <Text style={styles.ohlcVal}>{(last.volume / 1000).toFixed(1)}K</Text></Text>
            </>
          );
        })()}
      </View>

      {/* Main Chart */}
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ width: totalW }}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
      >
        <View style={{ width: totalW }} {...panResponder.panHandlers}>
          {/* Candlestick */}
          <View style={styles.chartSection}>
            <Text style={styles.chartLabel}>BTCUSDT · {TIMEFRAMES.find((t) => t.key === selectedTF)?.label}</Text>
            <Svg width={totalW} height={CHART_H}>
              {priceLabels.map((l, i) => (
                <Line key={`gl${i}`} x1={0} y1={l.y} x2={chartContentW} y2={l.y} stroke="#ffffff08" strokeWidth={1} />
              ))}
              {volumeElements}
              {candleElements}
              {showEma9 && buildLine(ema9, "#f7931a", "ema9", priceToY)}
              {showEma21 && buildLine(ema21, "#2ed573", "ema21", priceToY)}
              {showBB && buildLine(bbSeries.upper, "#9b59b6", "bbu", priceToY, 1, 0.5)}
              {showBB && buildLine(bbSeries.middle, "#9b59b6", "bbm", priceToY, 0.5, 0.3)}
              {showBB && buildLine(bbSeries.lower, "#9b59b6", "bbl", priceToY, 1, 0.5)}
              {/* Support / Resistance horizontal lines */}
              {showSR && srLevels.map((lvl, i) => {
                const y = priceToY(lvl.price);
                if (y < PADDING_TOP || y > CHART_H - PADDING_BOTTOM - VOL_H) return null;
                const isRes = lvl.kind === "resistance";
                const color = isRes ? "#ff4757" : "#2ed573";
                // Strength → line opacity + dash
                const op = 0.35 + lvl.strength * 0.4;
                const sw = 1 + Math.min(2, lvl.strength * 2);
                const fromX = lvl.firstFormedIdx * candleStep;
                const toX = chartContentW;
                return (
                  <React.Fragment key={`sr${i}`}>
                    {/* Main level line */}
                    <Line x1={fromX} y1={y} x2={toX} y2={y} stroke={color} strokeWidth={sw} opacity={op} strokeDasharray={isRes ? "6,3" : "6,3"} />
                    {/* Touch count pill on left edge */}
                    <Rect x={fromX + 2} y={y - 6} width={22} height={12} fill={color} opacity={0.85} rx={2} />
                    <SvgText x={fromX + 13} y={y + 3} fill="#ffffff" fontSize={8} fontFamily="monospace" fontWeight="bold" textAnchor="middle">
                      {lvl.touches}×
                    </SvgText>
                    {/* Price label on right edge */}
                    <Rect x={chartContentW + 1} y={y - 6} width={40} height={12} fill={color} opacity={0.9} rx={2} />
                    <SvgText x={chartContentW + 21} y={y + 3} fill="#ffffff" fontSize={8} fontFamily="monospace" fontWeight="bold" textAnchor="middle">
                      {formatSRPrice(lvl.price)}
                    </SvgText>
                  </React.Fragment>
                );
              })}
              {timeLabels}
              {priceLabels.map((l, i) => (
                <SvgText key={`pl${i}`} x={chartContentW + 4} y={l.y + 3} fill={COLORS.textMuted} fontSize={9} fontFamily="monospace">{l.text}</SvgText>
              ))}
            </Svg>
          </View>

          {/* RSI */}
          {showRSI && (
            <View style={styles.subChartSection}>
              <Text style={styles.subLabel}>RSI(14)</Text>
              <Svg width={totalW} height={RSI_H}>
                <Rect x={0} y={0} width={chartContentW} height={RSI_H} fill="#ffffff03" />
                <Rect x={0} y={rsiToY(70)} width={chartContentW} height={rsiToY(30) - rsiToY(70)} fill="#ffffff06" />
                <Line x1={0} y1={rsiToY(70)} x2={chartContentW} y2={rsiToY(70)} stroke="#ff475733" strokeWidth={1} strokeDasharray="3,3" />
                <Line x1={0} y1={rsiToY(30)} x2={chartContentW} y2={rsiToY(30)} stroke="#2ed57333" strokeWidth={1} strokeDasharray="3,3" />
                <Line x1={0} y1={rsiToY(50)} x2={chartContentW} y2={rsiToY(50)} stroke="#ffffff10" strokeWidth={1} strokeDasharray="2,4" />
                {buildLine(rsiSeries, "#e0a825", "rsi", rsiToY, 1.5, 1)}
                <SvgText x={chartContentW + 4} y={rsiToY(70) + 3} fill={COLORS.bear} fontSize={8} fontFamily="monospace">70</SvgText>
                <SvgText x={chartContentW + 4} y={rsiToY(50) + 3} fill={COLORS.textMuted} fontSize={8} fontFamily="monospace">50</SvgText>
                <SvgText x={chartContentW + 4} y={rsiToY(30) + 3} fill={COLORS.bull} fontSize={8} fontFamily="monospace">30</SvgText>
                {lastData?.rsi != null && (
                  <SvgText x={chartContentW + 4} y={12} fill="#e0a825" fontSize={9} fontFamily="monospace" fontWeight="bold">{lastData.rsi.toFixed(1)}</SvgText>
                )}
              </Svg>
            </View>
          )}

          {/* StochRSI */}
          {showStoch && (
            <View style={styles.subChartSection}>
              <Text style={styles.subLabel}>StochRSI(14,14,3,3)</Text>
              <Svg width={totalW} height={STOCH_H}>
                <Rect x={0} y={0} width={chartContentW} height={STOCH_H} fill="#ffffff03" />
                <Rect x={0} y={stochToY(80)} width={chartContentW} height={stochToY(20) - stochToY(80)} fill="#ffffff06" />
                <Line x1={0} y1={stochToY(80)} x2={chartContentW} y2={stochToY(80)} stroke="#ff475733" strokeWidth={1} strokeDasharray="3,3" />
                <Line x1={0} y1={stochToY(20)} x2={chartContentW} y2={stochToY(20)} stroke="#2ed57333" strokeWidth={1} strokeDasharray="3,3" />
                {buildLine(stochSeries.kSeries, "#3498db", "stochK", stochToY, 1.5, 1)}
                {buildLine(stochSeries.dSeries, "#e67e22", "stochD", stochToY, 1.5, 1)}
                <SvgText x={chartContentW + 4} y={stochToY(80) + 3} fill={COLORS.bear} fontSize={8} fontFamily="monospace">80</SvgText>
                <SvgText x={chartContentW + 4} y={stochToY(20) + 3} fill={COLORS.bull} fontSize={8} fontFamily="monospace">20</SvgText>
                {lastData?.stochK != null && (
                  <>
                    <SvgText x={chartContentW + 4} y={12} fill="#3498db" fontSize={8} fontFamily="monospace" fontWeight="bold">K:{lastData.stochK.toFixed(0)}</SvgText>
                    {lastData?.stochD != null && (
                      <SvgText x={chartContentW + 4} y={22} fill="#e67e22" fontSize={8} fontFamily="monospace" fontWeight="bold">D:{lastData.stochD.toFixed(0)}</SvgText>
                    )}
                  </>
                )}
              </Svg>
            </View>
          )}

          {/* MACD */}
          {showMACD && (
            <View style={styles.subChartSection}>
              <Text style={styles.subLabel}>MACD(12,26,9)</Text>
              <Svg width={totalW} height={MACD_H}>
                <Rect x={0} y={0} width={chartContentW} height={MACD_H} fill="#ffffff03" />
                <Line x1={0} y1={macdToY(0)} x2={chartContentW} y2={macdToY(0)} stroke="#ffffff15" strokeWidth={1} />
                {macdBars}
                {buildLine(macdSeries.macdLine, "#3498db", "macd", macdToY, 1.5, 0.9)}
                {buildLine(macdSeries.signalLine, "#e67e22", "macdSig", macdToY, 1.5, 0.9)}
                <SvgText x={chartContentW + 4} y={12} fill={COLORS.textMuted} fontSize={8} fontFamily="monospace">0</SvgText>
                {lastData?.macdHist != null && (
                  <SvgText x={chartContentW + 4} y={24} fill={lastData.macdHist >= 0 ? COLORS.bull : COLORS.bear} fontSize={8} fontFamily="monospace" fontWeight="bold">
                    {lastData.macdHist.toFixed(1)}
                  </SvgText>
                )}
              </Svg>
            </View>
          )}
        </View>
      </ScrollView>

      {/* Legend — tap to toggle */}
      <View style={styles.legendRow}>
        <TouchableOpacity style={styles.legendItem} onPress={() => setShowEma9((v) => !v)}>
          <View style={[styles.legendDot, { backgroundColor: showEma9 ? "#f7931a" : "#ffffff20" }]} />
          <Text style={[styles.legendText, !showEma9 && styles.legendOff]}>EMA9</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.legendItem} onPress={() => setShowEma21((v) => !v)}>
          <View style={[styles.legendDot, { backgroundColor: showEma21 ? "#2ed573" : "#ffffff20" }]} />
          <Text style={[styles.legendText, !showEma21 && styles.legendOff]}>EMA21</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.legendItem} onPress={() => setShowBB((v) => !v)}>
          <View style={[styles.legendDot, { backgroundColor: showBB ? "#9b59b6" : "#ffffff20" }]} />
          <Text style={[styles.legendText, !showBB && styles.legendOff]}>BB</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.legendItem} onPress={() => setShowSR((v) => !v)}>
          <View style={[styles.legendDot, { backgroundColor: showSR ? "#ff4757" : "#ffffff20" }]} />
          <Text style={[styles.legendText, !showSR && styles.legendOff]}>S/R</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.legendItem} onPress={() => setShowRSI((v) => !v)}>
          <View style={[styles.legendDot, { backgroundColor: showRSI ? "#e0a825" : "#ffffff20" }]} />
          <Text style={[styles.legendText, !showRSI && styles.legendOff]}>RSI</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.legendItem} onPress={() => setShowStoch((v) => !v)}>
          <View style={[styles.legendDot, { backgroundColor: showStoch ? "#3498db" : "#ffffff20" }]} />
          <Text style={[styles.legendText, !showStoch && styles.legendOff]}>Stoch</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.legendItem} onPress={() => setShowMACD((v) => !v)}>
          <View style={[styles.legendDot, { backgroundColor: showMACD ? "#e67e22" : "#ffffff20" }]} />
          <Text style={[styles.legendText, !showMACD && styles.legendOff]}>MACD</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const BinanceChart = React.memo(BinanceChartInner);
export default BinanceChart;

const styles = StyleSheet.create({
  container: { backgroundColor: P.card, borderRadius: 2, padding: 10, paddingLeft: 14, marginBottom: 10, borderLeftWidth: 4, borderLeftColor: P.primaryContainer },
  noData: { color: P.dim, fontSize: 12, fontFamily: "JetBrainsMono_400Regular", textAlign: "center", padding: 40 },
  tfRow: { flexDirection: "row", gap: 4, marginBottom: 8 },
  tfBtn: { flex: 1, paddingVertical: 6, backgroundColor: P.surface, borderRadius: 2, alignItems: "center" },
  tfBtnActive: { backgroundColor: P.primaryContainer },
  tfText: { color: P.dim, fontSize: 10, fontWeight: "700", fontFamily: "SpaceGrotesk_700Bold", letterSpacing: 1 },
  tfTextActive: { color: P.onPrimary, fontWeight: "800" },
  zoomRow: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 12, marginBottom: 6 },
  zoomBtn: { width: 28, height: 28, borderRadius: 0, backgroundColor: P.card, borderWidth: 1, borderColor: P.border, alignItems: "center", justifyContent: "center" },
  zoomBtnText: { color: P.text, fontSize: 16, fontWeight: "700", fontFamily: "monospace" },
  zoomLevel: { color: P.dim, fontSize: 11, fontFamily: "monospace", minWidth: 40, textAlign: "center" },
  ohlcRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 4, paddingBottom: 6, minHeight: 16 },
  ohlcLabel: { color: P.dim, fontSize: 10, fontFamily: "monospace" },
  ohlcVal: { color: P.text, fontWeight: "700" },
  chartSection: { borderBottomWidth: 1, borderBottomColor: P.border },
  chartLabel: { color: P.dim, fontSize: 8, fontFamily: "monospace", letterSpacing: 1.5, paddingLeft: 4, paddingBottom: 2 },
  subChartSection: { borderBottomWidth: 1, borderBottomColor: P.border },
  subLabel: { color: P.dim, fontSize: 8, fontFamily: "monospace", letterSpacing: 1.5, paddingLeft: 4, paddingTop: 4, paddingBottom: 2 },
  legendRow: { flexDirection: "row", justifyContent: "center", gap: 10, paddingTop: 8, flexWrap: "wrap" },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 3 },
  legendDot: { width: 8, height: 3, borderRadius: 1 },
  legendText: { color: P.dim, fontSize: 9, fontFamily: "monospace" },
  legendOff: { textDecorationLine: "line-through", opacity: 0.4 },
});
