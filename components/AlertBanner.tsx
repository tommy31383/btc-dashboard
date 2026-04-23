/**
 * AlertBanner — Material You Critical Alerts (v4.3.20)
 *
 * Pattern mirror từ Stitch 03_signal_cluster.html Critical Alerts:
 *   border-l-4 border-error + warning icon header
 *   Each row: w-1 h-3 bg-error bullet (rectangular bar) + text
 *   bg surface-container-low
 */
import React, { useEffect, useRef } from "react";
import { View, Text, StyleSheet, Animated } from "react-native";
import { P } from "../utils/v2Theme";
import { AccentBar } from "./v2/Primitives";
import { MaterialIcon } from "./v2/MaterialIcon";
import { Alert } from "../hooks/useAlerts";

interface Props { alerts: Alert[]; }

function AlertItem({ alert }: { alert: Alert }) {
  const pulseAnim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const a = Animated.loop(Animated.sequence([
      Animated.timing(pulseAnim, { toValue: 0.7, duration: 900, useNativeDriver: true }),
      Animated.timing(pulseAnim, { toValue: 1, duration: 900, useNativeDriver: true }),
    ]));
    a.start();
    return () => a.stop();
  }, [pulseAnim]);
  const isBullish = alert.message.includes("QUÁ BÁN") || alert.soundType === "bullish";
  const c = isBullish ? P.green : P.error;
  return (
    <Animated.View style={[styles.item, { opacity: pulseAnim }]}>
      <View style={[styles.bullet, { backgroundColor: c }]} />
      <View style={styles.content}>
        <Text style={[styles.text, { color: P.text }]}>{alert.message}</Text>
        <Text style={styles.time}>{new Date(alert.timestamp).toLocaleTimeString()}</Text>
      </View>
    </Animated.View>
  );
}

function AlertBannerInner({ alerts }: Props) {
  if (alerts.length === 0) return null;
  return (
    <View style={styles.card}>
      <AccentBar color={P.error} />
      <View style={styles.header}>
        <MaterialIcon name="warning" size={20} color={P.error} />
        <Text style={styles.headerTitle}>Critical Alerts</Text>
        <View style={styles.countBadge}>
          <Text style={styles.countBadgeText}>{alerts.length}</Text>
        </View>
      </View>
      <View style={styles.list}>
        {alerts.map((a) => <AlertItem key={a.id} alert={a} />)}
      </View>
    </View>
  );
}

const AlertBanner = React.memo(AlertBannerInner);
export default AlertBanner;

const styles = StyleSheet.create({
  card: {
    backgroundColor: P.card,
    borderRadius: 2,
    paddingLeft: 18,
    paddingRight: 14,
    paddingVertical: 12,
    marginBottom: 10,
    position: "relative",
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 10,
  },
  headerTitle: {
    flex: 1,
    color: P.text,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 1.5,
    textTransform: "uppercase",
    fontFamily: "SpaceGrotesk_700Bold",
  },
  countBadge: {
    backgroundColor: P.error,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 2,
  },
  countBadgeText: {
    color: P.onError,
    fontSize: 10,
    fontWeight: "800",
    fontFamily: "SpaceGrotesk_700Bold",
  },
  list: { gap: 10 },
  item: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  bullet: {
    width: 4,
    height: 14,
    marginTop: 3,
  },
  content: { flex: 1 },
  text: {
    fontSize: 12,
    fontWeight: "500",
    fontFamily: "Inter_500Medium",
    lineHeight: 18,
  },
  time: {
    color: P.dim,
    fontSize: 10,
    fontFamily: "JetBrainsMono_400Regular",
    marginTop: 2,
  },
});
