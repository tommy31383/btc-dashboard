import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { P } from "../utils/v2Theme";
import DebugLabel from "./DebugLabel";
import { RawKlinesMap } from "../hooks/useBinanceKlines";
import { TimeframeKey } from "../utils/constants";
import { RuleAlert } from "../hooks/useRuleAlerts";

interface Props {
  rawKlines: RawKlinesMap;
  selectedTF: TimeframeKey;
  onSelectTF: (tf: TimeframeKey) => void;
  activeAlerts: RuleAlert[];
}

// Intentionally does NOT import "lightweight-charts" (DOM-only library) — this file
// is the native counterpart Metro resolves for iOS/Android builds.
export default function TradingChartTab(_props: Props) {
  return (
    <View style={styles.container}>
      <DebugLabel name="TradingChartTab.native" />
      <Text style={styles.text}>
        Chart chuyên nghiệp hiện chỉ hỗ trợ bản web.{"\n"}Mở trên trình duyệt để xem đầy đủ.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, backgroundColor: P.bg },
  text: { color: P.dim, textAlign: "center", fontSize: 14 },
});
