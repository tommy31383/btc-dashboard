import React, { useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { COLORS } from "../utils/constants";
import { P } from "../utils/v2Theme";
import { AccentBar } from "./v2/Primitives";
import { MaterialIcon } from "./v2/MaterialIcon";
import { RuleAlert, LiveCondSnapshot, RuleMatchDetail } from "../hooks/useRuleAlerts";
import { getHardRules } from "../utils/hardRules";

const INTERVAL_MIN: Record<string, number> = {
  "5m": 5, "15m": 15, "1h": 60, "4h": 240, "1d": 1440, "1w": 10080,
};

function getTfDays(tfKey: string): number {
  try {
    const data = getHardRules();
    const tfData = data.tfs[tfKey];
    if (!tfData) return 0;
    const min = INTERVAL_MIN[tfData.interval] || 60;
    return (tfData.candles_used * min) / 60 / 24;
  } catch { return 0; }
}

interface Props {
  alerts: RuleAlert[];
  /** Live indicator values keyed by tfKey — used to show current values
   *  vs the rule's thresholds in the expanded detail view. */
  liveConditions?: Record<string, LiveCondSnapshot>;
  /** Per-rule detailed match info — tells which of the 5 conditions are
   *  currently met under each rule's own thresholds. */
  ruleMatchDetails?: Record<string, RuleMatchDetail>;
  /** Optional: called when user wants to jump to this rule in the list below.
   *  Shown as a small button inside the expanded details. */
  onAlertTap?: (ruleId: string) => void;
}

const COND_LABEL: Record<string, string> = {
  stochExtreme: "StochRSI cực",
  rsiExtreme: "RSI cực",
  divergence: "Phân kỳ",
  bollingerTouch: "Chạm Bollinger",
  macdCross: "MACD đảo chiều",
  candleReversal: "Đảo chiều nến 4H",
  price_above_ema50: "Giá trên EMA50",
  price_below_ema50: "Giá dưới EMA50",
};

/**
 * Big prominent banner shown at the top when ANY tracked rule is currently
 * firing. Lists all active alerts with full entry/TP/SL info so user can act
 * immediately. Glows red for SHORT, green for LONG.
 *
 * Tap a card → toggle inline detail view (show/hide rule config + thresholds
 * + backtest stats). A small "Xem trong list" button inside the expanded area
 * scrolls to the matching rule in TradingRulesPanel below.
 */
export default function RuleAlertBanner({ alerts, liveConditions = {}, ruleMatchDetails = {}, onAlertTap }: Props) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  if (alerts.length === 0) return null;

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <View style={styles.container}>
      <AccentBar color={P.bitcoinOrange} glow />
      <View style={styles.crownHeader}>
        <View style={styles.firingDot} />
        <Text style={styles.crownTitle}>
          SIGNAL LIVE · {alerts.length} RULE FIRING
        </Text>
        <View style={styles.firingBadge}>
          <Text style={styles.firingBadgeText}>{alerts.length} ACTIVE</Text>
        </View>
      </View>
      <Text style={styles.tapHint}>Tap rule to expand/collapse</Text>
      <View style={styles.list}>
        {alerts.map((alert, idx) => {
          const isLong = alert.side === "LONG";
          const cfg = alert.rule.config as any;
          const stats = alert.rule.stats as any;
          const lev = cfg.leverage || 100;
          const expanded = expandedIds.has(alert.id);
          return (
            <TouchableOpacity
              key={alert.id}
              activeOpacity={0.7}
              onPress={() => toggleExpand(alert.id)}
              style={[styles.alertCard, isLong ? styles.alertLong : styles.alertShort]}
            >
              <View style={styles.alertHeader}>
                <View style={[styles.iconBox, { backgroundColor: (isLong ? P.green : P.error) + "33" }]}>
                  <MaterialIcon
                    name={isLong ? "north_east" : "south_east"}
                    size={18}
                    color={isLong ? P.green : P.error}
                  />
                </View>
                <Text style={[styles.sideTag, isLong ? styles.sideTagLong : styles.sideTagShort]}>
                  {isLong ? "LONG" : "SHORT"}
                </Text>
                <Text style={styles.ruleTitle} numberOfLines={1}>
                  {alert.tfKey.toUpperCase()} · {stats.trades ? `${stats.trades} trades` : "rule"}
                </Text>
                <View style={styles.rankBadge}>
                  <Text style={styles.rankBadgeText}>#{alert.rule.rank}</Text>
                </View>
              </View>

              {/* Stats row 1: WR/PF/NET — gold accents */}
              <View style={styles.cardStats}>
                <View style={styles.statPill}>
                  <Text style={styles.statPillLabel}>WR</Text>
                  <Text style={[styles.statPillVal, {
                    color: stats.winRate >= 55 ? "#2ed573" : stats.winRate >= 40 ? "#d4af37" : "#ff6b78",
                  }]}>{stats.winRate}%</Text>
                </View>
                <View style={styles.statPill}>
                  <Text style={styles.statPillLabel}>PF</Text>
                  <Text style={styles.statPillVal}>
                    {stats.profitFactor === 999 ? "∞" : stats.profitFactor.toFixed(1)}
                  </Text>
                </View>
                {stats.netPnL !== undefined && (
                  <View style={styles.statPill}>
                    <Text style={styles.statPillLabel}>NET</Text>
                    <Text style={[styles.statPillVal, { color: stats.netPnL >= 0 ? "#2ed573" : "#ff6b78" }]}>
                      {stats.netPnL >= 0 ? "+" : ""}{stats.netPnL > 1000 ? `${(stats.netPnL / 1000).toFixed(1)}K` : stats.netPnL}%
                    </Text>
                  </View>
                )}
              </View>

              {/* Stats row 2: AVG Win/Loss + Monthly PnL
                  NOTE: avgWinPct/avgLossPct are ALREADY leveraged (see backtester.ts:420-425,
                  `leveragedPnlPct` = pnl × leverage). Do NOT multiply by `lev` again. */}
              <View style={styles.cardStats}>
                {stats.avgWinPct !== undefined && (
                  <View style={styles.statPill}>
                    <Text style={styles.statPillLabel}>TB THẮNG</Text>
                    <Text style={[styles.statPillVal, { color: "#2ed573" }]}>
                      +{Math.round(stats.avgWinPct)}%
                    </Text>
                  </View>
                )}
                {stats.avgLossPct !== undefined && (
                  <View style={styles.statPill}>
                    <Text style={styles.statPillLabel}>TB THUA</Text>
                    <Text style={[styles.statPillVal, { color: "#ff6b78" }]}>
                      -{Math.round(Math.abs(stats.avgLossPct))}%
                    </Text>
                  </View>
                )}
                {(() => {
                  const days = getTfDays(alert.tfKey);
                  if (stats.netPnL === undefined || days <= 0) return null;
                  const monthly = Math.round((stats.netPnL / days) * 30);
                  return (
                    <View style={styles.statPill}>
                      <Text style={styles.statPillLabel}>/THÁNG</Text>
                      <Text style={[styles.statPillVal, { color: monthly >= 0 ? "#2ed573" : "#ff6b78" }]}>
                        {monthly >= 0 ? "+" : ""}
                        {Math.abs(monthly) > 1000 ? `${(monthly / 1000).toFixed(1)}K` : String(monthly)}%
                      </Text>
                    </View>
                  );
                })()}
              </View>
              <View style={styles.priceGrid}>
                <View style={styles.priceBox}>
                  <Text style={styles.priceLabel}>VÀO LỆNH</Text>
                  <Text style={[styles.priceVal, { color: COLORS.bitcoin }]}>
                    ${alert.entryPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  </Text>
                </View>
                <View style={styles.priceBox}>
                  <Text style={styles.priceLabel}>TP (chốt lời)</Text>
                  <Text style={[styles.priceVal, { color: COLORS.bull }]}>
                    ${alert.tpPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  </Text>
                  <Text style={styles.priceSub}>+{(cfg.targetPct * lev).toFixed(0)}% PnL</Text>
                </View>
                <View style={styles.priceBox}>
                  <Text style={styles.priceLabel}>SL (cắt lỗ)</Text>
                  <Text style={[styles.priceVal, { color: COLORS.bear }]}>
                    ${alert.slPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  </Text>
                  <Text style={styles.priceSub}>-{(cfg.stopPct * lev).toFixed(0)}% PnL</Text>
                </View>
              </View>
              <Text style={styles.meta}>
                Đòn bẩy: <Text style={{ color: COLORS.text, fontWeight: "800" }}>x{lev}</Text>
                {" · "}R:R 1:{(cfg.targetPct / cfg.stopPct).toFixed(1)}
                {alert.htfStatus && (
                  <>
                    {" · 1H:"}<Text style={{ color: alert.htfStatus.trend1h === "UP" ? COLORS.bull : alert.htfStatus.trend1h === "DOWN" ? COLORS.bear : COLORS.textMuted }}>{alert.htfStatus.trend1h}</Text>
                    {" · 4H:"}<Text style={{ color: alert.htfStatus.trend4h === "UP" ? COLORS.bull : alert.htfStatus.trend4h === "DOWN" ? COLORS.bear : COLORS.textMuted }}>{alert.htfStatus.trend4h}</Text>
                  </>
                )}
              </Text>

              {expanded && (() => {
                const live = liveConditions[alert.tfKey];
                const detail = ruleMatchDetails[alert.id];
                // Decide which side's thresholds to show: LONG → OS, SHORT → OB
                const checkSide: "LONG" | "SHORT" = alert.side === "SHORT" ? "SHORT" : "LONG";
                const stochThreshold = checkSide === "LONG" ? (cfg.stochOSLevel ?? 5) : (cfg.stochOBLevel ?? 95);
                const rsiThreshold = checkSide === "LONG" ? (cfg.rsiOSLevel ?? 25) : (cfg.rsiOBLevel ?? 75);
                const stochOp = checkSide === "LONG" ? "<" : ">";
                const rsiOp = checkSide === "LONG" ? "<" : ">";
                const stochLive = live?.stochK;
                const rsiLive = live?.rsi;
                const stochMatch = stochLive !== null && stochLive !== undefined && (
                  checkSide === "LONG" ? stochLive < stochThreshold : stochLive > stochThreshold
                );
                const rsiMatch = rsiLive !== null && rsiLive !== undefined && (
                  checkSide === "LONG" ? rsiLive < rsiThreshold : rsiLive > rsiThreshold
                );
                return (
                <View style={styles.detailBox}>
                  <View style={styles.detailSection}>
                    <Text style={styles.detailTitle}>🎯 NGƯỠNG vs HIỆN TẠI ({checkSide})</Text>

                    {/* StochRSI row */}
                    <View style={styles.liveRow}>
                      <Text style={styles.liveLabel}>StochRSI</Text>
                      <View style={styles.liveCompare}>
                        <Text style={styles.liveCurrent}>
                          Hiện tại: <Text style={[styles.liveVal, { color: stochMatch ? COLORS.bull : COLORS.bear }]}>
                            {stochLive !== null && stochLive !== undefined ? `K=${stochLive.toFixed(1)}` : "—"}
                            {live?.stochD !== null && live?.stochD !== undefined && ` / D=${live.stochD.toFixed(1)}`}
                          </Text>
                        </Text>
                        <Text style={styles.liveReq}>
                          Cần: <Text style={styles.thresholdVal}>{stochOp}{stochThreshold}</Text>
                          {"  "}
                          <Text style={{ color: stochMatch ? COLORS.bull : COLORS.bear, fontWeight: "900" }}>
                            {stochMatch ? "✓ KHỚP" : "✗ KHÔNG KHỚP"}
                          </Text>
                        </Text>
                      </View>
                    </View>

                    {/* RSI row */}
                    <View style={styles.liveRow}>
                      <Text style={styles.liveLabel}>RSI</Text>
                      <View style={styles.liveCompare}>
                        <Text style={styles.liveCurrent}>
                          Hiện tại: <Text style={[styles.liveVal, { color: rsiMatch ? COLORS.bull : COLORS.bear }]}>
                            {rsiLive !== null && rsiLive !== undefined ? rsiLive.toFixed(1) : "—"}
                          </Text>
                        </Text>
                        <Text style={styles.liveReq}>
                          Cần: <Text style={styles.thresholdVal}>{rsiOp}{rsiThreshold}</Text>
                          {"  "}
                          <Text style={{ color: rsiMatch ? COLORS.bull : COLORS.bear, fontWeight: "900" }}>
                            {rsiMatch ? "✓ KHỚP" : "✗ KHÔNG KHỚP"}
                          </Text>
                        </Text>
                      </View>
                    </View>
                  </View>

                  {/* 5-condition status chips — shows which conditions actually fired.
                      Two metrics: total-true-out-of-5 vs rule-threshold-met. */}
                  {detail && (() => {
                    const condEntries = Object.entries(detail.condDetail);
                    const totalConds = condEntries.length; // always 5
                    const trueConds = condEntries.filter(([, v]) => v).length;
                    const thresholdOk = detail.matched >= detail.required;
                    return (
                      <View style={styles.detailSection}>
                        <Text style={styles.detailTitle}>
                          📋 ĐIỀU KIỆN KHỚP — {trueConds}/{totalConds}
                        </Text>
                        <Text style={[styles.detailText, { marginBottom: 6 }]}>
                          Ngưỡng rule: <Text style={{ ...styles.detailEmph, color: thresholdOk ? COLORS.bull : COLORS.bear }}>
                            {detail.matched}/{detail.required} {thresholdOk ? "✓ ĐỦ" : "✗ THIẾU"}
                          </Text>
                        </Text>
                        <View style={styles.chipRow}>
                          {condEntries.map(([k, v]) => (
                            <View key={k} style={[styles.condChip, v ? styles.condChipOn : styles.condChipOff]}>
                              <Text style={[styles.condChipText, { color: v ? COLORS.bull : COLORS.textMuted }]}>
                                {v ? "✓" : "✗"} {COND_LABEL[k] || k}
                              </Text>
                            </View>
                          ))}
                        </View>
                      </View>
                    );
                  })()}

                  <View style={styles.detailSection}>
                    <Text style={styles.detailTitle}>⚙️ LOGIC VÀO LỆNH</Text>
                    {cfg.requiredConditions?.length > 0 && (
                      <Text style={styles.detailText}>
                        Bắt buộc: <Text style={styles.detailEmph}>{cfg.requiredConditions.map((c: string) => COND_LABEL[c] || c).join(", ")}</Text>
                      </Text>
                    )}
                    {cfg.weights && (
                      <>
                        <Text style={styles.detailText}>
                          Weighted score ≥ <Text style={styles.detailEmph}>{cfg.minWeightedScore}</Text>
                        </Text>
                        <View style={styles.weightList}>
                          {Object.entries(cfg.weights).map(([k, w]) => (
                            (w as number) > 0 ? (
                              <Text key={k} style={styles.weightItem}>
                                {COND_LABEL[k] || k}: <Text style={styles.detailEmph}>×{w as number}</Text>
                              </Text>
                            ) : null
                          ))}
                        </View>
                      </>
                    )}
                    {!cfg.weights && cfg.minScore > 0 && (
                      <Text style={styles.detailText}>
                        Min score: <Text style={styles.detailEmph}>{cfg.minScore}</Text> điều kiện
                      </Text>
                    )}
                    {cfg.htfTrendFilter && (
                      <Text style={styles.detailText}>
                        HTF trend filter: <Text style={styles.detailEmph}>{cfg.htfTrendFilter.mode || cfg.htfTrendFilter}</Text>
                      </Text>
                    )}
                    {cfg.htfRsiFilter && (
                      <Text style={styles.detailText}>
                        HTF RSI filter: <Text style={styles.detailEmph}>{cfg.htfRsiFilter.tf} RSI {cfg.htfRsiFilter.op} {cfg.htfRsiFilter.value}</Text>
                        {detail?.htfRsiValue !== null && detail?.htfRsiValue !== undefined && (
                          <>  {" "}(hiện tại: <Text style={{ ...styles.detailEmph, color: detail?.htfRsiMatch ? COLORS.bull : COLORS.bear }}>{detail.htfRsiValue.toFixed(1)} {detail?.htfRsiMatch ? "✓" : "✗"}</Text>)</>
                        )}
                      </Text>
                    )}
                    <Text style={styles.detailText}>
                      Max hold: <Text style={styles.detailEmph}>{cfg.maxHoldBars}</Text> bars
                    </Text>
                  </View>

                  {/* v4.3.15 — Feature filters (atrFilter / macdHistFilter / emaDistFilter) */}
                  {detail?.featFiltersStatus && detail.featFiltersStatus.length > 0 && (
                    <View style={styles.detailSection}>
                      <Text style={styles.detailTitle}>
                        🧪 FEATURE FILTERS ({detail.featFiltersStatus.filter((s) => s.match).length}/{detail.featFiltersStatus.length} khớp)
                      </Text>
                      {detail.featFiltersStatus.map((fs, fi) => (
                        <View key={`ff-${fi}`} style={styles.htfFilterRow}>
                          <Text style={[styles.htfFilterMark, { color: fs.match ? COLORS.bull : COLORS.bear }]}>
                            {fs.match ? "✓" : "✗"}
                          </Text>
                          <View style={styles.htfFilterBody}>
                            <Text style={styles.htfFilterLabel}>{fs.label}</Text>
                            <Text style={[styles.htfFilterValue, { color: fs.match ? COLORS.bull : COLORS.textMuted }]}>
                              {fs.liveValue}
                            </Text>
                          </View>
                        </View>
                      ))}
                    </View>
                  )}

                  {/* htfFilters[] — extensible HTF filters (slope/compare/range/cross) */}
                  {detail?.htfFiltersStatus && detail.htfFiltersStatus.length > 0 && (
                    <View style={styles.detailSection}>
                      <Text style={styles.detailTitle}>
                        🔭 HTF FILTERS ({detail.htfFiltersStatus.filter((s) => s.match).length}/{detail.htfFiltersStatus.length} khớp)
                      </Text>
                      {detail.htfFiltersStatus.map((fs, fi) => (
                        <View key={fi} style={styles.htfFilterRow}>
                          <Text style={[styles.htfFilterMark, { color: fs.match ? COLORS.bull : COLORS.bear }]}>
                            {fs.match ? "✓" : "✗"}
                          </Text>
                          <View style={styles.htfFilterBody}>
                            <Text style={styles.htfFilterLabel}>{fs.label}</Text>
                            <Text style={[styles.htfFilterValue, { color: fs.match ? COLORS.bull : COLORS.textMuted }]}>
                              {fs.liveValue}
                            </Text>
                          </View>
                        </View>
                      ))}
                    </View>
                  )}

                  <View style={styles.detailSection}>
                    <Text style={styles.detailTitle}>📊 HIỆU SUẤT BACKTEST</Text>
                    <Text style={styles.detailText}>
                      Trades: <Text style={styles.detailEmph}>{stats.trades}</Text>
                      {" · "}Wins: <Text style={{ ...styles.detailEmph, color: COLORS.bull }}>{stats.wins}</Text>
                      {" · "}Losses: <Text style={{ ...styles.detailEmph, color: COLORS.bear }}>{stats.losses}</Text>
                    </Text>
                    <Text style={styles.detailText}>
                      Avg win: <Text style={{ ...styles.detailEmph, color: COLORS.bull }}>+{Math.round(stats.avgWinPct)}%</Text> PnL
                      {" · "}Avg loss: <Text style={{ ...styles.detailEmph, color: COLORS.bear }}>-{Math.round(Math.abs(stats.avgLossPct))}%</Text> PnL
                    </Text>
                    {stats.avgHoldBars > 0 ? (
                      <Text style={styles.detailText}>
                        Avg hold: <Text style={styles.detailEmph}>{stats.avgHoldBars}</Text> bars
                        {stats.timeouts > 0 && <>{" · "}Timeouts: <Text style={styles.detailEmph}>{stats.timeouts}</Text></>}
                      </Text>
                    ) : stats.timeouts > 0 ? (
                      <Text style={styles.detailText}>
                        Timeouts: <Text style={styles.detailEmph}>{stats.timeouts}</Text>
                      </Text>
                    ) : null}
                  </View>

                  {/* PnL Breakdown — Gross / Fee / NET / Monthly */}
                  {stats.netPnL !== undefined && (
                    <View style={styles.detailSection}>
                      <Text style={styles.detailTitle}>💰 CHI TIẾT PnL</Text>
                      {stats.grossPnL !== undefined && (
                        <Text style={styles.detailText}>
                          Gross PnL: <Text style={{ ...styles.detailEmph, color: COLORS.bull }}>+{stats.grossPnL.toLocaleString()}%</Text>
                        </Text>
                      )}
                      {stats.feeCost !== undefined && (
                        <Text style={styles.detailText}>
                          Phí Binance (0.05%×2×{lev}×{stats.trades}): <Text style={{ ...styles.detailEmph, color: COLORS.bear }}>-{stats.feeCost.toLocaleString()}%</Text>
                        </Text>
                      )}
                      <Text style={styles.detailText}>
                        NET PnL (sau fee): <Text style={{ ...styles.detailEmph, color: stats.netPnL >= 0 ? COLORS.bull : COLORS.bear }}>
                          {stats.netPnL >= 0 ? "+" : ""}{stats.netPnL.toLocaleString()}%
                        </Text>
                      </Text>
                      {(() => {
                        const days = getTfDays(alert.tfKey);
                        if (days <= 0) return null;
                        const monthly = Math.round((stats.netPnL / days) * 30);
                        return (
                          <Text style={styles.detailText}>
                            Trung bình/tháng: <Text style={{ ...styles.detailEmph, color: monthly >= 0 ? COLORS.bull : COLORS.bear }}>
                              ~{monthly >= 0 ? "+" : ""}{monthly.toLocaleString()}%/tháng
                            </Text>
                            {" · "}Test trên <Text style={styles.detailEmph}>{days.toFixed(0)} ngày</Text>
                          </Text>
                        );
                      })()}
                    </View>
                  )}

                  {onAlertTap && (
                    <TouchableOpacity
                      onPress={() => onAlertTap(alert.id)}
                      style={styles.viewInListBtn}
                      activeOpacity={0.7}
                    >
                      <Text style={styles.viewInListText}>📜 Xem trong danh sách rule bên dưới</Text>
                    </TouchableOpacity>
                  )}
                </View>
                );
              })()}

              <Text style={styles.tapPrompt}>
                {expanded ? "👆 Bấm để ẨN chi tiết" : "👆 Bấm để XEM chi tiết rule"}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const GOLD = P.primaryContainer;
const GOLD_LIGHT = P.primary;
const CREAM = P.text;
const NAVY = P.card;

const styles = StyleSheet.create({
  container: {
    backgroundColor: P.card,     // #1c1b1b surface-container-low
    borderRadius: 2,
    paddingLeft: 18,             // room for AccentBar border-l-4
    marginBottom: 10,
    overflow: "hidden" as const,
    position: "relative",
  },
  firingDot: {
    width: 8, height: 8, borderRadius: 999,
    backgroundColor: P.error,
  },
  firingBadge: {
    backgroundColor: P.error,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 2,
  },
  firingBadgeText: {
    color: P.onError,
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 0.8,
    fontFamily: "SpaceGrotesk_700Bold",
  },
  crownHeader: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 8,
    paddingTop: 12,
    paddingRight: 12,
    paddingBottom: 6,
  },
  crownTitle: {
    flex: 1,
    color: P.text,
    fontSize: 11,
    fontWeight: "700" as const,
    fontFamily: "SpaceGrotesk_700Bold",
    letterSpacing: 2,
    textTransform: "uppercase",
  },
  tapHint: { color: P.dim, fontSize: 10, fontFamily: "Inter_400Regular", marginBottom: 8, textAlign: "left", opacity: 0.7 },
  tapPrompt: { color: P.dim, fontSize: 9, fontFamily: "Inter_400Regular", fontStyle: "italic", textAlign: "right", marginTop: 4, opacity: 0.7 },
  list: { paddingRight: 12, paddingBottom: 12, gap: 8 },
  alertCard: {
    backgroundColor: P.cardAlt, // #201f1f surface-container
    borderRadius: 2,
    padding: 12,
    marginBottom: 0,
    borderLeftWidth: 4,
  },
  alertLong: { borderLeftColor: P.green },
  alertShort: { borderLeftColor: P.error },
  alertHeader: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 10 },
  iconBox: {
    width: 32, height: 32,
    alignItems: "center", justifyContent: "center",
    borderRadius: 2,
  },
  sideTag: {
    fontSize: 11,
    fontWeight: "900" as const,
    fontFamily: "JetBrainsMono_500Medium",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    borderWidth: 1,
    letterSpacing: 0.8,
  },
  sideTagLong: { color: COLORS.bull, backgroundColor: "#2ed57320", borderColor: "#2ed57360" },
  sideTagShort: { color: COLORS.bear, backgroundColor: "#ff475720", borderColor: "#ff475760" },
  ruleTitle: { color: CREAM, fontSize: 11, fontWeight: "700" as const, fontFamily: "JetBrainsMono_500Medium", flex: 1 },
  rankBadge: {
    backgroundColor: GOLD,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 0,
  },
  rankBadgeText: {
    color: "#1a1206",
    fontSize: 10,
    fontWeight: "900" as const,
    fontFamily: "JetBrainsMono_500Medium",
    letterSpacing: 0.5,
  },
  cardStats: {
    flexDirection: "row" as const,
    gap: 8,
    marginBottom: 8,
    flexWrap: "wrap" as const,
  },
  statPill: {
    backgroundColor: P.surface,
    borderWidth: 1,
    borderColor: P.border,
    borderRadius: 0,
    paddingHorizontal: 7,
    paddingVertical: 3,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 5,
  },
  statPillLabel: {
    color: GOLD,
    fontSize: 9,
    fontWeight: "800" as const,
    fontFamily: "JetBrainsMono_500Medium",
    letterSpacing: 0.5,
  },
  statPillVal: {
    color: CREAM,
    fontSize: 11,
    fontWeight: "900" as const,
    fontFamily: "JetBrainsMono_500Medium",
  },
  priceGrid: { flexDirection: "row", gap: 6, marginBottom: 6 },
  priceBox: { flex: 1, alignItems: "center", backgroundColor: P.surface, padding: 8, borderRadius: 0, borderWidth: 1, borderColor: P.border },
  priceLabel: { color: GOLD, fontSize: 9, fontWeight: "800", fontFamily: "JetBrainsMono_500Medium", letterSpacing: 0.5 },
  priceVal: { fontSize: 14, fontWeight: "900", fontFamily: "JetBrainsMono_500Medium", marginTop: 2 },
  priceSub: { color: CREAM, fontSize: 8, fontFamily: "JetBrainsMono_500Medium", marginTop: 2, opacity: 0.6 },
  meta: { color: CREAM, fontSize: 10, fontFamily: "JetBrainsMono_500Medium", marginTop: 4, opacity: 0.75 },
  // Expanded detail block
  detailBox: {
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: P.border,
    gap: 8,
  },
  detailSection: {
    backgroundColor: P.surface,
    padding: 8,
    borderRadius: 0,
    borderWidth: 1,
    borderColor: P.border,
    borderLeftWidth: 2,
    borderLeftColor: GOLD,
  },
  detailTitle: {
    color: GOLD,
    fontSize: 10,
    fontWeight: "900",
    fontFamily: "JetBrainsMono_500Medium",
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  detailText: {
    color: COLORS.textDim,
    fontSize: 10,
    fontFamily: "JetBrainsMono_500Medium",
    lineHeight: 16,
  },
  detailEmph: {
    color: COLORS.text,
    fontWeight: "800",
  },
  thresholdRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
  },
  thresholdItem: {
    color: COLORS.textDim,
    fontSize: 10,
    fontFamily: "JetBrainsMono_500Medium",
  },
  thresholdVal: {
    color: COLORS.warning,
    fontWeight: "900",
  },
  liveRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    paddingVertical: 4,
    borderTopWidth: 1,
    borderTopColor: "#ffffff08",
  },
  liveLabel: {
    width: 70,
    color: COLORS.bitcoin,
    fontSize: 11,
    fontWeight: "900",
    fontFamily: "JetBrainsMono_500Medium",
    paddingTop: 2,
  },
  liveCompare: {
    flex: 1,
    gap: 2,
  },
  liveCurrent: {
    color: COLORS.textDim,
    fontSize: 10,
    fontFamily: "JetBrainsMono_500Medium",
  },
  liveVal: {
    fontWeight: "900",
    fontSize: 11,
  },
  liveReq: {
    color: COLORS.textDim,
    fontSize: 10,
    fontFamily: "JetBrainsMono_500Medium",
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
  },
  condChip: {
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 0,
    borderWidth: 1,
  },
  condChipOn: {
    backgroundColor: P.green + "15",
    borderColor: P.green + "60",
  },
  condChipOff: {
    backgroundColor: P.surface,
    borderColor: P.border,
  },
  condChipText: {
    fontSize: 10,
    fontWeight: "700",
    fontFamily: "JetBrainsMono_500Medium",
  },
  weightList: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 4,
  },
  weightItem: {
    color: COLORS.textDim,
    fontSize: 10,
    fontFamily: "JetBrainsMono_500Medium",
  },
  htfFilterRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    paddingVertical: 4,
    borderTopWidth: 1,
    borderTopColor: "#ffffff08",
  },
  htfFilterMark: {
    width: 14,
    fontSize: 13,
    fontWeight: "900",
    fontFamily: "JetBrainsMono_500Medium",
    paddingTop: 1,
  },
  htfFilterBody: {
    flex: 1,
    gap: 2,
  },
  htfFilterLabel: {
    color: COLORS.text,
    fontSize: 10,
    fontWeight: "700",
    fontFamily: "JetBrainsMono_500Medium",
  },
  htfFilterValue: {
    fontSize: 10,
    fontFamily: "JetBrainsMono_500Medium",
  },
  viewInListBtn: {
    backgroundColor: P.orange + "20",
    borderWidth: 1,
    borderColor: P.orange,
    borderRadius: 0,
    paddingVertical: 8,
    paddingHorizontal: 12,
    alignItems: "center",
  },
  viewInListText: {
    color: COLORS.bitcoin,
    fontSize: 11,
    fontWeight: "800",
    fontFamily: "JetBrainsMono_500Medium",
  },
});
