/**
 * backtest-long-all.ts
 *
 * Backtest "LONG mọi cây nến": mỗi cây nến đóng → mở 1 LONG ảo, exit khi
 * giá hit TP +5% hoặc SL -2% (raw price, no leverage). Bar đụng cả 2 → giả
 * định SL hit trước (conservative).
 *
 * Default: BTCUSDT 15m, 1 năm gần nhất (~35,040 candles).
 *
 * Usage:
 *   npx tsx tools/backtest-long-all.ts
 *   npx tsx tools/backtest-long-all.ts --tf=15m --candles=35040 --tp=5 --sl=2
 */

import { writeFileSync } from "fs";
import { join } from "path";

const BINANCE_REST = "https://api.binance.com/api/v3";

const args = process.argv.slice(2);
const TF = args.find((a) => a.startsWith("--tf="))?.replace("--tf=", "") || "15m";
const CANDLES = parseInt(args.find((a) => a.startsWith("--candles="))?.replace("--candles=", "") || "35040", 10);
const TP_PCT = parseFloat(args.find((a) => a.startsWith("--tp="))?.replace("--tp=", "") || "5");
const SL_PCT = parseFloat(args.find((a) => a.startsWith("--sl="))?.replace("--sl=", "") || "2");

interface Candle { time: number; open: number; high: number; low: number; close: number; }

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
      low: parseFloat(k[3]), close: parseFloat(k[4]),
    }));
    all.unshift(...batch);
    endTime = batch[0].time - 1;
    process.stdout.write(`\rFetched ${all.length}/${total} candles...`);
    await new Promise((r) => setTimeout(r, 100));
  }
  process.stdout.write("\n");
  const byTime = new Map<number, Candle>();
  for (const c of all) byTime.set(c.time, c);
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

interface Trade {
  entryIdx: number;
  entryTime: number;
  entryPrice: number;
  exitIdx: number;
  exitTime: number;
  exitPrice: number;
  outcome: "WIN" | "LOSS" | "OPEN";
  pnlPct: number;
  holdBars: number;
}

function simulate(candles: Candle[], tpPct: number, slPct: number): Trade[] {
  const trades: Trade[] = [];
  for (let i = 0; i < candles.length - 1; i++) {
    const entry = candles[i].close;
    const tp = entry * (1 + tpPct / 100);
    const sl = entry * (1 - slPct / 100);
    let resolved = false;
    for (let j = i + 1; j < candles.length; j++) {
      const c = candles[j];
      const hitSL = c.low <= sl;
      const hitTP = c.high >= tp;
      if (hitSL && hitTP) {
        // conservative: SL first
        trades.push({
          entryIdx: i, entryTime: candles[i].time, entryPrice: entry,
          exitIdx: j, exitTime: c.time, exitPrice: sl,
          outcome: "LOSS", pnlPct: -slPct, holdBars: j - i,
        });
        resolved = true; break;
      }
      if (hitSL) {
        trades.push({
          entryIdx: i, entryTime: candles[i].time, entryPrice: entry,
          exitIdx: j, exitTime: c.time, exitPrice: sl,
          outcome: "LOSS", pnlPct: -slPct, holdBars: j - i,
        });
        resolved = true; break;
      }
      if (hitTP) {
        trades.push({
          entryIdx: i, entryTime: candles[i].time, entryPrice: entry,
          exitIdx: j, exitTime: c.time, exitPrice: tp,
          outcome: "WIN", pnlPct: tpPct, holdBars: j - i,
        });
        resolved = true; break;
      }
    }
    if (!resolved) {
      const last = candles[candles.length - 1];
      trades.push({
        entryIdx: i, entryTime: candles[i].time, entryPrice: entry,
        exitIdx: candles.length - 1, exitTime: last.time, exitPrice: last.close,
        outcome: "OPEN", pnlPct: ((last.close - entry) / entry) * 100,
        holdBars: candles.length - 1 - i,
      });
    }
  }
  return trades;
}

function downsample(arr: number[], maxPoints: number): number[] {
  if (arr.length <= maxPoints) return arr;
  const step = arr.length / maxPoints;
  const out: number[] = [];
  for (let i = 0; i < maxPoints; i++) out.push(arr[Math.floor(i * step)]);
  out.push(arr[arr.length - 1]);
  return out;
}

