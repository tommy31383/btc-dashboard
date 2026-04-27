/**
 * UnifiedTradesPanel — gộp lệnh OPEN từ 2 engine production:
 *   🔴 LIVE (Binance real, từ live.state.trackedPositions)
 *   🟢 5m ALL (paper engine, từ all5m.account.positions OPEN)
 *
 * Render dưới tab Rule (Dashboard). Thay thế AutoTraderPanel paper legacy
 * (anh Tommy v4.7.6).
 *
 * Mỗi section:
 *   - Stack summary (avg entry, total $, weighted TP/SL, sum uPnL)
 *   - Bảng lệnh (entry/size/TP/SL/held/uPnL)
 *   - Section collapse riêng nếu rỗng
 *
 * KHÔNG bulk close / edit TP/SL ở đây — sang tab LIVE / 5m ALL chính.
 * Đây CHỈ là READ-ONLY overview. Tránh nhầm lẫn destructive action.
 */
import React, { useState } from "react";
import { View, Text, ScrollView, StyleSheet, TouchableOpacity } from "react-native";
import { P } from "../utils/v2Theme";
import DebugLabel from "./DebugLabel";
import { LiveTraderState } from "../utils/liveTraderEngine";
import { All5mAccount, MARGIN_PER_TRADE, LEVERAGE, FEE_PER_SIDE } from "../utils/all5mAccount";

interface Props {
  liveState: LiveTraderState;
  all5mAccount: All5mAccount;
  currentPrice: number | null;
  onGoToLive?: () => void;
  onGoToAll5m?: () => void;
}

function fmtUsd(n: number, sign = false) {
  return (sign && n > 0 ? "+" : "") + "$" + n.toFixed(2);
}

