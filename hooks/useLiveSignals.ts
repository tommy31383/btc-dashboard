import { useState, useEffect, useRef, useCallback } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { RawKlinesMap, Kline } from "./useBinanceKlines";
import { TIMEFRAMES } from "../utils/constants";
import {
  EntrySignal,
  BacktestConfig,
  DEFAULT_BACKTEST_CONFIG,
  checkLiveSignal,
} from "../utils/backtester";
import { ConfigByTF } from "./useBacktest";
import {
  notifyNewSignal,
  notifySignalClosed,
} from "../utils/notifications";

const LIVE_SIGNALS_KEY = "@btc_live_signals";
const MAX_SIGNAL_HISTORY = 100;

export interface LiveSignalRecord {
  id: string;
  signal: EntrySignal;
  tfLabel: string;
  tfKey: string;
  timestamp: number;
  // Tracking
  status: "ACTIVE" | "WIN" | "LOSS" | "EXPIRED";
  currentPrice?: number;
  currentPnlPct?: number;
  maxFavorable: number;
  maxAdverse: number;
  updatedAt: number;
}

export interface LiveSignalStats {
  totalSignals: number;
  activeSignals: number;
  wins: number;
  losses: number;
  expired: number;
  winRate: number;
  // Per-score stats
  scoreStats: Record<number, { total: number; wins: number; winRate: number }>;
}

export interface UseLiveSignalsResult {
  activeSignals: LiveSignalRecord[];
  signalHistory: LiveSignalRecord[];
  stats: LiveSignalStats;
  config: BacktestConfig;
}

export interface LiveSignalsOptions {
  configByTF?: ConfigByTF;
  notifyEntry?: boolean;
  notifyExit?: boolean;
  notifyMinScore?: number;
}

