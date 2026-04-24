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

type Trade = {
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  holdBars: number;
  outcome: Outcome;
  stopPct: number;
  support: number;
  resistance: number;
  stochKAtEntry: number;
  stochKAtExit: number | null;
  rawPct: number;
  netPct: number;
};

const BINANCE_REST = "https://api.binance.com/api/v3";
const SYMBOL = "BTCUSDT";
const NOW = Date.now();
const START_TIME = NOW - 365 * 24 * 60 * 60 * 1000;
const LOOKBACK_4H = 20;
const MAX_HOLD_BARS = 8;
const STOP_PCT = 1;
const FEE_PCT_PER_SIDE = 0.05;
const RESISTANCE_BUFFER_PCT = 0.25;

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
  };
}

async function main() {
  console.log("Fetching 1-year Binance candles for 1h stoch/support rule...");

  const [candles1h, candles4h] = await Promise.all([
    fetchKlinesSince("1h", START_TIME - 30 * 60 * 60 * 1000),
    fetchKlinesSince("4h", START_TIME - 30 * 4 * 60 * 60 * 1000),
  ]);

  const closes1h = candles1h.map((c) => c.close);
  const { kSeries } = calcStochRSISeries(closes1h);

  const trades: Trade[] = [];
  let i = 30;

  while (i < candles1h.length - 1) {
    const candle = candles1h[i];
    if (candle.time < START_TIME) {
      i++;
      continue;
    }

    const idx4h = findLastClosedIndex(candles4h, candle.time);
    const stochK = kSeries[i];
    if (idx4h < LOOKBACK_4H || stochK === null) {
      i++;
      continue;
    }

    if (stochK >= 95) {
      i++;
      continue;
    }

    const window4h = candles4h.slice(idx4h - LOOKBACK_4H + 1, idx4h + 1);
    const support = Math.min(...window4h.map((c) => c.low));
    const resistance = Math.max(...window4h.map((c) => c.high));
    const atr1h = calcATRPct(candles1h.slice(Math.max(0, i - 20), i + 1), 14);
    if (atr1h === null) {
      i++;
      continue;
    }

    const nearSupportPct = ((candle.close - support) / candle.close) * 100;
    const supportNearThreshold = Math.max(0.25, atr1h * 0.35);
    const touchesSupport = candle.low <= support * 1.002;
    const nearSupport = nearSupportPct >= 0 && nearSupportPct <= supportNearThreshold;
    if (!touchesSupport && !nearSupport) {
      i++;
      continue;
    }

    const stopPrice = candle.close * (1 - STOP_PCT / 100);
    if (resistance <= candle.close) {
      i++;
      continue;
    }

    let trade: Trade | null = null;
    const resistanceTrigger = resistance * (1 - RESISTANCE_BUFFER_PCT / 100);
    const maxIdx = Math.min(i + MAX_HOLD_BARS, candles1h.length - 1);

    for (let j = i + 1; j <= maxIdx; j++) {
      const future = candles1h[j];
      const futureK = kSeries[j];

      if (future.low <= stopPrice) {
        trade = {
          entryTime: candle.time,
          entryPrice: candle.close,
          exitTime: future.time,
          exitPrice: stopPrice,
          holdBars: j - i,
          outcome: "LOSS",
          stopPct: STOP_PCT,
          support,
          resistance,
          stochKAtEntry: Number(stochK.toFixed(2)),
          stochKAtExit: futureK !== null ? Number(futureK.toFixed(2)) : null,
          rawPct: -STOP_PCT,
          netPct: -STOP_PCT - FEE_PCT_PER_SIDE * 2,
        };
        break;
      }

      const tpByResistance = future.high >= resistanceTrigger;
      const tpByStoch = futureK !== null && futureK > 90 && future.close > candle.close;
      if (tpByResistance || tpByStoch) {
        const exitPrice = tpByResistance ? Math.min(future.close, resistanceTrigger) : future.close;
        const rawPct = ((exitPrice - candle.close) / candle.close) * 100;
        trade = {
          entryTime: candle.time,
          entryPrice: candle.close,
          exitTime: future.time,
          exitPrice,
          holdBars: j - i,
          outcome: "WIN",
          stopPct: STOP_PCT,
          support,
          resistance,
          stochKAtEntry: Number(stochK.toFixed(2)),
          stochKAtExit: futureK !== null ? Number(futureK.toFixed(2)) : null,
          rawPct,
          netPct: rawPct - FEE_PCT_PER_SIDE * 2,
        };
        break;
      }
    }

    if (!trade) {
      const exit = candles1h[maxIdx];
      const exitK = kSeries[maxIdx];
      const rawPct = ((exit.close - candle.close) / candle.close) * 100;
      trade = {
        entryTime: candle.time,
        entryPrice: candle.close,
        exitTime: exit.time,
        exitPrice: exit.close,
        holdBars: maxIdx - i,
        outcome: "TIMEOUT",
        stopPct: STOP_PCT,
        support,
        resistance,
        stochKAtEntry: Number(stochK.toFixed(2)),
        stochKAtExit: exitK !== null ? Number(exitK.toFixed(2)) : null,
        rawPct,
        netPct: rawPct - FEE_PCT_PER_SIDE * 2,
      };
    }

    trades.push(trade);
    i += Math.max(1, trade.holdBars);
  }

  const result = {
    ruleId: "gpt-long-1h-stoch-support-4h-sr-v1",
    generatedAt: new Date().toISOString(),
    assumptions: {
      period: "1 year",
      dateRange: {
        from: new Date(START_TIME).toISOString(),
        to: new Date(NOW).toISOString(),
      },
      entry: "1h StochRSI K < 95 and price touches/is near 4h support",
      supportLookback4h: LOOKBACK_4H,
      supportNearThreshold: "max(0.25%, 0.35 * ATR1h)",
      stopLoss: "fixed 1%",
      takeProfit: "near 4h resistance OR 1h StochRSI K > 90",
      resistanceBufferPct: RESISTANCE_BUFFER_PCT,
      maxHoldBars1h: MAX_HOLD_BARS,
      feePctPerSide: FEE_PCT_PER_SIDE,
    },
    sample: {
      candles1h: candles1h.length,
      candles4h: candles4h.length,
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
