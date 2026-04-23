/**
 * LiveFeatureSnapshot — Material You live indicators (v4.3.20)
 *
 * Pattern mirror từ Stitch 02_dashboard_main.html "Chỉ số trực tiếp":
 *   Section caption "▼ LIVE FEATURE SNAPSHOT · 1H"
 *   grid-cols-3 gap-3 — each cell: bg-surface-container-lowest rounded-sm p-3,
 *   label (9px uppercase dim) + value (sm bold colored).
 *   HTF 4H cell có border-l primary-container (accent để tách HTF từ 1H features).
 */
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { P } from "../utils/v2Theme";
import { TFAnalysis } from "../hooks/useBinanceKlines";

interface Props { tfData: TFAnalysis[]; }

function trendOf(tf: TFAnalysis | undefined): { label: "UP" | "DOWN" | "FLAT"; color: string } {
  if (!tf || tf.ema50 === null || tf.ema50 <= 0) return { label: "FLAT", color: P.dim };
  const d = ((tf.lastClose - tf.ema50) / tf.ema50) * 100;
  if (d > 0.3) return { label: "UP", color: P.green };
  if (d < -0.3) return { label: "DOWN", color: P.error };
  return { label: "FLAT", color: P.primaryContainer };
}

function LiveFeatureSnapshotInner({ tfData }: Props) {
  const tf1h = tfData.find((t) => t.key === "1h");
  const tf4h = tfData.find((t) => t.key === "4h");
  const tf1d = tfData.find((t) => t.key === "1d");
  if (!tf1h) return null;

  const rsi = tf1h.rsi;
  const macdHist = tf1h.macdHistogram;
  const atr = tf1h.atrPct;
  const emaDist = tf1h.emaDistPct;
  const t4 = trendOf(tf4h);
  const t1d = trendOf(tf1d);

  const rsiColor = rsi === null ? P.dim : rsi > 70 ? P.error : rsi < 30 ? P.green : P.text;
  const macdColor = macdHist === null ? P.dim : macdHist >= 0 ? P.green : P.error;
  const atrColor = atr === null ? P.dim : atr < 0.3 ? P.green : atr < 0.8 ? P.primaryContainer : P.error;
  const emaColor =
    emaDist === null
      ? P.dim
      : Math.abs(emaDist) < 0.5
      ? P.green
      : Math.abs(emaDist) < 2
      ? P.primaryContainer
      : P.error;

  return (
    <View style={styles.wrap}>
      <Text style={styles.caption}>▼ LIVE FEATURE SNAPSHOT · 1H</Text>
      <View style={styles.grid}>
        <Cell
          label="RSI"
          value={rsi !== null ? rsi.toFixed(1) : "—"}
          color={rsiColor}
          hint={rsi === null ? "" : rsi > 70 ? "O.BOUGHT" : rsi < 30 ? "O.SOLD" : ""}
        />
        <Cell
          label="MACD H"
          value={macdHist !== null ? (macdHist >= 0 ? "+" : "") + macdHist.toFixed(1) : "—"}
          color={macdColor}
          hint={macdHist === null ? "" : macdHist >= 0 ? "BULL" : "BEAR"}
        />
        <Cell
          label="ATR%"
          value={atr !== null ? atr.toFixed(2) + "%" : "—"}
          color={atrColor}
          hint={atr === null ? "" : atr < 0.3 ? "GOLDEN" : atr < 0.8 ? "NORMAL" : "HIGH"}
        />
        <Cell
          label="EMA DIST"
          value={emaDist !== null ? (emaDist >= 0 ? "+" : "") + emaDist.toFixed(2) + "%" : "—"}
          color={emaColor}
          hint={emaDist === null ? "" : Math.abs(emaDist) < 0.5 ? "NEAR" : Math.abs(emaDist) < 2 ? "MID" : "FAR"}
        />
        <Cell label="HTF 4H" value={t4.label} color={t4.color} hint="" accent />
        <Cell label="HTF 1D" value={t1d.label} color={t1d.color} hint="" />
      </View>
    </View>
  );
}

function Cell({
  label,
  value,
  color,
  hint,
  accent,
}: {
  label: string;
  value: string;
  color: string;
  hint: string;
  accent?: boolean;
}) {
  return (
    <View style={[styles.cell, accent && styles.cellAccent]}>
      <Text style={styles.cellLabel}>{label}</Text>
      <Text style={[styles.cellValue, { color }]}>{value}</Text>
      {hint ? <Text style={[styles.cellHint, { color }]}>{hint}</Text> : null}
    </View>
  );
}

const LiveFeatureSnapshot = React.memo(LiveFeatureSnapshotInner);
export default LiveFeatureSnapshot;

const styles = StyleSheet.create({
  wrap: { marginBottom: 10 },
  caption: {
    color: P.text2,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 2,
    textTransform: "uppercase",
    fontFamily: "SpaceGrotesk_700Bold",
    marginBottom: 8,
    paddingHorizontal: 2,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  cell: {
    width: "32%",
    backgroundColor: P.surface,
    borderRadius: 2,
    paddingVertical: 10,
    paddingHorizontal: 8,
    alignItems: "center",
  },
  cellAccent: {
    borderLeftWidth: 2,
    borderLeftColor: P.primaryContainer,
  },
  cellLabel: {
    color: P.dim,
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 1.2,
    textTransform: "uppercase",
    fontFamily: "SpaceGrotesk_700Bold",
    marginBottom: 4,
  },
  cellValue: {
    fontSize: 14,
    fontWeight: "700",
    fontFamily: "JetBrainsMono_500Medium",
  },
  cellHint: {
    fontSize: 8,
    fontWeight: "700",
    fontFamily: "SpaceGrotesk_700Bold",
    letterSpacing: 1,
    marginTop: 2,
  },
});
