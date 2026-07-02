import React from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import { P } from "../utils/v2Theme";
import { INDICATORS, IndicatorKey } from "../utils/chartIndicators";

interface Props {
  enabled: IndicatorKey[];
  onToggle: (key: IndicatorKey) => void;
  onReset: () => void;
}

export default function ChartIndicatorPanel({ enabled, onToggle, onReset }: Props) {
  const overlayIndicators = INDICATORS.filter((i) => i.group === "overlay");
  const oscillatorIndicators = INDICATORS.filter((i) => i.group === "oscillator");

  const renderRow = (key: IndicatorKey, label: string) => {
    const isOn = enabled.includes(key);
    return (
      <Pressable key={key} onPress={() => onToggle(key)} style={styles.row}>
        <Text style={styles.rowLabel}>{label}</Text>
        <View style={[styles.toggleTrack, isOn && styles.toggleTrackOn]}>
          <View style={[styles.toggleThumb, isOn && styles.toggleThumbOn]} />
        </View>
      </Pressable>
    );
  };

  return (
    <View style={styles.container}>
      <Text style={styles.sectionTitle}>OVERLAY</Text>
      {overlayIndicators.map((i) => renderRow(i.key, i.label))}
      <Text style={styles.sectionTitle}>OSCILLATOR PANES</Text>
      {oscillatorIndicators.map((i) => renderRow(i.key, i.label))}
      <Pressable onPress={onReset} style={styles.resetBtn}>
        <Text style={styles.resetLabel}>Reset mặc định</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: P.card, borderRadius: 12, padding: 12, minWidth: 240 },
  sectionTitle: { color: P.dim, fontSize: 10, fontWeight: "700", marginTop: 10, marginBottom: 4 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: P.border,
  },
  rowLabel: { color: P.text, fontSize: 13 },
  toggleTrack: { width: 36, height: 20, borderRadius: 10, backgroundColor: P.borderSoft, padding: 2, justifyContent: "center" },
  toggleTrackOn: { backgroundColor: P.primaryContainer },
  toggleThumb: { width: 16, height: 16, borderRadius: 8, backgroundColor: P.text },
  toggleThumbOn: { alignSelf: "flex-end" },
  resetBtn: { marginTop: 12, paddingVertical: 8, alignItems: "center" },
  resetLabel: { color: P.dim, fontSize: 12, fontWeight: "600" },
});
