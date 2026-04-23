/**
 * scan-tpsl-htf.ts
 *
 * Combines 3 dimensions of search for ONE timeframe:
 *   1. CONDITIONS — singles + pairs (5 base indicators)
 *   2. TP/SL — 15 combos with R:R 1.5-4
 *   3. HTF FILTER — none / 1H trend match / 4H trend match / both
 *
 * Outputs ranked NET PnL list (after Binance fees) for every (condition, TP/SL,
 * HTF filter, side) combination. Lets us discover the BEST rule that uses
 * higher-timeframe trend confirmation.
 *
 * Usage:
 *   npx tsx tools/scan-tpsl-htf.ts                              # 15m default
 *   npx tsx tools/scan-tpsl-htf.ts --tf=15m --candles=10000
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { Candle, EntryConditions } from "../utils/backtester";
import { calcRSI, calcStochRSI, calcMACD, calcBollinger, detectDivergence } from "../utils/indicators";

const BINANCE_REST = "https://api.binance.com/api/v3";

const args = process.argv.slice(2);
const argTF = args.find((a) => a.startsWith("--tf="))?.replace("--tf=", "") || "15m";
const argBars = parseInt(args.find((a) => a.startsWith("--bars="))?.replace("--bars=", "") || "100", 10);
const argCandles = parseInt(args.find((a) => a.startsWith("--candles="))?.replace("--candles=", "") || "10000", 10);
const argLeverage = parseInt(args.find((a) => a.startsWith("--lev="))?.replace("--lev=", "") || "100", 10);
const argFee = parseFloat(args.find((a) => a.startsWith("--fee="))?.replace("--fee=", "") || "0.05");

const FEE_PNL_PER_TRADE = argFee * 2 * argLeverage;

// HTF mapping: which higher TFs to use as filter
// For 15m: use 1h + 4h. For 5m: use 15m + 1h. For 1h: use 4h + 1d.
const HTF_MAP: Record<string, [string, string]> = {
  "5m": ["15m", "1h"],
  "15m": ["1h", "4h"],
  "1h": ["4h", "1d"],
  "4h": ["1d", "1w"],
};

const [HTF_NEAR, HTF_FAR] = HTF_MAP[argTF] || ["1h", "4h"];

// TP/SL grid (raw price %)
const TPSL_COMBOS: [number, number][] = [
  [1, 0.5], [2, 1], [3, 1.5], [3, 1], [5, 2],
  [5, 3], [8, 3], [8, 4], [10, 5], [10, 3],
  [15, 5], [15, 7], [20, 8], [20, 10], [2, 0.5],
];

const COND_LABELS: Record<string, string> = {
  stochExtreme: "Stoch", rsiExtreme: "RSI", divergence: "Div",
  bollingerTouch: "BB", macdCross: "MACD",
};
// NOTE: stochExtreme đã loại (K>95/K<5 hiếm)
// NOTE: rsiExtreme cũng loại (phân tích top 100 rule profit: 6% 15m / 21% 1h, single-profit thấp)
// Chỉ còn 3 cond: divergence + bollingerTouch + macdCross
const COND_KEYS: (keyof EntryConditions)[] = ["divergence", "bollingerTouch", "macdCross"];

console.log(`=== scan-tpsl-htf ===`);
console.log(`TF: ${argTF} · HTF near: ${HTF_NEAR} · HTF far: ${HTF_FAR} · candles: ${argCandles} · lev x${argLeverage} · fee ${argFee}%`);
console.log("");

async function fetchKlines(interval: string, total: number): Promise<Candle[]> {
  const all: Candle[] = [];
  let endTime: number | undefined;
  while (all.length < total) {
    const remaining = total - all.length;
    const limit = Math.min(1000, remaining);
    const params = new URLSearchParams({ symbol: "BTCUSDT", interval, limit: String(limit) });
    if (endTime) params.set("endTime", String(endTime));
    const res = await fetch(`${BINANCE_REST}/klines?${params.toString()}`);
    const data: any[] = await res.json();
    if (data.length === 0) break;
    const batch: Candle[] = data.map((k) => ({
      time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
      low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
    }));
    all.unshift(...batch);
    endTime = batch[0].time - 1;
    await new Promise((r) => setTimeout(r, 100));
  }
  const byTime = new Map<number, Candle>();
  for (const c of all) byTime.set(c.time, c);
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

function calcEMASeries(closes: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = ema;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

type Trend = "UP" | "DOWN" | "FLAT";
function trendAt(closes: number[], emaSeries: (number | null)[], idx: number): Trend {
  if (idx < 0 || idx >= closes.length) return "FLAT";
  const ema = emaSeries[idx];
  if (ema === null) return "FLAT";
  const diffPct = ((closes[idx] - ema) / ema) * 100;
  if (diffPct > 0.3) return "UP";
  if (diffPct < -0.3) return "DOWN";
  return "FLAT";
}

const MIN_LOOKBACK = 50;
function computeAllConditions(candles: Candle[]): { longConds: EntryConditions; shortConds: EntryConditions }[] {
  const result: { longConds: EntryConditions; shortConds: EntryConditions }[] = [];
  const empty: EntryConditions = { stochExtreme: false, rsiExtreme: false, divergence: false, bollingerTouch: false, macdCross: false };
  for (let idx = 0; idx < candles.length; idx++) {
    if (idx < MIN_LOOKBACK) { result.push({ longConds: { ...empty }, shortConds: { ...empty } }); continue; }
    const closes = candles.slice(0, idx + 1).map((c) => c.close);
    const price = candles[idx].close;
    const rsi = calcRSI(closes);
    if (rsi === null) { result.push({ longConds: { ...empty }, shortConds: { ...empty } }); continue; }
    const stoch = calcStochRSI(closes);
    const macd = calcMACD(closes);
    const bb = calcBollinger(closes);
    const div = closes.length >= 44 ? detectDivergence(closes) : null;
    const prevCloses = candles.slice(0, idx).map((c) => c.close);
    const prevMacd = prevCloses.length >= 35 ? calcMACD(prevCloses) : null;
    const longConds: EntryConditions = {
      stochExtreme: stoch.k !== null && stoch.k < 5,
      rsiExtreme: rsi < 25,
      divergence: div === "BULLISH_DIV",
      bollingerTouch: bb.lower !== null && price <= bb.lower,
      macdCross: macd.histogram !== null && prevMacd !== null && prevMacd.histogram !== null && (
        (prevMacd.histogram < 0 && macd.histogram >= 0) || (macd.histogram > prevMacd.histogram)
      ),
    };
    const shortConds: EntryConditions = {
      stochExtreme: stoch.k !== null && stoch.k > 95,
      rsiExtreme: rsi > 75,
      divergence: div === "BEARISH_DIV",
      bollingerTouch: bb.upper !== null && price >= bb.upper,
      macdCross: macd.histogram !== null && prevMacd !== null && prevMacd.histogram !== null && (
        (prevMacd.histogram > 0 && macd.histogram <= 0) || (macd.histogram < prevMacd.histogram)
      ),
    };
    result.push({ longConds, shortConds });
    if (idx % 1000 === 0) process.stdout.write(`  conds ${idx}/${candles.length}\r`);
  }
  return result;
}

interface SimResult { outcome: "WIN" | "LOSS" | "TIMEOUT"; holdBars: number; }

function simulateOutcome(idx: number, candles: Candle[], side: "LONG" | "SHORT", tp: number, sl: number): SimResult {
  const entry = candles[idx].close;
  const maxIdx = Math.min(idx + argBars, candles.length - 1);
  for (let i = idx + 1; i <= maxIdx; i++) {
    const c = candles[i];
    const highPct = ((c.high - entry) / entry) * 100;
    const lowPct = ((c.low - entry) / entry) * 100;
    if (side === "LONG") {
      if (lowPct <= -sl) return { outcome: "LOSS", holdBars: i - idx };
      if (highPct >= tp) return { outcome: "WIN", holdBars: i - idx };
    } else {
      if (highPct >= sl) return { outcome: "LOSS", holdBars: i - idx };
      if (-lowPct >= tp) return { outcome: "WIN", holdBars: i - idx };
    }
  }
  return { outcome: "TIMEOUT", holdBars: maxIdx - idx };
}

interface ScanResult {
  side: "LONG" | "SHORT";
  conditionLabel: string;
  conditionKeys: string[];
  htfFilter: "none" | "near_match" | "far_match" | "both_match";
  htfFilterLabel: string;
  tp: number;
  sl: number;
  fires: number;
  wins: number;
  losses: number;
  timeouts: number;
  realWR: number;
  grossPnL: number;
  feeCost: number;
  netPnL: number;
  avgHoldBars: number;
}

async function main() {
  console.log(`Fetching ${argCandles} ${argTF} candles...`);
  const candles = await fetchKlines(argTF, argCandles);
  console.log(`Got ${candles.length} ${argTF} candles`);

  // HTF data
  const intervalMin: Record<string, number> = { "5m": 5, "15m": 15, "1h": 60, "4h": 240, "1d": 1440, "1w": 10080 };
  const ratioNear = intervalMin[HTF_NEAR] / intervalMin[argTF];
  const ratioFar = intervalMin[HTF_FAR] / intervalMin[argTF];
  const nNear = Math.ceil(argCandles / ratioNear) + 100;
  const nFar = Math.ceil(argCandles / ratioFar) + 50;

  console.log(`Fetching ${nNear} ${HTF_NEAR} candles...`);
  const candlesNear = await fetchKlines(HTF_NEAR, nNear);
  console.log(`Fetching ${nFar} ${HTF_FAR} candles...`);
  const candlesFar = await fetchKlines(HTF_FAR, nFar);
  console.log("");

  const closes = candles.map((c) => c.close);
  const closesNear = candlesNear.map((c) => c.close);
  const closesFar = candlesFar.map((c) => c.close);
  const emaNear = calcEMASeries(closesNear, 50);
  const emaFar = calcEMASeries(closesFar, 50);

  function findHTFIndex(htfCandles: Candle[], time: number): number {
    let lo = 0, hi = htfCandles.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (htfCandles[mid].time <= time) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return best;
  }

  console.log("Computing trends...");
  const trendNear: Trend[] = candles.map((c) => {
    const idx = findHTFIndex(candlesNear, c.time);
    return idx >= 0 ? trendAt(closesNear, emaNear, idx) : "FLAT";
  });
  const trendFar: Trend[] = candles.map((c) => {
    const idx = findHTFIndex(candlesFar, c.time);
    return idx >= 0 ? trendAt(closesFar, emaFar, idx) : "FLAT";
  });

  console.log("Computing 15m conditions...");
  const t0 = Date.now();
  const conds = computeAllConditions(candles);
  console.log(`\nDone conds in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Build condition groups
  type CondGroup = { label: string; keys: (keyof EntryConditions)[] };
  const groups: CondGroup[] = [];
  for (const c of COND_KEYS) groups.push({ label: COND_LABELS[c], keys: [c] });
  for (let i = 0; i < COND_KEYS.length; i++) {
    for (let j = i + 1; j < COND_KEYS.length; j++) {
      groups.push({
        label: `${COND_LABELS[COND_KEYS[i]]}+${COND_LABELS[COND_KEYS[j]]}`,
        keys: [COND_KEYS[i], COND_KEYS[j]],
      });
    }
  }

  // HTF filter modes
  type HTFMode = { id: ScanResult["htfFilter"]; label: string; check: (i: number, side: "LONG" | "SHORT") => boolean };
  const htfModes: HTFMode[] = [
    {
      id: "none", label: "không lọc",
      check: () => true,
    },
    {
      id: "near_match", label: `${HTF_NEAR} cùng chiều`,
      check: (i, side) => side === "LONG" ? trendNear[i] === "UP" : trendNear[i] === "DOWN",
    },
    {
      id: "far_match", label: `${HTF_FAR} cùng chiều`,
      check: (i, side) => side === "LONG" ? trendFar[i] === "UP" : trendFar[i] === "DOWN",
    },
    {
      id: "both_match", label: `cả ${HTF_NEAR} + ${HTF_FAR} cùng chiều`,
      check: (i, side) => side === "LONG"
        ? trendNear[i] === "UP" && trendFar[i] === "UP"
        : trendNear[i] === "DOWN" && trendFar[i] === "DOWN",
    },
  ];

  console.log("");
  console.log(`Scanning ${groups.length} condition groups × 2 sides × ${htfModes.length} HTF modes × ${TPSL_COMBOS.length} TP/SL = ${groups.length * 2 * htfModes.length * TPSL_COMBOS.length} combos...`);

  const allResults: ScanResult[] = [];

  for (const grp of groups) {
    for (const side of ["LONG", "SHORT"] as const) {
      // Indices where this condition fires
      const baseIndices: number[] = [];
      for (let i = MIN_LOOKBACK; i < candles.length - argBars; i++) {
        const c = side === "LONG" ? conds[i].longConds : conds[i].shortConds;
        if (grp.keys.every((k) => c[k])) baseIndices.push(i);
      }
      if (baseIndices.length < 5) continue;

      for (const htf of htfModes) {
        const filtered = baseIndices.filter((i) => htf.check(i, side));
        if (filtered.length < 5) continue;

        for (const [tp, sl] of TPSL_COMBOS) {
          let wins = 0, losses = 0, timeouts = 0, sumHold = 0;
          for (const i of filtered) {
            const sim = simulateOutcome(i, candles, side, tp, sl);
            if (sim.outcome === "WIN") wins++;
            else if (sim.outcome === "LOSS") losses++;
            else timeouts++;
            sumHold += sim.holdBars;
          }
          const total = wins + losses + timeouts;
          const wlOnly = wins + losses;
          const realWR = wlOnly > 0 ? Math.round((wins / wlOnly) * 1000) / 10 : 0;
          const grossPnL = (wins * tp - losses * sl) * argLeverage;
          const feeCost = total * FEE_PNL_PER_TRADE;
          const avgHoldBars = total > 0 ? Math.round((sumHold / total) * 10) / 10 : 0;
          allResults.push({
            side, conditionLabel: grp.label, conditionKeys: grp.keys,
            htfFilter: htf.id, htfFilterLabel: htf.label,
            tp, sl, fires: total, wins, losses, timeouts, realWR,
            grossPnL: Math.round(grossPnL),
            feeCost: Math.round(feeCost),
            netPnL: Math.round(grossPnL - feeCost),
            avgHoldBars,
          });
        }
      }
    }
  }

  // Sort by NET PnL
  allResults.sort((a, b) => b.netPnL - a.netPnL);
  const profitable = allResults.filter((r) => r.netPnL > 0);

  console.log("");
  console.log(`============= TOP 30 (NET PnL > 0) =============`);
  console.log(`Tổng combo lời: ${profitable.length}/${allResults.length}`);
  console.log("");
  console.log("Side   Condition          HTF Filter                Fires  WR     Gross   Fee     NET");
  console.log("─".repeat(115));
  for (const r of allResults.slice(0, 30)) {
    if (r.netPnL <= 0) break;
    console.log(
      `${r.side.padEnd(6)} ${r.conditionLabel.padEnd(18)} ${r.htfFilterLabel.padEnd(24)} ${String(r.fires).padStart(5)}  ${String(r.realWR).padStart(5)}%  ${(r.grossPnL >= 0 ? "+" : "") + r.grossPnL.toString().padStart(6)}%  -${String(r.feeCost).padStart(5)}%  ${(r.netPnL >= 0 ? "+" : "") + r.netPnL.toString().padStart(6)}% TP+${r.tp}/SL-${r.sl}`
    );
  }

  console.log("");
  console.log(`============= BREAKDOWN BY HTF FILTER =============`);
  for (const htf of htfModes) {
    const subset = profitable.filter((r) => r.htfFilter === htf.id);
    const best = subset[0];
    console.log(`${htf.label.padEnd(36)} : ${subset.length} combo lời${best ? ` · best NET +${best.netPnL}% (${best.side} ${best.conditionLabel} TP+${best.tp}/SL-${best.sl}, ${best.fires}L, WR ${best.realWR}%)` : ""}`);
  }

  // Output JSON
  const outDir = join(__dirname, "..", "assets");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `scan_tpsl_htf_${argTF}.json`);
  writeFileSync(outPath, JSON.stringify({
    tf: argTF, htfNear: HTF_NEAR, htfFar: HTF_FAR,
    leverage: argLeverage, feePerSide: argFee,
    candlesAnalyzed: candles.length,
    period: { from: new Date(candles[0].time).toISOString(), to: new Date(candles[candles.length - 1].time).toISOString() },
    profitable: profitable.length,
    total: allResults.length,
    topResults: allResults.slice(0, 100),
  }, null, 2));
  console.log("");
  console.log(`✅ Wrote ${outPath}`);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
