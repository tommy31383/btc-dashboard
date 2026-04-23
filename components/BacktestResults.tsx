import React, { useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator, TextInput } from "react-native";
import { COLORS, TIMEFRAMES } from "../utils/constants";
import { BacktestResult, BacktestConfig, OptimizeProgressInfo, OptimizeGridConfig, EvolveProgressInfo, EntryConditions, DEFAULT_BACKTEST_CONFIG, DEFAULT_GRID_CONFIG, RULE_SHAPE_PRESETS } from "../utils/backtester";
import { getHardRules, hasHardRules, HardRule } from "../utils/hardRules";
import { LiveSignalStats } from "../hooks/useLiveSignals";
import { BacktestStatus, ConfigByTF, OptByTF, LastRunByTF, RunningByTF, ConfigSourceByTF, ConfigSource } from "../hooks/useBacktest";

interface Props {
  backtestResults: BacktestResult[];
  optByTF: OptByTF;
  configByTF: ConfigByTF;
  liveStats: LiveSignalStats;
  loading: boolean;
  optLoading: boolean;
  status: BacktestStatus;
  optStatus: BacktestStatus;
  progress: string;
  progressPct: number;
  optProgress: string;
  optProgressPct: number;
  lastRun: number;
  lastOptRun: number;
  lastRunByTF: LastRunByTF;
  lastOptRunByTF: LastRunByTF;
  runningByTF: RunningByTF;
  runningOptByTF: RunningByTF;
  candleCountByTF: Record<string, number>;
  activeBacktestInfo: { tfKey: string; tfLabel: string; config: BacktestConfig } | null;
  activeOptInfo: { tfKey: string; tfLabel: string; progress: OptimizeProgressInfo } | null;
  activeEvoInfo: { tfKey: string; tfLabel: string; progress: EvolveProgressInfo } | null;
  onRunBacktest: () => void;
  onRunOptimizer: () => void;
  onRunEvolution: () => void;
  onRunEvolutionForTF: (tfKey: string) => void;
  onCancelEvolution: () => void;
  onClearCache: () => void;
  onApplyOptimizedAll: () => void;
  onApplyOptimizedForTF: (tfKey: string) => void;
  onApplyTopConfigForTF: (tfKey: string, rankIndex: number) => void;
  onApplyHardRuleForTF: (tfKey: string, config: BacktestConfig) => void;
  onRunBacktestForTF: (tfKey: string) => void;
  onRunOptimizerForTF: (tfKey: string) => void;
  onCancel: () => void;
  onCancelOptimizer: () => void;
  // Manual rule editor
  config: BacktestConfig;
  onSetConfig: (config: BacktestConfig) => void;
  onSetConfigForTF: (tfKey: string, config: BacktestConfig) => void;
  configSourceByTF: ConfigSourceByTF;
  // Grid search editor
  gridConfig: OptimizeGridConfig;
  onSetGridConfig: (next: OptimizeGridConfig) => void;
  onResetGridConfig: () => void;
}

const COND_LABELS: Record<string, string> = {
  stochExtreme: "StochRSI",
  rsiExtreme: "RSI",
  divergence: "Phân Kỳ",
  bollingerTouch: "Bollinger",
  macdCross: "MACD",
};

const COND_SHORT: Record<string, string> = {
  stochExtreme: "Stoch",
  rsiExtreme: "RSI",
  divergence: "Div",
  bollingerTouch: "BB",
  macdCross: "MACD",
};

/** Format a requiredConditions array into a human-readable rule shape label */
function formatRuleShape(req?: string[]): string {
  if (!req || req.length === 0) return "Bất kỳ";
  return req.map((k) => COND_SHORT[k] || k).join(" + ");
}

/** Safe leverage accessor — returns 100 if config or leverage is missing.
 *  Old cached configs from before the leverage display change might have
 *  leverage = undefined, which would make `targetPct * leverage` = NaN. */
function getLev(cfg?: { leverage?: number }): number {
  return cfg?.leverage ?? 100;
}

/** Safe number — returns 0 if value is null/undefined/NaN */
function safeNum(v: any): number {
  return typeof v === "number" && !isNaN(v) ? v : 0;
}

function WinRateBar({ rate, total }: { rate: number; total: number }) {
  const color = rate >= 70 ? COLORS.bull : rate >= 50 ? COLORS.warning : COLORS.bear;
  return (
    <View style={styles.wrBarContainer}>
      <View style={styles.wrBarBg}>
        <View style={[styles.wrBarFill, { width: `${Math.min(rate, 100)}%`, backgroundColor: color }]} />
      </View>
      <Text style={[styles.wrBarText, { color }]}>{rate.toFixed(0)}%</Text>
      <Text style={styles.wrBarCount}>({total})</Text>
    </View>
  );
}

const STATUS_CONFIG: Record<BacktestStatus, { icon: string; color: string; label: string }> = {
  IDLE: { icon: "○", color: COLORS.textMuted, label: "Chưa chạy" },
  LOADED: { icon: "⛃", color: COLORS.warning, label: "Từ cache" },
  RUNNING: { icon: "◉", color: COLORS.bitcoin, label: "Đang chạy" },
  DONE: { icon: "✓", color: COLORS.bull, label: "Hoàn tất" },
  ERROR: { icon: "✕", color: COLORS.bear, label: "Lỗi" },
};

function formatAge(ms: number): string {
  if (ms < 60000) return `${Math.floor(ms / 1000)}s trước`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m trước`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h trước`;
  return `${Math.floor(ms / 86400000)}d trước`;
}

