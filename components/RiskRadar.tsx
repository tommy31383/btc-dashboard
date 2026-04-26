/**
 * RiskRadar — v4.3.20 Material You warm refactor
 *
 * Mapped từ tab TRADES trong BottomNav. Data vẫn là lesson learn scan 20K
 * entries (2.7 năm) — KHÔNG đổi logic, chỉ đổi visual sang Material You warm:
 *   - border-l-4 accent pattern (bitcoinOrange/green/red/tertiary/fade)
 *   - rounded-sm 2px, Space Grotesk uppercase label, Inter body, JetBrains Mono numbers
 *   - Risk Score hero card tổng hợp (longScore+shortScore)/(longTotal+shortTotal) × 100
 *
 * Sections:
 *   1. Risk Score Hero   — big number + verdict pill + confidence row
 *   2. 💎 Golden Opportunities — firing rule cards
 *   3. LONG Checklist    — warnings (border-l green)
 *   4. SHORT Checklist   — warnings (border-l red)
 *   5. Live Snapshot     — raw indicator readings (border-l tertiary)
 */
import React from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from "react-native";
import { P } from "../utils/v2Theme";
import { RiskRadarState, RiskWarning, GoldenOpportunity } from "../hooks/useRiskRadar";
import DebugLabel from "./DebugLabel";

interface Props {
  state: RiskRadarState;
  onBack?: () => void;
}

const levelAccent = (level: "danger" | "caution" | "safe") =>
  level === "danger" ? P.red : level === "caution" ? P.primaryContainer : P.green;

const levelPillText = (level: "danger" | "caution" | "safe") =>
  level === "danger" ? "HIGH" : level === "caution" ? "MED" : "LOW";

// ── Indicator hint helpers ─────────────────────────────────────────────────
function rsiHint(v: number | null): { text: string; color: string } {
  if (v === null) return { text: "—", color: P.dim };
  if (v < 30) return { text: "oversold · lean BUY", color: P.green };
  if (v < 50) return { text: "weak · lean SELL", color: P.red };
  if (v < 70) return { text: "strong · lean BUY", color: P.green };
  return { text: "overbought · watch pullback", color: P.primaryContainer };
}
function macdHint(v: number | null): { text: string; color: string } {
  if (v === null) return { text: "—", color: P.dim };
  if (v > 0) return { text: "bull momentum", color: P.green };
  if (v < 0) return { text: "bear momentum", color: P.red };
  return { text: "neutral", color: P.dim };
}
function atrHint(v: number | null): { text: string; color: string } {
  if (v === null) return { text: "—", color: P.dim };
  if (v < 0.3) return { text: "rất thấp · golden zone", color: P.bitcoinOrange };
  if (v < 0.8) return { text: "bình thường", color: P.text };
  return { text: "cao · biến động mạnh", color: P.primaryContainer };
}
function emaDistHint(v: number | null): { text: string; color: string } {
  if (v === null) return { text: "—", color: P.dim };
  const abs = Math.abs(v);
  if (abs < 0.5) return { text: "sát EMA · sideway", color: P.dim };
  if (abs < 2) return { text: v >= 0 ? "xa vừa · trên EMA" : "xa vừa · dưới EMA", color: v >= 0 ? P.green : P.red };
  return { text: v >= 0 ? "xa quá · coi chừng pullback" : "xa quá · coi chừng bounce", color: P.primaryContainer };
}
function htfHint(state: string): string {
  if (state === "UP") return "trend UP rõ";
  if (state === "DOWN") return "trend DOWN rõ";
  return "không trend";
}

