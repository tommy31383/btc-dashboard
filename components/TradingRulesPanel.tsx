import React, { useState, useMemo, useEffect, useRef } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Animated, Easing, Modal } from "react-native";
import Svg, { Polyline, Line } from "react-native-svg";
import { COLORS, TIMEFRAMES } from "../utils/constants";
import { P } from "../utils/v2Theme";
import { getHardRules, hasHardRules, HardRule, isRuleMonitorable } from "../utils/hardRules";
import { useTrackedRules, makeRuleId } from "../hooks/useTrackedRules";
import { RuleMatchDetail } from "../hooks/useRuleAlerts";
import DebugLabel from "./DebugLabel";

/**
 * Single source-of-truth panel for the simplified app:
 *   - Loads pre-baked rules from assets/hard_rules.json
 *   - User toggles which rules to MONITOR ("Theo dõi")
 *   - Tracked rules will (in Phase 2) trigger live signal alerts when their
 *     conditions match incoming candle data
 *
 * No backtesting, no optimizing — just pick a rule and let the app watch.
 */

const COND_LABELS: Record<string, string> = {
  stochExtreme: "Stoch cực trị",
  rsiExtreme: "RSI cực trị",
  divergence: "Phân kỳ",
  bollingerTouch: "Chạm Bollinger",
  macdCross: "MACD đổi chiều",
};

const COND_SHORT: Record<string, string> = {
  stochExtreme: "Stoch", rsiExtreme: "RSI", divergence: "Div",
  bollingerTouch: "BB", macdCross: "MACD",
};

const INTERVAL_MIN: Record<string, number> = {
  "5m": 5, "15m": 15, "1h": 60, "4h": 240, "1d": 1440, "1w": 10080,
};

function formatPeriod(interval: string, candles: number): string {
  const min = INTERVAL_MIN[interval] || 60;
  const days = (candles * min) / 60 / 24;
  if (days < 30) return `${days.toFixed(1)} ngày`;
  if (days < 365) return `${(days / 30).toFixed(1)} tháng`;
  return `${(days / 365).toFixed(1)} năm`;
}

function formatFreq(trades: number, days: number): string {
  const perMonth = (trades / days) * 30;
  if (perMonth >= 30) return `${(perMonth / 30).toFixed(1)} lệnh/ngày`;
  if (perMonth >= 1) return `${perMonth.toFixed(1)} lệnh/tháng`;
  return `${(perMonth * 12).toFixed(1)} lệnh/năm`;
}

function formatRuleShape(req?: string[]): string {
  if (!req || req.length === 0) return "Bất kỳ";
  return req.map((k) => COND_SHORT[k] || k).join(" + ");
}

// ── 2026-04-23: Rarity tier theo absolute rank (Tommy: rank càng nhỏ càng rare) ──
type RarityTier = "LEGENDARY" | "EPIC" | "RARE" | "UNCOMMON" | "COMMON";
interface RarityInfo {
  tier: RarityTier;
  label: string;         // "🔥 LEGEND"
  color: string;         // border + badge color
  borderWidth: 1 | 2 | 3 | 4;
  gradientBg: string | null;  // rgba tint for bg (null = none)
  glow: boolean;         // pulse animation
}
function getRarity(rank: number): RarityInfo {
  if (rank <= 2)  return { tier: "LEGENDARY", label: "🔥 LEGEND",   color: "#ff6b1a", borderWidth: 4, gradientBg: "rgba(255,107,26,0.10)", glow: true };
  if (rank <= 5)  return { tier: "EPIC",      label: "💎 EPIC",     color: "#c77dff", borderWidth: 3, gradientBg: "rgba(199,125,255,0.08)", glow: false };
  if (rank <= 10) return { tier: "RARE",      label: "⚡ RARE",     color: "#4aa8ff", borderWidth: 3, gradientBg: "rgba(74,168,255,0.06)",  glow: false };
  if (rank <= 20) return { tier: "UNCOMMON",  label: "🟢 UNCOMMON", color: "#7dd87d", borderWidth: 2, gradientBg: null, glow: false };
  return             { tier: "COMMON",    label: "⚪ COMMON",   color: "#9f8e80", borderWidth: 1, gradientBg: null, glow: false };
}

// Human-readable condition labels (Vietnamese, short)
const COND_FULL: Record<string, string> = {
  stochExtreme: "Stoch cực trị", rsiExtreme: "RSI cực trị",
  divergence: "Phân kỳ giá/RSI", bollingerTouch: "Chạm Bollinger",
  macdCross: "MACD đổi chiều", candleReversal: "Candle reversal",
};
function condLive(k: string, conds: Record<string, any>, ind?: { rsi?: number | null; stochK?: number | null; macdCross?: string | null }): string {
  if (k === "rsiExtreme" && ind?.rsi != null) return `RSI=${ind.rsi.toFixed(1)}`;
  if (k === "stochExtreme" && ind?.stochK != null) return `K=${ind.stochK.toFixed(1)}`;
  if (k === "macdCross") return conds[k] ? "cross ✓" : "—";
  return conds[k] ? "✓" : "—";
}

