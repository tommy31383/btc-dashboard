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
type StopMode = "atr_only" | "structure_atr";

type RiskConfig = {
  stopMode: StopMode;
  lookback15: number;
  lookback1h: number;
  padPct: number;
  atrStopMult: number;
  minStopPct: number;
  maxStopPct: number;
  rrResume: number;
  rrSqueeze: number;
  atrFloorResume: number;
  atrFloorSqueeze: number;
  maxHoldBars15m: number;
};

type Trade = {
  context: ContextLabel;
  outcome: Outcome;
  holdBars: number;
  stopPct: number;
  targetPct: number;
  rawPct: number;
  netPct: number;
};

const BINANCE_REST = "https://api.binance.com/api/v3";
const SYMBOL = "BTCUSDT";
const START_TIME = Date.now() - 365 * 24 * 60 * 60 * 1000;
const INTERVALS = ["15m", "1h"] as const;
const INTERVAL_MS: Record<(typeof INTERVALS)[number], number> = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
};
const ALLOWED_CONTEXTS: ContextLabel[] = ["TREND_RESUME", "SQUEEZE"];
const FEE_PCT_PER_SIDE = 0.05;
const TREND_THRESHOLD_PCT = 0.6;

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
  if (pct > TREND_THRESHOLD_PCT) return "UP";
  if (pct < -TREND_THRESHOLD_PCT) return "DOWN";
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
  cfg: RiskConfig,
  context: ContextLabel,
  candles15m: Candle[],
  candles1h: Candle[],
  idx15m: number,
  idx1h: number,
): { stopPct: number; targetPct: number } | null {
  const entryPrice = candles15m[idx15m].close;
  const atr15m = calcATRPct(candles15m.slice(Math.max(0, idx15m - 20), idx15m + 1), 14);
  if (atr15m === null) return null;

  const structure15m = recentLowPct(candles15m, idx15m, cfg.lookback15, entryPrice);
  const structure1h = recentLowPct(candles1h, idx1h, cfg.lookback1h, entryPrice);

  let stopPct =
    cfg.stopMode === "atr_only"
      ? atr15m * cfg.atrStopMult
      : Math.max(structure15m, structure1h) + cfg.padPct;

  stopPct = Math.max(stopPct, atr15m * cfg.atrStopMult);
  stopPct = clamp(stopPct, cfg.minStopPct, cfg.maxStopPct);

  const rr = context === "TREND_RESUME" ? cfg.rrResume : cfg.rrSqueeze;
  const atrFloor = context === "TREND_RESUME" ? cfg.atrFloorResume : cfg.atrFloorSqueeze;
  const targetPct = clamp(Math.max(stopPct * rr, atr15m * atrFloor), 0.45, 6);

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
  maxHoldBars15m: number,
  context: ContextLabel,
): Trade {
  const entryPrice = candles[entryIdx].close;
  const stopPrice = entryPrice * (1 - stopPct / 100);
  const targetPrice = entryPrice * (1 + targetPct / 100);
  const maxIdx = Math.min(entryIdx + maxHoldBars15m, candles.length - 1);

  for (let i = entryIdx + 1; i <= maxIdx; i++) {
    const candle = candles[i];
    if (candle.low <= stopPrice) {
      const rawPct = -stopPct;
      return {
        context,
        outcome: "LOSS",
        holdBars: i - entryIdx,
        stopPct,
        targetPct,
        rawPct,
        netPct: rawPct - FEE_PCT_PER_SIDE * 2,
      };
    }
    if (candle.high >= targetPrice) {
      const rawPct = targetPct;
      return {
        context,
        outcome: "WIN",
        holdBars: i - entryIdx,
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
    context,
    outcome: "TIMEOUT",
    holdBars: maxIdx - entryIdx,
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

function contextBreakdown(trades: Trade[]) {
  return Object.fromEntries(
    ALLOWED_CONTEXTS.map((ctx) => [ctx, summarize(trades.filter((t) => t.context === ctx))]),
  );
}

function scoreCombo(summary: ReturnType<typeof summarize>) {
  return summary.netPct + summary.profitFactor * 25 - Math.max(0, 120 - summary.trades) * 0.08;
}

async function main() {
  console.log("Fetching data for 15m GPT SL/TP optimization...");
  const datasets = Object.fromEntries(
    await Promise.all(
      INTERVALS.map(async (interval) => [interval, await fetchKlinesSince(interval, START_TIME - INTERVAL_MS[interval] * 12)]),
    ),
  ) as Record<(typeof INTERVALS)[number], Candle[]>;

  const base = datasets["15m"].filter((c) => c.time >= START_TIME);
  const setupCandidates: { idx15: number; idx1h: number; context: ContextLabel }[] = [];
  for (let i = 6; i < base.length - 1; i++) {
    const entryTime = base[i].time;
    const idx15 = findLastClosedIndex(datasets["15m"], entryTime);
    const idx1h = findLastClosedIndex(datasets["1h"], entryTime);
    if (idx15 < 20 || idx1h < 20) continue;
    const trend1h = deriveTrend(datasets["1h"], idx1h);
    const trend15 = deriveTrend(datasets["15m"], idx15);
    const atr15m = calcATRPct(datasets["15m"].slice(Math.max(0, idx15 - 20), idx15 + 1), 14);
    if (trend1h !== "UP" || trend15 === null || atr15m === null) continue;
    const context = detectContext(trend15, atr15m);
    if (!ALLOWED_CONTEXTS.includes(context)) continue;
    setupCandidates.push({ idx15, idx1h, context });
  }

  const stopModes: StopMode[] = ["atr_only", "structure_atr"];
  const lookbacks15 = [6, 8, 10];
  const lookbacks1h = [2, 3, 4];
  const pads = [0.04, 0.08, 0.12];
  const atrStopMults = [1.0, 1.15, 1.3, 1.45];
  const minStops = [0.35, 0.45, 0.55];
  const rrResumeList = [1.3, 1.5, 1.7, 1.9, 2.1];
  const rrSqueezeList = [1.0, 1.15, 1.3, 1.45, 1.6];
  const atrFloorResumeList = [1.6, 2.0, 2.4];
  const atrFloorSqueezeList = [1.2, 1.5, 1.8];
  const maxHoldList = [12, 16, 20, 24, 32];

  const results: any[] = [];

  for (const stopMode of stopModes) {
    for (const atrStopMult of atrStopMults) {
      for (const minStopPct of minStops) {
        for (const rrResume of rrResumeList) {
          for (const rrSqueeze of rrSqueezeList) {
            for (const atrFloorResume of atrFloorResumeList) {
              for (const atrFloorSqueeze of atrFloorSqueezeList) {
                for (const maxHoldBars15m of maxHoldList) {
                  const lookback15Choices = stopMode === "atr_only" ? [8] : lookbacks15;
                  const lookback1hChoices = stopMode === "atr_only" ? [3] : lookbacks1h;
                  const padChoices = stopMode === "atr_only" ? [0.08] : pads;
                  for (const lookback15 of lookback15Choices) {
                    for (const lookback1h of lookback1hChoices) {
                      for (const padPct of padChoices) {
                        const cfg: RiskConfig = {
                          stopMode,
                          lookback15,
                          lookback1h,
                          padPct,
                          atrStopMult,
                          minStopPct,
                          maxStopPct: 2.8,
                          rrResume,
                          rrSqueeze,
                          atrFloorResume,
                          atrFloorSqueeze,
                          maxHoldBars15m,
                        };
                        const trades: Trade[] = [];
                        let nextAllowedIdx = 0;
                        for (const setup of setupCandidates) {
                          if (setup.idx15 < nextAllowedIdx) continue;
                          const riskPlan = buildRiskPlan(cfg, setup.context, datasets["15m"], datasets["1h"], setup.idx15, setup.idx1h);
                          if (!riskPlan) continue;
                          const trade = simulateTrade(
                            datasets["15m"],
                            setup.idx15,
                            riskPlan.stopPct,
                            riskPlan.targetPct,
                            cfg.maxHoldBars15m,
                            setup.context,
                          );
                          trades.push(trade);
                          nextAllowedIdx = setup.idx15 + Math.max(1, trade.holdBars);
                        }
                        const summary = summarize(trades);
                        const breakdown = contextBreakdown(trades);
                        results.push({
                          cfg,
                          summary,
                          breakdown,
                          score: Number(scoreCombo(summary).toFixed(2)),
                        });
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  const topByNet = [...results].sort((a, b) => b.summary.netPct - a.summary.netPct).slice(0, 30);
  const topByScore = [...results].sort((a, b) => b.score - a.score).slice(0, 30);
  const topByPf = [...results].sort((a, b) => b.summary.profitFactor - a.summary.profitFactor || b.summary.netPct - a.summary.netPct).slice(0, 30);

  const out = {
    generatedAt: new Date().toISOString(),
    ruleId: "gpt-long-every-candle-1h-up-15m-v1",
    assumptions: {
      period: "1 year",
      allowedContexts: ALLOWED_CONTEXTS,
      entry: "LONG every 15m candle only when 1h trend is UP",
      trendMethod: "5-candle percent change",
      trendThresholdPct: TREND_THRESHOLD_PCT,
      feePctPerSide: FEE_PCT_PER_SIDE,
      onePositionAtATime: true,
    },
    sample: {
      startTime: new Date(START_TIME).toISOString(),
      endTime: new Date().toISOString(),
      candidateSetups: setupCandidates.length,
      candlesFetched: {
        "15m": datasets["15m"].length,
        "1h": datasets["1h"].length,
      },
    },
    searchSpace: {
      stopModes,
      lookbacks15,
      lookbacks1h,
      pads,
      atrStopMults,
      minStops,
      rrResumeList,
      rrSqueezeList,
      atrFloorResumeList,
      atrFloorSqueezeList,
      maxHoldList,
    },
    totalCombos: results.length,
    bestByNet: topByNet[0],
    bestByScore: topByScore[0],
    bestByProfitFactor: topByPf[0],
    topByNet,
    topByScore,
    topByProfitFactor: topByPf,
  };

  const outPath = "E:/AI/BTC/btc-dashboard/assets/gpt_rule_15m_sltp_optimization.json";
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({
    totalCombos: out.totalCombos,
    bestByNet: out.bestByNet,
    bestByScore: out.bestByScore,
    bestByProfitFactor: out.bestByProfitFactor,
    outPath,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
