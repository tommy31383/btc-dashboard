/**
 * Binance Dark Pro Primitives — reusable pieces (AccentBar, SubCard, OuterCard,
 * MicroLabel/SectionLabel, StatCol, Sparkline, TFTabs, Pill, Chip).
 *
 * Legacy Corner export kept as no-op for backwards compat with older callers.
 */
import React from "react";
import { View, Text, StyleSheet, ViewStyle, TextStyle, TouchableOpacity } from "react-native";
import Svg, { Polyline } from "react-native-svg";
import { P } from "../../utils/v2Theme";

// ── Legacy Corner (no-op in Binance Pro) ─────────────────────────
export type CornerPos = "tl" | "tr" | "bl" | "br";
export function Corner(_props: { pos: CornerPos; color?: string; size?: number }) {
  return null;
}

// ── AccentBar — left-side colored stripe (Material You border-l-4 signature) ─
export function AccentBar({ color = P.primaryContainer, glow = false, width = 4 }: { color?: string; glow?: boolean; width?: number }) {
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute", left: 0, top: 0, bottom: 0, width,
        backgroundColor: color,
        shadowColor: glow ? color : "transparent",
        shadowOffset: { width: 2, height: 0 },
        shadowOpacity: glow ? 0.6 : 0,
        shadowRadius: 6,
        elevation: glow ? 4 : 0,
      }}
    />
  );
}

// ── SubCard — nested elevated surface (flat, no brackets) ────────
export function SubCard({
  children,
  accent,
  style,
}: {
  children: React.ReactNode;
  accent?: string;
  style?: ViewStyle | ViewStyle[];
}) {
  return (
    <View style={[primStyles.subCard, accent ? { borderColor: accent + "66" } : null, style as any]}>
      {accent && <AccentBar color={accent} />}
      {children}
    </View>
  );
}

// ── OuterCard — main card wrapper, flat with subtle border ──────
export function OuterCard({
  children,
  style,
  accent,
  glow = false,
  // kept for API compat; ignored in Binance Pro
  withGrid: _wg = false,
}: {
  children: React.ReactNode;
  style?: ViewStyle | ViewStyle[];
  accent?: string;
  glow?: boolean;
  withGrid?: boolean;
}) {
  return (
    <View style={[primStyles.outer, accent ? primStyles.outerWithAccent : null, style as any]}>
      {accent && <AccentBar color={accent} glow={glow} width={4} />}
      {children}
    </View>
  );
}

// ── SectionLabel — tiny caption + big H2 header (Material You pattern) ───────
// Example: <SectionLabel caption="System Monitor" title="Active Rules" right={<Text>18</Text>} />
export function SectionLabel({
  caption,
  title,
  right,
}: {
  caption: string;
  title?: string;
  right?: React.ReactNode;
}) {
  return (
    <View style={primStyles.sectionLabel}>
      <View style={{ flex: 1 }}>
        <Text style={primStyles.sectionCaption}>{caption}</Text>
        {title && <Text style={primStyles.sectionTitle}>{title}</Text>}
      </View>
      {right ? <View style={{ marginLeft: 8 }}>{right}</View> : null}
    </View>
  );
}

// ── MicroLabel — section header in Binance Pro (cleaner caps) ───
export function MicroLabel({ children, style }: { children: React.ReactNode; style?: TextStyle }) {
  return <Text style={[primStyles.microLabel, style]}>{children}</Text>;
}

// ── Pill — small rounded badge ───────────────────────────────────
export function Pill({
  children,
  color = P.dim,
  bg,
  style,
}: {
  children: React.ReactNode;
  color?: string;
  bg?: string;
  style?: ViewStyle;
}) {
  return (
    <View style={[primStyles.pill, { backgroundColor: bg || color + "22" }, style]}>
      <Text style={[primStyles.pillText, { color }]}>{children}</Text>
    </View>
  );
}

// ── StatCol — label + value column ───────────────────────────────
export function StatCol({
  label,
  value,
  color = P.text,
  divider,
  flex = 1,
}: {
  label: string;
  value: string | React.ReactNode;
  color?: string;
  divider?: boolean;
  flex?: number;
}) {
  return (
    <View style={[primStyles.statCol, { flex }, divider && { borderLeftWidth: 1, borderLeftColor: P.divider }]}>
      <Text style={primStyles.statLabel}>{label}</Text>
      {typeof value === "string" ? (
        <Text style={[primStyles.statValue, { color }]}>{value}</Text>
      ) : (
        value
      )}
    </View>
  );
}

