/**
 * LiveActionItems — replace LiveFeatureSnapshot v4.7.30+
 *
 * Actionable info cho Dashboard tab, 3 phần:
 *   1. STACK + EQUITY DD bars (từ live state + Binance account)
 *   2. ACTIVE FIRING RULES (current activeAlerts) với entry/TP/SL + button
 *   3. BUY/SELL ZONES (S/R 15m derived) + suggested action
 */
import React from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { P } from "../utils/v2Theme";
import DebugLabel from "./DebugLabel";
import { LiveTraderState } from "../utils/liveTraderEngine";
import { RuleAlert } from "../hooks/useRuleAlerts";

interface Props {
  liveState: LiveTraderState;
  walletEquity: number | null;        // wallet + uPnL từ Binance account
  activeAlerts: RuleAlert[];
  currentPrice: number | null;
  support15m: number | null;
  resistance15m: number | null;
  onGoToLive?: () => void;
}

function fmt(n: number, d = 0) { return n.toFixed(d); }

export default function LiveActionItems({
  liveState, walletEquity, activeAlerts, currentPrice, support15m, resistance15m, onGoToLive,
}: Props) {
  const tracked = liveState.trackedPositions;
  const cfg = liveState.settings;
  const longCount = tracked.filter((t) => t.side === "LONG").length;
  const shortCount = tracked.filter((t) => t.side === "SHORT").length;
  const stackPctLong = (longCount / cfg.stackMaxPerSide) * 100;
  const stackPctShort = (shortCount / cfg.stackMaxPerSide) * 100;

  // Equity DD% (current vs peak)
  const peak = liveState.peakEquityUsd ?? walletEquity ?? 0;
  const ddPct = peak > 0 && walletEquity !== null ? ((peak - walletEquity) / peak) * 100 : 0;
  const ddThreshold = cfg.equityDdPausePct;
  const ddRatio = ddThreshold > 0 ? ddPct / ddThreshold : 0;
  const ddColor = ddRatio < 0.5 ? P.green : ddRatio < 0.8 ? P.bitcoinOrange : P.error;

  // ── Active firing rules (filter HTF + LTF, show side + entry)
  const firing = activeAlerts.slice(0, 5); // top 5

  // ── Buy/Sell zones (S/R 15m proximity per LIVE settings confirmSrProximityPct)
  const proxPct = cfg.confirmSrProximityPct;
  const buyZone = support15m !== null
    ? { lo: support15m, hi: support15m * (1 + proxPct / 100) }
    : null;
  const sellZone = resistance15m !== null
    ? { lo: resistance15m * (1 - proxPct / 100), hi: resistance15m }
    : null;
  const inBuyZone = buyZone && currentPrice !== null && currentPrice >= buyZone.lo && currentPrice <= buyZone.hi;
  const inSellZone = sellZone && currentPrice !== null && currentPrice >= sellZone.lo && currentPrice <= sellZone.hi;

  return (
    <View style={styles.card}>
      <DebugLabel name="LiveActionItems" />
      <Text style={styles.h1}>
        🎯 ACTION ITEMS · LIVE
        {onGoToLive && (
          <Text style={styles.h1Sub} onPress={onGoToLive}>  → tab LIVE</Text>
        )}
      </Text>

      {/* ── Section 1: STACK + DD bars ── */}
      <View style={styles.section}>
        <View style={styles.barRow}>
          <Text style={[styles.barLabel, { color: P.green }]}>LONG {longCount}/{cfg.stackMaxPerSide}</Text>
          <View style={styles.barTrack}>
            <View style={[styles.barFill, { width: `${Math.min(100, stackPctLong)}%`, backgroundColor: P.green }]} />
          </View>
          <Text style={styles.barPct}>{stackPctLong.toFixed(0)}%</Text>
        </View>
        <View style={styles.barRow}>
          <Text style={[styles.barLabel, { color: P.error }]}>SHORT {shortCount}/{cfg.stackMaxPerSide}</Text>
          <View style={styles.barTrack}>
            <View style={[styles.barFill, { width: `${Math.min(100, stackPctShort)}%`, backgroundColor: P.error }]} />
          </View>
          <Text style={styles.barPct}>{stackPctShort.toFixed(0)}%</Text>
        </View>
        <View style={styles.barRow}>
          <Text style={[styles.barLabel, { color: ddColor }]}>EQ DD {ddPct.toFixed(1)}%/{ddThreshold}%</Text>
          <View style={styles.barTrack}>
            <View style={[styles.barFill, { width: `${Math.min(100, ddRatio * 100)}%`, backgroundColor: ddColor }]} />
          </View>
          <Text style={[styles.barPct, { color: ddColor }]}>
            {liveState.pauseReason === "equity-dd" ? "PAUSED" : ddRatio >= 0.8 ? "near" : "ok"}
          </Text>
        </View>
        <Text style={styles.statusInfo}>
          peak ${(peak).toFixed(0)} · eq ${(walletEquity ?? 0).toFixed(0)} · auto {liveState.autoEnabled ? "✅" : "❌"} · {liveState.dryRun ? "DRY" : "REAL"}
        </Text>
      </View>

      {/* ── Section 2: ACTIVE FIRING RULES ── */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>🔔 ACTIVE FIRING ({firing.length})</Text>
        {firing.length === 0 ? (
          <Text style={styles.empty}>không có rule nào đang fire — chờ market move</Text>
        ) : (
          firing.map((a) => {
            const sideColor = a.side === "LONG" ? P.green : P.error;
            return (
              <View key={a.id} style={styles.fireRow}>
                <Text style={[styles.fireRule, { color: sideColor }]}>
                  {a.tfKey} #{a.id.split(":").slice(-1)[0]} · {a.side}
                </Text>
                <Text style={styles.fireMeta}>
                  entry ${a.entryPrice.toFixed(0)} · TP ${a.tpPrice.toFixed(0)} · SL ${a.slPrice.toFixed(0)}
                </Text>
              </View>
            );
          })
        )}
      </View>

      {/* ── Section 3: BUY/SELL ZONES ── */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>📍 ZONES (S/R 15m, ±{proxPct}%)</Text>
        {(buyZone || sellZone) && currentPrice !== null ? (
          <>
            {buyZone && (
              <View style={[styles.zoneBox, inBuyZone && styles.zoneActive, { borderColor: P.green + "55" }]}>
                <Text style={[styles.zoneLabel, { color: P.green }]}>
                  🟢 BUY ZONE {inBuyZone && "← ĐANG TRONG VÙNG"}
                </Text>
                <Text style={styles.zonePrice}>
                  ${buyZone.lo.toFixed(0)} ─ ${buyZone.hi.toFixed(0)} (cách {((currentPrice - buyZone.hi) / buyZone.hi * 100).toFixed(2)}%)
                </Text>
              </View>
            )}
            {sellZone && (
              <View style={[styles.zoneBox, inSellZone && styles.zoneActive, { borderColor: P.error + "55" }]}>
                <Text style={[styles.zoneLabel, { color: P.error }]}>
                  🔴 SELL ZONE {inSellZone && "← ĐANG TRONG VÙNG"}
                </Text>
                <Text style={styles.zonePrice}>
                  ${sellZone.lo.toFixed(0)} ─ ${sellZone.hi.toFixed(0)} (cách {((sellZone.lo - currentPrice) / currentPrice * 100).toFixed(2)}%)
                </Text>
              </View>
            )}
            <Text style={styles.zoneInfo}>
              💡 Price chạm zone + rule fire → entry. Plan B sẽ tự close khi hit TP/SL.
            </Text>
          </>
        ) : (
          <Text style={styles.empty}>chưa có data S/R 15m</Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: P.elevated, borderRadius: 2, padding: 12, marginBottom: 10 },
  h1: { color: P.text, fontSize: 12, fontWeight: "700", letterSpacing: 1.2, fontFamily: "SpaceGrotesk_700Bold", marginBottom: 10 },
  h1Sub: { color: P.bitcoinOrange, fontSize: 10, fontWeight: "500" },
  section: { marginBottom: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: P.highest },
  sectionTitle: { color: P.text2, fontSize: 10, fontWeight: "800", letterSpacing: 1, fontFamily: "SpaceGrotesk_700Bold", marginBottom: 6 },
  empty: { color: P.dim, fontSize: 11, fontStyle: "italic", fontFamily: "JetBrainsMono_500Medium" },
  // Bars
  barRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 },
  barLabel: { fontSize: 10, fontFamily: "JetBrainsMono_700Bold", fontWeight: "700", width: 130 },
  barTrack: { flex: 1, height: 8, backgroundColor: P.surface, borderRadius: 1, borderWidth: 1, borderColor: P.borderSoft, overflow: "hidden" },
  barFill: { height: "100%" },
  barPct: { color: P.dim, fontSize: 10, fontFamily: "JetBrainsMono_500Medium", width: 50, textAlign: "right" },
  statusInfo: { color: P.dim, fontSize: 10, fontFamily: "JetBrainsMono_500Medium", marginTop: 4 },
  // Firing
  fireRow: { paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: P.surface },
  fireRule: { fontSize: 11, fontWeight: "800", fontFamily: "JetBrainsMono_700Bold" },
  fireMeta: { color: P.dim, fontSize: 10, fontFamily: "JetBrainsMono_500Medium", marginTop: 2 },
  // Zones
  zoneBox: { padding: 8, borderRadius: 3, borderWidth: 1, marginBottom: 4, backgroundColor: P.surface },
  zoneActive: { borderWidth: 2 },
  zoneLabel: { fontSize: 11, fontWeight: "800", fontFamily: "JetBrainsMono_700Bold", letterSpacing: 0.5 },
  zonePrice: { color: P.text, fontSize: 10, fontFamily: "JetBrainsMono_500Medium", marginTop: 2 },
  zoneInfo: { color: P.dim, fontSize: 9, fontStyle: "italic", marginTop: 4, fontFamily: "JetBrainsMono_500Medium" },
});
