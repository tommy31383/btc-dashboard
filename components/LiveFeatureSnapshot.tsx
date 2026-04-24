/**
 * LiveFeatureSnapshot — Market Regime + Action Hint + Near-Fire Rules (v4.3.35).
 *
 * Thay vì dump 6 cell raw values, panel này trả lời 3 câu hỏi:
 *   1. Thị trường đang ở regime nào? (TREND_UP / TREND_DOWN / SQUEEZE / EXHAUSTION / CHOPPY)
 *   2. Em nên làm gì? (action hint 1 dòng)
 *   3. Rule nào trong watchlist đang gần fire? (top 3 sorted by progress)
 */
import React, { useMemo } from "react";
import { View, Text, StyleSheet } from "react-native";
import { P } from "../utils/v2Theme";
import { TFAnalysis } from "../hooks/useBinanceKlines";
import { RuleMatchDetail } from "../hooks/useRuleAlerts";
import { parseRuleId, TrackedRuleId } from "../hooks/useTrackedRules";
import { getHardRulesForTF } from "../utils/hardRules";

interface Props {
  tfData: TFAnalysis[];
  trackedIds?: Set<TrackedRuleId> | TrackedRuleId[];
  ruleStatus?: Record<string, "ARMED" | "FIRED" | "OFF">;
  ruleMatchDetails?: Record<string, RuleMatchDetail>;
}

type Regime = "TREND_UP" | "TREND_DOWN" | "SQUEEZE" | "EXHAUSTION" | "CHOPPY";

interface RegimeInfo {
  key: Regime;
  emoji: string;
  label: string;
  color: string;
  bg: string;
  action: string;
}

function classifyRegime(tf1h: TFAnalysis, tf4h?: TFAnalysis): RegimeInfo {
  const rsi = tf1h.rsi ?? 50;
  const macdH = tf1h.macdHistogram ?? 0;
  const atr = tf1h.atrPct ?? 0.5;
  const dist = tf1h.emaDistPct ?? 0;
  const trend4hUp = tf4h && tf4h.ema50 && tf4h.lastClose > tf4h.ema50 * 1.003;
  const trend4hDown = tf4h && tf4h.ema50 && tf4h.lastClose < tf4h.ema50 * 0.997;

  // 1) EXHAUSTION — RSI cực trị, ưu tiên cao nhất
  if (rsi >= 72) {
    return {
      key: "EXHAUSTION", emoji: "⚠️", label: "EXHAUSTION (Quá mua)",
      color: P.error, bg: "#3a1a1a",
      action: "RSI cao — chờ pullback hoặc rule SHORT, không đu LONG",
    };
  }
  if (rsi <= 28) {
    return {
      key: "EXHAUSTION", emoji: "⚠️", label: "EXHAUSTION (Quá bán)",
      color: P.green, bg: "#1a2a1a",
      action: "RSI thấp — chờ bounce hoặc rule LONG, không cắt lỗ thêm",
    };
  }

  // 2) SQUEEZE — volatility thấp + giá sát EMA → breakout sắp đến
  if (atr < 0.3 && Math.abs(dist) < 0.5) {
    return {
      key: "SQUEEZE", emoji: "🟠", label: "SQUEEZE (Sắp breakout)",
      color: P.bitcoinOrange, bg: "#2a2010",
      action: "Volatility thấp, theo dõi sát — breakout có thể nổ bất kỳ lúc",
    };
  }

  // 3) TREND_UP / DOWN — dựa vào HTF 4h + MACD + EMA dist
  if (trend4hUp && macdH >= 0 && dist > 0) {
    return {
      key: "TREND_UP", emoji: "🟢", label: "TREND UP",
      color: P.green, bg: "#102a18",
      action: "Momentum tăng — chờ rule LONG fire, ưu tiên buy-on-dip",
    };
  }
  if (trend4hDown && macdH < 0 && dist < 0) {
    return {
      key: "TREND_DOWN", emoji: "🔴", label: "TREND DOWN",
      color: P.error, bg: "#2a1010",
      action: "Momentum giảm — chờ rule SHORT fire, không bắt đáy",
    };
  }

  // 4) Default — choppy
  return {
    key: "CHOPPY", emoji: "⚪", label: "CHOPPY (Sideways)",
    color: P.dim, bg: "#1a1a1a",
    action: "Không có hướng rõ — đứng ngoài hoặc scalp ngắn theo S/R",
  };
}

