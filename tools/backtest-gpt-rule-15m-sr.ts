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

type Trade = {
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  holdBars: number;
  outcome: "WIN" | "LOSS" | "TIMEOUT";
  stopPct: number;
  targetPct: number;
  rawPct: number;
  netPct: number;
};

const BINANCE_REST = "https://api.binance.com/api/v3";
const SYMBOL = "BTCUSDT";
const INTERVAL = "15m";
const NOW = Date.now();
const START_TIME = NOW - 365 * 24 * 60 * 60 * 1000;
const LOOKBACK = 20;
const MAX_HOLD_BARS = 24;
const FEE_PCT_PER_SIDE = 0.05;
const MIN_DIST_PCT = 0.25;
const ATR_BUFFER_MULT = 0.15;

async function fetchKlinesSince(startTime: number): Promise<Candle[]> {
  const all: Candle[] = [];
  let cursor = startTime;

  while (true) {
    const params = new URLSearchParams({
      symbol: SYMBOL,
      interval: INTERVAL,
      limit: "1000",
      startTime: String(cursor),
    });
    const res = await fetch(`${BINANCE_REST}/klines?${params.toString()}`);
    if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status}`);
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

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function buildPlan(candles: Candle[], idx: number) {
  const entryPrice = candles[idx].close;
  const window = candles.slice(idx - LOOKBACK, idx);
  const support = Math.min(...window.map((c) => c.low));
  const resistance = Math.max(...window.map((c) => c.high));
  const atrPct = calcATRPct(candles.slice(Math.max(0, idx - 20), idx + 1), 14);
  if (atrPct === null) return null;

  const stopPct = ((entryPrice - support) / entryPrice) * 100 + atrPct * ATR_BUFFER_MULT;
  const targetPct = ((resistance - entryPrice) / entryPrice) * 100 - atrPct * ATR_BUFFER_MULT;

  if (stopPct <= 0 || targetPct <= 0) return null;
  if (stopPct < MIN_DIST_PCT || targetPct < MIN_DIST_PCT) return null;

  return {
    stopPct: clamp(Number(stopPct.toFixed(3)), MIN_DIST_PCT, 8),
    targetPct: clamp(Number(targetPct.toFixed(3)), MIN_DIST_PCT, 8),
  };
}

function simulateTrade(candles: Candle[], entryIdx: number, stopPct: number, targetPct: number): Trade {
  const entryPrice = candles[entryIdx].close;
  const stopPrice = entryPrice * (1 - stopPct / 100);
  const targetPrice = entryPrice * (1 + targetPct / 100);
  const maxIdx = Math.min(entryIdx + MAX_HOLD_BARS, candles.length - 1);

  for (let i = entryIdx + 1; i <= maxIdx; i++) {
    const candle = candles[i];
    if (candle.low <= stopPrice) {
      const rawPct = -stopPct;
      return {
        entryTime: candles[entryIdx].time,
        entryPrice,
        exitTime: candle.time,
        exitPrice: stopPrice,
        holdBars: i - entryIdx,
        outcome: "LOSS",
        stopPct,
        targetPct,
        rawPct,
        netPct: rawPct - FEE_PCT_PER_SIDE * 2,
      };
    }
    if (candle.high >= targetPrice) {
      const rawPct = targetPct;
      return {
        entryTime: candles[entryIdx].time,
        entryPrice,
        exitTime: candle.time,
        exitPrice: targetPrice,
        holdBars: i - entryIdx,
        outcome: "WIN",
        stopPct,
        targetPct,
        rawPct,
        netPct: rawPct - FEE_PCT_PER_SIDE * 2,
      };
    }
  }

  const exit = candles[maxIdx];
  const rawPct = ((exit.close - entryPrice) / entryPrice) * 100;
  return {
    entryTime: candles[entryIdx].time,
    entryPrice,
    exitTime: exit.time,
    exitPrice: exit.close,
    holdBars: maxIdx - entryIdx,
    outcome: "TIMEOUT",
    stopPct,
    targetPct,
    rawPct,
    netPct: rawPct - FEE_PCT_PER_SIDE * 2,
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
  console.log("Fetching 1-year Binance candles for GPT LONG EVERY CANDLE SR 15M V1...");
  const candles = await fetchKlinesSince(START_TIME - 30 * 15 * 60 * 1000);
  const base = candles.filter((c) => c.time >= START_TIME);
  const trades: Trade[] = [];
  let i = LOOKBACK;

  while (i < base.length - 1) {
    const absoluteIdx = candles.findIndex((c) => c.time === base[i].time);
    if (absoluteIdx < LOOKBACK) {
      i++;
      continue;
    }
    const plan = buildPlan(candles, absoluteIdx);
    if (!plan) {
      i++;
      continue;
    }

    const trade = simulateTrade(candles, absoluteIdx, plan.stopPct, plan.targetPct);
    trades.push(trade);
    i += Math.max(1, trade.holdBars);
  }

  const result = {
    ruleId: "gpt-long-every-candle-sr-15m-v1",
    generatedAt: new Date().toISOString(),
    assumptions: {
      period: "1 year",
      interval: INTERVAL,
      entry: "LONG every new 15m candle",
      supportResistanceLookback: LOOKBACK,
      stopMode: "support - ATR buffer",
      targetMode: "resistance - ATR buffer",
      maxHoldBars: MAX_HOLD_BARS,
      feePctPerSide: FEE_PCT_PER_SIDE,
    },
    sample: {
      startTime: new Date(START_TIME).toISOString(),
      endTime: new Date(NOW).toISOString(),
      candlesFetched: candles.length,
    },
    summary: summarize(trades),
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
