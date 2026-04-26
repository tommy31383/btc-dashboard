/**
 * scan-4h-features.ts
 *
 * Phương án A+C: feature-scan trên 4h với HTF=1d làm context.
 *
 * Spec-aligned:
 *   - fee 0.05%/side (round-trip 0.10%)
 *   - entry @ close
 *   - SL trước TP (pessimistic)
 *   - one-position-at-a-time (skip until trade closes)
 *   - HTF=1d UP (LONG) / DOWN (SHORT) bằng EMA50 1d
 *
 * Feature buckets per candle:
 *   rsi, macdHist, bbPct, ema50Dist, atrPct, bodyPct, candle, reversal, htf
 *
 * Quét cả LONG và SHORT. Test pair + triple combos.
 *
 * Output: assets/scan_4h_features_results.json
 */
import { writeFileSync } from "fs";
import { join } from "path";
import { calcRSISeriesAligned, calcMACDSeries, calcBollingerSeries, calcEMASeries } from "../utils/indicators";

const BINANCE = "https://api.binance.com/api/v3";
const NOW = Date.now();
const YEARS = 3;
const TP_PCT = 5;
const SL_PCT = 2.5;
const MAX_HOLD = 50;
const FEE_PER_SIDE = 0.05;
const LEV = 100;
const MIN_N = 30;
const MIN_WR_LONG = 55;
const MIN_WR_SHORT = 55;

type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };
type Outcome = "WIN" | "LOSS" | "TIMEOUT";

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
    const batch = data.map((k) => ({
      time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
    }));
    all.unshift(...batch);
    endTime = batch[0].time - 1;
    await new Promise((r) => setTimeout(r, 80));
  }
  const m = new Map<number, Candle>();
  for (const c of all) m.set(c.time, c);
  return [...m.values()].sort((a, b) => a.time - b.time);
}

function findHTFIdxAt(arr: Candle[], t: number): number {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].time <= t) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

function atrPct(c: Candle[], i: number, period = 14): number | null {
  if (i < period) return null;
  let sum = 0;
  for (let j = i - period + 1; j <= i; j++) {
    const prevClose = j > 0 ? c[j - 1].close : c[j].open;
    const tr = Math.max(c[j].high - c[j].low, Math.abs(c[j].high - prevClose), Math.abs(c[j].low - prevClose));
    sum += tr;
  }
  return (sum / period) / c[i].close * 100;
}

function bucket(name: string, v: number | null): string {
  if (v === null || !isFinite(v)) return `${name}:null`;
  if (name === "rsi") { if (v < 30) return "rsi:<30"; if (v < 45) return "rsi:30-45"; if (v < 55) return "rsi:45-55"; if (v < 70) return "rsi:55-70"; return "rsi:>70"; }
  if (name === "macdHist") { if (v < -100) return "macd:<-100"; if (v < 0) return "macd:-100..0"; if (v < 100) return "macd:0..100"; return "macd:>100"; }
  if (name === "bbPct") { if (v < 0) return "bb%:<0"; if (v < 0.25) return "bb%:0-25"; if (v < 0.5) return "bb%:25-50"; if (v < 0.75) return "bb%:50-75"; if (v <= 1) return "bb%:75-100"; return "bb%:>100"; }
  if (name === "ema50Dist") { if (v < -3) return "ema:<-3%"; if (v < -1) return "ema:-3..-1%"; if (v < 1) return "ema:-1..1%"; if (v < 3) return "ema:1..3%"; return "ema:>3%"; }
  if (name === "atr") { if (v < 1) return "atr:<1%"; if (v < 2) return "atr:1-2%"; if (v < 3) return "atr:2-3%"; return "atr:>3%"; }
  if (name === "bodyPct") { if (v < 0.3) return "body:<0.3%"; if (v < 1) return "body:0.3-1%"; if (v < 2) return "body:1-2%"; return "body:>2%"; }
  return `${name}:${v.toFixed(2)}`;
}

function simulate(c: Candle[], i: number, side: "LONG" | "SHORT"): { o: Outcome; holdBars: number } {
  const entry = c[i].close;
  const tp = side === "LONG" ? entry * (1 + TP_PCT / 100) : entry * (1 - TP_PCT / 100);
  const sl = side === "LONG" ? entry * (1 - SL_PCT / 100) : entry * (1 + SL_PCT / 100);
  for (let j = i + 1; j < Math.min(i + 1 + MAX_HOLD, c.length); j++) {
    if (side === "LONG") {
      if (c[j].low <= sl) return { o: "LOSS", holdBars: j - i };
      if (c[j].high >= tp) return { o: "WIN", holdBars: j - i };
    } else {
      if (c[j].high >= sl) return { o: "LOSS", holdBars: j - i };
      if (c[j].low <= tp) return { o: "WIN", holdBars: j - i };
    }
  }
  return { o: "TIMEOUT", holdBars: Math.min(MAX_HOLD, c.length - i - 1) };
}

