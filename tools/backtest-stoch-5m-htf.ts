/**
 * backtest-stoch-5m-htf.ts
 *
 * Variant của backtest-stoch-5m.ts + HTF Trend Filter (Phương án 1).
 *
 * HTF filter:
 *   - 1h EMA50, band ±0.3%
 *   - close > EMA50*(1+0.3%) → UP
 *   - close < EMA50*(1-0.3%) → DOWN
 *   - else FLAT
 *   - LONG chỉ khi trend != DOWN (UP hoặc FLAT)
 *   - SHORT chỉ khi trend != UP
 *
 * Mọi tham số khác giữ nguyên backtest gốc.
 *
 * Run: npx tsx tools/backtest-stoch-5m-htf.ts
 */
import { writeFileSync } from "fs";
import { join } from "path";
import { calcStochRSISeries, calcEMASeries } from "../utils/indicators";

const BINANCE_REST = "https://api.binance.com/api/v3";

const CANDLES_5M = 105120;
const CANDLES_15M = 35040;
const CANDLES_1H = 8760;
const TP_PCT = 4;
const SL_PCT = 2;
const STOCH_LONG = 10;
const STOCH_SHORT = 90;
const COOLDOWN_BARS = 3;
const SR_PIVOT_LOOKBACK_15M = 50;
const SR_PROXIMITY_PCT = 0.3;

// HTF filter
const HTF_EMA_PERIOD = 50;
const HTF_BAND_PCT = 0.3;

const INITIAL_CAPITAL = 1000;
const MARGIN = 30;
const LEV = 100;
const NOTIONAL = MARGIN * LEV;
const FEE_PER_SIDE = NOTIONAL * 0.0005;

interface Candle { time: number; open: number; high: number; low: number; close: number; }

async function fetchKlines(interval: string, total: number): Promise<Candle[]> {
  const all: Candle[] = [];
  let endTime: number | undefined;
  while (all.length < total) {
    const limit = Math.min(1000, total - all.length);
    const params = new URLSearchParams({ symbol: "BTCUSDT", interval, limit: String(limit) });
    if (endTime) params.set("endTime", String(endTime));
    const res = await fetch(`${BINANCE_REST}/klines?${params}`);
    const data: any[] = await res.json();
    if (!data.length) break;
    const batch: Candle[] = data.map((k) => ({
      time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4],
    }));
    all.unshift(...batch);
    endTime = batch[0].time - 1;
    process.stdout.write(`\r  ${interval}: ${all.length}/${total}...`);
    await new Promise((r) => setTimeout(r, 80));
  }
  process.stdout.write("\n");
  const map = new Map<number, Candle>();
  for (const c of all) map.set(c.time, c);
  return Array.from(map.values()).sort((a, b) => a.time - b.time);
}

type Source = "stoch_long" | "stoch_short" | "sr_long" | "sr_short";
type Trend = "UP" | "DOWN" | "FLAT";
interface Trade {
  entryIdx5m: number;
  entryTime: number;
  side: "LONG" | "SHORT";
  source: Source;
  htfTrend: Trend;
  entryPrice: number;
  tp: number;
  sl: number;
  exitTime: number;
  exitPrice: number;
  outcome: "WIN" | "LOSS" | "OPEN";
  pnlPctRaw: number;
  pnlUsdNet: number;
  holdBars: number;
}