function UnifiedTradesPanelInner({ liveState, all5mAccount, currentPrice, onGoToLive, onGoToAll5m }: Props) {
  const [collapsed, setCollapsed] = useState(false);

  const liveTracked = liveState.trackedPositions;
  const all5mOpen = all5mAccount.positions.filter((p) => p.status === "OPEN");
  // Detect LIVE disconnected — chưa nhập API key (anh Tommy v4.7.7)
  const liveDisconnected = !liveState.apiKey || !liveState.apiSecret;

  // ── LIVE summary ──
  const liveLong = liveTracked.filter((t) => t.side === "LONG");
  const liveShort = liveTracked.filter((t) => t.side === "SHORT");
  const liveSummary = (() => {
    if (liveTracked.length === 0 || currentPrice === null) return null;
    let upnlUsd = 0, sumNotional = 0;
    for (const p of liveTracked) {
      const px = currentPrice;
      upnlUsd += (p.side === "LONG" ? (px - p.entryPrice) : (p.entryPrice - px)) * p.qty;
      sumNotional += p.qty * p.entryPrice;
    }
    return { upnlUsd, sumNotional };
  })();

  // ── 5m ALL summary ──
  const all5mLong = all5mOpen.filter((p) => p.side === "LONG");
  const all5mShort = all5mOpen.filter((p) => p.side === "SHORT");
  const all5mSummary = (() => {
    if (all5mOpen.length === 0 || currentPrice === null) return null;
    const NOTIONAL = MARGIN_PER_TRADE * LEVERAGE; // $30 × 100 = $3000
    let upnlUsd = 0, sumNotional = 0;
    for (const p of all5mOpen) {
      const px = currentPrice;
      const pct = p.side === "LONG"
        ? (px - p.entryPrice) / p.entryPrice * 100
        : (p.entryPrice - px) / p.entryPrice * 100;
      let pnl = MARGIN_PER_TRADE * pct * LEVERAGE / 100;
      if (pnl < -MARGIN_PER_TRADE) pnl = -MARGIN_PER_TRADE;
      upnlUsd += pnl - FEE_PER_SIDE;
      sumNotional += NOTIONAL;
    }
    return { upnlUsd, sumNotional };
  })();

  const totalOpen = liveTracked.length + all5mOpen.length;
  const totalUpnl = (liveSummary?.upnlUsd ?? 0) + (all5mSummary?.upnlUsd ?? 0);

  return (
    <View style={styles.card}>
      <DebugLabel name="UnifiedTradesPanel" />
      <TouchableOpacity onPress={() => setCollapsed((v) => !v)} style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>📊 OPEN POSITIONS · LIVE + 5m ALL</Text>
          <Text style={styles.subtitle}>
            {totalOpen} open · LIVE {liveDisconnected ? <Text style={{ color: P.error }}>⛔ DISCONNECTED</Text> : `${liveTracked.length} (${liveLong.length}L · ${liveShort.length}S)`}{"  "}
            · 5m ALL {all5mOpen.length} ({all5mLong.length}L · {all5mShort.length}S){"  "}
            · uPnL <Text style={{ color: totalUpnl >= 0 ? P.green : P.error }}>{fmtUsd(totalUpnl, true)}</Text>
          </Text>
        </View>
        <Text style={styles.chevron}>{collapsed ? "▾" : "▴"}</Text>
      </TouchableOpacity>

      {!collapsed && (
        <View style={styles.body}>
          {/* ──────────── LIVE section ──────────── */}
          <View style={[styles.section, { borderColor: liveDisconnected ? P.error : P.error + "55" }]}>
            <View style={styles.sectionHead}>
              <Text style={[styles.sectionTitle, { color: P.error }]}>
                🔴 LIVE · Binance real ({liveTracked.length})
                {liveDisconnected && " · ⛔ DISCONNECTED"}
              </Text>
              {onGoToLive && (
                <TouchableOpacity onPress={onGoToLive} style={[styles.gotoBtn, liveDisconnected && { borderColor: P.error, backgroundColor: P.error + "18" }]}>
                  <Text style={[styles.gotoBtnText, liveDisconnected && { color: P.error, fontWeight: "700" }]}>
                    {liveDisconnected ? "🔧 SETUP →" : "tab LIVE →"}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
            {liveDisconnected ? (
              <View style={styles.disconnectBox}>
                <Text style={styles.disconnectTitle}>⛔ LIVE chưa connect Binance</Text>
                <Text style={styles.disconnectText}>
                  Device này chưa có API key — không vào lệnh thật, không tham gia leader election.
                  {"\n"}→ Bấm <Text style={{ color: P.error, fontWeight: "700" }}>🔧 SETUP</Text> để sang tab LIVE → CREDENTIALS card → nhập API key/secret.
                </Text>
              </View>
            ) : liveTracked.length === 0 ? (
              <Text style={styles.empty}>Đã connect — chưa có lệnh LIVE đang theo dõi (chờ rule fire).</Text>
            ) : (
              <>
                {liveSummary && (
                  <Text style={styles.sumLine}>
                    Total notional <Text style={styles.sumNum}>${liveSummary.sumNotional.toFixed(0)}</Text>
                    {"  "}· uPnL <Text style={{ color: liveSummary.upnlUsd >= 0 ? P.green : P.error, fontWeight: "700" }}>
                      {fmtUsd(liveSummary.upnlUsd, true)}
                    </Text>
                  </Text>
                )}
                <ScrollView horizontal showsHorizontalScrollIndicator>
                  <View>
                    <View style={[styles.tblRow, styles.tblHeader]}>
                      <Text style={[styles.tblHead, { width: 40 }]}>SIDE</Text>
                      <Text style={[styles.tblHead, { width: 90 }]}>RULE</Text>
                      <Text style={[styles.tblHead, { width: 75 }]}>ENTRY</Text>
                      <Text style={[styles.tblHead, { width: 70 }]}>SIZE $</Text>
                      <Text style={[styles.tblHead, { width: 90 }]}>TP</Text>
                      <Text style={[styles.tblHead, { width: 90 }]}>SL</Text>
                      <Text style={[styles.tblHead, { width: 50 }]}>HELD</Text>
                      <Text style={[styles.tblHead, { width: 70, textAlign: "right" }]}>uPnL</Text>
                    </View>
                    {liveTracked.slice().sort((a, b) => b.entryMs - a.entryMs).map((t) => {
                      const sideColor = t.side === "LONG" ? P.green : P.error;
                      const upnlPct = currentPrice !== null
                        ? (t.side === "LONG" ? (currentPrice - t.entryPrice) : (t.entryPrice - currentPrice)) / t.entryPrice * 100
                        : 0;
                      const heldMin = Math.floor((Date.now() - t.entryMs) / 60000);
                      const heldStr = heldMin >= 60 ? `${(heldMin / 60).toFixed(1)}h` : `${heldMin}m`;
                      const upnlColor = upnlPct >= 0 ? P.green : P.error;
                      return (
                        <View key={t.id} style={styles.tblRow}>
                          <Text style={[styles.tblCell, { width: 40, color: sideColor, fontWeight: "800" }]}>{t.side}</Text>
                          <Text style={[styles.tblCell, { width: 90, color: P.tertiary, fontSize: 9 }]} numberOfLines={1}>{t.id}</Text>
                          <Text style={[styles.tblCell, { width: 75 }]}>${t.entryPrice.toFixed(0)}</Text>
                          <Text style={[styles.tblCell, { width: 70 }]}>${(t.qty * t.entryPrice).toFixed(0)}</Text>
                          <Text style={[styles.tblCell, { width: 90, color: P.green }]}>${t.tpPrice.toFixed(0)}</Text>
                          <Text style={[styles.tblCell, { width: 90, color: P.error }]}>${t.slPrice.toFixed(0)}</Text>
                          <Text style={[styles.tblCell, { width: 50, color: P.dim }]}>{heldStr}</Text>
                          <Text style={[styles.tblCell, { width: 70, color: upnlColor, textAlign: "right", fontWeight: "700" }]}>
                            {upnlPct >= 0 ? "+" : ""}{upnlPct.toFixed(2)}%
                          </Text>
                        </View>
                      );
                    })}
                  </View>
                </ScrollView>
              </>
            )}
          </View>

          {/* ──────────── 5m ALL section ──────────── */}
          <View style={[styles.section, { borderColor: P.bitcoinOrange + "55" }]}>
            <View style={styles.sectionHead}>
              <Text style={[styles.sectionTitle, { color: P.bitcoinOrange }]}>🟢 5m ALL · paper ({all5mOpen.length})</Text>
              {onGoToAll5m && (
                <TouchableOpacity onPress={onGoToAll5m} style={styles.gotoBtn}>
                  <Text style={styles.gotoBtnText}>tab 5m ALL →</Text>
                </TouchableOpacity>
              )}
            </View>
            {all5mOpen.length === 0 ? (
              <Text style={styles.empty}>Chưa có lệnh 5m ALL đang mở.</Text>
            ) : (
              <>
                {all5mSummary && (
                  <Text style={styles.sumLine}>
                    Total notional <Text style={styles.sumNum}>${all5mSummary.sumNotional.toFixed(0)}</Text>
                    {"  "}· uPnL <Text style={{ color: all5mSummary.upnlUsd >= 0 ? P.green : P.error, fontWeight: "700" }}>
                      {fmtUsd(all5mSummary.upnlUsd, true)}
                    </Text>
                  </Text>
                )}
                <ScrollView horizontal showsHorizontalScrollIndicator>
                  <View>
                    <View style={[styles.tblRow, styles.tblHeader]}>
                      <Text style={[styles.tblHead, { width: 40 }]}>SIDE</Text>
                      <Text style={[styles.tblHead, { width: 90 }]}>SOURCE</Text>
                      <Text style={[styles.tblHead, { width: 75 }]}>ENTRY</Text>
                      <Text style={[styles.tblHead, { width: 70 }]}>SIZE $</Text>
                      <Text style={[styles.tblHead, { width: 90 }]}>TP</Text>
                      <Text style={[styles.tblHead, { width: 90 }]}>SL</Text>
                      <Text style={[styles.tblHead, { width: 50 }]}>HELD</Text>
                      <Text style={[styles.tblHead, { width: 70, textAlign: "right" }]}>uPnL</Text>
                    </View>
                    {all5mOpen.slice().sort((a, b) => b.entryMs - a.entryMs).map((p) => {
                      const sideColor = p.side === "LONG" ? P.green : P.error;
                      const NOTIONAL = MARGIN_PER_TRADE * LEVERAGE;
                      const upnlPct = currentPrice !== null
                        ? (p.side === "LONG" ? (currentPrice - p.entryPrice) : (p.entryPrice - currentPrice)) / p.entryPrice * 100 * LEVERAGE
                        : 0;
                      const heldMin = Math.floor((Date.now() - p.entryMs) / 60000);
                      const heldStr = heldMin >= 60 ? `${(heldMin / 60).toFixed(1)}h` : `${heldMin}m`;
                      const upnlColor = upnlPct >= 0 ? P.green : P.error;
                      return (
                        <View key={p.id} style={styles.tblRow}>
                          <Text style={[styles.tblCell, { width: 40, color: sideColor, fontWeight: "800" }]}>{p.side}</Text>
                          <Text style={[styles.tblCell, { width: 90, color: P.tertiary, fontSize: 9 }]} numberOfLines={1}>{p.source.replace("_", " ")}</Text>
                          <Text style={[styles.tblCell, { width: 75 }]}>${p.entryPrice.toFixed(0)}</Text>
                          <Text style={[styles.tblCell, { width: 70 }]}>${NOTIONAL}</Text>
                          <Text style={[styles.tblCell, { width: 90, color: P.green }]}>${p.tpPrice.toFixed(0)}</Text>
                          <Text style={[styles.tblCell, { width: 90, color: P.error }]}>${p.slPrice.toFixed(0)}</Text>
                          <Text style={[styles.tblCell, { width: 50, color: P.dim }]}>{heldStr}</Text>
                          <Text style={[styles.tblCell, { width: 70, color: upnlColor, textAlign: "right", fontWeight: "700" }]}>
                            {upnlPct >= 0 ? "+" : ""}{upnlPct.toFixed(2)}%
                          </Text>
                        </View>
                      );
                    })}
                  </View>
                </ScrollView>
              </>
            )}
          </View>

          <Text style={styles.footnote}>
            💡 READ-ONLY view. Close / Edit TP-SL → sang tab LIVE hoặc 5m ALL.
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: P.elevated, borderRadius: 2, marginBottom: 10 },
  header: { flexDirection: "row", alignItems: "center", paddingVertical: 12, paddingHorizontal: 14 },
  title: { color: P.text, fontSize: 12, fontWeight: "700", letterSpacing: 1.2, fontFamily: "SpaceGrotesk_700Bold", marginBottom: 3 },
  subtitle: { color: P.dim, fontSize: 10, fontFamily: "JetBrainsMono_500Medium" },
  chevron: { color: P.dim, fontSize: 14, marginLeft: 8 },
  body: { padding: 14, paddingTop: 0, borderTopWidth: 1, borderTopColor: P.highest, gap: 12 },
  section: { padding: 10, borderRadius: 4, borderWidth: 1, backgroundColor: P.surface },
  sectionHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 6 },
  sectionTitle: { fontSize: 11, fontWeight: "800", letterSpacing: 1, fontFamily: "JetBrainsMono_700Bold" },
  gotoBtn: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 2, borderWidth: 1, borderColor: P.borderSoft },
  gotoBtnText: { color: P.dim, fontSize: 9, fontFamily: "JetBrainsMono_500Medium", letterSpacing: 0.5 },
  sumLine: { color: P.dim, fontSize: 10, fontFamily: "JetBrainsMono_500Medium", marginBottom: 6 },
  sumNum: { color: P.text, fontWeight: "700" },
  empty: { color: P.dim, fontSize: 10, fontFamily: "JetBrainsMono_500Medium", fontStyle: "italic", paddingVertical: 4 },
  tblRow: { flexDirection: "row", alignItems: "center", paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: P.highest },
  tblHeader: { backgroundColor: P.surface, borderBottomColor: P.borderSoft },
  tblHead: { color: P.dim, fontSize: 9, fontFamily: "JetBrainsMono_700Bold", letterSpacing: 0.5, paddingHorizontal: 4 },
  tblCell: { color: P.text, fontSize: 10, fontFamily: "JetBrainsMono_500Medium", paddingHorizontal: 4 },
  footnote: { color: P.dim, fontSize: 9, fontStyle: "italic", marginTop: 4, fontFamily: "JetBrainsMono_500Medium" },
  disconnectBox: { padding: 10, borderRadius: 4, borderWidth: 1, borderColor: P.error + "60", backgroundColor: P.error + "10" },
  disconnectTitle: { color: P.error, fontSize: 11, fontWeight: "800", letterSpacing: 0.5, fontFamily: "JetBrainsMono_700Bold", marginBottom: 4 },
  disconnectText: { color: P.text, fontSize: 10, lineHeight: 14, fontFamily: "JetBrainsMono_500Medium" },
});

const UnifiedTradesPanel = React.memo(UnifiedTradesPanelInner);
export default UnifiedTradesPanel;
