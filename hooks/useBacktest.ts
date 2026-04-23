import { useState, useEffect, useCallback, useRef } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { BINANCE_REST, TIMEFRAMES } from "../utils/constants";
import {
  Candle,
  BacktestConfig,
  BacktestResult,
  OptimizationResult,
  OptimizeProgressInfo,
  OptimizeGridConfig,
  EvolveProgressInfo,
  DEFAULT_BACKTEST_CONFIG,
  DEFAULT_GRID_CONFIG,
  runBacktest,
  optimizeRules,
  evolveRules,
} from "../utils/backtester";
import { notifyBacktestDone, notifyOptimizerDone } from "../utils/notifications";

const BACKTEST_CACHE_KEY = "@btc_backtest_results";
const CONFIG_BY_TF_KEY = "@btc_backtest_config_by_tf";
const OPT_BY_TF_KEY = "@btc_opt_by_tf";
const CANDLES_CACHE_KEY = "@btc_backtest_candles";
const CONFIG_SOURCE_KEY = "@btc_config_source_by_tf";
const GRID_CONFIG_KEY = "@btc_grid_config";

/** Where each TF's currently-applied rule came from. Used by UI to show
 *  "[Mặc định] / [Tối ưu] / [Tay] / [HARD]" badges so user knows the rule's origin. */
export type ConfigSource = "default" | "manual" | "optimized" | "hard";
export type ConfigSourceByTF = Record<string, ConfigSource>;

const MAX_CACHED_CANDLES = 1000;

export type BacktestStatus = "IDLE" | "LOADED" | "RUNNING" | "DONE" | "ERROR";

export type ConfigByTF = Record<string, BacktestConfig>;
export type OptByTF = Record<string, OptimizationResult>;

// Per-TF running flags so multiple TFs can show independent loading state.
export type RunningByTF = Record<string, boolean>;

// Cached candles per TF + timestamp
interface CachedCandles {
  candles: Candle[];
  lastTime: number;
  fetchedAt: number;
}
type CandlesByTF = Record<string, CachedCandles>;

// Per-TF last-run timestamps (so UI can show "Xong 3m trước" per TF)
export type LastRunByTF = Record<string, number>;

export interface UseBacktestResult {
  results: BacktestResult[];
  optByTF: OptByTF;
  configByTF: ConfigByTF;
  configSourceByTF: ConfigSourceByTF;
  gridConfig: OptimizeGridConfig;
  setGridConfig: (next: OptimizeGridConfig) => void;
  resetGridConfig: () => void;
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
  // Current backtest rule being used (shows in header while running)
  activeBacktestInfo: { tfKey: string; tfLabel: string; config: BacktestConfig } | null;
  // Live optimizer trial info — which rule is being tested right now
  activeOptInfo: { tfKey: string; tfLabel: string; progress: OptimizeProgressInfo } | null;
  // Live genetic algorithm progress
  activeEvoInfo: { tfKey: string; tfLabel: string; progress: EvolveProgressInfo } | null;
  // Global fallback config (used if TF-specific not set)
  config: BacktestConfig;
  setConfig: (config: BacktestConfig) => void;
  setConfigForTF: (tfKey: string, config: BacktestConfig) => void;
  applyOptimizedAll: () => void;
  applyOptimizedForTF: (tfKey: string) => void;
  /** Apply a specific top config (by rank index 0..N-1) from optByTF[tfKey].topConfigs */
  applyTopConfigForTF: (tfKey: string, rankIndex: number) => void;
  /** Apply a pre-baked hard rule (from bundled hard_rules.json) for a TF */
  applyHardRuleForTF: (tfKey: string, config: BacktestConfig) => void;
  runBacktestForTF: (tfKey: string) => Promise<void>;
  runOptimizerForTF: (tfKey: string) => Promise<void>;
  runEvolutionForTF: (tfKey: string) => Promise<void>;
  runEvolutionAll: () => Promise<void>;
  runNow: () => Promise<void>;
  runOptimizerAll: () => Promise<void>;
  cancel: () => void;
  cancelOptimizer: () => void;
  cancelEvolution: () => void;
  clearCache: () => Promise<void>;
}