(async () => {
  console.log(`\n=== LONG-ALL BACKTEST ===`);
  console.log(`TF=${TF}  candles=${CANDLES}  TP=+${TP_PCT}%  SL=-${SL_PCT}%\n`);

  const candles = await fetchKlines(TF, CANDLES);
  console.log(`Got ${candles.length} candles. Range: ${new Date(candles[0].time).toISOString()} → ${new Date(candles[candles.length-1].time).toISOString()}`);

  console.log(`\nSimulating...`);
  const trades = simulate(candles, TP_PCT, SL_PCT);

  const closed = trades.filter((t) => t.outcome !== "OPEN");
  const wins = closed.filter((t) => t.outcome === "WIN");
  const losses = closed.filter((t) => t.outcome === "LOSS");
  const open = trades.filter((t) => t.outcome === "OPEN");
  const winRate = closed.length > 0 ? (wins.length / closed.length) * 100 : 0;
  const totalPnl = closed.reduce((s, t) => s + t.pnlPct, 0);
  const avgHold = closed.length > 0 ? closed.reduce((s, t) => s + t.holdBars, 0) / closed.length : 0;
  const grossWin = wins.reduce((s, t) => s + t.pnlPct, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : Infinity;

  // Equity curve (theo trade index)
  const equity: number[] = [];
  let cum = 0;
  for (const t of closed) { cum += t.pnlPct; equity.push(cum); }
  let peak = -Infinity, maxDD = 0;
  for (const e of equity) { if (e > peak) peak = e; const dd = peak - e; if (dd > maxDD) maxDD = dd; }
  const eqDown = downsample(equity, 100);
  const trend = (() => {
    if (equity.length < 20) return "FLAT";
    const tail = equity.slice(-Math.floor(equity.length * 0.3));
    const head = equity.slice(0, Math.floor(equity.length * 0.3));
    const tailAvg = tail.reduce((s, x) => s + x, 0) / tail.length;
    const headAvg = head.reduce((s, x) => s + x, 0) / head.length;
    if (tailAvg - headAvg > Math.abs(headAvg) * 0.1) return "UP";
    if (headAvg - tailAvg > Math.abs(tailAvg) * 0.1) return "DOWN";
    return "FLAT";
  })();

  // Hold time distribution
  const holdBuckets = { "1": 0, "2-5": 0, "6-20": 0, "21-100": 0, "100+": 0 };
  for (const t of closed) {
    if (t.holdBars === 1) holdBuckets["1"]++;
    else if (t.holdBars <= 5) holdBuckets["2-5"]++;
    else if (t.holdBars <= 20) holdBuckets["6-20"]++;
    else if (t.holdBars <= 100) holdBuckets["21-100"]++;
    else holdBuckets["100+"]++;
  }

  console.log(`\n────────── RESULTS ──────────`);
  console.log(`Total trades:       ${trades.length}`);
  console.log(`Closed:             ${closed.length}  (open=${open.length})`);
  console.log(`Wins (+${TP_PCT}%):       ${wins.length}`);
  console.log(`Losses (-${SL_PCT}%):    ${losses.length}`);
  console.log(`Win rate:           ${winRate.toFixed(2)}%`);
  console.log(`Profit factor:      ${profitFactor.toFixed(2)}`);
  console.log(`Total NET PnL:      ${totalPnl.toFixed(2)}%`);
  console.log(`Avg PnL/trade:      ${(totalPnl / closed.length).toFixed(3)}%`);
  console.log(`Avg hold:           ${avgHold.toFixed(1)} bars (${(avgHold * 15 / 60).toFixed(1)}h)`);
  console.log(`Max drawdown:       -${maxDD.toFixed(2)}%`);
  console.log(`Equity trend:       ${trend}`);
  console.log(`\nHold distribution:`);
  for (const [k, v] of Object.entries(holdBuckets)) {
    const pct = closed.length > 0 ? (v / closed.length * 100).toFixed(1) : "0.0";
    console.log(`  ${k.padEnd(8)} bars: ${String(v).padStart(6)} (${pct}%)`);
  }

  // Break-even win rate analysis
  const beWR = (SL_PCT / (TP_PCT + SL_PCT)) * 100;
  console.log(`\nBreak-even win rate: ${beWR.toFixed(2)}%  (need WR > this to profit)`);
  console.log(`Edge: ${(winRate - beWR).toFixed(2)}pp ${winRate > beWR ? "✓ EDGE" : "✗ NO EDGE"}`);

  // Save
  const outPath = join(process.cwd(), `assets/backtest_long_all_${TF}.json`);
  writeFileSync(outPath, JSON.stringify({
    config: { tf: TF, candles: candles.length, tpPct: TP_PCT, slPct: SL_PCT },
    range: { from: new Date(candles[0].time).toISOString(), to: new Date(candles[candles.length-1].time).toISOString() },
    stats: {
      totalTrades: trades.length, closed: closed.length, wins: wins.length, losses: losses.length, open: open.length,
      winRate, profitFactor, totalPnlPct: totalPnl, avgHoldBars: avgHold, maxDrawdownPct: maxDD,
      equityTrend: trend, breakEvenWR: beWR, edge: winRate - beWR,
    },
    holdDistribution: holdBuckets,
    equityCurve: eqDown,
  }, null, 2));
  console.log(`\nSaved → ${outPath}`);
})();
