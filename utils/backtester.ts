import {
  calcRSI,
  calcStochRSI,
  calcMACD,
  calcBollinger,
  detectDivergence,
} from "./indicators";

// ====== TYPES ======

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface EntryConditions {
  stochExtreme: boolean;   // StochRSI K < 5 or > 95
  rsiExtreme: boolean;     // RSI < 25 or > 75
  divergence: boolean;     // Bullish/Bearish divergence
  bollingerTouch: boolean; // Price at/beyond Bollinger Band
  macdCross: boolean;      // MACD histogram changing direction
}

export interface EntrySignal {
  type: "LONG" | "SHORT";
  score: number;           // 0-5 conditions met
  conditions: EntryConditions;
  candleIndex: number;
  entryPrice: number;
  entryTime: number;
  targetPrice: number;     // +targetPct for LONG
  stopPrice: number;       // -stopPct for LONG
}

export interface TradeResult {
  signal: EntrySignal;
  outcome: "WIN" | "LOSS" | "TIMEOUT";
  exitPrice: number;
  exitTime: number;
  exitIndex: number;
  pnlPct: number;          // raw price change %
  leveragedPnlPct: number; // with leverage
  holdBars: number;        // how many candles held
  maxFavorable: number;    // max % move in favor
  maxAdverse: number;      // max % move against
}

export interface BacktestConfig {
  leverage: number;         // default 100
  targetPct: number;        // default 2 (price move to win)
  stopPct: number;          // default 1 (price move to lose)
  maxHoldBars: number;      // max candles before timeout, default 50
  minScore: number;         // minimum score to enter, default 3
  // Tunable thresholds
  stochOBLevel: number;     // default 95
  stochOSLevel: number;     // default 5
  rsiOBLevel: number;       // default 75
  rsiOSLevel: number;       // default 25
  /**
   * Required conditions — a rule "shape". If non-empty, an entry signal is
   * accepted ONLY when EVERY listed condition is true. This is how the
   * optimizer generates meaningfully different rule flavors, e.g.
   *   []                                 → pure minScore count (current default)
   *   ["stochExtreme", "macdCross"]      → must have StochRSI + MACD cross
   *   ["divergence"]                     → must have divergence (score can be low)
   * minScore is still applied on top as a secondary filter.
   */
  requiredConditions?: (keyof EntryConditions)[];
  /**
   * Per-condition weights (0-3). When present, entry uses WEIGHTED scoring
   * instead of binary count: signal = sum(weights[k] * condition[k]).
   * Entry requires `signal >= minWeightedScore`.
   *
   * This is how the genetic algorithm learns which conditions matter most
   * (weight=3) vs least (weight=0). Falls back to binary count + minScore
   * when undefined.
   */
  weights?: Partial<Record<keyof EntryConditions, number>>;
  /** Threshold for weighted scoring. Required when `weights` is set. */
  minWeightedScore?: number;
  /**
   * Restrict trades to one direction only.
   *   "LONG"  → only oversold (buy) entries
   *   "SHORT" → only overbought (sell) entries
   *   undefined → both directions (default)
   * Useful when one side has consistent edge but the other is noise.
   */
  forceSide?: "LONG" | "SHORT";
}

export const DEFAULT_BACKTEST_CONFIG: BacktestConfig = {
  leverage: 100,
  targetPct: 2,
  stopPct: 1,
  maxHoldBars: 50,
  minScore: 3,
  stochOBLevel: 95,
  stochOSLevel: 5,
  rsiOBLevel: 75,
  rsiOSLevel: 25,
  requiredConditions: [],
};

/**
 * Preset "rule shapes" the optimizer will try. Each is a distinct trading
 * philosophy — combined with threshold search these produce genuinely
 * different strategies, not just parameter tweaks.
 */
export const RULE_SHAPE_PRESETS: { id: string; label: string; required: (keyof EntryConditions)[] }[] = [
  { id: "any",            label: "Bất kỳ",                   required: [] },
  { id: "stoch",          label: "StochRSI cực trị",         required: ["stochExtreme"] },
  { id: "rsi",            label: "RSI cực trị",              required: ["rsiExtreme"] },
  { id: "macd",           label: "MACD đổi chiều",           required: ["macdCross"] },
  { id: "div",            label: "Phân kỳ",                  required: ["divergence"] },
  { id: "bb",             label: "Chạm Bollinger",           required: ["bollingerTouch"] },
  { id: "stoch+macd",     label: "Stoch + MACD",             required: ["stochExtreme", "macdCross"] },
  { id: "stoch+rsi",      label: "Stoch + RSI",              required: ["stochExtreme", "rsiExtreme"] },
  { id: "rsi+macd",       label: "RSI + MACD",               required: ["rsiExtreme", "macdCross"] },
  { id: "div+bb",         label: "Phân kỳ + Bollinger",      required: ["divergence", "bollingerTouch"] },
  { id: "stoch+div",      label: "Stoch + Phân kỳ",          required: ["stochExtreme", "divergence"] },
  { id: "stoch+rsi+macd", label: "Stoch + RSI + MACD",       required: ["stochExtreme", "rsiExtreme", "macdCross"] },
];

export interface BacktestResult {
  timeframe: string;
  totalSignals: number;
  trades: TradeResult[];
  wins: number;
  losses: number;
  timeouts: number;
  winRate: number;
  avgWinPct: number;
  avgLossPct: number;
  profitFactor: number;
  avgHoldBars: number;
  // Per-score breakdown
  scoreBreakdown: Record<number, { total: number; wins: number; winRate: number }>;
  // Per-condition win rates
  conditionWinRates: Record<keyof EntryConditions, { total: number; wins: number; winRate: number }>;
  // Best combination
  bestCombo: string;
  bestComboWinRate: number;
  // Config (rules) used to produce this result — needed so the UI can show
  // exactly which rules generated this number.
  config: BacktestConfig;
  // Sample size
  candlesAnalyzed: number;
}

// ====== CORE ENGINE ======

const MIN_LOOKBACK = 50; // Need at least 50 candles for indicators

/**
 * Compute entry conditions at a given candle index.
 * Uses all candles from 0..idx to compute indicators.
 */
