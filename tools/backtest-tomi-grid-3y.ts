/**
 * backtest-tomi-grid-3y.ts
 *
 * Grid sweep TP% × SL% cho entry K<5/K>95 + S/R 0.2% (TOMI config).
 * Tìm combo TP/SL tốt nhất theo NET PnL và MaxDD.
 *
 * Usage:
 *   npx tsx tools/backtest-tomi-grid-3y.ts
 *   npx tsx tools/backtest-tomi-grid-3y.ts --years=1
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { Candle } from "../utils/backtester";
import { calcStochRSISeries } from "../utils/indicators";

const BINANCE_REST = "https://api.binance.com/api/v3";
const args = process.argv.slice(2);
const YEARS = parseFloat(args.find((a) => a.startsWith("--years="))?.replace("--years=", "") || "3");

const INITIAL_CAPITAL = 5000;
const MARGIN = 30;
const LEV = 100;
const NOTIONAL = MARGIN * LEV;
const FEE_PER_SIDE = NOTIONAL * 0.0005; // $1.5

// Entry config (fixed — TOMI)
const STOCH_LONG = 5;
const STOCH_SHORT = 95;
const SR_PROX = 0.2;
const SR_LOOKBACK = 50;
const STACK_MAX = 50;
const COOLDOWN_MS = 5 * 60 * 1000;

// Grid params
const TP_GRID = [2, 3, 4, 5, 6, 7, 8, 10, 12, 15];
const SL_GRID = [1, 1.5, 2, 2.5, 3, 3.5, 4];

const BARS_5M = Math.ceil(YEARS * 365 * 24 * 12);
const BARS_15M = Math.ceil(YEARS * 365 * 24 * 4);

// ─── Data ───────────────────────────────────────────────────────────────────
async function fetchRaw(interval: string, total: number): Promise<Candle[]> {
  const all: Candle[] = [];
  let endTime: number | undefined;
  while (all.length < total) {
    const limit = Math.min(1000, total - all.length);
    const p = new URLSearchParams({ symbol: "BTCUSDT", interval, limit: String(limit) });
    if (endTime) p.set("endTime", String(endTime));
    const res = await fetch(`${BINANCE_REST}/klines?${p}`);
    const data: any[] = await res.json();
    if (!data.length) break;
    const batch: Candle[] = data.map((k) => ({
      time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
    }));
    all.unshift(...batch);
    endTime = batch[0].time - 1;
    await new Promise((r) => setTimeout(r, 200));
  }
  const m = new Map<number, Candle>();
  for (const c of all) m.set(c.time, c);
  return Array.from(m.values()).sort((a, b) => a.time - b.time);
}

async function fetchCached(interval: string, total: number): Promise<Candle[]> {
  const dir = join(__dirname, "..", ".cache");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, `binance-${interval}-${YEARS}y.json`);
  if (existsSync(path)) {
    try {
      const d = JSON.parse(readFileSync(path, "utf8")) as Candle[];
      if (Array.isArray(d) && d.length >= total * 0.9) { console.log(`  [cache] ${interval} ${d.length}`); return d; }
    } catch {}
  }
  process.stdout.write(`  Fetching ${interval}...`);
  const d = await fetchRaw(interval, total);
  process.stdout.write(` ${d.length}\n`);
  writeFileSync(path, JSON.stringify(d));
  return d;
}

// ─── S/R precompute ──────────────────────────────────────────────────────────
function precomputeSR(c15: Candle[]) {
  const n = c15.length;
  const sup: (number | null)[] = new Array(n).fill(null);
  const res: (number | null)[] = new Array(n).fill(null);
  for (let i = SR_LOOKBACK; i < n; i++) {
    let lo = Infinity, hi = -Infinity;
    for (let j = i - SR_LOOKBACK; j < i; j++) {
      if (c15[j].low < lo) lo = c15[j].low;
      if (c15[j].high > hi) hi = c15[j].high;
    }
    sup[i] = lo; res[i] = hi;
  }
  return { sup, res };
}

function sr15At(c15: Candle[], sup: (number|null)[], res: (number|null)[], t: number) {
  let lo = 0, hi = c15.length - 1, idx = -1;
  while (lo <= hi) { const m = (lo+hi)>>1; if (c15[m].time <= t) { idx=m; lo=m+1; } else hi=m-1; }
  if (idx < 0) return { s: null, r: null };
  return { s: sup[idx], r: res[idx] };
}

// ─── Entry signal precompute (same for all grid runs) ───────────────────────
interface EntrySignal { idx: number; side: "LONG"|"SHORT"; price: number; t: number; }

function precomputeSignals(c5: Candle[], stochK: (number|null)[], c15: Candle[], sup: (number|null)[], res: (number|null)[]): EntrySignal[] {
  const signals: EntrySignal[] = [];
  for (let i = SR_LOOKBACK; i < c5.length; i++) {
    const close = c5[i].close;
    const k = stochK[i];
    let side: "LONG"|"SHORT"|null = null;
    if (k !== null && k < STOCH_LONG) side = "LONG";
    else if (k !== null && k > STOCH_SHORT) side = "SHORT";
    else {
      const { s, r } = sr15At(c15, sup, res, c5[i].time);
      if (s !== null && r !== null) {
        const dSup = (close - s) / s * 100;
        const dRes = (r - close) / close * 100;
        if (dSup >= 0 && dSup <= SR_PROX) side = "LONG";
        else if (dRes >= 0 && dRes <= SR_PROX) side = "SHORT";
      }
    }
    if (side) signals.push({ idx: i, side, price: close, t: c5[i].time });
  }
  return signals;
}

// ─── Single run for one TP/SL combo ─────────────────────────────────────────
interface OpenPos {
  entryIdx: number; side: "LONG"|"SHORT"; entryPrice: number; entryMs: number;
  tp: number; sl: number;
}

function runOne(c5: Candle[], signals: EntrySignal[], tpPct: number, slPct: number) {
  const open: OpenPos[] = [];
  let lastEntryMs = 0;
  let capital = INITIAL_CAPITAL;
  const equityPts: number[] = [];
  let wins = 0, losses = 0;

  // Build a signal lookup: bar index → signal
  const sigMap = new Map<number, EntrySignal>();
  for (const s of signals) sigMap.set(s.idx, s);

  for (let i = SR_LOOKBACK; i < c5.length; i++) {
    const bar = c5[i];

    // Monitor open
    for (let pi = open.length - 1; pi >= 0; pi--) {
      const p = open[pi];
      if (p.entryIdx >= i) continue;
      let outcome: "WIN"|"LOSS"|null = null;
      let exitPrice = bar.close;
      if (p.side === "LONG") {
        if (bar.low <= p.sl)  { outcome = "LOSS"; exitPrice = p.sl; }
        else if (bar.high >= p.tp) { outcome = "WIN"; exitPrice = p.tp; }
      } else {
        if (bar.high >= p.sl) { outcome = "LOSS"; exitPrice = p.sl; }
        else if (bar.low <= p.tp)  { outcome = "WIN"; exitPrice = p.tp; }
      }
      if (!outcome) continue;
      const rawPct = p.side === "LONG"
        ? (exitPrice - p.entryPrice) / p.entryPrice * 100
        : (p.entryPrice - exitPrice) / p.entryPrice * 100;
      let gross = MARGIN * rawPct * LEV / 100;
      if (gross < -MARGIN) gross = -MARGIN;
      capital += gross - 2 * FEE_PER_SIDE;
      if (outcome === "WIN") wins++; else losses++;
      equityPts.push(capital);
      open.splice(pi, 1);
    }

    // Entry
    const sig = sigMap.get(i);
    if (!sig) continue;
    if (bar.time - lastEntryMs < COOLDOWN_MS) continue;
    const used = open.length * MARGIN;
    if (capital - used < MARGIN) continue;
    const sameSide = open.filter((p) => p.side === sig.side);
    if (sameSide.length >= STACK_MAX) continue;

    const tp = sig.side === "LONG" ? sig.price * (1 + tpPct/100) : sig.price * (1 - tpPct/100);
    const sl = sig.side === "LONG" ? sig.price * (1 - slPct/100) : sig.price * (1 + slPct/100);
    open.push({ entryIdx: i, side: sig.side, entryPrice: sig.price, entryMs: bar.time, tp, sl });
    lastEntryMs = bar.time;
  }

  const total = wins + losses;
  const wr = total ? wins / total * 100 : 0;
  const netUsd = capital - INITIAL_CAPITAL;
  // Max drawdown
  const full = [INITIAL_CAPITAL, ...equityPts];
  let peak = INITIAL_CAPITAL, maxDD = 0;
  for (const v of full) { if (v > peak) peak = v; const dd = peak - v; if (dd > maxDD) maxDD = dd; }
  // Profit factor
  const gw = equityPts.filter((_, i) => i > 0 ? equityPts[i] > equityPts[i-1] : capital > INITIAL_CAPITAL).length;
  return { total, wins, losses, wr, netUsd, finalCapital: capital, maxDD, roi: netUsd/INITIAL_CAPITAL*100 };
}

// ─── Main ────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n=== TOMI GRID SWEEP TP×SL — K<${STOCH_LONG}/K>${STOCH_SHORT} + S/R ${SR_PROX}% (${YEARS}y) ===`);
  console.log(`Capital=$${INITIAL_CAPITAL}  margin=$${MARGIN}×${LEV}x  stack=${STACK_MAX}/side  cooldown=5m\n`);

  const c5  = await fetchCached("5m",  BARS_5M);
  const c15 = await fetchCached("15m", BARS_15M);
  console.log(`Range: ${new Date(c5[0].time).toISOString().slice(0,10)} → ${new Date(c5[c5.length-1].time).toISOString().slice(0,10)}\n`);

  process.stdout.write("Computing StochRSI...");
  const { kSeries } = calcStochRSISeries(c5.map((x) => x.close), 14, 14, 3, 3);
  process.stdout.write(" done\n");

  process.stdout.write("Precomputing S/R...");
  const { sup, res } = precomputeSR(c15);
  process.stdout.write(" done\n");

  process.stdout.write("Precomputing entry signals...");
  const signals = precomputeSignals(c5, kSeries, c15, sup, res);
  process.stdout.write(` ${signals.length} signals\n\n`);

  // ─── Grid run ─────────────────────────────────────────────────────────────
  interface GridRow { tp: number; sl: number; total: number; wr: number; netUsd: number; maxDD: number; ratio: number; roi: number; }
  const grid: GridRow[] = [];

  for (const sl of SL_GRID) {
    for (const tp of TP_GRID) {
      const r = runOne(c5, signals, tp, sl);
      const ratio = r.maxDD > 0 ? r.netUsd / r.maxDD : 0;
      grid.push({ tp, sl, total: r.total, wr: r.wr, netUsd: r.netUsd, maxDD: r.maxDD, ratio, roi: r.roi });
    }
  }

  // ─── Print table sorted by ratio (NET/MaxDD) ──────────────────────────────
  const byRatio = [...grid].sort((a, b) => b.ratio - a.ratio);

  const pad = (s: string|number, n: number) => String(s).padStart(n);
  console.log(`${"─".repeat(78)}`);
  console.log(`${pad("TP%",5)} ${pad("SL%",5)} ${pad("TRADES",8)} ${pad("WR%",7)} ${pad("NET $",10)} ${pad("MAX DD",9)} ${pad("NET/DD",8)} ${pad("ROI%",8)}`);
  console.log(`${"─".repeat(78)}`);

  for (const r of byRatio) {
    const flag = r.ratio === byRatio[0].ratio ? " ← BEST" : r.netUsd === Math.max(...grid.map((x) => x.netUsd)) ? " ← MAX NET" : "";
    console.log(
      `${pad(r.tp+"%",5)} ${pad(r.sl+"%",5)} ${pad(r.total,8)} ${pad(r.wr.toFixed(1)+"%",7)} ` +
      `${pad("$"+r.netUsd.toFixed(0),10)} ${pad("$"+r.maxDD.toFixed(0),9)} ${pad(r.ratio.toFixed(2),8)} ${pad(r.roi.toFixed(1)+"%",8)}${flag}`
    );
  }
  console.log(`${"─".repeat(78)}`);

  // ─── Top 5 by NET/DD ratio ─────────────────────────────────────────────────
  console.log(`\n🏆 Top 5 by NET/MaxDD ratio:`);
  for (const r of byRatio.slice(0, 5)) {
    console.log(`  TP+${r.tp}% / SL-${r.sl}%  →  NET $${r.netUsd.toFixed(0)}  DD $${r.maxDD.toFixed(0)}  ratio ${r.ratio.toFixed(2)}  WR ${r.wr.toFixed(1)}%`);
  }

  // ─── Top 5 by raw NET ─────────────────────────────────────────────────────
  const byNet = [...grid].sort((a, b) => b.netUsd - a.netUsd);
  console.log(`\n💰 Top 5 by raw NET PnL:`);
  for (const r of byNet.slice(0, 5)) {
    console.log(`  TP+${r.tp}% / SL-${r.sl}%  →  NET $${r.netUsd.toFixed(0)}  DD $${r.maxDD.toFixed(0)}  ratio ${r.ratio.toFixed(2)}  WR ${r.wr.toFixed(1)}%`);
  }

  // ─── Matrix view (NET $) ──────────────────────────────────────────────────
  console.log(`\n📊 NET $ matrix (row=SL, col=TP):`);
  process.stdout.write("SL\\TP".padEnd(7));
  for (const tp of TP_GRID) process.stdout.write(String(tp+"%").padStart(9));
  process.stdout.write("\n");
  for (const sl of SL_GRID) {
    process.stdout.write(String(sl+"%").padEnd(7));
    for (const tp of TP_GRID) {
      const r = grid.find((x) => x.tp === tp && x.sl === sl)!;
      process.stdout.write(("$"+r.netUsd.toFixed(0)).padStart(9));
    }
    process.stdout.write("\n");
  }

  // ─── Matrix view (MaxDD $) ────────────────────────────────────────────────
  console.log(`\n📊 MaxDD $ matrix (row=SL, col=TP):`);
  process.stdout.write("SL\\TP".padEnd(7));
  for (const tp of TP_GRID) process.stdout.write(String(tp+"%").padStart(9));
  process.stdout.write("\n");
  for (const sl of SL_GRID) {
    process.stdout.write(String(sl+"%").padEnd(7));
    for (const tp of TP_GRID) {
      const r = grid.find((x) => x.tp === tp && x.sl === sl)!;
      process.stdout.write(("$"+r.maxDD.toFixed(0)).padStart(9));
    }
    process.stdout.write("\n");
  }

  // ─── Save ─────────────────────────────────────────────────────────────────
  const outDir = join(__dirname, "..", "assets");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "backtest_tomi_grid_3y.json");
  writeFileSync(outPath, JSON.stringify({
    generated_at: new Date().toISOString(), years: YEARS,
    config: { stochLong: STOCH_LONG, stochShort: STOCH_SHORT, srProx: SR_PROX, srLookback: SR_LOOKBACK, stackMax: STACK_MAX, cooldownMin: 5 },
    range: { from: c5[0].time, to: c5[c5.length-1].time },
    tpGrid: TP_GRID, slGrid: SL_GRID, grid: byRatio,
  }, null, 2));
  console.log(`\nSaved → ${outPath}`);
})();
