import { writeFileSync } from "fs";
import { calcATRPct, calcStochRSISeries } from "../utils/indicators";

type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type Outcome = "WIN" | "LOSS" | "TIMEOUT";
type SlMode = "fixed_1pct" | "atr_1p2" | "support4h_atr_buffer";

type EntrySetup = {
  idx1h: number;
  idx4h: number;
  entryTime: number;
  entryPrice: number;
  support: number;
  resistance: number;
  stochKAtEntry: number;
  atr1h: number;
};

type Trade = {
  mode: SlMode;
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  holdBars: number;
  outcome: Outcome;
  stopPct: number;
  rawPct: number;
  netPct: number;
};

const BINANCE_REST = "https://api.binance.com/api/v3";
const SYMBOL = "BTCUSDT";
const NOW = Date.now();
const START_TIME = NOW - 3 * 365 * 24 * 60 * 60 * 1000;
const LOOKBACK_4H = 20;
const MAX_HOLD_BARS = 8;
const FEE_PCT_PER_SIDE = 0.05;
const RESISTANCE_BUFFER_PCT = 0.25;
const MODES: SlMode[] = ["fixed_1pct", "atr_1p2", "support4h_atr_buffer"];

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

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function deriveStopPct(mode: SlMode, setup: EntrySetup): number {
  if (mode === "fixed_1pct") return 1;
  if (mode === "atr_1p2") return clamp(setup.atr1h * 1.2, 0.5, 2.5);
  const supportDistancePct = ((setup.entryPrice - setup.support) / setup.entryPrice) * 100;
  return clamp(Math.max(supportDistancePct + setup.atr1h * 0.15, setup.atr1h * 1.0), 0.6, 2.8);
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
  };
}

function simulateTrade(
  candles1h: Candle[],
  kSeries: (number | null)[],
  setup: EntrySetup,
  stopPct: number,
  mode: SlMode,
): Trade {
  const stopPrice = setup.entryPrice * (1 - stopPct / 100);
  const resistanceTrigger = setup.resistance * (1 - RESISTANCE_BUFFER_PCT / 100);
  const maxIdx = Math.min(setup.idx1h + MAX_HOLD_BARS, candles1h.length - 1);

  for (let j = setup.idx1h + 1; j <= maxIdx; j++) {
    const future = candles1h[j];
    const futureK = kSeries[j];

    if (future.low <= stopPrice) {
      const rawPct = -stopPct;
      return {
        mode,
        entryTime: setup.entryTime,
        entryPrice: setup.entryPrice,
        exitTime: future.time,
        exitPrice: stopPrice,
        holdBars: j - setup.idx1h,
        outcome: "LOSS",
        stopPct: Number(stopPct.toFixed(3)),
        rawPct,
        netPct: rawPct - FEE_PCT_PER_SIDE * 2,
      };
    }

    const tpByResistance = future.high >= resistanceTrigger;
    const tpByStoch = futureK !== null && futureK > 90 && future.close > setup.entryPrice;
    if (tpByResistance || tpByStoch) {
      const exitPrice = tpByResistance ? Math.min(future.close, resistanceTrigger) : future.close;
      const rawPct = ((exitPrice - setup.entryPrice) / setup.entryPrice) * 100;
      return {
        mode,
        entryTime: setup.entryTime,
        entryPrice: setup.entryPrice,
        exitTime: future.time,
        exitPrice,
        holdBars: j - setup.idx1h,
        outcome: "WIN",
        stopPct: Number(stopPct.toFixed(3)),
        rawPct,
        netPct: rawPct - FEE_PCT_PER_SIDE * 2,
      };
    }
  }

  const exit = candles1h[maxIdx];
  const rawPct = ((exit.close - setup.entryPrice) / setup.entryPrice) * 100;
  return {
    mode,
    entryTime: setup.entryTime,
    entryPrice: setup.entryPrice,
    exitTime: exit.time,
    exitPrice: exit.close,
    holdBars: maxIdx - setup.idx1h,
    outcome: "TIMEOUT",
    stopPct: Number(stopPct.toFixed(3)),
    rawPct,
    netPct: rawPct - FEE_PCT_PER_SIDE * 2,
  };
}

