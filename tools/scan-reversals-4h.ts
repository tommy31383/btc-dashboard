/**
 * scan-reversals-4h.ts
 *
 * Tommy task:
 *   - Quét 4h, tìm tất cả điểm đảo chiều (cây trước + cây sau ngược màu)
 *   - Tách 2 nhóm: QUAY ĐẦU TĂNG (đỏ→xanh) và QUAY ĐẦU GIẢM (xanh→đỏ)
 *   - Tại mỗi reversal, snapshot indicator trên 1H / 4H / 6H ở T-1, T-2, T-3
 *   - Backtest entry = close của cây đảo, với các combo TP/SL × lev 10x
 *   - Rank theo NET, xuất rule chất lượng cao (sample size > threshold)
 *
 * Usage:
 *   npx tsx tools/scan-reversals-4h.ts --candles=10000 --lev=10 --fee=0.04
 */

import { writeFileSync } from "fs";
import { join } from "path";
import { calcRSI, calcMACD, calcEMASeries, calcRSISeriesAligned, calcMACDSeries, calcBollingerSeries } from "../utils/indicators";

const BINANCE = "https://api.binance.com/api/v3";

const args = process.argv.slice(2);
const getArg = (k: string, d: string) => { const a = args.find(x => x.startsWith(`--${k}=`)); return a ? a.split("=")[1] : d; };
const CANDLES_4H = parseInt(getArg("candles", "6000"), 10); // ~2.7 năm
const LEV = parseFloat(getArg("lev", "10"));
const FEE = parseFloat(getArg("fee", "0.04"));
const FEE_PNL = FEE * 2 * LEV; // round-trip fee in PnL %

interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number; }

async function fetchKlines(interval: string, total: number): Promise<Candle[]> {
  const all: Candle[] = []; let endTime: number | undefined;
  while (all.length < total) {
    const limit = Math.min(1000, total - all.length);
    const params = new URLSearchParams({ symbol: "BTCUSDT", interval, limit: String(limit) });
    if (endTime) params.set("endTime", String(endTime));
    const res = await fetch(`${BINANCE}/klines?${params}`);
    const data: any[] = await res.json();
    if (!data.length) break;
    const batch = data.map(k => ({ time:k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5] }));
    all.unshift(...batch);
    endTime = batch[0].time - 1;
    await new Promise(r => setTimeout(r, 80));
  }
  const m = new Map<number, Candle>(); for (const c of all) m.set(c.time, c);
  return [...m.values()].sort((a,b) => a.time - b.time);
}

// Body & wick features
function candleFeatures(c: Candle) {
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low || 1e-9;
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const bullish = c.close >= c.open;
  return {
    bullish,
    bodyPct: (body / c.open) * 100,
    bodyRatio: body / range,
    upperWickRatio: upperWick / range,
    lowerWickRatio: lowerWick / range,
  };
}

// Find index in arr whose time <= targetTime (latest closed candle at that moment)
function findTFIndexAt(arr: Candle[], targetTime: number): number {
  // binary search
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].time <= targetTime) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

// Simulate outcome: entry at entryPrice, side LONG/SHORT, TP/SL %, max hold N bars
function simulate(c4h: Candle[], entryIdx: number, entryPrice: number, side: "LONG"|"SHORT", tpPct: number, slPct: number, maxHold = 50) {
  const tpAbs = side === "LONG" ? entryPrice * (1 + tpPct/100) : entryPrice * (1 - tpPct/100);
  const slAbs = side === "LONG" ? entryPrice * (1 - slPct/100) : entryPrice * (1 + slPct/100);
  for (let i = entryIdx + 1; i < Math.min(entryIdx + 1 + maxHold, c4h.length); i++) {
    const cd = c4h[i];
    if (side === "LONG") {
      if (cd.low <= slAbs) return { outcome: "LOSS" as const, holdBars: i - entryIdx };
      if (cd.high >= tpAbs) return { outcome: "WIN" as const, holdBars: i - entryIdx };
    } else {
      if (cd.high >= slAbs) return { outcome: "LOSS" as const, holdBars: i - entryIdx };
      if (cd.low <= tpAbs) return { outcome: "WIN" as const, holdBars: i - entryIdx };
    }
  }
  return { outcome: "TIMEOUT" as const, holdBars: maxHold };
}