// ── Sub-components ─────────────────────────────────────────────────────────
function WarningCard({ w }: { w: RiskWarning }) {
  const accent = levelAccent(w.level);
  const pill = levelPillText(w.level);
  const active = w.active;
  return (
    <View style={[styles.warnCard, { borderLeftColor: accent, opacity: active ? 1 : 0.55 }]}>
      <View style={{ flex: 1 }}>
        <Text style={[styles.warnTitle, { color: active ? P.text : P.dim }]} numberOfLines={2}>
          {w.title}
        </Text>
        <Text style={styles.warnDetail} numberOfLines={2}>
          {w.detail} · WR {w.lessonWR}
        </Text>
      </View>
      <View style={[styles.warnPill, { backgroundColor: accent + "20", borderColor: accent + "55" }]}>
        <Text style={[styles.warnPillText, { color: accent }]}>{pill}</Text>
      </View>
    </View>
  );
}

function GoldenCard({ g }: { g: GoldenOpportunity }) {
  const sideAccent = g.side === "LONG" ? P.green : P.red;
  const passCount = g.conditions.filter((c) => c.pass).length;
  const firing = g.allPass;
  const accent = firing ? P.bitcoinOrange : sideAccent;
  return (
    <View
      style={[
        styles.goldenCard,
        {
          borderLeftColor: accent,
          backgroundColor: firing ? P.bitcoinOrange + "15" : P.cardAlt,
          borderLeftWidth: firing ? 4 : 3,
        },
      ]}
    >
      <View style={styles.goldenHeader}>
        <Text style={[styles.goldenSide, { color: sideAccent }]}>{g.side}</Text>
        <Text style={styles.goldenTitle} numberOfLines={1}>{g.title}</Text>
        <View style={[styles.goldenWrPill, { borderColor: P.primaryContainer + "55", backgroundColor: P.primaryContainer + "10" }]}>
          <Text style={styles.goldenWrText}>{g.wr}</Text>
        </View>
      </View>
      <Text style={styles.goldenMeta}>
        {g.tpSl} · <Text style={{ color: firing ? P.bitcoinOrange : P.text2, fontWeight: "700" }}>{passCount}/{g.conditions.length} conditions</Text>
      </Text>
      <View style={styles.condList}>
        {g.conditions.map((c, i) => (
          <View key={i} style={styles.condRow}>
            <Text style={[styles.condIcon, { color: c.pass ? P.green : P.dim }]}>
              {c.pass ? "✓" : "·"}
            </Text>
            <Text style={[styles.condLabel, { color: c.pass ? P.text : P.dim }]} numberOfLines={1}>
              {c.label}
            </Text>
            <Text style={[styles.condLive, { color: c.pass ? P.green : P.dim }]} numberOfLines={1}>
              {c.live}
            </Text>
          </View>
        ))}
      </View>
      {firing && (
        <View style={styles.fireBadge}>
          <Text style={styles.fireBadgeText}>🔥 FIRING NOW — {g.side} SIGNAL LIVE</Text>
        </View>
      )}
    </View>
  );
}

function SnapRow({ label, value, hint, hintColor }: { label: string; value: string; hint: string; hintColor: string }) {
  return (
    <View style={styles.snapRow}>
      <Text style={styles.snapLabel}>{label}</Text>
      <Text style={styles.snapVal}>{value}</Text>
      <Text style={[styles.snapHint, { color: hintColor }]} numberOfLines={1}>{hint}</Text>
    </View>
  );
}