interface FeatureRow { idx: number; outcome: Outcome; holdBars: number; features: Record<string, string> }

function summarize(outcomes: Outcome[]) {
  const wins = outcomes.filter((o) => o === "WIN").length;
  const losses = outcomes.filter((o) => o === "LOSS").length;
  const wr = wins + losses > 0 ? wins / (wins + losses) * 100 : 0;
  const gross = wins * TP_PCT - losses * SL_PCT;
  const fee = outcomes.length * FEE_PER_SIDE * 2;
  const netPct = (gross - fee) * LEV;
  const pf = losses > 0 ? (wins * TP_PCT) / (losses * SL_PCT) : (wins > 0 ? 999 : 0);
  return {
    trades: outcomes.length, wins, losses,
    timeouts: outcomes.length - wins - losses,
    winRate: +wr.toFixed(2),
    netPctLev: +netPct.toFixed(0),
    profitFactor: +pf.toFixed(2),
  };
}

async function main() {
  console.log(`\n=== SCAN 4h FEATURES (HTF=1d, ${YEARS}y, TP=${TP_PCT}% SL=${SL_PCT}%) ===`);
  const target4h = Math.ceil(365 * 6 * YEARS) + 100;
  const target1d = Math.ceil(365 * YEARS) + 60;
  console.log(`Fetch 4h (${target4h}) + 1d (${target1d})...`);
  const [c4, c1d] = await Promise.all([fetchKlines("4h", target4h), fetchKlines("1d", target1d)]);
  console.log(`  4h: ${c4.length}, 1d: ${c1d.length}`);

  const closes = c4.map((c) => c.close);
  const rsi = calcRSISeriesAligned(closes, 14);
  const macd = calcMACDSeries(closes);
  const bb = calcBollingerSeries(closes);
  const ema50 = calcEMASeries(closes, 50);
  const ema1d = calcEMASeries(c1d.map((c) => c.close), 50);

  const records: FeatureRow[] = [];
  const startIdx = 50, endIdx = c4.length - MAX_HOLD - 1;

  for (let i = startIdx; i < endIdx; i++) {
    const c = c4[i], prev = c4[i - 1];
    const prevBull = prev.close >= prev.open;
    const currBull = c.close >= c.open;
    const reversal = prevBull === currBull ? "CONT" : (!prevBull && currBull ? "UP_REV" : "DOWN_REV");
    const bodyP = Math.abs(c.close - c.open) / c.open * 100;
    const macdH = macd.histogram[i];
    const bbU = bb.upper[i], bbL = bb.lower[i];
    const bbP = (bbU != null && bbL != null && bbU !== bbL) ? (c.close - bbL) / (bbU - bbL) : null;
    const e50 = ema50[i];
    const eDist = e50 != null ? (c.close - e50) / e50 * 100 : null;
    const atrP = atrPct(c4, i, 14);
    const htfI = findHTFIdxAt(c1d, c.time);
    let htf = "htf:na";
    if (htfI >= 0 && ema1d[htfI] != null) {
      const diff = (c1d[htfI].close - ema1d[htfI]!) / ema1d[htfI]! * 100;
      htf = diff > 0.5 ? "htf:UP" : diff < -0.5 ? "htf:DOWN" : "htf:FLAT";
    }
    const features: Record<string, string> = {
      rsi: bucket("rsi", rsi[i]),
      macdHist: bucket("macdHist", macdH),
      bbPct: bucket("bbPct", bbP),
      ema50Dist: bucket("ema50Dist", eDist),
      atr: bucket("atr", atrP),
      bodyPct: bucket("bodyPct", bodyP),
      candle: currBull ? "candle:BULL" : "candle:BEAR",
      reversal: `rev:${reversal}`,
      htf,
    };
    // We compute outcomes for both LONG and SHORT later (when checking combos)
    records.push({ idx: i, outcome: "TIMEOUT", holdBars: 0, features });
  }

  // Pre-simulate both sides per record (one-position will be enforced per combo)
  const outcomeLong: Outcome[] = records.map((r) => simulate(c4, r.idx, "LONG").o);
  const outcomeShort: Outcome[] = records.map((r) => simulate(c4, r.idx, "SHORT").o);
  const holdLong: number[] = records.map((r) => simulate(c4, r.idx, "LONG").holdBars);
  const holdShort: number[] = records.map((r) => simulate(c4, r.idx, "SHORT").holdBars);

  // Build combo enumeration
  const featKeys = ["rsi", "macdHist", "bbPct", "ema50Dist", "atr", "bodyPct", "candle", "reversal", "htf"];
  const valuesByKey: Record<string, Set<string>> = {};
  for (const k of featKeys) valuesByKey[k] = new Set();
  for (const r of records) for (const k of featKeys) valuesByKey[k].add(r.features[k]);

  const candidatesByKey: Record<string, string[]> = {};
  for (const k of featKeys) candidatesByKey[k] = [...valuesByKey[k]].filter((v) => !v.endsWith(":null") && !v.endsWith(":na"));

  function evalCombo(parts: string[], side: "LONG" | "SHORT", outcomes: Outcome[], holds: number[]) {
    // Apply spec one-position-at-a-time
    const trades: Outcome[] = [];
    let blockedUntil = -1;
    for (let i = 0; i < records.length; i++) {
      if (i <= blockedUntil) continue;
      const r = records[i];
      const hit = parts.every((p) => Object.values(r.features).includes(p));
      if (!hit) continue;
      // HTF align
      if (side === "LONG" && r.features.htf !== "htf:UP") continue;
      if (side === "SHORT" && r.features.htf !== "htf:DOWN") continue;
      trades.push(outcomes[i]);
      blockedUntil = i + holds[i];
    }
    return summarize(trades);
  }

  const results: { side: string; combo: string; rule: string; n: number; wr: number; pf: number; netPctLev: number }[] = [];

  // PAIR + TRIPLE combos (skip combos that include 'htf' since we always enforce HTF align)
  const keysNoHtf = featKeys.filter((k) => k !== "htf");

  // pairs
  for (let a = 0; a < keysNoHtf.length; a++) for (let b = a + 1; b < keysNoHtf.length; b++) {
    for (const va of candidatesByKey[keysNoHtf[a]]) for (const vb of candidatesByKey[keysNoHtf[b]]) {
      for (const side of ["LONG", "SHORT"] as const) {
        const summary = side === "LONG"
          ? evalCombo([va, vb], side, outcomeLong, holdLong)
          : evalCombo([va, vb], side, outcomeShort, holdShort);
        if (summary.trades < MIN_N) continue;
        const minWR = side === "LONG" ? MIN_WR_LONG : MIN_WR_SHORT;
        if (summary.winRate < minWR) continue;
        results.push({
          side, combo: "pair", rule: `${va} & ${vb} & htf:${side === "LONG" ? "UP" : "DOWN"}`,
          n: summary.trades, wr: summary.winRate, pf: summary.profitFactor, netPctLev: summary.netPctLev,
        });
      }
    }
  }

  // triples
  for (let a = 0; a < keysNoHtf.length; a++) for (let b = a + 1; b < keysNoHtf.length; b++) for (let c2 = b + 1; c2 < keysNoHtf.length; c2++) {
    for (const va of candidatesByKey[keysNoHtf[a]]) for (const vb of candidatesByKey[keysNoHtf[b]]) for (const vc of candidatesByKey[keysNoHtf[c2]]) {
      for (const side of ["LONG", "SHORT"] as const) {
        const summary = side === "LONG"
          ? evalCombo([va, vb, vc], side, outcomeLong, holdLong)
          : evalCombo([va, vb, vc], side, outcomeShort, holdShort);
        if (summary.trades < MIN_N) continue;
        const minWR = side === "LONG" ? MIN_WR_LONG : MIN_WR_SHORT;
        if (summary.winRate < minWR) continue;
        results.push({
          side, combo: "triple", rule: `${va} & ${vb} & ${vc} & htf:${side === "LONG" ? "UP" : "DOWN"}`,
          n: summary.trades, wr: summary.winRate, pf: summary.profitFactor, netPctLev: summary.netPctLev,
        });
      }
    }
  }

  // sort by netPctLev
  results.sort((a, b) => b.netPctLev - a.netPctLev);

  const out = {
    generatedAt: new Date().toISOString(),
    period: `${YEARS}y`,
    spec: { fee_per_side: FEE_PER_SIDE, sl_before_tp: true, one_position: true, htf: "1d EMA50" },
    params: { tp: TP_PCT, sl: SL_PCT, hold: MAX_HOLD, lev: LEV, minN: MIN_N, minWR: MIN_WR_LONG },
    totalCandidates: results.length,
    topByNet: results.slice(0, 30),
    topByWR: [...results].sort((a, b) => b.wr - a.wr).slice(0, 30),
  };

  const outPath = join(__dirname, "..", "assets", "scan_4h_features_results.json");
  writeFileSync(outPath, JSON.stringify(out, null, 2));

  console.log(`\nTotal candidate combos: ${results.length}`);
  console.log(`\nTop 10 by NET PnL (lev=${LEV}):`);
  out.topByNet.slice(0, 10).forEach((r) =>
    console.log(`  [${r.side}] ${r.combo}: WR=${r.wr}% n=${r.n} PF=${r.pf} NET=+${r.netPctLev}% | ${r.rule}`)
  );
  console.log(`\nTop 10 by WinRate:`);
  out.topByWR.slice(0, 10).forEach((r) =>
    console.log(`  [${r.side}] WR=${r.wr}% n=${r.n} NET=${r.netPctLev}% | ${r.rule}`)
  );
  console.log(`\n💾 ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
