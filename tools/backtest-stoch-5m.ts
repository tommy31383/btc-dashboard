/**
 * backtest-stoch-5m.ts
 *
 * Spec (anh Tommy):
 *   - 5m, 1 năm, mỗi cây nến đóng → quyết định
 *   - StochRSI 5m K (14,14,3,3): K<10 → LONG, K>90 → SHORT
 *   - Else fallback S/R 15m: gần support (<=0.3%) → LONG, gần resistance → SHORT, else skip
 *   - SL -2% / TP +4% (raw price)
 *   - Capital $1000, margin $30 × 100x = notional $3000, fee 0.05%/side ($1.5/side)
 *   - Cooldown sau entry: skip 3 cây 5m kế tiếp (15 phút)
 *   - Vào song song nhiều lệnh, không cần chờ TP/SL trước
 *
 * Run:
 *   npx tsx tools/backtest-stoch-5m.ts
 */
import { writeFileSync } from "fs";
import { join } from "path";
import { calcStochRSISeries } from "../utils/indicators";

const BINANCE_REST = "https://api.binance.com/api/v3";

const CANDLES_5M = 105120;   // 1 năm 5m (12 × 24 × 365)
const CANDLES_15M = 35040;   // 1 năm 15m
const TP_PCT = 4;            // raw
const SL_PCT = 2;            // raw
const STOCH_LONG = 10;
const STOCH_SHORT = 90;
const COOLDOWN_BARS = 3;     // 3 × 5m = 15 phút
const SR_PIVOT_LOOKBACK_15M = 50;  // 50 × 15m = 12.5h
const SR_PROXIMITY_PCT = 0.3;      // close ≤ 0.3% of S/R level

const INITIAL_CAPITAL = 1000;
const MARGIN = 30;
const LEV = 100;
const NOTIONAL = MARGIN * LEV;
const FEE_PER_SIDE = NOTIONAL * 0.0005;  // = $1.5

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
interface Trade {
  entryIdx5m: number;
  entryTime: number;
  side: "LONG" | "SHORT";
  source: Source;
  entryPrice: number;
  tp: number;
  sl: number;
  exitTime: number;
  exitPrice: number;
  outcome: "WIN" | "LOSS" | "OPEN";
  pnlPctRaw: number;
  pnlUsdNet: number;       // gross − 2× fee
  holdBars: number;
}