function BacktestResultsInner({
  backtestResults,
  optByTF,
  configByTF,
  liveStats,
  loading,
  optLoading,
  status,
  optStatus,
  progress,
  progressPct,
  optProgress,
  optProgressPct,
  lastRun,
  lastOptRun,
  lastRunByTF,
  lastOptRunByTF,
  runningByTF,
  runningOptByTF,
  candleCountByTF,
  activeBacktestInfo,
  activeOptInfo,
  activeEvoInfo,
  onRunBacktest,
  onRunOptimizer,
  onRunEvolution,
  onRunEvolutionForTF,
  onCancelEvolution,
  onClearCache,
  onApplyOptimizedAll,
  onApplyOptimizedForTF,
  onApplyTopConfigForTF,
  onApplyHardRuleForTF,
  onRunBacktestForTF,
  onRunOptimizerForTF,
  onCancel,
  onCancelOptimizer,
  config,
  onSetConfig,
  onSetConfigForTF,
  configSourceByTF,
  gridConfig,
  onSetGridConfig,
  onResetGridConfig,
}: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);
  // "tfKey:rank" of the top-config whose full stats are currently visible.
  const [expandedTop, setExpandedTop] = useState<string | null>(null);
  // Which TF's "Top bộ rule" list is expanded (shows all top configs)
  const [expandedTopList, setExpandedTopList] = useState<string | null>(null);
  const statusCfg = STATUS_CONFIG[status];
  const optStatusCfg = STATUS_CONFIG[optStatus];
  const hasData = backtestResults.length > 0;
  const hasOpt = Object.keys(optByTF).length > 0;
  const ageMs = lastRun > 0 ? Date.now() - lastRun : 0;
  const optAgeMs = lastOptRun > 0 ? Date.now() - lastOptRun : 0;
  const isStale = ageMs > 3600000;

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>BACKTEST & TỐI ƯU</Text>
        <View style={styles.btnGroup}>
          {hasData && !loading && (
            <TouchableOpacity onPress={onClearCache} style={styles.clearBtn} disabled={loading}>
              <Text style={styles.clearBtnText}>Xóa</Text>
            </TouchableOpacity>
          )}
          {loading ? (
            <TouchableOpacity onPress={onCancel} style={styles.stopBtn}>
              <Text style={styles.stopBtnText}>■ DỪNG</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity onPress={onRunBacktest} style={styles.runBtn}>
              <Text style={styles.runBtnText}>
                {hasData ? "Chạy lại" : "Chạy"}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Status indicator */}
      <View style={styles.statusRow}>
        <View style={[styles.statusDot, { backgroundColor: statusCfg.color }]}>
          <Text style={styles.statusDotText}>{statusCfg.icon}</Text>
        </View>
        <Text style={[styles.statusLabel, { color: statusCfg.color }]}>
          {statusCfg.label}
        </Text>
        {progress ? (
          <Text style={styles.progressText} numberOfLines={1}>{progress}</Text>
        ) : null}
        {lastRun > 0 && status !== "RUNNING" && (
          <Text style={[styles.lastRun, isStale && { color: COLORS.warning }]}>
            {formatAge(ageMs)}
          </Text>
        )}
      </View>

      {/* Stale warning */}
      {hasData && isStale && status !== "RUNNING" && (
        <View style={styles.staleWarn}>
          <Text style={styles.staleWarnText}>
            ⚠ Dữ liệu đã cũ ({formatAge(ageMs)}) — nhấn "Chạy lại" để cập nhật
          </Text>
        </View>
      )}

      {/* Empty state — no cached data */}
      {!hasData && status !== "RUNNING" && (
        <View style={styles.emptyBox}>
          <Text style={styles.emptyText}>
            Chưa có dữ liệu backtest. Nhấn "Chạy" để quét 1000 nến × 6 khung thời gian.
          </Text>
          <Text style={styles.emptyHint}>
            ⏱ Mất khoảng 15–30 giây. Dữ liệu sẽ được lưu để dùng lại.
          </Text>
        </View>
      )}

      {/* Progress bar when running */}
      {status === "RUNNING" && (
        <View style={styles.progressBarBg}>
          <View style={[styles.progressBarFill, { width: `${progressPct}%` }]} />
        </View>
      )}

      {/* Live rule being used — shows WHILE backtest is running */}
      {activeBacktestInfo && (
        <View style={styles.liveRulePanel}>
          <Text style={styles.liveRuleTitle}>
            ⚙ ĐANG BACKTEST {activeBacktestInfo.tfLabel} · Rule:
          </Text>
          <View style={styles.liveRuleChips}>
            <RuleChip label="Score" value={`≥${activeBacktestInfo.config.minScore}`} />
            <RuleChip label="Stoch" value={`<${activeBacktestInfo.config.stochOSLevel}/>${activeBacktestInfo.config.stochOBLevel}`} />
            <RuleChip label="RSI" value={`<${activeBacktestInfo.config.rsiOSLevel}/>${activeBacktestInfo.config.rsiOBLevel}`} />
            <RuleChip label="TP PnL" value={`+${(activeBacktestInfo.config.targetPct * activeBacktestInfo.config.leverage).toFixed(0)}%`} color={COLORS.bull} />
            <RuleChip label="SL PnL" value={`-${(activeBacktestInfo.config.stopPct * activeBacktestInfo.config.leverage).toFixed(0)}%`} color={COLORS.bear} />
            <RuleChip label="x" value={`${activeBacktestInfo.config.leverage}`} />
            <RuleChip label="R:R" value={`1:${(activeBacktestInfo.config.targetPct / activeBacktestInfo.config.stopPct).toFixed(1)}`} />
          </View>
        </View>
      )}

      {/* Live Stats */}
      {liveStats.totalSignals > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>KẾT QUẢ LIVE</Text>
          <View style={styles.statGrid}>
            <StatBox label="Tổng" value={`${liveStats.totalSignals}`} color={COLORS.text} />
            <StatBox label="Đang theo" value={`${liveStats.activeSignals}`} color={COLORS.bitcoin} />
            <StatBox label="Thắng" value={`${liveStats.wins}`} color={COLORS.bull} />
            <StatBox label="Thua" value={`${liveStats.losses}`} color={COLORS.bear} />
            <StatBox
              label="Win Rate"
              value={`${liveStats.winRate.toFixed(0)}%`}
              color={liveStats.winRate >= 60 ? COLORS.bull : liveStats.winRate >= 40 ? COLORS.warning : COLORS.bear}
            />
          </View>

          {/* Live per-score breakdown */}
          {Object.entries(liveStats.scoreStats).some(([, v]) => v.total > 0) && (
            <View style={styles.scoreGrid}>
              <Text style={styles.subLabel}>Win rate theo điểm (Live):</Text>
              {Object.entries(liveStats.scoreStats)
                .filter(([, v]) => v.total > 0)
                .map(([score, v]) => (
                  <View key={score} style={styles.scoreRow}>
                    <Text style={styles.scoreLabel}>Score {score}:</Text>
                    <WinRateBar rate={v.winRate} total={v.total} />
                  </View>
                ))}
            </View>
          )}
        </View>
      )}

      {/* ===== HARD RULES — pre-baked top rules from offline analysis.
            Bundled in app via assets/hard_rules.json. User gets sane rules
            without waiting for optimizer. ===== */}
      <HardRulesPanel
        configByTF={configByTF}
        onApplyHardRule={onApplyHardRuleForTF}
      />

      {/* ===== ACTIVE RULES — the "what rule is running for each TF right now"
            panel. This is the SINGLE COMMAND CENTER: shows current rule per
            TF, current backtest WR/PF, plus all per-TF actions
            (Test/Grid/GA/Edit) inline. Replaces the old separate per-TF
            backtest + optimizer lists. ===== */}
      <ActiveRulesPanel
        configByTF={configByTF}
        configSourceByTF={configSourceByTF}
        backtestResults={backtestResults}
        optByTF={optByTF}
        runningByTF={runningByTF}
        runningOptByTF={runningOptByTF}
        candleCountByTF={candleCountByTF}
        lastRunByTF={lastRunByTF}
        lastOptRunByTF={lastOptRunByTF}
        loading={loading}
        optLoading={optLoading}
        onRunBacktestForTF={onRunBacktestForTF}
        onRunOptimizerForTF={onRunOptimizerForTF}
        onRunEvolutionForTF={onRunEvolutionForTF}
        onApplyOptimizedForTF={onApplyOptimizedForTF}
        onApplyTopConfigForTF={onApplyTopConfigForTF}
      />

      {/* Manual rule editor — lets user set TP/SL/Score/Stoch/RSI + rule shape
          directly without running the optimizer. Applies to ALL TFs or one TF. */}
      <ManualRuleEditor
        config={config}
        onApplyAll={(cfg) => onSetConfig(cfg)}
        onApplyToTF={(tfKey, cfg) => onSetConfigForTF(tfKey, cfg)}
      />

      {/* (Standalone "CHẠY BACKTEST TỪNG KHUNG" section removed — actions
           are now inline in ActiveRulesPanel above. Each row has 📊 to test,
           ↻ to grid-optimize, 🧬 to evolve via GA.) */}

      {/* Backtest Results per TF */}
      {backtestResults.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>CHI TIẾT KẾT QUẢ (bấm để mở rộng)</Text>
          {backtestResults.map((r) => {
            const isExp = expanded === r.timeframe;
            return (
              <View key={r.timeframe}>
                <TouchableOpacity
                  style={styles.tfRow}
                  onPress={() => setExpanded(isExp ? null : r.timeframe)}
                >
                  <Text style={styles.tfLabel}>{r.timeframe}</Text>
                  <Text style={styles.tfTrades}>{r.totalSignals} lệnh</Text>
                  <WinRateBar rate={r.winRate} total={r.totalSignals} />
                  <Text style={[styles.tfPF, { color: r.profitFactor >= 1.5 ? COLORS.bull : r.profitFactor >= 1 ? COLORS.warning : COLORS.bear }]}>
                    PF:{r.profitFactor === Infinity ? "∞" : r.profitFactor.toFixed(1)}
                  </Text>
                </TouchableOpacity>

                {isExp && (
                  <View style={styles.expandedBox}>
                    {/* Rule detail — shows exactly which rules generated this result */}
                    {r.config && (
                      <View style={styles.ruleDetailBox}>
                        <Text style={styles.ruleDetailTitle}>⚙ BỘ RULE DÙNG CHO BACKTEST NÀY</Text>
                        <View style={styles.ruleDetailGrid}>
                          <RuleDetailRow
                            label="Hình dạng rule (điều kiện BẮT BUỘC)"
                            value={formatRuleShape(r.config.requiredConditions)}
                            color={(r.config.requiredConditions?.length || 0) > 0 ? COLORS.bull : COLORS.textDim}
                          />
                          <RuleDetailRow label="Min Score (điều kiện tối thiểu)" value={`≥ ${r.config.minScore} / 5`} />
                          <RuleDetailRow label="StochRSI Quá Bán / Quá Mua" value={`< ${r.config.stochOSLevel}  /  > ${r.config.stochOBLevel}`} />
                          <RuleDetailRow label="RSI Quá Bán / Quá Mua" value={`< ${r.config.rsiOSLevel}  /  > ${r.config.rsiOBLevel}`} />
                          <RuleDetailRow
                            label="Chốt Lời TP"
                            value={`+${(r.config.targetPct * r.config.leverage).toFixed(0)}% PnL  (giá +${r.config.targetPct.toFixed(2)}%)`}
                            color={COLORS.bull}
                          />
                          <RuleDetailRow
                            label="Cắt Lỗ SL"
                            value={`-${(r.config.stopPct * r.config.leverage).toFixed(0)}% PnL  (giá -${r.config.stopPct.toFixed(2)}%)`}
                            color={COLORS.bear}
                          />
                          <RuleDetailRow label="Đòn bẩy" value={`×${r.config.leverage}`} />
                          <RuleDetailRow label="Max nến giữ lệnh" value={`${r.config.maxHoldBars} nến`} />
                          <RuleDetailRow label="R:R (TP/SL)" value={`1 : ${(r.config.targetPct / r.config.stopPct).toFixed(2)}`} />
                          <RuleDetailRow label="Dữ liệu đã phân tích" value={`${r.candlesAnalyzed} nến`} />
                        </View>

                        {/* Weights (only present when GA-evolved) */}
                        {r.config.weights && (
                          <View style={styles.gaWeightsBox}>
                            <Text style={styles.gaWeightsTitle}>
                              🧬 TRỌNG SỐ HỌC (GA) · Vào lệnh khi tổng ≥ {r.config.minWeightedScore}
                            </Text>
                            <WeightsBar weights={r.config.weights} />
                          </View>
                        )}
                      </View>
                    )}

                    <View style={styles.miniGrid}>
                      <MiniStat label="Thắng" value={r.wins} color={COLORS.bull} />
                      <MiniStat label="Thua" value={r.losses} color={COLORS.bear} />
                      <MiniStat label="Timeout" value={r.timeouts} color={COLORS.textMuted} />
                      <MiniStat label="TB nến giữ" value={r.avgHoldBars.toFixed(0)} color={COLORS.text} />
                    </View>

                    {/* Headline PnL numbers */}
                    <View style={styles.pnlRow}>
                      <View style={styles.pnlBox}>
                        <Text style={styles.pnlLabel}>TB lệnh thắng</Text>
                        <Text style={[styles.pnlVal, { color: COLORS.bull }]}>+{r.avgWinPct.toFixed(2)}%</Text>
                      </View>
                      <View style={styles.pnlBox}>
                        <Text style={styles.pnlLabel}>TB lệnh thua</Text>
                        <Text style={[styles.pnlVal, { color: COLORS.bear }]}>-{Math.abs(r.avgLossPct).toFixed(2)}%</Text>
                      </View>
                      <View style={styles.pnlBox}>
                        <Text style={styles.pnlLabel}>Profit Factor</Text>
                        <Text style={[styles.pnlVal, {
                          color: r.profitFactor >= 1.5 ? COLORS.bull : r.profitFactor >= 1 ? COLORS.warning : COLORS.bear,
                        }]}>
                          {r.profitFactor === Infinity ? "∞" : r.profitFactor.toFixed(2)}
                        </Text>
                      </View>
                    </View>

                    <Text style={styles.subLabel}>Win rate theo điểm:</Text>
                    {Object.entries(r.scoreBreakdown)
                      .filter(([, v]) => v.total > 0)
                      .map(([score, v]) => (
                        <View key={score} style={styles.scoreRow}>
                          <Text style={styles.scoreLabel}>Score {score}:</Text>
                          <WinRateBar rate={v.winRate} total={v.total} />
                        </View>
                      ))}

                    <Text style={[styles.subLabel, { marginTop: 8 }]}>Win rate theo điều kiện:</Text>
                    {Object.entries(r.conditionWinRates)
                      .filter(([, v]) => v.total > 0)
                      .map(([key, v]) => (
                        <View key={key} style={styles.scoreRow}>
                          <Text style={styles.scoreLabel}>{COND_LABELS[key] || key}:</Text>
                          <WinRateBar rate={v.winRate} total={v.total} />
                        </View>
                      ))}

                    {r.bestCombo && (
                      <View style={styles.bestComboBox}>
                        <Text style={styles.bestComboTitle}>Combo tốt nhất:</Text>
                        <Text style={styles.bestComboText}>
                          {r.bestCombo.split("+").map((k) => COND_LABELS[k] || k).join(" + ")}
                        </Text>
                        <Text style={[styles.bestComboRate, { color: COLORS.bull }]}>
                          Win Rate: {r.bestComboWinRate.toFixed(0)}%
                        </Text>
                      </View>
                    )}
                  </View>
                )}
              </View>
            );
          })}
        </View>
      )}

      {/* Optimizer — manual trigger, per-TF + batch */}
      <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>TỐI ƯU TỪNG KHUNG</Text>
            {optLoading ? (
              <View style={{ flexDirection: "row", gap: 4 }}>
                <TouchableOpacity onPress={activeEvoInfo ? onCancelEvolution : onCancelOptimizer} style={styles.stopBtn}>
                  <Text style={styles.stopBtnText}>■ DỪNG</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={{ flexDirection: "row", gap: 4 }}>
                <TouchableOpacity
                  onPress={onRunEvolution}
                  style={styles.gaBtn}
                  disabled={loading}
                >
                  <Text style={styles.gaBtnText}>🧬 GA TẤT CẢ</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={onRunOptimizer}
                  style={styles.optRunBtn}
                  disabled={loading}
                >
                  <Text style={styles.optRunBtnText}>Grid TẤT CẢ</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
          <Text style={styles.gaHint}>
            🧬 GA = Genetic Algorithm: tiến hóa rule có TRỌNG SỐ qua 30 thế hệ. Tìm rule mà Grid Search bỏ sót.
            {"\n"}
            ⚙ Grid = thử các giá trị cố định trong "CHỈNH GRID SEARCH" bên dưới.
          </Text>

          <Text style={styles.sectionHint}>
            Dùng nút ↻ Grid hoặc 🧬 GA ở từng dòng RULE phía trên để chạy riêng từng khung.
            Hai nút TẤT CẢ ở đây để chạy cùng lúc cho mọi khung.
          </Text>

          {/* Opt status */}
          <View style={styles.statusRow}>
            <View style={[styles.statusDot, { backgroundColor: optStatusCfg.color }]}>
              <Text style={styles.statusDotText}>{optStatusCfg.icon}</Text>
            </View>
            <Text style={[styles.statusLabel, { color: optStatusCfg.color }]}>
              {optStatusCfg.label}
            </Text>
            {optProgress ? (
              <Text style={styles.progressText} numberOfLines={1}>{optProgress}</Text>
            ) : null}
            {lastOptRun > 0 && optStatus !== "RUNNING" && (
              <Text style={styles.lastRun}>{formatAge(optAgeMs)}</Text>
            )}
          </View>

          {optStatus === "RUNNING" && (
            <View style={styles.progressBarBg}>
              <View style={[styles.progressBarFill, { width: `${optProgressPct}%`, backgroundColor: COLORS.warning }]} />
            </View>
          )}

          {/* Live Genetic Algorithm progress */}
          {activeEvoInfo && (
            <View style={[styles.liveRulePanel, { borderLeftColor: COLORS.bull }]}>
              <Text style={[styles.liveRuleTitle, { color: COLORS.bull }]}>
                🧬 ĐANG TIẾN HÓA {activeEvoInfo.tfLabel} — Thế hệ {activeEvoInfo.progress.generation}/{activeEvoInfo.progress.totalGenerations}
              </Text>
              <Text style={styles.liveRuleSubtitle}>
                Đã đánh giá {activeEvoInfo.progress.evaluated} cá thể · population {activeEvoInfo.progress.population}
              </Text>

              {activeEvoInfo.progress.bestSoFar ? (
                <>
                  <Text style={[styles.liveRuleSection, { color: COLORS.bull, marginTop: 8 }]}>
                    ★ CÁ THỂ TỐT NHẤT HIỆN TẠI:
                  </Text>
                  <View style={styles.liveBestStatsRow}>
                    <View style={styles.liveBestStatBox}>
                      <Text style={styles.liveBestStatVal}>
                        {activeEvoInfo.progress.bestSoFar.winRate.toFixed(0)}%
                      </Text>
                      <Text style={styles.liveBestStatLabel}>Win Rate</Text>
                    </View>
                    <View style={styles.liveBestStatBox}>
                      <Text style={[styles.liveBestStatVal, { color: activeEvoInfo.progress.bestSoFar.profitFactor >= 1.5 ? COLORS.bull : COLORS.warning }]}>
                        {activeEvoInfo.progress.bestSoFar.profitFactor === Infinity ? "∞" : activeEvoInfo.progress.bestSoFar.profitFactor.toFixed(2)}
                      </Text>
                      <Text style={styles.liveBestStatLabel}>Profit Factor</Text>
                    </View>
                    <View style={styles.liveBestStatBox}>
                      <Text style={[styles.liveBestStatVal, { color: COLORS.text }]}>
                        {activeEvoInfo.progress.bestSoFar.trades}
                      </Text>
                      <Text style={styles.liveBestStatLabel}>Số lệnh</Text>
                    </View>
                  </View>

                  {/* Show learned weights */}
                  <Text style={styles.liveRuleSection}>Trọng số đã học:</Text>
                  <WeightsBar weights={activeEvoInfo.progress.bestSoFar.config.weights} />
                  <Text style={styles.manualHint}>
                    Tín hiệu có weight cao = quan trọng hơn. Signal score ≥ {activeEvoInfo.progress.bestSoFar.config.minWeightedScore} để vào lệnh.
                  </Text>
                </>
              ) : (
                <Text style={styles.liveRuleHint}>
                  Chưa có cá thể nào đạt ngưỡng (cần ≥ 5 lệnh). Đợi thế hệ tiếp theo...
                </Text>
              )}
            </View>
          )}

          {/* Live optimizer rule — shows current combo being tested + best-so-far */}
          {activeOptInfo && (
            <View style={[styles.liveRulePanel, { borderLeftColor: COLORS.warning }]}>
              {/* ============ PANEL 1: đang thử combo nào ============ */}
              <Text style={[styles.liveRuleTitle, { color: COLORS.warning }]}>
                ⚙ ĐANG TỐI ƯU {activeOptInfo.tfLabel}
              </Text>
              <Text style={styles.liveRuleSubtitle}>
                Combo {activeOptInfo.progress.label} ({Math.round(activeOptInfo.progress.pct * 100)}%) · mỗi combo ~0.1–0.3s
              </Text>

              <Text style={styles.liveRuleSection}>▸ Rule đang thử:</Text>
              <View style={styles.liveRuleKVBox}>
                <KVRow
                  label="Hình dạng rule"
                  value={formatRuleShape(activeOptInfo.progress.currentConfig.requiredConditions) + ((activeOptInfo.progress.currentConfig.requiredConditions?.length || 0) > 0 ? " (BẮT BUỘC)" : "")}
                  valueColor={(activeOptInfo.progress.currentConfig.requiredConditions?.length || 0) > 0 ? COLORS.bull : COLORS.textDim}
                />
                <KVRow
                  label="Điều kiện tối thiểu"
                  value={`≥ ${activeOptInfo.progress.currentConfig.minScore} / 5`}
                />
                <KVRow
                  label="StochRSI Quá Bán / Quá Mua"
                  value={`< ${activeOptInfo.progress.currentConfig.stochOSLevel}  /  > ${activeOptInfo.progress.currentConfig.stochOBLevel}`}
                />
                <KVRow
                  label="RSI Quá Bán / Quá Mua"
                  value={`< ${activeOptInfo.progress.currentConfig.rsiOSLevel}  /  > ${activeOptInfo.progress.currentConfig.rsiOBLevel}`}
                />
                <KVRow
                  label="Chốt Lời (TP)"
                  value={`+${(activeOptInfo.progress.currentConfig.targetPct * activeOptInfo.progress.currentConfig.leverage).toFixed(0)}% PnL  (giá +${activeOptInfo.progress.currentConfig.targetPct.toFixed(2)}%)`}
                  valueColor={COLORS.bull}
                />
                <KVRow
                  label="Cắt Lỗ (SL)"
                  value={`-${(activeOptInfo.progress.currentConfig.stopPct * activeOptInfo.progress.currentConfig.leverage).toFixed(0)}% PnL  (giá -${activeOptInfo.progress.currentConfig.stopPct.toFixed(2)}%)`}
                  valueColor={COLORS.bear}
                />
                <KVRow
                  label="Đòn bẩy"
                  value={`x${activeOptInfo.progress.currentConfig.leverage}`}
                />
              </View>

              {/* ============ PANEL 2: combo tốt nhất tìm được đến giờ ============ */}
              {activeOptInfo.progress.bestSoFar ? (
                <>
                  <Text style={[styles.liveRuleSection, { color: COLORS.bull, marginTop: 10 }]}>
                    ★ BỘ RULE TỐT NHẤT TÌM ĐƯỢC ĐẾN BÂY GIỜ:
                  </Text>

                  {/* Stats headline: WR, PF, số lệnh */}
                  <View style={styles.liveBestStatsRow}>
                    <View style={styles.liveBestStatBox}>
                      <Text style={styles.liveBestStatVal}>
                        {activeOptInfo.progress.bestSoFar.winRate.toFixed(0)}%
                      </Text>
                      <Text style={styles.liveBestStatLabel}>Win Rate</Text>
                      <Text style={styles.liveBestStatHint}>% số lệnh thắng</Text>
                    </View>
                    <View style={styles.liveBestStatBox}>
                      <Text style={[styles.liveBestStatVal, { color: activeOptInfo.progress.bestSoFar.profitFactor >= 1.5 ? COLORS.bull : COLORS.warning }]}>
                        {activeOptInfo.progress.bestSoFar.profitFactor === Infinity ? "∞" : activeOptInfo.progress.bestSoFar.profitFactor.toFixed(2)}
                      </Text>
                      <Text style={styles.liveBestStatLabel}>Profit Factor</Text>
                      <Text style={styles.liveBestStatHint}>Tổng lời / Tổng lỗ</Text>
                    </View>
                    <View style={styles.liveBestStatBox}>
                      <Text style={[styles.liveBestStatVal, { color: COLORS.text }]}>
                        {activeOptInfo.progress.bestSoFar.trades}
                      </Text>
                      <Text style={styles.liveBestStatLabel}>Số lệnh</Text>
                      <Text style={styles.liveBestStatHint}>trên 1000 nến</Text>
                    </View>
                  </View>

                  <View style={styles.liveRuleKVBox}>
                    <KVRow
                      label="Hình dạng rule"
                      value={formatRuleShape(activeOptInfo.progress.bestSoFar.config.requiredConditions) + ((activeOptInfo.progress.bestSoFar.config.requiredConditions?.length || 0) > 0 ? " (BẮT BUỘC)" : "")}
                      valueColor={COLORS.bull}
                    />
                    <KVRow
                      label="Điều kiện tối thiểu"
                      value={`≥ ${activeOptInfo.progress.bestSoFar.config.minScore} / 5`}
                    />
                    <KVRow
                      label="StochRSI Quá Bán / Quá Mua"
                      value={`< ${activeOptInfo.progress.bestSoFar.config.stochOSLevel}  /  > ${activeOptInfo.progress.bestSoFar.config.stochOBLevel}`}
                    />
                    <KVRow
                      label="RSI Quá Bán / Quá Mua"
                      value={`< ${activeOptInfo.progress.bestSoFar.config.rsiOSLevel}  /  > ${activeOptInfo.progress.bestSoFar.config.rsiOBLevel}`}
                    />
                    <KVRow
                      label="Chốt Lời (TP)"
                      value={`+${(activeOptInfo.progress.bestSoFar.config.targetPct * activeOptInfo.progress.bestSoFar.config.leverage).toFixed(0)}% PnL  (giá +${activeOptInfo.progress.bestSoFar.config.targetPct.toFixed(2)}%)`}
                      valueColor={COLORS.bull}
                    />
                    <KVRow
                      label="Cắt Lỗ (SL)"
                      value={`-${(activeOptInfo.progress.bestSoFar.config.stopPct * activeOptInfo.progress.bestSoFar.config.leverage).toFixed(0)}% PnL  (giá -${activeOptInfo.progress.bestSoFar.config.stopPct.toFixed(2)}%)`}
                      valueColor={COLORS.bear}
                    />
                    <KVRow
                      label="Đòn bẩy"
                      value={`x${activeOptInfo.progress.bestSoFar.config.leverage}`}
                    />
                    <KVRow
                      label="Tỉ lệ Lời/Lỗ (R:R)"
                      value={`1 : ${(activeOptInfo.progress.bestSoFar.config.targetPct / activeOptInfo.progress.bestSoFar.config.stopPct).toFixed(2)}`}
                    />
                  </View>

                  {/* Explainer */}
                  <Text style={styles.liveExplainer}>
                    💡 Win Rate có thể &lt;50% mà vẫn lời — nếu Profit Factor &gt; 1 (lời mỗi lệnh lớn hơn lỗ). Ví dụ WR 46% + PF 2.0 nghĩa là thua nhiều hơn thắng nhưng tổng cuộc vẫn LỜI gấp 2.
                  </Text>
                </>
              ) : (
                <Text style={styles.liveRuleHint}>
                  Chưa có combo nào đủ điều kiện (cần ≥ 5 lệnh để thống kê có ý nghĩa). Đợi tí...
                </Text>
              )}
            </View>
          )}

          {/* Grid editor — always available so user can tweak BEFORE running */}
          <GridEditor
            value={gridConfig}
            leverage={getLev(config)}
            onChange={onSetGridConfig}
            onReset={onResetGridConfig}
          />

          {/* Apply best optimizer config to all TFs at once */}
          {hasOpt && (
            <>
              <TouchableOpacity style={styles.applyAllBtn} onPress={onApplyOptimizedAll}>
                <Text style={styles.applyAllBtnText}>✓ ÁP DỤNG BỘ RULE TỐT NHẤT CHO TẤT CẢ KHUNG</Text>
              </TouchableOpacity>
              <Text style={[styles.sectionHint, { textAlign: "center", marginTop: 4 }]}>
                💡 Để xem TOP 10 bộ rule của 1 khung, bấm ▼ ở dòng RULE phía trên
              </Text>

              {/* Per-TF detail blocks removed — now shown inline in
                  ActiveRulesPanel (top of card). User clicks ▼ to expand a
                  TF row and sees its top configs there. */}
              {false && TIMEFRAMES.filter((tf) => tf.key !== "1M").map((tf) => {
                const opt = optByTF[tf.key];
                const currentCfg = configByTF[tf.key];
                if (!opt) return null;

                const isApplied = currentCfg &&
                  currentCfg.stochOSLevel === opt.bestConfig.stochOSLevel &&
                  currentCfg.minScore === opt.bestConfig.minScore &&
                  currentCfg.targetPct === opt.bestConfig.targetPct &&
                  currentCfg.stopPct === opt.bestConfig.stopPct;

                const topConfigs = opt.topConfigs || [];
                const isListExpanded = expandedTopList === tf.key;

                return (
                  <View key={tf.key} style={styles.tfOptBox}>
                    <View style={styles.tfOptHeader}>
                      <Text style={styles.tfOptLabel}>{tf.label}</Text>
                      <Text style={[styles.tfOptWR, {
                        color: opt.bestWinRate >= 60 ? COLORS.bull : opt.bestWinRate >= 45 ? COLORS.warning : COLORS.bear
                      }]}>
                        WR {opt.bestWinRate.toFixed(0)}%
                      </Text>
                      <Text style={styles.tfOptTrades}>{opt.bestTrades} lệnh</Text>
                      <Text style={[styles.tfOptPF, {
                        color: opt.bestProfitFactor >= 1.5 ? COLORS.bull : COLORS.warning
                      }]}>
                        PF {opt.bestProfitFactor === Infinity ? "∞" : opt.bestProfitFactor.toFixed(1)}
                      </Text>
                      <TouchableOpacity
                        style={[styles.applyTFBtn, isApplied && styles.applyTFBtnActive]}
                        onPress={() => onApplyOptimizedForTF(tf.key)}
                      >
                        <Text style={[styles.applyTFBtnText, isApplied && styles.applyTFBtnTextActive]}>
                          {isApplied ? "✓ Đã áp" : "Áp dụng"}
                        </Text>
                      </TouchableOpacity>
                    </View>

                    <View style={styles.topShapeRow}>
                      <Text style={styles.topShapeLabel}>Hình dạng rule:</Text>
                      <Text style={[
                        styles.topShapeValue,
                        { color: (opt.bestConfig.requiredConditions?.length || 0) > 0 ? COLORS.bull : COLORS.textDim }
                      ]}>
                        {(opt.bestConfig.requiredConditions?.length || 0) > 0
                          ? `BẮT BUỘC ${formatRuleShape(opt.bestConfig.requiredConditions)}`
                          : "Bất kỳ (chỉ cần đủ Score)"}
                      </Text>
                    </View>
                    <View style={styles.tfOptRules}>
                      <RuleChip label="Score" value={`≥${opt.bestConfig.minScore}`} />
                      <RuleChip label="Stoch" value={`<${opt.bestConfig.stochOSLevel}/>${opt.bestConfig.stochOBLevel}`} />
                      <RuleChip label="RSI" value={`<${opt.bestConfig.rsiOSLevel}/>${opt.bestConfig.rsiOBLevel}`} />
                      <RuleChip label="TP PnL" value={`+${(opt.bestConfig.targetPct * opt.bestConfig.leverage).toFixed(0)}%`} color={COLORS.bull} />
                      <RuleChip label="SL PnL" value={`-${(opt.bestConfig.stopPct * opt.bestConfig.leverage).toFixed(0)}%`} color={COLORS.bear} />
                      <RuleChip label="x" value={`${opt.bestConfig.leverage}`} />
                    </View>

                    {/* TOP BỘ RULE — multiple high-WR configs, each with full backtest data */}
                    {topConfigs.length > 0 && (
                      <>
                        <TouchableOpacity
                          style={styles.topListHeader}
                          onPress={() => setExpandedTopList(isListExpanded ? null : tf.key)}
                        >
                          <Text style={styles.topListTitle}>
                            {isListExpanded ? "▼" : "▶"} TOP {topConfigs.length} BỘ RULE
                            {opt.totalQualified !== undefined && opt.minWinRateUsed !== undefined && opt.totalQualified > 0
                              ? ` · ${opt.totalQualified} combo đạt WR ≥ ${opt.minWinRateUsed}%`
                              : opt.totalQualified === 0
                                ? ` · KHÔNG combo nào đạt WR ${opt.minWinRateUsed}% — show fallback (PF≥1)`
                                : ""}
                          </Text>
                          {opt.totalQualified === 0 && (
                            <Text style={styles.topListSubHint}>
                              💡 Các rule dưới có PF&gt;1 (lời thật) nhưng WR thấp. Hạ "WR tối thiểu" trong Grid Search xuống 40% để bớt fallback.
                            </Text>
                          )}
                        </TouchableOpacity>

                        {isListExpanded && topConfigs.map((top) => {
                          const topKey = `${tf.key}:${top.rank}`;
                          const isTopExpanded = expandedTop === topKey;
                          const isTopApplied = currentCfg &&
                            currentCfg.stochOSLevel === top.config.stochOSLevel &&
                            currentCfg.minScore === top.config.minScore &&
                            currentCfg.targetPct === top.config.targetPct &&
                            currentCfg.stopPct === top.config.stopPct;
                          const wrColor = top.result.winRate >= 70 ? COLORS.bull
                            : top.result.winRate >= 55 ? COLORS.warning
                            : COLORS.bear;

                          const shapeLabel = formatRuleShape(top.config.requiredConditions);
                          const isPureShape = (top.config.requiredConditions || []).length > 0;

                          return (
                            <View key={topKey} style={styles.topRow}>
                              <TouchableOpacity
                                style={styles.topRowHead}
                                onPress={() => setExpandedTop(isTopExpanded ? null : topKey)}
                              >
                                <Text style={styles.topRank}>#{top.rank}</Text>
                                <Text style={[styles.topWR, { color: wrColor }]}>
                                  {top.result.winRate.toFixed(0)}%
                                </Text>
                                <Text style={styles.topTrades}>{top.result.totalSignals}L</Text>
                                <Text style={[styles.topPF, {
                                  color: top.result.profitFactor >= 1.5 ? COLORS.bull : COLORS.warning,
                                }]}>
                                  PF{top.result.profitFactor === Infinity ? "∞" : top.result.profitFactor.toFixed(1)}
                                </Text>
                                <Text style={styles.topExpandIcon}>{isTopExpanded ? "▼" : "▶"}</Text>
                                <TouchableOpacity
                                  style={[styles.applyTopBtn, isTopApplied && styles.applyTFBtnActive]}
                                  onPress={() => onApplyTopConfigForTF(tf.key, top.rank - 1)}
                                >
                                  <Text style={[styles.applyTFBtnText, isTopApplied && styles.applyTFBtnTextActive]}>
                                    {isTopApplied ? "✓" : "Áp"}
                                  </Text>
                                </TouchableOpacity>
                              </TouchableOpacity>

                              {/* Rule SHAPE (what conditions are required) — this is the "how it
                                  decides" part, distinct from the threshold numbers below. */}
                              <View style={styles.topShapeRow}>
                                <Text style={styles.topShapeLabel}>Hình dạng rule:</Text>
                                <Text style={[
                                  styles.topShapeValue,
                                  { color: isPureShape ? COLORS.bull : COLORS.textDim }
                                ]}>
                                  {isPureShape ? `BẮT BUỘC ${shapeLabel}` : shapeLabel}
                                </Text>
                              </View>

                              {/* Compact rule chips — always visible under the row.
                                  TP/SL show PnL% (with leverage applied) since
                                  that's how traders actually think about risk. */}
                              <View style={styles.topRuleChips}>
                                <RuleChip label="S" value={`≥${top.config.minScore}`} />
                                <RuleChip label="St" value={`<${top.config.stochOSLevel}/>${top.config.stochOBLevel}`} />
                                <RuleChip label="R" value={`<${top.config.rsiOSLevel}/>${top.config.rsiOBLevel}`} />
                                <RuleChip label="TP PnL" value={`+${(top.config.targetPct * top.config.leverage).toFixed(0)}%`} color={COLORS.bull} />
                                <RuleChip label="SL PnL" value={`-${(top.config.stopPct * top.config.leverage).toFixed(0)}%`} color={COLORS.bear} />
                                <RuleChip label="x" value={`${top.config.leverage}`} />
                                <RuleChip label="R:R" value={`1:${(top.config.targetPct / top.config.stopPct).toFixed(1)}`} />
                              </View>

                              {/* Full backtest detail for this top config */}
                              {isTopExpanded && (
                                <View style={styles.topDetailBox}>
                                  {/* Show learned weights if this is a GA-evolved rule */}
                                  {top.config.weights && (
                                    <View style={styles.gaWeightsBox}>
                                      <Text style={styles.gaWeightsTitle}>
                                        🧬 TRỌNG SỐ HỌC ĐƯỢC (vào lệnh khi tổng ≥ {top.config.minWeightedScore})
                                      </Text>
                                      <WeightsBar weights={top.config.weights} />
                                    </View>
                                  )}
                                  <View style={styles.miniGrid}>
                                    <MiniStat label="Thắng" value={top.result.wins} color={COLORS.bull} />
                                    <MiniStat label="Thua" value={top.result.losses} color={COLORS.bear} />
                                    <MiniStat label="Timeout" value={top.result.timeouts} color={COLORS.textMuted} />
                                    <MiniStat label="TB nến" value={top.result.avgHoldBars.toFixed(0)} color={COLORS.text} />
                                  </View>

                                  <View style={styles.pnlRow}>
                                    <View style={styles.pnlBox}>
                                      <Text style={styles.pnlLabel}>TB thắng</Text>
                                      <Text style={[styles.pnlVal, { color: COLORS.bull, fontSize: 11 }]}>
                                        +{top.result.avgWinPct.toFixed(1)}%
                                      </Text>
                                    </View>
                                    <View style={styles.pnlBox}>
                                      <Text style={styles.pnlLabel}>TB thua</Text>
                                      <Text style={[styles.pnlVal, { color: COLORS.bear, fontSize: 11 }]}>
                                        -{Math.abs(top.result.avgLossPct).toFixed(1)}%
                                      </Text>
                                    </View>
                                    <View style={styles.pnlBox}>
                                      <Text style={styles.pnlLabel}>PF</Text>
                                      <Text style={[styles.pnlVal, {
                                        color: top.result.profitFactor >= 1.5 ? COLORS.bull : COLORS.warning,
                                        fontSize: 11,
                                      }]}>
                                        {top.result.profitFactor === Infinity ? "∞" : top.result.profitFactor.toFixed(2)}
                                      </Text>
                                    </View>
                                  </View>

                                  {/* Per-score breakdown for this combo */}
                                  {Object.entries(top.result.scoreBreakdown).some(([, v]) => v.total > 0) && (
                                    <>
                                      <Text style={styles.subLabel}>Win rate theo điểm:</Text>
                                      {Object.entries(top.result.scoreBreakdown)
                                        .filter(([, v]) => v.total > 0)
                                        .map(([score, v]) => (
                                          <View key={score} style={styles.scoreRow}>
                                            <Text style={styles.scoreLabel}>Score {score}:</Text>
                                            <WinRateBar rate={v.winRate} total={v.total} />
                                          </View>
                                        ))}
                                    </>
                                  )}

                                  {top.result.bestCombo && (
                                    <Text style={styles.topBestCombo}>
                                      Combo tốt nhất: {top.result.bestCombo.split("+").map((k) => COND_LABELS[k] || k).join(" + ")}
                                      {` (${top.result.bestComboWinRate.toFixed(0)}%)`}
                                    </Text>
                                  )}
                                </View>
                              )}
                            </View>
                          );
                        })}
                      </>
                    )}
                  </View>
                );
              })}

              {/* (Bottom "BỘ RULE ĐANG DÙNG LIVE" panel removed — now shown
                   prominently at TOP via <ActiveRulesPanel/> so user always
                   sees what's active without scrolling.) */}
            </>
          )}
        </View>
    </View>
  );
}