// ── Sparkline ────────────────────────────────────────────────────
export function Sparkline({
  data,
  color,
  width = 90,
  height = 44,
}: {
  data: number[];
  color: string;
  width?: number;
  height?: number;
}) {
  if (data.length < 2) return <View style={{ width, height }} />;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const points = data
    .map((y, i) => {
      const x = (i / (data.length - 1)) * 100;
      const yy = 100 - ((y - min) / range) * 100;
      return `${x.toFixed(2)},${yy.toFixed(2)}`;
    })
    .join(" ");
  const areaPoints = `${points} 100,100 0,100`;
  return (
    <Svg width={width} height={height} viewBox="0 0 100 100" preserveAspectRatio="none">
      <Polyline points={areaPoints} fill={color} fillOpacity={0.18} stroke="none" />
      <Polyline points={points} fill="none" stroke={color} strokeWidth={2.2} vectorEffect="non-scaling-stroke" />
    </Svg>
  );
}

// ── TFTabs — pill-style tab group (Binance Pro) ──────────────────
export function TFTabs<T extends string>({
  tfs,
  selected,
  onSelect,
}: {
  tfs: readonly T[];
  selected: T;
  onSelect: (tf: T) => void;
}) {
  return (
    <View style={primStyles.tfTabsWrap}>
      {tfs.map((tf) => {
        const active = tf === selected;
        return (
          <TouchableOpacity
            key={tf as string}
            onPress={() => onSelect(tf)}
            style={[primStyles.tfTab, active && primStyles.tfTabActive]}
          >
            <Text style={[primStyles.tfTabText, active && primStyles.tfTabTextActive]}>{tf as string}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

// ── Styles ──
const primStyles = StyleSheet.create({
  outer: {
    backgroundColor: P.card,     // #1c1b1b surface-container-low
    borderRadius: 2,             // rounded-sm (Material You sharp)
    padding: 14,
    marginBottom: 10,
    overflow: "hidden",
    position: "relative",
  },
  outerWithAccent: {
    paddingLeft: 18,             // 14 + 4 for border-l-4 accent
  },
  sectionLabel: {
    flexDirection: "row",
    alignItems: "flex-end",
    marginBottom: 10,
    paddingHorizontal: 2,
  },
  sectionCaption: {
    color: P.text2,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 2,
    textTransform: "uppercase",
    fontFamily: "SpaceGrotesk_700Bold",
    marginBottom: 2,
  },
  sectionTitle: {
    color: P.text,
    fontSize: 22,
    fontWeight: "700",
    fontFamily: "SpaceGrotesk_700Bold",
    letterSpacing: -0.5,
  },
  subCard: {
    backgroundColor: P.cardAlt,  // #201f1f surface-container
    borderRadius: 2,
    padding: 10,
    position: "relative",
    overflow: "hidden",
  },
  microLabel: {
    color: P.text2,              // warm beige on-surface-variant
    fontSize: 10,
    letterSpacing: 2,            // tracking-widest
    fontWeight: "700",
    textTransform: "uppercase",
    fontFamily: "SpaceGrotesk_700Bold",
  },
  pill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,            // rounded-full
    alignSelf: "flex-start",
  },
  pillText: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.3,
    fontFamily: "SpaceGrotesk_700Bold",
  },
  statCol: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  statLabel: {
    color: P.dim,
    fontSize: 10,
    fontWeight: "600",
    marginBottom: 3,
    textTransform: "uppercase",
    letterSpacing: 1,
    fontFamily: "SpaceGrotesk_500Medium",
  },
  statValue: {
    fontSize: 13,
    fontWeight: "700",
    fontFamily: "JetBrainsMono_500Medium",
    letterSpacing: -0.2,
  },
  tfTabsWrap: {
    flexDirection: "row",
    backgroundColor: P.surface,   // #0e0e0e surface-container-lowest
    padding: 3,
    borderRadius: 2,              // rounded-sm
    gap: 2,
  },
  tfTab: {
    flex: 1,
    paddingVertical: 7,
    alignItems: "center",
    borderRadius: 2,
  },
  tfTabActive: {
    backgroundColor: P.secondaryContainer, // #e78603 deep orange
  },
  tfTabText: {
    color: P.text2,
    fontSize: 11,
    fontWeight: "700",
    fontFamily: "SpaceGrotesk_700Bold",
  },
  tfTabTextActive: {
    color: P.onSecondary,         // dark text on amber
    fontWeight: "800",
  },
});