(async () => {
  console.log(`\n=== BACKTEST 5m STOCH + S/R FALLBACK ===`);
  console.log(`Capital=$${INITIAL_CAPITAL}  margin=$${MARGIN}×${LEV}x  TP=+${TP_PCT}%/SL=-${SL_PCT}%`);
  console.log(`Stoch K<${STOCH_LONG}→LONG  K>${STOCH_SHORT}→SHORT  cooldown=${COOLDOWN_BARS} bars (15m)`);
  console.log(`S/R fallback: pivot ${SR_PIVOT_LOOKBACK_15M}×15m, proximity ≤${SR_PROXIMITY_PCT}%\n`);

  const c5 = await fetchKlines("5m", CANDLES_5M);
  const c15 = await fetchKlines("15m", CANDLES_15M);
  console.log(`5m: ${c5.length} bars  ·  15m: ${c15.length} bars`);
  console.log(`Range: ${new Date(c5[0].time).toISOString()} → ${new Date(c5[c5.length-1].time).toISOString()}\n`);

  // ── StochRSI K trên 5m closes ──
  console.log(`Computing StochRSI(14,14,3,3) on 5m...`);
  const closes5 = c5.map((x) => x.close);
  const { kSeries } = calcStochRSISeries(closes5, 14, 14, 3, 3);

  // ── Index lookup: cho mỗi 5m bar, tìm 15m bar nó nằm trong ──
  // 15m bar covers [t, t+15m). 5m bar at time T thuộc 15m bar có time = floor(T/15m)*15m.
  console.log(`Building 15m index map...`);
  const time15Map = new Map<number, number>();
  for (let i = 0; i < c15.length; i++) time15Map.set(c15[i].time, i);

  function find15mIdx(t5m: number): number {
    const t15 = Math.floor(t5m / (15 * 60_000)) * (15 * 60_000);
    return time15Map.get(t15) ?? -1;
  }

  // ── Pivot S/R rolling 15m: cho mỗi 15m bar, support = min low của 50 cây trước, resistance = max high ──
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

  // ── Iterate 5m bars: decide entry ──
  console.log(`\nSimulating...`);
  const trades: Trade[] = [];
  let cooldownUntil = -1;

  for (let i = 0; i < c5.length - 1; i++) {
    if (i < cooldownUntil) continue;
    const k = kSeries[i];
    const close = c5[i].close;
    let side: "LONG" | "SHORT" | null = null;
    let source: Source | null = null;

    if (k !== null && k < STOCH_LONG) { side = "LONG"; source = "stoch_long"; }
    else if (k !== null && k > STOCH_SHORT) { side = "SHORT"; source = "stoch_short"; }
    else {
      // Fallback S/R 15m
      const idx15 = find15mIdx(c5[i].time);
      if (idx15 >= 0) {
        const sup = support15[idx15];
        const res = resistance15[idx15];
        if (sup !== null && res !== null) {
          const distSup = ((close - sup) / sup) * 100;   // % above support
          const distRes = ((res - close) / close) * 100; // % below resistance
          if (distSup >= 0 && distSup <= SR_PROXIMITY_PCT) { side = "LONG"; source = "sr_long"; }
          else if (distRes >= 0 && distRes <= SR_PROXIMITY_PCT) { side = "SHORT"; source = "sr_short"; }
        }
      }
    }
    if (!side || !source) continue;

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
      entryIdx5m: i, entryTime: c5[i].time, side, source,
      entryPrice, tp, sl,
      exitTime, exitPrice, outcome,
      pnlPctRaw: rawPct, pnlUsdNet: netUsd,
      holdBars: exitIdx - i,
    });
    cooldownUntil = i + COOLDOWN_BARS + 1;
  }

  // ── Stats ──
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

  // ── Account sim chronological: capital starts $1000, fee per entry/exit, parallel positions ──
  // Do trades đã vào song song (không lock margin), ta cộng dồn theo exit chronological.
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

  console.log(`\n=== RESULTS ===`);
  console.log(`Trades: ${trades.length} (closed ${closed.length}, open ${open})`);
  console.log(`Wins: ${wins.length}  Losses: ${losses.length}  WR: ${wr.toFixed(2)}%`);
  console.log(`Final equity: $${cap.toFixed(2)}  ROI: ${((cap-INITIAL_CAPITAL)/INITIAL_CAPITAL*100).toFixed(2)}%`);
  console.log(`Net PnL: $${totalNet.toFixed(2)}  Fees: $${totalFees.toFixed(2)}  PF: ${pf.toFixed(2)}`);
  console.log(`Max DD: $${maxDD.toFixed(2)}  Liquidations: ${liquidations}`);
  console.log(`Avg hold: ${avgHold5m.toFixed(1)} × 5m = ${(avgHold5m*5).toFixed(0)} phút`);
  console.log(`\nBy source:`);
  for (const [s, v] of Object.entries(bySource)) {
    const w = v.trades ? (v.wins / v.trades * 100).toFixed(1) : "0";
    console.log(`  ${s.padEnd(12)} trades=${String(v.trades).padStart(5)}  WR=${w.padStart(5)}%  net=$${v.netUsd.toFixed(0)}`);
  }

  // ── Downsample equity for chart ──
  const ds = downsample(equity, 800);

  const out = {
    generated_at: new Date().toISOString(),
    config: {
      tf: "5m", years: 1, capital: INITIAL_CAPITAL, margin: MARGIN, leverage: LEV,
      tpPct: TP_PCT, slPct: SL_PCT, stochLong: STOCH_LONG, stochShort: STOCH_SHORT,
      cooldownBars: COOLDOWN_BARS, srPivotLookback15m: SR_PIVOT_LOOKBACK_15M, srProximityPct: SR_PROXIMITY_PCT,
      feePerSidePct: 0.05,
    },
    range: { from: c5[0].time, to: c5[c5.length-1].time },
    summary: {
      totalTrades: trades.length, closed: closed.length, open,
      wins: wins.length, losses: losses.length, winRate: wr,
      finalEquity: cap, roi: ((cap-INITIAL_CAPITAL)/INITIAL_CAPITAL)*100,
      netPnl: totalNet, totalFees, profitFactor: pf, maxDrawdownUsd: maxDD,
      liquidations, avgHold5m, peakEquity: peak,
    },
    bySource,
    equityCurve: ds,
  };
  const outPath = join(__dirname, "..", "assets", "backtest_stoch_5m.json");
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
