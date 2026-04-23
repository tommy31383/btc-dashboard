import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  calcRSI,
  calcStochRSI,
  calcMACD,
  calcBollinger,
  calcEMASeries,
  calcRSISeriesAligned,
  calcMACDSeries,
  calcBollingerSeries,
  detectDivergence,
} from "../utils/indicators";

const BINANCE = "https://api.binance.com/api/v3";

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const TARGETS: Record<string, number[]> = {
  "5m": [1, 2, 4, 5, 6, 7, 8],
  "15m": [2, 3, 4],
  "1h": [1, 2, 3, 4, 5, 8, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40],
  "4h": [4, 5, 6, 7, 8, 9],
  "1d": [1, 2, 3, 4, 5, 6, 7, 8],
  "1w": [1, 2],
};

const TF_CONFIG: Record<string, { candles: number; htfNear: string; htfFar: string }> = {
  "5m": { candles: 10000, htfNear: "15m", htfFar: "1h" },
  "15m": { candles: 10000, htfNear: "1h", htfFar: "4h" },
  "1h": { candles: 10000, htfNear: "4h", htfFar: "1d" },
  "4h": { candles: 6000, htfNear: "1d", htfFar: "1w" },
  "1d": { candles: 2000, htfNear: "1w", htfFar: "1M" },
  "1w": { candles: 500, htfNear: "1M", htfFar: "1M" },
};

const TF_MINUTES: Record<string, number> = {
  "5m": 5,
  "15m": 15,
  "1h": 60,
  "4h": 240,
  "1d": 1440,
  "1w": 10080,
  "1M": 43200,
};