async function fetchKlinesRange(
  interval: string,
  startTime?: number,
  limit = 1000
): Promise<Candle[]> {
  const params = new URLSearchParams({
    symbol: "BTCUSDT",
    interval,
    limit: String(limit),
  });
  if (startTime && startTime > 0) params.set("startTime", String(startTime));
  const url = `${BINANCE_REST}/klines?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.map((k: any[]) => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

/**
 * Merge newly fetched candles into a cached set, replacing any overlap on
 * time key. Trims to the most recent MAX_CACHED_CANDLES.
 */
function mergeCandles(cached: Candle[], fresh: Candle[]): Candle[] {
  if (cached.length === 0) return fresh.slice(-MAX_CACHED_CANDLES);
  if (fresh.length === 0) return cached;
  const byTime = new Map<number, Candle>();
  for (const c of cached) byTime.set(c.time, c);
  for (const c of fresh) byTime.set(c.time, c); // fresh overwrites on collision
  const merged = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
  return merged.slice(-MAX_CACHED_CANDLES);
}

const yieldToUI = () => new Promise<void>((r) => setTimeout(r, 0));

export function useBacktest(): UseBacktestResult {
  const [results, setResults] = useState<BacktestResult[]>([]);
  const [optByTF, setOptByTF] = useState<OptByTF>({});
  const [configByTF, setConfigByTFState] = useState<ConfigByTF>({});
  const [loading, setLoading] = useState(false);
  const [optLoading, setOptLoading] = useState(false);
  const [status, setStatus] = useState<BacktestStatus>("IDLE");
  const [optStatus, setOptStatus] = useState<BacktestStatus>("IDLE");
  const [progress, setProgress] = useState("");
  const [progressPct, setProgressPct] = useState(0);
  const [optProgress, setOptProgress] = useState("");
  const [optProgressPct, setOptProgressPct] = useState(0);
  const [lastRun, setLastRun] = useState(0);
  const [lastOptRun, setLastOptRun] = useState(0);
  const [lastRunByTF, setLastRunByTF] = useState<LastRunByTF>({});
  const [lastOptRunByTF, setLastOptRunByTF] = useState<LastRunByTF>({});
  const [runningByTF, setRunningByTF] = useState<RunningByTF>({});
  const [runningOptByTF, setRunningOptByTF] = useState<RunningByTF>({});
  const [config, setConfigState] = useState<BacktestConfig>(DEFAULT_BACKTEST_CONFIG);
  const [configSourceByTF, setConfigSourceByTFState] = useState<ConfigSourceByTF>({});
  const [gridConfig, setGridConfigState] = useState<OptimizeGridConfig>(DEFAULT_GRID_CONFIG);
  const [activeBacktestInfo, setActiveBacktestInfo] = useState<
    { tfKey: string; tfLabel: string; config: BacktestConfig } | null
  >(null);
  const [activeOptInfo, setActiveOptInfo] = useState<
    { tfKey: string; tfLabel: string; progress: OptimizeProgressInfo } | null
  >(null);
  const [activeEvoInfo, setActiveEvoInfo] = useState<
    { tfKey: string; tfLabel: string; progress: EvolveProgressInfo } | null
  >(null);

  // Candles cache is kept in a ref — not in state — because it's large and
  // we don't want to trigger re-renders just from candle updates.
  const candlesByTFRef = useRef<CandlesByTF>({});
  const [candleCountByTF, setCandleCountByTF] = useState<Record<string, number>>({});

  const batchRunningRef = useRef(false);
  // Cancellation flags. When set to true, running loops bail at the next
  // yield point and clean up their state.
  const cancelRef = useRef(false);
  const cancelOptRef = useRef(false);
  const cancelEvoRef = useRef(false);

  // Migrate any partial/legacy BacktestConfig to the current full shape so
  // old cached configs (e.g. missing `leverage` after a schema bump) don't
  // cause `cfg.targetPct * cfg.leverage` to produce NaN downstream.
  const migrateConfig = (cfg: any): BacktestConfig => ({
    ...DEFAULT_BACKTEST_CONFIG,
    ...(cfg || {}),
    requiredConditions: Array.isArray(cfg?.requiredConditions) ? cfg.requiredConditions : [],
  });

  // Load cache on mount
  useEffect(() => {
    (async () => {
      try {
        const [resVal, cfgVal, optVal, candlesVal, srcVal, gridVal] = await Promise.all([
          AsyncStorage.getItem(BACKTEST_CACHE_KEY),
          AsyncStorage.getItem(CONFIG_BY_TF_KEY),
          AsyncStorage.getItem(OPT_BY_TF_KEY),
          AsyncStorage.getItem(CANDLES_CACHE_KEY),
          AsyncStorage.getItem(CONFIG_SOURCE_KEY),
          AsyncStorage.getItem(GRID_CONFIG_KEY),
        ]);
        if (resVal) {
          const cached = JSON.parse(resVal);
          if (cached.results && cached.timestamp) {
            // Migrate each result's config so display code can safely access
            // `r.config.leverage` etc. without undefined explosions.
            const migratedResults = cached.results.map((r: any) => ({
              ...r,
              config: migrateConfig(r.config),
            }));
            setResults(migratedResults);
            setLastRun(cached.timestamp);
            setLastRunByTF(cached.byTF || {});
            setStatus("LOADED");
            setProgress(`Đã tải ${migratedResults.length} khung từ cache`);
            setProgressPct(100);
          }
        }
        if (cfgVal) {
          const parsed = JSON.parse(cfgVal);
          const migrated: ConfigByTF = {};
          Object.entries(parsed || {}).forEach(([k, v]) => {
            migrated[k] = migrateConfig(v);
          });
          setConfigByTFState(migrated);
          const firstKey = Object.keys(migrated)[0];
          if (firstKey) setConfigState(migrated[firstKey]);
        }
        if (optVal) {
          const parsed = JSON.parse(optVal);
          if (parsed.byTF && parsed.timestamp) {
            // Also migrate inside optByTF — bestConfig + topConfigs[].config
            const migratedOpt: OptByTF = {};
            Object.entries(parsed.byTF as Record<string, any>).forEach(([k, v]) => {
              migratedOpt[k] = {
                ...v,
                bestConfig: migrateConfig(v.bestConfig),
                topConfigs: Array.isArray(v.topConfigs)
                  ? v.topConfigs.map((t: any) => ({
                      ...t,
                      config: migrateConfig(t.config),
                      result: t.result ? { ...t.result, config: migrateConfig(t.result?.config) } : t.result,
                    }))
                  : [],
              };
            });
            setOptByTF(migratedOpt);
            setLastOptRun(parsed.timestamp);
            setLastOptRunByTF(parsed.byTFTime || {});
            setOptStatus("LOADED");
          }
        }
        if (candlesVal) {
          const parsed = JSON.parse(candlesVal) as CandlesByTF;
          candlesByTFRef.current = parsed;
          const counts: Record<string, number> = {};
          Object.entries(parsed).forEach(([k, v]) => {
            counts[k] = v.candles?.length ?? 0;
          });
          setCandleCountByTF(counts);
        }
        if (srcVal) {
          try {
            const parsed = JSON.parse(srcVal);
            if (parsed && typeof parsed === "object") setConfigSourceByTFState(parsed);
          } catch {}
        }
        if (gridVal) {
          try {
            const parsed = JSON.parse(gridVal);
            if (parsed && typeof parsed === "object") {
              setGridConfigState({ ...DEFAULT_GRID_CONFIG, ...parsed });
            }
          } catch {}
        }
      } catch (e) {
        // If anything goes wrong loading cache, log it but don't crash —
        // user can always wipe via Clear button.
        // eslint-disable-next-line no-console
        console.warn("[useBacktest] cache load failed:", e);
      }
    })();
  }, []);

  const persistCandles = useCallback(() => {
    // Debounced-ish: fire-and-forget
    setTimeout(() => {
      try {
        AsyncStorage.setItem(
          CANDLES_CACHE_KEY,
          JSON.stringify(candlesByTFRef.current)
        ).catch(() => {});
      } catch {}
    }, 0);
  }, []);

  const persistConfigByTF = useCallback((map: ConfigByTF) => {
    AsyncStorage.setItem(CONFIG_BY_TF_KEY, JSON.stringify(map)).catch(() => {});
  }, []);

  const persistConfigSource = useCallback((map: ConfigSourceByTF) => {
    AsyncStorage.setItem(CONFIG_SOURCE_KEY, JSON.stringify(map)).catch(() => {});
  }, []);

  const setGridConfig = useCallback((next: OptimizeGridConfig) => {
    setGridConfigState(next);
    AsyncStorage.setItem(GRID_CONFIG_KEY, JSON.stringify(next)).catch(() => {});
  }, []);

  const resetGridConfig = useCallback(() => {
    setGridConfig(DEFAULT_GRID_CONFIG);
  }, [setGridConfig]);

  /** Set source = "manual" | "optimized" | "default" for a single TF */
  const tagSource = useCallback(
    (tfKey: string, source: ConfigSource) => {
      setConfigSourceByTFState((prev) => {
        const next = { ...prev, [tfKey]: source };
        persistConfigSource(next);
        return next;
      });
    },
    [persistConfigSource]
  );

  /** Same but for many TFs at once */
  const tagSourceMany = useCallback(
    (tfKeys: string[], source: ConfigSource) => {
      setConfigSourceByTFState((prev) => {
        const next = { ...prev };
        tfKeys.forEach((k) => { next[k] = source; });
        persistConfigSource(next);
        return next;
      });
    },
    [persistConfigSource]
  );

  const setConfig = useCallback((newConfig: BacktestConfig) => {
    // User explicitly applied a rule — OVERWRITE every TF's config so the
    // effect is immediately visible. (Previously we only filled in missing
    // ones, which meant "Apply to ALL" silently did nothing when TFs had
    // configs from a prior optimizer run.)
    setConfigState(newConfig);
    setConfigByTFState(() => {
      const next: ConfigByTF = {};
      TIMEFRAMES.filter((tf) => tf.key !== "1M").forEach((tf) => {
        next[tf.key] = newConfig;
      });
      persistConfigByTF(next);
      return next;
    });
    tagSourceMany(TIMEFRAMES.filter((tf) => tf.key !== "1M").map((tf) => tf.key), "manual");
  }, [persistConfigByTF, tagSourceMany]);

  const setConfigForTF = useCallback((tfKey: string, newConfig: BacktestConfig) => {
    setConfigByTFState((prev) => {
      const next = { ...prev, [tfKey]: newConfig };
      persistConfigByTF(next);
      return next;
    });
    tagSource(tfKey, "manual");
  }, [persistConfigByTF, tagSource]);

  /**
   * Fetch candles incrementally. If we have a cache for this TF, only request
   * new candles since the last cached candle time.
   */
  const loadCandlesForTF = useCallback(
    async (tfKey: string, interval: string): Promise<{ candles: Candle[]; newCount: number }> => {
      const cached = candlesByTFRef.current[tfKey];
      if (cached && cached.candles.length >= MAX_CACHED_CANDLES / 2) {
        // Incremental: fetch only from lastTime (small request — usually <= a
        // few candles). startTime is inclusive so the last cached candle is
        // returned again and replaced (handles still-forming candles).
        const fresh = await fetchKlinesRange(interval, cached.lastTime, 1000);
        const merged = mergeCandles(cached.candles, fresh);
        const newOnes = fresh.filter((c) => c.time > cached.lastTime).length;
        const lastTime = merged[merged.length - 1]?.time ?? cached.lastTime;
        candlesByTFRef.current[tfKey] = {
          candles: merged,
          lastTime,
          fetchedAt: Date.now(),
        };
        return { candles: merged, newCount: newOnes };
      }
      // Cold path: first run or short cache — fetch full 1000
      const fresh = await fetchKlinesRange(interval, undefined, 1000);
      const lastTime = fresh[fresh.length - 1]?.time ?? 0;
      candlesByTFRef.current[tfKey] = {
        candles: fresh,
        lastTime,
        fetchedAt: Date.now(),
      };
      return { candles: fresh, newCount: fresh.length };
    },
    []
  );

  const persistResults = useCallback((nextResults: BacktestResult[], byTFTime: LastRunByTF, ts: number) => {
    AsyncStorage.setItem(
      BACKTEST_CACHE_KEY,
      JSON.stringify({ results: nextResults, timestamp: ts, byTF: byTFTime })
    ).catch(() => {});
  }, []);

  const persistOpt = useCallback((nextOpt: OptByTF, byTFTime: LastRunByTF, ts: number) => {
    AsyncStorage.setItem(
      OPT_BY_TF_KEY,
      JSON.stringify({ byTF: nextOpt, timestamp: ts, byTFTime })
    ).catch(() => {});
  }, []);

  /**
   * Run backtest for a single TF — fetches only new candles since last run,
   * runs the backtest, updates state, fires a push notification.
   */
  const runBacktestForTF = useCallback(
    async (tfKey: string): Promise<void> => {
      const tf = TIMEFRAMES.find((t) => t.key === tfKey);
      if (!tf || tf.key === "1M") return;

      cancelRef.current = false;
      const tfConfigActive = configByTF[tf.key] || config;
      setActiveBacktestInfo({ tfKey: tf.key, tfLabel: tf.label, config: tfConfigActive });
      setRunningByTF((prev) => ({ ...prev, [tfKey]: true }));
      setLoading(true);
      setStatus("RUNNING");
      setProgress(`${tf.label}: tải dữ liệu...`);
      setProgressPct(20);

      try {
        const { candles, newCount } = await loadCandlesForTF(tf.key, tf.interval);
        if (cancelRef.current) {
          setProgress(`${tf.label}: đã dừng`);
          setStatus("IDLE");
          return;
        }
        if (candles.length < 100) {
          setProgress(`${tf.label}: chưa đủ dữ liệu`);
          return;
        }

        setProgress(`${tf.label}: phân tích ${candles.length} nến${newCount > 0 ? ` (+${newCount} mới)` : ""}...`);
        setProgressPct(60);
        await yieldToUI();
        if (cancelRef.current) {
          setProgress(`${tf.label}: đã dừng`);
          setStatus("IDLE");
          return;
        }

        const tfConfig = configByTF[tf.key] || config;
        const result = runBacktest(candles, tf.label, tfConfig);

        const now = Date.now();

        setResults((prev) => {
          const idx = prev.findIndex((r) => r.timeframe === tf.label);
          const next = idx >= 0 ? [...prev.slice(0, idx), result, ...prev.slice(idx + 1)] : [...prev, result];

          // Keep persisted results in sync
          setLastRunByTF((prevTime) => {
            const nextTime = { ...prevTime, [tfKey]: now };
            persistResults(next, nextTime, now);
            return nextTime;
          });

          return next;
        });

        setLastRun(now);
        setStatus("DONE");
        setProgress(`${tf.label} xong · WR ${result.winRate.toFixed(0)}% · ${result.totalSignals} lệnh`);
        setProgressPct(100);

        setCandleCountByTF((prev) => ({ ...prev, [tfKey]: candles.length }));
        persistCandles();

        // Push notification
        notifyBacktestDone(
          tf.label,
          result.winRate,
          result.totalSignals,
          result.profitFactor,
          newCount
        ).catch(() => {});
      } catch (e) {
        setStatus("ERROR");
        setProgress(`${tf.label}: lỗi`);
      } finally {
        setLoading(false);
        setActiveBacktestInfo(null);
        setRunningByTF((prev) => {
          const next = { ...prev };
          delete next[tfKey];
          return next;
        });
      }
    },
    [config, configByTF, loadCandlesForTF, persistCandles, persistResults]
  );

  /**
   * Run optimizer for a single TF — uses cached candles when available, runs
   * grid search, fires push notification with best config.
   */
  const runOptimizerForTF = useCallback(
    async (tfKey: string): Promise<void> => {
      const tf = TIMEFRAMES.find((t) => t.key === tfKey);
      if (!tf || tf.key === "1M") return;

      cancelOptRef.current = false;
      setRunningOptByTF((prev) => ({ ...prev, [tfKey]: true }));
      setOptLoading(true);
      setOptStatus("RUNNING");
      setOptProgress(`${tf.label}: tải dữ liệu...`);
      setOptProgressPct(10);

      try {
        const { candles, newCount } = await loadCandlesForTF(tf.key, tf.interval);
        if (cancelOptRef.current) {
          setOptProgress(`${tf.label}: đã dừng`);
          setOptStatus("IDLE");
          return;
        }
        if (candles.length < 100) {
          setOptProgress(`${tf.label}: chưa đủ dữ liệu`);
          return;
        }

        setOptProgress(`${tf.label}: tối ưu ${candles.length} nến${newCount > 0 ? ` (+${newCount} mới)` : ""}...`);
        setOptProgressPct(15);
        await yieldToUI();

        const optResult = await optimizeRules(candles, config, {
          gridConfig,
          isCancelled: () => cancelOptRef.current,
          onProgress: (info) => {
            // Scale pct [0..1] to [15..95] so header shows fetch+compute progress
            setOptProgressPct(15 + Math.round(info.pct * 80));
            const best = info.bestSoFar;
            const bestStr = best
              ? ` · best WR ${best.winRate.toFixed(0)}% (${best.trades}L)`
              : "";
            setOptProgress(`${tf.label}: ${info.label}${bestStr}`);
            setActiveOptInfo({ tfKey: tf.key, tfLabel: tf.label, progress: info });
          },
        });

        if (cancelOptRef.current) {
          setOptProgress(`${tf.label}: đã dừng`);
          setOptStatus("IDLE");
          return;
        }

        const now = Date.now();

        setOptByTF((prev) => {
          const next = { ...prev, [tfKey]: optResult };
          setLastOptRunByTF((prevTime) => {
            const nextTime = { ...prevTime, [tfKey]: now };
            persistOpt(next, nextTime, now);
            return nextTime;
          });
          return next;
        });

        setLastOptRun(now);
        setOptStatus("DONE");
        setOptProgress(
          `${tf.label} xong · Best WR ${optResult.bestWinRate.toFixed(0)}% · ${optResult.bestTrades} lệnh`
        );
        setOptProgressPct(100);

        setCandleCountByTF((prev) => ({ ...prev, [tfKey]: candles.length }));
        persistCandles();

        notifyOptimizerDone(
          tf.label,
          optResult.bestWinRate,
          optResult.bestTrades,
          optResult.bestProfitFactor,
          optResult.bestConfig
        ).catch(() => {});
      } catch (e) {
        setOptStatus("ERROR");
        setOptProgress(`${tf.label}: lỗi`);
      } finally {
        setOptLoading(false);
        setActiveOptInfo(null);
        setRunningOptByTF((prev) => {
          const next = { ...prev };
          delete next[tfKey];
          return next;
        });
      }
    },
    [config, gridConfig, loadCandlesForTF, persistCandles, persistOpt]
  );

  /**
   * Run genetic-algorithm evolution for one TF. Stores result into optByTF
   * (same shape as optimizer output) so the existing "Top N" UI can display
   * GA-discovered weighted rules without changes.
   */
  const runEvolutionForTF = useCallback(
    async (tfKey: string): Promise<void> => {
      const tf = TIMEFRAMES.find((t) => t.key === tfKey);
      if (!tf || tf.key === "1M") return;

      cancelEvoRef.current = false;
      setRunningOptByTF((prev) => ({ ...prev, [tfKey]: true }));
      setOptLoading(true);
      setOptStatus("RUNNING");
      setOptProgress(`${tf.label}: GA tải dữ liệu...`);
      setOptProgressPct(5);

      try {
        const { candles, newCount } = await loadCandlesForTF(tf.key, tf.interval);
        if (cancelEvoRef.current) {
          setOptProgress(`${tf.label}: GA đã dừng`);
          setOptStatus("IDLE");
          return;
        }
        if (candles.length < 100) {
          setOptProgress(`${tf.label}: chưa đủ dữ liệu`);
          return;
        }

        setOptProgress(`${tf.label}: GA tiến hóa ${candles.length} nến${newCount > 0 ? ` (+${newCount} mới)` : ""}...`);
        setOptProgressPct(10);
        await yieldToUI();

        const evoResult = await evolveRules(candles, config, {
          isCancelled: () => cancelEvoRef.current,
          populationSize: 50,
          generations: 30,
          topN: gridConfig.topN,
          minWinRate: gridConfig.minWinRate,
          minTrades: gridConfig.minTrades,
          onProgress: (info) => {
            setOptProgressPct(10 + Math.round(info.pct * 85));
            const best = info.bestSoFar;
            const bestStr = best
              ? ` · best WR ${best.winRate.toFixed(0)}% (${best.trades}L)`
              : "";
            setOptProgress(`${tf.label}: 🧬 Gen ${info.generation}/${info.totalGenerations} (${info.evaluated} evals)${bestStr}`);
            setActiveEvoInfo({ tfKey: tf.key, tfLabel: tf.label, progress: info });
          },
        });

        if (cancelEvoRef.current) {
          setOptProgress(`${tf.label}: GA đã dừng`);
          setOptStatus("IDLE");
          return;
        }

        const now = Date.now();

        setOptByTF((prev) => {
          const next = { ...prev, [tfKey]: evoResult };
          setLastOptRunByTF((prevTime) => {
            const nextTime = { ...prevTime, [tfKey]: now };
            persistOpt(next, nextTime, now);
            return nextTime;
          });
          return next;
        });

        setLastOptRun(now);
        setOptStatus("DONE");
        setOptProgress(
          `${tf.label} GA xong · Best WR ${evoResult.bestWinRate.toFixed(0)}% · ${evoResult.bestTrades} lệnh`
        );
        setOptProgressPct(100);

        setCandleCountByTF((prev) => ({ ...prev, [tfKey]: candles.length }));
        persistCandles();

        notifyOptimizerDone(
          `${tf.label} 🧬`,
          evoResult.bestWinRate,
          evoResult.bestTrades,
          evoResult.bestProfitFactor,
          evoResult.bestConfig
        ).catch(() => {});
      } catch (e) {
        setOptStatus("ERROR");
        setOptProgress(`${tf.label} GA: lỗi`);
      } finally {
        setOptLoading(false);
        setActiveEvoInfo(null);
        setRunningOptByTF((prev) => {
          const next = { ...prev };
          delete next[tfKey];
          return next;
        });
      }
    },
    [config, gridConfig, loadCandlesForTF, persistCandles, persistOpt]
  );

  const runEvolutionAll = useCallback(async () => {
    if (batchRunningRef.current) return;
    batchRunningRef.current = true;
    cancelEvoRef.current = false;
    try {
      const testTFs = TIMEFRAMES.filter((tf) => tf.key !== "1M");
      for (let i = 0; i < testTFs.length; i++) {
        if (cancelEvoRef.current) {
          setOptProgress(`GA đã dừng (${i}/${testTFs.length})`);
          setOptStatus("IDLE");
          break;
        }
        const tf = testTFs[i];
        setOptProgress(`GA ${i + 1}/${testTFs.length} · ${tf.label}...`);
        setOptProgressPct(Math.round((i / testTFs.length) * 100));
        await runEvolutionForTF(tf.key);
        if (cancelEvoRef.current) {
          setOptProgress(`GA đã dừng (${i + 1}/${testTFs.length})`);
          setOptStatus("IDLE");
          break;
        }
        await yieldToUI();
      }
      if (!cancelEvoRef.current) {
        setOptProgress(`GA hoàn tất tiến hóa ${testTFs.length} khung`);
        setOptProgressPct(100);
      }
    } finally {
      batchRunningRef.current = false;
    }
  }, [runEvolutionForTF]);

  const cancelEvolution = useCallback(() => {
    cancelEvoRef.current = true;
  }, []);

  // Batch orchestrators — run per-TF sequentially with yield between each.
  // Each loop iteration checks cancelRef / cancelOptRef so "Dừng" works both
  // mid-TF and between TFs.
  const runNow = useCallback(async () => {
    if (batchRunningRef.current) return;
    batchRunningRef.current = true;
    cancelRef.current = false;
    try {
      const testTFs = TIMEFRAMES.filter((tf) => tf.key !== "1M");
      for (let i = 0; i < testTFs.length; i++) {
        if (cancelRef.current) {
          setProgress(`Đã dừng (${i}/${testTFs.length})`);
          setStatus("IDLE");
          break;
        }
        const tf = testTFs[i];
        setProgress(`${i + 1}/${testTFs.length} · ${tf.label}...`);
        setProgressPct(Math.round((i / testTFs.length) * 100));
        await runBacktestForTF(tf.key);
        if (cancelRef.current) {
          setProgress(`Đã dừng (${i + 1}/${testTFs.length})`);
          setStatus("IDLE");
          break;
        }
        await yieldToUI();
      }
      if (!cancelRef.current) {
        setProgress(`Hoàn tất ${testTFs.length} khung`);
        setProgressPct(100);
      }
    } finally {
      batchRunningRef.current = false;
    }
  }, [runBacktestForTF]);

  const runOptimizerAll = useCallback(async () => {
    if (batchRunningRef.current) return;
    batchRunningRef.current = true;
    cancelOptRef.current = false;
    try {
      const testTFs = TIMEFRAMES.filter((tf) => tf.key !== "1M");
      for (let i = 0; i < testTFs.length; i++) {
        if (cancelOptRef.current) {
          setOptProgress(`Đã dừng (${i}/${testTFs.length})`);
          setOptStatus("IDLE");
          break;
        }
        const tf = testTFs[i];
        setOptProgress(`${i + 1}/${testTFs.length} · ${tf.label}...`);
        setOptProgressPct(Math.round((i / testTFs.length) * 100));
        await runOptimizerForTF(tf.key);
        if (cancelOptRef.current) {
          setOptProgress(`Đã dừng (${i + 1}/${testTFs.length})`);
          setOptStatus("IDLE");
          break;
        }
        await yieldToUI();
      }
      if (!cancelOptRef.current) {
        setOptProgress(`Hoàn tất tối ưu ${testTFs.length} khung`);
        setOptProgressPct(100);
      }
    } finally {
      batchRunningRef.current = false;
    }
  }, [runOptimizerForTF]);

  const cancel = useCallback(() => {
    cancelRef.current = true;
  }, []);

  const cancelOptimizer = useCallback(() => {
    cancelOptRef.current = true;
  }, []);

  const applyOptimizedForTF = useCallback(
    (tfKey: string) => {
      const opt = optByTF[tfKey];
      if (opt?.bestConfig) {
        setConfigForTF(tfKey, opt.bestConfig);
        tagSource(tfKey, "optimized"); // override "manual" tag setConfigForTF set
      }
    },
    [optByTF, setConfigForTF, tagSource]
  );

  const applyTopConfigForTF = useCallback(
    (tfKey: string, rankIndex: number) => {
      const opt = optByTF[tfKey];
      const top = opt?.topConfigs?.[rankIndex];
      if (top?.config) {
        setConfigForTF(tfKey, top.config);
        tagSource(tfKey, "optimized");
      }
    },
    [optByTF, setConfigForTF, tagSource]
  );

  const applyHardRuleForTF = useCallback(
    (tfKey: string, cfg: BacktestConfig) => {
      setConfigForTF(tfKey, cfg);
      tagSource(tfKey, "hard");
    },
    [setConfigForTF, tagSource]
  );

  const applyOptimizedAll = useCallback(() => {
    const next: ConfigByTF = { ...configByTF };
    const appliedKeys: string[] = [];
    Object.entries(optByTF).forEach(([tfKey, opt]) => {
      if (opt?.bestConfig) {
        next[tfKey] = opt.bestConfig;
        appliedKeys.push(tfKey);
      }
    });
    setConfigByTFState(next);
    persistConfigByTF(next);
    if (next["1h"]) setConfigState(next["1h"]);
    tagSourceMany(appliedKeys, "optimized");
  }, [optByTF, configByTF, persistConfigByTF, tagSourceMany]);

  const clearCache = useCallback(async () => {
    await Promise.all([
      AsyncStorage.removeItem(BACKTEST_CACHE_KEY),
      AsyncStorage.removeItem(OPT_BY_TF_KEY),
      AsyncStorage.removeItem(CANDLES_CACHE_KEY),
      AsyncStorage.removeItem(CONFIG_SOURCE_KEY),
    ]).catch(() => {});
    setConfigSourceByTFState({});
    candlesByTFRef.current = {};
    setResults([]);
    setOptByTF({});
    setLastRun(0);
    setLastOptRun(0);
    setLastRunByTF({});
    setLastOptRunByTF({});
    setStatus("IDLE");
    setOptStatus("IDLE");
    setProgress("");
    setOptProgress("");
    setProgressPct(0);
    setOptProgressPct(0);
    setCandleCountByTF({});
  }, []);

  return {
    results,
    optByTF,
    configByTF,
    configSourceByTF,
    gridConfig,
    setGridConfig,
    resetGridConfig,
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
    config,
    setConfig,
    setConfigForTF,
    applyOptimizedAll,
    applyOptimizedForTF,
    applyTopConfigForTF,
    applyHardRuleForTF,
    runBacktestForTF,
    runOptimizerForTF,
    runEvolutionForTF,
    runEvolutionAll,
    runNow: runNow,
    runOptimizerAll,
    cancel,
    cancelOptimizer,
    cancelEvolution,
    clearCache,
  };
}
