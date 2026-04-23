/**
 * forward-test-top-rules.ts
 *
 * Forward test 3 top LONG rules trên 20K candles 1h BTCUSDT (~2.3Y)
 * TP +5% / SL -2% / maxHold 100h / fee 0.05% × 2 side
 *
 * Rules:
 *   R1: macd:0..50 + ema:±0.5% + htf:FLAT      (Golden #1 hiện tại, claim WR 95.2%)
 *   R2: macd:0..50 + atr:<0.3% + htf:FLAT      (MISSING, claim WR 94.1%)
 *   R3: ema:±0.5% + atr:<0.3% + htf:FLAT       (Golden #2 hiện tại, claim WR 93.1%)
 *
 * Output: console bảng so sánh WR / N / PF / Expectancy
 *          + assets/forward_test_top_rules.json
 */

import { writeFileSync } from "fs";
import { join } from "path";
import {
  calcRSISeriesAligned,
  calcMACDSeries,
  calcEMASeries,
} from "../utils/indicators";

const BINANCE = "https://api.binance.com/api/v3";
const args = process.argv.slice(2);
const getArg = (k: string, d: string) => {
  const a = args.find((x) => x.startsWith(`--${k}=`));
  return a ? a.split("=")[1] : d;
};
const CANDLES_1H = parseInt(getArg("candles", "20000"), 10);
const TP_PCT = 5;
const SL_PCT = 2;
const MAX_HOLD = 100;
const FEE = 0.05; // per side

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

async function fetchKlines(interval: string, total: number): Promise<Candle[]> {
  const all: Candle[] = [];
  let endTime: number | undefined;
  while (all.length < total) {
    const limit = Math.min(1000, total - all.length);
    const params = new URLSearchParams({ symbol: "BTCUSDT", interval, limit: String(limit) });
    if (endTime) params.set("endTime", String(endTime));
    const res = await fetch(`${BINANCE}/klines?${params}`);
    const data: any[] = await res.json();
    if (!data.length) break;
    const batch = data.map((k) => ({
      time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
    }));
    all.unshift(...batch);
    endTime = batch[0].time - 1;
    await new Promise((r) => setTimeout(r, 80));
  }
  const m = new Map<number, Candle>();
  for (const c of all) m.set(c.time, c);
  return [...m.values()].sort((a, b) => a.time - b.time);
}

function calcATRPctSeries(c: Candle[], period = 14): (number | null)[] {
  const n = c.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (n < period + 1) return out;
  const trs: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i === 0) trs.push(c[i].high - c[i].low);
    else trs.push(Math.max(
      c[i].high - c[i].low,
      Math.abs(c[i].high - c[i - 1].close),
      Math.abs(c[i].low - c[i - 1].close),
    ));
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = (atr / c[period - 1].close) * 100;
  for (let i = period; i < n; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    out[i] = (atr / c[i].close) * 100;
  }
  return out;
}

function findIndexAt(arr: Candle[], t: number): number {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].time <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function simulateLong(candles: Candle[], entryIdx: number) {
  const entryPrice = candles[entryIdx].close;
  const tpPrice = entryPrice * (1 + TP_PCT / 100);
  const slPrice = entryPrice * (1 - SL_PCT / 100);
  const endIdx = Math.min(entryIdx + MAX_HOLD, candles.length - 1);
  for (let j = entryIdx + 1; j <= endIdx; j++) {
    if (candles[j].low <= slPrice) return { rawPnl: -SL_PCT, outcome: "SL" as const, hold: j - entryIdx };
    if (candles[j].high >= tpPrice) return { rawPnl: TP_PCT, outcome: "TP" as const, hold: j - entryIdx };
  }
  const exitP = candles[endIdx].close;
  return {
    rawPnl: ((exitP - entryPrice) / entryPrice) * 100,
    outcome: "TIMEOUT" as const,
    hold: endIdx - entryIdx,
  };
}

