/**
 * BottomNavBar — fixed footer với các tab đã có màn hình.
 *
 * Pattern từ Stitch (06_settings.html variant — chuẩn Material You):
 *   h-16 bg #1C1B1B, border-t outline-variant
 *   Active tab: bg neutral-900 + border-t-2 border-bitcoinOrange, text primaryContainer
 *   Inactive: text outline, hover text primaryContainer
 *
 * Tabs:
 *   RADAR (default active for dashboard)
 *   TRADES
 *   GPT RULE
 */
import React from "react";
import { View, Text, TouchableOpacity, StyleSheet, useWindowDimensions } from "react-native";
import { P } from "../../utils/v2Theme";
import { MaterialIcon } from "./MaterialIcon";

export type NavTab = "radar" | "trades" | "gptRule" | "live" | "all5m" | "server";

const ALL_TABS: { key: NavTab; label: string; icon: React.ComponentProps<typeof MaterialIcon>["name"]; pcOnly?: boolean }[] = [
  { key: "radar",   label: "RULE",    icon: "radar" },
  // v4.9.4 (anh Tommy): hide LIVE tab — server cloud đã thay thế, tab này deprecated.
  // { key: "live",    label: "LIVE",    icon: "bolt" },
  { key: "all5m",   label: "5m ALL",  icon: "auto_graph" },
  { key: "server",  label: "SERVER",  icon: "monitoring" },
];

const PC_BREAKPOINT = 768;

export function BottomNavBar({
  active,
  onSelect,
  tradesBadge = 0,
}: {
  active: NavTab;
  onSelect: (tab: NavTab) => void;
  /** Số golden đang firing — hiển thị badge cam trên tab TRADES khi > 0 */
  tradesBadge?: number;
}) {
  const { width } = useWindowDimensions();
  const TABS = ALL_TABS.filter((t) => !t.pcOnly || width >= PC_BREAKPOINT);
  return (
    <View style={styles.bar}>
      {TABS.map((t) => {
        const isActive = t.key === active;
        const showBadge = t.key === "trades" && tradesBadge > 0;
        return (
          <TouchableOpacity
            key={t.key}
            onPress={() => onSelect(t.key)}
            style={[styles.tab, isActive && styles.tabActive]}
            activeOpacity={0.75}
          >
            <View style={styles.iconWrap}>
              <MaterialIcon
                name={t.icon}
                size={22}
                color={isActive ? P.primaryContainer : P.dim}
              />
              {showBadge && (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{tradesBadge > 9 ? "9+" : String(tradesBadge)}</Text>
                </View>
              )}
            </View>
            <Text style={[styles.label, isActive && styles.labelActive]}>
              {t.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    height: 64,
    backgroundColor: P.card,      // #1c1b1b
    borderTopWidth: 1,
    borderTopColor: P.highest,    // #353534
    paddingHorizontal: 8,
  },
  tab: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    // leave 2px on top so active state's top border slots in
    paddingTop: 2,
    borderTopWidth: 2,
    borderTopColor: "transparent",
  },
  tabActive: {
    backgroundColor: P.elevated,  // #2a2a2a
    borderTopColor: P.bitcoinOrange,
  },
  label: {
    fontSize: 10,
    fontWeight: "600",
    letterSpacing: 1.5,
    color: P.dim,
    fontFamily: "SpaceGrotesk_500Medium",
  },
  labelActive: {
    color: P.primaryContainer,
  },
  iconWrap: {
    position: "relative",
    alignItems: "center",
    justifyContent: "center",
  },
  badge: {
    position: "absolute",
    top: -6,
    right: -10,
    minWidth: 18,
    height: 18,
    borderRadius: 999,
    backgroundColor: P.bitcoinOrange,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 5,
    shadowColor: P.bitcoinOrange,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6,
    shadowRadius: 6,
    elevation: 4,
  },
  badgeText: {
    fontFamily: "JetBrainsMono_700Bold",
    fontSize: 10,
    fontWeight: "700",
    color: P.onPrimary,
    lineHeight: 14,
  },
});
