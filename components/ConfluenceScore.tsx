/**
 * ConfluenceScore — gộp signal từ 7 TF (5m..1mo) thành 1 score -100..+100.
 *
 * Thay panel "PHÂN TÍCH ĐA KHUNG THỜI GIAN" cũ (table 7×5 raw values nhìn loãng).
 *
 * Logic mỗi TF (lean -1..+1):
 *   - RSI<30 = +0.5 bull · RSI>70 = -0.5 bear · giữa 40-60 = 0
 *   - StochK<20 = +0.3 · StochK>80 = -0.3
 *   - MACD hist >0 = +0.4 · <0 = -0.4
 *   - Divergence: BULLISH = +0.6 · BEARISH = -0.6
 *   - clamp [-1, +1]
 *
 * TF weight (TF lớn matter hơn):
 *   5m=1, 15m=2, 1h=4, 4h=6, 1d=8, 1w=10, 1mo=12
 *
 * Total = sum(lean × weight) / sum(weight) × 100  → -100..+100
 */
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { P } from "../utils/v2Theme";
import { TFAnalysis } from "../hooks/useBinanceKlines";
import DebugLabel from "./DebugLabel";

interface Props {
  tfData: TFAnalysis[];
}

const TF_WEIGHTS: Record<string, number> = {
  "5m": 1, "15m": 2, "1h": 4, "4h": 6, "1d": 8, "1w": 10, "1mo": 12,
};

interface TFLean {
  key: string;
  label: string;
  lean: number;     // -1..+1
  weight: number;
  contrib: number;  // lean × weight (signed)
  parts: { rsi: number; stoch: number; macd: number; div: number };
}

function computeLean(tf: TFAnalysis): TFLean {
  let rsiL = 0, stochL = 0, macdL = 0, divL = 0;
  if (tf.rsi !== null) {
    if (tf.rsi < 30) rsiL = 0.5;
    else if (tf.rsi < 40) rsiL = 0.25;
    else if (tf.rsi > 70) rsiL = -0.5;
    else if (tf.rsi > 60) rsiL = -0.25;
  }
  if (tf.stochK !== null) {
    if (tf.stochK < 20) stochL = 0.3;
    else if (tf.stochK > 80) stochL = -0.3;
  }
  if (tf.macdHistogram !== null) {
    macdL = tf.macdHistogram > 0 ? 0.4 : -0.4;
  }
  if (tf.divergence === "BULLISH_DIV") divL = 0.6;
  else if (tf.divergence === "BEARISH_DIV") divL = -0.6;

  const raw = rsiL + stochL + macdL + divL;
  const lean = Math.max(-1, Math.min(1, raw));
  const weight = TF_WEIGHTS[tf.key] ?? 1;
  return {
    key: tf.key, label: tf.label, lean, weight,
    contrib: lean * weight,
    parts: { rsi: rsiL, stoch: stochL, macd: macdL, div: divL },
  };
}

function verdict(score: number): { text: string; color: string; emoji: string } {
  if (score >= 50)  return { text: "STRONG BUY",  color: P.green,           emoji: "🟢🟢" };
  if (score >= 20)  return { text: "BUY",         color: P.green,           emoji: "🟢" };
  if (score >= -20) return { text: "NEUTRAL",     color: P.dim,             emoji: "⚪" };
  if (score >= -50) return { text: "SELL",        color: P.error,           emoji: "🔴" };
  return                { text: "STRONG SELL",  color: P.error,           emoji: "🔴🔴" };
}

