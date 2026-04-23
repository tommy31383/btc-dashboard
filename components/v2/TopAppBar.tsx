/**
 * TopAppBar — sticky header ở top của app.
 *
 * Pattern từ Stitch (02_dashboard_main.html, 05_chart_table_log.html):
 *   h-16 bg #1C1B1B (alpha 70%) + backdrop-blur-xl
 *   Left:  [menu icon] + "₿ BTC DASHBOARD" title (bitcoinOrange, tracking-widest)
 *   Right: [notifications] [settings] icons
 *
 * Không có backdrop-blur trong RN → fallback là bg solid tone surface-container-low.
 */
import React from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { P } from "../../utils/v2Theme";
import { MaterialIcon } from "./MaterialIcon";

export function TopAppBar({
  title = "BTC DASHBOARD",
  onMenu,
  onNotifications,
  onSettings,
}: {
  title?: string;
  onMenu?: () => void;
  onNotifications?: () => void;
  onSettings?: () => void;
}) {
  return (
    <View style={styles.bar}>
      <View style={styles.left}>
        <TouchableOpacity onPress={onMenu} hitSlop={8} style={styles.iconBtn}>
          <MaterialIcon name="menu" size={22} color={P.primaryContainer} />
        </TouchableOpacity>
        <Text style={styles.title}>
          <Text style={styles.bitcoin}>₿ </Text>
          {title}
        </Text>
      </View>
      <View style={styles.right}>
        {onNotifications && (
          <TouchableOpacity onPress={onNotifications} hitSlop={8} style={styles.iconBtn}>
            <MaterialIcon name="notifications" size={22} color={P.primaryContainer} />
          </TouchableOpacity>
        )}
        {onSettings && (
          <TouchableOpacity onPress={onSettings} hitSlop={8} style={styles.iconBtn}>
            <MaterialIcon name="settings" size={22} color={P.primaryContainer} />
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    height: 56,
    backgroundColor: P.card,       // #1c1b1b — no true backdrop-blur in RN
    borderBottomWidth: 2,
    borderBottomColor: P.elevated, // #2a2a2a
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
  },
  left: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  right: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  iconBtn: {
    padding: 4,
  },
  title: {
    color: P.primaryContainer,
    fontSize: 16,
    fontWeight: "700",
    letterSpacing: 2,
    fontFamily: "SpaceGrotesk_700Bold",
  },
  bitcoin: {
    color: P.bitcoinOrange,
  },
});