function computeConditions(
  candles: Candle[],
  idx: number,
  config: BacktestConfig
): { conditions: EntryConditions; direction: "LONG" | "SHORT" | null } {
  if (idx < MIN_LOOKBACK) return { conditions: emptyConditions(), direction: null };

  const closes = candles.slice(0, idx + 1).map((c) => c.close);
  const price = candles[idx].close;

  // RSI
  const rsi = calcRSI(closes);
  if (rsi === null) return { conditions: emptyConditions(), direction: null };

  // StochRSI
  const stoch = calcStochRSI(closes);

  // MACD
  const macd = calcMACD(closes);

  // Bollinger
  const bb = calcBollinger(closes);

  // Divergence (needs 30+ candles)
  const div = closes.length >= 44 ? detectDivergence(closes) : null;

  // Previous MACD histogram for cross detection
  const prevCloses = candles.slice(0, idx).map((c) => c.close);
  const prevMacd = prevCloses.length >= 35 ? calcMACD(prevCloses) : null;

  // Determine direction
  let direction: "LONG" | "SHORT" | null = null;

  const isOversold = rsi < config.rsiOSLevel || (stoch.k !== null && stoch.k < config.stochOSLevel);
  const isOverbought = rsi > config.rsiOBLevel || (stoch.k !== null && stoch.k > config.stochOBLevel);

  if (isOversold) direction = "LONG";
  else if (isOverbought) direction = "SHORT";
  else return { conditions: emptyConditions(), direction: null };

  // Check conditions
  const conditions: EntryConditions = {
    stochExtreme: stoch.k !== null && (
      (direction === "LONG" && stoch.k < config.stochOSLevel) ||
      (direction === "SHORT" && stoch.k > config.stochOBLevel)
    ),
    rsiExtreme:
      (direction === "LONG" && rsi < config.rsiOSLevel) ||
      (direction === "SHORT" && rsi > config.rsiOBLevel),
    divergence:
      (direction === "LONG" && div === "BULLISH_DIV") ||
      (direction === "SHORT" && div === "BEARISH_DIV"),
    bollingerTouch: bb.lower !== null && bb.upper !== null && (
      (direction === "LONG" && price <= bb.lower) ||
      (direction === "SHORT" && price >= bb.upper)
    ),
    macdCross:
      macd.histogram !== null &&
      prevMacd !== null &&
      prevMacd.histogram !== null && (
        (direction === "LONG" && prevMacd.histogram < 0 && macd.histogram >= 0) ||
        (direction === "SHORT" && prevMacd.histogram > 0 && macd.histogram <= 0) ||
        (direction === "LONG" && macd.histogram > prevMacd.histogram) ||
        (direction === "SHORT" && macd.histogram < prevMacd.histogram)
      ),
  };

  return { conditions, direction };
}

function emptyConditions(): EntryConditions {
  return {
    stochExtreme: false,
    rsiExtreme: false,
    divergence: false,
    bollingerTouch: false,
    macdCross: false,
  };
}

function countScore(conditions: EntryConditions): number {
  return Object.values(conditions).filter(Boolean).length;
}

/** Compute weighted score using config.weights. Returns 0 when weights absent. */
function computeWeightedScore(conditions: EntryConditions, weights?: BacktestConfig["weights"]): number {
  if (!weights) return 0;
  let s = 0;
  if (conditions.stochExtreme)   s += weights.stochExtreme   ?? 0;
  if (conditions.rsiExtreme)     s += weights.rsiExtreme     ?? 0;
  if (conditions.divergence)     s += weights.divergence     ?? 0;
  if (conditions.bollingerTouch) s += weights.bollingerTouch ?? 0;
  if (conditions.macdCross)      s += weights.macdCross      ?? 0;
  return s;
}

/**
 * Simulate a trade from entry candle forward.
 * Returns the trade result.
 */
function simulateTrade(
  candles: Candle[],
  signal: EntrySignal,
  config: BacktestConfig
): TradeResult {
  const { entryPrice, type, candleIndex } = signal;
  let maxFavorable = 0;
  let maxAdverse = 0;
  const maxIdx = Math.min(candleIndex + config.maxHoldBars, candles.length - 1);

  for (let i = candleIndex + 1; i <= maxIdx; i++) {
    const candle = candles[i];
    // Check both high and low within the candle
    const highPct = ((candle.high - entryPrice) / entryPrice) * 100;
    const lowPct = ((candle.low - entryPrice) / entryPrice) * 100;

    if (type === "LONG") {
      maxFavorable = Math.max(maxFavorable, highPct);
      maxAdverse = Math.min(maxAdverse, lowPct);

      // Check stop first (within candle, assume stop hit if low touches)
      if (lowPct <= -config.stopPct) {
        return {
          signal, outcome: "LOSS",
          exitPrice: entryPrice * (1 - config.stopPct / 100),
          exitTime: candle.time, exitIndex: i,
          pnlPct: -config.stopPct,
          leveragedPnlPct: -config.stopPct * config.leverage,
          holdBars: i - candleIndex,
          maxFavorable, maxAdverse: Math.abs(maxAdverse),
        };
      }
      // Check target
      if (highPct >= config.targetPct) {
        return {
          signal, outcome: "WIN",
          exitPrice: entryPrice * (1 + config.targetPct / 100),
          exitTime: candle.time, exitIndex: i,
          pnlPct: config.targetPct,
          leveragedPnlPct: config.targetPct * config.leverage,
          holdBars: i - candleIndex,
          maxFavorable, maxAdverse: Math.abs(maxAdverse),
        };
      }
    } else {
      // SHORT
      maxFavorable = Math.max(maxFavorable, -lowPct); // favorable = price going down
      maxAdverse = Math.max(maxAdverse, highPct);     // adverse = price going up

      if (highPct >= config.stopPct) {
        return {
          signal, outcome: "LOSS",
          exitPrice: entryPrice * (1 + config.stopPct / 100),
          exitTime: candle.time, exitIndex: i,
          pnlPct: -config.stopPct,
          leveragedPnlPct: -config.stopPct * config.leverage,
          holdBars: i - candleIndex,
          maxFavorable, maxAdverse,
        };
      }
      if (-lowPct >= config.targetPct) {
        return {
          signal, outcome: "WIN",
          exitPrice: entryPrice * (1 - config.targetPct / 100),
          exitTime: candle.time, exitIndex: i,
          pnlPct: config.targetPct,
          leveragedPnlPct: config.targetPct * config.leverage,
          holdBars: i - candleIndex,
          maxFavorable, maxAdverse,
        };
      }
    }
  }

  // Timeout — close at last candle
  const lastCandle = candles[maxIdx];
  const closePct = ((lastCandle.close - entryPrice) / entryPrice) * 100;
  const pnl = type === "LONG" ? closePct : -closePct;

  return {
    signal, outcome: "TIMEOUT",
    exitPrice: lastCandle.close,
    exitTime: lastCandle.time, exitIndex: maxIdx,
    pnlPct: pnl,
    leveragedPnlPct: pnl * config.leverage,
    holdBars: maxIdx - candleIndex,
    maxFavorable, maxAdverse: Math.abs(maxAdverse),
  };
}

