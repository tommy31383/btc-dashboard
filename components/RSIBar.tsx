import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { COLORS } from "../utils/constants";

interface Props {
  value: number | null;
  overbought?: number;
  oversold?: number;
}

export default function RSIBar({ value, overbought = 70, oversold = 30 }: Props) {
  if (value === null) return <Text style={styles.na}>—</Text>;

  const color =
    value > overbought ? COLORS.bear : value < oversold ? COLORS.bull : COLORS.neutral;

  return (
    <View style={styles.container}>
      <View style={styles.barBg}>
        {/* Oversold marker */}
        <View style={[styles.marker, { left: `${oversold}%` }]} />
        {/* Overbought marker */}
        <View style={[styles.marker, { left: `${overbought}%` }]} />
        {/* Fill */}
        <View style={[styles.barFill, { width: `${Math.min(value, 100)}%`, backgroundColor: color }]} />
      </View>
      <Text style={[styles.value, { color }]}>{value.toFixed(1)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  barBg: {
    flex: 1,
    height: 6,
    backgroundColor: "#ffffff15",
    borderRadius: 3,
    overflow: "hidden",
    position: "relative",
  },
  barFill: {
    height: "100%",
    borderRadius: 3,
  },
  marker: {
    position: "absolute",
    top: 0,
    width: 1,
    height: "100%",
    backgroundColor: "#ffffff30",
  },
  value: {
    fontSize: 11,
    fontWeight: "700",
    fontFamily: "monospace",
    width: 36,
    textAlign: "right",
  },
  na: {
    color: COLORS.textMuted,
    fontSize: 11,
    fontFamily: "monospace",
  },
});