/** Mini equity curve sparkline. Color = trend (UP/FLAT/DOWN). */
function EquitySparkline({ curve, trend, width = 90, height = 26 }: {
  curve: number[]; trend: "UP" | "FLAT" | "DOWN"; width?: number; height?: number;
}) {
  if (!curve || curve.length < 2) return null;
  const min = Math.min(0, ...curve);
  const max = Math.max(0, ...curve);
  const range = max - min || 1;
  const pad = 2;
  const w = width - pad * 2;
  const h = height - pad * 2;
  const pts = curve.map((v, i) => {
    const x = pad + (i / (curve.length - 1)) * w;
    const y = pad + h - ((v - min) / range) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const color = trend === "UP" ? COLORS.bull : trend === "DOWN" ? COLORS.bear : COLORS.textDim;
  // zero baseline
  const yZero = pad + h - ((0 - min) / range) * h;
  return (
    <Svg width={width} height={height}>
      <Line x1={0} y1={yZero} x2={width} y2={yZero} stroke="#ffffff20" strokeWidth={0.5} strokeDasharray="2,2" />
      <Polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} />
    </Svg>
  );
}

/** Quality score: NET × log(N+1) × min(PF,5) × trendMul × edgePenalty.
 *  trendMul: UP=1.2, FLAT=1.0, DOWN=0.7.
 *  edgePenalty: 0.6 nếu WR < BE_WR, 1.0 nếu vượt.
 *  Negative NET → score âm để loser chìm xuống đáy. */
export function computeQualityScore(rule: HardRule): number {
  const cfg: any = rule.config || {};
  const stats: any = rule.stats || {};
  const net = stats.netPnL || 0;
  const trades = stats.trades || 0;
  const pf = Math.min(stats.profitFactor || 0, 5);
  const trend = stats.equityTrend as "UP" | "FLAT" | "DOWN" | undefined;
  const trendMul = trend === "UP" ? 1.2 : trend === "DOWN" ? 0.7 : 1.0;
  const tp = cfg.targetPct, sl = cfg.stopPct;
  const beWR = tp && sl ? (sl / (tp + sl)) * 100 : 50;
  const wr = stats.winRate || 0;
  const edgePenalty = wr < beWR ? 0.6 : 1.0;
  return net * Math.log(trades + 1) * (pf || 0.1) * trendMul * edgePenalty;
}

interface RuleCardProps {
  rule: HardRule;
  tfKey: string;
  days: number;
  isTracked: boolean;
  onToggle: () => void;
  liveStatus?: "ARMED" | "FIRED" | "OFF";
  matchDetail?: RuleMatchDetail;
  isHighlighted?: boolean;
  qualityRank: number; // 1-based rank trong TF theo computeQualityScore
}

const RuleCard = React.memo(function RuleCardInner({ rule, tfKey, days, isTracked, onToggle, liveStatus, matchDetail, isHighlighted, qualityRank }: RuleCardProps) {
  // Compact-by-default: cards collapsed unless user taps to expand
  const [expanded, setExpanded] = useState(false);
  const [zoomEquity, setZoomEquity] = useState(false);

  // Auto-expand when highlighted (from banner tap)
  useEffect(() => {
    if (isHighlighted) setExpanded(true);
  }, [isHighlighted]);

  const isFiring = liveStatus === "FIRED";
  const cfg = rule.config as any;
  const stats = rule.stats as any;
  const lev = cfg.leverage || 100;
  const side = stats.side as "LONG" | "SHORT" | undefined;
  const isGA = !!cfg.weights;
  const htfFilter = cfg.htfTrendFilter;
  const htfRsiFilter = cfg.htfRsiFilter as { tf: string; op: string; value: number } | undefined;
  const htfFilters = cfg.htfFilters as any[] | undefined;
  const hasHtf = !!(htfFilter || htfRsiFilter || (htfFilters && htfFilters.length > 0));
  const wrColor = stats.winRate >= 55 ? COLORS.bull : stats.winRate >= 40 ? COLORS.warning : COLORS.bear;
  const wrBg = stats.winRate >= 55 ? COLORS.bull + "20" : stats.winRate >= 40 ? COLORS.warning + "15" : COLORS.bear + "15";
  const wrBorder = stats.winRate >= 55 ? COLORS.bull + "50" : stats.winRate >= 40 ? COLORS.warning + "40" : COLORS.bear + "40";
  const netPnL = stats.netPnL;
  const monthlyPnL = netPnL !== undefined ? Math.round(netPnL / days * 30) : null;
  const sourceMap: Record<string, { label: string; color: string }> = {
    GRID: { label: "↻", color: COLORS.warning },
    GA: { label: "🧬", color: COLORS.bull },
    VERIFIED: { label: "⭐", color: COLORS.bitcoin },
    MYRULE: { label: "📝", color: "#ff66cc" },
  };
  const src = sourceMap[rule.source] || sourceMap.VERIFIED;

  // 2026-04-22: Tier badge (GOLD/SILVER/BRONZE/JUNK) — dùng stats.tier nếu có,
  // fallback: auto-classify theo WR + N + PF + edge.
  const tp = cfg.targetPct, sl = cfg.stopPct;
  const beWR = tp && sl ? (sl / (tp + sl)) * 100 : 50;
  const edge = (stats.winRate || 0) - beWR;
  const autoTier = (() => {
    const wr = stats.winRate || 0, n = stats.trades || 0, pf = stats.profitFactor || 0;
    if (wr >= 60 && n >= 50 && pf >= 1.3) return "GOLD";
    if (wr >= 50 && n >= 30 && pf >= 1.1) return "SILVER";
    if (wr >= 40 && n >= 30 && pf >= 1.0) return "BRONZE";
    return "JUNK";
  })();
  const tier = stats.tier || autoTier;
  const tierMap: Record<string, { label: string; color: string; bg: string }> = {
    GOLD:   { label: "🥇", color: "#ffd54a", bg: "#ffd54a20" },
    SILVER: { label: "🥈", color: "#c0c0c0", bg: "#c0c0c020" },
    BRONZE: { label: "🥉", color: "#cd8a4a", bg: "#cd8a4a20" },
    JUNK:   { label: "⚠",  color: COLORS.bear, bg: COLORS.bear + "15" },
  };
  const tierInfo = tierMap[tier] || tierMap.JUNK;
  const edgeWarn = edge < 0;
  const isFlipped = typeof rule.source === "string" && rule.source.startsWith("flipped-from-");

  // 2026-04-23: Rarity theo rank
  const rarity = getRarity(qualityRank);
  // Pulse animation cho LEGENDARY (or FIRING)
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!rarity.glow && !isFiring) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: isFiring ? 600 : 900, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
        Animated.timing(pulse, { toValue: 0, duration: isFiring ? 600 : 900, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [rarity.glow, isFiring, pulse]);
  const glowShadowRadius = pulse.interpolate({ inputRange: [0, 1], outputRange: [4, isFiring ? 18 : 12] });
  const glowColor = isFiring ? P.bitcoinOrange : rarity.color;
  const accentColor = isFiring ? P.bitcoinOrange : rarity.color;
  const accentBorderWidth = isFiring ? 4 : rarity.borderWidth;
  const cardBgTint = isFiring ? P.bitcoinOrange + "15" : rarity.gradientBg || undefined;

  return (
    <Animated.View style={[
      styles.cardV2,
      {
        borderLeftColor: accentColor,
        borderLeftWidth: accentBorderWidth,
        backgroundColor: cardBgTint || P.cardAlt,
        opacity: rarity.tier === "COMMON" && !isFiring && !isTracked ? 0.88 : 1,
      },
      (rarity.glow || isFiring) && {
        shadowColor: glowColor,
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.55,
        shadowRadius: glowShadowRadius as any,
        elevation: 6,
      },
      isHighlighted && { borderLeftColor: P.primaryContainer, borderLeftWidth: 4 },
    ]}>
      <TouchableOpacity onPress={() => setExpanded(!expanded)} activeOpacity={0.7}>
        {/* HEADER ROW: SIDE pill · #rank · title · rarity · WR pill · switch */}
        <View style={styles.rcHead}>
          {side === "LONG" && (
            <View style={[styles.rcSidePill, { backgroundColor: COLORS.bull + "1f", borderColor: COLORS.bull + "72" }]}>
              <Text style={[styles.rcSideText, { color: COLORS.bull }]}>LONG</Text>
            </View>
          )}
          {side === "SHORT" && (
            <View style={[styles.rcSidePill, { backgroundColor: COLORS.bear + "1f", borderColor: COLORS.bear + "72" }]}>
              <Text style={[styles.rcSideText, { color: COLORS.bear }]}>SHORT</Text>
            </View>
          )}
          {!side && (
            <View style={[styles.rcSidePill, { backgroundColor: "#ffffff0a", borderColor: "#ffffff30" }]}>
              <Text style={[styles.rcSideText, { color: COLORS.textDim }]}>⇅ BOTH</Text>
            </View>
          )}
          <Text style={[styles.rcRank, { color: accentColor }]}>#{qualityRank}</Text>
          <Text style={styles.rcTitle} numberOfLines={1}>
            {formatRuleShape(cfg.requiredConditions)}{cfg.candleReversalFilter ? " · CR" : ""}{cfg.emaPosFilter ? ` · EMA` : ""}
          </Text>
          <View style={[styles.rcRarityBadge, { borderColor: accentColor + "a0", backgroundColor: accentColor + "15" }]}>
            <Text style={[styles.rcRarityText, { color: accentColor }]}>{rarity.label}</Text>
          </View>
          <View style={[styles.rcWrPill, { backgroundColor: wrBg, borderColor: wrBorder }]}>
            <Text style={[styles.rcWrText, { color: wrColor }]}>WR {stats.winRate}%</Text>
          </View>
        </View>

        {/* META LINE: lev · PF · N · TP/SL · NET */}
        <View style={styles.rcMetaLine}>
          <Text style={styles.rcMeta}>
            lv{lev}<Text style={styles.rcMetaSep}> · </Text>
            PF<Text style={{ color: P.text2, fontWeight: "800" }}>{stats.profitFactor === 999 ? "∞" : stats.profitFactor.toFixed(1)}</Text>
            <Text style={styles.rcMetaSep}> · </Text>N={stats.trades}
            <Text style={styles.rcMetaSep}> · </Text>
            <Text style={styles.rcMetaTp}>+{(cfg.targetPct * lev).toFixed(0)}%</Text>
            <Text style={styles.rcMetaSep}>/</Text>
            <Text style={styles.rcMetaSl}>-{(cfg.stopPct * lev).toFixed(0)}%</Text>
            <Text style={styles.rcMetaSep}> · </Text>{formatFreq(stats.trades, days)}
            {edgeWarn ? <Text style={{ color: COLORS.bear }}>  ⚠edge</Text> : null}
            {isFlipped ? <Text style={{ color: P.primaryContainer }}>  ⇄flip</Text> : null}
          </Text>
          {netPnL !== undefined && (
            <Text numberOfLines={1} style={[styles.rcNet, { color: netPnL >= 0 ? COLORS.bull : COLORS.bear }]}>
              {netPnL >= 0 ? "+" : ""}{Math.abs(netPnL) >= 1000 ? `${(netPnL/1000).toFixed(1)}K` : netPnL}%
            </Text>
          )}
        </View>

        {/* Equity curve sparkline + trend badge + max drawdown + risk + age */}
        {stats.equityCurve && stats.equityCurve.length >= 2 && (() => {
          const trend = (stats.equityTrend as "UP" | "FLAT" | "DOWN") || "FLAT";
          const trendCfg = trend === "UP"
            ? { icon: "📈", label: "UP", color: COLORS.bull }
            : trend === "DOWN"
              ? { icon: "📉", label: "DOWN", color: COLORS.bear }
              : { icon: "➡️", label: "FLAT", color: COLORS.textDim };
          const dd = Math.abs(stats.maxDrawdownPct ?? 0);
          const net = Math.abs(netPnL ?? 0);
          const highRisk = net > 0 && dd > net; // DD > NET tổng = nguy hiểm
          const riskRatio = net > 0 ? (dd / net).toFixed(1) : null;
          // Backtest age
          let ageBadge: { label: string; color: string } | null = null;
          if (stats.lastBacktestAt) {
            const ageMs = Date.now() - new Date(stats.lastBacktestAt).getTime();
            const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
            const c = ageDays > 30 ? COLORS.warning : COLORS.textMuted;
            ageBadge = { label: ageDays === 0 ? "Hôm nay" : `${ageDays}d trước`, color: c };
          }
          return (
            <View style={styles.rcEquityRow}>
              <TouchableOpacity onPress={() => setZoomEquity(true)} activeOpacity={0.7}>
                <EquitySparkline curve={stats.equityCurve} trend={trend} />
              </TouchableOpacity>
              <View style={styles.rcTrendCol}>
                <View style={[styles.rcTrendBadge, { backgroundColor: trendCfg.color + "20", borderColor: trendCfg.color + "60" }]}>
                  <Text style={[styles.rcTrendText, { color: trendCfg.color }]}>{trendCfg.icon} {trendCfg.label}</Text>
                </View>
                <Text style={styles.rcDdText}>DD -{dd >= 1000 ? `${(dd/1000).toFixed(1)}K` : dd}%</Text>
              </View>
              {highRisk && (
                <View style={[styles.rcTrendBadge, { backgroundColor: COLORS.bear + "20", borderColor: COLORS.bear + "70" }]}>
                  <Text style={[styles.rcTrendText, { color: COLORS.bear }]}>⚠ HIGH RISK ×{riskRatio}</Text>
                </View>
              )}
              {ageBadge && (
                <Text style={[styles.rcAgeText, { color: ageBadge.color }]}>⏰ {ageBadge.label}</Text>
              )}
            </View>
          );
        })()}

        {/* Equity zoom modal */}
        <Modal visible={zoomEquity} transparent animationType="fade" onRequestClose={() => setZoomEquity(false)}>
          <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setZoomEquity(false)}>
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>Equity curve · #{qualityRank} · {stats.trades} trades</Text>
              <EquitySparkline curve={stats.equityCurve || []} trend={(stats.equityTrend as any) || "FLAT"} width={300} height={180} />
              <Text style={styles.modalMeta}>
                NET <Text style={{ color: (netPnL ?? 0) >= 0 ? COLORS.bull : COLORS.bear, fontWeight: "900" }}>
                  {(netPnL ?? 0) >= 0 ? "+" : ""}{netPnL}%
                </Text> · DD -{Math.abs(stats.maxDrawdownPct ?? 0)}% · trend {stats.equityTrend || "FLAT"}
              </Text>
              <Text style={styles.modalHint}>Tap để đóng</Text>
            </View>
          </TouchableOpacity>
        </Modal>

        {/* Live status + condition match detail */}
        {isTracked && liveStatus && (
          <View>
            {liveStatus === "FIRED" ? (
              <>
                <View style={[styles.rcStatus, { backgroundColor: COLORS.bitcoin + "20", borderColor: COLORS.bitcoin + "95" }]}>
                  <Text style={[styles.rcStatusIcon]}>🚨</Text>
                  <Text style={[styles.rcStatusText, { color: COLORS.bitcoin }]}>KÍCH HOẠT — VÀO LỆNH NGAY</Text>
                </View>
                <View style={styles.rcFireBadge}>
                  <Text style={styles.rcFireBadgeText}>🔥 FIRING NOW — {side || "SIGNAL"} LIVE</Text>
                </View>
              </>
            ) : liveStatus === "ARMED" && matchDetail ? (() => {
              // Aggregate HTF checks (trend + rsi + filters[])
              const htfChecks: boolean[] = [];
              if (matchDetail.htfMatch !== null) htfChecks.push(matchDetail.htfMatch);
              if (matchDetail.htfRsiMatch !== null) htfChecks.push(matchDetail.htfRsiMatch);
              if (matchDetail.htfFiltersStatus) {
                for (const f of matchDetail.htfFiltersStatus) htfChecks.push(f.match);
              }
              const hasHtf = htfChecks.length > 0;
              const htfPass = htfChecks.filter(Boolean).length;
              const htfAllPass = hasHtf && htfPass === htfChecks.length;
              const condsAllPass = matchDetail.matched >= matchDetail.required;
              const allPass = condsAllPass && (!hasHtf || htfAllPass);
              const blocked = condsAllPass && hasHtf && !htfAllPass;
              const totalMatched = matchDetail.matched + htfPass;
              const totalRequired = matchDetail.required + htfChecks.length;
              const pct = (totalMatched / Math.max(1, totalRequired)) * 100;
              const barColor = allPass ? COLORS.bull : blocked ? COLORS.bear : COLORS.warning;
              const statusIcon = allPass ? "🎯" : blocked ? "🚫" : "📡";
              const statusText = allPass
                ? "SẴN SÀNG VÀO LỆNH"
                : blocked
                  ? `HTF CHẶN (${htfPass}/${htfChecks.length} filter pass)`
                  : matchDetail.skipReason
                    ? `CHẶN: ${matchDetail.skipReason}`
                    : `${totalMatched}/${totalRequired} điều kiện khớp`;
              const statusColor = allPass ? COLORS.bull : blocked ? COLORS.bear : COLORS.warning;

              // Chip filtering: only required conditions (skip non-required noise)
              // GA rules (weights) show all since weights apply to each
              const isGAMode = !!cfg.weights;
              const reqKeys: string[] = cfg.requiredConditions || [];
              const condEntries = isGAMode
                ? Object.entries(matchDetail.condDetail)
                : reqKeys.length > 0
                  ? Object.entries(matchDetail.condDetail).filter(([k]) => reqKeys.includes(k))
                  : Object.entries(matchDetail.condDetail);

              const bannerBg = allPass ? COLORS.bull + "1c" : blocked ? COLORS.bear + "14" : COLORS.warning + "14";
              const bannerBorder = allPass ? COLORS.bull + "80" : blocked ? COLORS.bear + "60" : COLORS.warning + "60";
              return (
                <View>
                  <View style={[styles.rcStatus, { backgroundColor: bannerBg, borderColor: bannerBorder }]}>
                    <Text style={styles.rcStatusIcon}>{statusIcon}</Text>
                    <Text style={[styles.rcStatusText, { color: statusColor }]} numberOfLines={2}>{statusText}</Text>
                  </View>
                  <View style={styles.progressBg}>
                    <View style={[styles.progressFill, { width: `${Math.min(100, pct)}%`, backgroundColor: barColor }]} />
                  </View>
                  {/* REQUIRED conditions — row-based (Golden style) */}
                  {condEntries.length > 0 && (
                    <View style={styles.rcCondGroup}>
                      <Text style={styles.rcCondTitle}>✅ REQUIRED ({condEntries.filter(([, v]) => v).length}/{condEntries.length})</Text>
                      {condEntries.map(([k, v]) => (
                        <View key={k} style={styles.rcCondRow}>
                          <Text style={[styles.rcCondIcon, { color: v ? COLORS.bull : COLORS.textMuted }]}>{v ? "✓" : "·"}</Text>
                          <Text style={[styles.rcCondLabel, { color: v ? COLORS.text : COLORS.textMuted }]} numberOfLines={1}>
                            {COND_FULL[k] || k}
                          </Text>
                          <Text style={[styles.rcCondLive, { color: v ? COLORS.bull : COLORS.textMuted }]} numberOfLines={1}>
                            {v ? "✓" : "—"}
                          </Text>
                        </View>
                      ))}
                    </View>
                  )}
                  {/* FEATURE FILTERS — row-based */}
                  {matchDetail.featFiltersStatus && matchDetail.featFiltersStatus.length > 0 && (
                    <View style={styles.rcCondGroup}>
                      <Text style={styles.rcCondTitle}>
                        🧪 FEATURE ({matchDetail.featFiltersStatus.filter((f) => f.match).length}/{matchDetail.featFiltersStatus.length})
                      </Text>
                      {matchDetail.featFiltersStatus.map((f, i) => (
                        <View key={i} style={styles.rcCondRow}>
                          <Text style={[styles.rcCondIcon, { color: f.match ? COLORS.bull : COLORS.textMuted }]}>{f.match ? "✓" : "·"}</Text>
                          <Text style={[styles.rcCondLabel, { color: f.match ? COLORS.text : COLORS.textMuted }]} numberOfLines={1}>{f.label}</Text>
                          <Text style={[styles.rcCondLive, { color: f.match ? COLORS.bull : COLORS.textMuted }]} numberOfLines={1}>{f.liveValue || "—"}</Text>
                        </View>
                      ))}
                    </View>
                  )}
                  {/* HTF FILTERS — row-based with bitcoin accent khi match */}
                  {matchDetail.htfFiltersStatus && matchDetail.htfFiltersStatus.length > 0 && (
                    <View style={styles.rcCondGroup}>
                      <Text style={styles.rcCondTitle}>
                        🔭 HTF TREND ({matchDetail.htfFiltersStatus.filter((f) => f.match).length}/{matchDetail.htfFiltersStatus.length})
                      </Text>
                      {matchDetail.htfFiltersStatus.map((f, i) => (
                        <View key={i} style={styles.rcCondRow}>
                          <Text style={[styles.rcCondIcon, { color: f.match ? COLORS.bitcoin : COLORS.bear }]}>{f.match ? "✓" : "·"}</Text>
                          <Text style={[styles.rcCondLabel, { color: f.match ? COLORS.text : COLORS.textMuted }]} numberOfLines={1}>{f.label}</Text>
                          <Text style={[styles.rcCondLive, { color: f.match ? COLORS.bitcoin : COLORS.bear }]} numberOfLines={1}>{f.liveValue || "—"}</Text>
                        </View>
                      ))}
                    </View>
                  )}
                  {/* Legacy HTF trend (htfTrendFilter) row */}
                  {matchDetail.htfMatch !== null && !matchDetail.htfFiltersStatus && (
                    <View style={styles.rcCondGroup}>
                      <Text style={styles.rcCondTitle}>🔭 HTF TREND</Text>
                      <View style={styles.rcCondRow}>
                        <Text style={[styles.rcCondIcon, { color: matchDetail.htfMatch ? COLORS.bitcoin : COLORS.bear }]}>{matchDetail.htfMatch ? "✓" : "·"}</Text>
                        <Text style={[styles.rcCondLabel, { color: matchDetail.htfMatch ? COLORS.text : COLORS.textMuted }]}>HTF trend filter</Text>
                        <Text style={[styles.rcCondLive, { color: matchDetail.htfMatch ? COLORS.bitcoin : COLORS.bear }]}>{matchDetail.htfMatch ? "match" : "miss"}</Text>
                      </View>
                    </View>
                  )}
                </View>
              );
            })() : (
              <Text style={styles.compactStatusOff}>○ Chưa đủ data live</Text>
            )}
          </View>
        )}

        {/* Collapse indicator — small chevron hint */}
        <Text style={styles.rcChevron}>{expanded ? "▲ thu gọn" : "▼ chi tiết"}</Text>
      </TouchableOpacity>

      {expanded && (
        <View style={styles.detail}>
          <DetailRow label="Hướng" value={side ? (side === "LONG" ? "🟢 LONG (mua, lời khi giá tăng)" : "🔴 SHORT (bán khống, lời khi giá giảm)") : "⇅ Cả 2 hướng"} />
          <DetailRow label="Hình dạng rule" value={
            isGA
              ? `🧬 GA Weighted · vào lệnh khi tổng trọng số ≥ ${cfg.minWeightedScore}`
              : (cfg.requiredConditions?.length || 0) > 0
                ? `BẮT BUỘC: ${formatRuleShape(cfg.requiredConditions)}`
                : `Bất kỳ Score ≥ ${cfg.minScore}/5`
          } />
          {htfFilter && (
            <DetailRow label="HTF Trend Filter" value={`📈 ${htfFilter.label || htfFilter.mode}`} color={COLORS.bitcoin} />
          )}
          {htfRsiFilter && (
            <DetailRow label="HTF RSI Filter" value={`📈 ${htfRsiFilter.tf} RSI ${htfRsiFilter.op} ${htfRsiFilter.value}`} color={COLORS.bitcoin} />
          )}
          {htfFilters && htfFilters.length > 0 && (
            <DetailRow
              label={`HTF Filters (${htfFilters.length})`}
              value={`🔭 ${htfFilters.map((f: any) => {
                if (f.type === "trend") return `${f.tf || "near"} ${String(f.direction).toUpperCase()}`;
                if (f.type === "rsi") return `${f.tf} RSI ${f.op} ${f.value}`;
                if (f.type === "slope") return `${f.tf} ${f.indicator} ${f.direction === "rising" ? "↑" : "↓"}`;
                if (f.type === "compare") return `${f.tf} ${f.left}${f.op}${f.right}`;
                if (f.type === "stochRange") {
                  const p: string[] = [];
                  if (f.kMin !== undefined) p.push(`K≥${f.kMin}`);
                  if (f.kMax !== undefined) p.push(`K≤${f.kMax}`);
                  if (f.dMin !== undefined) p.push(`D≥${f.dMin}`);
                  if (f.dMax !== undefined) p.push(`D≤${f.dMax}`);
                  return `${f.tf} ${p.join(",")}`;
                }
                if (f.type === "cross") return `${f.tf} ${f.direction}`;
                return f.type;
              }).join(" · ")}`}
              color={COLORS.bitcoin}
            />
          )}
          {isGA && cfg.weights && (
            <View style={styles.weightsBox}>
              <Text style={styles.weightsTitle}>🧬 Trọng số học được:</Text>
              {Object.entries(cfg.weights as Record<string, number>)
                .filter(([_, w]) => (w ?? 0) > 0)
                .sort(([, a], [, b]) => (b as number) - (a as number))
                .map(([k, w]) => (
                  <Text key={k} style={styles.weightRow}>
                    {COND_LABELS[k] || k}: <Text style={{ color: COLORS.bull, fontWeight: "800" }}>{w}/3</Text>
                  </Text>
                ))}
            </View>
          )}
          <DetailRow label="StochRSI" value={`Quá Bán < ${cfg.stochOSLevel} · Quá Mua > ${cfg.stochOBLevel}`} />
          <DetailRow label="RSI" value={`Quá Bán < ${cfg.rsiOSLevel} · Quá Mua > ${cfg.rsiOBLevel}`} />
          <DetailRow label="Take Profit" value={`+${(cfg.targetPct * lev).toFixed(0)}% PnL  (giá +${cfg.targetPct.toFixed(2)}%)`} color={COLORS.bull} />
          <DetailRow label="Stop Loss" value={`-${(cfg.stopPct * lev).toFixed(0)}% PnL  (giá -${cfg.stopPct.toFixed(2)}%)`} color={COLORS.bear} />
          <DetailRow label="Đòn bẩy" value={`x${lev}`} />
          <DetailRow label="Giữ lệnh tối đa" value={`${cfg.maxHoldBars} nến`} />
          <DetailRow label="R:R (Risk:Reward)" value={`1 : ${(cfg.targetPct / cfg.stopPct).toFixed(2)}`} />
          <View style={styles.divider} />
          <DetailRow label="Số lệnh test" value={`${stats.trades} lệnh trên ${days.toFixed(0)} ngày`} />
          <DetailRow label="Win/Loss/Timeout" value={`${stats.wins} thắng · ${stats.losses} thua · ${stats.timeouts} hết hạn`} />
          {netPnL !== undefined && (
            <>
              <DetailRow label="Gross PnL" value={`+${stats.grossPnL}%`} color={COLORS.bull} />
              <DetailRow label="Phí Binance" value={`-${stats.feeCost}%`} color={COLORS.bear} />
              <DetailRow label="NET PnL" value={`${netPnL >= 0 ? "+" : ""}${netPnL}% sau fee`} color={netPnL >= 0 ? COLORS.bull : COLORS.bear} />
              {monthlyPnL !== null && (
                <DetailRow label="Trung bình/tháng" value={`~${monthlyPnL >= 0 ? "+" : ""}${monthlyPnL}%/tháng`} color={monthlyPnL >= 0 ? COLORS.bull : COLORS.bear} />
              )}
            </>
          )}
        </View>
      )}
    </Animated.View>
  );
});