interface NearFireItem {
  id: string;
  tfKey: string;
  rank: number;
  side: string;
  progress: number;       // 0..1
  matched: number;
  required: number;
  reason: string;
  netPnL: number;
}

function buildNearFire(
  trackedIds: Set<TrackedRuleId> | TrackedRuleId[],
  ruleStatus: Record<string, "ARMED" | "FIRED" | "OFF">,
  ruleMatchDetails: Record<string, RuleMatchDetail>,
): NearFireItem[] {
  const arr = trackedIds instanceof Set ? Array.from(trackedIds) : trackedIds;
  const items: NearFireItem[] = [];
  const ruleCache: Record<string, ReturnType<typeof getHardRulesForTF>> = {};

  for (const id of arr) {
    const st = ruleStatus[id];
    const d = ruleMatchDetails[id];
    if (!st || st !== "ARMED" || !d) continue;
    if (d.required <= 0) continue;
    const { tfKey, rank } = parseRuleId(id);
    if (!ruleCache[tfKey]) ruleCache[tfKey] = getHardRulesForTF(tfKey);
    const rule: any = ruleCache[tfKey].find((r) => r.rank === rank);
    if (!rule) continue;
    const progress = Math.min(d.matched / d.required, 1);
    items.push({
      id, tfKey, rank,
      side: d.side,
      progress, matched: d.matched, required: d.required,
      reason: d.skipReason || "—",
      netPnL: rule.stats?.netPnL ?? 0,
    });
  }
  // Sort: progress desc, then netPnL desc
  items.sort((a, b) => b.progress - a.progress || b.netPnL - a.netPnL);
  return items.slice(0, 3);
}

