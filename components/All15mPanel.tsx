/**
 * All15mPanel — full-screen panel cho tab "15m All".
 *
 * Strategy: LONG mỗi nến 15m đóng. Trong 7 phút chờ 5m StochRSI K<20 để fill;
 * hết deadline → force fill. SL -2% / TP +5% raw, lev 100x → +$150/lệnh thắng,
 * -$30/lệnh thua (cap ở margin).
 *
 * Hiển thị: KPI, equity curve (SVG), 3 list (PENDING countdown / OPEN uPnL / CLOSED).
 */
import React, { useMemo, useState } from "react";
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from "react-native";
import Svg, { Polyline, Line } from "react-native-svg";
import { P } from "../utils/v2Theme";
import {
  All15mAccount, AccountSummary, Position,
  INITIAL_CAPITAL, MARGIN_PER_TRADE, LEVERAGE, NOTIONAL,
  TP_PCT, SL_PCT, STOCH_OS_LEVEL, PENDING_TIMEOUT_MS, FEE_PER_TRADE, FEE_PER_SIDE,
} from "../utils/all15mAccount";

interface Props {
  account: All15mAccount;
  summary: AccountSummary;
  currentPrice: number | null;
  stoch5mK: number | null;
  onReset: () => Promise<void> | void;
}

type Filter = "ALL" | "WIN" | "LOSS";

