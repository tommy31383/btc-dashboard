/**
 * AlertLog — Material You history ticker (v4.3.20)
 *
 * Pattern mirror từ Stitch 05 History card:
 *   border-l-4 dim (#514439) · bg surface-container-low
 *   Each row: minimal, icon + message + timestamp right-aligned
 */
import React from "react";
import { View, Text, StyleSheet, ScrollView } from "react-native";
import { P } from "../utils/v2Theme";
import { Alert } from "../hooks/useAlerts";

interface Props { alerts: Alert[]; }

function AlertLogInner({ alerts }: Props) {
  if (alerts.length === 0) return null;
  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.caption}>ALERT LOG</Text>
        <View style={styles.countBadge}>
          <Text style={styles.countBadgeText}>{alerts.length}</Text>
        </View>
      </View>
      <ScrollView style={styles.list} nestedScrollEnabled>
        {alerts.map((a) => (
          <View key={a.id} style={styles.item}>
            <Text style={styles.icon}>{a.icon}</Text>
            <Text style={styles.message} numberOfLines={1}>{a.message}</Text>
            <Text style={styles.time}>
              {new Date(a.timestamp).toLocaleTimeString("vi-VN", {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
            </Text>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const AlertLog = React.memo(AlertLogInner);
export default AlertLog;

const styles = StyleSheet.create({
  card: {
    backgroundColor: P.card,
    borderRadius: 2,
    paddingHorizontal: 14,
    paddingLeft: 18,
    paddingVertical: 12,
    marginBottom: 10,
    borderLeftWidth: 4,
    borderLeftColor: P.fade,
    maxHeight: 240,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  caption: {
    color: P.text2,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 2,
    textTransform: "uppercase",
    fontFamily: "SpaceGrotesk_700Bold",
  },
  countBadge: {
    backgroundColor: P.surface,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 2,
  },
  countBadgeText: {
    color: P.dim,
    fontSize: 10,
    fontWeight: "800",
    fontFamily: "SpaceGrotesk_700Bold",
  },
  list: { maxHeight: 180 },
  item: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 6,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: P.borderSoft,
  },
  icon: { fontSize: 12, marginRight: 8 },
  message: {
    flex: 1,
    color: P.text,
    fontSize: 11,
    fontFamily: "Inter_400Regular",
  },
  time: {
    color: P.dim,
    fontSize: 9,
    fontFamily: "JetBrainsMono_400Regular",
    marginLeft: 8,
    letterSpacing: 0.5,
  },
});