function RuleDetailRow({ label, value, color = COLORS.text }: { label: string; value: string; color?: string }) {
  return (
    <View style={styles.ruleDetailRow}>
      <Text style={styles.ruleDetailLabel}>{label}</Text>
      <Text style={[styles.ruleDetailValue, { color }]}>{value}</Text>
    </View>
  );
}

/** Visual weights bar — shows learned weight per condition as colored bars 0-3.
 *  Used when displaying GA-discovered rules. */
function WeightsBar({ weights }: { weights?: BacktestConfig["weights"] }) {
  if (!weights) return null;
  const items: { key: keyof EntryConditions; label: string }[] = [
    { key: "stochExtreme",   label: "Stoch" },
    { key: "rsiExtreme",     label: "RSI" },
    { key: "divergence",     label: "Div" },
    { key: "bollingerTouch", label: "BB" },
    { key: "macdCross",      label: "MACD" },
  ];
  const maxW = 3;
  const colorFor = (w: number) => w >= 3 ? COLORS.bull : w === 2 ? COLORS.warning : w === 1 ? COLORS.textDim : COLORS.textMuted;
  return (
    <View style={styles.weightsBox}>
      {items.map(({ key, label }) => {
        const w = weights[key] ?? 0;
        return (
          <View key={key} style={styles.weightRow}>
            <Text style={styles.weightLabel}>{label}</Text>
            <View style={styles.weightBarBg}>
              <View style={[styles.weightBarFill, { width: `${(w / maxW) * 100}%`, backgroundColor: colorFor(w) }]} />
            </View>
            <Text style={[styles.weightVal, { color: colorFor(w) }]}>w={w}</Text>
          </View>
        );
      })}
    </View>
  );
}

/** Key–value row used in the live optimizer panel (full Vietnamese labels) */
function KVRow({ label, value, valueColor = COLORS.text }: { label: string; value: string; valueColor?: string }) {
  return (
    <View style={styles.kvRow}>
      <Text style={styles.kvLabel}>{label}</Text>
      <Text style={[styles.kvValue, { color: valueColor }]}>{value}</Text>
    </View>
  );
}

function RuleChip({ label, value, color = COLORS.textDim }: { label: string; value: string; color?: string }) {
  return (
    <View style={styles.ruleChip}>
      <Text style={styles.ruleChipLabel}>{label}</Text>
      <Text style={[styles.ruleChipVal, { color }]}>{value}</Text>
    </View>
  );
}

