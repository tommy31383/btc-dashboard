/**
 * GoldenFiringBanner — v4.3.20 Material You warm
 *
 * Banner hiển thị đầu dashboard RADAR khi có ≥1 Golden rule đang firing.
 * Ấn banner → chuyển qua tab TRADES để xem chi tiết.
 *
 * Visual:
 *   - border-l-4 bitcoinOrange + pulse glow
 *   - gradient cam mờ → trong suốt
 *   - 🔥 icon lớn · tiêu đề caps · tên rule + WR · CTA "VIEW →"
 */
import React, { useEffect, useRef } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Animated, Easing } from "react-native";
import { P, fonts } from "../utils/v2Theme";
import type { GoldenOpportunity } from "../hooks/useRiskRadar";

interface Props {
  goldens: GoldenOpportunity[];
  onPress?: () => void;
}

export function GoldenFiringBanner({ goldens, onPress }: Props) {
  const firing = goldens.filter((g) => g.allPass);
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (firing.length === 0) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
        Animated.timing(pulse, { toValue: 0, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [firing.length, pulse]);

  if (firing.length === 0) return null;

  const bgOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.18, 0.32] });
  const shadowRadius = pulse.interpolate({ inputRange: [0, 1], outputRange: [6, 14] });

  const top = firing[0];
  const extraCount = firing.length - 1;
  const sub =
    extraCount > 0
      ? `${top.title} · ${top.wr}  (+${extraCount} more)`
      : `${top.title} · ${top.wr}`;

  return (
    <TouchableOpacity activeOpacity={0.85} onPress={onPress}>
      <Animated.View
        style={[
          styles.banner,
          {
            backgroundColor: P.bitcoinOrange + "22",
            shadowRadius: shadowRadius as any,
          },
        ]}
      >
        <Animated.View style={[styles.bgPulse, { opacity: bgOpacity }]} />
        <Text style={styles.fireIcon}>🔥</Text>
        <View style={styles.textWrap}>
          <Text style={styles.title}>
            {firing.length} GOLDEN{firing.length > 1 ? "S" : ""} FIRING
          </Text>
          <Text style={styles.sub} numberOfLines={2}>{sub}</Text>
        </View>
        <View style={styles.cta}>
          <Text style={styles.ctaText}>VIEW →</Text>
        </View>
      </Animated.View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    borderLeftWidth: 4,
    borderLeftColor: P.bitcoinOrange,
    borderRadius: 2,
    paddingVertical: 12,
    paddingLeft: 16,
    paddingRight: 12,
    marginBottom: 10,
    gap: 10,
    overflow: "hidden",
    shadowColor: P.bitcoinOrange,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6,
    elevation: 6,
  },
  bgPulse: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: P.bitcoinOrange,
  },
  fireIcon: {
    fontSize: 24,
  },
  textWrap: {
    flex: 1,
  },
  title: {
    fontFamily: fonts.headline,
    fontWeight: "800",
    fontSize: 12,
    letterSpacing: 2,
    color: P.bitcoinOrange,
    textTransform: "uppercase",
  },
  sub: {
    fontFamily: fonts.body,
    fontSize: 11,
    color: P.text2,
    marginTop: 2,
  },
  cta: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: P.bitcoinOrange,
    borderRadius: 2,
  },
  ctaText: {
    fontFamily: fonts.headline,
    fontWeight: "800",
    fontSize: 10,
    letterSpacing: 2,
    color: P.bitcoinOrange,
  },
});