async function main() {
  console.log("Fetching 3-year Binance candles for 1h rule SL comparison...");

  const [candles1h, candles4h] = await Promise.all([
    fetchKlinesSince("1h", START_TIME - 30 * 60 * 60 * 1000),
    fetchKlinesSince("4h", START_TIME - 30 * 4 * 60 * 60 * 1000),
  ]);

  const closes1h = candles1h.map((c) => c.close);
  const { kSeries } = calcStochRSISeries(closes1h);
  const setups: EntrySetup[] = [];

  for (let i = 30; i < candles1h.length - 1; i++) {
    const candle = candles1h[i];
    if (candle.time < START_TIME) continue;

    const idx4h = findLastClosedIndex(candles4h, candle.time);
    const stochK = kSeries[i];
    if (idx4h < LOOKBACK_4H || stochK === null) continue;
    if (stochK >= 95) continue;

    const window4h = candles4h.slice(idx4h - LOOKBACK_4H + 1, idx4h + 1);
    const support = Math.min(...window4h.map((c) => c.low));
    const resistance = Math.max(...window4h.map((c) => c.high));
    const atr1h = calcATRPct(candles1h.slice(Math.max(0, i - 20), i + 1), 14);
    if (atr1h === null) continue;

    const nearSupportPct = ((candle.close - support) / candle.close) * 100;
    const supportNearThreshold = Math.max(0.25, atr1h * 0.35);
    const touchesSupport = candle.low <= support * 1.002;
    const nearSupport = nearSupportPct >= 0 && nearSupportPct <= supportNearThreshold;
    if (!touchesSupport && !nearSupport) continue;
    if (resistance <= candle.close) continue;

    setups.push({
      idx1h: i,
      idx4h,
      entryTime: candle.time,
      entryPrice: candle.close,
      support,
      resistance,
      stochKAtEntry: Number(stochK.toFixed(2)),
      atr1h,
    });
  }

  const byMode: Record<SlMode, Trade[]> = {
    fixed_1pct: [],
    atr_1p2: [],
    support4h_atr_buffer: [],
  };

  for (const mode of MODES) {
    let nextFreeIdx = 0;
    for (const setup of setups) {
      if (setup.idx1h < nextFreeIdx) continue;
      const stopPct = deriveStopPct(mode, setup);
      const trade = simulateTrade(candles1h, kSeries, setup, stopPct, mode);
      byMode[mode].push(trade);
      nextFreeIdx = setup.idx1h + Math.max(1, trade.holdBars);
    }
  }

  const result = {
    ruleId: "gpt-long-1h-stoch-support-4h-sr-sl-compare-3y",
    generatedAt: new Date().toISOString(),
    assumptions: {
      period: "3 years",
      dateRange: {
        from: new Date(START_TIME).toISOString(),
        to: new Date(NOW).toISOString(),
      },
      entry: "1h StochRSI K < 95 and price touches/is near 4h support",
      takeProfit: "near 4h resistance OR 1h StochRSI K > 90",
      modes: {
        fixed_1pct: "SL fixed 1%",
        atr_1p2: "SL = 1.2 * ATR1h",
        support4h_atr_buffer: "SL = max(distance to 4h support + 0.15*ATR1h, 1.0*ATR1h), clamped",
      },
      maxHoldBars1h: MAX_HOLD_BARS,
      feePctPerSide: FEE_PCT_PER_SIDE,
    },
    sample: {
      candles1h: candles1h.length,
      candles4h: candles4h.length,
      candidateSetups: setups.length,
    },
    comparison: {
      fixed_1pct: summarize(byMode.fixed_1pct),
      atr_1p2: summarize(byMode.atr_1p2),
      support4h_atr_buffer: summarize(byMode.support4h_atr_buffer),
    },
    recentTradesByMode: {
      fixed_1pct: byMode.fixed_1pct.slice(-5),
      atr_1p2: byMode.atr_1p2.slice(-5),
      support4h_atr_buffer: byMode.support4h_atr_buffer.slice(-5),
    },
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
