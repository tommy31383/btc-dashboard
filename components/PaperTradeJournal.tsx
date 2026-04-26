/**
 * PaperTradeJournal — hiển thị paper-trade journal + calibration health.
 * Default collapsed (giống TradingRulesPanel) để không chiếm chỗ.
 */
import React, { useMemo, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from "react-native";
import { P, alpha } from "../utils/v2Theme";
import { PaperTrade, PaperTradeSummary } from "../utils/paperTrader";
import { CalibStats, classifyRuleHealth, MIN_RESOLVED_FOR_WARN } from "../utils/calibration";
import DebugLabel from "./DebugLabel";

interface Props {
  trades: PaperTrade[];
  summary: PaperTradeSummary;
  stats: CalibStats;
  pendingCount: number;
}

export default function PaperTradeJournal({ trades, summary, stats, pendingCount }: Props) {
  const [collapsed, setCollapsed] = useState(true);

  const recent = useMemo(() => {
    return [...trades].sort((a, b) => (b.openedMs - a.openedMs)).slice(0, 20);
  }, [trades]);

  // Δ prev = openedMs[i] - openedMs[i+1] (mảng đã sort desc theo openedMs)
  const recentWithDelta = useMemo(() => {
    return recent.map((t, i) => {
      const prev = recent[i + 1];
      const deltaMs = prev ? t.openedMs - prev.openedMs : null;
      return { trade: t, deltaMs };
    });
  }, [recent]);

  const ruleHealthRows = useMemo(() => {
    const rows = Object.entries(stats.rules)
      .map(([ruleId, s]) => ({
        ruleId,
        n: s.n,
        hitRate: s.hitRate,
        avgRet: s.avgReturn,
        health: classifyRuleHealth(s),
      }))
      .filter((r) => r.n >= MIN_RESOLVED_FOR_WARN)
      .sort((a, b) => a.hitRate - b.hitRate);
    return rows;
  }, [stats]);

  const pnlColor = summary.totalPnlPct >= 0 ? P.green : P.error;

  return (
    <View style={styles.card}>
      <DebugLabel name="PaperTradeJournal" />
      <TouchableOpacity onPress={() => setCollapsed((v) => !v)} style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>📓 PAPER JOURNAL · LEARNER</Text>
          <Text style={styles.subtitle}>
            {summary.total} lệnh · OPEN {summary.open} · WR {summary.winRate}% · PnL{" "}
            <Text style={{ color: pnlColor, fontWeight: "700" }}>
              {summary.totalPnlPct >= 0 ? "+" : ""}{summary.totalPnlPct}%
            </Text>{" "}
            · Pending {pendingCount}
          </Text>
        </View>
        <Text style={styles.chevron}>{collapsed ? "▾" : "▴"}</Text>
      </TouchableOpacity>

      {!collapsed && (
        <View style={styles.body}>
          <View style={styles.statsRow}>
            <Stat label="WIN" value={String(summary.wins)} color={P.green} />
            <Stat label="LOSS" value={String(summary.losses)} color={P.error} />
            <Stat label="TIMEOUT" value={String(summary.timeouts)} color={P.dim} />
            <Stat label="BEST" value={`${summary.bestTradePct >= 0 ? "+" : ""}${summary.bestTradePct}%`} color={P.green} />
            <Stat label="WORST" value={`${summary.worstTradePct >= 0 ? "+" : ""}${summary.worstTradePct}%`} color={P.error} />
          </View>

          {ruleHealthRows.length > 0 && (
            <>
              <Text style={styles.sectionTitle}>🩺 RULE HEALTH (live calibration)</Text>
              <ScrollView style={{ maxHeight: 160 }} nestedScrollEnabled>
                {ruleHealthRows.map((r) => (
                  <View key={r.ruleId} style={styles.healthRow}>
                    <Text style={[styles.dot, { color: healthColor(r.health) }]}>●</Text>
                    <Text style={styles.healthRuleId}>{r.ruleId}</Text>
                    <Text style={styles.healthCell}>n={r.n}</Text>
                    <Text style={[styles.healthCell, { color: healthColor(r.health), fontWeight: "700" }]}>
                      WR {(r.hitRate * 100).toFixed(0)}%
                    </Text>
                    <Text style={[styles.healthCell, { color: r.avgRet >= 0 ? P.green : P.error }]}>
                      μ {(r.avgRet * 100).toFixed(2)}%
                    </Text>
                  </View>
                ))}
              </ScrollView>
            </>
          )}

          <Text style={styles.sectionTitle}>📜 LẦN LỆNH GẦN ĐÂY</Text>
          {recent.length === 0 ? (
            <Text style={styles.empty}>
              Chưa có lệnh. App sẽ tự ghi lại khi có rule FIRE.
            </Text>
          ) : (
            <ScrollView style={{ maxHeight: 320 }} nestedScrollEnabled>
              {recentWithDelta.map(({ trade, deltaMs }) => (
                <TradeRow key={trade.id} t={trade} deltaMs={deltaMs} />
              ))}
            </ScrollView>
          )}
        </View>
      )}
    </View>
  );
}

function healthColor(h: ReturnType<typeof classifyRuleHealth>): string {
  if (h === "ok") return P.green;
  if (h === "warn") return P.primaryContainer;
  if (h === "bad") return P.error;
  return P.dim;
}

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, { color }]}>{value}</Text>
    </View>
  );
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

