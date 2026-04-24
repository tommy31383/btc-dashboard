import { writeFileSync } from "fs";

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

const BINANCE_REST = "https://api.binance.com/api/v3";
const SYMBOL = "BTCUSDT";
const BASE_INTERVAL = "15m";
const BASE_CANDLES = 6000;
const INTERVALS = ["15m", "1h", "4h", "8h", "12h"] as const;
const INTERVAL_MINUTES: Record<(typeof INTERVALS)[number], number> = {
  "15m": 15,
  "1h": 60,
  "4h": 240,
  "8h": 480,
  "12h": 720,
};

const ASSUMPTIONS = {
  trendMethod: "5-candle percent change",
  trendThresholdPct: 0.6,
  entryTrigger: "15m turns into UP from non-UP while 8h/12h stay UP and 4h is not DOWN",
  stopPct: 1.5,
  targetPct: 3.0,
  maxHoldBars15m: 24,
  feePctPerSide: 0.05,
  onePositionAtATime: true,
};

async function fetchKlines(interval: string, total: number): Promise<Candle[]> {
  const all: Candle[] = [];
  let endTime: number | undefined;

  while (all.length < total) {
    const remaining = total - all.length;
    const limit = Math.min(1000, remaining);
    const params = new URLSearchParams({
      symbol: SYMBOL,
      interval,
      limit: String(limit),
    });
    if (endTime) params.set("endTime", String(endTime));

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

    all.unshift(...batch);
    endTime = batch[0].time - 1;
    await new Promise((r) => setTimeout(r, 100));
  }

  const uniq = new Map<number, Candle>();
  for (const c of all) uniq.set(c.time, c);
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

type Trade = {
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  holdBars: number;
  outcome: Outcome;
  rawPct: number;
  netPct: number;
};

function simulateTrade(candles: Candle[], entryIdx: number): Trade {
  const entryPrice = candles[entryIdx].close;
  const stopPrice = entryPrice * (1 - ASSUMPTIONS.stopPct / 100);
  const targetPrice = entryPrice * (1 + ASSUMPTIONS.targetPct / 100);
  const maxIdx = Math.min(entryIdx + ASSUMPTIONS.maxHoldBars15m, candles.length - 1);

  for (let i = entryIdx + 1; i <= maxIdx; i++) {
    const candle = candles[i];
    if (candle.low <= stopPrice) {
      const rawPct = -ASSUMPTIONS.stopPct;
      return {
        entryTime: candles[entryIdx].time,
        entryPrice,
        exitTime: candle.time,
        exitPrice: stopPrice,
        holdBars: i - entryIdx,
        outcome: "LOSS",
        rawPct,
        netPct: rawPct - ASSUMPTIONS.feePctPerSide * 2,
      };
    }
    if (candle.high >= targetPrice) {
      const rawPct = ASSUMPTIONS.targetPct;
      return {
        entryTime: candles[entryIdx].time,
        entryPrice,
        exitTime: candle.time,
        exitPrice: targetPrice,
        holdBars: i - entryIdx,
        outcome: "WIN",
        rawPct,
        netPct: rawPct - ASSUMPTIONS.feePctPerSide * 2,
      };
    }
  }

  const exitCandle = candles[maxIdx];
  const rawPct = ((exitCandle.close - entryPrice) / entryPrice) * 100;
  return {
    entryTime: candles[entryIdx].time,
    entryPrice,
    exitTime: exitCandle.time,
    exitPrice: exitCandle.close,
    holdBars: maxIdx - entryIdx,
    outcome: "TIMEOUT",
    rawPct,
    netPct: rawPct - ASSUMPTIONS.feePctPerSide * 2,
  };
}

async function main() {
  console.log("Fetching Binance candles for GPT LONG PULLBACK 15M V1...");

  const datasets = Object.fromEntries(
    await Promise.all(
      INTERVALS.map(async (interval) => {
        const needed = interval === BASE_INTERVAL
          ? BASE_CANDLES
          : Math.ceil((BASE_CANDLES * INTERVAL_MINUTES[BASE_INTERVAL]) / INTERVAL_MINUTES[interval]) + 20;
        const candles = await fetchKlines(interval, needed);
        return [interval, candles];
      }),
    ),
  ) as Record<(typeof INTERVALS)[number], Candle[]>;

  const base = datasets["15m"];
  const trades: Trade[] = [];
  let i = 6;

  while (i < base.length - 1) {
    const entryTime = base[i].time;

    const trend15 = deriveTrend(base, i);
    const prevTrend15 = deriveTrend(base, i - 1);
    const idx1h = findLastClosedIndex(datasets["1h"], entryTime);
    const idx4h = findLastClosedIndex(datasets["4h"], entryTime);
    const idx8h = findLastClosedIndex(datasets["8h"], entryTime);
    const idx12h = findLastClosedIndex(datasets["12h"], entryTime);

    if ([idx1h, idx4h, idx8h, idx12h].some((idx) => idx < 5)) {
      i++;
      continue;
    }

    const trend1h = deriveTrend(datasets["1h"], idx1h);
    const trend4h = deriveTrend(datasets["4h"], idx4h);
    const trend8h = deriveTrend(datasets["8h"], idx8h);
    const trend12h = deriveTrend(datasets["12h"], idx12h);

    const setupOk =
      trend8h === "UP" &&
      trend12h === "UP" &&
      trend4h !== "DOWN" &&
      (trend1h === "DOWN" || trend1h === "SIDEWAY") &&
      trend15 === "UP" &&
      prevTrend15 !== "UP";

    if (!setupOk) {
      i++;
      continue;
    }

    const trade = simulateTrade(base, i);
    trades.push(trade);
    i += Math.max(1, trade.holdBars);
  }

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

  const result = {
    ruleId: "gpt-long-pullback-15m-v1",
    generatedAt: new Date().toISOString(),
    assumptions: ASSUMPTIONS,
    sample: {
      baseInterval: BASE_INTERVAL,
      candlesFetched: Object.fromEntries(INTERVALS.map((interval) => [interval, datasets[interval].length])),
      trades: trades.length,
    },
    summary: {
      wins,
      losses,
      timeouts,
      winRate: Number(winRate.toFixed(2)),
      netPct: Number(netPct.toFixed(2)),
      avgNetPct: Number(avgNetPct.toFixed(3)),
      avgHoldBars: Number(avgHoldBars.toFixed(1)),
      profitFactor: Number(profitFactor.toFixed(2)),
    },
    recentTrades: trades.slice(-10),
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