interface Metrics {
  n: number; wins: number; losses: number; to: number;
  wr: number; sumPnl: number; avgWin: number; avgLoss: number; pf: number; exp: number;
}
function metrics(trades: { rawPnl: number; outcome: string }[]): Metrics {
  let wins = 0, losses = 0, to = 0, sumWin = 0, sumLoss = 0;
  const FEE_RT = FEE * 2;
  const pnls: number[] = [];
  for (const t of trades) {
    const pnl = t.rawPnl - FEE_RT;
    pnls.push(pnl);
    if (t.outcome === "TP") wins++; else if (t.outcome === "SL") losses++; else to++;
    if (pnl > 0) sumWin += pnl; else sumLoss += pnl;
  }
  const n = trades.length;
  const winCount = pnls.filter((p) => p > 0).length;
  const lossCount = pnls.filter((p) => p <= 0).length;
  const wr = n ? (winCount / n) * 100 : 0;
  const avgWin = winCount ? sumWin / winCount : 0;
  const avgLoss = lossCount ? sumLoss / lossCount : 0;
  const sumPnl = pnls.reduce((a, b) => a + b, 0);
  const pf = sumLoss < 0 ? sumWin / Math.abs(sumLoss) : sumWin > 0 ? 99 : 0;
  return {
    n, wins, losses, to,
    wr: +wr.toFixed(2),
    sumPnl: +sumPnl.toFixed(2),
    avgWin: +avgWin.toFixed(2),
    avgLoss: +avgLoss.toFixed(2),
    pf: +pf.toFixed(2),
    exp: +(n ? sumPnl / n : 0).toFixed(3),
  };
}

