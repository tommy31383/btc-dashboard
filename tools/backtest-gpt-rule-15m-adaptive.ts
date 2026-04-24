import { writeFileSync } from "fs";
import { calcATRPct } from "../utils/indicators";

type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type TrendLabel = "UP" | "DOWN" | "SIDEWAY";
type Outcome = "WIN" | "LOSS" | "TIMEOUT";
type ContextLabel = "DEEP_PULLBACK" | "COMPRESSION_RESUME" | "TREND_RESUME";

type Trade = {
  context: ContextLabel;
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  holdBars: number;
  outcome: Outcome;
  stopPct: number;
  targetPct: number;
  rawPct: number;
  netPct: number;
};

const BINANCE_REST = "https://api.binance.com/api/v3";
const SYMBOL = "BTCUSDT";
const BASE_INTERVAL = "15m";
const INTERVALS = ["15m", "1h", "4h", "8h", "12h"] as const;
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const NOW = Date.now();
const START_TIME = NOW - ONE_YEAR_MS;
const INTERVAL_MS: Record<(typeof INTERVALS)[number], number> = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "8h": 8 * 60 * 60 * 1000,
  "12h": 12 * 60 * 60 * 1000,
};

const ALLOWED_CONTEXTS: ContextLabel[] = ["TREND_RESUME"];

const ASSUMPTIONS = {
  period: "1 year",
  trendMethod: "5-candle percent change",
  trendThresholdPct: 0.6,
  entryTrigger: "15m flips to UP while 8h/12h are UP, 4h is not DOWN, 1h is DOWN/SIDEWAY",
  stopMode: "adaptive structure + ATR",
  targetMode: "adaptive RR by context",
  allowedContexts: ALLOWED_CONTEXTS,
  maxHoldBars15m: 24,
  feePctPerSide: 0.05,
  onePositionAtATime: true,
};

