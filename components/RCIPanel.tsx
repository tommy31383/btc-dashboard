/**
 * RCIPanel — Reversal Confluence Index oscillator.
 *
 * 1 đường dao động âm/dương (range ~ -4 → +6):
 *   Dương (đỏ)  = bearish pressure (đỉnh sắp quay đầu)
 *   Âm  (xanh) = bullish pressure (đáy sắp quay đầu)
 *
 * Thresholds (backtest docs/rci-indicator-research-2026-06-03.md):
 *   > +4.0  BEAR STRONG (60% precision)
 *   > +3.0  BEAR WATCH
 *   < -1.5  BULL WATCH
 *   < -2.5  BULL STRONG
 *
 * Funding rate là driver mạnh nhất (>0.05%/8h = 64% precision).
 */
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { COLORS } from "../utils/constants";
import { RCIResult, zoneLabel } from "../utils/rci";
import { TrendResult, TrendZone, trendLabel } from "../utils/trend";

interface Props {
  rci: RCIResult;
  trend?: TrendResult;
}

function trendColor(zone: TrendZone): string {
  switch (zone) {
    case "STRONG_UP":   return COLORS.bull;
    case "UP":          return "#26de81";
    case "STRONG_DOWN": return COLORS.bear;
    case "DOWN":        return COLORS.warning;
    default:            return COLORS.neutral;
  }
}

// Trend score range cho thanh bar (-4 → +4, 0 = sideway)
function trendPct(v: number): number {
  return Math.max(0, Math.min(100, ((v + 4) / 8) * 100));
}

// Oscillator range for the bar visualization
const RCI_MIN = -4;
const RCI_MAX = 6;
const RANGE = RCI_MAX - RCI_MIN;

function pctOf(v: number): number {
  return Math.max(0, Math.min(100, ((v - RCI_MIN) / RANGE) * 100));
}

function zoneColor(zone: RCIResult["zone"]): string {
  switch (zone) {
    case "BEAR_STRONG": return COLORS.bear;
    case "BEAR_WATCH":  return COLORS.warning;
    case "BULL_STRONG": return COLORS.bull;
    case "BULL_WATCH":  return "#26de81";
    default:            return COLORS.neutral;
  }
}

function TrendSection({ trend }: { trend: TrendResult }) {
  if (trend.value === null) return null;
  const tc = trendColor(trend.zone);
  const zeroP = trendPct(0);
  const valP = trendPct(trend.value);
  const fillLeft = Math.min(zeroP, valP);
  const fillWidth = Math.abs(valP - zeroP);
  return (
    <View style={styles.trendBox}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>XU HƯỚNG (Trend)</Text>
        <Text style={[styles.value, { color: tc }]}>
          {trend.value >= 0 ? "+" : ""}{trend.value.toFixed(2)}
        </Text>
      </View>
      <Text style={[styles.zone, { color: tc }]}>{trendLabel(trend.zone)}</Text>
      <View style={styles.barBg}>
        <View style={[styles.zeroLine, { left: `${zeroP}%` }]} />
        <View style={[styles.fill, { left: `${fillLeft}%`, width: `${fillWidth}%`, backgroundColor: tc }]} />
      </View>
      <View style={styles.axisRow}>
        <Text style={styles.axisLabel}>▼ giảm</Text>
        <Text style={styles.axisLabel}>sideway</Text>
        <Text style={styles.axisLabel}>tăng ▲</Text>
      </View>
      {trend.adx !== null && (
        <Text style={styles.funding}>
          ADX {trend.adx.toFixed(0)} · DI+ {trend.diPlus?.toFixed(0)} / DI− {trend.diMinus?.toFixed(0)}
          {trend.adx > 25 ? "  ✓ trend mạnh" : trend.adx < 18 ? "  · không trend (range)" : "  · trend yếu"}
        </Text>
      )}
    </View>
  );
}