async function main() {
  console.log("═".repeat(70));
  console.log("🔬 FORWARD TEST — 3 TOP LONG RULES (TP5/SL2 100h)");
  console.log("═".repeat(70));
  console.log(`Period: ${CANDLES_1H} candles 1h (~${(CANDLES_1H / 24 / 365).toFixed(1)}Y)`);
  console.log("");

  console.log("📡 Fetching klines …");
  const [k1h, k4h] = await Promise.all([
    fetchKlines("1h", CANDLES_1H),
    fetchKlines("4h", Math.ceil(CANDLES_1H / 4) + 200),
  ]);
  console.log(`  ✓ 1h: ${k1h.length} · 4h: ${k4h.length}`);

  console.log("🧮 Computing indicators …");
  const closes1h = k1h.map((c) => c.close);
  const closes4h = k4h.map((c) => c.close);
  const rsi1h = calcRSISeriesAligned(closes1h, 14);
  const macd1h = calcMACDSeries(closes1h, 12, 26, 9);
  const ema50_1h = calcEMASeries(closes1h, 50);
  const ema50_4h = calcEMASeries(closes4h, 50);
  const atr1h = calcATRPctSeries(k1h, 14);

  console.log("🔎 Scanning entries …");
  const startIdx = 100;
  const endIdx = k1h.length - MAX_HOLD - 1;

  const hits = { R1: [] as any[], R2: [] as any[], R3: [] as any[] };
  const intersect = { all3: [] as any[] };

  // Regime tally
  let rUp = 0, rDn = 0, rFl = 0;

  for (let i = startIdx; i <= endIdx; i++) {
    const rsi = rsi1h[i];
    const macdH = macd1h.histogram[i];
    const ema1hV = ema50_1h[i];
    const atr1hV = atr1h[i];
    if (rsi === null || macdH === null || ema1hV === null || atr1hV === null) continue;

    const close = k1h[i].close;
    const emaDist1h = ((close - ema1hV) / ema1hV) * 100;

    const idx4h = findIndexAt(k4h, k1h[i].time);
    if (idx4h < 0) continue;
    const ema4hV = ema50_4h[idx4h];
    if (ema4hV === null) continue;
    const emaDist4h = ((k4h[idx4h].close - ema4hV) / ema4hV) * 100;
    let htf: "UP" | "DOWN" | "FLAT";
    if (emaDist4h > 0.5) htf = "UP";
    else if (emaDist4h < -0.5) htf = "DOWN";
    else htf = "FLAT";
    if (htf === "UP") rUp++; else if (htf === "DOWN") rDn++; else rFl++;

    // Rule predicates
    const macdBullWeak = macdH >= 0 && macdH <= 50;
    const emaNear = Math.abs(emaDist1h) <= 0.5;
    const atrLow = atr1hV < 0.3;
    const htfFlat = htf === "FLAT";

    const sim = simulateLong(k1h, i);
    const row = { i, time: k1h[i].time, rsi, macdH, emaDist1h, atr1hV, htf, ...sim };

    if (macdBullWeak && emaNear && htfFlat) hits.R1.push(row);
    if (macdBullWeak && atrLow && htfFlat) hits.R2.push(row);
    if (emaNear && atrLow && htfFlat) hits.R3.push(row);
    if (macdBullWeak && emaNear && atrLow && htfFlat) intersect.all3.push(row);
  }

  const mR1 = metrics(hits.R1);
  const mR2 = metrics(hits.R2);
  const mR3 = metrics(hits.R3);
  const mAll = metrics(intersect.all3);

  console.log("");
  console.log("🌐 Regime: UP " + ((rUp/(rUp+rDn+rFl))*100).toFixed(1) + "% · DOWN " + ((rDn/(rUp+rDn+rFl))*100).toFixed(1) + "% · FLAT " + ((rFl/(rUp+rDn+rFl))*100).toFixed(1) + "%");
  console.log("");
  console.log("┌─────────────────────────────────────────────┬───────┬────────┬────────┬──────────┬──────────┬────────┬────────┐");
  console.log("│ Rule                                        │   N   │  WR %  │ Sum %  │ AvgWin % │ AvgLoss %│   PF   │  Exp % │");
  console.log("├─────────────────────────────────────────────┼───────┼────────┼────────┼──────────┼──────────┼────────┼────────┤");
  const row = (name: string, m: Metrics) =>
    `│ ${name.padEnd(43)} │ ${String(m.n).padStart(5)} │ ${m.wr.toFixed(2).padStart(6)} │ ${m.sumPnl.toFixed(2).padStart(6)} │ ${m.avgWin.toFixed(2).padStart(8)} │ ${m.avgLoss.toFixed(2).padStart(8)} │ ${m.pf.toFixed(2).padStart(6)} │ ${m.exp.toFixed(3).padStart(6)} │`;
  console.log(row("R1: macd:0..50 + ema:±0.5% + htf:FLAT", mR1));
  console.log(row("R2: macd:0..50 + atr:<0.3% + htf:FLAT", mR2));
  console.log(row("R3: ema:±0.5% + atr:<0.3% + htf:FLAT", mR3));
  console.log(row("ALL3: macd + ema + atr + htf:FLAT", mAll));
  console.log("└─────────────────────────────────────────────┴───────┴────────┴────────┴──────────┴──────────┴────────┴────────┘");

  // Sample winners & losers
  console.log("");
  console.log("🏆 R2 sample (top 5 mới nhất):");
  const r2Recent = hits.R2.slice(-5);
  for (const t of r2Recent) {
    const dt = new Date(t.time).toISOString().slice(0, 16);
    console.log(`  ${dt}  macd=${t.macdH.toFixed(1)}  atr=${t.atr1hV.toFixed(2)}%  → ${t.outcome} ${t.rawPnl.toFixed(2)}% in ${t.hold}h`);
  }

  const out = {
    meta: {
      candles: CANDLES_1H, tp: TP_PCT, sl: SL_PCT, maxHold: MAX_HOLD, fee: FEE,
      generatedAt: new Date().toISOString(),
    },
    regime: { up: rUp, down: rDn, flat: rFl },
    rules: {
      R1: { pred: "macd:0..50 + ema:±0.5% + htf:FLAT", claimWR: 95.2, metrics: mR1 },
      R2: { pred: "macd:0..50 + atr:<0.3% + htf:FLAT", claimWR: 94.1, metrics: mR2 },
      R3: { pred: "ema:±0.5% + atr:<0.3% + htf:FLAT",  claimWR: 93.1, metrics: mR3 },
      ALL3: { pred: "macd:0..50 + ema:±0.5% + atr:<0.3% + htf:FLAT", metrics: mAll },
    },
  };
  writeFileSync(join("assets", "forward_test_top_rules.json"), JSON.stringify(out, null, 2));
  console.log("");
  console.log("💾 Saved → assets/forward_test_top_rules.json");
  console.log("");
  console.log("═".repeat(70));
  console.log("📊 VERDICT (so sánh claim WR):");
  console.log(`  R1 claim 95.2%  → actual ${mR1.wr}%  (N=${mR1.n})  ${Math.abs(mR1.wr - 95.2) < 5 ? "✅ HOLDS" : "⚠ DIVERGE"}`);
  console.log(`  R2 claim 94.1%  → actual ${mR2.wr}%  (N=${mR2.n})  ${Math.abs(mR2.wr - 94.1) < 5 ? "✅ HOLDS" : "⚠ DIVERGE"}`);
  console.log(`  R3 claim 93.1%  → actual ${mR3.wr}%  (N=${mR3.n})  ${Math.abs(mR3.wr - 93.1) < 5 ? "✅ HOLDS" : "⚠ DIVERGE"}`);
  console.log("═".repeat(70));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