async function fetchKlinesSince(interval: string, startTime: number): Promise<Candle[]> {
  const all: Candle[] = [];
  let cursor = startTime;

  while (true) {
    const params = new URLSearchParams({
      symbol: SYMBOL,
      interval,
      limit: "1000",
      startTime: String(cursor),
    });
    const res = await fetch(`${BINANCE_REST}/klines?${params.toString()}`);
    if (!res.ok) throw new Error(`Fetch ${interval} failed: HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;

    const batch = data.map((k: any[]) => ({
      time: Number(k[0]),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
    })) as Candle[];

    all.push(...batch);
    if (batch.length < 1000) break;
    cursor = batch[batch.length - 1].time + 1;
    await new Promise((r) => setTimeout(r, 120));
  }

  const uniq = new Map<number, Candle>();
  for (const c of all) {
    if (c.time >= startTime) uniq.set(c.time, c);
  }
  return Array.from(uniq.values()).sort((a, b) => a.time - b.time);
}

function findLastClosedIndex(candles: Candle[], time: number): number {
  let lo = 0;
  let hi = candles.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (candles[mid].time <= time) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

function deriveTrend(candles: Candle[], endIdx: number): TrendLabel | null {
  if (endIdx < 5) return null;
  const startClose = candles[endIdx - 5].close;
  const endClose = candles[endIdx].close;
  if (startClose <= 0) return null;
  const pct = ((endClose - startClose) / startClose) * 100;
  if (pct > ASSUMPTIONS.trendThresholdPct) return "UP";
  if (pct < -ASSUMPTIONS.trendThresholdPct) return "DOWN";
  return "SIDEWAY";
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function recentLowPct(candles: Candle[], endIdx: number, lookback: number, entryPrice: number) {
  const start = Math.max(0, endIdx - lookback + 1);
  const low = Math.min(...candles.slice(start, endIdx + 1).map((c) => c.low));
  return ((entryPrice - low) / entryPrice) * 100;
}

function detectContext(trend1h: TrendLabel, atr15m: number): ContextLabel {
  if (trend1h === "DOWN") return "DEEP_PULLBACK";
  if (atr15m < 0.45) return "COMPRESSION_RESUME";
  return "TREND_RESUME";
}

function buildRiskPlan(
  context: ContextLabel,
  candles15m: Candle[],
  candles1h: Candle[],
  idx15m: number,
  idx1h: number,
): { stopPct: number; targetPct: number } | null {
  const entryPrice = candles15m[idx15m].close;
  const atr15m = calcATRPct(candles15m.slice(Math.max(0, idx15m - 20), idx15m + 1), 14);
  if (atr15m === null) return null;

  const structure15m = recentLowPct(candles15m, idx15m, 8, entryPrice);
  const structure1h = recentLowPct(candles1h, idx1h, 3, entryPrice);

  let stopPct: number;
  let rr: number;

  if (context === "DEEP_PULLBACK") {
    stopPct = Math.max(structure1h + 0.12, atr15m * 1.8, 0.9);
    rr = 1.2;
  } else if (context === "COMPRESSION_RESUME") {
    stopPct = Math.max(structure15m + 0.08, atr15m * 1.25, 0.65);
    rr = 1.6;
  } else {
    stopPct = Math.max(Math.max(structure15m, structure1h) + 0.1, atr15m * 1.45, 0.75);
    rr = 1.8;
  }

  stopPct = clamp(stopPct, 0.6, 2.6);
  const targetFloor = context === "DEEP_PULLBACK" ? atr15m * 1.6 : context === "COMPRESSION_RESUME" ? atr15m * 2.0 : atr15m * 2.4;
  const targetPct = clamp(Math.max(stopPct * rr, targetFloor), 0.9, 4.8);

  return {
    stopPct: Number(stopPct.toFixed(3)),
    targetPct: Number(targetPct.toFixed(3)),
  };
}

function simulateTrade(candles: Candle[], entryIdx: number, stopPct: number, targetPct: number, context: ContextLabel): Trade {
  const entryPrice = candles[entryIdx].close;
  const stopPrice = entryPrice * (1 - stopPct / 100);
  const targetPrice = entryPrice * (1 + targetPct / 100);
  const maxIdx = Math.min(entryIdx + ASSUMPTIONS.maxHoldBars15m, candles.length - 1);

  for (let i = entryIdx + 1; i <= maxIdx; i++) {
    const candle = candles[i];
    if (candle.low <= stopPrice) {
      const rawPct = -stopPct;
      return {
        context,
        entryTime: candles[entryIdx].time,
        entryPrice,
        exitTime: candle.time,
        exitPrice: stopPrice,
        holdBars: i - entryIdx,
        outcome: "LOSS",
        stopPct,
        targetPct,
        rawPct,
        netPct: rawPct - ASSUMPTIONS.feePctPerSide * 2,
      };
    }
    if (candle.high >= targetPrice) {
      const rawPct = targetPct;
      return {
        context,
        entryTime: candles[entryIdx].time,
        entryPrice,
        exitTime: candle.time,
        exitPrice: targetPrice,
        holdBars: i - entryIdx,
        outcome: "WIN",
        stopPct,
        targetPct,
        rawPct,
        netPct: rawPct - ASSUMPTIONS.feePctPerSide * 2,
      };
    }
  }

  const exitCandle = candles[maxIdx];
  const rawPct = ((exitCandle.close - entryPrice) / entryPrice) * 100;
  return {
    context,
    entryTime: candles[entryIdx].time,
    entryPrice,
    exitTime: exitCandle.time,
    exitPrice: exitCandle.close,
    holdBars: maxIdx - entryIdx,
    outcome: "TIMEOUT",
    stopPct,
    targetPct,
    rawPct,
    netPct: rawPct - ASSUMPTIONS.feePctPerSide * 2,
  };
}

function summarize(trades: Trade[]) {
  const wins = trades.filter((t) => t.outcome === "WIN").length;
  const losses = trades.filter((t) => t.outcome === "LOSS").length;
  const timeouts = trades.filter((t) => t.outcome === "TIMEOUT").length;
  const winRate = trades.length ? (wins / trades.length) * 100 : 0;
  const netPct = trades.reduce((sum, t) => sum + t.netPct, 0);
  const avgNetPct = trades.length ? netPct / trades.length : 0;
  const avgHoldBars = trades.length ? trades.reduce((sum, t) => sum + t.holdBars, 0) / trades.length : 0;
  const grossWin = trades.filter((t) => t.netPct > 0).reduce((sum, t) => sum + t.netPct, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.netPct < 0).reduce((sum, t) => sum + t.netPct, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : 0;
  const avgStopPct = trades.length ? trades.reduce((sum, t) => sum + t.stopPct, 0) / trades.length : 0;
  const avgTargetPct = trades.length ? trades.reduce((sum, t) => sum + t.targetPct, 0) / trades.length : 0;

  return {
    trades: trades.length,
    wins,
    losses,
    timeouts,
    winRate: Number(winRate.toFixed(2)),
    netPct: Number(netPct.toFixed(2)),
    avgNetPct: Number(avgNetPct.toFixed(3)),
    avgHoldBars: Number(avgHoldBars.toFixed(1)),
    profitFactor: Number(profitFactor.toFixed(2)),
    avgStopPct: Number(avgStopPct.toFixed(3)),
    avgTargetPct: Number(avgTargetPct.toFixed(3)),
  };
}

async function main() {
  console.log("Fetching 1-year Binance candles for GPT LONG PULLBACK 15M V2 adaptive...");

  const datasets = Object.fromEntries(
    await Promise.all(
      INTERVALS.map(async (interval) => [interval, await fetchKlinesSince(interval, START_TIME - INTERVAL_MS[interval] * 12)]),
    ),
  ) as Record<(typeof INTERVALS)[number], Candle[]>;

  const base = datasets["15m"].filter((c) => c.time >= START_TIME);
  const trades: Trade[] = [];
  let i = 6;

  while (i < base.length - 1) {
    const entryTime = base[i].time;
    const idx15 = findLastClosedIndex(datasets["15m"], entryTime);
    const idx1h = findLastClosedIndex(datasets["1h"], entryTime);
    const idx4h = findLastClosedIndex(datasets["4h"], entryTime);
    const idx8h = findLastClosedIndex(datasets["8h"], entryTime);
    const idx12h = findLastClosedIndex(datasets["12h"], entryTime);

    if ([idx15, idx1h, idx4h, idx8h, idx12h].some((idx) => idx < 20)) {
      i++;
      continue;
    }

    const trend15 = deriveTrend(datasets["15m"], idx15);
    const prevTrend15 = deriveTrend(datasets["15m"], idx15 - 1);
    const trend1h = deriveTrend(datasets["1h"], idx1h);
    const trend4h = deriveTrend(datasets["4h"], idx4h);
    const trend8h = deriveTrend(datasets["8h"], idx8h);
    const trend12h = deriveTrend(datasets["12h"], idx12h);
    const atr15m = calcATRPct(datasets["15m"].slice(Math.max(0, idx15 - 20), idx15 + 1), 14);

    const setupOk =
      trend8h === "UP" &&
      trend12h === "UP" &&
      trend4h !== "DOWN" &&
      (trend1h === "DOWN" || trend1h === "SIDEWAY") &&
      trend15 === "UP" &&
      prevTrend15 !== "UP" &&
      atr15m !== null &&
      atr15m >= 0.18;

    if (!setupOk || atr15m === null || trend1h === null) {
      i++;
      continue;
    }

    const context = detectContext(trend1h, atr15m);
    if (!ALLOWED_CONTEXTS.includes(context)) {
      i++;
      continue;
    }

    const riskPlan = buildRiskPlan(context, datasets["15m"], datasets["1h"], idx15, idx1h);
    if (!riskPlan) {
      i++;
      continue;
    }

    const trade = simulateTrade(datasets["15m"], idx15, riskPlan.stopPct, riskPlan.targetPct, context);
    trades.push(trade);
    i += Math.max(1, trade.holdBars);
  }

  const byContext = {
    DEEP_PULLBACK: summarize(trades.filter((t) => t.context === "DEEP_PULLBACK")),
    COMPRESSION_RESUME: summarize(trades.filter((t) => t.context === "COMPRESSION_RESUME")),
    TREND_RESUME: summarize(trades.filter((t) => t.context === "TREND_RESUME")),
  };

  const result = {
    ruleId: "gpt-long-pullback-15m-v2-adaptive-trend-resume-only",
    generatedAt: new Date().toISOString(),
    assumptions: ASSUMPTIONS,
    sample: {
      startTime: new Date(START_TIME).toISOString(),
      endTime: new Date(NOW).toISOString(),
      baseInterval: BASE_INTERVAL,
      candlesFetched: Object.fromEntries(INTERVALS.map((interval) => [interval, datasets[interval].length])),
    },
    summary: summarize(trades),
    byContext,
    recentTrades: trades.slice(-12),
  };

  const outPath = "E:/AI/BTC/btc-dashboard/assets/gpt_rule_backtests.json";
  writeFileSync(outPath, JSON.stringify(result, null, 2));

  console.log(JSON.stringify(result, null, 2));
  console.log(`\nSaved: ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
