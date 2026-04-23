import React, { useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { COLORS } from "../utils/constants";
import { P } from "../utils/v2Theme";
import { TFAnalysis } from "../hooks/useBinanceKlines";
import RSIBar from "./RSIBar";
import TimeframeDetail from "./TimeframeDetail";

interface Props {
  tfData: TFAnalysis[];
  overboughtLevel: number;
  oversoldLevel: number;
}

function getStatus(rsi: number | null, ob: number, os: number): { text: string; color: string } {
  if (rsi === null) return { text: "—", color: COLORS.textMuted };
  if (rsi > ob) return { text: "QUÁ MUA", color: COLORS.bear };
  if (rsi < os) return { text: "QUÁ BÁN", color: COLORS.bull };
  return { text: "TRUNG TÍNH", color: COLORS.neutral };
}

function getMacdLabel(hist: number | null): { text: string; color: string } {
  if (hist === null) return { text: "—", color: COLORS.textMuted };
  return hist >= 0 ? { text: "TĂNG", color: COLORS.bull } : { text: "GIẢM", color: COLORS.bear };
}

function getDivLabel(div: string | null): { text: string; color: string } {
  if (div === "BEARISH_DIV") return { text: "⚠ Giảm", color: COLORS.bear };
  if (div === "BULLISH_DIV") return { text: "🚀 Tăng", color: COLORS.bull };
  return { text: "—", color: COLORS.textMuted };
}

function getStochStatus(k: number | null): { text: string; color: string } {
  if (k === null) return { text: "", color: COLORS.textMuted };
  if (k > 80) return { text: "QM", color: COLORS.bear };
  if (k < 20) return { text: "QB", color: COLORS.bull };
  return { text: "", color: COLORS.textMuted };
}

function TimeframeTableInner({ tfData, overboughtLevel, oversoldLevel }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [legendOpen, setLegendOpen] = useState<boolean>(false);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>PHÂN TÍCH ĐA KHUNG THỜI GIAN</Text>

      <View style={styles.headerRow}>
        <Text style={[styles.headerCell, { flex: 0.5 }]}>TF</Text>
        <Text style={[styles.headerCell, { flex: 1.5 }]}>RSI(14)</Text>
        <Text style={[styles.headerCell, { flex: 0.8 }]}>StochRSI</Text>
        <Text style={[styles.headerCell, { flex: 0.6 }]}>MACD</Text>
        <Text style={[styles.headerCell, { flex: 0.8 }]}>Trạng thái</Text>
        <Text style={[styles.headerCell, { flex: 0.7 }]}>P.Kỳ</Text>
      </View>

      {tfData.map((tf) => {
        const status = getStatus(tf.rsi, overboughtLevel, oversoldLevel);
        const macd = getMacdLabel(tf.macdHistogram);
        const div = getDivLabel(tf.divergence);
        const stochSt = getStochStatus(tf.stochK);
        const isExpanded = expanded === tf.key;

        return (
          <View key={tf.key}>
            <TouchableOpacity
              style={[styles.row, isExpanded && styles.rowExpanded]}
              onPress={() => setExpanded(isExpanded ? null : tf.key)}
              activeOpacity={0.7}
            >
              <Text style={[styles.cell, styles.tfLabel, { flex: 0.5 }]}>{tf.label}</Text>
              <View style={{ flex: 1.5 }}>
                <RSIBar value={tf.rsi} overbought={overboughtLevel} oversold={oversoldLevel} />
              </View>
              <View style={{ flex: 0.8, alignItems: "center" }}>
                {tf.stochK !== null ? (
                  <View style={styles.stochCell}>
                    <Text style={styles.cell}>
                      <Text style={{ color: tf.stochK > 80 ? COLORS.bear : tf.stochK < 20 ? COLORS.bull : COLORS.text }}>
                        {tf.stochK.toFixed(0)}
                      </Text>
                      <Text style={{ color: COLORS.textMuted }}>/</Text>
                      <Text style={{ color: tf.stochD !== null ? (tf.stochD > 80 ? COLORS.bear : tf.stochD < 20 ? COLORS.bull : COLORS.text) : COLORS.textMuted }}>
                        {tf.stochD?.toFixed(0) ?? "—"}
                      </Text>
                    </Text>
                    {stochSt.text !== "" && (
                      <View style={[styles.stochBadge, { backgroundColor: stochSt.color + "20" }]}>
                        <Text style={[styles.stochBadgeText, { color: stochSt.color }]}>{stochSt.text}</Text>
                      </View>
                    )}
                  </View>
                ) : (
                  <Text style={[styles.cell, { color: COLORS.textMuted }]}>—</Text>
                )}
              </View>
              <Text style={[styles.cell, { flex: 0.6, color: macd.color }]}>{macd.text}</Text>
              <View style={{ flex: 0.8, alignItems: "center" }}>
                <View style={[styles.badge, { backgroundColor: status.color + "20" }]}>
                  <Text style={[styles.badgeText, { color: status.color }]}>{status.text}</Text>
                </View>
              </View>
              <Text style={[styles.cell, { flex: 0.7, color: div.color }]}>{div.text}</Text>
            </TouchableOpacity>
            {isExpanded && <TimeframeDetail tf={tf} />}
          </View>
        );
      })}

      {/* Legend — collapsible, default hidden */}
      <View style={styles.legendContainer}>
        <TouchableOpacity onPress={() => setLegendOpen((v) => !v)} style={styles.legendTitleRow} activeOpacity={0.7}>
          <Text style={styles.legendTitle}>CHÚ THÍCH</Text>
          <Text style={styles.legendChevron}>{legendOpen ? "▼ ẩn" : "▶ xem"}</Text>
        </TouchableOpacity>

        {legendOpen && (
        <>
        <View style={styles.legendSection}>
          <Text style={styles.legendHeader}>Trạng thái RSI:</Text>
          <View style={styles.legendRow}>
            <View style={[styles.legendBadge, { backgroundColor: COLORS.bear + "20" }]}>
              <Text style={[styles.legendBadgeText, { color: COLORS.bear }]}>QUÁ MUA</Text>
            </View>
            <Text style={styles.legendDesc}>RSI {">"} {overboughtLevel} — Giá đã tăng quá nhiều, có thể sắp giảm</Text>
          </View>
          <View style={styles.legendRow}>
            <View style={[styles.legendBadge, { backgroundColor: COLORS.bull + "20" }]}>
              <Text style={[styles.legendBadgeText, { color: COLORS.bull }]}>QUÁ BÁN</Text>
            </View>
            <Text style={styles.legendDesc}>RSI {"<"} {oversoldLevel} — Giá đã giảm quá nhiều, có thể sắp tăng</Text>
          </View>
          <View style={styles.legendRow}>
            <View style={[styles.legendBadge, { backgroundColor: COLORS.neutral + "20" }]}>
              <Text style={[styles.legendBadgeText, { color: COLORS.neutral }]}>TRUNG TÍNH</Text>
            </View>
            <Text style={styles.legendDesc}>RSI trong vùng {oversoldLevel}-{overboughtLevel} — Chưa có tín hiệu rõ ràng</Text>
          </View>
        </View>

        <View style={styles.legendSection}>
          <Text style={styles.legendHeader}>Phân kỳ RSI:</Text>
          <View style={styles.legendRow}>
            <Text style={[styles.legendIcon, { color: COLORS.bear }]}>⚠ Giảm</Text>
            <Text style={styles.legendDesc}>Phân kỳ giảm — Giá tạo đỉnh cao hơn nhưng RSI tạo đỉnh thấp hơn → Tín hiệu GIẢM</Text>
          </View>
          <View style={styles.legendRow}>
            <Text style={[styles.legendIcon, { color: COLORS.bull }]}>🚀 Tăng</Text>
            <Text style={styles.legendDesc}>Phân kỳ tăng — Giá tạo đáy thấp hơn nhưng RSI tạo đáy cao hơn → Tín hiệu TĂNG</Text>
          </View>
        </View>

        <View style={styles.legendSection}>
          <Text style={styles.legendHeader}>StochRSI (Stochastic RSI):</Text>
          <View style={styles.legendRow}>
            <Text style={[styles.legendIcon, { color: COLORS.bear }]}>K {">"} 80</Text>
            <Text style={styles.legendDesc}>Vùng quá mua — Động lực tăng yếu dần</Text>
          </View>
          <View style={styles.legendRow}>
            <Text style={[styles.legendIcon, { color: COLORS.bull }]}>K {"<"} 20</Text>
            <Text style={styles.legendDesc}>Vùng quá bán — Động lực giảm yếu dần</Text>
          </View>
          <View style={styles.legendRow}>
            <Text style={[styles.legendIcon, { color: COLORS.warning }]}>⚡ Kề nhau</Text>
            <Text style={styles.legendDesc}>2 khung kề nhau cùng {">"} 80 hoặc {"<"} 20 → Xác suất quay đầu RẤT CAO</Text>
          </View>
        </View>

        <View style={styles.legendSection}>
          <Text style={styles.legendHeader}>MACD:</Text>
          <View style={styles.legendRow}>
            <Text style={[styles.legendIcon, { color: COLORS.bull }]}>TĂNG</Text>
            <Text style={styles.legendDesc}>MACD Histogram {">"} 0 — Xu hướng tăng</Text>
          </View>
          <View style={styles.legendRow}>
            <Text style={[styles.legendIcon, { color: COLORS.bear }]}>GIẢM</Text>
            <Text style={styles.legendDesc}>MACD Histogram {"<"} 0 — Xu hướng giảm</Text>
          </View>
        </View>
        </>
        )}
      </View>
    </View>
  );
}

