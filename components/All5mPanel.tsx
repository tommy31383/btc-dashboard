/**
 * All5mPanel — full-screen panel cho tab "5m All".
 *
 * Strategy: mỗi 5m closed → quyết định LONG/SHORT theo StochRSI K (LONG K<10,
 * SHORT K>90), fallback S/R 15m. TP+4%/SL-2%. Cooldown 15m sau entry.
 */
import React, { useMemo, useState } from "react";
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from "react-native";
import Svg, { Polyline, Line } from "react-native-svg";
import { P } from "../utils/v2Theme";
import {
  All5mAccount, AccountSummary, Position,
  INITIAL_CAPITAL, MARGIN_PER_TRADE, LEVERAGE,
  TP_PCT, SL_PCT, STOCH_LONG_LEVEL, STOCH_SHORT_LEVEL, COOLDOWN_MS, FEE_PER_SIDE,
} from "../utils/all5mAccount";

interface Props {
  account: All5mAccount;
  summary: AccountSummary;
  currentPrice: number | null;
  stoch5mK: number | null;
  onReset: () => Promise<void> | void;
  /** Optional content rendered at bottom of the scroll (vd PaperTradeJournal) */
  footer?: React.ReactNode;
}

type Filter = "ALL" | "WIN" | "LOSS";

function fmtUsd(n: number, sign = false) { return (sign && n > 0 ? "+" : "") + "$" + n.toFixed(2); }
function fmtPct(n: number, sign = true) { return (sign && n > 0 ? "+" : "") + n.toFixed(2) + "%"; }
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
    <View style={{ width, height, backgroundColor: P.surface, borderRadius: 2, borderWidth: 1, borderColor: P.borderSoft }}>
      <Svg width={width} height={height}>
        <Line x1={0} y1={yInitial} x2={width} y2={yInitial} stroke={P.dim} strokeWidth={0.6} strokeDasharray="3,3" />
        <Polyline points={pts} fill="none" stroke={color} strokeWidth={2} />
      </Svg>
    </View>
  );
}