// ── Main ───────────────────────────────────────────────────────────────────
export default function RiskRadar({ state }: Props) {
  const { longWarnings, shortWarnings, goldens, longScore, shortScore, verdict, liveSnapshot } = state;

  // Aggregate risk score 0-100 (higher = safer overall)
  const totalSafe = longScore + shortScore;
  const totalChecks = longWarnings.length + shortWarnings.length;
  const riskScore = totalChecks > 0 ? Math.round((totalSafe / totalChecks) * 100) : 0;

  // Verdict → pill text + color
  const verdictMap: Record<string, { text: string; color: string }> = {
    PREFER_LONG: { text: "PREFER LONG", color: P.green },
    PREFER_SHORT: { text: "PREFER SHORT", color: P.red },
    AVOID_BOTH: { text: "AVOID BOTH", color: P.primaryContainer },
    NEUTRAL: { text: "NEUTRAL", color: P.tertiary },
  };
  const v = verdictMap[verdict] ?? verdictMap.NEUTRAL;

  const longBad = longWarnings.length - longScore;
  const shortBad = shortWarnings.length - shortScore;

  // Sort goldens: firing first
  const goldensSorted = [...goldens].sort((a, b) => {
    if (a.allPass && !b.allPass) return -1;
    if (!a.allPass && b.allPass) return 1;
    return b.conditions.filter((c) => c.pass).length - a.conditions.filter((c) => c.pass).length;
  });

  const firingCount = goldens.filter((g) => g.allPass).length;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <DebugLabel name="RiskRadar" />
      {/* Tab header chip */}
      <View style={styles.tabChipRow}>
        <View style={styles.tabChip}>
          <Text style={styles.tabChipText}>TRADES</Text>
        </View>
        <Text style={styles.tabChipMeta}>· Risk + Rules + Safety Check</Text>
      </View>

      {/* 1. RISK SCORE HERO */}
      <View style={styles.heroCard}>
        <View style={styles.heroHeader}>
          <Text style={styles.heroCaption}>▼ RISK RADAR · 20K LESSON</Text>
          <Text style={styles.heroSamples}>2.7Y scan</Text>
        </View>

        <View style={styles.heroScoreWrap}>
          <Text style={styles.heroScoreLabel}>RISK SCORE</Text>
          <Text style={styles.heroScore}>{riskScore}</Text>
          <Text style={styles.heroScoreSuffix}>/ 100</Text>
          <View style={[styles.verdictPill, { borderColor: v.color + "55", backgroundColor: v.color + "15" }]}>
            <Text style={[styles.verdictPillText, { color: v.color }]}>{v.text}</Text>
          </View>
        </View>

        <View style={styles.heroStatsRow}>
          <View style={styles.heroStatCell}>
            <Text style={styles.heroStatLabel}>LONG SAFE</Text>
            <Text style={[styles.heroStatVal, { color: P.green }]}>
              {longScore}<Text style={styles.heroStatDim}>/{longWarnings.length}</Text>
            </Text>
          </View>
          <View style={[styles.heroStatCell, styles.heroStatMid]}>
            <Text style={styles.heroStatLabel}>SHORT SAFE</Text>
            <Text style={[styles.heroStatVal, { color: P.red }]}>
              {shortScore}<Text style={styles.heroStatDim}>/{shortWarnings.length}</Text>
            </Text>
          </View>
          <View style={styles.heroStatCell}>
            <Text style={styles.heroStatLabel}>FIRING</Text>
            <Text style={[styles.heroStatVal, { color: firingCount > 0 ? P.bitcoinOrange : P.dim }]}>
              {firingCount}<Text style={styles.heroStatDim}>/{goldens.length}</Text>
            </Text>
          </View>
        </View>
      </View>

      {/* 2. GOLDEN OPPORTUNITIES */}
      <View style={styles.sectionCard}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>💎 GOLDEN OPPORTUNITIES</Text>
          <Text style={styles.sectionMeta}>{firingCount > 0 ? `${firingCount} firing` : `${goldens.length} watching`}</Text>
        </View>
        <Text style={styles.sectionSub}>Rule đỉnh từ scan TP+5/SL-2 · all ✓ = vào lệnh ngay</Text>
        {goldensSorted.map((g) => (
          <GoldenCard key={g.id} g={g} />
        ))}
      </View>

      {/* 3. LONG CHECKLIST */}
      <View style={[styles.sectionCard, { borderLeftColor: P.green }]}>
        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, { color: P.green }]}>⇧ LONG CHECKLIST</Text>
          <Text style={styles.sectionMeta}>{longBad}/{longWarnings.length} bad</Text>
        </View>
        <Text style={styles.sectionSub}>
          {longBad === 0
            ? `✅ Zero red flags — có thể LONG an toàn`
            : `⚠️ ${longBad} dấu hiệu xấu đang xuất hiện — cân nhắc kỹ`}
        </Text>
        {longWarnings.map((w) => (
          <WarningCard key={w.id} w={w} />
        ))}
      </View>

      {/* 4. SHORT CHECKLIST */}
      <View style={[styles.sectionCard, { borderLeftColor: P.red }]}>
        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, { color: P.red }]}>⇩ SHORT CHECKLIST</Text>
          <Text style={styles.sectionMeta}>{shortBad}/{shortWarnings.length} bad</Text>
        </View>
        <Text style={styles.sectionSub}>
          {shortBad === 0
            ? `✅ Zero red flags — có thể SHORT an toàn`
            : `⚠️ ${shortBad} dấu hiệu xấu đang xuất hiện — cân nhắc kỹ`}
        </Text>
        {shortWarnings.map((w) => (
          <WarningCard key={w.id} w={w} />
        ))}
      </View>

      {/* 5. LIVE SNAPSHOT */}
      <View style={[styles.sectionCard, { borderLeftColor: P.tertiary }]}>
        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, { color: P.tertiary }]}>📡 LIVE SNAPSHOT</Text>
          <Text style={styles.sectionMeta}>raw · live</Text>
        </View>
        <View style={styles.snapBox}>
          {(() => {
            const rsi = rsiHint(liveSnapshot.rsi1h);
            const macd = macdHint(liveSnapshot.macdHist1h);
            const atr1h = atrHint(liveSnapshot.atrPct1h);
            const atr4h = atrHint(liveSnapshot.atrPct4h);
            const atr15m = atrHint(liveSnapshot.atrPct15m);
            const ema1h = emaDistHint(liveSnapshot.emaDist1h);
            const ema4h = emaDistHint(liveSnapshot.emaDist4h);
            const htfColor =
              liveSnapshot.htf4hState === "UP" ? P.green :
              liveSnapshot.htf4hState === "DOWN" ? P.red : P.primaryContainer;
            return (
              <>
                <SnapRow label="1h RSI" value={liveSnapshot.rsi1h?.toFixed(1) ?? "—"} hint={rsi.text} hintColor={rsi.color} />
                <SnapRow label="1h MACD H" value={liveSnapshot.macdHist1h?.toFixed(1) ?? "—"} hint={macd.text} hintColor={macd.color} />
                <SnapRow label="1h ATR%" value={liveSnapshot.atrPct1h !== null ? `${liveSnapshot.atrPct1h.toFixed(2)}%` : "—"} hint={atr1h.text} hintColor={atr1h.color} />
                <SnapRow label="4h ATR%" value={liveSnapshot.atrPct4h !== null ? `${liveSnapshot.atrPct4h.toFixed(2)}%` : "—"} hint={atr4h.text} hintColor={atr4h.color} />
                <SnapRow label="15m ATR%" value={liveSnapshot.atrPct15m !== null ? `${liveSnapshot.atrPct15m.toFixed(2)}%` : "—"} hint={atr15m.text} hintColor={atr15m.color} />
                <SnapRow label="1h EMA50Δ" value={liveSnapshot.emaDist1h !== null ? `${liveSnapshot.emaDist1h >= 0 ? "+" : ""}${liveSnapshot.emaDist1h.toFixed(2)}%` : "—"} hint={ema1h.text} hintColor={ema1h.color} />
                <SnapRow label="4h EMA50Δ" value={liveSnapshot.emaDist4h !== null ? `${liveSnapshot.emaDist4h >= 0 ? "+" : ""}${liveSnapshot.emaDist4h.toFixed(2)}%` : "—"} hint={ema4h.text} hintColor={ema4h.color} />
                <SnapRow label="HTF 4h" value={liveSnapshot.htf4hState} hint={htfHint(liveSnapshot.htf4hState)} hintColor={htfColor} />
              </>
            );
          })()}
        </View>
      </View>
    </ScrollView>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: P.bg },
  content: { padding: 12, paddingTop: 12, paddingBottom: 80 },

  tabChipRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 10,
    paddingLeft: 2,
  },
  tabChip: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    backgroundColor: P.primaryContainer,
    borderRadius: 2,
  },
  tabChipText: {
    color: P.onPrimary,
    fontSize: 10,
    fontFamily: "SpaceGrotesk_700Bold",
    fontWeight: "800",
    letterSpacing: 2,
  },
  tabChipMeta: {
    color: P.dim,
    fontSize: 10,
    fontFamily: "JetBrainsMono_500Medium",
    marginLeft: 8,
  },

  // ── Hero ──
  heroCard: {
    backgroundColor: P.card,
    borderRadius: 2,
    padding: 14,
    paddingLeft: 18,
    marginBottom: 10,
    borderLeftWidth: 4,
    borderLeftColor: P.bitcoinOrange,
  },
  heroHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  heroCaption: {
    color: P.text2,
    fontSize: 10,
    fontFamily: "SpaceGrotesk_700Bold",
    fontWeight: "700",
    letterSpacing: 2,
  },
  heroSamples: {
    color: P.dim,
    fontSize: 9,
    fontFamily: "JetBrainsMono_500Medium",
  },
  heroScoreWrap: {
    alignItems: "center",
    marginTop: 10,
    marginBottom: 12,
  },
  heroScoreLabel: {
    color: P.dim,
    fontSize: 9,
    fontFamily: "SpaceGrotesk_700Bold",
    fontWeight: "700",
    letterSpacing: 2,
    marginBottom: 2,
  },
  heroScore: {
    color: P.primaryContainer,
    fontSize: 56,
    fontFamily: "SpaceGrotesk_700Bold",
    fontWeight: "700",
    lineHeight: 60,
  },
  heroScoreSuffix: {
    color: P.dim,
    fontSize: 11,
    fontFamily: "JetBrainsMono_500Medium",
    fontWeight: "700",
    letterSpacing: 2,
    marginTop: 2,
  },
  verdictPill: {
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 3,
    borderWidth: 1,
    borderRadius: 999,
  },
  verdictPillText: {
    fontSize: 10,
    fontFamily: "SpaceGrotesk_700Bold",
    fontWeight: "800",
    letterSpacing: 2,
  },
  heroStatsRow: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderTopColor: P.border,
    paddingTop: 10,
  },
  heroStatCell: {
    flex: 1,
    alignItems: "center",
  },
  heroStatMid: {
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: P.borderSoft,
  },
  heroStatLabel: {
    color: P.dim,
    fontSize: 9,
    fontFamily: "SpaceGrotesk_700Bold",
    fontWeight: "700",
    letterSpacing: 1.5,
    marginBottom: 4,
  },
  heroStatVal: {
    fontSize: 16,
    fontFamily: "JetBrainsMono_500Medium",
    fontWeight: "800",
  },
  heroStatDim: {
    color: P.dim,
    fontSize: 11,
    fontWeight: "600",
  },

  // ── Section card (base) ──
  sectionCard: {
    backgroundColor: P.card,
    borderRadius: 2,
    padding: 12,
    paddingLeft: 16,
    marginBottom: 10,
    borderLeftWidth: 4,
    borderLeftColor: P.primaryContainer,
  },
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 2,
  },
  sectionTitle: {
    color: P.primaryContainer,
    fontSize: 12,
    fontFamily: "SpaceGrotesk_700Bold",
    fontWeight: "700",
    letterSpacing: 2,
    textTransform: "uppercase",
  },
  sectionMeta: {
    color: P.dim,
    fontSize: 9,
    fontFamily: "JetBrainsMono_500Medium",
    letterSpacing: 1,
  },
  sectionSub: {
    color: P.dim,
    fontSize: 10,
    fontFamily: "Inter_400Regular",
    marginBottom: 8,
    marginTop: 2,
  },

  // ── Warning card ──
  warnCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: P.cardAlt,
    borderRadius: 2,
    paddingVertical: 8,
    paddingHorizontal: 10,
    paddingLeft: 12,
    marginBottom: 4,
    borderLeftWidth: 3,
  },
  warnTitle: {
    fontSize: 12,
    fontFamily: "Inter_700Bold",
    fontWeight: "700",
  },
  warnDetail: {
    color: P.dim,
    fontSize: 10,
    fontFamily: "JetBrainsMono_500Medium",
    marginTop: 1,
  },
  warnPill: {
    marginLeft: 8,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 2,
    borderWidth: 1,
  },
  warnPillText: {
    fontSize: 9,
    fontFamily: "SpaceGrotesk_700Bold",
    fontWeight: "800",
    letterSpacing: 1.2,
  },

  // ── Golden card ──
  goldenCard: {
    backgroundColor: P.cardAlt,
    borderRadius: 2,
    padding: 10,
    paddingLeft: 12,
    marginBottom: 6,
    borderLeftWidth: 3,
  },
  goldenHeader: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 4,
  },
  goldenSide: {
    fontSize: 10,
    fontFamily: "SpaceGrotesk_700Bold",
    fontWeight: "800",
    letterSpacing: 1.5,
    marginRight: 6,
    minWidth: 40,
  },
  goldenTitle: {
    flex: 1,
    color: P.text,
    fontSize: 12,
    fontFamily: "Inter_700Bold",
    fontWeight: "700",
  },
  goldenWrPill: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 2,
    borderWidth: 1,
    marginLeft: 6,
  },
  goldenWrText: {
    color: P.primaryContainer,
    fontSize: 9,
    fontFamily: "JetBrainsMono_500Medium",
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  goldenMeta: {
    color: P.dim,
    fontSize: 10,
    fontFamily: "JetBrainsMono_500Medium",
    marginBottom: 6,
  },
  condList: {
    gap: 1,
  },
  condRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 2,
  },
  condIcon: {
    fontSize: 12,
    width: 14,
    fontWeight: "900",
  },
  condLabel: {
    flex: 1,
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    marginLeft: 4,
  },
  condLive: {
    fontSize: 10,
    fontFamily: "JetBrainsMono_500Medium",
    fontWeight: "700",
  },
  fireBadge: {
    marginTop: 8,
    paddingVertical: 6,
    paddingHorizontal: 8,
    backgroundColor: P.bitcoinOrange + "20",
    borderRadius: 2,
    borderWidth: 1,
    borderColor: P.bitcoinOrange + "55",
    alignItems: "center",
  },
  fireBadgeText: {
    color: P.bitcoinOrange,
    fontSize: 11,
    fontFamily: "SpaceGrotesk_700Bold",
    fontWeight: "800",
    letterSpacing: 1.5,
  },

  // ── Snapshot ──
  snapBox: {
    backgroundColor: P.surface,
    borderRadius: 2,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: P.borderSoft,
  },
  snapRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 5,
    borderBottomWidth: 1,
    borderBottomColor: P.borderSoft,
  },
  snapLabel: {
    color: P.dim,
    fontSize: 10,
    fontFamily: "JetBrainsMono_500Medium",
    width: 80,
    letterSpacing: 0.5,
  },
  snapVal: {
    color: P.text,
    fontSize: 11,
    fontFamily: "JetBrainsMono_500Medium",
    fontWeight: "700",
    minWidth: 60,
    textAlign: "right",
  },
  snapHint: {
    flex: 1,
    fontSize: 10,
    fontFamily: "Inter_400Regular",
    fontStyle: "italic",
    marginLeft: 10,
  },
});