/**
 * Run full backtest on a candle array.
 */
export function runBacktest(
  candles: Candle[],
  timeframeLabel: string,
  config: BacktestConfig = DEFAULT_BACKTEST_CONFIG
): BacktestResult {
  const trades: TradeResult[] = [];
  let lastTradeEndIdx = 0;

  // Walk through candles
  for (let i = MIN_LOOKBACK; i < candles.length - config.maxHoldBars; i++) {
    // Skip if we're still in a previous trade
    if (i < lastTradeEndIdx) continue;

    const { conditions, direction } = computeConditions(candles, i, config);
    if (direction === null) continue;

    // Side restriction (LONG-only or SHORT-only rules)
    if (config.forceSide && direction !== config.forceSide) continue;

    const score = countScore(conditions);

    // Choose scoring mode: WEIGHTED if config.weights is set (genetic algo),
    // else binary minScore count (grid search / manual rules).
    if (config.weights && config.minWeightedScore !== undefined) {
      const ws = computeWeightedScore(conditions, config.weights);
      if (ws < config.minWeightedScore) continue;
    } else {
      if (score < config.minScore) continue;
    }

    // "Rule shape" filter — reject entries that are missing any required
    // condition. This is how the optimizer differentiates strategies like
    // "Stoch + MACD must both fire" from "any 3 of 5".
    if (config.requiredConditions && config.requiredConditions.length > 0) {
      const missing = config.requiredConditions.some((k) => !conditions[k]);
      if (missing) continue;
    }

    const entryPrice = candles[i].close;
    const signal: EntrySignal = {
      type: direction,
      score,
      conditions,
      candleIndex: i,
      entryPrice,
      entryTime: candles[i].time,
      targetPrice: direction === "LONG"
        ? entryPrice * (1 + config.targetPct / 100)
        : entryPrice * (1 - config.targetPct / 100),
      stopPrice: direction === "LONG"
        ? entryPrice * (1 - config.stopPct / 100)
        : entryPrice * (1 + config.stopPct / 100),
    };

    const result = simulateTrade(candles, signal, config);
    trades.push(result);
    lastTradeEndIdx = result.exitIndex + 1; // Don't enter again until this trade closes
  }

  // Compute stats
  const wins = trades.filter((t) => t.outcome === "WIN").length;
  const losses = trades.filter((t) => t.outcome === "LOSS").length;
  const timeouts = trades.filter((t) => t.outcome === "TIMEOUT").length;
  const winRate = trades.length > 0 ? (wins / trades.length) * 100 : 0;

  const avgWinPct = wins > 0
    ? trades.filter((t) => t.outcome === "WIN").reduce((s, t) => s + t.leveragedPnlPct, 0) / wins
    : 0;
  const avgLossPct = losses > 0
    ? trades.filter((t) => t.outcome === "LOSS").reduce((s, t) => s + Math.abs(t.leveragedPnlPct), 0) / losses
    : 0;

  const totalWinPnl = trades.filter((t) => t.outcome === "WIN").reduce((s, t) => s + t.leveragedPnlPct, 0);
  const totalLossPnl = trades.filter((t) => t.outcome === "LOSS").reduce((s, t) => s + Math.abs(t.leveragedPnlPct), 0);
  const profitFactor = totalLossPnl > 0 ? totalWinPnl / totalLossPnl : totalWinPnl > 0 ? Infinity : 0;

  const avgHoldBars = trades.length > 0
    ? trades.reduce((s, t) => s + t.holdBars, 0) / trades.length
    : 0;

  // Score breakdown
  const scoreBreakdown: Record<number, { total: number; wins: number; winRate: number }> = {};
  for (let s = 1; s <= 5; s++) {
    const filtered = trades.filter((t) => t.signal.score === s);
    const w = filtered.filter((t) => t.outcome === "WIN").length;
    scoreBreakdown[s] = {
      total: filtered.length,
      wins: w,
      winRate: filtered.length > 0 ? (w / filtered.length) * 100 : 0,
    };
  }

  // Per-condition win rates
  const condKeys: (keyof EntryConditions)[] = [
    "stochExtreme", "rsiExtreme", "divergence", "bollingerTouch", "macdCross",
  ];
  const conditionWinRates: Record<keyof EntryConditions, { total: number; wins: number; winRate: number }> = {} as any;
  for (const key of condKeys) {
    const filtered = trades.filter((t) => t.signal.conditions[key]);
    const w = filtered.filter((t) => t.outcome === "WIN").length;
    conditionWinRates[key] = {
      total: filtered.length,
      wins: w,
      winRate: filtered.length > 0 ? (w / filtered.length) * 100 : 0,
    };
  }

  // Best combo
  const comboMap = new Map<string, { total: number; wins: number }>();
  for (const trade of trades) {
    const comboKey = condKeys.filter((k) => trade.signal.conditions[k]).sort().join("+");
    const existing = comboMap.get(comboKey) || { total: 0, wins: 0 };
    existing.total++;
    if (trade.outcome === "WIN") existing.wins++;
    comboMap.set(comboKey, existing);
  }

  let bestCombo = "";
  let bestComboWinRate = 0;
  comboMap.forEach((v, k) => {
    if (v.total >= 3) { // Need at least 3 trades to be meaningful
      const wr = (v.wins / v.total) * 100;
      if (wr > bestComboWinRate) {
        bestCombo = k;
        bestComboWinRate = wr;
      }
    }
  });

  return {
    timeframe: timeframeLabel,
    totalSignals: trades.length,
    trades,
    wins, losses, timeouts,
    winRate,
    avgWinPct, avgLossPct,
    profitFactor,
    avgHoldBars,
    scoreBreakdown,
    conditionWinRates,
    bestCombo,
    bestComboWinRate,
    config,
    candlesAnalyzed: candles.length,
  };
}

// ====== AUTO-OPTIMIZER ======
// Tries different threshold combinations and finds the best one

/**
 * One entry in the optimizer's "top N" list — a rule combo that passed the
 * quality filter, along with its FULL backtest result so the UI can show
 * everything (score breakdown, condition breakdown, individual trades) for
 * that specific combo without having to re-run the backtest.
 */
export interface TopConfigResult {
  /** Rank 1..N by composite score */
  rank: number;
  /** The rule combo that produced this result */
  config: BacktestConfig;
  /** Short human-readable label */
  label: string;
  /** Composite score: winRate * min(PF,10) * log(trades+1) */
  compositeScore: number;
  /** Full backtest result — every trade, every stat */
  result: BacktestResult;
}