export default function All5mPanel({ account, summary, currentPrice, stoch5mK, onReset, footer }: Props) {
  const [filter, setFilter] = useState<Filter>("ALL");

  const handleReset = () => {
    if (typeof window !== "undefined") {
      const ok = window.confirm(
        `RESET 5m All account?\n\nXoá tất cả lệnh, capital về $${INITIAL_CAPITAL}.\n\nKhông thể undo.`
      );
      if (!ok) return;
    }
    Promise.resolve(onReset());
  };

  const open = account.positions.filter((p) => p.status === "OPEN");
  const closedAll = account.positions.filter((p) => p.status === "WIN" || p.status === "LOSS");
  const closed = filter === "ALL" ? closedAll : closedAll.filter((p) => p.status === filter);

  const unrealized = useMemo(() => {
    if (currentPrice === null) return 0;
    let s = 0;
    for (const p of open) {
      const pct = p.side === "LONG"
        ? (currentPrice - p.entryPrice) / p.entryPrice * 100
        : (p.entryPrice - currentPrice) / p.entryPrice * 100;
      let pnl = MARGIN_PER_TRADE * pct * LEVERAGE / 100;
      if (pnl < -MARGIN_PER_TRADE) pnl = -MARGIN_PER_TRADE;
      s += pnl - FEE_PER_SIDE;
    }
    return s;
  }, [open, currentPrice]);

  const equity = account.capital + unrealized;
  const equityRoi = ((equity - INITIAL_CAPITAL) / INITIAL_CAPITAL) * 100;

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.rootContent}>
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.h1}>⚡ 5m ALL — STOCH + S/R</Text>
          <Text style={styles.subtitle}>
            5m closed → K&lt;{STOCH_LONG_LEVEL} LONG · K&gt;{STOCH_SHORT_LEVEL} SHORT · else S/R 15m fallback ·
            TP +{TP_PCT}% / SL -{SL_PCT}% · cooldown {COOLDOWN_MS / 60000}m · margin ${MARGIN_PER_TRADE} × {LEVERAGE}x · fee ${FEE_PER_SIDE.toFixed(2)}/side
          </Text>
        </View>
        <TouchableOpacity onPress={handleReset} style={styles.resetBtn}>
          <Text style={styles.resetBtnText}>🗑 RESET</Text>
        </TouchableOpacity>
      </View>

      {/* KPI */}
      <View style={styles.kpiGrid}>
        <Kpi label="CAPITAL" value={fmtUsd(account.capital)} color={P.text} />
        <Kpi label="EQUITY" value={fmtUsd(equity)} color={equity >= INITIAL_CAPITAL ? P.green : P.error} sub={`uPnL ${fmtUsd(unrealized, true)}`} />
        <Kpi label="ROI" value={`${equityRoi >= 0 ? "+" : ""}${equityRoi.toFixed(2)}%`} color={equityRoi >= 0 ? P.green : P.error} />
        <Kpi label="WIN RATE" value={summary.totalClosed > 0 ? `${summary.winRate.toFixed(1)}%` : "—"} color={P.tertiary} />
        <Kpi label="TRADES" value={`${summary.totalClosed}`} color={P.text} sub={`${summary.wins}W · ${summary.losses}L`} />
        <Kpi label="OPEN" value={`${summary.openCount}`} color={P.primaryContainer} sub={`free $${summary.freeMargin.toFixed(0)}`} />
      </View>

      {/* Cooldown banner */}
      {summary.cooldownRemainMs > 0 && (
        <View style={styles.cdBanner}>
          <Text style={styles.cdBannerText}>
            ⏸ COOLDOWN — kế tiếp sau {fmtCountdown(summary.cooldownRemainMs)} · stoch5m K = {stoch5mK !== null ? stoch5mK.toFixed(1) : "—"}
          </Text>
        </View>
      )}

      {/* Equity curve */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>📈 EQUITY ({account.equityHistory.length} pts)</Text>
        <EquityCurveSvg data={account.equityHistory} />
      </View>

      {/* OPEN list */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>🟢 OPEN ({open.length}) · uPnL: <Text style={{ color: unrealized >= 0 ? P.green : P.error }}>{fmtUsd(unrealized, true)}</Text></Text>
        {open.length === 0
          ? <Text style={styles.empty}>chưa có lệnh nào đang mở</Text>
          : open.slice(0, 30).map((p) => {
              const upnlPct = currentPrice !== null
                ? (p.side === "LONG" ? (currentPrice - p.entryPrice) : (p.entryPrice - currentPrice)) / p.entryPrice * 100 * LEVERAGE
                : 0;
              const grossUsd = currentPrice !== null
                ? Math.max(-MARGIN_PER_TRADE, MARGIN_PER_TRADE * upnlPct / LEVERAGE * LEVERAGE / 100)
                : 0;
              const upnlUsd = grossUsd - FEE_PER_SIDE;
              const color = upnlUsd >= 0 ? P.green : P.error;
              const sideColor = p.side === "LONG" ? P.green : P.error;
              return (
                <View key={p.id} style={styles.row}>
                  <Text style={[styles.cellW, { color: P.tertiary }]}>{fmtTime(p.entryMs)}</Text>
                  <Text style={[styles.cellNarrow, { color: sideColor, fontWeight: "700" }]}>{p.side}</Text>
                  <Text style={[styles.cellW, { color: P.dim, fontSize: 10 }]}>{p.source.replace("_", " ")}</Text>
                  <Text style={[styles.cellW, { color: P.text }]}>${p.entryPrice.toFixed(0)}</Text>
                  <Text style={[styles.cellW, { color: P.green, fontSize: 10 }]}>TP ${p.tpPrice.toFixed(0)}</Text>
                  <Text style={[styles.cellW, { color: P.error, fontSize: 10 }]}>SL ${p.slPrice.toFixed(0)}</Text>
                  <Text style={[styles.cellW, { color: P.dim, fontSize: 10 }]}>fee -${p.entryFeeUsd.toFixed(2)}</Text>
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
          : closed.slice(0, 50).map((p) => {
              const color = p.status === "WIN" ? P.green : P.error;
              const sideColor = p.side === "LONG" ? P.green : P.error;
              return (
                <View key={p.id} style={styles.row}>
                  <Text style={[styles.cellW, { color: P.dim, fontSize: 10 }]}>{fmtTime(p.exitMs!)}</Text>
                  <Text style={[styles.cellNarrow, { color, fontWeight: "700" }]}>{p.status}</Text>
                  <Text style={[styles.cellNarrow, { color: sideColor, fontWeight: "700" }]}>{p.side}</Text>
                  <Text style={[styles.cellW, { color: P.dim, fontSize: 10 }]}>{p.source.replace("_", " ")}</Text>
                  <Text style={[styles.cellW, { color: P.text }]}>${p.entryPrice.toFixed(0)} → ${p.exitPrice!.toFixed(0)}</Text>
                  <Text style={[styles.cellW, { color: P.dim, fontSize: 10 }]}>fee -${(p.entryFeeUsd + (p.exitFeeUsd ?? FEE_PER_SIDE)).toFixed(2)}</Text>
                  <Text style={[styles.cellNarrow, { color, textAlign: "right" }]}>{fmtUsd(p.pnlNetUsd ?? p.pnlUsd!, true)}</Text>
                </View>
              );
            })}
      </View>
      {footer ? <View style={{ marginTop: 16 }}>{footer}</View> : null}
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
  kpi: { flexBasis: "15%", flexGrow: 1, backgroundColor: P.surface, borderColor: P.borderSoft, borderWidth: 1, borderRadius: 4, padding: 10, minWidth: 130 },
  kpiLabel: { color: P.dim, fontSize: 9, letterSpacing: 1.2, fontFamily: "JetBrainsMono_500Medium" },
  kpiValue: { fontSize: 18, fontWeight: "800", marginTop: 4, fontFamily: "JetBrainsMono_700Bold" },
  kpiSub: { color: P.dim, fontSize: 10, marginTop: 2, fontFamily: "JetBrainsMono_400Regular" },
  cdBanner: { backgroundColor: P.tertiaryContainer, padding: 10, borderRadius: 4, marginBottom: 12 },
  cdBannerText: { color: P.onTertiaryContainer, fontSize: 12, textAlign: "center", fontFamily: "JetBrainsMono_500Medium" },
  section: { marginBottom: 18 },
  sectionTitle: { color: P.text, fontSize: 13, fontWeight: "700", marginBottom: 8, letterSpacing: 0.4 },
  empty: { color: P.dim, fontStyle: "italic", paddingVertical: 8, fontSize: 12 },
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 5, borderBottomColor: P.borderSoft, borderBottomWidth: 1, gap: 10 },
  cellW: { flexBasis: 110, flexShrink: 0, fontFamily: "JetBrainsMono_500Medium", fontSize: 11 },
  cellNarrow: { flexBasis: 70, flexShrink: 0, fontFamily: "JetBrainsMono_500Medium", fontSize: 11 },
  filterRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  filterBtn: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 2, borderWidth: 1, borderColor: P.borderSoft },
  filterBtnActive: { backgroundColor: P.primaryContainer, borderColor: P.primaryContainer },
  filterBtnText: { color: P.dim, fontSize: 10, letterSpacing: 1, fontFamily: "JetBrainsMono_500Medium" },
  filterBtnTextActive: { color: P.onPrimaryContainer, fontWeight: "700" },
  chartBox: { backgroundColor: P.surface, borderRadius: 2, borderWidth: 1, borderColor: P.borderSoft },
  chartEmpty: { color: P.dim, fontSize: 12, fontStyle: "italic" },
});