(async () => {
  console.log(`=== scan-reversals-4h ===`);
  console.log(`Fetching klines: 4h × ${CANDLES_4H}, 1h × ${CANDLES_4H * 4}, 6h × ${Math.ceil(CANDLES_4H * 4 / 6)}`);

  const [c4h, c1h, c6h] = await Promise.all([
    fetchKlines("4h", CANDLES_4H),
    fetchKlines("1h", CANDLES_4H * 4),
    fetchKlines("6h", Math.ceil(CANDLES_4H * 4 / 6) + 200),
  ]);
  console.log(`Got: 4h=${c4h.length} 1h=${c1h.length} 6h=${c6h.length}`);

  // Pre-compute indicator series on each TF
  const closes4h = c4h.map(x => x.close);
  const closes1h = c1h.map(x => x.close);
  const closes6h = c6h.map(x => x.close);
  const ema50_4h = calcEMASeries(closes4h, 50);
  const ema50_1h = calcEMASeries(closes1h, 50);
  const ema50_6h = calcEMASeries(closes6h, 50);
  const rsi4h = calcRSISeriesAligned(closes4h, 14);
  const rsi1h = calcRSISeriesAligned(closes1h, 14);
  const rsi6h = calcRSISeriesAligned(closes6h, 14);
  const macd4h_ = calcMACDSeries(closes4h);
  const macd1h_ = calcMACDSeries(closes1h);
  const macd6h_ = calcMACDSeries(closes6h);
  const bb4h_ = calcBollingerSeries(closes4h, 20, 2);
  const bb1h_ = calcBollingerSeries(closes1h, 20, 2);
  const getMacdHist = (m: any, i: number) => (i>=0 && i<m.histogram.length) ? m.histogram[i] : null;
  const getBB = (b: any, i: number) => (i>=0 && i<b.upper.length && b.upper[i]!=null) ? { upper: b.upper[i], lower: b.lower[i], middle: b.middle[i] } : null;

  // Detect reversal points on 4h
  interface Reversal {
    idx: number; time: number;
    type: "UP" | "DOWN";         // UP = red→green (long signal), DOWN = green→red (short signal)
    entryPrice: number;
    prev: ReturnType<typeof candleFeatures>;
    curr: ReturnType<typeof candleFeatures>;
    // Snapshot at T-1 (closed before reversal candle)
    ind: {
      rsi4h: number | null; rsi1h: number | null; rsi6h: number | null;
      macdHist4h: number | null; macdHist1h: number | null; macdHist6h: number | null;
      emaPos4h: "ABOVE" | "BELOW" | "NA"; emaPos1h: "ABOVE" | "BELOW" | "NA"; emaPos6h: "ABOVE" | "BELOW" | "NA";
      bbPos4h: "UPPER" | "LOWER" | "MID" | "NA"; bbPos1h: "UPPER" | "LOWER" | "MID" | "NA";
      priorRedRun: number; priorGreenRun: number; // số nến cùng màu liên tiếp trước
    };
  }
  const reversals: Reversal[] = [];
  for (let i = 1; i < c4h.length - 50; i++) {
    const prev = c4h[i-1], curr = c4h[i];
    const prevBull = prev.close >= prev.open;
    const currBull = curr.close >= curr.open;
    if (prevBull === currBull) continue; // cùng màu → skip
    const type = !prevBull && currBull ? "UP" : "DOWN";

    // Count prior same-color run (before the "prev" candle)
    let priorRedRun = 0, priorGreenRun = 0;
    for (let j = i - 1; j >= 0; j--) {
      const b = c4h[j].close >= c4h[j].open;
      if (!b) priorRedRun++; else break;
    }
    for (let j = i - 1; j >= 0; j--) {
      const b = c4h[j].close >= c4h[j].open;
      if (b) priorGreenRun++; else break;
    }

    // Snapshot at close of candle[i-1] (= time of prev)
    const snapshotTime = prev.time + 4 * 3600 * 1000 - 1; // close of prev candle
    const i1h = findTFIndexAt(c1h, snapshotTime);
    const i6h = findTFIndexAt(c6h, snapshotTime);

    const pos = (price: number, ema: number | null) => ema == null ? "NA" as const : (price >= ema ? "ABOVE" as const : "BELOW" as const);
    const bbPos = (price: number, bb: any) => {
      if (!bb) return "NA" as const;
      if (price >= bb.upper * 0.995) return "UPPER" as const;
      if (price <= bb.lower * 1.005) return "LOWER" as const;
      return "MID" as const;
    };

    reversals.push({
      idx: i, time: curr.time, type,
      entryPrice: curr.close,
      prev: candleFeatures(prev),
      curr: candleFeatures(curr),
      ind: {
        rsi4h: rsi4h[i-1] ?? null,
        rsi1h: i1h >= 0 ? (rsi1h[i1h] ?? null) : null,
        rsi6h: i6h >= 0 ? (rsi6h[i6h] ?? null) : null,
        macdHist4h: getMacdHist(macd4h_, i-1),
        macdHist1h: getMacdHist(macd1h_, i1h),
        macdHist6h: getMacdHist(macd6h_, i6h),
        emaPos4h: pos(prev.close, ema50_4h[i-1]),
        emaPos1h: i1h >= 0 ? pos(c1h[i1h].close, ema50_1h[i1h]) : "NA",
        emaPos6h: i6h >= 0 ? pos(c6h[i6h].close, ema50_6h[i6h]) : "NA",
        bbPos4h: bbPos(prev.close, getBB(bb4h_, i-1)),
        bbPos1h: i1h >= 0 ? bbPos(c1h[i1h].close, getBB(bb1h_, i1h)) : "NA",
        priorRedRun, priorGreenRun,
      }
    });
  }

  const ups = reversals.filter(r => r.type === "UP");
  const downs = reversals.filter(r => r.type === "DOWN");
  console.log(`Reversals: ${reversals.length} (UP=${ups.length}, DOWN=${downs.length})`);

  // Backtest combos
  const TPSL_COMBOS = [
    { tp: 1, sl: 0.5 }, { tp: 2, sl: 1 }, { tp: 3, sl: 1 }, { tp: 3, sl: 1.5 },
    { tp: 5, sl: 2 }, { tp: 5, sl: 3 }, { tp: 8, sl: 3 }, { tp: 10, sl: 5 },
  ];

  type FilterFn = (r: Reversal) => boolean;
  const filters: { id: string; label: string; side: "LONG"|"SHORT"; fn: FilterFn }[] = [];

  // UP reversal → LONG entries
  filters.push({ id: "UP_BASE", label: "Mọi UP reversal", side: "LONG", fn: r => r.type === "UP" });
  filters.push({ id: "UP_RSI4H_OS", label: "UP + RSI 4h < 40 (OS)", side: "LONG", fn: r => r.type==="UP" && (r.ind.rsi4h ?? 99) < 40 });
  filters.push({ id: "UP_RSI1H_OS", label: "UP + RSI 1h < 35", side: "LONG", fn: r => r.type==="UP" && (r.ind.rsi1h ?? 99) < 35 });
  filters.push({ id: "UP_BB_LOWER", label: "UP + giá chạm BB dưới 4h", side: "LONG", fn: r => r.type==="UP" && r.ind.bbPos4h === "LOWER" });
  filters.push({ id: "UP_LONG_WICK", label: "UP + prev có long lower wick (>40%)", side: "LONG", fn: r => r.type==="UP" && r.prev.lowerWickRatio > 0.4 });
  filters.push({ id: "UP_3RED_RUN", label: "UP + trước có ≥3 nến đỏ liên tiếp", side: "LONG", fn: r => r.type==="UP" && r.ind.priorRedRun >= 3 });
  filters.push({ id: "UP_BELOW_EMA50", label: "UP + giá dưới EMA50 4h", side: "LONG", fn: r => r.type==="UP" && r.ind.emaPos4h === "BELOW" });
  filters.push({ id: "UP_MACD_NEG", label: "UP + MACD hist 4h < 0", side: "LONG", fn: r => r.type==="UP" && (r.ind.macdHist4h ?? 1) < 0 });
  filters.push({ id: "UP_ABOVE_EMA50", label: "UP + giá TRÊN EMA50 4h (pullback)", side: "LONG", fn: r => r.type==="UP" && r.ind.emaPos4h === "ABOVE" });
  filters.push({ id: "UP_RSI1H_OS_3RED", label: "UP + RSI 1h<35 + ≥3 nến đỏ", side: "LONG", fn: r => r.type==="UP" && (r.ind.rsi1h ?? 99) < 35 && r.ind.priorRedRun >= 3 });
  filters.push({ id: "UP_BB_LOWER_WICK", label: "UP + BB dưới 4h + long lower wick", side: "LONG", fn: r => r.type==="UP" && r.ind.bbPos4h === "LOWER" && r.prev.lowerWickRatio > 0.3 });
  filters.push({ id: "UP_RSI4H_OS_EMA_BELOW", label: "UP + RSI 4h<40 + dưới EMA50 4h", side: "LONG", fn: r => r.type==="UP" && (r.ind.rsi4h ?? 99) < 40 && r.ind.emaPos4h === "BELOW" });

  // DOWN reversal → SHORT entries
  filters.push({ id: "DN_BASE", label: "Mọi DOWN reversal", side: "SHORT", fn: r => r.type === "DOWN" });
  filters.push({ id: "DN_RSI4H_OB", label: "DOWN + RSI 4h > 60 (OB)", side: "SHORT", fn: r => r.type==="DOWN" && (r.ind.rsi4h ?? 0) > 60 });
  filters.push({ id: "DN_RSI1H_OB", label: "DOWN + RSI 1h > 65", side: "SHORT", fn: r => r.type==="DOWN" && (r.ind.rsi1h ?? 0) > 65 });
  filters.push({ id: "DN_BB_UPPER", label: "DOWN + giá chạm BB trên 4h", side: "SHORT", fn: r => r.type==="DOWN" && r.ind.bbPos4h === "UPPER" });
  filters.push({ id: "DN_LONG_WICK", label: "DOWN + prev có long upper wick (>40%)", side: "SHORT", fn: r => r.type==="DOWN" && r.prev.upperWickRatio > 0.4 });
  filters.push({ id: "DN_3GREEN_RUN", label: "DOWN + trước có ≥3 nến xanh liên tiếp", side: "SHORT", fn: r => r.type==="DOWN" && r.ind.priorGreenRun >= 3 });
  filters.push({ id: "DN_ABOVE_EMA50", label: "DOWN + giá trên EMA50 4h", side: "SHORT", fn: r => r.type==="DOWN" && r.ind.emaPos4h === "ABOVE" });
  filters.push({ id: "DN_MACD_POS", label: "DOWN + MACD hist 4h > 0", side: "SHORT", fn: r => r.type==="DOWN" && (r.ind.macdHist4h ?? -1) > 0 });
  filters.push({ id: "DN_BELOW_EMA50", label: "DOWN + giá DƯỚI EMA50 4h (bear pullback)", side: "SHORT", fn: r => r.type==="DOWN" && r.ind.emaPos4h === "BELOW" });
  filters.push({ id: "DN_RSI1H_OB_3GREEN", label: "DOWN + RSI 1h>65 + ≥3 nến xanh", side: "SHORT", fn: r => r.type==="DOWN" && (r.ind.rsi1h ?? 0) > 65 && r.ind.priorGreenRun >= 3 });
  filters.push({ id: "DN_BB_UPPER_WICK", label: "DOWN + BB trên 4h + long upper wick", side: "SHORT", fn: r => r.type==="DOWN" && r.ind.bbPos4h === "UPPER" && r.prev.upperWickRatio > 0.3 });
  filters.push({ id: "DN_RSI4H_OB_EMA_ABOVE", label: "DOWN + RSI 4h>60 + trên EMA50 4h", side: "SHORT", fn: r => r.type==="DOWN" && (r.ind.rsi4h ?? 0) > 60 && r.ind.emaPos4h === "ABOVE" });

  interface Result {
    filterId: string; label: string; side: "LONG"|"SHORT"; samples: number;
    tp: number; sl: number;
    wins: number; losses: number; timeouts: number;
    winRate: number; netPnL: number;
    avgHoldBars: number;
  }
  const results: Result[] = [];

  for (const f of filters) {
    const matched = reversals.filter(f.fn);
    if (matched.length < 20) { // quá ít sample → skip
      continue;
    }
    for (const { tp, sl } of TPSL_COMBOS) {
      let wins = 0, losses = 0, timeouts = 0, sumHold = 0;
      for (const r of matched) {
        const out = simulate(c4h, r.idx, r.entryPrice, f.side, tp, sl);
        if (out.outcome === "WIN") wins++;
        else if (out.outcome === "LOSS") losses++;
        else timeouts++;
        sumHold += out.holdBars;
      }
      const total = wins + losses + timeouts;
      const gross = wins * tp * LEV - losses * sl * LEV;
      const fees = total * FEE_PNL;
      const net = gross - fees;
      const wr = total > 0 ? (wins / total) * 100 : 0;
      results.push({
        filterId: f.id, label: f.label, side: f.side, samples: total,
        tp, sl, wins, losses, timeouts,
        winRate: wr, netPnL: net,
        avgHoldBars: sumHold / Math.max(1, total),
      });
    }
  }

  results.sort((a, b) => b.netPnL - a.netPnL);

  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      candles4h: c4h.length,
      priceRange: { first: c4h[0]?.close, last: c4h.at(-1)?.close, min: Math.min(...closes4h), max: Math.max(...closes4h) },
      leverage: LEV,
      feePerSidePct: FEE,
    },
    counts: { total: reversals.length, up: ups.length, down: downs.length },
    topResults: results.slice(0, 40),
    allResults: results,
  };

  const outPath = join(__dirname, "..", "assets", "scan_reversals_4h.json");
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\n✅ Wrote ${outPath}`);
  console.log(`\n=== TOP 20 ===`);
  console.log("SIDE  FILTER                                        TP/SL      N     WR%    NET%");
  for (const r of results.slice(0, 20)) {
    console.log(
      `${r.side.padEnd(5)} ${r.label.padEnd(45).slice(0,45)} ${('+'+r.tp+'/-'+r.sl).padEnd(9)} ${String(r.samples).padStart(4)}  ${r.winRate.toFixed(1).padStart(5)}%  ${(r.netPnL>=0?'+':'')}${r.netPnL.toFixed(0)}%`
    );
  }
})();