(async () => {
  console.log(`\n=== BACKTEST 5m STOCH + S/R + HTF FILTER ===`);
  console.log(`HTF: 1h EMA${HTF_EMA_PERIOD}, band ±${HTF_BAND_PCT}%`);
  console.log(`LONG only if trend != DOWN, SHORT only if trend != UP\n`);

  const c5 = await fetchKlines("5m", CANDLES_5M);
  const c15 = await fetchKlines("15m", CANDLES_15M);
  const c1h = await fetchKlines("1h", CANDLES_1H);
  console.log(`5m: ${c5.length}  ·  15m: ${c15.length}  ·  1h: ${c1h.length}`);
  console.log(`Range: ${new Date(c5[0].time).toISOString()} → ${new Date(c5[c5.length-1].time).toISOString()}\n`);

  console.log(`Computing StochRSI 5m + EMA50 1h...`);
  const closes5 = c5.map((x) => x.close);
  const { kSeries } = calcStochRSISeries(closes5, 14, 14, 3, 3);
  const closes1h = c1h.map((x) => x.close);
  const ema1h = calcEMASeries(closes1h, HTF_EMA_PERIOD);

  // 15m index
  const time15Map = new Map<number, number>();
  for (let i = 0; i < c15.length; i++) time15Map.set(c15[i].time, i);
  function find15mIdx(t5m: number): number {
    const t15 = Math.floor(t5m / (15 * 60_000)) * (15 * 60_000);
    return time15Map.get(t15) ?? -1;
  }

  // 1h index
  const time1hMap = new Map<number, number>();
  for (let i = 0; i < c1h.length; i++) time1hMap.set(c1h[i].time, i);
  function find1hIdx(t5m: number): number {
    const t1h = Math.floor(t5m / (60 * 60_000)) * (60 * 60_000);
    return time1hMap.get(t1h) ?? -1;
  }

  function htfTrendAt(t5m: number, close: number): Trend {
    const idx = find1hIdx(t5m);
    if (idx < 0) return "FLAT";
    const e = ema1h[idx];
    if (e === null) return "FLAT";
    const upBand = e * (1 + HTF_BAND_PCT / 100);
    const dnBand = e * (1 - HTF_BAND_PCT / 100);
    if (close > upBand) return "UP";
    if (close < dnBand) return "DOWN";
    return "FLAT";
  }

  // Pivot S/R 15m
  console.log(`Computing S/R pivots on 15m...`);
  const support15: (number | null)[] = new Array(c15.length).fill(null);
  const resistance15: (number | null)[] = new Array(c15.length).fill(null);
  for (let i = SR_PIVOT_LOOKBACK_15M; i < c15.length; i++) {
    let lo = Infinity, hi = -Infinity;
    for (let j = i - SR_PIVOT_LOOKBACK_15M; j < i; j++) {
      if (c15[j].low < lo) lo = c15[j].low;
      if (c15[j].high > hi) hi = c15[j].high;
    }
    support15[i] = lo;
    resistance15[i] = hi;
  }

  console.log(`\nSimulating with HTF filter...`);
  const trades: Trade[] = [];
  let cooldownUntil = -1;
  let skippedByHtf = 0;

  for (let i = 0; i < c5.length - 1; i++) {
    if (i < cooldownUntil) continue;
    const k = kSeries[i];
    const close = c5[i].close;
    let side: "LONG" | "SHORT" | null = null;
    let source: Source | null = null;

    if (k !== null && k < STOCH_LONG) { side = "LONG"; source = "stoch_long"; }
    else if (k !== null && k > STOCH_SHORT) { side = "SHORT"; source = "stoch_short"; }
    else {
      const idx15 = find15mIdx(c5[i].time);
      if (idx15 >= 0) {
        const sup = support15[idx15];
        const res = resistance15[idx15];
        if (sup !== null && res !== null) {
          const distSup = ((close - sup) / sup) * 100;
          const distRes = ((res - close) / close) * 100;
          if (distSup >= 0 && distSup <= SR_PROXIMITY_PCT) { side = "LONG"; source = "sr_long"; }
          else if (distRes >= 0 && distRes <= SR_PROXIMITY_PCT) { side = "SHORT"; source = "sr_short"; }
        }
      }
    }
    if (!side || !source) continue;

    // HTF FILTER
    const trend = htfTrendAt(c5[i].time, close);
    if (side === "LONG" && trend === "DOWN") { skippedByHtf++; continue; }
    if (side === "SHORT" && trend === "UP") { skippedByHtf++; continue; }

    const entryPrice = close;
    const tp = side === "LONG" ? entryPrice * (1 + TP_PCT / 100) : entryPrice * (1 - TP_PCT / 100);
    const sl = side === "LONG" ? entryPrice * (1 - SL_PCT / 100) : entryPrice * (1 + SL_PCT / 100);
    let outcome: "WIN" | "LOSS" | "OPEN" = "OPEN";
    let exitPrice = entryPrice;
    let exitTime = c5[c5.length - 1].time;
    let exitIdx = c5.length - 1;

    for (let j = i + 1; j < c5.length; j++) {
      const b = c5[j];
      let hitTP = false, hitSL = false;
      if (side === "LONG") { hitSL = b.low <= sl; hitTP = b.high >= tp; }
      else { hitSL = b.high >= sl; hitTP = b.low <= tp; }
      if (hitTP && hitSL) { outcome = "LOSS"; exitPrice = sl; exitTime = b.time; exitIdx = j; break; }
      if (hitSL) { outcome = "LOSS"; exitPrice = sl; exitTime = b.time; exitIdx = j; break; }
      if (hitTP) { outcome = "WIN";  exitPrice = tp; exitTime = b.time; exitIdx = j; break; }
    }

    const rawPct = side === "LONG"
      ? ((exitPrice - entryPrice) / entryPrice) * 100
      : ((entryPrice - exitPrice) / entryPrice) * 100;
    let grossUsd = MARGIN * rawPct * LEV / 100;
    if (grossUsd < -MARGIN) grossUsd = -MARGIN;
    const netUsd = grossUsd - FEE_PER_SIDE * 2;

    trades.push({
      entryIdx5m: i, entryTime: c5[i].time, side, source, htfTrend: trend,
      entryPrice, tp, sl,
      exitTime, exitPrice, outcome,
      pnlPctRaw: rawPct, pnlUsdNet: netUsd,
      holdBars: exitIdx - i,
    });
    cooldownUntil = i + COOLDOWN_BARS + 1;
  }

  const closed = trades.filter((t) => t.outcome !== "OPEN");
  const wins = closed.filter((t) => t.outcome === "WIN");
  const losses = closed.filter((t) => t.outcome === "LOSS");
  const open = trades.length - closed.length;
  const wr = closed.length ? (wins.length / closed.length) * 100 : 0;

  const bySource: Record<string, { trades: number; wins: number; losses: number; netUsd: number }> = {};
  for (const t of closed) {
    const s = t.source;
    if (!bySource[s]) bySource[s] = { trades: 0, wins: 0, losses: 0, netUsd: 0 };
    bySource[s].trades++;
    if (t.outcome === "WIN") bySource[s].wins++;
    else if (t.outcome === "LOSS") bySource[s].losses++;
    bySource[s].netUsd += t.pnlUsdNet;
  }

  const sortedByExit = [...closed].sort((a, b) => a.exitTime - b.exitTime);
  let cap = INITIAL_CAPITAL;
  const equity: { t: number; eq: number }[] = [{ t: c5[0].time, eq: cap }];
  let liquidations = 0;
  for (const t of sortedByExit) {
    cap += t.pnlUsdNet;
    if (t.pnlUsdNet <= -MARGIN) liquidations++;
    equity.push({ t: t.exitTime, eq: cap });
  }
  const peak = equity.reduce((m, p) => Math.max(m, p.eq), -Infinity);
  let maxDD = 0;
  let runPeak = -Infinity;
  for (const p of equity) {
    runPeak = Math.max(runPeak, p.eq);
    const dd = runPeak - p.eq;
    if (dd > maxDD) maxDD = dd;
  }

  const totalNet = sortedByExit.reduce((s, t) => s + t.pnlUsdNet, 0);
  const totalFees = closed.length * FEE_PER_SIDE * 2;
  const grossWinUsd = wins.reduce((s, t) => s + t.pnlUsdNet, 0);
  const grossLossUsd = Math.abs(losses.reduce((s, t) => s + t.pnlUsdNet, 0));
  const pf = grossLossUsd > 0 ? grossWinUsd / grossLossUsd : Infinity;
  const avgHold5m = closed.length ? closed.reduce((s, t) => s + t.holdBars, 0) / closed.length : 0;

  console.log(`\n=== RESULTS (HTF FILTER) ===`);
  console.log(`Trades: ${trades.length} (closed ${closed.length}, open ${open})`);
  console.log(`Skipped by HTF filter: ${skippedByHtf}`);
  console.log(`WR: ${wr.toFixed(2)}%  Final: $${cap.toFixed(2)}  ROI: ${((cap-INITIAL_CAPITAL)/INITIAL_CAPITAL*100).toFixed(2)}%`);
  console.log(`Net: $${totalNet.toFixed(2)}  PF: ${pf.toFixed(2)}  MaxDD: $${maxDD.toFixed(2)}  Liq: ${liquidations}`);

  const ds = downsample(equity, 800);

  const out = {
    generated_at: new Date().toISOString(),
    variant: "htf_filter",
    config: {
      tf: "5m", years: 1, capital: INITIAL_CAPITAL, margin: MARGIN, leverage: LEV,
      tpPct: TP_PCT, slPct: SL_PCT, stochLong: STOCH_LONG, stochShort: STOCH_SHORT,
      cooldownBars: COOLDOWN_BARS, srPivotLookback15m: SR_PIVOT_LOOKBACK_15M, srProximityPct: SR_PROXIMITY_PCT,
      feePerSidePct: 0.05,
      htfEmaPeriod: HTF_EMA_PERIOD, htfBandPct: HTF_BAND_PCT,
    },
    range: { from: c5[0].time, to: c5[c5.length-1].time },
    summary: {
      totalTrades: trades.length, closed: closed.length, open,
      wins: wins.length, losses: losses.length, winRate: wr,
      finalEquity: cap, roi: ((cap-INITIAL_CAPITAL)/INITIAL_CAPITAL)*100,
      netPnl: totalNet, totalFees, profitFactor: pf, maxDrawdownUsd: maxDD,
      liquidations, avgHold5m, peakEquity: peak,
      skippedByHtf,
    },
    bySource,
    equityCurve: ds,
  };
  const outPath = join(__dirname, "..", "assets", "backtest_stoch_5m_htf.json");
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nSaved → ${outPath}`);
})();

function downsample<T>(arr: T[], maxPoints: number): T[] {
  if (arr.length <= maxPoints) return arr;
  const step = arr.length / maxPoints;
  const out: T[] = [];
  for (let i = 0; i < maxPoints; i++) out.push(arr[Math.floor(i * step)]);
  out.push(arr[arr.length - 1]);
  return out;
}
