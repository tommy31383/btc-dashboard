/**
 * HistoryScreen — full-screen list các lệnh đã đóng (WIN/LOSS/TIMEOUT) của
 * auto-trader. Render dưới tab HISTORY trong bottom nav.
 *
 * Hiển thị:
 *   - Header KPI: capital · ROI · win rate · tổng lệnh
 *   - Filter: ALL / WIN / LOSS / TIMEOUT
 *   - Danh sách lệnh sort theo closedMs DESC
 */
import React, { useMemo, useState } from "react";
import { View, Text, ScrollView, StyleSheet, TouchableOpacity } from "react-native";
import { P } from "../utils/v2Theme";
import DebugLabel from "./DebugLabel";
import {
  AutoAccount,
  AutoPosition,
  PositionStatus,
  INITIAL_CAPITAL_USD,
  summarize,
} from "../utils/autoAccount";

interface Props {
  account: AutoAccount;
  summary: ReturnType<typeof summarize>;
}

type Filter = "ALL" | "WIN" | "LOSS" | "TIMEOUT";

export default function HistoryScreen({ account, summary }: Props) {
  const [filter, setFilter] = useState<Filter>("ALL");

  const closed = useMemo(() => {
    const list = summary.closed.slice().sort((a, b) => (b.closedMs ?? 0) - (a.closedMs ?? 0));
    if (filter === "ALL") return list;
    return list.filter((p) => p.status === filter);
  }, [summary.closed, filter]);

  const counts = useMemo(() => {
    const c = { ALL: summary.closed.length, WIN: 0, LOSS: 0, TIMEOUT: 0 } as Record<Filter, number>;
    for (const p of summary.closed) {
      if (p.status === "WIN") c.WIN++;
      else if (p.status === "LOSS") c.LOSS++;
      else if (p.status === "TIMEOUT") c.TIMEOUT++;
    }
    return c;
  }, [summary.closed]);

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <DebugLabel name="HistoryScreen" />
      {/* KPI bar */}
      <View style={styles.kpiBar}>
        <Kpi
          label="CAPITAL"
          value={`$${account.capitalUsd.toFixed(0)}`}
          sub={`PnL $${account.stats.totalPnLUsd >= 0 ? "+" : ""}${account.stats.totalPnLUsd.toFixed(0)}`}
          color={account.capitalUsd >= INITIAL_CAPITAL_USD ? P.green : P.error}
        />
        <Kpi
          label="ROI"
          value={`${summary.roi >= 0 ? "+" : ""}${summary.roi.toFixed(1)}%`}
          color={summary.roi >= 0 ? P.green : P.error}
        />
        <Kpi
          label="WIN RATE"
          value={`${summary.winRate.toFixed(0)}%`}
          sub={`${account.stats.wins}W ${account.stats.losses}L`}
          color={summary.winRate >= 50 ? P.green : P.error}
        />
        <Kpi
          label="TRADES"
          value={String(account.stats.totalTrades)}
          sub={`${account.stats.timeouts}T`}
        />
      </View>

      {/* Filter tabs */}
      <View style={styles.filterRow}>
        {(["ALL", "WIN", "LOSS", "TIMEOUT"] as Filter[]).map((f) => {
          const active = f === filter;
          const accent = f === "WIN" ? P.green : f === "LOSS" ? P.error : f === "TIMEOUT" ? P.tertiary : P.bitcoinOrange;
          return (
            <TouchableOpacity
              key={f}
              onPress={() => setFilter(f)}
              style={[styles.filterBtn, active && { borderColor: accent, backgroundColor: accent + "20" }]}
            >
              <Text style={[styles.filterText, active && { color: accent }]}>
                {f} {counts[f] > 0 ? `(${counts[f]})` : ""}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* List */}
      {closed.length === 0 ? (
        <Text style={styles.empty}>Chưa có lệnh nào đóng.</Text>
      ) : (
        closed.map((p) => <ClosedRow key={p.id} p={p} />)
      )}
    </ScrollView>
  );
}

function Kpi({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <View style={styles.kpi}>
      <Text style={styles.kpiLabel}>{label}</Text>
      <Text style={[styles.kpiValue, color ? { color } : null]}>{value}</Text>
      {sub && <Text style={styles.kpiSub}>{sub}</Text>}
    </View>
  );
}

function ClosedRow({ p }: { p: AutoPosition }) {
  const pnl = p.pnlUsd ?? 0;
  const pnlColor = p.status === "WIN" ? P.green : p.status === "LOSS" ? P.error : P.tertiary;
  const closedAt = p.closedMs ? new Date(p.closedMs) : null;
  const openedAt = p.openedMs ? new Date(p.openedMs) : null;
  const holdMin = p.openedMs && p.closedMs ? Math.round((p.closedMs - p.openedMs) / 60000) : null;

  return (
    <View style={[styles.row, { borderLeftColor: pnlColor }]}>
      <View style={styles.rowHead}>
        <View style={{ flex: 1 }}>
          <Text style={styles.rowTitle}>
            <Text style={[styles.tag, { color: p.side === "LONG" ? P.green : P.error }]}>{p.side}</Text>
            {"  "}{p.tfKey}
            {"  "}<Text style={[styles.statusBadge, { color: pnlColor }]}>{p.status}</Text>
          </Text>
          <Text style={styles.rowMeta}>{p.ruleId}</Text>
        </View>
        <Text style={[styles.pnl, { color: pnlColor }]}>
          {pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}
        </Text>
      </View>
      <View style={styles.rowGrid}>
        <Text style={styles.cell}>entry ${p.entryPrice?.toFixed(1) ?? "—"}</Text>
        <Text style={styles.cell}>exit ${p.exitPrice?.toFixed(1) ?? "—"}</Text>
        <Text style={styles.cell}>SL ${p.slPrice.toFixed(1)}</Text>
        <Text style={styles.cell}>TP ${p.tpPrice.toFixed(1)}</Text>
      </View>
      <Text style={styles.rowFoot}>
        {openedAt ? openedAt.toLocaleString("vi-VN", { hour12: false }) : "—"}
        {closedAt ? `  →  ${closedAt.toLocaleString("vi-VN", { hour12: false })}` : ""}
        {holdMin !== null ? `  · ${holdMin}m` : ""}
        {p.entryMode ? `  · ${p.entryMode === "limit_filled" ? "limit ✓" : "auto@expiry"}` : ""}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: P.bg },
  content: { padding: 12, paddingBottom: 80 },
  kpiBar: { flexDirection: "row", gap: 6, marginBottom: 10 },
  kpi: { flex: 1, backgroundColor: P.elevated, padding: 10, borderRadius: 2, borderWidth: 1, borderColor: P.highest },
  kpiLabel: { color: P.dim, fontSize: 9, fontWeight: "700", letterSpacing: 1, fontFamily: "SpaceGrotesk_700Bold" },
  kpiValue: { color: P.text, fontSize: 14, fontWeight: "700", fontFamily: "JetBrainsMono_700Bold", marginTop: 2 },
  kpiSub: { color: P.dim, fontSize: 9, fontFamily: "JetBrainsMono_500Medium", marginTop: 2 },
  filterRow: { flexDirection: "row", gap: 6, marginBottom: 10 },
  filterBtn: { flex: 1, paddingVertical: 8, borderWidth: 1, borderColor: P.highest, borderRadius: 2, alignItems: "center", backgroundColor: P.elevated },
  filterText: { color: P.dim, fontSize: 10, fontWeight: "700", letterSpacing: 0.5, fontFamily: "SpaceGrotesk_700Bold" },
  empty: { color: P.dim, fontSize: 12, textAlign: "center", marginTop: 40, fontFamily: "Inter_400Regular", fontStyle: "italic" },
  row: {
    backgroundColor: P.elevated, borderRadius: 2, marginBottom: 6,
    padding: 10, borderLeftWidth: 3,
  },
  rowHead: { flexDirection: "row", alignItems: "flex-start", marginBottom: 6 },
  rowTitle: { color: P.text, fontSize: 11, fontWeight: "600", fontFamily: "JetBrainsMono_500Medium", marginBottom: 2 },
  rowMeta: { color: P.dim, fontSize: 9, fontFamily: "JetBrainsMono_500Medium" },
  tag: { fontWeight: "800", fontSize: 10, letterSpacing: 0.5 },
  statusBadge: { fontWeight: "800", fontSize: 9, letterSpacing: 0.5 },
  pnl: { fontSize: 14, fontWeight: "700", fontFamily: "JetBrainsMono_700Bold", marginLeft: 8 },
  rowGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 4 },
  cell: { color: P.text2, fontSize: 10, fontFamily: "JetBrainsMono_500Medium" },
  rowFoot: { color: P.dim, fontSize: 9, fontFamily: "JetBrainsMono_500Medium", marginTop: 2 },
});