function DetailRow({ label, value, color = COLORS.text }: { label: string; value: string; color?: string }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={[styles.detailValue, { color }]}>{value}</Text>
    </View>
  );
}

interface Props {
  tfFilter?: string[];
  ruleStatus?: Record<string, "ARMED" | "FIRED" | "OFF">;
  ruleMatchDetails?: Record<string, RuleMatchDetail>;
  highlightedRuleId?: string | null;
  globalTF?: string; // TF global sync từ App (nếu có)
}

// Auto-map TF global → TF gần nhất có rule
function mapToPanelTF(globalTF: string | undefined, availableTFs: string[]): { mapped: string; isAutoMapped: boolean } {
  if (!globalTF) return { mapped: availableTFs[0], isAutoMapped: false };
  if (availableTFs.includes(globalTF)) return { mapped: globalTF, isAutoMapped: false };
  // 5m → 15m · 1d/1w/1M → 4h
  if (globalTF === "5m" && availableTFs.includes("15m")) return { mapped: "15m", isAutoMapped: true };
  if ((globalTF === "1d" || globalTF === "1w" || globalTF === "1M") && availableTFs.includes("4h")) return { mapped: "4h", isAutoMapped: true };
  return { mapped: availableTFs[0], isAutoMapped: true };
}

export default function TradingRulesPanel({ tfFilter, ruleStatus = {}, ruleMatchDetails = {}, highlightedRuleId, globalTF }: Props) {
  const tracked = useTrackedRules();
  const [activeTab, setActiveTab] = useState<string>("15m");
  const [userOverrode, setUserOverrode] = useState(false);

  // Sync với globalTF khi user chưa tự override
  useEffect(() => {
    if (!globalTF || userOverrode) return;
    // Chỉ set activeTab — map thực tế xảy ra ở currentTF/mapToPanelTF
    setActiveTab(globalTF);
  }, [globalTF, userOverrode]);
  const [showOnlyTracked, setShowOnlyTracked] = useState(false);
  // Default COLLAPSED — 55 rules quá dài, user tự bấm để mở khi cần
  const [collapsed, setCollapsed] = useState(true);

  if (!hasHardRules()) {
    return (
      <View style={styles.container}>
        <DebugLabel name="TradingRulesPanel" />
        <Text style={styles.emptyText}>
          📦 Hard Rules chưa được tạo.{"\n\n"}
          Chạy lệnh sau từ máy tính:{"\n"}
          <Text style={{ color: COLORS.warning, fontFamily: "monospace" }}>npx tsx tools/generate-hard-rules.ts</Text>
        </Text>
      </View>
    );
  }

  const data = getHardRules();
  const availableTFs = useMemo(() => {
    const all = Object.keys(data.tfs);
    const filtered = tfFilter ? all.filter((tf) => tfFilter.includes(tf)) : all;
    // Hide TF tabs where no monitorable rules exist (e.g., 5m sau khi move loser)
    return filtered.filter((tf) => (data.tfs[tf]?.rules || []).some(isRuleMonitorable));
  }, [data, tfFilter]);

  const { mapped: currentTF, isAutoMapped } = mapToPanelTF(activeTab, availableTFs);
  const tfData = data.tfs[currentTF];
  const days = tfData ? (tfData.candles_used * (INTERVAL_MIN[tfData.interval] || 60)) / 60 / 24 : 0;

  const [showAll, setShowAll] = useState(false);
  const PAGE_SIZE = 10;

  // When user taps an alert in the banner, auto-switch to that TF + show
  // all rules so the highlighted card is rendered & visible.
  useEffect(() => {
    if (!highlightedRuleId) return;
    const [tfKey] = highlightedRuleId.split(":");
    setActiveTab(tfKey);
    setShowOnlyTracked(false); // make sure it's visible
    setShowAll(true);          // show all so the card is rendered
    setCollapsed(false);       // auto-uncollapse panel when jumped from banner
  }, [highlightedRuleId]);

  // Quality-rank map: highest score = #1. Tính 1 lần per TF.
  const qualityRankMap = useMemo(() => {
    const map = new Map<number, number>();
    if (!tfData) return map;
    const monitorables = tfData.rules.filter(isRuleMonitorable);
    const scored = monitorables
      .map((r) => ({ rank: r.rank, score: computeQualityScore(r) }))
      .sort((a, b) => b.score - a.score);
    scored.forEach((x, i) => map.set(x.rank, i + 1));
    return map;
  }, [tfData]);

  const visibleRules = useMemo(() => {
    if (!tfData) return [];
    const monitorableRules = tfData.rules.filter(isRuleMonitorable);
    const filtered = showOnlyTracked
      ? monitorableRules.filter((r) => tracked.isTracked(makeRuleId(currentTF, r.rank)))
      : monitorableRules;
    // Sort theo quality rank (rule tốt nhất lên đầu)
    const sorted = [...filtered].sort((a, b) => {
      const qa = qualityRankMap.get(a.rank) ?? 999;
      const qb = qualityRankMap.get(b.rank) ?? 999;
      return qa - qb;
    });
    return showAll || showOnlyTracked ? sorted : sorted.slice(0, PAGE_SIZE);
  }, [tfData, showOnlyTracked, tracked, currentTF, showAll, qualityRankMap]);

  const totalCount = tfData ? (showOnlyTracked
    ? tfData.rules.filter((r) => isRuleMonitorable(r) && tracked.isTracked(makeRuleId(currentTF, r.rank))).length
    : tfData.rules.filter(isRuleMonitorable).length) : 0;
  const hasMore = !showAll && !showOnlyTracked && totalCount > PAGE_SIZE;

  return (
    <View style={styles.container}>
      <TouchableOpacity onPress={() => setCollapsed(!collapsed)} activeOpacity={0.7}>
        <View style={styles.headerRow}>
          <Text style={styles.title}>📡 RULE TRADING</Text>
          <View style={styles.trackedCounter}>
            <Text style={styles.trackedCounterText}>
              <Text style={{ color: COLORS.bull, fontWeight: "900" }}>🟢 {tracked.count}</Text> rule
            </Text>
            <Text style={styles.collapseIcon}>{collapsed ? "▶" : "▼"}</Text>
          </View>
        </View>
      </TouchableOpacity>

      {collapsed ? (
        <Text style={styles.collapsedHint}>
          Bấm để mở danh sách {availableTFs.length > 0 ? availableTFs.map(t => data.tfs[t]?.label).join(" · ") : ""} rules
        </Text>
      ) : (
      <>
      <Text style={styles.hint}>
        💡 Tất cả rule đều được theo dõi — app sẽ báo khi giá khớp điều kiện.
      </Text>

      {/* Auto-map note khi TF global nằm ngoài list */}
      {isAutoMapped && globalTF && (
        <View style={styles.syncNote}>
          <Text style={styles.syncNoteText}>
            ℹ️ TF <Text style={{ color: COLORS.bitcoin, fontWeight: "900" }}>{globalTF}</Text> chưa có rule — đang hiển thị rule <Text style={{ color: COLORS.bitcoin, fontWeight: "900" }}>{currentTF}</Text> (gần nhất)
          </Text>
        </View>
      )}
      {userOverrode && globalTF && globalTF !== activeTab && (
        <TouchableOpacity style={styles.syncBackBtn} onPress={() => setUserOverrode(false)}>
          <Text style={styles.syncBackText}>🔗 Sync lại với TF {globalTF.toUpperCase()} global</Text>
        </TouchableOpacity>
      )}

      {/* TF tabs */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabsRow}>
        {availableTFs.map((tfKey) => {
          const tf = data.tfs[tfKey];
          const monitorables = tf.rules.filter(isRuleMonitorable);
          const firedCount = monitorables.filter((r) => ruleStatus[makeRuleId(tfKey, r.rank)] === "FIRED").length;
          const isActive = currentTF === tfKey;
          return (
            <TouchableOpacity
              key={tfKey}
              onPress={() => { setActiveTab(tfKey); setUserOverrode(true); }}
              style={[styles.tab, isActive && styles.tabActive, firedCount > 0 && styles.tabFiring]}
            >
              <Text style={[styles.tabLabel, isActive && styles.tabLabelActive]}>
                {tf.label}
              </Text>
              <Text style={styles.tabCount}>
                {monitorables.length} rule
              </Text>
              {firedCount > 0 && (
                <View style={styles.tabFireBadge}>
                  <Text style={styles.tabFireBadgeText}>🔥 {firedCount}</Text>
                </View>
              )}
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* TF context */}
      {tfData && (
        <View style={styles.tfContextBox}>
          <Text style={styles.tfContextText}>
            📅 Test trên <Text style={{ fontWeight: "800" }}>{formatPeriod(tfData.interval, tfData.candles_used)}</Text> · {tfData.candles_used.toLocaleString()} nến · Giá ${tfData.price_range.first.toLocaleString()} → ${tfData.price_range.last.toLocaleString()}
          </Text>
        </View>
      )}

      {/* Rules list */}
      {visibleRules.length === 0 ? (
        <Text style={styles.emptyHint}>
          {showOnlyTracked ? "Chưa theo dõi rule nào ở khung này" : "Khung này chưa có rule"}
        </Text>
      ) : (
        <>
          {visibleRules.map((rule) => {
            const id = makeRuleId(currentTF, rule.rank);
            return (
              <RuleCard
                key={id}
                rule={rule}
                tfKey={currentTF}
                days={days}
                qualityRank={qualityRankMap.get(rule.rank) ?? 999}
                isTracked={tracked.isTracked(id)}
                onToggle={() => tracked.toggle(id)}
                liveStatus={ruleStatus[id]}
                matchDetail={ruleMatchDetails[id]}
                isHighlighted={highlightedRuleId === id}
              />
            );
          })}
          {hasMore && (
            <TouchableOpacity onPress={() => setShowAll(true)} style={styles.showMoreBtn}>
              <Text style={styles.showMoreText}>
                ▼ Hiển thị thêm {totalCount - PAGE_SIZE} rule (đang ẩn)
              </Text>
            </TouchableOpacity>
          )}
          {showAll && totalCount > PAGE_SIZE && (
            <TouchableOpacity onPress={() => setShowAll(false)} style={styles.showMoreBtn}>
              <Text style={styles.showMoreText}>▲ Thu gọn về {PAGE_SIZE} rule đầu</Text>
            </TouchableOpacity>
          )}
        </>
      )}

      </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: P.card, borderRadius: 2, padding: 12, paddingLeft: 16, marginBottom: 10, borderLeftWidth: 4, borderLeftColor: P.green },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 6 },
  title: { color: P.text, fontSize: 12, fontWeight: "700", fontFamily: "SpaceGrotesk_700Bold", letterSpacing: 2, textTransform: "uppercase" },
  trackedCounter: { flexDirection: "row", alignItems: "center", gap: 8 },
  trackedCounterText: { color: COLORS.textDim, fontSize: 11, fontFamily: "monospace" },
  clearTrackBtn: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4, backgroundColor: COLORS.bear + "20", borderWidth: 1, borderColor: COLORS.bear + "40" },
  clearTrackText: { color: COLORS.bear, fontSize: 9, fontWeight: "700", fontFamily: "monospace" },
  hint: { color: COLORS.textMuted, fontSize: 10, fontFamily: "monospace", marginBottom: 10, fontStyle: "italic" },
  syncNote: { backgroundColor: COLORS.bitcoin + "10", borderLeftWidth: 3, borderLeftColor: COLORS.bitcoin, padding: 8, borderRadius: 4, marginBottom: 8 },
  syncNoteText: { color: COLORS.textDim, fontSize: 10, fontFamily: "monospace", lineHeight: 14 },
  syncBackBtn: { backgroundColor: COLORS.bitcoin + "15", borderWidth: 1, borderColor: COLORS.bitcoin + "50", borderRadius: 6, padding: 8, marginBottom: 8, alignItems: "center" },
  syncBackText: { color: COLORS.bitcoin, fontSize: 10, fontFamily: "monospace", fontWeight: "800" },
  tabsRow: { marginBottom: 8 },
  tab: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 2, backgroundColor: P.surface, marginRight: 6, alignItems: "center" },
  tabActive: { backgroundColor: P.primaryContainer },
  tabLabel: { color: P.dim, fontSize: 11, fontWeight: "700", fontFamily: "SpaceGrotesk_700Bold", letterSpacing: 1 },
  tabLabelActive: { color: P.onPrimary },
  tabCount: { color: COLORS.textMuted, fontSize: 8, fontFamily: "monospace", marginTop: 1 },
  filterRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 4, marginBottom: 8 },
  filterLabel: { color: COLORS.textDim, fontSize: 10, fontFamily: "monospace" },
  tfContextBox: { backgroundColor: COLORS.bitcoin + "08", borderRadius: 6, padding: 8, marginBottom: 10, borderLeftWidth: 3, borderLeftColor: COLORS.bitcoin + "60" },
  tfContextText: { color: COLORS.textDim, fontSize: 10, fontFamily: "monospace", lineHeight: 14 },
  emptyText: { color: COLORS.textDim, fontSize: 12, fontFamily: "monospace", textAlign: "center", padding: 20, lineHeight: 18 },
  emptyHint: { color: COLORS.textMuted, fontSize: 10, fontFamily: "monospace", textAlign: "center", padding: 20, fontStyle: "italic" },
  showMoreBtn: { paddingVertical: 10, alignItems: "center", marginVertical: 6, backgroundColor: COLORS.bitcoin + "10", borderRadius: 6, borderWidth: 1, borderColor: COLORS.bitcoin + "30" },
  showMoreText: { color: COLORS.bitcoin, fontSize: 11, fontWeight: "700", fontFamily: "monospace" },
  // Compact card
  compactRow: { flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 2 },
  compactSideLong: { fontSize: 13 },
  compactSideShort: { fontSize: 13 },
  compactSideBoth: { fontSize: 13, color: COLORS.textMuted },
  compactRank: { color: COLORS.warning, fontSize: 10, fontWeight: "900", fontFamily: "monospace", minWidth: 22 },
  compactWR: { fontSize: 13, fontWeight: "900", fontFamily: "monospace", minWidth: 38 },
  wrBadge: { paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4, borderWidth: 1, minWidth: 38, alignItems: "center" as const },
  wrText: { fontSize: 12, fontWeight: "900", fontFamily: "monospace", letterSpacing: 0.3 },
  compactPF: { color: COLORS.textDim, fontSize: 9, fontFamily: "monospace", minWidth: 32 },
  compactTrades: { color: COLORS.textMuted, fontSize: 9, fontFamily: "monospace", minWidth: 32 },
  compactNet: { fontSize: 10, fontWeight: "800", fontFamily: "monospace", marginLeft: "auto", paddingLeft: 4 },
  compactStatus: { marginTop: 4 },
  compactStatusArmed: { color: COLORS.bull, fontSize: 9, fontFamily: "monospace", textAlign: "center" },
  compactStatusOff: { color: COLORS.textMuted, fontSize: 9, fontFamily: "monospace", fontStyle: "italic", textAlign: "center" },
  compactSummary: { fontSize: 10, fontFamily: "monospace", marginTop: 4, paddingTop: 4, borderTopWidth: 1, borderTopColor: "#ffffff08" },
  // Card
  card: { backgroundColor: P.cardAlt, borderRadius: 2, padding: 10, marginBottom: 6, borderLeftWidth: 2, borderLeftColor: P.borderSoft },
  cardTracked: { borderLeftColor: P.green, borderLeftWidth: 4, backgroundColor: P.green + "0C" },
  cardFiring: { borderLeftColor: P.error, borderLeftWidth: 4, backgroundColor: P.error + "10" },
  cardHighlighted: { borderLeftColor: P.primaryContainer, borderLeftWidth: 4, backgroundColor: P.primaryContainer + "10" },
  liveStatusRow: { marginBottom: 6, padding: 6, borderRadius: 4 },
  liveStatusFired: { color: COLORS.bear, fontSize: 11, fontWeight: "900", fontFamily: "monospace", letterSpacing: 0.5, textAlign: "center", backgroundColor: COLORS.bear + "20", padding: 6, borderRadius: 4, borderWidth: 1, borderColor: COLORS.bear + "60" },
  liveStatusArmed: { color: COLORS.bull, fontSize: 10, fontWeight: "700", fontFamily: "monospace", textAlign: "center" },
  liveStatusOff: { color: COLORS.textMuted, fontSize: 10, fontFamily: "monospace", fontStyle: "italic", textAlign: "center" },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 8 },
  rank: { color: COLORS.warning, fontSize: 12, fontWeight: "900", fontFamily: "monospace" },
  sourceBadge: { paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3, borderWidth: 1, minWidth: 22, alignItems: "center" as const },
  sourceText: { fontSize: 11, fontWeight: "800", fontFamily: "monospace" },
  sideLong: { backgroundColor: COLORS.bull + "20", paddingHorizontal: 6, paddingVertical: 3, borderRadius: 4, borderWidth: 1, borderColor: COLORS.bull + "60" },
  sideLongText: { color: COLORS.bull, fontSize: 10, fontWeight: "900", fontFamily: "monospace" },
  sideShort: { backgroundColor: COLORS.bear + "20", paddingHorizontal: 6, paddingVertical: 3, borderRadius: 4, borderWidth: 1, borderColor: COLORS.bear + "60" },
  sideShortText: { color: COLORS.bear, fontSize: 10, fontWeight: "900", fontFamily: "monospace" },
  sideBoth: { backgroundColor: "#ffffff10", paddingHorizontal: 6, paddingVertical: 3, borderRadius: 4, borderWidth: 1, borderColor: "#ffffff30" },
  sideBothText: { color: COLORS.textDim, fontSize: 10, fontWeight: "700", fontFamily: "monospace" },
  trackToggle: { flexDirection: "row", alignItems: "center", gap: 4 },
  trackLabel: { color: COLORS.textMuted, fontSize: 9, fontFamily: "monospace", fontWeight: "700" },
  // Stats
  statsRow: { flexDirection: "row", gap: 6, marginBottom: 8 },
  statBox: { flex: 1, alignItems: "center", backgroundColor: P.surface, paddingVertical: 6, borderRadius: 0, borderWidth: 1, borderColor: P.border },
  statVal: { fontSize: 16, fontWeight: "900", fontFamily: "monospace" },
  statLabel: { color: COLORS.textMuted, fontSize: 8, fontFamily: "monospace", marginTop: 1, letterSpacing: 0.3 },
  statSub: { color: COLORS.textMuted, fontSize: 7, fontFamily: "monospace", marginTop: 1, fontStyle: "italic" },
  // Summary
  summary: { color: COLORS.text, fontSize: 11, fontFamily: "monospace", marginBottom: 4 },
  tpsl: { fontSize: 11, fontFamily: "monospace", marginBottom: 4 },
  // Expand
  expandBtn: { paddingVertical: 6, alignItems: "center", marginTop: 4 },
  expandText: { color: COLORS.bitcoin, fontSize: 10, fontWeight: "700", fontFamily: "monospace" },
  detail: { backgroundColor: P.surface, borderRadius: 0, padding: 8, marginTop: 4, gap: 2, borderWidth: 1, borderColor: P.border },
  detailRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3, borderBottomWidth: 1, borderBottomColor: "#ffffff08" },
  detailLabel: { color: COLORS.textMuted, fontSize: 10, fontFamily: "monospace", flex: 1 },
  detailValue: { fontSize: 10, fontWeight: "700", fontFamily: "monospace", textAlign: "right", flex: 2 },
  divider: { height: 1, backgroundColor: "#ffffff15", marginVertical: 4 },
  // Weights box
  weightsBox: { backgroundColor: COLORS.bull + "10", padding: 6, borderRadius: 4, marginVertical: 4, borderLeftWidth: 2, borderLeftColor: COLORS.bull },
  weightsTitle: { color: COLORS.bull, fontSize: 10, fontWeight: "800", fontFamily: "monospace", marginBottom: 4 },
  weightRow: { color: COLORS.textDim, fontSize: 10, fontFamily: "monospace", paddingVertical: 1 },
  // Collapse
  collapseIcon: { color: COLORS.textMuted, fontSize: 12, fontFamily: "monospace", marginLeft: 6 },
  collapsedHint: { color: COLORS.textMuted, fontSize: 10, fontFamily: "monospace", fontStyle: "italic", textAlign: "center", paddingVertical: 6 },
  // Live condition match
  matchBar: { marginBottom: 4 },
  matchLabel: { color: COLORS.warning, fontSize: 10, fontWeight: "800", fontFamily: "monospace", marginBottom: 3 },
  matchLabelNew: { fontSize: 11, fontWeight: "900" as const, fontFamily: "monospace", marginBottom: 4, letterSpacing: 0.3 },
  progressBg: { height: 4, backgroundColor: "#ffffff10", borderRadius: 2, overflow: "hidden" as const },
  progressFill: { height: 4, borderRadius: 2 },
  condChips: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 4, marginTop: 3 },
  filterSection: { marginTop: 6, backgroundColor: "#ffffff04", borderRadius: 6, padding: 6, borderLeftWidth: 2, borderLeftColor: "#ffffff15" },
  filterSectionTitle: { color: COLORS.textMuted, fontSize: 8, fontWeight: "800" as const, fontFamily: "monospace", letterSpacing: 0.5, marginBottom: 4 },
  featRow: { flexDirection: "row" as const, alignItems: "flex-start" as const, gap: 6, paddingVertical: 2 },
  featMark: { fontSize: 11, fontWeight: "900" as const, fontFamily: "monospace", width: 12 },
  featLabel: { color: COLORS.text, fontSize: 9, fontFamily: "monospace", fontWeight: "600" as const },
  featLiveValue: { fontSize: 8, fontFamily: "monospace", fontWeight: "700" as const, marginTop: 1 },
  condChip: { fontSize: 8, fontFamily: "monospace", fontWeight: "700" as const, paddingHorizontal: 5, paddingVertical: 2, borderRadius: 3, borderWidth: 1, overflow: "hidden" as const },
  condChipOn: { color: COLORS.bull, backgroundColor: COLORS.bull + "15", borderColor: COLORS.bull + "40" },
  condChipOff: { color: COLORS.textMuted, backgroundColor: "#ffffff05", borderColor: "#ffffff15" },
  htfChip: { fontSize: 8, fontFamily: "monospace", fontWeight: "700" as const, paddingHorizontal: 5, paddingVertical: 2, borderRadius: 3, borderWidth: 1, overflow: "hidden" as const, maxWidth: 180 },
  htfChipOn: { color: COLORS.bitcoin, backgroundColor: COLORS.bitcoin + "15", borderColor: COLORS.bitcoin + "40" },
  htfChipOff: { color: COLORS.bear, backgroundColor: COLORS.bear + "10", borderColor: COLORS.bear + "40" },
  // Bulk buttons
  bulkBtnRow: { flexDirection: "row" as const, gap: 8, marginTop: 8 },
  bulkBtnOn: { flex: 1, paddingVertical: 8, borderRadius: 6, backgroundColor: COLORS.bull + "15", borderWidth: 1, borderColor: COLORS.bull + "40", alignItems: "center" as const },
  bulkBtnOnText: { color: COLORS.bull, fontSize: 10, fontWeight: "800", fontFamily: "monospace" },
  bulkBtnOff: { flex: 1, paddingVertical: 8, borderRadius: 6, backgroundColor: COLORS.bear + "15", borderWidth: 1, borderColor: COLORS.bear + "40", alignItems: "center" as const },
  bulkBtnOffText: { color: COLORS.bear, fontSize: 10, fontWeight: "800", fontFamily: "monospace" },

  // ── 2026-04-23 Rule Card v2 (Golden-clone + rarity) ───────────────────────
  cardV2: {
    backgroundColor: P.cardAlt,
    borderRadius: 2,
    paddingVertical: 10,
    paddingHorizontal: 12,
    paddingLeft: 14,
    marginBottom: 8,
    borderLeftWidth: 2,
    borderLeftColor: P.borderSoft,
    overflow: "hidden",
  },
  rcHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 6,
  },
  rcSidePill: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 2,
    borderWidth: 1,
  },
  rcSideText: { fontSize: 9, fontWeight: "900", fontFamily: "monospace", letterSpacing: 1 },
  rcRank: { fontSize: 11, fontWeight: "900", fontFamily: "monospace", letterSpacing: 0.3, minWidth: 28 },
  rcTitle: {
    flex: 1,
    fontSize: 10,
    color: P.text2,
    fontFamily: "monospace",
    fontWeight: "600",
  },
  rcRarityBadge: {
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 2,
    borderWidth: 1,
  },
  rcRarityText: { fontSize: 8, fontWeight: "900", fontFamily: "monospace", letterSpacing: 1 },
  rcWrPill: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 2,
    borderWidth: 1,
    minWidth: 46,
    alignItems: "center" as const,
  },
  rcWrText: { fontSize: 11, fontWeight: "900", fontFamily: "monospace" },
  rcMetaLine: { flexDirection: "row", alignItems: "center", marginBottom: 6 },
  rcMeta: { flex: 1, fontSize: 9.5, color: COLORS.textDim, fontFamily: "monospace" },
  rcMetaSep: { color: P.fade },
  rcMetaTp: { color: COLORS.bull, fontWeight: "800" },
  rcMetaSl: { color: COLORS.bear, fontWeight: "800" },
  rcNet: { fontSize: 11, fontWeight: "900", fontFamily: "monospace", marginLeft: 8 },
  rcEquityRow: { flexDirection: "row" as const, alignItems: "center" as const, marginBottom: 6, gap: 8 },
  rcTrendCol: { flexDirection: "column" as const, alignItems: "flex-start" as const, gap: 2 },
  rcTrendBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 3, borderWidth: 1 },
  rcTrendText: { fontSize: 9, fontWeight: "800" as const, fontFamily: "monospace", letterSpacing: 0.5 },
  rcDdText: { fontSize: 9, color: COLORS.textMuted, fontFamily: "monospace" },
  rcAgeText: { fontSize: 9, fontFamily: "monospace", marginLeft: 4 },
  tabFiring: { borderWidth: 1, borderColor: COLORS.bitcoin + "90" },
  tabFireBadge: { position: "absolute" as const, top: -4, right: -4, backgroundColor: COLORS.bitcoin, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 8 },
  tabFireBadgeText: { color: "#000", fontSize: 8, fontWeight: "900" as const, fontFamily: "monospace" },
  modalBackdrop: { flex: 1, backgroundColor: "#000000c0", justifyContent: "center" as const, alignItems: "center" as const, padding: 20 },
  modalCard: { backgroundColor: P.card, borderRadius: 8, padding: 16, alignItems: "center" as const, gap: 10, borderWidth: 1, borderColor: P.dim + "40" },
  modalTitle: { color: P.text, fontSize: 12, fontWeight: "800" as const, fontFamily: "monospace", letterSpacing: 1 },
  modalMeta: { color: COLORS.textDim, fontSize: 11, fontFamily: "monospace" },
  modalHint: { color: COLORS.textMuted, fontSize: 9, fontFamily: "monospace", fontStyle: "italic" as const, marginTop: 4 },
  rcStatus: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 2,
    borderWidth: 1,
    marginBottom: 4,
  },
  rcStatusIcon: { fontSize: 13 },
  rcStatusText: { flex: 1, fontSize: 10.5, fontWeight: "800", fontFamily: "monospace", letterSpacing: 0.3 },
  rcFireBadge: {
    marginTop: 4,
    paddingVertical: 6,
    borderRadius: 2,
    backgroundColor: COLORS.bitcoin + "25",
    borderWidth: 1,
    borderColor: COLORS.bitcoin,
    alignItems: "center" as const,
  },
  rcFireBadgeText: { color: COLORS.bitcoin, fontSize: 10, fontWeight: "900", fontFamily: "monospace", letterSpacing: 2 },
  rcCondGroup: {
    marginTop: 4,
    paddingHorizontal: 8,
    paddingVertical: 5,
    backgroundColor: "#ffffff06",
    borderRadius: 2,
    borderLeftWidth: 2,
    borderLeftColor: "#ffffff14",
  },
  rcCondTitle: {
    fontSize: 8,
    fontWeight: "800",
    fontFamily: "monospace",
    letterSpacing: 1,
    color: COLORS.textDim,
    marginBottom: 3,
  },
  rcCondRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 1.5,
  },
  rcCondIcon: { width: 12, fontSize: 11, fontWeight: "900", fontFamily: "monospace", textAlign: "center" as const },
  rcCondLabel: { flex: 1, fontSize: 9.5, fontFamily: "monospace", fontWeight: "600" },
  rcCondLive: { fontSize: 9, fontFamily: "monospace", fontWeight: "700" },
  rcChevron: {
    color: COLORS.textMuted,
    fontSize: 9,
    fontFamily: "monospace",
    textAlign: "right" as const,
    marginTop: 6,
    fontStyle: "italic" as const,
  },
});