const TimeframeTable = React.memo(TimeframeTableInner);
export default TimeframeTable;

const styles = StyleSheet.create({
  container: { backgroundColor: P.card, borderRadius: 2, padding: 12, paddingLeft: 16, marginBottom: 10, borderLeftWidth: 4, borderLeftColor: P.tertiary },
  title: { color: P.text, fontSize: 11, fontWeight: "700", fontFamily: "SpaceGrotesk_700Bold", letterSpacing: 2, marginBottom: 10, textTransform: "uppercase" },
  headerRow: { flexDirection: "row", alignItems: "center", paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: P.borderSoft, marginBottom: 4, backgroundColor: P.surface, paddingTop: 6 },
  headerCell: { color: P.dim, fontSize: 8, fontWeight: "700", fontFamily: "SpaceGrotesk_700Bold", textAlign: "center", letterSpacing: 1 },
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: P.borderSoft },
  rowExpanded: { backgroundColor: P.primaryContainer + "0C", borderRadius: 2 },
  cell: { fontSize: 11, fontWeight: "600", fontFamily: "monospace", textAlign: "center", color: P.text },
  tfLabel: { color: P.primaryContainer, fontWeight: "800", letterSpacing: 0.5, fontFamily: "SpaceGrotesk_700Bold" },
  stochCell: { alignItems: "center", gap: 2 },
  stochBadge: { paddingHorizontal: 4, paddingVertical: 1, borderRadius: 0, borderWidth: 1, borderColor: P.border },
  stochBadgeText: { fontSize: 7, fontWeight: "800", fontFamily: "monospace" },
  badge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 0, borderWidth: 1, borderColor: P.border },
  badgeText: { fontSize: 8, fontWeight: "700", fontFamily: "monospace", letterSpacing: 0.5 },
  legendContainer: { marginTop: 16, paddingTop: 12, borderTopWidth: 1, borderTopColor: P.border },
  legendTitleRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, marginBottom: 10 },
  legendTitle: { color: P.primaryContainer, fontSize: 10, fontWeight: "700", fontFamily: "SpaceGrotesk_700Bold", letterSpacing: 2, textAlign: "center" },
  legendChevron: { color: P.dim, fontSize: 9, fontFamily: "monospace" },
  legendSection: { marginBottom: 10 },
  legendHeader: { color: P.text, fontSize: 10, fontWeight: "800", fontFamily: "monospace", marginBottom: 4, letterSpacing: 0.5 },
  legendRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 3, paddingLeft: 8 },
  legendBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 0, minWidth: 60, alignItems: "center", borderWidth: 1, borderColor: P.border },
  legendBadgeText: { fontSize: 8, fontWeight: "800", fontFamily: "monospace", letterSpacing: 0.5 },
  legendIcon: { fontSize: 10, fontWeight: "700", fontFamily: "monospace", minWidth: 60 },
  legendDesc: { flex: 1, color: P.dim, fontSize: 9, fontFamily: "monospace", lineHeight: 14 },
});
