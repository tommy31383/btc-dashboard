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
  outcome: Outcome;
  holdBars: number;
  rawPct: number;
  netPct: number;
};

type Config = {
  stopPct: number;
  maxHoldBars: number;
  resistanceBufferPct: number;
  stochExitK: number;
  stochMinProfitPct: number;
  supportAtrMult: number;
  supportMinPct: number;
};

const BINANCE_REST = "https://api.binance.com/api/v3";
const SYMBOL = "BTCUSDT";
const NOW = Date.now();
const START_TIME = NOW - 365 * 24 * 60 * 60 * 1000;
const LOOKBACK_1H = 20;
const FEE_PCT_PER_SIDE = 0.05;

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
  for (const c of all) if (c.time >= startTime) uniq.set(c.time, c);
  return Array.from(uniq.values()).sort((a, b) => a.time - b.time);
}

function findLastClosedIndex(candles: Candle[], time: number): number {
  let lo = 0;
  let hi = candles.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
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

function score(summary: ReturnType<typeof summarize>) {
  return summary.netPct + summary.profitFactor * 20 + Math.max(0, summary.winRate - 70) * 3;
}

async function main() {
  console.log("Fetching data for 15m stoch/support optimization...");
  const [candles15m, candles1h] = await Promise.all([
    fetchKlinesSince("15m", START_TIME - 30 * 15 * 60 * 1000),
    fetchKlinesSince("1h", START_TIME - 30 * 60 * 60 * 1000),
  ]);

  const closes15m = candles15m.map((c) => c.close);
  const { kSeries } = calcStochRSISeries(closes15m);

  const stopList = [0.85, 0.95, 1.0, 1.05, 1.15];
  const maxHoldList = [24, 28, 32, 40];
  const resistanceBufferList = [0.15, 0.2, 0.25, 0.3];
  const stochExitList = [90, 92, 94, 96];
  const stochProfitList = [0, 0.15, 0.3];
  const supportAtrMultList = [0.3, 0.35, 0.4];
  const supportMinPctList = [0.18, 0.2, 0.25];

  const results: any[] = [];
  let comboCount = 0;

  for (const stopPct of stopList) {
    for (const maxHoldBars of maxHoldList) {
      for (const resistanceBufferPct of resistanceBufferList) {
        for (const stochExitK of stochExitList) {
          for (const stochMinProfitPct of stochProfitList) {
            for (const supportAtrMult of supportAtrMultList) {
              for (const supportMinPct of supportMinPctList) {
                comboCount++;
                const cfg: Config = {
                  stopPct,
                  maxHoldBars,
                  resistanceBufferPct,
                  stochExitK,
                  stochMinProfitPct,
                  supportAtrMult,
                  supportMinPct,
                };
                const trades: Trade[] = [];
                let i = 30;
                while (i < candles15m.length - 1) {
                  const candle = candles15m[i];
                  if (candle.time < START_TIME) {
                    i++;
                    continue;
                  }
                  const idx1h = findLastClosedIndex(candles1h, candle.time);
                  const stochK = kSeries[i];
                  if (idx1h < LOOKBACK_1H || stochK === null) {
                    i++;
                    continue;
                  }
                  if (stochK >= 95) {
                    i++;
                    continue;
                  }
                  const window1h = candles1h.slice(idx1h - LOOKBACK_1H + 1, idx1h + 1);
                  const support = Math.min(...window1h.map((c) => c.low));
                  const resistance = Math.max(...window1h.map((c) => c.high));
                  const atr15m = calcATRPct(candles15m.slice(Math.max(0, i - 20), i + 1), 14);
                  if (atr15m === null) {
                    i++;
                    continue;
                  }
                  const nearSupportPct = ((candle.close - support) / candle.close) * 100;
                  const supportNearThreshold = Math.max(cfg.supportMinPct, atr15m * cfg.supportAtrMult);
                  const touchesSupport = candle.low <= support * 1.0015;
                  const nearSupport = nearSupportPct >= 0 && nearSupportPct <= supportNearThreshold;
                  if (!touchesSupport && !nearSupport) {
                    i++;
                    continue;
                  }
                  if (resistance <= candle.close) {
                    i++;
                    continue;
                  }
                  const stopPrice = candle.close * (1 - cfg.stopPct / 100);
                  const resistanceTrigger = resistance * (1 - cfg.resistanceBufferPct / 100);
                  const maxIdx = Math.min(i + cfg.maxHoldBars, candles15m.length - 1);
                  let trade: Trade | null = null;
                  for (let j = i + 1; j <= maxIdx; j++) {
                    const future = candles15m[j];
                    const futureK = kSeries[j];
                    if (future.low <= stopPrice) {
                      const rawPct = -cfg.stopPct;
                      trade = {
                        outcome: "LOSS",
                        holdBars: j - i,
                        rawPct,
                        netPct: rawPct - FEE_PCT_PER_SIDE * 2,
                      };
                      break;
                    }
                    const rawNow = ((future.close - candle.close) / candle.close) * 100;
                    const tpByResistance = future.high >= resistanceTrigger;
                    const tpByStoch = futureK !== null && futureK > cfg.stochExitK && rawNow >= cfg.stochMinProfitPct;
                    if (tpByResistance || tpByStoch) {
                      const exitPrice = tpByResistance ? Math.min(future.close, resistanceTrigger) : future.close;
                      const rawPct = ((exitPrice - candle.close) / candle.close) * 100;
                      trade = {
                        outcome: "WIN",
                        holdBars: j - i,
                        rawPct,
                        netPct: rawPct - FEE_PCT_PER_SIDE * 2,
                      };
                      break;
                    }
                  }
                  if (!trade) {
                    const exit = candles15m[maxIdx];
                    const rawPct = ((exit.close - candle.close) / candle.close) * 100;
                    trade = {
                      outcome: "TIMEOUT",
                      holdBars: maxIdx - i,
                      rawPct,
                      netPct: rawPct - FEE_PCT_PER_SIDE * 2,
                    };
                  }
                  trades.push(trade);
                  i += Math.max(1, trade.holdBars);
                }
                const summary = summarize(trades);
                results.push({
                  cfg,
                  summary,
                  score: Number(score(summary).toFixed(2)),
                });
              }
            }
          }
        }
      }
    }
  }

  const bestByNet = [...results].sort((a, b) => b.summary.netPct - a.summary.netPct).slice(0, 30);
  const bestWr70 = [...results]
    .filter((r) => r.summary.winRate >= 70)
    .sort((a, b) => b.summary.netPct - a.summary.netPct || b.summary.profitFactor - a.summary.profitFactor)
    .slice(0, 30);
  const bestWr68 = [...results]
    .filter((r) => r.summary.winRate >= 68)
    .sort((a, b) => b.summary.netPct - a.summary.netPct || b.summary.profitFactor - a.summary.profitFactor)
    .slice(0, 30);
  const bestByScore = [...results].sort((a, b) => b.score - a.score).slice(0, 30);

  const out = {
    generatedAt: new Date().toISOString(),
    ruleId: "gpt-long-15m-stoch-support-1h-sr-v1",
    assumptions: {
      period: "1 year",
      dateRange: {
        from: new Date(START_TIME).toISOString(),
        to: new Date(NOW).toISOString(),
      },
      entry: "15m StochRSI K < 95 and price touches/is near 1h support",
      supportLookback1h: LOOKBACK_1H,
      feePctPerSide: FEE_PCT_PER_SIDE,
    },
    searchSpace: {
      stopList,
      maxHoldList,
      resistanceBufferList,
      stochExitList,
      stochProfitList,
      supportAtrMultList,
      supportMinPctList,
    },
    totalCombos: comboCount,
    baseline: {
      stopPct: 1,
      maxHoldBars: 32,
      resistanceBufferPct: 0.25,
      stochExitK: 90,
      stochMinProfitPct: 0,
      supportAtrMult: 0.35,
      supportMinPct: 0.2,
      summary: results.find((r) =>
        r.cfg.stopPct === 1 &&
        r.cfg.maxHoldBars === 32 &&
        r.cfg.resistanceBufferPct === 0.25 &&
        r.cfg.stochExitK === 90 &&
        r.cfg.stochMinProfitPct === 0 &&
        r.cfg.supportAtrMult === 0.35 &&
        r.cfg.supportMinPct === 0.2,
      )?.summary,
    },
    bestByNet,
    bestWr70,
    bestWr68,
    bestByScore,
  };

  const outPath = "E:/AI/BTC/btc-dashboard/assets/gpt_rule_15m_stoch_support_optimization.json";
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({
    totalCombos: comboCount,
    baseline: out.baseline,
    bestWr70: out.bestWr70[0],
    bestWr68: out.bestWr68[0],
    bestByNet: out.bestByNet[0],
    outPath,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