function LiveFeatureSnapshotInner({ tfData, trackedIds, ruleStatus, ruleMatchDetails }: Props) {
  const tf1h = tfData.find((t) => t.key === "1h");
  const tf4h = tfData.find((t) => t.key === "4h");

  const regime = useMemo(() => (tf1h ? classifyRegime(tf1h, tf4h) : null),
    [tf1h?.rsi, tf1h?.macdHistogram, tf1h?.atrPct, tf1h?.emaDistPct, tf4h?.lastClose, tf4h?.ema50]);

  const nearFire = useMemo(() => {
    if (!trackedIds || !ruleStatus || !ruleMatchDetails) return [];
    return buildNearFire(trackedIds, ruleStatus, ruleMatchDetails);
  }, [trackedIds, ruleStatus, ruleMatchDetails]);

  if (!tf1h || !regime) return null;

  return (
    <View style={styles.wrap}>
      <Text style={styles.caption}>▼ MARKET STATUS · 1H</Text>

      {/* REGIME + ACTION HINT */}
      <View style={[styles.regimeBox, { backgroundColor: regime.bg, borderLeftColor: regime.color }]}>
        <View style={styles.regimeHeader}>
          <Text style={styles.regimeEmoji}>{regime.emoji}</Text>
          <Text style={[styles.regimeLabel, { color: regime.color }]}>{regime.label}</Text>
        </View>
        <Text style={styles.regimeAction}>{regime.action}</Text>
        <Text style={styles.regimeMeta}>
          RSI {tf1h.rsi?.toFixed(0) ?? "—"} · MACD {tf1h.macdHistogram !== null ? (tf1h.macdHistogram >= 0 ? "+" : "") + tf1h.macdHistogram.toFixed(0) : "—"}
          {" · "}ATR {tf1h.atrPct?.toFixed(2) ?? "—"}% · EMA {tf1h.emaDistPct !== null ? (tf1h.emaDistPct >= 0 ? "+" : "") + tf1h.emaDistPct.toFixed(2) + "%" : "—"}
        </Text>
      </View>

      {/* NEAR-FIRE RULES */}
      {nearFire.length > 0 && (
        <View style={styles.nearWrap}>
          <Text style={styles.nearCaption}>🔔 RULE GẦN FIRE NHẤT</Text>
          {nearFire.map((it) => (
            <View key={it.id} style={styles.nearRow}>
              <View style={styles.nearRowTop}>
                <Text style={styles.nearTag}>{it.tfKey.toUpperCase()} #{it.rank}</Text>
                <Text style={[styles.nearSide, { color: it.side === "SHORT" ? P.error : P.green }]}>{it.side}</Text>
                <Text style={styles.nearProgress}>{it.matched}/{it.required}</Text>
                <View style={styles.nearBarOuter}>
                  <View style={[styles.nearBarInner, { width: `${Math.round(it.progress * 100)}%`, backgroundColor: it.progress >= 0.66 ? P.green : it.progress >= 0.33 ? P.bitcoinOrange : P.dim }]} />
                </View>
              </View>
              <Text style={styles.nearReason} numberOfLines={1}>{it.reason}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const LiveFeatureSnapshot = React.memo(LiveFeatureSnapshotInner);
export default LiveFeatureSnapshot;

const styles = StyleSheet.create({
  wrap: { marginBottom: 10 },
  caption: {
    color: P.text2,
    fontSize: 10, fontWeight: "700", letterSpacing: 2,
    textTransform: "uppercase",
    fontFamily: "SpaceGrotesk_700Bold",
    marginBottom: 8, paddingHorizontal: 2,
  },
  regimeBox: {
    borderRadius: 4,
    borderLeftWidth: 4,
    paddingVertical: 12, paddingHorizontal: 14,
    marginBottom: 8,
  },
  regimeHeader: {
    flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6,
  },
  regimeEmoji: { fontSize: 18 },
  regimeLabel: {
    fontSize: 14, fontWeight: "700", letterSpacing: 0.8,
    fontFamily: "SpaceGrotesk_700Bold",
  },
  regimeAction: {
    color: P.text, fontSize: 12, lineHeight: 17,
    fontFamily: "SpaceGrotesk_500Medium", marginBottom: 6,
  },
  regimeMeta: {
    color: P.dim, fontSize: 10,
    fontFamily: "JetBrainsMono_500Medium", letterSpacing: 0.3,
  },
  nearWrap: {
    backgroundColor: P.surface, borderRadius: 4,
    paddingVertical: 10, paddingHorizontal: 12,
  },
  nearCaption: {
    color: P.text2, fontSize: 9, fontWeight: "700", letterSpacing: 1.5,
    fontFamily: "SpaceGrotesk_700Bold", marginBottom: 8,
  },
  nearRow: { marginBottom: 8 },
  nearRowTop: {
    flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 3,
  },
  nearTag: {
    color: P.primaryContainer, fontSize: 10, fontWeight: "700",
    fontFamily: "JetBrainsMono_700Bold", minWidth: 60,
  },
  nearSide: {
    fontSize: 9, fontWeight: "700", letterSpacing: 0.8,
    fontFamily: "SpaceGrotesk_700Bold", minWidth: 36,
  },
  nearProgress: {
    color: P.text, fontSize: 10, fontWeight: "700",
    fontFamily: "JetBrainsMono_700Bold", minWidth: 36,
  },
  nearBarOuter: {
    flex: 1, height: 4, borderRadius: 2,
    backgroundColor: P.highest, overflow: "hidden",
  },
  nearBarInner: { height: "100%", borderRadius: 2 },
  nearReason: {
    color: P.dim, fontSize: 10, lineHeight: 13,
    fontFamily: "SpaceGrotesk_500Medium", paddingLeft: 2,
  },
});