async function fetchKlines(interval: string, total: number): Promise<Candle[]> {
  const all: Candle[] = [];
  let endTime: number | undefined;
  while (all.length < total) {
    const limit = Math.min(1000, total - all.length);
    const params = new URLSearchParams({ symbol: "BTCUSDT", interval, limit: String(limit) });
    if (endTime) params.set("endTime", String(endTime));
    const res = await fetch(`${BINANCE}/klines?${params}`);
    const data: any[] = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;
    const batch: Candle[] = data.map((k) => ({
      time: +k[0],
      open: +k[1],
      high: +k[2],
      low: +k[3],
      close: +k[4],
      volume: +k[5],
    }));
    all.unshift(...batch);
    endTime = batch[0].time - 1;
    await new Promise((r) => setTimeout(r, 80));
  }
  const byTime = new Map<number, Candle>();
  for (const c of all) byTime.set(c.time, c);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

function htfIdxAt(arr: Candle[], t: number): number {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].time <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

function trendFromEMA(price: number, ema: number | null): "UP" | "DOWN" | "FLAT" {
  if (ema === null) return "FLAT";
  const d = ((price - ema) / ema) * 100;
  return d > 0.3 ? "UP" : d < -0.3 ? "DOWN" : "FLAT";
}

function simulate(
  candles: Candle[],
  entryIdx: number,
  entryPrice: number,
  side: "LONG" | "SHORT",
  tpPct: number,
  slPct: number,
  maxHold: number,
): { outcome: "WIN" | "LOSS" | "TIMEOUT"; holdBars: number } {
  const tp = side === "LONG" ? entryPrice * (1 + tpPct / 100) : entryPrice * (1 - tpPct / 100);
  const sl = side === "LONG" ? entryPrice * (1 - slPct / 100) : entryPrice * (1 + slPct / 100);
  for (let i = entryIdx + 1; i < Math.min(entryIdx + 1 + maxHold, candles.length); i++) {
    if (side === "LONG") {
      if (candles[i].low <= sl) return { outcome: "LOSS", holdBars: i - entryIdx };
      if (candles[i].high >= tp) return { outcome: "WIN", holdBars: i - entryIdx };
    } else {
      if (candles[i].high >= sl) return { outcome: "LOSS", holdBars: i - entryIdx };
      if (candles[i].low <= tp) return { outcome: "WIN", holdBars: i - entryIdx };
    }
  }
  return { outcome: "TIMEOUT", holdBars: maxHold };
}

async function verifyTF(tfKey: string, ranks: number[], hard: any): Promise<any[]> {
  const cfg = TF_CONFIG[tfKey];
  console.log(`\n=== [${tfKey}] flipped backtest ${ranks.length} rules ===`);
  const entry = await fetchKlines(tfKey, cfg.candles);
  const htfNear = await fetchKlines(cfg.htfNear, Math.ceil(cfg.candles * TF_MINUTES[tfKey] / TF_MINUTES[cfg.htfNear]) + 100).catch(() => [] as Candle[]);
  const htfFar = await fetchKlines(cfg.htfFar, Math.ceil(cfg.candles * TF_MINUTES[tfKey] / TF_MINUTES[cfg.htfFar]) + 100).catch(() => [] as Candle[]);

  const closes = entry.map((x) => x.close);
  const rsiArr = calcRSISeriesAligned(closes, 14);
  const macdArr = calcMACDSeries(closes);
  const bbArr = calcBollingerSeries(closes, 20, 2);
  const ema50 = calcEMASeries(closes, 50);
  const stochArr: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = 50; i < closes.length; i++) stochArr[i] = calcStochRSI(closes.slice(0, i + 1)).k;
  const divArr: ("BULLISH_DIV" | "BEARISH_DIV" | null)[] = new Array(closes.length).fill(null);
  for (let i = 50; i < closes.length; i++) {
    divArr[i] = i % 3 === 0 ? detectDivergence(closes.slice(0, i + 1)) : divArr[i - 1];
  }
  const htfNearEMA = calcEMASeries(htfNear.map((x) => x.close), 50);
  const htfFarEMA = calcEMASeries(htfFar.map((x) => x.close), 50);

  const results: any[] = [];
  for (const rank of ranks) {
    const rule = (hard.tfs?.[tfKey]?.rules || []).find((r: any) => r.rank === rank);
    if (!rule) continue;
    const rcfg = rule.config || {};
    const origSide: "LONG" | "SHORT" = rcfg.forceSide || rule.stats?.side || "LONG";
    const flipSide: "LONG" | "SHORT" = origSide === "LONG" ? "SHORT" : "LONG";
    const lev = rcfg.leverage || 10;
    const tpPct = rcfg.targetPct || 2;
    const slPct = rcfg.stopPct || 1;
    const maxHold = rcfg.maxHoldBars || 100;
    const feePerSide = 0.04;
    const feePnl = feePerSide * 2 * lev;
    const required: string[] = rcfg.requiredConditions || [];
    const minScore = rcfg.minScore ?? 1;

    let wins = 0, losses = 0, timeouts = 0, sumHold = 0;
    for (let i = 50; i < entry.length - maxHold - 1; i++) {
      const price = closes[i];

      if (rcfg.candleReversalFilter) {
        if (i < 1) continue;
        const prevBull = entry[i - 1].close >= entry[i - 1].open;
        const currBull = entry[i].close >= entry[i].open;
        const rev = prevBull === currBull ? null : (!prevBull && currBull ? "UP_REVERSAL" : "DOWN_REVERSAL");
        const inverted = rcfg.candleReversalFilter.invertedFromFlip === true;
        const baseWant = origSide === "LONG" ? "UP_REVERSAL" : "DOWN_REVERSAL";
        const want = inverted ? (baseWant === "UP_REVERSAL" ? "DOWN_REVERSAL" : "UP_REVERSAL") : baseWant;
        if (rev !== want) continue;
      }

      if (rcfg.emaPosFilter) {
        const e = ema50[i];
        if (e === null) continue;
        const above = price >= e;
        if (rcfg.emaPosFilter === "above" && !above) continue;
        if (rcfg.emaPosFilter === "below" && above) continue;
      }

      if (rcfg.htfTrendFilter) {
        const mode = rcfg.htfTrendFilter.mode || rcfg.htfTrendFilter;
        const inverted = rcfg.htfTrendFilter.invertedFromFlip === true;
        const baseWant: "UP" | "DOWN" = origSide === "LONG" ? "UP" : "DOWN";
        const want = inverted ? (baseWant === "UP" ? "DOWN" : "UP") : baseWant;
        const t = entry[i].time + TF_MINUTES[tfKey] * 60 * 1000 - 1;
        const ni = htfIdxAt(htfNear, t);
        const fi = htfIdxAt(htfFar, t);
        const nt = ni >= 0 ? trendFromEMA(htfNear[ni].close, htfNearEMA[ni]) : "FLAT";
        const ft = fi >= 0 ? trendFromEMA(htfFar[fi].close, htfFarEMA[fi]) : "FLAT";
        if (mode === "near_match" && nt !== want) continue;
        if (mode === "far_match" && ft !== want) continue;
        if (mode === "both_match" && (nt !== want || ft !== want)) continue;
        if (mode === "near_flat" && nt !== "FLAT") continue;
        if (mode === "far_flat" && ft !== "FLAT") continue;
        if (mode === "both_flat" && (nt !== "FLAT" || ft !== "FLAT")) continue;
      }

      const rsi = rsiArr[i];
      const stK = stochArr[i];
      const mh = macdArr.histogram[i];
      const pmh = i > 0 ? macdArr.histogram[i - 1] : null;
      const bb = { upper: bbArr.upper[i], lower: bbArr.lower[i] };
      const div = divArr[i];

      const conds: Record<string, boolean> = {
        stochExtreme: stK !== null && (origSide === "LONG" ? stK < (rcfg.stochOSLevel ?? 5) : stK > (rcfg.stochOBLevel ?? 95)),
        rsiExtreme: rsi !== null && (origSide === "LONG" ? rsi < (rcfg.rsiOSLevel ?? 25) : rsi > (rcfg.rsiOBLevel ?? 75)),
        divergence: origSide === "LONG" ? div === "BULLISH_DIV" : div === "BEARISH_DIV",
        bollingerTouch: origSide === "LONG" ? (bb.lower !== null && price <= bb.lower) : (bb.upper !== null && price >= bb.upper),
        macdCross: mh !== null && pmh !== null && (
          origSide === "LONG"
            ? ((pmh < 0 && mh >= 0) || mh > pmh)
            : ((pmh > 0 && mh <= 0) || mh < pmh)
        ),
      };

      let reqFail = false;
      for (const k of required) {
        if (!conds[k]) {
          reqFail = true;
          break;
        }
      }
      if (reqFail) continue;

      if (!rcfg.candleReversalFilter && required.length === 0) {
        const n = Object.values(conds).filter(Boolean).length;
        if (n < minScore) continue;
      }

      const out = simulate(entry, i, price, flipSide, tpPct, slPct, maxHold);
      if (out.outcome === "WIN") wins++;
      else if (out.outcome === "LOSS") losses++;
      else timeouts++;
      sumHold += out.holdBars;
    }

    const trades = wins + losses + timeouts;
    const grossPct = wins * tpPct * lev - losses * slPct * lev;
    const feesPct = trades * feePnl;
    const netPct = grossPct - feesPct;
    const wr = trades > 0 ? (wins / trades) * 100 : 0;
    const avgHold = trades > 0 ? sumHold / trades : 0;
    results.push({
      tfKey,
      rank,
      label: rule.label || `${origSide} rank${rank}`,
      originalSide: origSide,
      flippedSide: flipSide,
      config: { tpPct, slPct, lev, maxHold, required, minScore },
      flipped: {
        trades,
        wins,
        losses,
        timeouts,
        winRate: +wr.toFixed(1),
        netPnL: Math.round(netPct),
        avgHold: +avgHold.toFixed(1),
      },
    });
    console.log(`  #${String(rank).padStart(2)} ${origSide}->${flipSide} N=${String(trades).padStart(5)} WR=${String((+wr.toFixed(1))).padStart(5)}% NET=${netPct >= 0 ? "+" : ""}${Math.round(netPct)}%`);
  }
  return results;
}

async function main() {
  console.log("=== backtest-flipped-selected ===");
  const hardPath = join(__dirname, "..", "assets", "hard_rules.json");
  const hard = JSON.parse(readFileSync(hardPath, "utf8"));
  const allResults: any[] = [];
  for (const [tfKey, ranks] of Object.entries(TARGETS)) {
    const res = await verifyTF(tfKey, ranks, hard);
    allResults.push(...res);
  }
  const summary = allResults.reduce((acc: any, r: any) => {
    acc[r.tfKey] ??= { total: 0, positive: 0, negative: 0, zero: 0 };
    acc[r.tfKey].total++;
    if (r.flipped.netPnL > 0) acc[r.tfKey].positive++;
    else if (r.flipped.netPnL < 0) acc[r.tfKey].negative++;
    else acc[r.tfKey].zero++;
    return acc;
  }, {});

  const outPath = join(__dirname, "..", "assets", "flipped_43_verification.json");
  writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    assumptions: "Flip side only; keep original conditions, TP/SL, leverage, maxHold, HTF filters",
    results: allResults,
    summary,
  }, null, 2));

  console.log("\n=== Summary ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nSaved -> ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
