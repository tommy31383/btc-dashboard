/**
 * diag-tomi-stack-dd.ts — Investigate why TOMI stack=75 has DD 2.0% vs neighbors 0.2-0.3%.
 *
 * Track: peak capital, when DD happened, max concurrent open, capital used at DD peak.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { Candle } from "../utils/backtester";
import { calcStochRSISeries } from "../utils/indicators";

const INITIAL_CAPITAL = 5000;
const MARGIN_PER_TRADE = 30;
const LEVERAGE = 100;
const NOTIONAL = MARGIN_PER_TRADE * LEVERAGE;
const FEE_PER_SIDE_PCT = 0.05;
const FEE_PER_SIDE = NOTIONAL * (FEE_PER_SIDE_PCT / 100);

const STACKS = [50, 75, 100];

const TOMI = {
  tpPct: 4, slPct: 4,
  stackMinEntryDistPct: 0, stackPerSideSpacingMin: 0,
  cooldownMin: 5, stochLongLevel: 5, stochShortLevel: 95,
  srProximityPct: 0.2, srLookback15m: 50,
};

type Side = "LONG" | "SHORT";

interface OpenPos {
  bar5mTime: number; entryIdx: number; side: Side;
  entryPrice: number; entryMs: number; tpPrice: number; slPrice: number;
}

function precomputeSR15m(c15: Candle[], lookback: number) {
  const n = c15.length;
  const support: (number | null)[] = new Array(n).fill(null);
  const resistance: (number | null)[] = new Array(n).fill(null);
  for (let i = lookback; i < n; i++) {
    let lo = Infinity, hi = -Infinity;
    for (let j = i - lookback; j < i; j++) {
      if (c15[j].low < lo) lo = c15[j].low;
      if (c15[j].high > hi) hi = c15[j].high;
    }
    support[i] = lo === Infinity ? null : lo;
    resistance[i] = hi === -Infinity ? null : hi;
  }
  return { support, resistance };
}

function srAtTime(c15: Candle[], sup: (number | null)[], res: (number | null)[], t: number) {
  let lo = 0, hi = c15.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (c15[mid].time <= t) { idx = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (idx < 0) return { support: null, resistance: null };
  return { support: sup[idx], resistance: res[idx] };
}

function runDiag(stackMax: number, c5: Candle[], stochK: (number | null)[], c15: Candle[]) {
  const SR_LB = TOMI.srLookback15m;
  const { support: srS, resistance: srR } = precomputeSR15m(c15, SR_LB);
  const COOLDOWN_MS = TOMI.cooldownMin * 60 * 1000;
  const open: OpenPos[] = [];
  let lastEntryMs = 0;
  let capital = INITIAL_CAPITAL;
  let peak = INITIAL_CAPITAL;
  let maxDD = 0;
  let maxDDPct = 0;
  let maxDDTimeMs = 0;
  let maxDDPeak = peak;
  let maxDDTrough = peak;
  let maxConcurrent = 0;
  let maxConcurrentLong = 0;
  let maxConcurrentShort = 0;
  let maxConcurrentTimeMs = 0;
  let totalTrades = 0;

  for (let i = SR_LB; i < c5.length; i++) {
    const bar = c5[i];
    const t = bar.time;
    const close = bar.close;

    // Exit check
    for (let pi = open.length - 1; pi >= 0; pi--) {
      const p = open[pi];
      if (p.entryIdx >= i) continue;
      let exitPrice: number | null = null;
      if (p.side === "LONG") {
        if (bar.low <= p.slPrice) exitPrice = p.slPrice;
        else if (bar.high >= p.tpPrice) exitPrice = p.tpPrice;
      } else {
        if (bar.high >= p.slPrice) exitPrice = p.slPrice;
        else if (bar.low <= p.tpPrice) exitPrice = p.tpPrice;
      }
      if (exitPrice === null) continue;
      const rawPct = p.side === "LONG"
        ? ((exitPrice - p.entryPrice) / p.entryPrice) * 100
        : ((p.entryPrice - exitPrice) / p.entryPrice) * 100;
      let grossPnl = MARGIN_PER_TRADE * rawPct * LEVERAGE / 100;
      if (grossPnl < -MARGIN_PER_TRADE) grossPnl = -MARGIN_PER_TRADE;
      capital += grossPnl - 2 * FEE_PER_SIDE;
      totalTrades++;
      if (capital > peak) peak = capital;
      const dd = peak - capital;
      if (dd > maxDD) {
        maxDD = dd;
        maxDDPct = peak > 0 ? (dd / peak) * 100 : 0;
        maxDDTimeMs = t;
        maxDDPeak = peak;
        maxDDTrough = capital;
      }
      open.splice(pi, 1);
    }

    // Track max concurrent
    if (open.length > maxConcurrent) {
      maxConcurrent = open.length;
      maxConcurrentLong = open.filter((p) => p.side === "LONG").length;
      maxConcurrentShort = open.filter((p) => p.side === "SHORT").length;
      maxConcurrentTimeMs = t;
    }

    // Entry
    if (open.some((p) => p.bar5mTime === t)) continue;
    if (t - lastEntryMs < COOLDOWN_MS) continue;
    const usedMargin = open.length * MARGIN_PER_TRADE;
    if (capital - usedMargin < MARGIN_PER_TRADE) continue;

    let side: Side | null = null;
    const k = stochK[i];
    if (k !== null && k < TOMI.stochLongLevel) side = "LONG";
    else if (k !== null && k > TOMI.stochShortLevel) side = "SHORT";
    else {
      const sr = srAtTime(c15, srS, srR, t);
      if (sr.support !== null && sr.resistance !== null) {
        const distSup = ((close - sr.support) / sr.support) * 100;
        const distRes = ((sr.resistance - close) / close) * 100;
        if (distSup >= 0 && distSup <= TOMI.srProximityPct) side = "LONG";
        else if (distRes >= 0 && distRes <= TOMI.srProximityPct) side = "SHORT";
      }
    }
    if (!side) continue;

    const sameSide = open.filter((p) => p.side === side);
    if (sameSide.length >= stackMax) continue;

    const tpPrice = side === "LONG" ? close * (1 + TOMI.tpPct / 100) : close * (1 - TOMI.tpPct / 100);
    const slPrice = side === "LONG" ? close * (1 - TOMI.slPct / 100) : close * (1 + TOMI.slPct / 100);
    open.push({ bar5mTime: t, entryIdx: i, side, entryPrice: close, entryMs: t, tpPrice, slPrice });
    lastEntryMs = t;
  }

  return {
    stackMax, totalTrades,
    finalCapital: capital, peak, maxDD, maxDDPct,
    maxDDTimeMs, maxDDPeak, maxDDTrough,
    maxConcurrent, maxConcurrentLong, maxConcurrentShort, maxConcurrentTimeMs,
  };
}

(async () => {
  const c5: Candle[] = JSON.parse(readFileSync(join(__dirname, "..", ".cache", "binance-5m-3y.json"), "utf8"));
  const c15: Candle[] = JSON.parse(readFileSync(join(__dirname, "..", ".cache", "binance-15m-3y.json"), "utf8"));
  console.log(`5m=${c5.length} 15m=${c15.length}`);
  const closes5 = c5.map((x) => x.close);
  const { kSeries: stochK } = calcStochRSISeries(closes5, 14, 14, 3, 3);

  console.log(`\n=== TOMI DD DIAGNOSTIC (stack 50/75/100) ===\n`);
  for (const stack of STACKS) {
    process.stdout.write(`Running stack=${stack}...`);
    const t0 = Date.now();
    const r = runDiag(stack, c5, stochK, c15);
    process.stdout.write(` ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
    const ddDate = new Date(r.maxDDTimeMs).toISOString().slice(0, 16).replace("T", " ");
    const ccDate = new Date(r.maxConcurrentTimeMs).toISOString().slice(0, 16).replace("T", " ");
    console.log(`  Trades:           ${r.totalTrades}`);
    console.log(`  Final capital:    $${r.finalCapital.toFixed(0)}  (peak $${r.peak.toFixed(0)})`);
    console.log(`  Max DD:           $${r.maxDD.toFixed(0)} (${r.maxDDPct.toFixed(2)}%)  at  ${ddDate} UTC`);
    console.log(`  DD peak→trough:   $${r.maxDDPeak.toFixed(0)} → $${r.maxDDTrough.toFixed(0)}`);
    console.log(`  Max concurrent:   ${r.maxConcurrent} (LONG ${r.maxConcurrentLong} + SHORT ${r.maxConcurrentShort})  at  ${ccDate} UTC`);
    console.log("");
  }
})();