export interface OptimizationResult {
  bestConfig: BacktestConfig;
  bestWinRate: number;
  bestProfitFactor: number;
  bestTrades: number;
  /** Top N configs that passed the quality filter, ranked by composite score.
   *  Each has full BacktestResult so UI can drill into every combo. */
  topConfigs: TopConfigResult[];
  /** Legacy lightweight trial list (kept for backward compat) */
  allTrials: {
    config: BacktestConfig;
    winRate: number;
    profitFactor: number;
    trades: number;
    label: string;
  }[];
  /** How many combos passed the WR/trades filter (before trimming to top N) */
  totalQualified: number;
  /** Threshold that was used */
  minWinRateUsed: number;
  recommendation: string;
}

/**
 * User-editable grid search bounds. Multiplied with rule-shape presets to form
 * the full combo set the optimizer scans. Persisted to AsyncStorage so the
 * user's tuning sticks across sessions.
 */
export interface OptimizeGridConfig {
  /** Minimum total conditions that must fire for a signal */
  minScores: number[];
  /** StochRSI oversold thresholds (overbought = 100 - this) */
  stochOSLevels: number[];
  /** RSI oversold thresholds (overbought = 100 - this) */
  rsiOSLevels: number[];
  /** Take-profit % (raw price move). Multiply by leverage to get PnL%. */
  targetPcts: number[];
  /** Stop-loss % (raw price move). Multiply by leverage to get PnL%. */
  stopPcts: number[];
  /** Reject combos where targetPct/stopPct is below this. Default 1.5 */
  minRR: number;
  /** Don't keep a combo unless it had at least this many trades */
  minTrades: number;
  /** Quality filter — only top configs that hit at least this WR (%) are
   *  kept in the topConfigs list. */
  minWinRate: number;
  /** How many top configs to surface in UI */
  topN: number;
}

export const DEFAULT_GRID_CONFIG: OptimizeGridConfig = {
  minScores: [2, 3],
  stochOSLevels: [5, 10],
  rsiOSLevels: [25, 30],
  targetPcts: [1.5, 2, 2.5, 3],
  stopPcts: [0.5, 1, 1.5],
  minRR: 1.5,
  minTrades: 5,
  // Lowered from 55% to 45% — crypto rules with high R:R can be profitable
  // at WR 40-50% (PF > 1 matters more than WR alone). User can raise it back
  // in the GridEditor if they want stricter WR-based filtering.
  minWinRate: 45,
  topN: 10,
};

export interface OptimizeProgressInfo {
  /** 0..1 progress through the grid */
  pct: number;
  /** "146/288 combo" */
  label: string;
  /** Rule currently being tested */
  currentConfig: BacktestConfig;
  /** Best trial so far (or null before any valid trial) */
  bestSoFar: { config: BacktestConfig; winRate: number; profitFactor: number; trades: number } | null;
  /** Total combos in the grid */
  totalCombos: number;
  /** Grid bounds being searched — useful for the UI to render "đang quét" */
  gridBounds: {
    stochLevels: number[];
    rsiLevels: number[];
    minScores: number[];
    targetPcts: number[];
    stopPcts: number[];
  };
}

export interface OptimizeCallbacks {
  /** Return true to abort the optimization. Checked between trials. */
  isCancelled?: () => boolean;
  /** Called with detailed progress after each (yielded) trial. */
  onProgress?: (info: OptimizeProgressInfo) => void;
  /** User-editable grid search bounds + quality filters. Falls back to
   *  DEFAULT_GRID_CONFIG when omitted. */
  gridConfig?: Partial<OptimizeGridConfig>;
}

/**
 * Run optimizer: try different threshold combos on historical data
 * and return the best-performing configuration.
 *
 * Async so it can yield to the UI between trials on mobile, and so the
 * caller can cancel mid-run (via callbacks.isCancelled).
 */
