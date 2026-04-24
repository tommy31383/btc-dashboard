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
type ContextLabel = "TREND_RESUME" | "PULLBACK_BUY" | "SQUEEZE";
type Outcome = "WIN" | "LOSS" | "TIMEOUT";

const ALLOWED_CONTEXTS: ContextLabel[] = ["TREND_RESUME", "SQUEEZE"];

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
const INTERVALS = ["15m", "1h"] as const;
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const NOW = Date.now();
const START_TIME = NOW - ONE_YEAR_MS;
const INTERVAL_MS: Record<(typeof INTERVALS)[number], number> = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
};

const ASSUMPTIONS = {
  period: "1 year",
  entry: "LONG every 15m candle only when 1h trend is UP",
  trendMethod: "5-candle percent change",
  trendThresholdPct: 0.6,
  allowedContexts: ALLOWED_CONTEXTS,
  stopMode: "adaptive by context with structure + ATR",
  targetMode: "adaptive RR by context",
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

function detectContext(trend15: TrendLabel, atr15m: number): ContextLabel {
  if (trend15 === "DOWN") return "PULLBACK_BUY";
  if (atr15m < 0.35) return "SQUEEZE";
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

  if (context === "PULLBACK_BUY") {
    stopPct = Math.max(structure15m + 0.08, atr15m * 1.15, 0.45);
    rr = 1.25;
  } else if (context === "SQUEEZE") {
    stopPct = Math.max(structure15m + 0.06, atr15m * 1.35, 0.35);
    rr = 1.4;
  } else {
    stopPct = Math.max(Math.max(structure15m, structure1h) + 0.08, atr15m * 1.45, 0.55);
    rr = 1.7;
  }

  stopPct = clamp(stopPct, 0.35, 2.8);
  const targetPct = clamp(Math.max(stopPct * rr, atr15m * (context === "TREND_RESUME" ? 2.4 : 1.8)), 0.5, 5.5);

  return {
    stopPct: Number(stopPct.toFixed(3)),
    targetPct: Number(targetPct.toFixed(3)),
  };
}

function simulateTrade(
  candles: Candle[],
  entryIdx: number,
  stopPct: number,
  targetPct: number,
  context: ContextLabel,
): Trade {
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

  const exit = candles[maxIdx];
  const rawPct = ((exit.close - entryPrice) / entryPrice) * 100;
  return {
    context,
    entryTime: candles[entryIdx].time,
    entryPrice,
    exitTime: exit.time,
    exitPrice: exit.close,
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
  console.log("Fetching 1-year Binance candles for GPT LONG EVERY CANDLE 1H UP 15M V1...");

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
    if (idx15 < 20 || idx1h < 20) {
      i++;
      continue;
    }

    const trend1h = deriveTrend(datasets["1h"], idx1h);
    const trend15 = deriveTrend(datasets["15m"], idx15);
    const atr15m = calcATRPct(datasets["15m"].slice(Math.max(0, idx15 - 20), idx15 + 1), 14);
    if (trend1h !== "UP" || trend15 === null || atr15m === null) {
      i++;
      continue;
    }

    const context = detectContext(trend15, atr15m);
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

  const result = {
    ruleId: "gpt-long-every-candle-1h-up-15m-v1-filtered",
    generatedAt: new Date().toISOString(),
    assumptions: ASSUMPTIONS,
    sample: {
      startTime: new Date(START_TIME).toISOString(),
      endTime: new Date(NOW).toISOString(),
      baseInterval: BASE_INTERVAL,
      candlesFetched: Object.fromEntries(INTERVALS.map((interval) => [interval, datasets[interval].length])),
    },
    summary: summarize(trades),
    byContext: {
      TREND_RESUME: summarize(trades.filter((t) => t.context === "TREND_RESUME")),
      PULLBACK_BUY: summarize(trades.filter((t) => t.context === "PULLBACK_BUY")),
      SQUEEZE: summarize(trades.filter((t) => t.context === "SQUEEZE")),
    },
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