export default function ConfluenceScore({ tfData }: Props) {
  if (!tfData || tfData.length === 0) return null;

  const leans = tfData.map(computeLean);
  const totalWeight = leans.reduce((s, l) => s + l.weight, 0) || 1;
  const totalContrib = leans.reduce((s, l) => s + l.contrib, 0);
  const score = Math.round((totalContrib / totalWeight) * 100);
  const v = verdict(score);

  // 0..100 cho thanh hiển thị (50 = neutral)
  const barPct = 50 + score / 2;

  return (
    <View style={styles.container}>
      <DebugLabel name="ConfluenceScore" />
      <View style={styles.headerRow}>
        <Text style={styles.title}>📊 CONFLUENCE SCORE · ĐA KHUNG</Text>
        <Text style={[styles.scoreText, { color: v.color }]}>
          {score >= 0 ? "+" : ""}{score}
        </Text>
      </View>

      {/* Big bar -100..+100 */}
      <View style={styles.barOuter}>
        <View style={styles.barCenter} />
        <View style={[
          styles.barFill,
          score >= 0
            ? { left: "50%", width: `${Math.abs(score) / 2}%`, backgroundColor: P.green }
            : { right: "50%", width: `${Math.abs(score) / 2}%`, backgroundColor: P.error },
        ]} />
        <View style={[styles.barMarker, { left: `${barPct}%`, backgroundColor: v.color }]} />
      </View>
      <View style={styles.barLabels}>
        <Text style={styles.barLabel}>STRONG SELL</Text>
        <Text style={styles.barLabel}>NEUTRAL</Text>
        <Text style={styles.barLabel}>STRONG BUY</Text>
      </View>

      <View style={[styles.verdictBox, { borderColor: v.color, backgroundColor: v.color + "12" }]}>
        <Text style={[styles.verdictText, { color: v.color }]}>
          {v.emoji}  {v.text}
        </Text>
        <Text style={styles.verdictHint}>
          {score >= 50 ? "Đa số TF (đặc biệt TF lớn) lean LONG mạnh"
           : score >= 20 ? "Có thiên hướng LONG, nhưng chưa mạnh"
           : score >= -20 ? "TF mâu thuẫn — chờ rõ xu hướng"
           : score >= -50 ? "Có thiên hướng SHORT, nhưng chưa mạnh"
           : "Đa số TF (đặc biệt TF lớn) lean SHORT mạnh"}
        </Text>
      </View>

      {/* Per-TF breakdown */}
      <Text style={styles.breakdownTitle}>BREAKDOWN THEO TF</Text>
      {leans.map((l) => {
        const tfPct = 50 + l.lean * 50; // 0..100
        const color = l.lean > 0.05 ? P.green : l.lean < -0.05 ? P.error : P.dim;
        return (
          <View key={l.key} style={styles.tfRow}>
            <Text style={styles.tfLabel}>{l.label.padEnd(4, " ")}</Text>
            <Text style={styles.tfWeight}>×{l.weight}</Text>
            <View style={styles.tfBarOuter}>
              <View style={styles.tfBarCenter} />
              <View style={[
                styles.tfBarFill,
                l.lean >= 0
                  ? { left: "50%", width: `${Math.abs(l.lean) * 50}%`, backgroundColor: P.green }
                  : { right: "50%", width: `${Math.abs(l.lean) * 50}%`, backgroundColor: P.error },
              ]} />
            </View>
            <Text style={[styles.tfScore, { color }]}>
              {l.lean >= 0 ? "+" : ""}{(l.lean * 100).toFixed(0)}
            </Text>
            <Text style={[styles.tfContrib, { color }]}>
              ({l.contrib >= 0 ? "+" : ""}{l.contrib.toFixed(1)})
            </Text>
          </View>
        );
      })}

      <Text style={styles.note}>
        Score = Σ(lean × weight) / Σ(weight) × 100. Weight: TF lớn matter hơn (1mo=12, 1w=10, 1d=8...).
        Lean per-TF từ RSI · StochRSI · MACD · Divergence (clamp ±1).
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: P.card, borderRadius: 2, padding: 14, paddingLeft: 16, marginBottom: 10, borderLeftWidth: 4, borderLeftColor: P.tertiary },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  title: { color: P.text, fontSize: 11, fontWeight: "700", fontFamily: "SpaceGrotesk_700Bold", letterSpacing: 1.5 },
  scoreText: { fontSize: 26, fontWeight: "800", fontFamily: "JetBrainsMono_700Bold" },
  barOuter: {
    height: 18, backgroundColor: P.surface, borderRadius: 2,
    borderWidth: 1, borderColor: P.highest, position: "relative", overflow: "hidden",
  },
  barCenter: { position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, backgroundColor: P.highest, marginLeft: -0.5 },
  barFill: { position: "absolute", top: 0, bottom: 0, opacity: 0.7 },
  barMarker: { position: "absolute", top: -2, bottom: -2, width: 3, marginLeft: -1.5 },
  barLabels: { flexDirection: "row", justifyContent: "space-between", marginTop: 4, marginBottom: 12 },
  barLabel: { color: P.dim, fontSize: 8, fontFamily: "JetBrainsMono_500Medium", letterSpacing: 0.5 },
  verdictBox: { padding: 10, borderRadius: 2, borderWidth: 1, marginBottom: 14 },
  verdictText: { fontSize: 14, fontWeight: "800", fontFamily: "SpaceGrotesk_700Bold", letterSpacing: 1, marginBottom: 2 },
  verdictHint: { color: P.dim, fontSize: 10, fontFamily: "Inter_400Regular" },
  breakdownTitle: { color: P.dim, fontSize: 9, fontWeight: "700", letterSpacing: 1.2, fontFamily: "SpaceGrotesk_700Bold", marginBottom: 6 },
  tfRow: { flexDirection: "row", alignItems: "center", paddingVertical: 4, gap: 6 },
  tfLabel: { color: P.primaryContainer, fontSize: 11, fontWeight: "800", fontFamily: "JetBrainsMono_700Bold", width: 36 },
  tfWeight: { color: P.dim, fontSize: 9, fontFamily: "JetBrainsMono_500Medium", width: 26 },
  tfBarOuter: { flex: 1, height: 8, backgroundColor: P.surface, borderRadius: 2, position: "relative", overflow: "hidden", borderWidth: 1, borderColor: P.highest },
  tfBarCenter: { position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, backgroundColor: P.highest, marginLeft: -0.5 },
  tfBarFill: { position: "absolute", top: 0, bottom: 0, opacity: 0.8 },
  tfScore: { fontSize: 10, fontWeight: "700", fontFamily: "JetBrainsMono_700Bold", width: 36, textAlign: "right" },
  tfContrib: { fontSize: 9, fontFamily: "JetBrainsMono_500Medium", width: 50, textAlign: "right" },
  note: { color: P.dim, fontSize: 9, lineHeight: 13, fontFamily: "JetBrainsMono_500Medium", marginTop: 12 },
});