export default function RCIPanel({ rci, trend }: Props) {
  const { value, zone, components, fundingPct } = rci;

  if (value === null) {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>RCI — Reversal Confluence Index</Text>
        <Text style={styles.na}>Đang tải dữ liệu 4h/1h…</Text>
      </View>
    );
  }

  const color = zoneColor(zone);
  const zeroPct = pctOf(0);
  const valPct = pctOf(value);
  // Fill from zero to value
  const fillLeft = Math.min(zeroPct, valPct);
  const fillWidth = Math.abs(valPct - zeroPct);

  return (
    <View style={[styles.card, { borderLeftColor: color, borderLeftWidth: 4 }]}>
      {trend && <TrendSection trend={trend} />}

      <View style={styles.headerRow}>
        <Text style={styles.title}>RCI — Reversal Index</Text>
        <Text style={[styles.value, { color }]}>{value >= 0 ? "+" : ""}{value.toFixed(2)}</Text>
      </View>

      {/* Zone status */}
      <Text style={[styles.zone, { color }]}>{zoneLabel(zone)}</Text>

      {/* Oscillator bar */}
      <View style={styles.barBg}>
        {/* threshold markers */}
        <View style={[styles.thMarker, { left: `${pctOf(3.0)}%`, backgroundColor: COLORS.warning }]} />
        <View style={[styles.thMarker, { left: `${pctOf(4.0)}%`, backgroundColor: COLORS.bear }]} />
        <View style={[styles.thMarker, { left: `${pctOf(-1.5)}%`, backgroundColor: "#26de81" }]} />
        <View style={[styles.thMarker, { left: `${pctOf(-2.5)}%`, backgroundColor: COLORS.bull }]} />
        {/* zero line */}
        <View style={[styles.zeroLine, { left: `${zeroPct}%` }]} />
        {/* fill */}
        <View style={[styles.fill, { left: `${fillLeft}%`, width: `${fillWidth}%`, backgroundColor: color }]} />
      </View>
      <View style={styles.axisRow}>
        <Text style={styles.axisLabel}>↑ đáy (bull)</Text>
        <Text style={styles.axisLabel}>0</Text>
        <Text style={styles.axisLabel}>đỉnh (bear) ↓</Text>
      </View>

      {/* Components breakdown (v4: 8 components) */}
      <View style={styles.compRow}>
        <Comp label="Fund" v={components.funding} highlight={Math.abs(components.funding) >= 1.5} />
        <Comp label="FAcc" v={components.fundingAccel} highlight={Math.abs(components.fundingAccel) >= 1.2} />
        <Comp label="RSI" v={components.rsi} />
        <Comp label="Stoch" v={components.stoch} />
        <Comp label="BB" v={components.bollinger} />
        <Comp label="MACD" v={components.macd} />
        <Comp label="ADX" v={components.adxSlope} />
        <Comp label="VolX" v={components.volExhaust} />
      </View>

      {fundingPct !== null && (
        <Text style={styles.funding}>
          Funding: {fundingPct >= 0 ? "+" : ""}{fundingPct.toFixed(4)}%/8h
          {fundingPct > 0.05 ? "  ⚠️ LONGS crowded (squeeze risk)" : fundingPct < -0.01 ? "  ⚠️ SHORTS crowded" : ""}
        </Text>
      )}
    </View>
  );
}

function Comp({ label, v, highlight }: { label: string; v: number; highlight?: boolean }) {
  const c = v > 0 ? COLORS.bear : v < 0 ? COLORS.bull : COLORS.textMuted;
  return (
    <View style={styles.comp}>
      <Text style={styles.compLabel}>{label}</Text>
      <Text style={[styles.compVal, { color: c, fontWeight: highlight ? "800" : "600" }]}>
        {v > 0 ? "+" : ""}{v.toFixed(1)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: COLORS.bgCard,
    borderRadius: 8,
    padding: 12,
    marginHorizontal: 8,
    marginVertical: 4,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  title: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: "700",
  },
  value: {
    fontSize: 18,
    fontWeight: "800",
    fontFamily: "monospace",
  },
  zone: {
    fontSize: 12,
    fontWeight: "600",
    marginTop: 2,
    marginBottom: 8,
  },
  barBg: {
    height: 10,
    backgroundColor: "#ffffff12",
    borderRadius: 5,
    position: "relative",
    overflow: "hidden",
  },
  zeroLine: {
    position: "absolute",
    top: 0,
    width: 1.5,
    height: "100%",
    backgroundColor: "#ffffff60",
  },
  thMarker: {
    position: "absolute",
    top: 0,
    width: 1,
    height: "100%",
    opacity: 0.5,
  },
  fill: {
    position: "absolute",
    top: 0,
    height: "100%",
    borderRadius: 5,
  },
  axisRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 3,
  },
  axisLabel: {
    color: COLORS.textMuted,
    fontSize: 9,
  },
  compRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 10,
    gap: 4,
  },
  comp: {
    alignItems: "center",
    flex: 1,
  },
  compLabel: {
    color: COLORS.textMuted,
    fontSize: 9,
    marginBottom: 2,
  },
  compVal: {
    fontSize: 12,
    fontFamily: "monospace",
  },
  funding: {
    color: COLORS.textDim,
    fontSize: 10,
    marginTop: 8,
    fontFamily: "monospace",
  },
  na: {
    color: COLORS.textMuted,
    fontSize: 11,
    marginTop: 6,
  },
  trendBox: {
    paddingBottom: 10,
    marginBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#ffffff20",
  },
});
