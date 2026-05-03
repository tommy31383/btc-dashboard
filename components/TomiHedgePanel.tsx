/**
 * TomiHedgePanel — render TomiHedge engine state (Hedge01 rule).
 *
 * Display:
 *   - Header: rule name + capital + ROI
 *   - 2 NET cards: LONG + SHORT (qty, avg entry, uPnL, margin)
 *   - Account NET LIQ (1 cái duy nhất theo NET direction)
 *   - Stats: total adds, closes, realized PnL, fees
 *   - Action: Reset + Close All
 */
import React, { useMemo } from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
// Toggle types exported above
import { P } from "../utils/v2Theme";
import ConsolidatedPositions from "./ConsolidatedPositions";

export type TomiHedgeView = "paper" | "real";

interface Props {
  state: any;
  markPrice: number | null;
  view: TomiHedgeView;
  onViewChange: (v: TomiHedgeView) => void;
}

export default function TomiHedgePanel({ state, markPrice, view, onViewChange }: Props) {
  const cfg = state?.settings || {};
  const isPaper = view === "paper";
  const th = isPaper ? state?.tomiHedgePaper : state?.tomiHedgeReal;

  // Toggle bar
  const toggle = (
    <View style={styles.toggleRow}>
      <TouchableOpacity
        style={[styles.toggleBtn, view === "real" && { borderColor: P.error, backgroundColor: P.error + "22" }]}
        onPress={() => onViewChange("real")}
      >
        <Text style={[styles.toggleText, view === "real" && { color: P.error }]}>🔴 REAL</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.toggleBtn, view === "paper" && { borderColor: "#3b82f6", backgroundColor: "#3b82f622" }]}
        onPress={() => onViewChange("paper")}
      >
        <Text style={[styles.toggleText, view === "paper" && { color: "#3b82f6" }]}>📋 PAPER</Text>
      </TouchableOpacity>
    </View>
  );

  if (!th) {
    return (
      <View style={styles.card}>
        <View style={styles.headerRow}>
          <Text style={styles.h2}>🌊 TomiHedge — Hedge01 ({isPaper ? "PAPER" : "REAL"})</Text>
          {toggle}
        </View>
        {isPaper ? (
          <Text style={styles.empty}>State chưa init. Cần POST /api/live/tomihedge/paper/reset</Text>
        ) : (
          <Text style={styles.empty}>
            🔴 REAL engine chưa activate. Em đang defer chờ paper test OK rồi anh confirm mới deploy real (tránh risk tiền thật).
          </Text>
        )}
      </View>
    );
  }

  const longNet = th.longNet || { qty: 0, avgEntry: 0, totalAdds: 0 };
  const shortNet = th.shortNet || { qty: 0, avgEntry: 0, totalAdds: 0 };
  const wallet: number = th.wallet ?? 0;
  const initialCap: number = th.initialCapital ?? 1000;

  // Compute uPnL realtime
  const uPnLLong = (markPrice && longNet.qty > 0) ? longNet.qty * (markPrice - longNet.avgEntry) : 0;
  const uPnLShort = (markPrice && shortNet.qty > 0) ? shortNet.qty * (shortNet.avgEntry - markPrice) : 0;
  const totalUpnl = uPnLLong + uPnLShort;
  const equity = wallet + totalUpnl;
  const roi = ((equity - initialCap) / initialCap) * 100;

  // Build positions for ConsolidatedPositions component (which expects array)
  const consolidatedPositions = useMemo(() => {
    const out: any[] = [];
    if (longNet.qty > 0) out.push({ side: "LONG", entryPrice: longNet.avgEntry, qty: longNet.qty });
    if (shortNet.qty > 0) out.push({ side: "SHORT", entryPrice: shortNet.avgEntry, qty: shortNet.qty });
    return out;
  }, [longNet.qty, longNet.avgEntry, shortNet.qty, shortNet.avgEntry]);

  return (
    <View>
      {/* HEADER */}
      <View style={styles.card}>
        <View style={styles.headerRow}>
          <Text style={styles.h2}>
            🌊 TomiHedge — <Text style={{ color: P.bitcoinOrange }}>{th.activeRuleKey?.toUpperCase() || "?"}</Text>{" "}
            <Text style={{ color: isPaper ? "#3b82f6" : P.error, fontSize: 12 }}>
              · {isPaper ? "📋 PAPER" : "🔴 REAL"}
            </Text>
          </Text>
          {toggle}
        </View>
        <View style={styles.row}>
          <View style={styles.kpi}>
            <Text style={styles.kpiLabel}>WALLET</Text>
            <Text style={[styles.kpiVal, { color: P.bitcoinOrange }]}>${wallet.toFixed(2)}</Text>
          </View>
          <View style={styles.kpi}>
            <Text style={styles.kpiLabel}>EQUITY</Text>
            <Text style={[styles.kpiVal, { color: equity >= initialCap ? P.green : P.error }]}>${equity.toFixed(2)}</Text>
          </View>
          <View style={styles.kpi}>
            <Text style={styles.kpiLabel}>ROI</Text>
            <Text style={[styles.kpiVal, { color: roi >= 0 ? P.green : P.error }]}>
              {roi >= 0 ? "+" : ""}{roi.toFixed(2)}%
            </Text>
          </View>
          <View style={styles.kpi}>
            <Text style={styles.kpiLabel}>uPnL</Text>
            <Text style={[styles.kpiVal, { color: totalUpnl >= 0 ? P.green : P.error }]}>
              {totalUpnl >= 0 ? "+" : ""}${totalUpnl.toFixed(2)}
            </Text>
          </View>
        </View>
        <Text style={styles.dim}>
          Initial: ${initialCap} · Realized: ${th.totalRealizedPnl?.toFixed(2) ?? "0.00"} · Fees: ${th.totalFeesPaid?.toFixed(2) ?? "0.00"}
        </Text>
        <Text style={styles.dim}>
          Total ADDs: LONG {th.totalAddsLong ?? 0} · SHORT {th.totalAddsShort ?? 0} · Closes: {th.totalCloses ?? 0}
        </Text>
      </View>

      {/* CONSOLIDATED POSITIONS (2 NET LONG + SHORT + ACCOUNT LIQ) */}
      <ConsolidatedPositions
        positions={consolidatedPositions}
        markPrice={markPrice}
        walletUsd={wallet}
        marginUsd={cfg.paperMarginUsd ?? 1}
        leverage={cfg.paperLeverage ?? 125}
        title={isPaper ? "🌊 TomiHedge PAPER NET POSITIONS" : "🌊 TomiHedge REAL NET POSITIONS"}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: P.surface, borderRadius: 6, padding: 12, marginBottom: 14, borderWidth: 1, borderColor: P.border },
  h2: { color: P.text, fontSize: 14, fontWeight: "700", marginBottom: 10 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 12, marginBottom: 8 },
  kpi: { minWidth: 90 },
  kpiLabel: { color: P.dim, fontSize: 9, fontFamily: "monospace" },
  kpiVal: { fontSize: 16, fontWeight: "700", fontFamily: "monospace" },
  dim: { color: P.dim, fontSize: 11, fontFamily: "monospace", marginTop: 4 },
  empty: { color: P.dim, fontSize: 11, fontStyle: "italic", padding: 8 },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  toggleRow: { flexDirection: "row", gap: 6 },
  toggleBtn: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 4, borderWidth: 1, borderColor: P.borderSoft },
  toggleText: { color: P.dim, fontSize: 11, fontWeight: "700", fontFamily: "monospace" },
});
