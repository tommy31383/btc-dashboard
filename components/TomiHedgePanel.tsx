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
import { api } from "../utils/backendApi";
import ConsolidatedPositions from "./ConsolidatedPositions";
import TomiHedgeChart from "./TomiHedgeChart";
import TomiHedgeLogPanel from "./TomiHedgeLogPanel";

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
  const enabled = isPaper
    ? (cfg.tomiHedgePaperEnabled !== false)
    : (cfg.tomiHedgeRealEnabled === true);
  const [busy, setBusy] = React.useState(false);

  const handleToggle = async () => {
    setBusy(true);
    try { await api.tomihedgeToggle(view, !enabled); }
    catch (e: any) { if (typeof window !== "undefined") window.alert("❌ " + (e?.message ?? String(e))); }
    finally { setBusy(false); }
  };

  // v0.4.4: Binance live positions (real view only) — lọc symbol active
  const symbol = cfg.symbol || "BTCUSDT";
  const binancePositions = React.useMemo(() => {
    const all = state?.binanceSnapshot?.positions ?? [];
    return all.filter((p: any) => p.symbol === symbol && Math.abs(parseFloat(p.positionAmt)) > 0);
  }, [state?.binanceSnapshot?.positions, symbol]);

  // v0.4.4 fix #300: ALL hooks PHẢI gọi trước conditional return.
  // Build positions cho ConsolidatedPositions (an toàn cả khi th null)
  const longNet0 = th?.longNet || { qty: 0, avgEntry: 0, totalAdds: 0 };
  const shortNet0 = th?.shortNet || { qty: 0, avgEntry: 0, totalAdds: 0 };
  const consolidatedPositions = useMemo(() => {
    const out: any[] = [];
    if (longNet0.qty > 0) out.push({ side: "LONG", entryPrice: longNet0.avgEntry, qty: longNet0.qty });
    if (shortNet0.qty > 0) out.push({ side: "SHORT", entryPrice: shortNet0.avgEntry, qty: shortNet0.qty });
    return out;
  }, [longNet0.qty, longNet0.avgEntry, shortNet0.qty, shortNet0.avgEntry]);

  // Toggle bar + START/STOP
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
      <TouchableOpacity
        style={[styles.toggleBtn, {
          borderColor: enabled ? P.green : P.dim,
          backgroundColor: enabled ? P.green + "22" : "transparent",
          opacity: busy ? 0.5 : 1,
        }]}
        onPress={handleToggle}
        disabled={busy}
      >
        <Text style={[styles.toggleText, { color: enabled ? P.green : P.dim }]}>
          {enabled ? "⏸ STOP" : "▶ START"}
        </Text>
      </TouchableOpacity>
    </View>
  );

  if (!th) {
    return (
      <View>
        <View style={styles.card}>
          <View style={styles.headerRow}>
            <Text style={styles.h2}>🌊 TomiHedge — Hedge01 ({isPaper ? "PAPER" : "REAL"})</Text>
            {toggle}
          </View>
          {isPaper ? (
            <Text style={styles.empty}>State chưa init. Cần POST /api/live/tomihedge/paper/reset</Text>
          ) : (
            <Text style={styles.empty}>
              🔴 REAL engine state chưa init. {enabled ? "Engine đang ON, chờ entry signal." : "Engine OFF — bấm ▶ START để activate."}
            </Text>
          )}
        </View>
        {!isPaper && <BinancePositionsCard positions={binancePositions} markPrice={markPrice} symbol={symbol} />}
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

      {/* v0.4.4: BINANCE LIVE POSITIONS — chỉ show khi REAL view */}
      {!isPaper && (
        <BinancePositionsCard positions={binancePositions} markPrice={markPrice} symbol={symbol} />
      )}

      {/* CHART — entry/close markers + weekly bias */}
      <TomiHedgeChart
        eventLog={th.eventLog}
        weeklyTrend={th.lastWeeklyTrend}
        title={isPaper ? "TomiHedge PAPER — Entry/Close Markers" : "TomiHedge REAL — Entry/Close Markers"}
      />

      {/* v0.4.5: LOG ADD/CLOSE — 20 entries mới nhất */}
      <TomiHedgeLogPanel
        eventLog={th.eventLog}
        title={isPaper ? "TomiHedge PAPER Log" : "TomiHedge REAL Log"}
      />
    </View>
  );
}

// v0.4.4: Binance LIVE positions card — show vị thế thực trên Binance Futures
function BinancePositionsCard({ positions, markPrice, symbol }: { positions: any[]; markPrice: number | null; symbol: string }) {
  return (
    <View style={styles.card}>
      <Text style={styles.h2}>🏦 BINANCE LIVE POSITIONS · {symbol}</Text>
      {positions.length === 0 ? (
        <Text style={styles.empty}>Không có vị thế nào đang mở trên Binance.</Text>
      ) : (
        <View>
          {/* Header row */}
          <View style={[styles.binRow, styles.binHeader]}>
            <Text style={[styles.binCell, { flex: 1 }]}>SIDE</Text>
            <Text style={[styles.binCell, { flex: 1.2 }]}>QTY</Text>
            <Text style={[styles.binCell, { flex: 1.4 }]}>ENTRY</Text>
            <Text style={[styles.binCell, { flex: 1.4 }]}>MARK</Text>
            <Text style={[styles.binCell, { flex: 1.4 }]}>uPnL</Text>
            <Text style={[styles.binCell, { flex: 1.4 }]}>LIQ</Text>
          </View>
          {positions.map((p: any, i: number) => {
            const amt = parseFloat(p.positionAmt);
            const side = p.positionSide === "BOTH" ? (amt > 0 ? "LONG" : "SHORT") : p.positionSide;
            const entry = parseFloat(p.entryPrice);
            const mark = markPrice ?? parseFloat(p.markPrice ?? "0");
            const upnl = parseFloat(p.unRealizedProfit ?? p.unrealizedProfit ?? "0");
            const liq = parseFloat(p.liquidationPrice ?? "0");
            const sideColor = side === "LONG" ? P.green : P.error;
            return (
              <View key={i} style={styles.binRow}>
                <Text style={[styles.binCell, { flex: 1, color: sideColor, fontWeight: "700" }]}>{side}</Text>
                <Text style={[styles.binCell, { flex: 1.2, color: P.text }]}>{Math.abs(amt).toFixed(4)}</Text>
                <Text style={[styles.binCell, { flex: 1.4, color: P.text }]}>${entry.toFixed(0)}</Text>
                <Text style={[styles.binCell, { flex: 1.4, color: P.text2 }]}>${mark.toFixed(0)}</Text>
                <Text style={[styles.binCell, { flex: 1.4, color: upnl >= 0 ? P.green : P.error, fontWeight: "700" }]}>
                  {upnl >= 0 ? "+" : ""}${upnl.toFixed(2)}
                </Text>
                <Text style={[styles.binCell, { flex: 1.4, color: P.dim }]}>{liq > 0 ? `$${liq.toFixed(0)}` : "—"}</Text>
              </View>
            );
          })}
          <Text style={styles.dim}>
            💡 Dữ liệu live từ Binance Futures API (refresh mỗi tick scheduler).
          </Text>
        </View>
      )}
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
  binRow: { flexDirection: "row", paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: P.borderSoft },
  binHeader: { borderBottomColor: P.border, borderBottomWidth: 2 },
  binCell: { fontSize: 11, fontFamily: "monospace", color: P.dim },
});