export async function optimizeRules(
  candles: Candle[],
  baseConfig: BacktestConfig = DEFAULT_BACKTEST_CONFIG,
  callbacks: OptimizeCallbacks = {}
): Promise<OptimizationResult> {
  const trials: OptimizationResult["allTrials"] = [];
  // Keep the full BacktestResult for every trial that passes the quality
  // filter so we can later surface "top N" with all their stats & trades.
  const qualifiedResults: { config: BacktestConfig; result: BacktestResult; compositeScore: number; label: string }[] = [];

  // Merge user grid config with defaults
  const gc: OptimizeGridConfig = {
    ...DEFAULT_GRID_CONFIG,
    ...(callbacks.gridConfig || {}),
  };
  const minWinRate = gc.minWinRate;
  const minTrades = gc.minTrades;
  const topN = gc.topN;

  // Label for requiredConditions — used in the trial label so UI can show
  // which rule-shape each combo is.
  const ruleShapeLabel = (req: (keyof EntryConditions)[]): string => {
    if (req.length === 0) return "Any";
    const short: Record<keyof EntryConditions, string> = {
      stochExtreme: "Stoch",
      rsiExtreme: "RSI",
      divergence: "Div",
      bollingerTouch: "BB",
      macdCross: "MACD",
    };
    return req.map((k) => short[k]).join("+");
  };

  // Parameter grid to search — now driven by user-editable gridConfig
  const stochLevels = gc.stochOSLevels;
  const rsiLevels = gc.rsiOSLevels;
  const minScores = gc.minScores;
  const targetPcts = gc.targetPcts;
  const stopPcts = gc.stopPcts;
  const minRR = gc.minRR;

  // Rule-shape presets — this is the big change that makes the optimizer
  // actually GENERATE different strategies (not just different thresholds).
  const shapes = RULE_SHAPE_PRESETS;

  // Precompute total valid combos for progress tracking
  const allCombos: {
    stochOS: number; rsiOS: number; minScore: number; targetPct: number; stopPct: number;
    requiredConditions: (keyof EntryConditions)[]; shapeLabel: string;
  }[] = [];
  for (const shape of shapes) {
    for (const stochOS of stochLevels) {
      for (const rsiOS of rsiLevels) {
        for (const minScore of minScores) {
          // If a shape already requires N conditions, don't ALSO require
          // minScore > N+1 (would over-constrain and produce 0 signals).
          if (minScore > shape.required.length + 2) continue;
          // For pure "Any" shape, skip minScore=2 to avoid noise
          if (shape.required.length === 0 && minScore < 2) continue;
          for (const targetPct of targetPcts) {
            for (const stopPct of stopPcts) {
              if (targetPct / stopPct < minRR) continue;
              allCombos.push({
                stochOS, rsiOS, minScore, targetPct, stopPct,
                requiredConditions: shape.required,
                shapeLabel: shape.label,
              });
            }
          }
        }
      }
    }
  }

  const gridBounds = { stochLevels, rsiLevels, minScores, targetPcts, stopPcts };
  let bestSoFar: OptimizeProgressInfo["bestSoFar"] = null;
  const compositeScore = (wr: number, pf: number, t: number) =>
    wr * Math.min(pf, 10) * Math.log(t + 1);

  const yieldEvery = 4; // yield to UI every N trials
  for (let idx = 0; idx < allCombos.length; idx++) {
    if (callbacks.isCancelled?.()) {
      // Bail out — return whatever trials we have so far
      break;
    }

    const { stochOS, rsiOS, minScore, targetPct, stopPct, requiredConditions, shapeLabel } = allCombos[idx];
    const testConfig: BacktestConfig = {
      ...baseConfig,
      stochOSLevel: stochOS,
      stochOBLevel: 100 - stochOS,
      rsiOSLevel: rsiOS,
      rsiOBLevel: 100 - rsiOS,
      minScore,
      targetPct,
      stopPct,
      requiredConditions,
    };

    const result = runBacktest(candles, "opt", testConfig);
    const shapeTag = ruleShapeLabel(requiredConditions);
    const label = `[${shapeTag}] Stoch${stochOS} RSI${rsiOS} S${minScore} TP${targetPct}% SL${stopPct}%${shapeLabel !== "Bất kỳ" ? ` (${shapeLabel})` : ""}`;

    if (result.totalSignals >= minTrades) {
      trials.push({
        config: testConfig,
        winRate: result.winRate,
        profitFactor: result.profitFactor,
        trades: result.totalSignals,
        label,
      });

      // Only keep the FULL result if this combo's WR passes the quality bar.
      // This keeps memory bounded — we discard losing combos entirely.
      if (result.winRate >= minWinRate) {
        qualifiedResults.push({
          config: testConfig,
          result,
          compositeScore: compositeScore(result.winRate, result.profitFactor, result.totalSignals),
          label,
        });
      }

      // Track best running trial so UI can show "best so far"
      const scoreNew = compositeScore(result.winRate, result.profitFactor, result.totalSignals);
      const scoreBest = bestSoFar
        ? compositeScore(bestSoFar.winRate, bestSoFar.profitFactor, bestSoFar.trades)
        : -1;
      if (scoreNew > scoreBest) {
        bestSoFar = {
          config: testConfig,
          winRate: result.winRate,
          profitFactor: result.profitFactor,
          trades: result.totalSignals,
        };
      }
    }

    if (idx % yieldEvery === 0 || idx === allCombos.length - 1) {
      callbacks.onProgress?.({
        pct: (idx + 1) / allCombos.length,
        label: `${idx + 1}/${allCombos.length} combo`,
        currentConfig: testConfig,
        bestSoFar,
        totalCombos: allCombos.length,
        gridBounds,
      });
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  }

  // Sort by composite score: winRate * profitFactor * log(trades)
  // This balances accuracy with statistical significance
  trials.sort((a, b) => {
    const scoreA = a.winRate * Math.min(a.profitFactor, 10) * Math.log(a.trades + 1);
    const scoreB = b.winRate * Math.min(b.profitFactor, 10) * Math.log(b.trades + 1);
    return scoreB - scoreA;
  });

  // Build the "top N" list. If nothing passed the minWinRate filter, fall back
  // to showing the best combos we ran regardless of threshold so the user
  // still sees *something* actionable.
  qualifiedResults.sort((a, b) => b.compositeScore - a.compositeScore);
  let topConfigs: TopConfigResult[] = qualifiedResults.slice(0, topN).map((t, i) => ({
    rank: i + 1,
    config: t.config,
    label: t.label,
    compositeScore: t.compositeScore,
    result: t.result,
  }));

  // Fallback: if no combo hit minWinRate, synthesize top-N from the trial
  // list by re-running backtest for them (so we still get full result data).
  if (topConfigs.length === 0 && trials.length > 0) {
    const fallback = trials.slice(0, Math.min(topN, trials.length));
    topConfigs = fallback.map((t, i) => {
      const result = runBacktest(candles, "opt", t.config);
      return {
        rank: i + 1,
        config: t.config,
        label: t.label,
        compositeScore: compositeScore(t.winRate, t.profitFactor, t.trades),
        result,
      };
    });
  }

  const best = trials[0];
  const recommendation = best
    ? [
        `StochRSI < ${best.config.stochOSLevel} / > ${best.config.stochOBLevel}`,
        `RSI < ${best.config.rsiOSLevel} / > ${best.config.rsiOBLevel}`,
        `Min ${best.config.minScore} điều kiện`,
        `TP: ${best.config.targetPct}% / SL: ${best.config.stopPct}%`,
        `Win Rate: ${best.winRate.toFixed(1)}% trên ${best.trades} lệnh`,
        `Profit Factor: ${best.profitFactor.toFixed(2)}`,
      ].join("\n")
    : "Không đủ dữ liệu để tối ưu";

  return {
    bestConfig: best?.config || baseConfig,
    bestWinRate: best?.winRate || 0,
    bestProfitFactor: best?.profitFactor || 0,
    bestTrades: best?.trades || 0,
    topConfigs,
    allTrials: trials.slice(0, 20), // Top 20
    totalQualified: qualifiedResults.length,
    minWinRateUsed: minWinRate,
    recommendation,
  };
}

// ====== GENETIC ALGORITHM ======
// Evolves rules over generations using weighted scoring.

export interface EvolveProgressInfo {
  generation: number;
  totalGenerations: number;
  pct: number;
  bestSoFar: { config: BacktestConfig; winRate: number; profitFactor: number; trades: number; fitness: number } | null;
  population: number; // how many in current pop
  evaluated: number;  // total evals so far
}

export interface EvolveCallbacks {
  isCancelled?: () => boolean;
  onProgress?: (info: EvolveProgressInfo) => void;
  /** Population size per generation. Default 50 */
  populationSize?: number;
  /** How many generations to run. Default 30 */
  generations?: number;
  /** Top N to keep with full backtest results. Default 10 */
  topN?: number;
  /** Quality filter for topConfigs */
  minWinRate?: number;
  minTrades?: number;
}

const COND_KEYS: (keyof EntryConditions)[] = [
  "stochExtreme", "rsiExtreme", "divergence", "bollingerTouch", "macdCross",
];

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function randChoice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
function randFloat(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

/**
 * Generate TP/SL pair that satisfies REALISTIC trading constraints:
 *   - SL ≤ 80% PnL (= 80/leverage raw price): below liquidation, leaves room
 *   - SL ≥ 30% PnL (= 30/leverage raw price): not noise-exploit territory
 *   - TP ≥ minRR × SL: realistic risk-reward
 *   - TP ≤ 500% PnL: no fantasy moonshots
 *
 * IMPORTANT: targetPct/stopPct are stored as RAW PRICE PERCENT (e.g. 1.5 = 1.5% price move).
 *   PnL% = rawPct × leverage. So with leverage=100:
 *     - 30% PnL = 0.3% raw  → stopPct = 0.3
 *     - 80% PnL = 0.8% raw  → stopPct = 0.8
 *     - 200% PnL = 2.0% raw → targetPct = 2.0
 */
function genTPSL(leverage: number, minRR: number): { targetPct: number; stopPct: number } {
  // Raw price bounds (in PERCENT, not fraction):
  // 30% PnL ÷ leverage = min raw stop. With lev=100: 30/100 = 0.3
  const minStopRaw = Math.max(0.3, 30 / leverage);
  // 80% PnL ÷ leverage = max raw stop (leave 20% margin before liquidation).
  // With lev=100: 80/100 = 0.8. With lev=10: 80/10 = 8 — but cap at 3% so SL hits in reasonable time.
  const maxStopRaw = Math.min(3, 80 / leverage);

  const stopPct = randFloat(minStopRaw, maxStopRaw);
  const minTP = stopPct * minRR;
  const maxTP = Math.min(5, stopPct * 5); // TP can be up to 5× SL
  const targetPct = randFloat(minTP, Math.max(minTP + 0.1, maxTP));
  return {
    targetPct: Math.round(targetPct * 100) / 100,
    stopPct: Math.round(stopPct * 100) / 100,
  };
}

/** Generate a random rule for the initial population. baseConfig.forceSide
 *  is preserved across mutation/crossover so LONG-only stays LONG-only. */
function randomRule(baseConfig: BacktestConfig, minRR: number = 1.5): BacktestConfig {
  // Random weights 0-3 for each condition. At least one must be > 0.
  const weights: BacktestConfig["weights"] = {};
  let totalW = 0;
  for (const k of COND_KEYS) {
    const w = randInt(0, 3);
    weights[k] = w;
    totalW += w;
  }
  // If all zero, force one random one to 2
  if (totalW === 0) {
    const k = randChoice(COND_KEYS);
    weights[k] = 2;
    totalW = 2;
  }
  // minWeightedScore between 1 and totalW (inclusive). Pick a reasonable threshold.
  const minWeightedScore = randInt(Math.max(1, Math.floor(totalW * 0.3)), Math.max(2, Math.floor(totalW * 0.7)));

  const stochOS = randChoice([3, 5, 8, 10, 15, 20]);
  const rsiOS = randChoice([15, 20, 25, 30, 35]);
  const { targetPct, stopPct } = genTPSL(baseConfig.leverage || 100, minRR);

  return {
    ...baseConfig,
    weights,
    minWeightedScore,
    minScore: 1, // weighted scoring overrides this anyway
    stochOSLevel: stochOS,
    stochOBLevel: 100 - stochOS,
    rsiOSLevel: rsiOS,
    rsiOBLevel: 100 - rsiOS,
    targetPct,
    stopPct,
    requiredConditions: [], // GA learns shape via weights, not hard requires
    forceSide: baseConfig.forceSide, // preserve LONG-only / SHORT-only constraint
  };
}

/** Crossover two parents → child (uniform crossover) */
function crossover(parentA: BacktestConfig, parentB: BacktestConfig, minRR: number = 1.5): BacktestConfig {
  const pickFrom = (a: any, b: any) => Math.random() < 0.5 ? a : b;
  const childWeights: BacktestConfig["weights"] = {};
  for (const k of COND_KEYS) {
    childWeights[k] = pickFrom(parentA.weights?.[k] ?? 0, parentB.weights?.[k] ?? 0);
  }
  let targetPct = pickFrom(parentA.targetPct, parentB.targetPct);
  let stopPct = pickFrom(parentA.stopPct, parentB.stopPct);
  // Enforce realistic SL/TP bounds + R:R minimum
  const lev = (parentA.leverage || parentB.leverage || 100);
  const minStopRaw = Math.max(0.3, 30 / lev);
  const maxStopRaw = Math.min(3, 80 / lev);
  if (stopPct < minStopRaw) stopPct = minStopRaw;
  if (stopPct > maxStopRaw) stopPct = maxStopRaw;
  if (targetPct / stopPct < minRR) targetPct = stopPct * minRR;
  if (targetPct > 5) targetPct = 5;
  return {
    ...parentA, // base shape
    weights: childWeights,
    minWeightedScore: pickFrom(parentA.minWeightedScore, parentB.minWeightedScore),
    stochOSLevel: pickFrom(parentA.stochOSLevel, parentB.stochOSLevel),
    stochOBLevel: 100 - pickFrom(parentA.stochOSLevel, parentB.stochOSLevel),
    rsiOSLevel: pickFrom(parentA.rsiOSLevel, parentB.rsiOSLevel),
    rsiOBLevel: 100 - pickFrom(parentA.rsiOSLevel, parentB.rsiOSLevel),
    targetPct: Math.round(targetPct * 100) / 100,
    stopPct: Math.round(stopPct * 100) / 100,
  };
}

/** Mutate a rule — randomly tweak parameters with given probability */
function mutate(rule: BacktestConfig, rate: number = 0.2, minRR: number = 1.5): BacktestConfig {
  const r = { ...rule, weights: { ...rule.weights } as BacktestConfig["weights"] };
  // Mutate weights
  for (const k of COND_KEYS) {
    if (Math.random() < rate) {
      const cur = r.weights![k] ?? 0;
      // Drift by ±1, clamp 0-3
      const next = Math.max(0, Math.min(3, cur + randChoice([-1, 1])));
      r.weights![k] = next;
    }
  }
  // Recompute minWeightedScore valid range
  const totalW = COND_KEYS.reduce((s, k) => s + (r.weights![k] ?? 0), 0);
  if (totalW === 0) {
    r.weights![randChoice(COND_KEYS)] = 2;
  }
  if (Math.random() < rate) {
    r.minWeightedScore = Math.max(1, Math.min(totalW || 1, (r.minWeightedScore ?? 2) + randChoice([-1, 1])));
  }
  // Mutate thresholds
  if (Math.random() < rate) {
    r.stochOSLevel = Math.max(2, Math.min(40, r.stochOSLevel + randChoice([-2, -1, 1, 2])));
    r.stochOBLevel = 100 - r.stochOSLevel;
  }
  if (Math.random() < rate) {
    r.rsiOSLevel = Math.max(10, Math.min(45, r.rsiOSLevel + randChoice([-3, -2, 2, 3])));
    r.rsiOBLevel = 100 - r.rsiOSLevel;
  }
  // Mutate TP/SL — but RE-VALIDATE to maintain R:R ≥ minRR and realistic SL bounds.
  const lev = r.leverage || 100;
  const minStopRaw = Math.max(0.3, 30 / lev); // ≥ 30% PnL — không exploit noise
  const maxStopRaw = Math.min(3, 80 / lev);   // ≤ 80% PnL — chừa margin trước liquidation
  if (Math.random() < rate) {
    r.targetPct = Math.max(0.3, Math.min(5, r.targetPct + randFloat(-0.3, 0.3)));
  }
  if (Math.random() < rate) {
    r.stopPct = Math.max(minStopRaw, Math.min(maxStopRaw, r.stopPct + randFloat(-0.2, 0.2)));
  }
  // Final clamp: enforce both bounds
  if (r.stopPct < minStopRaw) r.stopPct = minStopRaw;
  if (r.stopPct > maxStopRaw) r.stopPct = maxStopRaw;
  if (r.targetPct / r.stopPct < minRR) {
    r.targetPct = r.stopPct * minRR;
  }
  if (r.targetPct > 5) r.targetPct = 5;
  r.targetPct = Math.round(r.targetPct * 100) / 100;
  r.stopPct = Math.round(r.stopPct * 100) / 100;
  return r;
}

/** Tournament selection — pick best of `size` random individuals */
function tournament(pop: { config: BacktestConfig; fitness: number }[], size: number = 3): BacktestConfig {
  let best = pop[Math.floor(Math.random() * pop.length)];
  for (let i = 1; i < size; i++) {
    const candidate = pop[Math.floor(Math.random() * pop.length)];
    if (candidate.fitness > best.fitness) best = candidate;
  }
  return best.config;
}

/**
 * Evolve trading rules via genetic algorithm. Returns OptimizationResult so
 * UI can reuse the same display path as optimizeRules.
 */
export async function evolveRules(
  candles: Candle[],
  baseConfig: BacktestConfig = DEFAULT_BACKTEST_CONFIG,
  callbacks: EvolveCallbacks = {}
): Promise<OptimizationResult> {
  const popSize = callbacks.populationSize ?? 50;
  const generations = callbacks.generations ?? 30;
  const topN = callbacks.topN ?? 10;
  const minWinRate = callbacks.minWinRate ?? 55;
  const minTrades = callbacks.minTrades ?? 5;
  const minRR = 1.5; // enforce realistic risk-reward in GA
  const eliteSize = Math.max(2, Math.floor(popSize * 0.2));

  /**
   * Composite fitness with HARD penalty for unprofitable rules:
   *   - PF < 1   → fitness = 0  (rule loses money overall, ignore even if WR high)
   *   - else     → WR × min(PF, 10) × log(trades+1)
   * This kills the "WR 71% but PF 0.4" trap where you win often but lose more.
   */
  const fitness = (wr: number, pf: number, t: number) => {
    if (pf < 1) return 0;
    return wr * Math.min(pf, 10) * Math.log(t + 1);
  };

  // Initialize population with random rules
  let population: { config: BacktestConfig; fitness: number; result?: BacktestResult }[] =
    Array.from({ length: popSize }, () => ({
      config: randomRule(baseConfig, minRR),
      fitness: 0,
    }));

  let bestSoFar: EvolveProgressInfo["bestSoFar"] = null;
  let totalEvaluated = 0;
  // Cache results across generations: serialize config to key so identical
  // crossover children don't re-run the backtest.
  const evalCache = new Map<string, { fitness: number; wr: number; pf: number; trades: number; result: BacktestResult }>();

  const cacheKey = (c: BacktestConfig): string =>
    `${JSON.stringify(c.weights)}|${c.minWeightedScore}|${c.stochOSLevel}|${c.rsiOSLevel}|${c.targetPct}|${c.stopPct}`;

  for (let gen = 0; gen < generations; gen++) {
    if (callbacks.isCancelled?.()) break;

    // Evaluate every individual
    for (let i = 0; i < population.length; i++) {
      if (callbacks.isCancelled?.()) break;
      const ind = population[i];
      const key = cacheKey(ind.config);
      const cached = evalCache.get(key);
      if (cached) {
        ind.fitness = cached.fitness;
        ind.result = cached.result;
        continue;
      }
      const result = runBacktest(candles, "ga", ind.config);
      const fit = result.totalSignals >= minTrades
        ? fitness(result.winRate, result.profitFactor, result.totalSignals)
        : 0;
      ind.fitness = fit;
      ind.result = result;
      evalCache.set(key, {
        fitness: fit,
        wr: result.winRate,
        pf: result.profitFactor,
        trades: result.totalSignals,
        result,
      });
      totalEvaluated++;

      // Yield to UI every 5 evals
      if (totalEvaluated % 5 === 0) {
        await new Promise<void>((r) => setTimeout(r, 0));
      }
    }

    // Sort by fitness desc
    population.sort((a, b) => b.fitness - a.fitness);

    // Track best
    const top = population[0];
    if (top.result && top.result.totalSignals >= minTrades) {
      const tFitness = fitness(top.result.winRate, top.result.profitFactor, top.result.totalSignals);
      if (!bestSoFar || tFitness > bestSoFar.fitness) {
        bestSoFar = {
          config: top.config,
          winRate: top.result.winRate,
          profitFactor: top.result.profitFactor,
          trades: top.result.totalSignals,
          fitness: tFitness,
        };
      }
    }

    callbacks.onProgress?.({
      generation: gen + 1,
      totalGenerations: generations,
      pct: (gen + 1) / generations,
      bestSoFar,
      population: population.length,
      evaluated: totalEvaluated,
    });

    if (gen === generations - 1) break;

    // Build next generation: keep elite, fill rest with crossover + mutation,
    // sprinkle some fresh randoms to avoid local optima.
    const next: typeof population = [];
    // Elite (no change)
    for (let i = 0; i < eliteSize; i++) next.push({ ...population[i] });
    // Mutated elite
    for (let i = 0; i < Math.floor(popSize * 0.2); i++) {
      next.push({ config: mutate(population[i % eliteSize].config, 0.3, minRR), fitness: 0 });
    }
    // Crossover children from tournament selection
    while (next.length < popSize - 5) {
      const a = tournament(population, 3);
      const b = tournament(population, 3);
      let child = crossover(a, b, minRR);
      if (Math.random() < 0.4) child = mutate(child, 0.15, minRR);
      next.push({ config: child, fitness: 0 });
    }
    // Fresh random blood (5)
    while (next.length < popSize) {
      next.push({ config: randomRule(baseConfig, minRR), fitness: 0 });
    }
    population = next;
  }

  // Build final OptimizationResult from cache
  const allEvaluated = Array.from(evalCache.entries()).map(([_, v]) => v);

  // Two-tier dedup:
  // 1. Stats-similarity: same WR (±2%), same trades (±2), same PF (±0.3)
  //    → these rules trade THE SAME WAY, doesn't matter what config differs
  // 2. Config-similarity: TP/SL within 0.3, weights within 1, thresholds within 5
  const isStatsDuplicate = (
    a: { wr: number; trades: number; pf: number },
    b: { wr: number; trades: number; pf: number },
  ): boolean => {
    if (Math.abs(a.wr - b.wr) > 2) return false;
    if (Math.abs(a.trades - b.trades) > 2) return false;
    const pfA = a.pf === Infinity ? 100 : a.pf;
    const pfB = b.pf === Infinity ? 100 : b.pf;
    if (Math.abs(pfA - pfB) > 0.3) return false;
    return true;
  };

  const isConfigSimilar = (a: BacktestConfig, b: BacktestConfig): boolean => {
    if (Math.abs((a.targetPct || 0) - (b.targetPct || 0)) > 0.3) return false;
    if (Math.abs((a.stopPct || 0) - (b.stopPct || 0)) > 0.3) return false;
    if (Math.abs((a.stochOSLevel || 0) - (b.stochOSLevel || 0)) > 5) return false;
    if (Math.abs((a.rsiOSLevel || 0) - (b.rsiOSLevel || 0)) > 8) return false;
    for (const k of COND_KEYS) {
      if (Math.abs((a.weights?.[k] ?? 0) - (b.weights?.[k] ?? 0)) > 1) return false;
    }
    return true;
  };

  // Pick diverse top: skip if either stats-duplicate OR config-similar to anything already picked
  const pickDiverse = (sorted: typeof allEvaluated, n: number) => {
    const picked: typeof allEvaluated = [];
    for (const e of sorted) {
      const isDup = picked.some((p) =>
        isStatsDuplicate(p, e) || isConfigSimilar(p.result.config, e.result.config)
      );
      if (isDup) continue;
      picked.push(e);
      if (picked.length >= n) break;
    }
    return picked;
  };

  // Filter qualifiers (PF must be > 1 AND meet WR/trades)
  const qualified = allEvaluated
    .filter((e) => e.pf >= 1 && e.wr >= minWinRate && e.trades >= minTrades)
    .sort((a, b) => b.fitness - a.fitness);

  let topConfigs: TopConfigResult[] = pickDiverse(qualified, topN).map((e, i) => ({
    rank: i + 1,
    config: e.result.config,
    label: `[GA] WR${e.wr.toFixed(0)}% PF${e.pf.toFixed(1)} ${e.trades}L`,
    compositeScore: e.fitness,
    result: e.result,
  }));

  // Fallback if no qualified configs (relax WR but keep PF > 1)
  if (topConfigs.length === 0 && allEvaluated.length > 0) {
    const fallback = allEvaluated
      .filter((e) => e.pf >= 1 && e.trades >= minTrades)
      .sort((a, b) => b.fitness - a.fitness);
    topConfigs = pickDiverse(fallback, topN).map((e, i) => ({
      rank: i + 1,
      config: e.result.config,
      label: `[GA] WR${e.wr.toFixed(0)}% PF${e.pf.toFixed(1)} ${e.trades}L`,
      compositeScore: e.fitness,
      result: e.result,
    }));
  }

  const best = topConfigs[0];
  const recommendation = best
    ? `🧬 GA tìm được sau ${generations} thế hệ:\n` +
      `Win Rate: ${best.result.winRate.toFixed(1)}% trên ${best.result.totalSignals} lệnh\n` +
      `Profit Factor: ${best.result.profitFactor.toFixed(2)}\n` +
      `Trọng số: ${COND_KEYS.map((k) => `${k}=${best.config.weights?.[k] ?? 0}`).join(", ")}`
    : "GA không tìm được rule đạt yêu cầu";

  return {
    bestConfig: best?.config || baseConfig,
    bestWinRate: best?.result.winRate || 0,
    bestProfitFactor: best?.result.profitFactor || 0,
    bestTrades: best?.result.totalSignals || 0,
    topConfigs,
    allTrials: allEvaluated.slice(0, 20).map((e) => ({
      config: e.result.config,
      winRate: e.wr,
      profitFactor: e.pf,
      trades: e.trades,
      label: `GA WR${e.wr.toFixed(0)}%`,
    })),
    totalQualified: qualified.length,
    minWinRateUsed: minWinRate,
    recommendation,
  };
}

/**
 * Check current candle for entry signal (for live use).
 */
export function checkLiveSignal(
  candles: Candle[],
  config: BacktestConfig = DEFAULT_BACKTEST_CONFIG
): EntrySignal | null {
  if (candles.length < MIN_LOOKBACK + 1) return null;

  const idx = candles.length - 1;
  const { conditions, direction } = computeConditions(candles, idx, config);
  if (direction === null) return null;

  if (config.forceSide && direction !== config.forceSide) return null;

  const score = countScore(conditions);
  if (config.weights && config.minWeightedScore !== undefined) {
    const ws = computeWeightedScore(conditions, config.weights);
    if (ws < config.minWeightedScore) return null;
  } else {
    if (score < config.minScore) return null;
  }

  if (config.requiredConditions && config.requiredConditions.length > 0) {
    const missing = config.requiredConditions.some((k) => !conditions[k]);
    if (missing) return null;
  }

  const entryPrice = candles[idx].close;
  return {
    type: direction,
    score,
    conditions,
    candleIndex: idx,
    entryPrice,
    entryTime: candles[idx].time,
    targetPrice: direction === "LONG"
      ? entryPrice * (1 + config.targetPct / 100)
      : entryPrice * (1 - config.targetPct / 100),
    stopPrice: direction === "LONG"
      ? entryPrice * (1 - config.stopPct / 100)
      : entryPrice * (1 + config.stopPct / 100),
  };
}
