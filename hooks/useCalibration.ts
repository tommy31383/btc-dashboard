/**
 * useCalibration — listen activeAlerts + currentPrice, tự log prediction +
 * paper-trade khi rule fire, tự resolve khi đến mature/SL/TP/timeout.
 *
 * KHÔNG modify useRuleAlerts để tránh đụng chạm logic eval phức tạp.
 * Side-effect only — return stats để UI hiển thị.
 */
import { useEffect, useRef, useState } from "react";
import { RuleAlert } from "./useRuleAlerts";
import {
  CalibStats,
  loadStats,
  loadPending,
  logPrediction,
  resolvePending,
} from "../utils/calibration";
import {
  PaperTrade,
  checkOpenTrades,
  loadTrades,
  openTrade,
  summarize,
  PaperTradeSummary,
} from "../utils/paperTrader";

export interface UseCalibrationResult {
  stats: CalibStats;
  pendingCount: number;
  trades: PaperTrade[];
  summary: PaperTradeSummary;
  /** Số pending vừa resolve trong tick gần nhất (để debug/notify nếu cần). */
  lastResolved: number;
}

const EMPTY_STATS: CalibStats = { buckets: {}, rules: {} };

export function useCalibration(
  activeAlerts: RuleAlert[],
  currentPrice: number | null,
): UseCalibrationResult {
  const [stats, setStats] = useState<CalibStats>(EMPTY_STATS);
  const [pendingCount, setPendingCount] = useState(0);
  const [trades, setTrades] = useState<PaperTrade[]>([]);
  const [lastResolved, setLastResolved] = useState(0);

  const lastFireKeyRef = useRef<Record<string, number>>({});

  useEffect(() => {
    (async () => {
      setStats(await loadStats());
      setPendingCount((await loadPending()).length);
      setTrades(await loadTrades());
    })();
  }, []);

  useEffect(() => {
    if (activeAlerts.length === 0) return;
    (async () => {
      let opened = false;
      for (const a of activeAlerts) {
        const key = `${a.id}:${a.firedAt}`;
        if (lastFireKeyRef.current[key]) continue;
        lastFireKeyRef.current[key] = 1;

        const stats = a.rule.stats as any;
        const cfg = a.rule.config as any;
        const rawConf = Math.max(0, Math.min(100, Math.round(stats.winRate ?? 50)));

        await logPrediction({
          ruleId: a.id,
          tfKey: a.tfKey,
          side: a.side === "BOTH" ? "LONG" : a.side,
          entryPrice: a.entryPrice,
          rawConf,
          barTimeMs: a.firedAt,
        });

        await openTrade({
          ruleId: a.id,
          tfKey: a.tfKey,
          side: a.side === "BOTH" ? "LONG" : a.side,
          entryPrice: a.entryPrice,
          slPrice: a.slPrice,
          tpPrice: a.tpPrice,
          leverage: cfg.leverage ?? 100,
          targetPct: cfg.targetPct ?? 1,
          stopPct: cfg.stopPct ?? 1,
          maxHoldBars: cfg.maxHoldBars ?? 50,
          barTimeMs: a.firedAt,
        });
        opened = true;
      }
      if (opened) {
        setTrades(await loadTrades());
        setPendingCount((await loadPending()).length);
      }
    })();
  }, [activeAlerts]);

  useEffect(() => {
    if (currentPrice === null || currentPrice <= 0) return;
    (async () => {
      const getPrice = (_tf: string) => currentPrice;
      const resolved = await resolvePending(getPrice);
      const closed = await checkOpenTrades(getPrice);
      if (resolved > 0 || closed.length > 0) {
        setStats(await loadStats());
        setPendingCount((await loadPending()).length);
        setTrades(await loadTrades());
        setLastResolved(resolved);
      }
    })();
  }, [currentPrice]);

  const summary = summarize(trades);
  return { stats, pendingCount, trades, summary, lastResolved };
}
