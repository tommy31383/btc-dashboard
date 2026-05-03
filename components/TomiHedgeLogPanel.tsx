/**
 * TomiHedgeLogPanel v0.4.5 — bảng log ADD/CLOSE từ eventLog state.
 * Default hiển thị 20 entries mới nhất, filter ALL/ADD/CLOSE.
 */
import React, { useState, useMemo } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from "react-native";
import { P } from "../utils/v2Theme";

interface Event {
  ts: number;
  kind: "ADD" | "CLOSE";
  side: "LONG" | "SHORT";
  price: number;
  qty: number;
  avgEntryAfter?: number;
  realizedPnl?: number;
  weeklyTrend?: "UP" | "DOWN";
}

interface Props {
  eventLog?: Event[];
  title?: string;
}

type Filter = "ALL" | "ADD" | "CLOSE";

export default function TomiHedgeLogPanel({ eventLog, title }: Props) {
  const [filter, setFilter] = useState<Filter>("ALL");

  const rows = useMemo(() => {
    const all = eventLog || [];
    const filtered = filter === "ALL" ? all : all.filter((e) => e.kind === filter);
    // Mới nhất trên cùng, lấy 20
    return [...filtered].reverse().slice(0, 20);
  }, [eventLog, filter]);

  const fmtTime = (ts: number) => {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const mo = String(d.getMonth() + 1).padStart(2, "0");
    return `${dd}/${mo} ${hh}:${mm}:${ss}`;
  };

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Text style={styles.h2}>📜 {title || "TomiHedge Log"}</Text>
        <View style={styles.filterRow}>
          {(["ALL", "ADD", "CLOSE"] as Filter[]).map((f) => (
            <TouchableOpacity
              key={f}
              style={[styles.filterBtn, filter === f && styles.filterBtnActive]}
              onPress={() => setFilter(f)}
            >
              <Text style={[styles.filterText, filter === f && styles.filterTextActive]}>{f}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Header row */}
      <View style={[styles.row, styles.headerCells]}>
        <Text style={[styles.cell, { flex: 2 }]}>TIME</Text>
        <Text style={[styles.cell, { flex: 1 }]}>KIND</Text>
        <Text style={[styles.cell, { flex: 1 }]}>SIDE</Text>
        <Text style={[styles.cell, { flex: 1.4 }]}>QTY</Text>
        <Text style={[styles.cell, { flex: 1.4 }]}>PRICE</Text>
        <Text style={[styles.cell, { flex: 1.4 }]}>AVG/PnL</Text>
      </View>

      <ScrollView style={{ maxHeight: 420 }}>
        {rows.length === 0 ? (
          <Text style={styles.empty}>Chưa có event nào.</Text>
        ) : (
          rows.map((e, i) => {
            const sideColor = e.side === "LONG" ? P.green : P.error;
            const isAdd = e.kind === "ADD";
            const last = isAdd
              ? (e.avgEntryAfter ? `$${e.avgEntryAfter.toFixed(0)}` : "—")
              : (e.realizedPnl !== undefined
                  ? `${e.realizedPnl >= 0 ? "+" : ""}$${e.realizedPnl.toFixed(2)}`
                  : "—");
            const lastColor = isAdd
              ? P.text2
              : (e.realizedPnl !== undefined && e.realizedPnl >= 0 ? P.green : P.error);
            return (
              <View key={i} style={styles.row}>
                <Text style={[styles.cell, { flex: 2, color: P.dim }]}>{fmtTime(e.ts)}</Text>
                <Text style={[styles.cell, { flex: 1, color: isAdd ? P.bitcoinOrange : P.text2, fontWeight: "700" }]}>
                  {isAdd ? "▲ ADD" : "✕ CLOSE"}
                </Text>
                <Text style={[styles.cell, { flex: 1, color: sideColor, fontWeight: "700" }]}>{e.side}</Text>
                <Text style={[styles.cell, { flex: 1.4, color: P.text }]}>{e.qty.toFixed(4)}</Text>
                <Text style={[styles.cell, { flex: 1.4, color: P.text }]}>${e.price.toFixed(0)}</Text>
                <Text style={[styles.cell, { flex: 1.4, color: lastColor, fontWeight: "700" }]}>{last}</Text>
              </View>
            );
          })
        )}
      </ScrollView>

      <Text style={styles.dim}>
        💡 Hiển thị 20 entries mới nhất · server lưu cap 500 trong state · reset state → log mất.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: P.surface, borderRadius: 6, padding: 10, marginBottom: 14, borderWidth: 1, borderColor: P.border },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  h2: { color: P.text, fontSize: 13, fontWeight: "700" },
  filterRow: { flexDirection: "row", gap: 4 },
  filterBtn: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 3, borderWidth: 1, borderColor: P.borderSoft },
  filterBtnActive: { borderColor: P.bitcoinOrange, backgroundColor: P.bitcoinOrange + "22" },
  filterText: { color: P.dim, fontSize: 9, fontWeight: "700", fontFamily: "monospace" },
  filterTextActive: { color: P.bitcoinOrange },
  row: { flexDirection: "row", paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: P.borderSoft },
  headerCells: { borderBottomColor: P.border, borderBottomWidth: 2 },
  cell: { fontSize: 10, fontFamily: "monospace", color: P.dim },
  empty: { color: P.dim, fontSize: 11, fontStyle: "italic", padding: 12, textAlign: "center" },
  dim: { color: P.dim, fontSize: 10, fontFamily: "monospace", marginTop: 6 },
});
