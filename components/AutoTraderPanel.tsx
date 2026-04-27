/**
 * AutoTraderPanel — KPI + danh sách lệnh đang chạy của auto-trader.
 *
 * Hiển thị:
 *   - Capital / Equity / ROI / Win Rate / Tổng số lệnh đã đóng
 *   - PENDING (đang chờ limit fill, hiện limit price + ETA hết hạn)
 *   - OPEN (đã fill, hiện entry/SL/TP/uPnL)
 *   - Nút RESET (xác nhận trước khi xoá)
 *
 * Default collapsed.
 */
import React, { useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { P } from "../utils/v2Theme";
import DebugLabel from "./DebugLabel";
import {
  AutoAccount,
  AutoPosition,
  INITIAL_CAPITAL_USD,
  MARGIN_PER_TRADE_USD,
  NOTIONAL_USD,
  summarize,
} from "../utils/autoAccount";
import { getHardRulesForTF, HardRule } from "../utils/hardRules";

/** Lookup HardRule by ruleId "tfKey:rank" — return null if not found */
function findRuleInfo(ruleId: string, tfKey: string): HardRule | null {
  const parts = ruleId.split(":");
  const rankStr = parts[parts.length - 1];
  const rank = Number(rankStr);
  if (!Number.isFinite(rank)) return null;
  const rules = getHardRulesForTF(tfKey);
  return rules.find((r) => r.rank === rank) ?? null;
}

interface Props {
  account: AutoAccount;
  summary: ReturnType<typeof summarize>;
  currentPrice: number | null;
  onReset: () => Promise<void> | void;
}

function AutoTraderPanelInner({ account, summary, currentPrice, onReset }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [showSpec, setShowSpec] = useState(false);
  const [showRuleInfo, setShowRuleInfo] = useState(false);

  const handleReset = () => {
    if (typeof window !== "undefined") {
      const ok = window.confirm(
        "RESET auto account?\n\n" +
        "Sẽ xoá TẤT CẢ lệnh (pending/open/closed), reset capital về " +
        `$${INITIAL_CAPITAL_USD}, push lên server.\n\n` +
        "Không thể undo."
      );
      if (!ok) return;
    }
    Promise.resolve(onReset());
  };

  // Unrealized PnL từ open positions (theo currentPrice)
  let unrealized = 0;
  if (currentPrice !== null && currentPrice > 0) {
    for (const p of summary.open) {
      if (!p.entryPrice) continue;
      const pct = p.side === "LONG"
        ? (currentPrice - p.entryPrice) / p.entryPrice * 100
        : (p.entryPrice - currentPrice) / p.entryPrice * 100;
      unrealized += pct * p.notionalUsd / 100;
    }
  }
  const equity = account.capitalUsd + unrealized;
  const equityRoi = (equity - INITIAL_CAPITAL_USD) / INITIAL_CAPITAL_USD * 100;

  const pnlColor = (v: number) => (v > 0 ? P.green : v < 0 ? P.error : P.dim);

  return (
    <View style={styles.card}>
      <DebugLabel name="AutoTraderPanel" />
      <TouchableOpacity onPress={() => setCollapsed((v) => !v)} style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>🤖 AUTO TRADER · LIVE</Text>
          <Text style={styles.subtitle}>
            Cap ${account.capitalUsd.toFixed(0)} · Equity ${equity.toFixed(0)}
            {"  "}· {summary.open.length} open · {summary.pending.length} pending
            {"  "}· {account.stats.totalTrades} done
          </Text>
        </View>
        <Text style={styles.chevron}>{collapsed ? "▾" : "▴"}</Text>
      </TouchableOpacity>

      {!collapsed && (
        <View style={styles.body}>
          {/* KPI grid */}
          <View style={styles.kpiRow}>
            <Kpi label="CAPITAL" value={`$${account.capitalUsd.toFixed(0)}`} sub="realized" />
            <Kpi
              label="EQUITY"
              value={`$${equity.toFixed(0)}`}
              sub={`${equityRoi >= 0 ? "+" : ""}${equityRoi.toFixed(2)}%`}
              color={pnlColor(equityRoi)}
            />
            <Kpi
              label="ROI"
              value={`${summary.roi >= 0 ? "+" : ""}${summary.roi.toFixed(1)}%`}
              sub={`PnL $${account.stats.totalPnLUsd.toFixed(0)}`}
              color={pnlColor(summary.roi)}
            />
          </View>
          <View style={styles.kpiRow}>
            <Kpi
              label="WIN RATE"
              value={`${summary.winRate.toFixed(0)}%`}
              sub={`${account.stats.wins}W ${account.stats.losses}L ${account.stats.timeouts}T`}
              color={summary.winRate >= 50 ? P.green : P.error}
            />
            <Kpi
              label="TRADES"
              value={String(account.stats.totalTrades)}
              sub={`open ${summary.open.length} · pend ${summary.pending.length}`}
            />
            <Kpi
              label="MARGIN"
              value={`$${summary.usedMargin.toFixed(0)}`}
              sub={`/ $${account.capitalUsd.toFixed(0)} · lev 100x`}
            />
          </View>

          {/* Toggle: show rule info per row */}
          {(summary.pending.length > 0 || summary.open.length > 0) && (
            <TouchableOpacity onPress={() => setShowRuleInfo((v) => !v)} style={styles.ruleInfoToggle}>
              <Text style={styles.ruleInfoToggleText}>
                {showRuleInfo ? "▴ HIDE RULE INFO" : "▾ SHOW RULE INFO (WR/PF/NET/trend)"}
              </Text>
            </TouchableOpacity>
          )}

          {/* Pending positions */}
          {summary.pending.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>⏳ PENDING ({summary.pending.length})</Text>
              {summary.pending.map((p) => (
                <PendingRow key={p.id} p={p} currentPrice={currentPrice} showRuleInfo={showRuleInfo} />
              ))}
            </View>
          )}

          {/* Open positions */}
          {summary.open.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>📈 OPEN ({summary.open.length})</Text>
              {summary.open.map((p) => (
                <OpenRow key={p.id} p={p} currentPrice={currentPrice} showRuleInfo={showRuleInfo} />
              ))}
            </View>
          )}

          {summary.pending.length === 0 && summary.open.length === 0 && (
            <Text style={styles.emptyText}>
              Chưa có lệnh nào. Khi rule fire → auto đặt limit ±0.1% → chờ tối đa 5p → fill.
            </Text>
          )}

          {/* Spec note — collapsible */}
          {showSpec && (
            <Text style={styles.note}>
              Capital ban đầu: <Text style={styles.code}>${INITIAL_CAPITAL_USD}</Text>
              {" · "}Margin/lệnh: <Text style={styles.code}>${MARGIN_PER_TRADE_USD}</Text>
              {" · "}Notional: <Text style={styles.code}>${NOTIONAL_USD}</Text>
              {"\n"}Limit ±0.1% · auto fill nếu hết 5p · no limit concurrent (chỉ giới hạn margin)
            </Text>
          )}
          <TouchableOpacity onPress={() => setShowSpec((v) => !v)} style={styles.specToggle}>
            <Text style={styles.specToggleText}>{showSpec ? "▴ ẩn spec" : "▾ xem spec"}</Text>
          </TouchableOpacity>

          {/* Reset button */}
          <TouchableOpacity onPress={handleReset} style={styles.resetBtn}>
            <Text style={styles.resetText}>🗑 RESET ACCOUNT (xoá hết · cap → $1000)</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
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

function PendingRow({ p, currentPrice, showRuleInfo }: { p: AutoPosition; currentPrice: number | null; showRuleInfo: boolean }) {
  const remainingMs = Math.max(0, p.limitExpiresMs - Date.now());
  const remainingS = Math.ceil(remainingMs / 1000);
  const mm = Math.floor(remainingS / 60);
  const ss = remainingS % 60;
  const expiresIn = remainingMs > 0 ? `${mm}:${String(ss).padStart(2, "0")}` : "expired";

  const distPct = currentPrice && p.limitPrice
    ? Math.abs(currentPrice - p.limitPrice) / p.limitPrice * 100
    : null;

  return (
    <View style={styles.row}>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle}>
          <Text style={[styles.tag, { color: p.side === "LONG" ? P.green : P.error }]}>{p.side}</Text>
          {"  "}{p.tfKey} · {p.ruleId.split(":").slice(-1)[0]}
        </Text>
        <Text style={styles.rowMeta}>
          limit ${p.limitPrice.toFixed(1)} (rule ${p.ruleEntryPrice.toFixed(1)})
          {distPct !== null ? `  · cách ${distPct.toFixed(2)}%` : ""}
        </Text>
        {showRuleInfo && <RuleInfoLine ruleId={p.ruleId} tfKey={p.tfKey} />}
      </View>
      <Text style={[styles.rowRight, { color: remainingMs > 0 ? P.tertiary : P.error }]}>
        ⏱ {expiresIn}
      </Text>
    </View>
  );
}

function OpenRow({ p, currentPrice, showRuleInfo }: { p: AutoPosition; currentPrice: number | null; showRuleInfo: boolean }) {
  if (!p.entryPrice) return null;
  const pricePct = currentPrice
    ? p.side === "LONG"
      ? (currentPrice - p.entryPrice) / p.entryPrice * 100
      : (p.entryPrice - currentPrice) / p.entryPrice * 100
    : 0;
  const upnl = pricePct * p.notionalUsd / 100;
  const upnlColor = upnl > 0 ? P.green : upnl < 0 ? P.error : P.dim;

  return (
    <View style={styles.row}>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle}>
          <Text style={[styles.tag, { color: p.side === "LONG" ? P.green : P.error }]}>{p.side}</Text>
          {"  "}{p.tfKey} · {p.ruleId.split(":").slice(-1)[0]}
        </Text>
        <Text style={styles.rowMeta}>
          entry ${p.entryPrice.toFixed(1)}{"  "}
          SL ${p.slPrice.toFixed(1)}{"  "}
          TP ${p.tpPrice.toFixed(1)}
        </Text>
        {showRuleInfo && <RuleInfoLine ruleId={p.ruleId} tfKey={p.tfKey} />}
      </View>
      <View style={{ alignItems: "flex-end" }}>
        <Text style={[styles.rowRight, { color: upnlColor }]}>
          {upnl >= 0 ? "+" : ""}${upnl.toFixed(1)}
        </Text>
        <Text style={[styles.rowMeta, { color: upnlColor }]}>
          {pricePct >= 0 ? "+" : ""}{pricePct.toFixed(2)}%
        </Text>
      </View>
    </View>
  );
}

/** Backtest stats block — show khi user toggle "SHOW RULE INFO". */
function RuleInfoLine({ ruleId, tfKey }: { ruleId: string; tfKey: string }) {
  const rule = findRuleInfo(ruleId, tfKey);
  if (!rule) {
    return <Text style={styles.ruleInfoLine}>📋 rule {ruleId} không tìm thấy trong hard_rules.json</Text>;
  }
  const s: any = rule.stats || {};
  const wr = s.winRate ?? 0;
  const pf = s.profitFactor ?? 0;
  const trades = s.trades ?? 0;
  const net = s.netPnL ?? 0;
  const trend = (s.equityTrend as "UP" | "FLAT" | "DOWN" | undefined) ?? "FLAT";
  const dd = s.maxDrawdownPct ?? 0;
  const trendIcon = trend === "UP" ? "📈" : trend === "DOWN" ? "📉" : "➖";
  const trendColor = trend === "UP" ? P.green : trend === "DOWN" ? P.error : P.dim;
  const cfg: any = rule.config || {};
  const targetPct = cfg.targetPct ?? 0;
  const stopPct = cfg.stopPct ?? 0;
  return (
    <View style={styles.ruleInfoBox}>
      <Text style={styles.ruleInfoLine}>
        📋 #{rule.rank} · WR <Text style={{ color: wr >= 55 ? P.green : wr >= 40 ? P.bitcoinOrange : P.error }}>{wr.toFixed(0)}%</Text>
        {"  "}· PF <Text style={{ color: pf >= 1.5 ? P.green : pf >= 1 ? P.bitcoinOrange : P.error }}>{pf.toFixed(2)}</Text>
        {"  "}· {trades} trades
      </Text>
      <Text style={styles.ruleInfoLine}>
        NET <Text style={{ color: net >= 0 ? P.green : P.error }}>{net >= 0 ? "+" : ""}{net.toFixed(1)}%</Text>
        {"  "}· DD <Text style={{ color: P.error }}>{dd.toFixed(1)}%</Text>
        {"  "}· trend <Text style={{ color: trendColor }}>{trendIcon} {trend}</Text>
      </Text>
      <Text style={styles.ruleInfoLine}>
        TP raw <Text style={{ color: P.green }}>+{targetPct.toFixed(2)}%</Text>
        {"  "}· SL raw <Text style={{ color: P.error }}>-{stopPct.toFixed(2)}%</Text>
        {"  "}· source {rule.source}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: P.elevated, borderRadius: 2, marginBottom: 10 },
  header: { flexDirection: "row", alignItems: "center", paddingVertical: 12, paddingHorizontal: 14 },
  title: { color: P.text, fontSize: 12, fontWeight: "700", letterSpacing: 1.2, fontFamily: "SpaceGrotesk_700Bold", marginBottom: 3 },
  subtitle: { color: P.dim, fontSize: 10, fontFamily: "JetBrainsMono_500Medium" },
  chevron: { color: P.dim, fontSize: 14, marginLeft: 8 },
  body: { padding: 14, paddingTop: 0, borderTopWidth: 1, borderTopColor: P.highest },
  kpiRow: { flexDirection: "row", gap: 6, marginTop: 10 },
  kpi: { flex: 1, backgroundColor: P.surface, padding: 8, borderRadius: 2, borderWidth: 1, borderColor: P.highest },
  kpiLabel: { color: P.dim, fontSize: 9, fontWeight: "700", letterSpacing: 1, fontFamily: "SpaceGrotesk_700Bold" },
  kpiValue: { color: P.text, fontSize: 16, fontWeight: "700", fontFamily: "JetBrainsMono_700Bold", marginTop: 2 },
  kpiSub: { color: P.dim, fontSize: 9, fontFamily: "JetBrainsMono_500Medium", marginTop: 2 },
  section: { marginTop: 14 },
  sectionTitle: { color: P.text2, fontSize: 11, fontWeight: "700", letterSpacing: 1, fontFamily: "SpaceGrotesk_700Bold", marginBottom: 6 },
  row: {
    flexDirection: "row", alignItems: "center",
    paddingVertical: 8, paddingHorizontal: 10,
    backgroundColor: P.surface, borderRadius: 2, marginBottom: 4,
    borderLeftWidth: 2, borderLeftColor: P.highest,
  },
  rowTitle: { color: P.text, fontSize: 11, fontWeight: "600", fontFamily: "JetBrainsMono_500Medium", marginBottom: 2 },
  rowMeta: { color: P.dim, fontSize: 10, fontFamily: "JetBrainsMono_500Medium" },
  rowRight: { fontSize: 12, fontWeight: "700", fontFamily: "JetBrainsMono_700Bold", marginLeft: 8 },
  tag: { fontWeight: "800", fontSize: 10, letterSpacing: 0.5 },
  emptyText: { color: P.dim, fontSize: 11, lineHeight: 16, fontFamily: "Inter_400Regular", marginTop: 12, fontStyle: "italic" },
  note: { color: P.dim, fontSize: 10, lineHeight: 14, fontFamily: "JetBrainsMono_500Medium", marginTop: 14 },
  specToggle: { alignSelf: "flex-start", paddingVertical: 4, marginTop: 6 },
  specToggleText: { color: P.dim, fontSize: 10, fontFamily: "JetBrainsMono_500Medium", letterSpacing: 0.5 },
  code: { color: P.bitcoinOrange, fontFamily: "JetBrainsMono_700Bold" },
  resetBtn: {
    marginTop: 14, paddingVertical: 10, alignItems: "center",
    borderWidth: 1, borderColor: P.error, borderRadius: 2,
    backgroundColor: P.error + "10",
  },
  resetText: { color: P.error, fontSize: 11, fontWeight: "700", letterSpacing: 0.8, fontFamily: "SpaceGrotesk_700Bold" },
  ruleInfoToggle: { alignSelf: "flex-start", paddingVertical: 6, paddingHorizontal: 10, marginTop: 12, borderWidth: 1, borderColor: P.bitcoinOrange + "55", borderRadius: 2, backgroundColor: P.bitcoinOrange + "12" },
  ruleInfoToggleText: { color: P.bitcoinOrange, fontSize: 10, fontWeight: "700", letterSpacing: 0.8, fontFamily: "JetBrainsMono_700Bold" },
  ruleInfoBox: { marginTop: 4, paddingTop: 4, borderTopWidth: 1, borderTopColor: P.highest, gap: 1 },
  ruleInfoLine: { color: P.dim, fontSize: 9, fontFamily: "JetBrainsMono_500Medium", lineHeight: 12 },
});


const AutoTraderPanel = React.memo(AutoTraderPanelInner);
export default AutoTraderPanel;
