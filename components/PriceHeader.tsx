/**
 * PriceHeader — Material You warm hero card (v4.3.20)
 *
 * Pattern mirror từ Stitch 03_signal_cluster.html Price Hero:
 *   border-l-4 border-bitcoinOrange + bg surface-container-low
 *   Top row: BTC/USDT label + price + right-side 24h change
 *   Sparkline bar-style (emerald bars gradient) dưới price
 *   3-col stats grid (High / Low / Vol) trong surface-container-lowest cells
 */
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import Svg, { Polyline, Circle, Defs, LinearGradient, Stop } from "react-native-svg";
import { P } from "../utils/v2Theme";
import { AccentBar } from "./v2/Primitives";
import { MaterialIcon } from "./v2/MaterialIcon";
import { PriceData } from "../hooks/useBinancePrice";
import DebugLabel from "./DebugLabel";

interface Props {
  priceData: PriceData | null;
  priceHistory: number[];
  connectionStatus: "LIVE" | "POLLING" | "ERROR";
}

/** Bar-style sparkline (Stitch signal-cluster) — vertical bars ascending height. */
function BarSparkline({ data, color }: { data: number[]; color: string }) {
  if (data.length < 2) return <View style={{ height: 48 }} />;
  const BARS = 12;
  // downsample/average to BARS buckets
  const step = data.length / BARS;
  const buckets: number[] = [];
  for (let i = 0; i < BARS; i++) {
    const start = Math.floor(i * step);
    const end = Math.floor((i + 1) * step);
    const slice = data.slice(start, Math.max(end, start + 1));
    const avg = slice.reduce((a, b) => a + b, 0) / slice.length;
    buckets.push(avg);
  }
  const min = Math.min(...buckets);
  const max = Math.max(...buckets);
  const range = max - min || 1;
  return (
    <View style={styles.barSpark}>
      {buckets.map((v, i) => {
        const pct = (v - min) / range;
        // opacity ramps up left → right for depth
        const opacity = 0.2 + (i / (BARS - 1)) * 0.8;
        const isLast = i === BARS - 1;
        const h = 10 + pct * 34;
        return (
          <View key={i} style={{ flex: 1, alignItems: "center", justifyContent: "flex-end" }}>
            <View
              style={{
                width: "82%",
                height: h,
                backgroundColor: color,
                opacity: isLast ? 1 : opacity,
                position: "relative",
              }}
            >
              {isLast && (
                <View
                  pointerEvents="none"
                  style={{
                    position: "absolute",
                    top: -3,
                    right: -3,
                    width: 6,
                    height: 6,
                    borderRadius: 999,
                    backgroundColor: color,
                  }}
                />
              )}
            </View>
          </View>
        );
      })}
    </View>
  );
}

function formatNum(n: number, decimals = 2): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return n.toFixed(decimals);
}

export default function PriceHeader({ priceData, priceHistory, connectionStatus }: Props) {
  const isUp = priceData ? priceData.changePct24h >= 0 : true;
  const trendColor = isUp ? P.green : P.error;
  const statusColor =
    connectionStatus === "LIVE" ? P.green : connectionStatus === "ERROR" ? P.error : P.primaryContainer;
  const statusLabel =
    connectionStatus === "LIVE" ? "LIVE" : connectionStatus === "ERROR" ? "ERR" : "POLL 3s";

  return (
    <View style={styles.card}>
      <DebugLabel name="PriceHeader" />
      <AccentBar color={P.bitcoinOrange} />

      {/* Top row: symbol + status */}
      <View style={styles.topRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.microLabel}>BTC / USDT · SPOT</Text>
          <Text style={styles.price}>
            {priceData
              ? "$" +
                priceData.price.toLocaleString("en-US", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })
              : "—"}
          </Text>
        </View>
        <View style={{ alignItems: "flex-end" }}>
          <View style={styles.changeRow}>
            <MaterialIcon
              name={isUp ? "trending_up" : "trending_down"}
              size={14}
              color={trendColor}
            />
            <Text style={[styles.changeText, { color: trendColor }]}>
              {priceData
                ? `${priceData.changePct24h >= 0 ? "+" : ""}${priceData.changePct24h.toFixed(2)}%`
                : "—"}
            </Text>
          </View>
          <View style={[styles.statusDot, { backgroundColor: statusColor }]}>
            <Text style={styles.statusText}>{statusLabel}</Text>
          </View>
        </View>
      </View>

      {/* Bar sparkline */}
      <BarSparkline data={priceHistory} color={trendColor} />

      {/* 3-col stats */}
      <View style={styles.statsRow}>
        <View style={styles.statCell}>
          <Text style={styles.statLabel}>HIGH</Text>
          <Text style={[styles.statValue, { color: P.green }]}>
            {priceData ? formatNum(priceData.high24h) : "—"}
          </Text>
        </View>
        <View style={styles.statCell}>
          <Text style={styles.statLabel}>LOW</Text>
          <Text style={[styles.statValue, { color: P.error }]}>
            {priceData ? formatNum(priceData.low24h) : "—"}
          </Text>
        </View>
        <View style={[styles.statCell, styles.statCellLast]}>
          <Text style={styles.statLabel}>VOL 24H</Text>
          <Text style={[styles.statValue, { color: P.primary }]}>
            {priceData ? formatNum(priceData.volume24h) : "—"}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: P.card,
    borderRadius: 2,
    padding: 14,
    paddingLeft: 18,
    marginBottom: 10,
    position: "relative",
    overflow: "hidden",
  },
  topRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  microLabel: {
    color: P.text2,
    fontSize: 10,
    letterSpacing: 2,
    fontWeight: "700",
    textTransform: "uppercase",
    fontFamily: "SpaceGrotesk_700Bold",
    marginBottom: 4,
  },
  price: {
    color: P.text,
    fontSize: 28,
    fontWeight: "700",
    fontFamily: "SpaceGrotesk_700Bold",
    letterSpacing: -0.8,
  },
  changeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
  },
  changeText: {
    fontSize: 13,
    fontWeight: "600",
    fontFamily: "SpaceGrotesk_500Medium",
  },
  statusDot: {
    marginTop: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 2,
    alignSelf: "flex-end",
  },
  statusText: {
    color: P.onPrimary,
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 1,
    fontFamily: "SpaceGrotesk_700Bold",
  },
  barSpark: {
    flexDirection: "row",
    height: 48,
    marginTop: 16,
    gap: 2,
  },
  statsRow: {
    flexDirection: "row",
    gap: 6,
    marginTop: 14,
  },
  statCell: {
    flex: 1,
    backgroundColor: P.surface,
    padding: 8,
  },
  statCellLast: {
    borderRightWidth: 2,
    borderRightColor: P.primaryContainer + "33",
  },
  statLabel: {
    color: P.dim,
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 1.5,
    textTransform: "uppercase",
    fontFamily: "SpaceGrotesk_700Bold",
  },
  statValue: {
    fontSize: 13,
    fontWeight: "700",
    fontFamily: "JetBrainsMono_500Medium",
    marginTop: 3,
  },
});

// Unused exports kept for backwards compat
void Svg; void Polyline; void Circle; void Defs; void LinearGradient; void Stop;