export function useLiveSignals(
  rawKlines: RawKlinesMap,
  config: BacktestConfig = DEFAULT_BACKTEST_CONFIG,
  opts: LiveSignalsOptions = {}
): UseLiveSignalsResult {
  const { configByTF = {}, notifyEntry = false, notifyExit = false, notifyMinScore = 3 } = opts;
  const [signals, setSignals] = useState<LiveSignalRecord[]>([]);
  const prevSignalKeysRef = useRef<Set<string>>(new Set());
  const lastCandleTimeRef = useRef<Record<string, number>>({});

  // Load from storage
  useEffect(() => {
    AsyncStorage.getItem(LIVE_SIGNALS_KEY).then((val) => {
      if (val) {
        try {
          const saved = JSON.parse(val) as LiveSignalRecord[];
          setSignals(saved.slice(-MAX_SIGNAL_HISTORY));
        } catch {}
      }
    });
  }, []);

  // Save to storage — debounced to avoid blocking on every update
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persist = useCallback((records: LiveSignalRecord[]) => {
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      AsyncStorage.setItem(
        LIVE_SIGNALS_KEY,
        JSON.stringify(records.slice(-MAX_SIGNAL_HISTORY))
      ).catch(() => {});
    }, 2000);
  }, []);

  // Check for new signals + update active ones
  useEffect(() => {
    if (Object.keys(rawKlines).length === 0) return;

    setSignals((prev) => {
      let updated = [...prev];
      const now = Date.now();
      const newSignalKeys = new Set<string>();

      // 1. Check each TF for new entry signals (using per-TF config)
      // Only run the heavy checkLiveSignal when the last candle time actually
      // changed for that TF — skips redundant CPU work on every refresh.
      for (const tf of TIMEFRAMES) {
        const klines = rawKlines[tf.key];
        if (!klines || klines.length < 60) continue;

        const lastTime = klines[klines.length - 1].time;
        const prevTime = lastCandleTimeRef.current[tf.key] ?? 0;
        if (lastTime === prevTime) continue;
        lastCandleTimeRef.current[tf.key] = lastTime;

        const tfConfig = configByTF[tf.key] || config;
        const signal = checkLiveSignal(klines as Kline[], tfConfig);
        if (!signal) continue;

        const signalKey = `${tf.key}-${signal.type}-${signal.score}`;
        newSignalKeys.add(signalKey);

        // Only add if not already tracking this signal
        const existing = updated.find(
          (s) => s.tfKey === tf.key && s.status === "ACTIVE"
        );
        if (!existing && !prevSignalKeysRef.current.has(signalKey)) {
          updated.push({
            id: `${tf.key}-${now}`,
            signal,
            tfLabel: tf.label,
            tfKey: tf.key,
            timestamp: now,
            status: "ACTIVE",
            currentPrice: signal.entryPrice,
            currentPnlPct: 0,
            maxFavorable: 0,
            maxAdverse: 0,
            updatedAt: now,
          });

          // Fire entry notification
          if (notifyEntry && signal.score >= notifyMinScore) {
            notifyNewSignal(tf.label, signal).catch(() => {});
          }
        }
      }

      prevSignalKeysRef.current = newSignalKeys;

      // 2. Update active signals with current price
      updated = updated.map((rec) => {
        if (rec.status !== "ACTIVE") return rec;

        const klines = rawKlines[rec.tfKey];
        if (!klines || klines.length === 0) return rec;

        const currentPrice = klines[klines.length - 1].close;
        const priceDelta = ((currentPrice - rec.signal.entryPrice) / rec.signal.entryPrice) * 100;
        const pnl = rec.signal.type === "LONG" ? priceDelta : -priceDelta;

        const maxFavorable = Math.max(rec.maxFavorable, pnl);
        const maxAdverse = Math.max(rec.maxAdverse, -pnl);

        // Check WIN/LOSS using the TF-specific config
        const recConfig = configByTF[rec.tfKey] || config;
        let status: LiveSignalRecord["status"] = "ACTIVE";
        if (pnl >= recConfig.targetPct) {
          status = "WIN";
        } else if (-pnl >= recConfig.stopPct) {
          status = "LOSS";
        } else if (now - rec.timestamp > 24 * 60 * 60 * 1000) {
          status = "EXPIRED";
        }

        // Fire exit notification when status just changed
        if (status !== "ACTIVE" && rec.status === "ACTIVE" && notifyExit) {
          notifySignalClosed(rec.tfLabel, rec.signal, status, pnl * recConfig.leverage).catch(() => {});
        }

        return {
          ...rec,
          currentPrice,
          currentPnlPct: pnl,
          maxFavorable,
          maxAdverse,
          status,
          updatedAt: now,
        };
      });

      // Keep only last N
      if (updated.length > MAX_SIGNAL_HISTORY) {
        updated = updated.slice(-MAX_SIGNAL_HISTORY);
      }

      persist(updated);
      return updated;
    });
  }, [rawKlines, config, configByTF, notifyEntry, notifyExit, notifyMinScore, persist]);

  // Compute stats
  const activeSignals = signals.filter((s) => s.status === "ACTIVE");
  const closed = signals.filter((s) => s.status !== "ACTIVE");
  const wins = closed.filter((s) => s.status === "WIN").length;
  const losses = closed.filter((s) => s.status === "LOSS").length;
  const expired = closed.filter((s) => s.status === "EXPIRED").length;
  const totalClosed = wins + losses;

  const scoreStats: Record<number, { total: number; wins: number; winRate: number }> = {};
  for (let s = 1; s <= 5; s++) {
    const filtered = closed.filter((r) => r.signal.score === s);
    const w = filtered.filter((r) => r.status === "WIN").length;
    scoreStats[s] = {
      total: filtered.length,
      wins: w,
      winRate: filtered.length > 0 ? (w / filtered.length) * 100 : 0,
    };
  }

  const stats: LiveSignalStats = {
    totalSignals: signals.length,
    activeSignals: activeSignals.length,
    wins,
    losses,
    expired,
    winRate: totalClosed > 0 ? (wins / totalClosed) * 100 : 0,
    scoreStats,
  };

  return {
    activeSignals,
    signalHistory: signals,
    stats,
    config,
  };
}