function fmtUsd(n: number, sign = false) {
  const s = (sign && n > 0 ? "+" : "") + "$" + n.toFixed(2);
  return s;
}
function fmtPct(n: number, sign = true) {
  return (sign && n > 0 ? "+" : "") + n.toFixed(2) + "%";
}
function fmtTime(ms: number) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}
function fmtCountdown(ms: number) {
  if (ms <= 0) return "00:00";
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function EquityCurveSvg({ data, width = 760, height = 220 }: { data: { t: number; equity: number }[]; width?: number; height?: number; }) {
  if (!data || data.length < 2) {
    return <View style={[styles.chartBox, { width, height, justifyContent: "center", alignItems: "center" }]}>
      <Text style={styles.chartEmpty}>chưa có data — chờ lệnh đầu tiên đóng</Text>
    </View>;
  }
  const vals = data.map((d) => d.equity);
  const min = Math.min(INITIAL_CAPITAL, ...vals);
  const max = Math.max(INITIAL_CAPITAL, ...vals);
  const range = max - min || 1;
  const pad = 8;
  const w = width - pad * 2;
  const h = height - pad * 2;
  const pts = data.map((d, i) => {
    const x = pad + (i / (data.length - 1)) * w;
    const y = pad + h - ((d.equity - min) / range) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const yInitial = pad + h - ((INITIAL_CAPITAL - min) / range) * h;
  const color = vals[vals.length - 1] >= INITIAL_CAPITAL ? P.green : P.error;
  return (
    <View style={{ width, height, backgroundColor: P.surface, borderRadius: 2, borderWidth: 1, borderColor: P.borderSoft, padding: 0 }}>
      <Svg width={width} height={height}>
        <Line x1={0} y1={yInitial} x2={width} y2={yInitial} stroke={P.dim} strokeWidth={0.6} strokeDasharray="3,3" />
        <Polyline points={pts} fill="none" stroke={color} strokeWidth={2} />
      </Svg>
    </View>
  );
}

export default function All15mPanel({ account, summary, currentPrice, stoch5mK, onReset }: Props) {
  const [filter, setFilter] = useState<Filter>("ALL");

  const handleReset = () => {
    if (typeof window !== "undefined") {
      const ok = window.confirm(
        `RESET 15m All account?\n\nXoá tất cả lệnh, capital về $${INITIAL_CAPITAL}.\n\nKhông thể undo.`
      );
      if (!ok) return;
    }
    Promise.resolve(onReset());
  };

  const pending = account.positions.filter((p) => p.status === "PENDING");
  const open = account.positions.filter((p) => p.status === "OPEN");
  const closedAll = account.positions.filter((p) => p.status === "WIN" || p.status === "LOSS");
  const closed = filter === "ALL" ? closedAll : closedAll.filter((p) => p.status === filter);

  // Unrealized NET PnL từ open positions (đã trừ exit fee chưa thanh toán;
  // entry fee đã trừ khỏi capital lúc fill rồi).
  const unrealized = useMemo(() => {
    if (currentPrice === null) return 0;
    let s = 0;
    for (const p of open) {
      if (!p.entryPrice) continue;
      const pct = (currentPrice - p.entryPrice) / p.entryPrice * 100;
      let pnl = MARGIN_PER_TRADE * pct * LEVERAGE / 100;
      if (pnl < -MARGIN_PER_TRADE) pnl = -MARGIN_PER_TRADE;
      s += pnl - FEE_PER_SIDE;
    }
    return s;
  }, [open, currentPrice]);

  const equity = account.capital + unrealized;
  const equityRoi = ((equity - INITIAL_CAPITAL) / INITIAL_CAPITAL) * 100;
  const now = Date.now();

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.rootContent}>
      <View style={styles.headerRow}>
        <Text style={styles.h1}>📊 15m ALL · LONG MỌI NẾN · $1,000 PAPER</Text>
        <TouchableOpacity onPress={handleReset} style={styles.resetBtn}>
          <Text style={styles.resetBtnText}>RESET</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.subtitle}>
        Strategy: mỗi nến 15m đóng → chờ 5m StochRSI K&lt;{STOCH_OS_LEVEL} (max 7 phút) → LONG 30U×{LEVERAGE}x · TP +{TP_PCT}% / SL -{SL_PCT}% · fee ${FEE_PER_TRADE.toFixed(0)}/lệnh
      </Text>

      {/* KPI grid */}
      <View style={styles.kpiGrid}>
        <Kpi label="CAPITAL" value={fmtUsd(account.capital)} color={P.text} />
        <Kpi label="EQUITY" value={fmtUsd(equity)} color={equity >= INITIAL_CAPITAL ? P.green : P.error} />
        <Kpi label="ROI" value={fmtPct(equityRoi)} color={equityRoi >= 0 ? P.green : P.error} />
        <Kpi label="WIN RATE" value={summary.totalClosed > 0 ? `${summary.winRate.toFixed(1)}%` : "—"} color={P.tertiary} />
        <Kpi label="TRADES" value={`${summary.totalClosed}`} color={P.text} sub={`${summary.wins}W · ${summary.losses}L`} />
        <Kpi label="OPEN / PEND" value={`${summary.openCount} / ${summary.pendingCount}`} color={P.primaryContainer} sub={`free $${summary.freeMargin.toFixed(0)}`} />
      </View>

      {/* Equity curve */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>📈 EQUITY CURVE (từ lệnh đầu tiên đóng)</Text>
        <EquityCurveSvg data={account.equityHistory} />
      </View>

      {/* PENDING list */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>⏳ PENDING ({pending.length}) · stoch5m K = {stoch5mK !== null ? stoch5mK.toFixed(1) : "—"}</Text>
        {pending.length === 0
          ? <Text style={styles.empty}>không có pending — chờ nến 15m mới đóng</Text>
          : pending.slice(0, 10).map((p) => {
              const remain = p.pendingDeadlineMs - now;
              const pctBar = Math.max(0, Math.min(1, remain / PENDING_TIMEOUT_MS));
              return (
                <View key={p.id} style={styles.row}>
                  <Text style={[styles.cellW, { color: P.tertiary }]}>{fmtTime(p.bar15mTime)}</Text>
                  <Text style={[styles.cellW, { color: P.dim }]}>trig ${p.triggerPrice.toFixed(0)}</Text>
                  <View style={styles.barBox}>
                    <View style={[styles.barFill, { width: `${pctBar * 100}%`, backgroundColor: pctBar > 0.3 ? P.tertiary : P.error }]} />
                  </View>
                  <Text style={[styles.cellNarrow, { color: remain > 0 ? P.text : P.error, textAlign: "right" }]}>{fmtCountdown(remain)}</Text>
                </View>
              );
            })}
      </View>

      {/* OPEN list */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>🟢 OPEN ({open.length}) · uPnL: <Text style={{ color: unrealized >= 0 ? P.green : P.error }}>{fmtUsd(unrealized, true)}</Text></Text>
        {open.length === 0
          ? <Text style={styles.empty}>chưa có lệnh nào đang mở</Text>
          : open.slice(0, 20).map((p) => {
              if (!p.entryPrice) return null;
              const upnlPct = currentPrice !== null
                ? (currentPrice - p.entryPrice) / p.entryPrice * 100 * LEVERAGE
                : 0;
              const grossUsd = currentPrice !== null
                ? Math.max(-MARGIN_PER_TRADE, MARGIN_PER_TRADE * (currentPrice - p.entryPrice) / p.entryPrice * LEVERAGE)
                : 0;
              // NET = gross − exit fee (entry fee đã trừ rồi)
              const upnlUsd = grossUsd - FEE_PER_SIDE;
              const color = upnlUsd >= 0 ? P.green : P.error;
              return (
                <View key={p.id} style={styles.row}>
                  <Text style={[styles.cellW, { color: P.tertiary }]}>{fmtTime(p.entryMs!)}</Text>
                  <Text style={[styles.cellW, { color: P.dim, fontSize: 10 }]}>{p.entryMode === "stoch_dep" ? "stoch" : "force"}</Text>
                  <Text style={[styles.cellW, { color: P.text }]}>${p.entryPrice.toFixed(0)}</Text>
                  <Text style={[styles.cellW, { color: P.green, fontSize: 10 }]}>TP ${p.tpPrice!.toFixed(0)}</Text>
                  <Text style={[styles.cellW, { color: P.error, fontSize: 10 }]}>SL ${p.slPrice!.toFixed(0)}</Text>
                  <Text style={[styles.cellW, { color: P.dim, fontSize: 10 }]}>fee -${(p.entryFeeUsd ?? FEE_PER_SIDE).toFixed(2)}</Text>
                  <Text style={[styles.cellNarrow, { color, textAlign: "right" }]}>{fmtUsd(upnlUsd, true)}</Text>
                  <Text style={[styles.cellNarrow, { color, textAlign: "right", fontSize: 10 }]}>{fmtPct(upnlPct)}</Text>
                </View>
              );
            })}
      </View>

      {/* CLOSED history */}
      <View style={styles.section}>
        <View style={styles.filterRow}>
          <Text style={styles.sectionTitle}>📜 CLOSED ({closedAll.length})</Text>
          <View style={{ flexDirection: "row", gap: 6 }}>
            {(["ALL", "WIN", "LOSS"] as Filter[]).map((f) => (
              <TouchableOpacity key={f} onPress={() => setFilter(f)} style={[styles.filterBtn, filter === f && styles.filterBtnActive]}>
                <Text style={[styles.filterBtnText, filter === f && styles.filterBtnTextActive]}>{f}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
        {closed.length === 0
          ? <Text style={styles.empty}>chưa có lệnh đóng</Text>
          : closed.slice(0, 30).map((p) => {
              const color = p.status === "WIN" ? P.green : P.error;
              return (
                <View key={p.id} style={styles.row}>
                  <Text style={[styles.cellW, { color: P.dim, fontSize: 10 }]}>{fmtTime(p.exitMs!)}</Text>
                  <Text style={[styles.cellNarrow, { color, fontWeight: "700" }]}>{p.status}</Text>
                  <Text style={[styles.cellW, { color: P.dim, fontSize: 10 }]}>{p.entryMode === "stoch_dep" ? "stoch" : "force"}</Text>
                  <Text style={[styles.cellW, { color: P.text }]}>${p.entryPrice!.toFixed(0)} → ${p.exitPrice!.toFixed(0)}</Text>
                  <Text style={[styles.cellW, { color: P.dim, fontSize: 10 }]}>fee -${(((p.entryFeeUsd ?? FEE_PER_SIDE) + (p.exitFeeUsd ?? FEE_PER_SIDE))).toFixed(2)}</Text>
                  <Text style={[styles.cellNarrow, { color, textAlign: "right" }]}>{fmtUsd(p.pnlNetUsd ?? p.pnlUsd!, true)}</Text>
                </View>
              );
            })}
      </View>
    </ScrollView>
  );
}

function Kpi({ label, value, color, sub }: { label: string; value: string; color: string; sub?: string }) {
  return (
    <View style={styles.kpi}>
      <Text style={styles.kpiLabel}>{label}</Text>
      <Text style={[styles.kpiValue, { color }]}>{value}</Text>
      {sub ? <Text style={styles.kpiSub}>{sub}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: P.bg },
  rootContent: { padding: 16, paddingBottom: 80 },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 },
  h1: { color: P.primary, fontSize: 16, fontWeight: "700", letterSpacing: 1.5, fontFamily: "SpaceGrotesk_700Bold" },
  subtitle: { color: P.dim, fontSize: 11, marginBottom: 14, fontFamily: "Inter_400Regular" },
  resetBtn: { backgroundColor: P.errorContainer, paddingHorizontal: 14, paddingVertical: 6, borderRadius: 2 },
  resetBtnText: { color: P.onErrorContainer, fontSize: 11, fontWeight: "700", letterSpacing: 1 },
  kpiGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 16 },
  kpi: { flex: 1, minWidth: 110, backgroundColor: P.card, borderLeftWidth: 3, borderLeftColor: P.primaryContainer, padding: 10, borderRadius: 2 },
  kpiLabel: { color: P.dim, fontSize: 9, letterSpacing: 1, fontFamily: "JetBrainsMono_500Medium" },
  kpiValue: { fontSize: 18, fontWeight: "800", marginTop: 4, fontFamily: "JetBrainsMono_700Bold" },
  kpiSub: { color: P.dim, fontSize: 9, marginTop: 2, fontFamily: "JetBrainsMono_500Medium" },
  section: { backgroundColor: P.card, borderRadius: 4, padding: 12, marginBottom: 10 },
  sectionTitle: { color: P.text2, fontSize: 11, fontWeight: "700", letterSpacing: 1.2, marginBottom: 8, fontFamily: "SpaceGrotesk_700Bold" },
  filterRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  filterBtn: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 2, backgroundColor: P.surface },
  filterBtnActive: { backgroundColor: P.primaryContainer },
  filterBtnText: { color: P.dim, fontSize: 10, fontWeight: "700", letterSpacing: 0.8 },
  filterBtnTextActive: { color: P.onPrimary },
  empty: { color: P.dim, fontSize: 11, fontStyle: "italic", paddingVertical: 8 },
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: P.borderSoft, gap: 8 },
  cellW: { color: P.text, fontSize: 11, fontFamily: "JetBrainsMono_500Medium", width: 78 },
  cellNarrow: { color: P.text, fontSize: 11, fontFamily: "JetBrainsMono_700Bold", width: 70 },
  barBox: { flex: 1, height: 6, backgroundColor: P.surface, borderRadius: 1, overflow: "hidden" },
  barFill: { height: "100%" },
  chartBox: { backgroundColor: P.surface, borderRadius: 2, borderWidth: 1, borderColor: P.borderSoft },
  chartEmpty: { color: P.dim, fontSize: 11, fontStyle: "italic" },
});