function StatBox({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <View style={styles.statBox}>
      <Text style={[styles.statValue, { color }]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function MiniStat({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <View style={styles.miniStatBox}>
      <Text style={[styles.miniStatVal, { color }]}>{value}</Text>
      <Text style={styles.miniStatLabel}>{label}</Text>
    </View>
  );
}

/**
 * Hard Rules — pre-baked rules generated offline from Binance historical data
 * via tools/generate-hard-rules.ts. User can apply any of them with one tap.
 *
 * Collapsible per-TF: each TF row shows top 3 rules by default (rest behind
 * "show more"), with WR/PF/trades stats, and an "Áp" button per rule.
 */
function HardRulesPanel({
  configByTF,
  onApplyHardRule,
}: {
  configByTF: ConfigByTF;
  onApplyHardRule: (tfKey: string, cfg: BacktestConfig) => void;
}) {
  const [open, setOpen] = useState(true);
  const [expandedTF, setExpandedTF] = useState<string | null>(null);

  if (!hasHardRules()) {
    return (
      <View style={styles.hardRulesBox}>
        <Text style={styles.hardRulesEmpty}>
          📦 Hard Rules chưa được tạo. Chạy: <Text style={{ color: COLORS.warning }}>npx tsx tools/generate-hard-rules.ts</Text>
        </Text>
      </View>
    );
  }

  const data = getHardRules();
  const tfKeys = TIMEFRAMES.filter((tf) => tf.key !== "1M" && data.tfs[tf.key]).map((tf) => tf.key);
  const generatedAge = data.generated_at
    ? formatAge(Date.now() - new Date(data.generated_at).getTime())
    : "—";

  return (
    <View style={styles.hardRulesBox}>
      <TouchableOpacity style={styles.hardRulesHeader} onPress={() => setOpen(!open)}>
        <Text style={styles.hardRulesTitle}>
          {open ? "▼" : "▶"} 📦 HARD RULES (rule sẵn từ phân tích lịch sử)
        </Text>
        <Text style={styles.hardRulesSub}>
          {tfKeys.length} khung · gen {generatedAge} · từ {data.data_source}
        </Text>
      </TouchableOpacity>

      {open && (
        <View style={styles.hardRulesBody}>
          <Text style={styles.hardRulesIntro}>
            💡 Đây là rule TỐT NHẤT đã tìm được offline (Grid + GA trên hàng nghìn nến). Áp ngay không cần đợi optimizer chạy. Bấm 1 TF để xem top 10 rule của khung đó.
          </Text>

          {tfKeys.map((tfKey) => {
            const tfData = data.tfs[tfKey];
            const isExpanded = expandedTF === tfKey;
            const visibleRules = isExpanded ? tfData.rules : tfData.rules.slice(0, 3);
            const cfg = configByTF[tfKey];

            return (
              <View key={tfKey} style={styles.hardRulesTFBox}>
                <TouchableOpacity
                  style={styles.hardRulesTFHead}
                  onPress={() => setExpandedTF(isExpanded ? null : tfKey)}
                >
                  <Text style={styles.hardRulesTFLabel}>{tfData.label}</Text>
                  <Text style={styles.hardRulesTFMeta}>
                    {tfData.rules.length} rule · {tfData.candles_used} nến lịch sử (${tfData.price_range.first.toLocaleString()} → ${tfData.price_range.last.toLocaleString()})
                  </Text>
                  <Text style={styles.hardRulesTFExpand}>{isExpanded ? "▲ thu gọn" : `▼ xem hết ${tfData.rules.length}`}</Text>
                </TouchableOpacity>

                {visibleRules.map((rule) => {
                  const lev = getLev(rule.config);
                  const isApplied = cfg &&
                    cfg.targetPct === rule.config.targetPct &&
                    cfg.stopPct === rule.config.stopPct &&
                    cfg.stochOSLevel === rule.config.stochOSLevel &&
                    cfg.minScore === rule.config.minScore;
                  const wrColor = rule.stats.winRate >= 60 ? COLORS.bull
                    : rule.stats.winRate >= 45 ? COLORS.warning : COLORS.bear;
                  const isGA = rule.source === "GA";
                  const shape = formatRuleShape(rule.config.requiredConditions);
                  const hasShape = (rule.config.requiredConditions?.length || 0) > 0;

                  return (
                    <View key={rule.rank} style={styles.hardRuleRow}>
                      <View style={styles.hardRuleStatsRow}>
                        <Text style={styles.hardRuleRank}>#{rule.rank}</Text>
                        <View style={[styles.hardRuleSrcBadge, { backgroundColor: isGA ? COLORS.bull + "20" : COLORS.warning + "20", borderColor: isGA ? COLORS.bull + "60" : COLORS.warning + "60" }]}>
                          <Text style={[styles.hardRuleSrcText, { color: isGA ? COLORS.bull : COLORS.warning }]}>
                            {isGA ? "🧬 GA" : "↻ Grid"}
                          </Text>
                        </View>
                        <Text style={[styles.hardRuleWR, { color: wrColor }]}>{rule.stats.winRate}%</Text>
                        <Text style={styles.hardRulePF}>
                          PF{rule.stats.profitFactor === 999 ? "∞" : rule.stats.profitFactor.toFixed(1)}
                        </Text>
                        <Text style={styles.hardRuleTrades}>{rule.stats.trades}L</Text>
                        <TouchableOpacity
                          style={[styles.hardRuleApplyBtn, isApplied && styles.applyTFBtnActive]}
                          onPress={() => onApplyHardRule(tfKey, rule.config)}
                        >
                          <Text style={[styles.applyTFBtnText, isApplied && styles.applyTFBtnTextActive]}>
                            {isApplied ? "✓ Đã áp" : "Áp"}
                          </Text>
                        </TouchableOpacity>
                      </View>
                      <Text style={styles.hardRuleShape}>
                        {hasShape
                          ? <Text style={{ color: COLORS.bull, fontWeight: "800" }}>BẮT BUỘC: {shape} · </Text>
                          : <Text style={{ color: COLORS.textMuted }}>Bất kỳ · </Text>}
                        Score≥{rule.config.minScore} · Stoch&lt;{rule.config.stochOSLevel}/&gt;{rule.config.stochOBLevel} · RSI&lt;{rule.config.rsiOSLevel}/&gt;{rule.config.rsiOBLevel}
                      </Text>
                      <Text style={styles.hardRuleTPSL}>
                        <Text style={{ color: COLORS.bull }}>TP +{(rule.config.targetPct * lev).toFixed(0)}% PnL</Text>
                        {" / "}
                        <Text style={{ color: COLORS.bear }}>SL -{(rule.config.stopPct * lev).toFixed(0)}% PnL</Text>
                        {" · "}
                        <Text style={{ color: COLORS.textDim }}>x{lev} · R:R 1:{(rule.config.targetPct / rule.config.stopPct).toFixed(1)} · TB thắng +{rule.stats.avgWinPct.toFixed(0)}% / TB thua -{Math.abs(rule.stats.avgLossPct).toFixed(0)}%</Text>
                      </Text>
                    </View>
                  );
                })}
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

/**
 * THE single source of truth panel for "which rule is running for each TF
 * RIGHT NOW". Always visible at the top of the BacktestResults card so user
 * never has to wonder "what rule will run when I click backtest" or "what
 * rule is generating my live signals".
 *
 * Each row shows:
 *  - TF label
 *  - Source badge: [Mặc định] / [Tối ưu] / [Tay]
 *  - Rule shape (BẮT BUỘC X / Bất kỳ)
 *  - Score, Stoch, RSI thresholds, TP/SL in PnL%
 */
function ActiveRulesPanel({
  configByTF,
  configSourceByTF,
  backtestResults,
  optByTF,
  runningByTF,
  runningOptByTF,
  candleCountByTF,
  lastRunByTF,
  lastOptRunByTF,
  loading,
  optLoading,
  onRunBacktestForTF,
  onRunOptimizerForTF,
  onRunEvolutionForTF,
  onApplyOptimizedForTF,
  onApplyTopConfigForTF,
}: {
  configByTF: ConfigByTF;
  configSourceByTF: ConfigSourceByTF;
  backtestResults: BacktestResult[];
  optByTF: OptByTF;
  runningByTF: RunningByTF;
  runningOptByTF: RunningByTF;
  candleCountByTF: Record<string, number>;
  lastRunByTF: LastRunByTF;
  lastOptRunByTF: LastRunByTF;
  loading: boolean;
  optLoading: boolean;
  onRunBacktestForTF: (tfKey: string) => void;
  onRunOptimizerForTF: (tfKey: string) => void;
  onRunEvolutionForTF: (tfKey: string) => void;
  onApplyOptimizedForTF: (tfKey: string) => void;
  onApplyTopConfigForTF: (tfKey: string, rankIndex: number) => void;
}) {
  const [open, setOpen] = useState(true); // open by default — this is THE most important panel
  // Which TF row is expanded to show top configs + details
  const [expandedTF, setExpandedTF] = useState<string | null>(null);
  // Which top config inside an expanded TF is expanded for full stats
  const [expandedTop, setExpandedTop] = useState<string | null>(null);

  const sourceBadge = (src: ConfigSource | undefined): { label: string; color: string; bg: string } => {
    switch (src) {
      case "manual":    return { label: "TAY",       color: COLORS.bitcoin, bg: COLORS.bitcoin + "20" };
      case "optimized": return { label: "TỐI ƯU",   color: COLORS.warning, bg: COLORS.warning + "20" };
      case "hard":      return { label: "📦 HARD",  color: COLORS.bull,    bg: COLORS.bull + "20" };
      case "default":
      default:          return { label: "MẶC ĐỊNH", color: COLORS.textMuted, bg: "#ffffff10" };
    }
  };

  return (
    <View style={styles.activeRulesBox}>
      <TouchableOpacity style={styles.activeRulesHeader} onPress={() => setOpen(!open)}>
        <Text style={styles.activeRulesTitle}>
          {open ? "▼" : "▶"} 🎯 RULE ĐANG CHẠY CHO TỪNG KHUNG
        </Text>
        <Text style={styles.activeRulesHint}>
          (rule này quyết định khi nào báo tín hiệu LIVE + sẽ chạy khi backtest)
        </Text>
      </TouchableOpacity>

      {open && (
        <View style={styles.activeRulesBody}>
          {/* Column headers */}
          <View style={styles.activeRulesHeadRow}>
            <Text style={[styles.activeRulesCellTF, styles.activeRulesHeadText]}>TF</Text>
            <Text style={[styles.activeRulesCellSrc, styles.activeRulesHeadText]}>NGUỒN</Text>
            <Text style={[styles.activeRulesCellRule, styles.activeRulesHeadText]}>BỘ RULE</Text>
          </View>

          {TIMEFRAMES.filter((tf) => tf.key !== "1M").map((tf) => {
            const cfg = configByTF[tf.key];
            const src = configSourceByTF[tf.key];
            const badge = sourceBadge(cfg ? src : "default");
            const effective = cfg || DEFAULT_BACKTEST_CONFIG;
            const shape = formatRuleShape(effective.requiredConditions);
            const hasShape = (effective.requiredConditions?.length || 0) > 0;
            const lev = getLev(effective);
            const isGA = !!effective.weights;
            const weightsSummary = isGA && effective.weights
              ? Object.entries(effective.weights)
                  .filter(([_, w]) => (w ?? 0) > 0)
                  .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
                  .map(([k, w]) => `${COND_SHORT[k] || k}=${w}`)
                  .join(", ")
              : "";

            const result = backtestResults.find((r) => r.timeframe === tf.label);
            const opt = optByTF[tf.key];
            const isBacktesting = !!runningByTF[tf.key];
            const isOptimizing = !!runningOptByTF[tf.key];
            const isExpanded = expandedTF === tf.key;
            const wrColor = result
              ? (result.winRate >= 60 ? COLORS.bull : result.winRate >= 45 ? COLORS.warning : COLORS.bear)
              : COLORS.textMuted;
            const candleCount = candleCountByTF[tf.key] || 0;
            const tfLastRun = lastRunByTF[tf.key] || 0;
            const tfLastOpt = lastOptRunByTF[tf.key] || 0;

            return (
              <View key={tf.key} style={[styles.activeRulesRow, isExpanded && styles.activeRulesRowExpanded]}>
                {/* Top section: TF + badge + rule + WR/PF + action buttons */}
                <View style={styles.activeRulesTopRow}>
                  <Text style={styles.activeRulesCellTF}>{tf.label}</Text>

                  <View style={styles.activeRulesCellSrc}>
                    <View style={[styles.activeRuleBadge, { backgroundColor: badge.bg, borderColor: badge.color + "60" }]}>
                      <Text style={[styles.activeRuleBadgeText, { color: badge.color }]}>{badge.label}</Text>
                    </View>
                    {isGA && (
                      <View style={[styles.activeRuleBadge, { backgroundColor: COLORS.bull + "20", borderColor: COLORS.bull + "60", marginTop: 3 }]}>
                        <Text style={[styles.activeRuleBadgeText, { color: COLORS.bull }]}>🧬 GA</Text>
                      </View>
                    )}
                  </View>

                  {/* WR/PF stats inline */}
                  <View style={styles.activeRulesCellStats}>
                    {result ? (
                      <>
                        <Text style={[styles.activeRulesWR, { color: wrColor }]}>
                          {result.winRate.toFixed(0)}%
                        </Text>
                        <Text style={styles.activeRulesPF}>
                          PF{result.profitFactor === Infinity ? "∞" : result.profitFactor.toFixed(1)}
                        </Text>
                        <Text style={styles.activeRulesTrades}>{result.totalSignals}L</Text>
                      </>
                    ) : (
                      <Text style={styles.activeRulesNoData}>chưa test</Text>
                    )}
                  </View>

                  {/* Action buttons — icon + tiny label so user knows what each does */}
                  <View style={styles.activeRulesActions}>
                    <TouchableOpacity
                      style={styles.actionBtnTest}
                      onPress={() => onRunBacktestForTF(tf.key)}
                      disabled={isBacktesting || loading}
                    >
                      {isBacktesting
                        ? <ActivityIndicator size="small" color={COLORS.bitcoin} />
                        : (
                          <>
                            <Text style={styles.actionBtnIcon}>📊</Text>
                            <Text style={[styles.actionBtnLabel, { color: COLORS.bitcoin }]}>Test</Text>
                          </>
                        )}
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.actionBtnGrid}
                      onPress={() => onRunOptimizerForTF(tf.key)}
                      disabled={isOptimizing || optLoading}
                    >
                      {isOptimizing
                        ? <ActivityIndicator size="small" color={COLORS.warning} />
                        : (
                          <>
                            <Text style={styles.actionBtnIcon}>↻</Text>
                            <Text style={[styles.actionBtnLabel, { color: COLORS.warning }]}>Grid</Text>
                          </>
                        )}
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.actionBtnGA}
                      onPress={() => onRunEvolutionForTF(tf.key)}
                      disabled={isOptimizing || optLoading}
                    >
                      <Text style={styles.actionBtnIcon}>🧬</Text>
                      <Text style={[styles.actionBtnLabel, { color: COLORS.bull }]}>GA</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.actionBtnExpand}
                      onPress={() => setExpandedTF(isExpanded ? null : tf.key)}
                    >
                      <Text style={styles.actionBtnIcon}>{isExpanded ? "▲" : "▼"}</Text>
                      <Text style={[styles.actionBtnLabel, { color: COLORS.textDim }]}>{isExpanded ? "Đóng" : "Mở"}</Text>
                    </TouchableOpacity>
                  </View>
                </View>

                {/* Rule summary line */}
                <View style={styles.activeRulesRuleRow}>
                  <Text style={styles.activeRulesShape}>
                    {isGA
                      ? <Text style={{ color: COLORS.bull, fontWeight: "800" }}>🧬 GA WEIGHTED ≥ {effective.minWeightedScore}</Text>
                      : hasShape
                        ? <Text style={{ color: COLORS.bull, fontWeight: "800" }}>BẮT BUỘC: {shape}</Text>
                        : <Text style={{ color: COLORS.textMuted }}>Bất kỳ ĐK</Text>}
                    {"  ·  "}
                    <Text style={{ color: COLORS.bull }}>TP +{(safeNum(effective.targetPct) * lev).toFixed(0)}%</Text>
                    {" / "}
                    <Text style={{ color: COLORS.bear }}>SL -{(safeNum(effective.stopPct) * lev).toFixed(0)}%</Text>
                    {" · "}
                    <Text style={{ color: COLORS.textDim }}>x{lev} · R:R 1:{(safeNum(effective.targetPct) / safeNum(effective.stopPct)).toFixed(1)}</Text>
                  </Text>
                  {isGA && (
                    <Text style={[styles.activeRulesParams, { color: COLORS.bull, fontStyle: "italic" }]}>
                      W: {weightsSummary || "(0)"}
                    </Text>
                  )}
                  {!isGA && (
                    <Text style={styles.activeRulesParams}>
                      S≥{effective.minScore} · Stoch&lt;{effective.stochOSLevel}/&gt;{effective.stochOBLevel} · RSI&lt;{effective.rsiOSLevel}/&gt;{effective.rsiOBLevel}
                    </Text>
                  )}
                  {(candleCount > 0 || tfLastRun > 0 || tfLastOpt > 0) && (
                    <Text style={styles.activeRulesMeta}>
                      {candleCount > 0 ? `${candleCount} nến cache` : ""}
                      {tfLastRun > 0 ? ` · backtest ${formatAge(Date.now() - tfLastRun)}` : ""}
                      {tfLastOpt > 0 ? ` · optimize ${formatAge(Date.now() - tfLastOpt)}` : ""}
                    </Text>
                  )}
                </View>

                {/* Expanded: show top configs from optimizer */}
                {isExpanded && (
                  <View style={styles.activeRulesExpanded}>
                    {opt && opt.topConfigs && opt.topConfigs.length > 0 ? (
                      <>
                        <Text style={styles.expandedSectionTitle}>
                          🏆 TOP {opt.topConfigs.length} BỘ RULE TÌM ĐƯỢC (sort theo fitness)
                        </Text>
                        {opt.topConfigs.map((top) => {
                          const topKey = `${tf.key}:${top.rank}`;
                          const isTopExpanded = expandedTop === topKey;
                          const isTopApplied = cfg &&
                            cfg.stochOSLevel === top.config.stochOSLevel &&
                            cfg.targetPct === top.config.targetPct &&
                            cfg.stopPct === top.config.stopPct;
                          const tWR = top.result.winRate;
                          const tWRColor = tWR >= 60 ? COLORS.bull : tWR >= 45 ? COLORS.warning : COLORS.bear;
                          const isTopGA = !!top.config.weights;
                          const tlev = getLev(top.config);

                          return (
                            <View key={topKey} style={styles.topRow}>
                              <TouchableOpacity
                                style={styles.topRowHead}
                                onPress={() => setExpandedTop(isTopExpanded ? null : topKey)}
                              >
                                <Text style={styles.topRank}>#{top.rank}</Text>
                                <Text style={[styles.topWR, { color: tWRColor }]}>{tWR.toFixed(0)}%</Text>
                                <Text style={styles.topTrades}>{top.result.totalSignals}L</Text>
                                <Text style={[styles.topPF, {
                                  color: top.result.profitFactor >= 1.5 ? COLORS.bull : COLORS.warning,
                                }]}>
                                  PF{top.result.profitFactor === Infinity ? "∞" : top.result.profitFactor.toFixed(1)}
                                </Text>
                                <Text style={styles.topExpandIcon}>{isTopExpanded ? "▼" : "▶"}</Text>
                                <TouchableOpacity
                                  style={[styles.applyTopBtn, isTopApplied && styles.applyTFBtnActive]}
                                  onPress={() => onApplyTopConfigForTF(tf.key, top.rank - 1)}
                                >
                                  <Text style={[styles.applyTFBtnText, isTopApplied && styles.applyTFBtnTextActive]}>
                                    {isTopApplied ? "✓" : "Áp"}
                                  </Text>
                                </TouchableOpacity>
                              </TouchableOpacity>
                              <View style={styles.topRuleChips}>
                                {isTopGA
                                  ? <Text style={{ color: COLORS.bull, fontSize: 9, fontFamily: "monospace" }}>🧬 GA · ≥{top.config.minWeightedScore}</Text>
                                  : <RuleChip label="S" value={`≥${top.config.minScore}`} />}
                                <RuleChip label="St" value={`<${top.config.stochOSLevel}/>${top.config.stochOBLevel}`} />
                                <RuleChip label="R" value={`<${top.config.rsiOSLevel}/>${top.config.rsiOBLevel}`} />
                                <RuleChip label="TP" value={`+${(top.config.targetPct * tlev).toFixed(0)}%`} color={COLORS.bull} />
                                <RuleChip label="SL" value={`-${(top.config.stopPct * tlev).toFixed(0)}%`} color={COLORS.bear} />
                                <RuleChip label="R:R" value={`1:${(top.config.targetPct / top.config.stopPct).toFixed(1)}`} />
                              </View>

                              {isTopExpanded && (
                                <View style={styles.topDetailBox}>
                                  {isTopGA && top.config.weights && (
                                    <View style={styles.gaWeightsBox}>
                                      <Text style={styles.gaWeightsTitle}>
                                        🧬 TRỌNG SỐ HỌC (vào lệnh khi tổng ≥ {top.config.minWeightedScore})
                                      </Text>
                                      <WeightsBar weights={top.config.weights} />
                                    </View>
                                  )}
                                  <View style={styles.miniGrid}>
                                    <MiniStat label="Thắng" value={top.result.wins} color={COLORS.bull} />
                                    <MiniStat label="Thua" value={top.result.losses} color={COLORS.bear} />
                                    <MiniStat label="Timeout" value={top.result.timeouts} color={COLORS.textMuted} />
                                    <MiniStat label="TB nến" value={top.result.avgHoldBars.toFixed(0)} color={COLORS.text} />
                                  </View>
                                  <View style={styles.pnlRow}>
                                    <View style={styles.pnlBox}>
                                      <Text style={styles.pnlLabel}>TB thắng</Text>
                                      <Text style={[styles.pnlVal, { color: COLORS.bull, fontSize: 11 }]}>+{top.result.avgWinPct.toFixed(1)}%</Text>
                                    </View>
                                    <View style={styles.pnlBox}>
                                      <Text style={styles.pnlLabel}>TB thua</Text>
                                      <Text style={[styles.pnlVal, { color: COLORS.bear, fontSize: 11 }]}>-{Math.abs(top.result.avgLossPct).toFixed(1)}%</Text>
                                    </View>
                                    <View style={styles.pnlBox}>
                                      <Text style={styles.pnlLabel}>PF</Text>
                                      <Text style={[styles.pnlVal, {
                                        color: top.result.profitFactor >= 1.5 ? COLORS.bull : COLORS.warning,
                                        fontSize: 11,
                                      }]}>
                                        {top.result.profitFactor === Infinity ? "∞" : top.result.profitFactor.toFixed(2)}
                                      </Text>
                                    </View>
                                  </View>
                                </View>
                              )}
                            </View>
                          );
                        })}
                      </>
                    ) : (
                      <Text style={styles.expandedHint}>
                        Chưa có top configs. Bấm ↻ (Grid) hoặc 🧬 (GA) ở trên để chạy optimizer.
                      </Text>
                    )}
                  </View>
                )}
              </View>
            );
          })}

          <Text style={styles.activeRulesFooter}>
            💡 <Text style={{ color: COLORS.bitcoin, fontWeight: "800" }}>MẶC ĐỊNH</Text> = rule cài sẵn ·{" "}
            <Text style={{ color: COLORS.warning, fontWeight: "800" }}>TỐI ƯU</Text> = optimizer (Grid) ·{" "}
            <Text style={{ color: COLORS.bull, fontWeight: "800" }}>🧬 GA</Text> = Genetic Algorithm (Weighted) ·{" "}
            <Text style={{ color: COLORS.bitcoin, fontWeight: "800" }}>TAY</Text> = chỉnh tay
          </Text>
        </View>
      )}
    </View>
  );
}

/**
 * GridEditor — lets user customize the values the optimizer scans.
 *
 * Each list (minScores, stochOSLevels, rsiOSLevels, targetPcts, stopPcts)
 * is editable as chips with × remove + a "+ Add" input. TP/SL show in PnL%
 * (multiplied by leverage) but stored internally as raw price %.
 *
 * Quality filters (minWinRate, minTrades, topN) and the R:R threshold are
 * single-value number inputs.
 *
 * Live combo count tells user how big the grid will be before they run.
 */
function GridEditor({
  value,
  leverage,
  onChange,
  onReset,
}: {
  value: OptimizeGridConfig;
  leverage: number;
  onChange: (next: OptimizeGridConfig) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  // pending-add text per list
  const [addText, setAddText] = useState<Record<string, string>>({});

  const updateList = (key: keyof OptimizeGridConfig, list: number[]) => {
    onChange({ ...value, [key]: list });
  };

  const removeFromList = (key: keyof OptimizeGridConfig, idx: number) => {
    const list = (value[key] as number[]).filter((_, i) => i !== idx);
    if (list.length === 0) return; // never let it go empty
    updateList(key, list);
  };

  const addToList = (key: keyof OptimizeGridConfig, divisor: number = 1) => {
    const text = addText[key as string] || "";
    const n = parseFloat(text);
    if (isNaN(n)) return;
    const valToAdd = n / divisor; // e.g. user types 200 PnL%, store 200/lev = 2
    const current = value[key] as number[];
    if (current.includes(valToAdd)) return;
    const next = [...current, valToAdd].sort((a, b) => a - b);
    updateList(key, next);
    setAddText((t) => ({ ...t, [key as string]: "" }));
  };

  const setNumberField = (key: keyof OptimizeGridConfig, text: string) => {
    const n = parseFloat(text);
    if (isNaN(n)) return;
    onChange({ ...value, [key]: n });
  };

  // Compute approximate combo count (matches optimizer logic minus shape filter)
  const totalCombos = (() => {
    const shapes = RULE_SHAPE_PRESETS.length;
    let validTPSL = 0;
    for (const tp of value.targetPcts) {
      for (const sl of value.stopPcts) {
        if (tp / sl >= value.minRR) validTPSL++;
      }
    }
    return shapes * value.stochOSLevels.length * value.rsiOSLevels.length * value.minScores.length * validTPSL;
  })();

  // ETA estimate: ~0.15s per combo
  const etaSec = Math.round(totalCombos * 0.15);
  const etaStr = etaSec < 60 ? `${etaSec}s` : `${Math.floor(etaSec / 60)}m ${etaSec % 60}s`;

  return (
    <View style={styles.gridEditorBox}>
      <TouchableOpacity style={styles.gridEditorHeader} onPress={() => setOpen(!open)}>
        <Text style={styles.gridEditorTitle}>
          {open ? "▼" : "▶"} ⚙ CHỈNH GRID SEARCH (~{totalCombos} combo · ~{etaStr}/khung)
        </Text>
        {!open && (
          <Text style={styles.gridEditorPreview}>
            S:[{value.minScores.join(",")}] · St:[{value.stochOSLevels.join(",")}] · R:[{value.rsiOSLevels.join(",")}] · TP%PnL:[{value.targetPcts.map(t => (t * leverage).toFixed(0)).join(",")}] · SL%PnL:[{value.stopPcts.map(s => (s * leverage).toFixed(0)).join(",")}] · R:R≥{value.minRR}
          </Text>
        )}
      </TouchableOpacity>

      {open && (
        <View style={styles.gridEditorBody}>
          <Text style={styles.gridEditorHint}>
            💡 Mỗi list cần ≥ 1 giá trị. Bấm × để xóa, gõ số rồi Enter/+ để thêm. Tổng combo = các list nhân với nhau × {RULE_SHAPE_PRESETS.length} hình dạng rule.
          </Text>

          {/* What conditions are searched (transparency) */}
          <View style={styles.condInfoBox}>
            <Text style={styles.condInfoTitle}>📡 5 TÍN HIỆU CƠ BẢN ĐƯỢC OPTIMIZER THỬ:</Text>
            <Text style={styles.condInfoRow}>• <Text style={{ color: COLORS.bull, fontWeight: "800" }}>Stoch</Text> — StochRSI cực trị (Quá Bán/Quá Mua)</Text>
            <Text style={styles.condInfoRow}>• <Text style={{ color: COLORS.bull, fontWeight: "800" }}>RSI</Text> — RSI cực trị</Text>
            <Text style={styles.condInfoRow}>• <Text style={{ color: COLORS.bull, fontWeight: "800" }}>Phân kỳ</Text> — Phân kỳ giá vs RSI (Bullish/Bearish Divergence)</Text>
            <Text style={styles.condInfoRow}>• <Text style={{ color: COLORS.bull, fontWeight: "800" }}>Bollinger</Text> — Giá chạm dải BB trên/dưới</Text>
            <Text style={styles.condInfoRow}>• <Text style={{ color: COLORS.bull, fontWeight: "800" }}>MACD</Text> — Histogram đổi chiều / cross zero</Text>
            <Text style={styles.condInfoFooter}>
              Optimizer thử <Text style={{ color: COLORS.warning, fontWeight: "800" }}>{RULE_SHAPE_PRESETS.length} HÌNH DẠNG</Text> tổ hợp các tín hiệu này (vd: "Stoch+MACD bắt buộc", "Phân kỳ + Bollinger", v.v.) — không cần chỉnh ở đây.
            </Text>
            <Text style={styles.condInfoRoadmap}>
              🚧 Sắp thêm: <Text style={{ color: COLORS.warning }}>HTF Trend</Text> (cùng xu hướng khung lớn — vd 5M chỉ vào LONG khi 1H xu hướng tăng) · <Text style={{ color: COLORS.warning }}>Volume spike</Text> · <Text style={{ color: COLORS.warning }}>EMA50/200 cross</Text>
            </Text>
          </View>

          <ListEditor
            label="Min Score (số ĐK tối thiểu)"
            values={value.minScores}
            renderValue={(v) => `${v}`}
            placeholder="VD: 4"
            text={addText["minScores"] || ""}
            onChangeText={(t) => setAddText((s) => ({ ...s, minScores: t }))}
            onAdd={() => addToList("minScores")}
            onRemove={(i) => removeFromList("minScores", i)}
          />

          <ListEditor
            label="StochRSI Quá Bán (Quá Mua = 100 - x)"
            values={value.stochOSLevels}
            renderValue={(v) => `<${v}/>${100 - v}`}
            placeholder="VD: 15"
            text={addText["stochOSLevels"] || ""}
            onChangeText={(t) => setAddText((s) => ({ ...s, stochOSLevels: t }))}
            onAdd={() => addToList("stochOSLevels")}
            onRemove={(i) => removeFromList("stochOSLevels", i)}
          />

          <ListEditor
            label="RSI Quá Bán (Quá Mua = 100 - x)"
            values={value.rsiOSLevels}
            renderValue={(v) => `<${v}/>${100 - v}`}
            placeholder="VD: 35"
            text={addText["rsiOSLevels"] || ""}
            onChangeText={(t) => setAddText((s) => ({ ...s, rsiOSLevels: t }))}
            onAdd={() => addToList("rsiOSLevels")}
            onRemove={(i) => removeFromList("rsiOSLevels", i)}
          />

          <ListEditor
            label={`Take Profit % PnL (đòn bẩy x${leverage})`}
            values={value.targetPcts}
            renderValue={(v) => `+${(v * leverage).toFixed(0)}% PnL (giá +${v.toFixed(2)}%)`}
            placeholder={`VD: ${(2 * leverage).toFixed(0)} (= giá +2%)`}
            text={addText["targetPcts"] || ""}
            onChangeText={(t) => setAddText((s) => ({ ...s, targetPcts: t }))}
            onAdd={() => addToList("targetPcts", leverage)}
            onRemove={(i) => removeFromList("targetPcts", i)}
            valueColor={COLORS.bull}
          />

          <ListEditor
            label={`Stop Loss % PnL (đòn bẩy x${leverage})`}
            values={value.stopPcts}
            renderValue={(v) => `-${(v * leverage).toFixed(0)}% PnL (giá -${v.toFixed(2)}%)`}
            placeholder={`VD: ${(1 * leverage).toFixed(0)} (= giá -1%)`}
            text={addText["stopPcts"] || ""}
            onChangeText={(t) => setAddText((s) => ({ ...s, stopPcts: t }))}
            onAdd={() => addToList("stopPcts", leverage)}
            onRemove={(i) => removeFromList("stopPcts", i)}
            valueColor={COLORS.bear}
          />

          {/* Quality filters */}
          <View style={styles.gridEditorDivider} />
          <Text style={styles.gridEditorSection}>BỘ LỌC CHẤT LƯỢNG</Text>

          <View style={styles.gridFilterRow}>
            <View style={styles.gridFilterCol}>
              <Text style={styles.manualLabel}>R:R tối thiểu (loại combo TP/SL xấu)</Text>
              <TextInput
                style={styles.manualInput}
                value={String(value.minRR)}
                onChangeText={(t) => setNumberField("minRR", t)}
                keyboardType="decimal-pad"
                maxLength={4}
              />
              <Text style={styles.manualHint}>Combo có TP/SL &lt; {value.minRR} sẽ bị bỏ qua</Text>
            </View>
            <View style={styles.gridFilterCol}>
              <Text style={styles.manualLabel}>WR tối thiểu để vào TOP (%)</Text>
              <TextInput
                style={styles.manualInput}
                value={String(value.minWinRate)}
                onChangeText={(t) => setNumberField("minWinRate", t)}
                keyboardType="number-pad"
                maxLength={3}
              />
              <Text style={styles.manualHint}>
                Combo có WR &lt; {value.minWinRate}% bị loại{"\n"}
                💡 Crypto: WR 40-50% + PF cao vẫn lời, đừng đặt quá cao
              </Text>
            </View>
          </View>

          <View style={styles.gridFilterRow}>
            <View style={styles.gridFilterCol}>
              <Text style={styles.manualLabel}>Số lệnh tối thiểu</Text>
              <TextInput
                style={styles.manualInput}
                value={String(value.minTrades)}
                onChangeText={(t) => setNumberField("minTrades", t)}
                keyboardType="number-pad"
                maxLength={3}
              />
              <Text style={styles.manualHint}>Combo có &lt; {value.minTrades} lệnh bị loại</Text>
            </View>
            <View style={styles.gridFilterCol}>
              <Text style={styles.manualLabel}>Số TOP giữ lại</Text>
              <TextInput
                style={styles.manualInput}
                value={String(value.topN)}
                onChangeText={(t) => setNumberField("topN", t)}
                keyboardType="number-pad"
                maxLength={2}
              />
              <Text style={styles.manualHint}>Hiện top {value.topN} bộ rule</Text>
            </View>
          </View>

          <View style={styles.gridEditorDivider} />

          <View style={styles.gridSummaryBox}>
            <Text style={styles.gridSummaryText}>
              📊 Tổng combo: <Text style={{ color: COLORS.warning, fontWeight: "900" }}>{totalCombos}</Text> · ETA: ~{etaStr}/khung · Top giữ: {value.topN}
            </Text>
          </View>

          <TouchableOpacity style={styles.gridResetBtn} onPress={onReset}>
            <Text style={styles.gridResetBtnText}>↺ ĐẶT LẠI MẶC ĐỊNH</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

/** A single editable list of numbers — chips with × + add input */
function ListEditor({
  label,
  values,
  renderValue,
  placeholder,
  text,
  onChangeText,
  onAdd,
  onRemove,
  valueColor,
}: {
  label: string;
  values: number[];
  renderValue: (v: number) => string;
  placeholder: string;
  text: string;
  onChangeText: (t: string) => void;
  onAdd: () => void;
  onRemove: (i: number) => void;
  valueColor?: string;
}) {
  return (
    <View style={styles.listEditorBox}>
      <Text style={styles.manualLabel}>{label}</Text>
      <View style={styles.listChipsRow}>
        {values.map((v, i) => (
          <View key={`${i}-${v}`} style={styles.listChip}>
            <Text style={[styles.listChipText, valueColor && { color: valueColor }]}>
              {renderValue(v)}
            </Text>
            <TouchableOpacity onPress={() => onRemove(i)} style={styles.listChipRemove} disabled={values.length <= 1}>
              <Text style={[styles.listChipRemoveText, values.length <= 1 && { color: COLORS.textMuted }]}>×</Text>
            </TouchableOpacity>
          </View>
        ))}
      </View>
      <View style={styles.listAddRow}>
        <TextInput
          style={[styles.manualInput, { flex: 1 }]}
          value={text}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={COLORS.textMuted}
          keyboardType="decimal-pad"
          onSubmitEditing={onAdd}
        />
        <TouchableOpacity style={styles.listAddBtn} onPress={onAdd}>
          <Text style={styles.listAddBtnText}>+ Thêm</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

/**
 * Collapsible manual editor. User can pick rule-shape preset, tweak
 * TP/SL/minScore/Stoch/RSI, then apply to ALL TFs or a specific TF.
 */
function ManualRuleEditor({
  config,
  onApplyAll,
  onApplyToTF,
}: {
  config: BacktestConfig;
  onApplyAll: (cfg: BacktestConfig) => void;
  onApplyToTF: (tfKey: string, cfg: BacktestConfig) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<BacktestConfig>(() => ({
    ...DEFAULT_BACKTEST_CONFIG,
    ...config,
    requiredConditions: config.requiredConditions || [],
  }));
  // IMPORTANT: tpText / slText are stored as PnL% (with leverage applied),
  // because that's how traders actually think ("SL 100% means I lose all my
  // margin"). We convert to raw price % by dividing by leverage when saving.
  // Internally, BacktestConfig.targetPct/stopPct stay as raw price % so the
  // simulation engine doesn't change.
  const [leverageText, setLeverageText] = useState(String(draft.leverage));
  const [tpText, setTpText] = useState(String(draft.targetPct * draft.leverage));
  const [slText, setSlText] = useState(String(draft.stopPct * draft.leverage));
  const [scoreText, setScoreText] = useState(String(draft.minScore));
  const [stochOSText, setStochOSText] = useState(String(draft.stochOSLevel));
  const [rsiOSText, setRsiOSText] = useState(String(draft.rsiOSLevel));
  const [targetTF, setTargetTF] = useState<string>("ALL");
  // After-apply confirmation banner
  const [appliedMsg, setAppliedMsg] = useState<string | null>(null);

  const setShapeId = (id: string) => {
    const preset = RULE_SHAPE_PRESETS.find((p) => p.id === id);
    if (preset) setDraft((d) => ({ ...d, requiredConditions: preset.required }));
  };

  // Match current requiredConditions to a preset id
  const currentShapeId = (() => {
    const req = draft.requiredConditions || [];
    const found = RULE_SHAPE_PRESETS.find((p) =>
      p.required.length === req.length &&
      p.required.every((r) => req.includes(r))
    );
    return found?.id || "any";
  })();

  // Parse + validate. Returns { value, error } — error is non-null when the
  // input is out of range so we can highlight + prevent apply.
  const validate = (text: string, min: number, max: number, isInt: boolean): { value: number; error: string | null } => {
    const n = parseFloat(text);
    if (isNaN(n)) return { value: 0, error: "Không phải số" };
    if (n < min || n > max) return { value: n, error: `Phải trong ${min}–${max}` };
    return { value: isInt ? Math.round(n) : n, error: null };
  };

  // Validate leverage first because TP/SL bounds depend on it.
  const levV = validate(leverageText, 1, 500, true);
  const lev = levV.error ? draft.leverage : levV.value;

  // TP/SL are entered as PnL% — bounds = raw_price_bound × leverage.
  // Raw price max 20% × lev → 2000% PnL max. Min 0.1% raw → 0.1×lev PnL min.
  const tpV = validate(tpText, 0.1 * lev, 20 * lev, false);
  const slV = validate(slText, 0.1 * lev, 10 * lev, false);
  const scoreV = validate(scoreText, 1, 5, true);
  const stochV = validate(stochOSText, 1, 49, true);
  const rsiV = validate(rsiOSText, 1, 49, true);

  const hasError = !!(levV.error || tpV.error || slV.error || scoreV.error || stochV.error || rsiV.error);

  // Convert PnL% → raw price% for storage (engine works in raw price)
  const tpRaw = tpV.error ? draft.targetPct : tpV.value / lev;
  const slRaw = slV.error ? draft.stopPct : slV.value / lev;

  const handleApply = () => {
    if (hasError) {
      setAppliedMsg("❌ Vui lòng sửa các giá trị sai trước khi áp dụng");
      setTimeout(() => setAppliedMsg(null), 4000);
      return;
    }
    const committed: BacktestConfig = {
      ...draft,
      leverage: lev,
      targetPct: tpRaw,
      stopPct: slRaw,
      minScore: scoreV.value,
      stochOSLevel: stochV.value,
      stochOBLevel: 100 - stochV.value,
      rsiOSLevel: rsiV.value,
      rsiOBLevel: 100 - rsiV.value,
    };
    setDraft(committed);

    if (targetTF === "ALL") onApplyAll(committed);
    else onApplyToTF(targetTF, committed);

    const shapeTxt = formatRuleShape(committed.requiredConditions);
    const scopeTxt = targetTF === "ALL" ? "TẤT CẢ khung" : targetTF;
    setAppliedMsg(
      `✓ Đã áp ${scopeTxt} · ${shapeTxt} · S≥${committed.minScore} · ` +
      `TP +${(committed.targetPct * committed.leverage).toFixed(0)}% PnL (giá +${committed.targetPct.toFixed(2)}%) / ` +
      `SL -${(committed.stopPct * committed.leverage).toFixed(0)}% PnL (giá -${committed.stopPct.toFixed(2)}%) · ` +
      `x${committed.leverage} · Stoch<${committed.stochOSLevel}/>${committed.stochOBLevel} · RSI<${committed.rsiOSLevel}/>${committed.rsiOBLevel}`
    );
    setTimeout(() => setAppliedMsg(null), 8000);
  };

  return (
    <View style={styles.manualBox}>
      <TouchableOpacity
        style={styles.manualHeader}
        onPress={() => setOpen(!open)}
      >
        <Text style={styles.manualTitle}>
          {open ? "▼" : "▶"} CHỈNH RULE THỦ CÔNG (TP/SL/Score/Stoch/RSI)
        </Text>
      </TouchableOpacity>

      {open && (
        <View style={styles.manualBody}>
          {/* Rule shape selector */}
          <Text style={styles.manualLabel}>Hình dạng rule (bắt buộc có điều kiện nào):</Text>
          <View style={styles.shapePills}>
            {RULE_SHAPE_PRESETS.map((p) => {
              const active = currentShapeId === p.id;
              return (
                <TouchableOpacity
                  key={p.id}
                  style={[styles.shapePill, active && styles.shapePillActive]}
                  onPress={() => setShapeId(p.id)}
                >
                  <Text style={[styles.shapePillText, active && styles.shapePillTextActive]}>
                    {p.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Leverage row — controls how PnL% maps to raw price % */}
          <View style={styles.leverageBox}>
            <View style={{ flex: 1 }}>
              <Text style={styles.manualLabel}>Đòn bẩy (x)</Text>
              <TextInput
                style={[styles.manualInput, levV.error && styles.manualInputError, { maxWidth: 100 }]}
                value={leverageText}
                onChangeText={setLeverageText}
                keyboardType="number-pad"
                maxLength={3}
                placeholder="100"
                placeholderTextColor={COLORS.textMuted}
              />
              {levV.error && <Text style={styles.manualErrorText}>{levV.error}</Text>}
            </View>
            <Text style={styles.leverageHint}>
              💡 TP/SL nhập theo % PnL (lời/lỗ trên vốn).{"\n"}
              VD: vốn 100u, x{lev} → SL 100% = mất 100u (giá ngược {(100/lev).toFixed(2)}%) · TP 200% = lời 200u (giá thuận {(200/lev).toFixed(2)}%)
            </Text>
          </View>

          {/* PnL% inputs */}
          <View style={styles.manualInputRow}>
            <View style={styles.manualInputCol}>
              <Text style={styles.manualLabel}>Chốt Lời TP — % PnL</Text>
              <TextInput
                style={[styles.manualInput, tpV.error && styles.manualInputError]}
                value={tpText}
                onChangeText={setTpText}
                keyboardType="decimal-pad"
                maxLength={6}
                placeholder={`VD: ${(2 * lev).toFixed(0)}`}
                placeholderTextColor={COLORS.textMuted}
              />
              {tpV.error
                ? <Text style={styles.manualErrorText}>{tpV.error}</Text>
                : <Text style={styles.manualHint}>= giá tăng {tpRaw.toFixed(2)}% (lời {tpV.value.toFixed(0)}u/100u)</Text>}
            </View>
            <View style={styles.manualInputCol}>
              <Text style={styles.manualLabel}>Cắt Lỗ SL — % PnL</Text>
              <TextInput
                style={[styles.manualInput, slV.error && styles.manualInputError]}
                value={slText}
                onChangeText={setSlText}
                keyboardType="decimal-pad"
                maxLength={6}
                placeholder={`VD: ${(1 * lev).toFixed(0)}`}
                placeholderTextColor={COLORS.textMuted}
              />
              {slV.error
                ? <Text style={styles.manualErrorText}>{slV.error}</Text>
                : <Text style={styles.manualHint}>= giá giảm {slRaw.toFixed(2)}% (mất {slV.value.toFixed(0)}u/100u)</Text>}
            </View>
            <View style={styles.manualInputCol}>
              <Text style={styles.manualLabel}>Score tối thiểu (1–5)</Text>
              <TextInput
                style={[styles.manualInput, scoreV.error && styles.manualInputError]}
                value={scoreText}
                onChangeText={setScoreText}
                keyboardType="number-pad"
                maxLength={1}
              />
              {scoreV.error
                ? <Text style={styles.manualErrorText}>{scoreV.error}</Text>
                : <Text style={styles.manualHint}>Cần {scoreText}/5 ĐK đúng</Text>}
            </View>
          </View>

          <View style={styles.manualInputRow}>
            <View style={styles.manualInputCol}>
              <Text style={styles.manualLabel}>StochRSI Quá Bán (1–49)</Text>
              <TextInput
                style={[styles.manualInput, stochV.error && styles.manualInputError]}
                value={stochOSText}
                onChangeText={setStochOSText}
                keyboardType="number-pad"
                maxLength={2}
              />
              {stochV.error
                ? <Text style={styles.manualErrorText}>{stochV.error}</Text>
                : <Text style={styles.manualHint}>Quá Mua = {100 - stochV.value}</Text>}
            </View>
            <View style={styles.manualInputCol}>
              <Text style={styles.manualLabel}>RSI Quá Bán (1–49)</Text>
              <TextInput
                style={[styles.manualInput, rsiV.error && styles.manualInputError]}
                value={rsiOSText}
                onChangeText={setRsiOSText}
                keyboardType="number-pad"
                maxLength={2}
              />
              {rsiV.error
                ? <Text style={styles.manualErrorText}>{rsiV.error}</Text>
                : <Text style={styles.manualHint}>Quá Mua = {100 - rsiV.value}</Text>}
            </View>
            <View style={styles.manualInputCol}>
              <Text style={styles.manualLabel}>R:R (Lời/Lỗ)</Text>
              <View style={[styles.manualInput, { justifyContent: "center", alignItems: "center" }]}>
                <Text style={{
                  color: (!tpV.error && !slV.error && tpV.value / slV.value >= 1.5) ? COLORS.bull : COLORS.warning,
                  fontFamily: "monospace",
                  fontWeight: "700",
                }}>
                  1 : {!tpV.error && !slV.error ? (tpV.value / slV.value).toFixed(2) : "—"}
                </Text>
              </View>
              <Text style={styles.manualHint}>Nên ≥ 1:1.5</Text>
            </View>
          </View>

          {/* TF picker */}
          <Text style={[styles.manualLabel, { marginTop: 8 }]}>Áp dụng cho:</Text>
          <View style={styles.tfPickerRow}>
            <TouchableOpacity
              style={[styles.tfPickerBtn, targetTF === "ALL" && styles.tfPickerBtnActive]}
              onPress={() => setTargetTF("ALL")}
            >
              <Text style={[styles.tfPickerText, targetTF === "ALL" && styles.tfPickerTextActive]}>
                TẤT CẢ
              </Text>
            </TouchableOpacity>
            {TIMEFRAMES.filter((tf) => tf.key !== "1M").map((tf) => (
              <TouchableOpacity
                key={tf.key}
                style={[styles.tfPickerBtn, targetTF === tf.key && styles.tfPickerBtnActive]}
                onPress={() => setTargetTF(tf.key)}
              >
                <Text style={[styles.tfPickerText, targetTF === tf.key && styles.tfPickerTextActive]}>
                  {tf.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <TouchableOpacity
            style={[styles.manualApplyBtn, hasError && styles.manualApplyBtnDisabled]}
            onPress={handleApply}
            disabled={hasError}
          >
            <Text style={[styles.manualApplyText, hasError && { color: COLORS.textMuted }]}>
              {hasError
                ? "⚠ SỬA LỖI Ở TRÊN TRƯỚC"
                : `✓ ÁP DỤNG RULE ${targetTF === "ALL" ? "CHO TẤT CẢ" : `CHO ${targetTF}`}`}
            </Text>
          </TouchableOpacity>

          {/* Confirmation banner — shows right after Apply so user sees exactly
              what was committed, with a green check and full rule string. */}
          {appliedMsg && (
            <View style={[
              styles.appliedBanner,
              appliedMsg.startsWith("❌") && styles.appliedBannerError,
            ]}>
              <Text style={[
                styles.appliedBannerText,
                appliedMsg.startsWith("❌") && { color: COLORS.bear },
              ]}>
                {appliedMsg}
              </Text>
            </View>
          )}

          <Text style={styles.manualFooterHint}>
            Rule áp tay sẽ được dùng cho backtest + tín hiệu live của khung đó. Chạy lại backtest để xem hiệu quả.
          </Text>
        </View>
      )}
    </View>
  );
}

const BacktestResults = React.memo(BacktestResultsInner);
export default BacktestResults;

const styles = StyleSheet.create({
  container: { backgroundColor: COLORS.bgCard, borderRadius: 12, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: "#ffffff10" },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 6 },
  title: { color: COLORS.bitcoin, fontSize: 13, fontWeight: "700", fontFamily: "monospace" },
  runBtn: { backgroundColor: COLORS.bitcoin + "20", paddingHorizontal: 12, paddingVertical: 5, borderRadius: 6, borderWidth: 1, borderColor: COLORS.bitcoin + "40" },
  runBtnText: { color: COLORS.bitcoin, fontSize: 10, fontWeight: "700", fontFamily: "monospace" },
  btnGroup: { flexDirection: "row", gap: 6 },
  clearBtn: { backgroundColor: COLORS.bear + "15", paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6, borderWidth: 1, borderColor: COLORS.bear + "30" },
  clearBtnText: { color: COLORS.bear, fontSize: 10, fontWeight: "700", fontFamily: "monospace" },
  optRunBtn: { backgroundColor: COLORS.warning + "20", paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6, borderWidth: 1, borderColor: COLORS.warning + "40" },
  optRunBtnText: { color: COLORS.warning, fontSize: 10, fontWeight: "700", fontFamily: "monospace" },
  sectionHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 6 },
  emptyBox: { backgroundColor: "#ffffff05", borderRadius: 8, padding: 14, marginVertical: 6, alignItems: "center" },
  emptyText: { color: COLORS.textDim, fontSize: 11, fontFamily: "monospace", textAlign: "center", lineHeight: 16 },
  emptyHint: { color: COLORS.textMuted, fontSize: 9, fontFamily: "monospace", marginTop: 6, textAlign: "center" },
  staleWarn: { backgroundColor: COLORS.warning + "10", borderRadius: 6, padding: 8, marginVertical: 6, borderLeftWidth: 3, borderLeftColor: COLORS.warning },
  staleWarnText: { color: COLORS.warning, fontSize: 10, fontFamily: "monospace" },
  sectionHint: { color: COLORS.textMuted, fontSize: 9, fontFamily: "monospace", marginBottom: 8, fontStyle: "italic" },
  // Per-TF run rows
  tfRunRow: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: "#ffffff06" },
  tfOptRunRow: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: "#ffffff06" },
  tfRunLabel: { color: COLORS.bitcoin, fontSize: 11, fontWeight: "800", fontFamily: "monospace", width: 36 },
  tfRunWR: { color: COLORS.textDim, fontSize: 10, fontFamily: "monospace", width: 60 },
  tfRunTrades: { color: COLORS.textMuted, fontSize: 9, fontFamily: "monospace", width: 36 },
  tfRunCache: { color: COLORS.textMuted, fontSize: 9, fontFamily: "monospace", width: 40 },
  tfRunAge: { color: COLORS.textMuted, fontSize: 9, fontFamily: "monospace", flex: 1, textAlign: "right" },
  tfRunEmpty: { color: COLORS.textMuted, fontSize: 9, fontFamily: "monospace", fontStyle: "italic", flex: 1 },
  tfRunBtn: { width: 34, height: 28, borderRadius: 5, backgroundColor: COLORS.bitcoin + "20", borderWidth: 1, borderColor: COLORS.bitcoin + "40", alignItems: "center", justifyContent: "center", marginLeft: 4 },
  tfRunBtnActive: { backgroundColor: COLORS.bitcoin + "40" },
  tfRunBtnText: { color: COLORS.bitcoin, fontSize: 14, fontWeight: "900", fontFamily: "monospace" },
  tfOptBtnTint: { backgroundColor: COLORS.warning + "20", borderColor: COLORS.warning + "40" },
  // Stop button (red-ish)
  stopBtn: { backgroundColor: COLORS.bear + "25", paddingHorizontal: 12, paddingVertical: 5, borderRadius: 6, borderWidth: 1, borderColor: COLORS.bear + "60" },
  stopBtnText: { color: COLORS.bear, fontSize: 10, fontWeight: "900", fontFamily: "monospace", letterSpacing: 1 },
  // Rule detail box (inside expanded backtest result)
  ruleDetailBox: { backgroundColor: COLORS.bitcoin + "08", borderRadius: 8, padding: 10, marginBottom: 10, borderLeftWidth: 3, borderLeftColor: COLORS.bitcoin + "80" },
  ruleDetailTitle: { color: COLORS.bitcoin, fontSize: 10, fontWeight: "800", fontFamily: "monospace", marginBottom: 8, letterSpacing: 1 },
  ruleDetailGrid: { gap: 4 },
  ruleDetailRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 3, borderBottomWidth: 1, borderBottomColor: "#ffffff06" },
  ruleDetailLabel: { color: COLORS.textDim, fontSize: 10, fontFamily: "monospace", flex: 1 },
  ruleDetailValue: { fontSize: 10, fontWeight: "800", fontFamily: "monospace", marginLeft: 6 },
  // PnL headline row
  pnlRow: { flexDirection: "row", gap: 6, marginBottom: 10 },
  pnlBox: { flex: 1, alignItems: "center", backgroundColor: "#ffffff05", paddingVertical: 8, borderRadius: 6 },
  pnlLabel: { color: COLORS.textMuted, fontSize: 8, fontFamily: "monospace", marginBottom: 2 },
  pnlVal: { fontSize: 13, fontWeight: "900", fontFamily: "monospace" },
  // Live rule panel (shows while running)
  liveRulePanel: {
    backgroundColor: COLORS.bitcoin + "0f",
    borderRadius: 8,
    padding: 10,
    marginBottom: 10,
    borderLeftWidth: 3,
    borderLeftColor: COLORS.bitcoin,
  },
  liveRuleTitle: { color: COLORS.bitcoin, fontSize: 11, fontWeight: "800", fontFamily: "monospace", marginBottom: 4, letterSpacing: 0.5 },
  liveRuleSubtitle: { color: COLORS.textMuted, fontSize: 9, fontFamily: "monospace", marginBottom: 8 },
  liveRuleSection: { color: COLORS.textDim, fontSize: 10, fontWeight: "700", fontFamily: "monospace", marginTop: 4, marginBottom: 4, letterSpacing: 0.5 },
  liveRuleKVBox: { backgroundColor: "#ffffff05", borderRadius: 6, padding: 8, gap: 2 },
  kvRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 2, borderBottomWidth: 1, borderBottomColor: "#ffffff06" },
  kvLabel: { color: COLORS.textDim, fontSize: 10, fontFamily: "monospace", flex: 1 },
  kvValue: { fontSize: 10, fontWeight: "700", fontFamily: "monospace", marginLeft: 8 },
  liveBestStatsRow: { flexDirection: "row", gap: 6, marginBottom: 8 },
  liveBestStatBox: { flex: 1, alignItems: "center", backgroundColor: COLORS.bull + "10", paddingVertical: 8, borderRadius: 6, borderWidth: 1, borderColor: COLORS.bull + "25" },
  liveBestStatVal: { fontSize: 16, fontWeight: "900", fontFamily: "monospace", color: COLORS.bull },
  liveBestStatLabel: { color: COLORS.textDim, fontSize: 9, fontWeight: "700", fontFamily: "monospace", marginTop: 2, letterSpacing: 0.5 },
  liveBestStatHint: { color: COLORS.textMuted, fontSize: 7, fontFamily: "monospace", marginTop: 1, fontStyle: "italic" },
  liveExplainer: { color: COLORS.textDim, fontSize: 9, fontFamily: "monospace", marginTop: 8, padding: 6, backgroundColor: COLORS.bitcoin + "08", borderRadius: 4, lineHeight: 13, fontStyle: "italic" },
  liveRuleChips: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  liveRuleHint: { color: COLORS.textMuted, fontSize: 10, fontFamily: "monospace", marginTop: 6, fontStyle: "italic" },
  // Per-TF rule preview (below each TF row in run list)
  tfRunBlock: { paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: "#ffffff06" },
  tfRulePreview: { color: COLORS.textDim, fontSize: 9, fontFamily: "monospace", paddingLeft: 42, paddingRight: 42, paddingBottom: 4, opacity: 0.85 },
  // Grid info box (before optimizer runs)
  gridInfoBox: { backgroundColor: COLORS.warning + "08", borderRadius: 8, padding: 10, marginTop: 6, borderWidth: 1, borderColor: COLORS.warning + "20" },
  gridInfoTitle: { color: COLORS.warning, fontSize: 10, fontWeight: "800", fontFamily: "monospace", marginBottom: 6 },
  gridInfoRow: { color: COLORS.textDim, fontSize: 9, fontFamily: "monospace", marginBottom: 2 },
  gridInfoFooter: { color: COLORS.textMuted, fontSize: 9, fontFamily: "monospace", marginTop: 6, fontStyle: "italic" },
  // Per-TF optimization
  applyAllBtn: { backgroundColor: COLORS.bull + "20", paddingVertical: 10, borderRadius: 6, borderWidth: 1, borderColor: COLORS.bull + "50", alignItems: "center", marginVertical: 10 },
  applyAllBtnText: { color: COLORS.bull, fontSize: 11, fontWeight: "900", fontFamily: "monospace", letterSpacing: 1 },
  tfOptBox: { backgroundColor: "#ffffff05", borderRadius: 8, padding: 10, marginBottom: 6, borderLeftWidth: 3, borderLeftColor: COLORS.warning + "60" },
  tfOptHeader: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 6 },
  tfOptLabel: { color: COLORS.bitcoin, fontSize: 12, fontWeight: "800", fontFamily: "monospace", width: 30 },
  tfOptWR: { fontSize: 11, fontWeight: "800", fontFamily: "monospace", width: 55 },
  tfOptTrades: { color: COLORS.textMuted, fontSize: 9, fontFamily: "monospace", width: 50 },
  tfOptPF: { fontSize: 9, fontWeight: "700", fontFamily: "monospace", flex: 1 },
  applyTFBtn: { backgroundColor: COLORS.warning + "20", paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4, borderWidth: 1, borderColor: COLORS.warning + "40" },
  applyTFBtnActive: { backgroundColor: COLORS.bull + "20", borderColor: COLORS.bull + "40" },
  applyTFBtnText: { color: COLORS.warning, fontSize: 9, fontWeight: "700", fontFamily: "monospace" },
  applyTFBtnTextActive: { color: COLORS.bull },
  tfOptRules: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  ruleChip: { flexDirection: "row", alignItems: "center", gap: 3, backgroundColor: "#ffffff08", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 3 },
  ruleChipLabel: { color: COLORS.textMuted, fontSize: 8, fontFamily: "monospace" },
  ruleChipVal: { fontSize: 9, fontWeight: "700", fontFamily: "monospace" },
  // Current config box
  currentCfgBox: { marginTop: 10, backgroundColor: COLORS.bull + "08", borderRadius: 8, padding: 10, borderWidth: 1, borderColor: COLORS.bull + "20" },
  currentCfgTitle: { color: COLORS.bull, fontSize: 10, fontWeight: "800", fontFamily: "monospace", marginBottom: 6, letterSpacing: 1 },
  currentCfgRow: { flexDirection: "row", alignItems: "center", paddingVertical: 3, gap: 6 },
  currentCfgTF: { color: COLORS.bitcoin, fontSize: 10, fontWeight: "700", fontFamily: "monospace", width: 30 },
  currentCfgText: { color: COLORS.textDim, fontSize: 9, fontFamily: "monospace", flex: 1 },
  // Status row
  statusRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 6 },
  statusDot: { width: 18, height: 18, borderRadius: 9, alignItems: "center", justifyContent: "center" },
  statusDotText: { color: "#fff", fontSize: 10, fontWeight: "900" },
  statusLabel: { fontSize: 10, fontWeight: "700", fontFamily: "monospace" },
  progressText: { color: COLORS.textDim, fontSize: 9, fontFamily: "monospace" },
  lastRun: { color: COLORS.textMuted, fontSize: 9, fontFamily: "monospace", marginLeft: "auto" },
  // Progress bar
  progressBarBg: { height: 3, backgroundColor: "#ffffff10", borderRadius: 2, marginBottom: 10, overflow: "hidden" },
  progressBarFill: { height: "100%", backgroundColor: COLORS.bitcoin, borderRadius: 2 },
  section: { marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: "#ffffff08" },
  sectionTitle: { color: COLORS.textDim, fontSize: 10, fontWeight: "700", fontFamily: "monospace", marginBottom: 8, letterSpacing: 1 },
  // Stats
  statGrid: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 8 },
  statBox: { flex: 1, minWidth: "18%", alignItems: "center", backgroundColor: "#ffffff05", padding: 8, borderRadius: 6 },
  statValue: { fontSize: 16, fontWeight: "900", fontFamily: "monospace" },
  statLabel: { color: COLORS.textMuted, fontSize: 7, fontWeight: "700", fontFamily: "monospace", marginTop: 2 },
  // TF rows
  tfRow: { flexDirection: "row", alignItems: "center", paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: "#ffffff06", gap: 8 },
  tfLabel: { color: COLORS.bitcoin, fontSize: 11, fontWeight: "700", fontFamily: "monospace", width: 30 },
  tfTrades: { color: COLORS.textMuted, fontSize: 9, fontFamily: "monospace", width: 50 },
  tfPF: { fontSize: 9, fontWeight: "700", fontFamily: "monospace", width: 40, textAlign: "right" },
  // Expanded
  expandedBox: { backgroundColor: "#ffffff05", borderRadius: 8, padding: 10, marginBottom: 6 },
  miniGrid: { flexDirection: "row", gap: 6, marginBottom: 8 },
  miniStatBox: { flex: 1, alignItems: "center", backgroundColor: "#ffffff05", padding: 6, borderRadius: 4 },
  miniStatVal: { fontSize: 13, fontWeight: "800", fontFamily: "monospace" },
  miniStatLabel: { color: COLORS.textMuted, fontSize: 7, fontFamily: "monospace", marginTop: 1 },
  // Score rows
  scoreGrid: { marginTop: 6 },
  subLabel: { color: COLORS.textMuted, fontSize: 9, fontWeight: "700", fontFamily: "monospace", marginBottom: 4 },
  scoreRow: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 2 },
  scoreLabel: { color: COLORS.textDim, fontSize: 9, fontFamily: "monospace", width: 65 },
  // Win rate bar
  wrBarContainer: { flex: 1, flexDirection: "row", alignItems: "center", gap: 4 },
  wrBarBg: { flex: 1, height: 6, backgroundColor: "#ffffff10", borderRadius: 3, overflow: "hidden" },
  wrBarFill: { height: "100%", borderRadius: 3 },
  wrBarText: { fontSize: 10, fontWeight: "800", fontFamily: "monospace", width: 30, textAlign: "right" },
  wrBarCount: { color: COLORS.textMuted, fontSize: 8, fontFamily: "monospace", width: 25 },
  // Best combo
  bestComboBox: { marginTop: 8, backgroundColor: COLORS.bull + "10", borderRadius: 6, padding: 8, borderWidth: 1, borderColor: COLORS.bull + "20" },
  bestComboTitle: { color: COLORS.bull, fontSize: 9, fontWeight: "700", fontFamily: "monospace" },
  bestComboText: { color: COLORS.text, fontSize: 10, fontWeight: "700", fontFamily: "monospace", marginTop: 2 },
  bestComboRate: { fontSize: 12, fontWeight: "900", fontFamily: "monospace", marginTop: 4 },
  // Optimization
  optBox: { backgroundColor: "#ffa50210", borderRadius: 8, padding: 12, borderWidth: 1, borderColor: "#ffa50230" },
  optTitle: { color: COLORS.warning, fontSize: 10, fontWeight: "800", fontFamily: "monospace", marginBottom: 6, textAlign: "center" },
  optRecommendation: { color: COLORS.textDim, fontSize: 10, fontFamily: "monospace", lineHeight: 16 },
  applyBtn: { marginTop: 10, backgroundColor: COLORS.bull + "20", paddingVertical: 8, borderRadius: 6, borderWidth: 1, borderColor: COLORS.bull + "40", alignItems: "center" },
  applyBtnText: { color: COLORS.bull, fontSize: 11, fontWeight: "900", fontFamily: "monospace" },
  // GA (Genetic Algorithm) styles
  gaBtn: { backgroundColor: COLORS.bull + "20", paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6, borderWidth: 1, borderColor: COLORS.bull + "40" },
  gaBtnText: { color: COLORS.bull, fontSize: 10, fontWeight: "800", fontFamily: "monospace" },
  gaHint: { color: COLORS.textMuted, fontSize: 9, fontFamily: "monospace", marginBottom: 8, fontStyle: "italic", lineHeight: 13 },
  tfGABtnTint: { backgroundColor: COLORS.bull + "15", borderColor: COLORS.bull + "40" },
  // Weights bar (per-condition learned weights)
  weightsBox: { gap: 3, marginVertical: 4 },
  weightRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  weightLabel: { color: COLORS.textDim, fontSize: 9, fontFamily: "monospace", width: 40 },
  weightBarBg: { flex: 1, height: 8, backgroundColor: "#ffffff10", borderRadius: 4, overflow: "hidden" },
  weightBarFill: { height: "100%", borderRadius: 4 },
  weightVal: { fontSize: 9, fontWeight: "800", fontFamily: "monospace", width: 30, textAlign: "right" },
  gaWeightsBox: { backgroundColor: COLORS.bull + "10", borderRadius: 6, padding: 8, marginVertical: 6, borderLeftWidth: 3, borderLeftColor: COLORS.bull },
  gaWeightsTitle: { color: COLORS.bull, fontSize: 9, fontWeight: "800", fontFamily: "monospace", marginBottom: 6, letterSpacing: 0.5 },
  // Grid editor — for tuning the optimizer's search space
  gridEditorBox: { marginTop: 6, marginBottom: 6, backgroundColor: COLORS.warning + "08", borderRadius: 8, borderWidth: 1, borderColor: COLORS.warning + "30" },
  gridEditorHeader: { padding: 10 },
  gridEditorTitle: { color: COLORS.warning, fontSize: 11, fontWeight: "800", fontFamily: "monospace", letterSpacing: 0.5 },
  gridEditorPreview: { color: COLORS.textMuted, fontSize: 8, fontFamily: "monospace", marginTop: 4, lineHeight: 12 },
  gridEditorBody: { paddingHorizontal: 10, paddingBottom: 10 },
  gridEditorHint: { color: COLORS.textDim, fontSize: 9, fontFamily: "monospace", lineHeight: 13, marginBottom: 10, padding: 6, backgroundColor: "#ffffff05", borderRadius: 4 },
  gridEditorSection: { color: COLORS.warning, fontSize: 10, fontWeight: "800", fontFamily: "monospace", letterSpacing: 0.5, marginBottom: 6 },
  gridEditorDivider: { height: 1, backgroundColor: COLORS.warning + "20", marginVertical: 10 },
  gridFilterRow: { flexDirection: "row", gap: 8, marginBottom: 8 },
  gridFilterCol: { flex: 1 },
  gridSummaryBox: { backgroundColor: COLORS.warning + "15", padding: 8, borderRadius: 6, borderLeftWidth: 3, borderLeftColor: COLORS.warning, marginTop: 4 },
  gridSummaryText: { color: COLORS.text, fontSize: 10, fontFamily: "monospace" },
  gridResetBtn: { marginTop: 8, paddingVertical: 8, backgroundColor: "#ffffff08", borderRadius: 5, borderWidth: 1, borderColor: "#ffffff20", alignItems: "center" },
  gridResetBtnText: { color: COLORS.textDim, fontSize: 10, fontWeight: "700", fontFamily: "monospace" },
  condInfoBox: { backgroundColor: COLORS.bull + "08", borderRadius: 6, padding: 10, marginBottom: 12, borderLeftWidth: 3, borderLeftColor: COLORS.bull + "60" },
  condInfoTitle: { color: COLORS.bull, fontSize: 10, fontWeight: "800", fontFamily: "monospace", marginBottom: 6, letterSpacing: 0.5 },
  condInfoRow: { color: COLORS.textDim, fontSize: 10, fontFamily: "monospace", lineHeight: 14, marginBottom: 1 },
  condInfoFooter: { color: COLORS.textDim, fontSize: 9, fontFamily: "monospace", marginTop: 6, lineHeight: 13, fontStyle: "italic" },
  condInfoRoadmap: { color: COLORS.textMuted, fontSize: 9, fontFamily: "monospace", marginTop: 6, lineHeight: 13, padding: 6, backgroundColor: COLORS.warning + "08", borderRadius: 4 },
  // List editor (one row of chips + add input)
  listEditorBox: { marginBottom: 10 },
  listChipsRow: { flexDirection: "row", flexWrap: "wrap", gap: 4, marginBottom: 4 },
  listChip: { flexDirection: "row", alignItems: "center", backgroundColor: "#ffffff08", borderRadius: 4, paddingLeft: 8, paddingRight: 4, paddingVertical: 3, borderWidth: 1, borderColor: "#ffffff15" },
  listChipText: { color: COLORS.text, fontSize: 9, fontFamily: "monospace", fontWeight: "700" },
  listChipRemove: { marginLeft: 4, paddingHorizontal: 4, paddingVertical: 1 },
  listChipRemoveText: { color: COLORS.bear, fontSize: 14, fontWeight: "900", lineHeight: 16 },
  listAddRow: { flexDirection: "row", gap: 6 },
  listAddBtn: { backgroundColor: COLORS.bull + "20", paddingHorizontal: 12, paddingVertical: 6, borderRadius: 5, borderWidth: 1, borderColor: COLORS.bull + "40", justifyContent: "center" },
  listAddBtnText: { color: COLORS.bull, fontSize: 10, fontWeight: "800", fontFamily: "monospace" },
  // Hard Rules panel (pre-baked rules from offline analysis)
  hardRulesBox: { backgroundColor: COLORS.bull + "08", borderRadius: 8, borderWidth: 1, borderColor: COLORS.bull + "40", marginBottom: 10 },
  hardRulesEmpty: { color: COLORS.textMuted, fontSize: 10, fontFamily: "monospace", padding: 12, textAlign: "center", lineHeight: 14 },
  hardRulesHeader: { paddingVertical: 10, paddingHorizontal: 12 },
  hardRulesTitle: { color: COLORS.bull, fontSize: 12, fontWeight: "900", fontFamily: "monospace", letterSpacing: 0.5, marginBottom: 2 },
  hardRulesSub: { color: COLORS.textMuted, fontSize: 9, fontFamily: "monospace", fontStyle: "italic" },
  hardRulesBody: { padding: 10, paddingTop: 4 },
  hardRulesIntro: { color: COLORS.textDim, fontSize: 9, fontFamily: "monospace", lineHeight: 13, marginBottom: 10, padding: 8, backgroundColor: "#ffffff05", borderRadius: 4 },
  hardRulesTFBox: { marginBottom: 8, backgroundColor: "#ffffff05", borderRadius: 6, padding: 8, borderLeftWidth: 3, borderLeftColor: COLORS.bull + "60" },
  hardRulesTFHead: { flexDirection: "row", alignItems: "center", marginBottom: 6, gap: 8 },
  hardRulesTFLabel: { color: COLORS.bitcoin, fontSize: 12, fontWeight: "900", fontFamily: "monospace", width: 36 },
  hardRulesTFMeta: { flex: 1, color: COLORS.textMuted, fontSize: 8, fontFamily: "monospace" },
  hardRulesTFExpand: { color: COLORS.bull, fontSize: 9, fontWeight: "700", fontFamily: "monospace" },
  hardRuleRow: { paddingVertical: 6, paddingHorizontal: 4, borderTopWidth: 1, borderTopColor: "#ffffff08" },
  hardRuleStatsRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 3 },
  hardRuleRank: { color: COLORS.warning, fontSize: 10, fontWeight: "900", fontFamily: "monospace", width: 26 },
  hardRuleSrcBadge: { paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3, borderWidth: 1 },
  hardRuleSrcText: { fontSize: 8, fontWeight: "800", fontFamily: "monospace" },
  hardRuleWR: { fontSize: 11, fontWeight: "900", fontFamily: "monospace", minWidth: 36 },
  hardRulePF: { color: COLORS.textDim, fontSize: 9, fontFamily: "monospace", minWidth: 38 },
  hardRuleTrades: { color: COLORS.textMuted, fontSize: 9, fontFamily: "monospace", flex: 1 },
  hardRuleApplyBtn: { backgroundColor: COLORS.bull + "20", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 4, borderWidth: 1, borderColor: COLORS.bull + "40" },
  hardRuleShape: { color: COLORS.textDim, fontSize: 9, fontFamily: "monospace", marginBottom: 2 },
  hardRuleTPSL: { fontSize: 9, fontFamily: "monospace", lineHeight: 13 },
  // Active rules panel — the "what rule is running" overview
  activeRulesBox: { backgroundColor: COLORS.bitcoin + "10", borderRadius: 8, borderWidth: 1, borderColor: COLORS.bitcoin + "40", marginBottom: 10 },
  activeRulesHeader: { paddingVertical: 10, paddingHorizontal: 12 },
  activeRulesTitle: { color: COLORS.bitcoin, fontSize: 12, fontWeight: "900", fontFamily: "monospace", letterSpacing: 0.5, marginBottom: 2 },
  activeRulesHint: { color: COLORS.textMuted, fontSize: 9, fontFamily: "monospace", fontStyle: "italic" },
  activeRulesBody: { padding: 10, paddingTop: 4 },
  activeRulesHeadRow: { flexDirection: "row", alignItems: "center", paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: COLORS.bitcoin + "30", marginBottom: 4, gap: 6 },
  activeRulesHeadText: { color: COLORS.textMuted, fontSize: 8, fontWeight: "800", fontFamily: "monospace", letterSpacing: 1 },
  activeRulesRow: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: "#ffffff08" },
  activeRulesRowExpanded: { backgroundColor: "#ffffff05", borderRadius: 6, paddingHorizontal: 6, marginVertical: 4, borderBottomWidth: 0 },
  activeRulesTopRow: { flexDirection: "row", alignItems: "center", gap: 4, marginBottom: 4 },
  activeRulesCellTF: { color: COLORS.bitcoin, fontSize: 12, fontWeight: "900", fontFamily: "monospace", width: 36 },
  activeRulesCellSrc: { width: 64, alignItems: "flex-start" },
  activeRulesCellStats: { flexDirection: "row", alignItems: "center", gap: 4, flex: 1 },
  activeRulesWR: { fontSize: 12, fontWeight: "900", fontFamily: "monospace", minWidth: 36 },
  activeRulesPF: { color: COLORS.textDim, fontSize: 9, fontFamily: "monospace", minWidth: 38 },
  activeRulesTrades: { color: COLORS.textMuted, fontSize: 9, fontFamily: "monospace", minWidth: 30 },
  activeRulesNoData: { color: COLORS.textMuted, fontSize: 9, fontFamily: "monospace", fontStyle: "italic" },
  activeRulesActions: { flexDirection: "row", gap: 3 },
  actionBtnTest: { minWidth: 42, paddingVertical: 4, paddingHorizontal: 4, borderRadius: 5, backgroundColor: COLORS.bitcoin + "20", borderWidth: 1, borderColor: COLORS.bitcoin + "40", alignItems: "center", justifyContent: "center" },
  actionBtnGrid: { minWidth: 42, paddingVertical: 4, paddingHorizontal: 4, borderRadius: 5, backgroundColor: COLORS.warning + "20", borderWidth: 1, borderColor: COLORS.warning + "40", alignItems: "center", justifyContent: "center" },
  actionBtnGA: { minWidth: 42, paddingVertical: 4, paddingHorizontal: 4, borderRadius: 5, backgroundColor: COLORS.bull + "20", borderWidth: 1, borderColor: COLORS.bull + "40", alignItems: "center", justifyContent: "center" },
  actionBtnExpand: { minWidth: 42, paddingVertical: 4, paddingHorizontal: 4, borderRadius: 5, backgroundColor: "#ffffff10", borderWidth: 1, borderColor: "#ffffff20", alignItems: "center", justifyContent: "center" },
  actionBtnIcon: { color: COLORS.text, fontSize: 13, fontWeight: "700", fontFamily: "monospace", lineHeight: 16 },
  actionBtnLabel: { fontSize: 8, fontWeight: "800", fontFamily: "monospace", marginTop: 1, letterSpacing: 0.3 },
  actionBtnText: { color: COLORS.text, fontSize: 12, fontWeight: "700", fontFamily: "monospace" },
  activeRulesRuleRow: { paddingLeft: 36 + 4, gap: 2 },
  activeRulesMeta: { color: COLORS.textMuted, fontSize: 8, fontFamily: "monospace", fontStyle: "italic" },
  activeRulesExpanded: { marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: "#ffffff10" },
  expandedSectionTitle: { color: COLORS.bull, fontSize: 10, fontWeight: "800", fontFamily: "monospace", marginBottom: 6, letterSpacing: 0.5 },
  expandedHint: { color: COLORS.textMuted, fontSize: 10, fontFamily: "monospace", fontStyle: "italic", textAlign: "center", padding: 8 },
  activeRulesCellRule: { flex: 1 },
  activeRuleBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 3, borderWidth: 1, alignSelf: "flex-start" },
  activeRuleBadgeText: { fontSize: 8, fontWeight: "900", fontFamily: "monospace", letterSpacing: 0.5 },
  activeRulesShape: { fontSize: 10, fontFamily: "monospace", marginBottom: 2 },
  activeRulesParams: { color: COLORS.textDim, fontSize: 9, fontFamily: "monospace", lineHeight: 13 },
  activeRulesFooter: { color: COLORS.textMuted, fontSize: 9, fontFamily: "monospace", marginTop: 8, lineHeight: 13, textAlign: "center" },
  // Manual rule editor (user can hand-set TP/SL/etc)
  manualBox: { marginTop: 8, backgroundColor: COLORS.bitcoin + "08", borderRadius: 8, borderWidth: 1, borderColor: COLORS.bitcoin + "30" },
  manualHeader: { paddingVertical: 10, paddingHorizontal: 12 },
  manualTitle: { color: COLORS.bitcoin, fontSize: 11, fontWeight: "800", fontFamily: "monospace", letterSpacing: 0.5 },
  manualBody: { padding: 10, paddingTop: 0 },
  manualLabel: { color: COLORS.textDim, fontSize: 10, fontFamily: "monospace", marginBottom: 4 },
  manualHint: { color: COLORS.textMuted, fontSize: 8, fontFamily: "monospace", marginTop: 2 },
  shapePills: { flexDirection: "row", flexWrap: "wrap", gap: 4, marginBottom: 10 },
  shapePill: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4, backgroundColor: "#ffffff08", borderWidth: 1, borderColor: "#ffffff15" },
  shapePillActive: { backgroundColor: COLORS.bitcoin + "30", borderColor: COLORS.bitcoin + "80" },
  shapePillText: { color: COLORS.textDim, fontSize: 9, fontFamily: "monospace", fontWeight: "700" },
  shapePillTextActive: { color: COLORS.bitcoin },
  manualInputRow: { flexDirection: "row", gap: 8, marginBottom: 8 },
  manualInputCol: { flex: 1 },
  manualInput: { backgroundColor: COLORS.bg, borderWidth: 1, borderColor: "#ffffff20", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 6, color: COLORS.text, fontSize: 13, fontFamily: "monospace", fontWeight: "700", textAlign: "center", minHeight: 34 },
  tfPickerRow: { flexDirection: "row", flexWrap: "wrap", gap: 4, marginBottom: 10 },
  tfPickerBtn: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 4, backgroundColor: "#ffffff08", borderWidth: 1, borderColor: "#ffffff20" },
  tfPickerBtnActive: { backgroundColor: COLORS.warning + "30", borderColor: COLORS.warning + "80" },
  tfPickerText: { color: COLORS.textDim, fontSize: 10, fontFamily: "monospace", fontWeight: "700" },
  tfPickerTextActive: { color: COLORS.warning },
  manualApplyBtn: { backgroundColor: COLORS.bull + "25", paddingVertical: 10, borderRadius: 6, borderWidth: 1, borderColor: COLORS.bull + "60", alignItems: "center", marginTop: 4 },
  manualApplyBtnDisabled: { backgroundColor: "#ffffff08", borderColor: "#ffffff20" },
  manualApplyText: { color: COLORS.bull, fontSize: 11, fontWeight: "900", fontFamily: "monospace", letterSpacing: 0.5 },
  manualInputError: { borderColor: COLORS.bear + "80", backgroundColor: COLORS.bear + "10" },
  leverageBox: { flexDirection: "row", gap: 10, alignItems: "flex-start", marginBottom: 10, padding: 8, backgroundColor: COLORS.warning + "08", borderRadius: 6, borderLeftWidth: 3, borderLeftColor: COLORS.warning + "60" },
  leverageHint: { flex: 2, color: COLORS.textDim, fontSize: 9, fontFamily: "monospace", lineHeight: 13 },
  manualErrorText: { color: COLORS.bear, fontSize: 8, fontFamily: "monospace", marginTop: 2, fontWeight: "700" },
  appliedBanner: { backgroundColor: COLORS.bull + "15", borderRadius: 6, padding: 8, marginTop: 8, borderLeftWidth: 3, borderLeftColor: COLORS.bull },
  appliedBannerError: { backgroundColor: COLORS.bear + "15", borderLeftColor: COLORS.bear },
  appliedBannerText: { color: COLORS.bull, fontSize: 10, fontFamily: "monospace", fontWeight: "700", lineHeight: 14 },
  manualFooterHint: { color: COLORS.textMuted, fontSize: 9, fontFamily: "monospace", fontStyle: "italic", marginTop: 6, textAlign: "center" },
  // Rule shape row (shows requiredConditions prominently)
  topShapeRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4, marginBottom: 4, paddingHorizontal: 2 },
  topShapeLabel: { color: COLORS.textMuted, fontSize: 9, fontFamily: "monospace" },
  topShapeValue: { fontSize: 10, fontWeight: "800", fontFamily: "monospace", flex: 1, letterSpacing: 0.5 },
  // Top-N list (multiple high-WR configs per TF)
  topListHeader: { marginTop: 8, paddingVertical: 6, paddingHorizontal: 6, backgroundColor: COLORS.bull + "10", borderRadius: 5, borderLeftWidth: 2, borderLeftColor: COLORS.bull + "80" },
  topListTitle: { color: COLORS.bull, fontSize: 10, fontWeight: "800", fontFamily: "monospace", letterSpacing: 0.5 },
  topListSubHint: { color: COLORS.warning, fontSize: 9, fontFamily: "monospace", marginTop: 4, fontStyle: "italic", lineHeight: 12 },
  topRow: { marginTop: 6, backgroundColor: "#ffffff05", borderRadius: 5, padding: 6, borderLeftWidth: 2, borderLeftColor: COLORS.warning + "40" },
  topRowHead: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 },
  topRank: { color: COLORS.warning, fontSize: 10, fontWeight: "900", fontFamily: "monospace", width: 28 },
  topWR: { fontSize: 11, fontWeight: "900", fontFamily: "monospace", width: 44 },
  topTrades: { color: COLORS.textMuted, fontSize: 9, fontFamily: "monospace", width: 30 },
  topPF: { fontSize: 9, fontWeight: "700", fontFamily: "monospace", width: 48 },
  topExpandIcon: { color: COLORS.textMuted, fontSize: 9, fontFamily: "monospace", flex: 1 },
  applyTopBtn: { backgroundColor: COLORS.warning + "20", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4, borderWidth: 1, borderColor: COLORS.warning + "40", minWidth: 32, alignItems: "center" },
  topRuleChips: { flexDirection: "row", flexWrap: "wrap", gap: 3, marginBottom: 2 },
  topDetailBox: { marginTop: 6, paddingTop: 6, borderTopWidth: 1, borderTopColor: "#ffffff10" },
  topBestCombo: { color: COLORS.bull, fontSize: 9, fontFamily: "monospace", marginTop: 6, fontStyle: "italic" },
  // Trials
  trialRow: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: "#ffffff06" },
  trialRank: { color: COLORS.textMuted, fontSize: 9, fontFamily: "monospace", width: 20 },
  trialLabel: { flex: 1, color: COLORS.textDim, fontSize: 8, fontFamily: "monospace" },
  trialWR: { fontSize: 10, fontWeight: "800", fontFamily: "monospace", width: 30 },
  trialTrades: { color: COLORS.textMuted, fontSize: 8, fontFamily: "monospace", width: 25 },
});