function fmtPrice(p: number): string {
  return "$" + p.toFixed(0);
}

function TradeRow({ t, deltaMs }: { t: PaperTrade; deltaMs: number | null }) {
  const [expanded, setExpanded] = useState(false);
  const sideColor = t.side === "LONG" ? P.green : P.error;
  const statusColor =
    t.status === "WIN" ? P.green :
    t.status === "LOSS" ? P.error :
    t.status === "TIMEOUT" ? P.dim :
    P.primaryContainer;
  const pnl = t.leveragedPnlPct ?? 0;
  const now = Date.now();
  const ageMs = (t.closedMs ?? now) - t.openedMs;
  // Cột "Time": OPEN → "OPEN +Xm" / closed → "HH:mm"
  const timeText =
    t.status === "OPEN"
      ? `OPEN +${fmtDuration(now - t.openedMs)}`
      : fmtTime(t.closedMs ?? t.openedMs);
  const deltaText = deltaMs !== null ? `+${fmtDuration(deltaMs)}` : "—";

  return (
    <TouchableOpacity onPress={() => setExpanded((v) => !v)} activeOpacity={0.7}>
      <View style={styles.tradeRow}>
        <Text style={[styles.tradeCell, { color: P.dim, width: 90 }]} numberOfLines={1}>
          {t.ruleId}
        </Text>
        <Text style={[styles.tradeCell, { color: sideColor, width: 44, fontWeight: "700" }]}>{t.side}</Text>
        <Text style={[styles.tradeCell, { color: statusColor, width: 60, fontWeight: "700" }]}>{t.status}</Text>
        <Text style={[styles.tradeCell, { color: P.dim, width: 86 }]} numberOfLines={1}>
          {timeText}
        </Text>
        <Text style={[styles.tradeCell, { color: P.dim, width: 56 }]} numberOfLines={1}>
          Δ {deltaText}
        </Text>
        <Text style={[styles.tradeCell, { color: pnl >= 0 ? P.green : P.error, flex: 1, textAlign: "right" }]}>
          {t.status === "OPEN" ? "—" : `${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}%`}
        </Text>
      </View>
      {expanded && (
        <View style={styles.tradeDetail}>
          <Text style={styles.detailLine}>
            Entry {fmtPrice(t.entryPrice)} → {t.exitPrice ? `Exit ${fmtPrice(t.exitPrice)}` : "—"}
            {"   "}TP {fmtPrice(t.tpPrice)} / SL {fmtPrice(t.slPrice)}
          </Text>
          <Text style={styles.detailLine}>
            Open {fmtTime(t.openedMs)}
            {t.closedMs ? `  →  Close ${fmtTime(t.closedMs)}` : `  (đang chạy ${fmtDuration(now - t.openedMs)})`}
            {"   "}Hold {fmtDuration(ageMs)}
          </Text>
          <Text style={styles.detailLine}>
            Lev {t.leverage}x · TP {t.targetPct}% · SL {t.stopPct}% · maxHold {t.maxHoldBars} bars
          </Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: P.card,
    borderWidth: 1,
    borderColor: P.border,
    borderLeftWidth: 4,
    borderLeftColor: P.primaryContainer,
    borderRadius: 2,
    marginBottom: 12,
  },
  header: { flexDirection: "row", alignItems: "center", padding: 12 },
  title: { color: P.primary, fontFamily: "monospace", fontSize: 12, fontWeight: "900", letterSpacing: 1 },
  subtitle: { color: P.dim, fontFamily: "monospace", fontSize: 10, marginTop: 4 },
  chevron: { color: P.dim, fontSize: 18, paddingHorizontal: 8 },
  body: { paddingHorizontal: 12, paddingBottom: 12, borderTopWidth: 1, borderTopColor: P.borderSoft },
  statsRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 12 },
  stat: { alignItems: "center", flex: 1 },
  statLabel: { color: P.dim, fontFamily: "monospace", fontSize: 9, letterSpacing: 1 },
  statValue: { fontFamily: "monospace", fontSize: 13, fontWeight: "700", marginTop: 2 },
  sectionTitle: { color: P.text2, fontFamily: "monospace", fontSize: 10, fontWeight: "700", letterSpacing: 1, marginTop: 14, marginBottom: 6 },
  empty: { color: P.dim, fontFamily: "monospace", fontSize: 10, fontStyle: "italic", paddingVertical: 8 },
  tradeRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: alpha(P.borderSoft, 0.5),
  },
  tradeCell: { fontFamily: "monospace", fontSize: 10 },
  tradeDetail: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    backgroundColor: alpha(P.borderSoft, 0.25),
    borderBottomWidth: 1,
    borderBottomColor: alpha(P.borderSoft, 0.5),
  },
  detailLine: {
    color: P.text2,
    fontFamily: "monospace",
    fontSize: 10,
    lineHeight: 16,
  },
  healthRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 4,
    gap: 8,
  },
  dot: { fontSize: 12 },
  healthRuleId: { color: P.text, fontFamily: "monospace", fontSize: 10, width: 90 },
  healthCell: { color: P.text2, fontFamily: "monospace", fontSize: 10, width: 70 },
});
