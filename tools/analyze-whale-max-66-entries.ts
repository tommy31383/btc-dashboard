/**
 * analyze-whale-max-66-entries.ts (anh Tommy 2026-04-29)
 *
 * Thống kê chi tiết điểm vào lệnh 3y của preset WHALE_MAX_66 (TP6/SL6 stack 200).
 * Output:
 *   - Per-source breakdown (stoch_long/short + sr_long/short)
 *   - Per-side breakdown (LONG vs SHORT)
 *   - Time-of-day distribution + WR
 *   - Day-of-week distribution + WR
 *   - Monthly entry density + WR
 *   - Sequential pattern (winning/losing streaks)
 *   - Recommendation: source nào nên loại
 *
 * Usage:
 *   npx tsx tools/analyze-whale-max-66-entries.ts
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { Candle } from "../utils/backtester";
import { calcStochRSISeries } from "../utils/indicators";

const YEARS = 3;
const INITIAL_CAPITAL = 5000;
const MARGIN_PER_TRADE = 30;
const LEVERAGE = 100;
const NOTIONAL = MARGIN_PER_TRADE * LEVERAGE;
const FEE_PER_SIDE_PCT = 0.05;
const FEE_PER_SIDE = NOTIONAL * (FEE_PER_SIDE_PCT / 100);

// ─── WHALE_MAX_66 config ────────────────────────────────────────────────────
const PRESET = {
  key: "WHALE_MAX_66",
  tpPct: 6, slPct: 6,
  stackMaxPerSide: 200,
  cooldownMin: 5,
  stochLongLevel: 10, stochShortLevel: 90,
  srProximityPct: 0.4, srLookback15m: 30,
  stackPerSideSpacingMin: 0,
  stackMinEntryDistPct: 0,
};

type Side = "LONG" | "SHORT";
type EntrySource = "stoch_long" | "stoch_short" | "sr_long" | "sr_short";

interface Trade {
  bar5mTime: number;
  entryIdx: number;
  side: Side;
  source: EntrySource;
  entryPrice: number;
  exitPrice: number;
  outcome: "WIN" | "LOSS";
  pnlNet: number;
  holdBars: number;
  hourOfDay: number;
  dayOfWeek: number;
  monthYear: string;
}

function loadCachedKlines(interval: string): Candle[] {
  const cachePath = join(__dirname, "..", ".cache", `binance-${interval}-${YEARS}y.json`);
  if (!existsSync(cachePath)) throw new Error(`Missing cache ${cachePath}`);
  return JSON.parse(readFileSync(cachePath, "utf8")) as Candle[];
}

function precomputeSR(candles: Candle[], lookback: number) {
  const n = candles.length;
  const sup = new Array<number | null>(n).fill(null);
  const res = new Array<number | null>(n).fill(null);
  for (let i = lookback; i < n; i++) {
    let lo = Infinity, hi = -Infinity;
    for (let j = i - lookback; j < i; j++) {
      if (candles[j].low < lo) lo = candles[j].low;
      if (candles[j].high > hi) hi = candles[j].high;
    }
    sup[i] = lo === Infinity ? null : lo;
    res[i] = hi === -Infinity ? null : hi;
  }
  return { sup, res };
}

function srAtTime(candles15m: Candle[], sup: (number | null)[], res: (number | null)[], time: number) {
  // Binary search: last 15m bar with time <= target
  let lo = 0, hi = candles15m.length - 1, idx = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (candles15m[m].time <= time) { idx = m; lo = m + 1; }
    else hi = m - 1;
  }
  if (idx < 0) return { support: null, resistance: null };
  return { support: sup[idx], resistance: res[idx] };
}

function runBacktest(candles5m: Candle[], stoch5m: (number | null)[], candles15m: Candle[], sup: (number | null)[], res: (number | null)[]): Trade[] {
  const trades: Trade[] = [];
  const open: { bar5mTime: number; side: Side; source: EntrySource; entryIdx: number; entryPrice: number; tpPrice: number; slPrice: number; entryMs: number; }[] = [];
  let lastEntryMs = 0;
  const cooldownMs = PRESET.cooldownMin * 60_000;

  for (let i = PRESET.srLookback15m; i < candles5m.length; i++) {
    const c = candles5m[i];
    const close = c.close;
    const k = stoch5m[i];

    // ─── Check exits trên open positions ─────────────────────────────────────
    for (let j = open.length - 1; j >= 0; j--) {
      const p = open[j];
      let outcome: "WIN" | "LOSS" | null = null;
      let exitPrice = close;
      if (p.side === "LONG") {
        if (c.high >= p.tpPrice) { outcome = "WIN"; exitPrice = p.tpPrice; }
        else if (c.low <= p.slPrice) { outcome = "LOSS"; exitPrice = p.slPrice; }
      } else {
        if (c.low <= p.tpPrice) { outcome = "WIN"; exitPrice = p.tpPrice; }
        else if (c.high >= p.slPrice) { outcome = "LOSS"; exitPrice = p.slPrice; }
      }
      if (outcome) {
        const rawPct = p.side === "LONG" ? (exitPrice - p.entryPrice) / p.entryPrice * 100 : (p.entryPrice - exitPrice) / p.entryPrice * 100;
        let grossPnl = MARGIN_PER_TRADE * rawPct * LEVERAGE / 100;
        if (grossPnl < -MARGIN_PER_TRADE) grossPnl = -MARGIN_PER_TRADE;
        const netPnl = grossPnl - 2 * FEE_PER_SIDE;
        const d = new Date(c.time);
        trades.push({
          bar5mTime: p.bar5mTime, entryIdx: p.entryIdx, side: p.side, source: p.source,
          entryPrice: p.entryPrice, exitPrice, outcome, pnlNet: netPnl,
          holdBars: i - p.entryIdx,
          hourOfDay: new Date(p.entryMs).getUTCHours(),
          dayOfWeek: new Date(p.entryMs).getUTCDay(),
          monthYear: `${new Date(p.entryMs).getUTCFullYear()}-${String(new Date(p.entryMs).getUTCMonth() + 1).padStart(2, '0')}`,
        });
        open.splice(j, 1);
      }
    }

    // ─── Try entry ───────────────────────────────────────────────────────────
    if (c.time - lastEntryMs < cooldownMs) continue;

    let side: Side | null = null;
    let source: EntrySource | null = null;
    if (k !== null && k < PRESET.stochLongLevel) { side = "LONG"; source = "stoch_long"; }
    else if (k !== null && k > PRESET.stochShortLevel) { side = "SHORT"; source = "stoch_short"; }
    else {
      const { support, resistance } = srAtTime(candles15m, sup, res, c.time);
      if (support !== null && resistance !== null) {
        const distSup = (close - support) / support * 100;
        const distRes = (resistance - close) / close * 100;
        if (distSup >= 0 && distSup <= PRESET.srProximityPct) { side = "LONG"; source = "sr_long"; }
        else if (distRes >= 0 && distRes <= PRESET.srProximityPct) { side = "SHORT"; source = "sr_short"; }
      }
    }
    if (!side || !source) continue;

    // Stack gates
    const sameSide = open.filter(p => p.side === side);
    if (sameSide.length >= PRESET.stackMaxPerSide) continue;

    const tpPrice = side === "LONG" ? close * (1 + PRESET.tpPct / 100) : close * (1 - PRESET.tpPct / 100);
    const slPrice = side === "LONG" ? close * (1 - PRESET.slPct / 100) : close * (1 + PRESET.slPct / 100);
    open.push({
      bar5mTime: c.time, side, source, entryIdx: i,
      entryPrice: close, tpPrice, slPrice, entryMs: c.time,
    });
    lastEntryMs = c.time;
  }
  return trades;
}

(async () => {
  console.log("Loading 5m + 15m caches (3y)...");
  const c5 = loadCachedKlines("5m");
  const c15 = loadCachedKlines("15m");
  console.log(`  5m: ${c5.length.toLocaleString()} candles, 15m: ${c15.length.toLocaleString()}`);

  console.log("Computing Stoch5m + S/R 15m...");
  const stoch5m = calcStochRSISeries(c5.map(c => c.close)).kSeries;
  const { sup, res } = precomputeSR(c15, PRESET.srLookback15m);

  console.log(`Running backtest WHALE_MAX_66 (TP${PRESET.tpPct}/SL${PRESET.slPct}, stack ${PRESET.stackMaxPerSide})...`);
  const t0 = Date.now();
  const trades = runBacktest(c5, stoch5m, c15, sup, res);
  console.log(`  ${trades.length.toLocaleString()} trades in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // ─── Stats ─────────────────────────────────────────────────────────────────
  const wins = trades.filter(t => t.outcome === "WIN").length;
  const losses = trades.filter(t => t.outcome === "LOSS").length;
  const totalNet = trades.reduce((s, t) => s + t.pnlNet, 0);
  console.log(`\n=== TỔNG QUAN ===`);
  console.log(`  Total trades: ${trades.length.toLocaleString()}`);
  console.log(`  Wins: ${wins} (${(wins / trades.length * 100).toFixed(1)}%)`);
  console.log(`  Losses: ${losses} (${(losses / trades.length * 100).toFixed(1)}%)`);
  console.log(`  Total NET: $${totalNet.toLocaleString(undefined, {maximumFractionDigits: 0})}`);
  console.log(`  Avg per trade: $${(totalNet / trades.length).toFixed(2)}`);

  // Per-source
  console.log(`\n=== PER ENTRY SOURCE (4 sources) ===`);
  const bySrc: Record<string, Trade[]> = {};
  for (const t of trades) (bySrc[t.source] ??= []).push(t);
  for (const src of ["stoch_long", "stoch_short", "sr_long", "sr_short"]) {
    const arr = bySrc[src] || [];
    if (!arr.length) { console.log(`  ${src.padEnd(14)} 0 trades`); continue; }
    const w = arr.filter(t => t.outcome === "WIN").length;
    const net = arr.reduce((s, t) => s + t.pnlNet, 0);
    console.log(`  ${src.padEnd(14)} ${arr.length.toString().padStart(5)} trades · WR ${(w / arr.length * 100).toFixed(1).padStart(5)}% · NET $${(net / 1000).toFixed(0).padStart(5)}k · avg $${(net / arr.length).toFixed(2).padStart(7)} · contrib ${(net / totalNet * 100).toFixed(1)}%`);
  }

  // Per-side
  console.log(`\n=== PER SIDE ===`);
  const bySide: Record<Side, Trade[]> = { LONG: [], SHORT: [] };
  for (const t of trades) bySide[t.side].push(t);
  for (const side of ["LONG", "SHORT"] as Side[]) {
    const arr = bySide[side];
    const w = arr.filter(t => t.outcome === "WIN").length;
    const net = arr.reduce((s, t) => s + t.pnlNet, 0);
    console.log(`  ${side.padEnd(6)} ${arr.length.toString().padStart(5)} trades · WR ${(w / arr.length * 100).toFixed(1)}% · NET $${(net / 1000).toFixed(0)}k`);
  }

  // Hour of day
  console.log(`\n=== HOUR OF DAY (UTC) ===`);
  const byHour: Trade[][] = Array.from({ length: 24 }, () => []);
  for (const t of trades) byHour[t.hourOfDay].push(t);
  for (let h = 0; h < 24; h++) {
    const arr = byHour[h];
    if (!arr.length) continue;
    const w = arr.filter(t => t.outcome === "WIN").length;
    const net = arr.reduce((s, t) => s + t.pnlNet, 0);
    const wr = w / arr.length * 100;
    const bar = "█".repeat(Math.floor(arr.length / 50));
    console.log(`  ${h.toString().padStart(2, '0')}h ${arr.length.toString().padStart(4)} · WR ${wr.toFixed(1).padStart(5)}% · NET $${(net / 1000).toFixed(0).padStart(4)}k ${bar}`);
  }

  // Day of week
  console.log(`\n=== DAY OF WEEK (UTC, 0=Sun) ===`);
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const byDow: Trade[][] = Array.from({ length: 7 }, () => []);
  for (const t of trades) byDow[t.dayOfWeek].push(t);
  for (let d = 0; d < 7; d++) {
    const arr = byDow[d];
    if (!arr.length) continue;
    const w = arr.filter(t => t.outcome === "WIN").length;
    const net = arr.reduce((s, t) => s + t.pnlNet, 0);
    console.log(`  ${dayNames[d]} ${arr.length.toString().padStart(4)} · WR ${(w / arr.length * 100).toFixed(1).padStart(5)}% · NET $${(net / 1000).toFixed(0).padStart(4)}k`);
  }

  // Monthly density (skip first/last partial)
  console.log(`\n=== MONTHLY ENTRY DENSITY ===`);
  const byMonth: Record<string, Trade[]> = {};
  for (const t of trades) (byMonth[t.monthYear] ??= []).push(t);
  const months = Object.keys(byMonth).sort();
  console.log(`  Months: ${months.length} (${months[0]} → ${months[months.length - 1]})`);
  const counts = months.map(m => byMonth[m].length);
  console.log(`  Min/Max trades/month: ${Math.min(...counts)} / ${Math.max(...counts)}`);
  console.log(`  Avg trades/month: ${(trades.length / months.length).toFixed(0)}`);
  const wrByMonth = months.map(m => {
    const arr = byMonth[m];
    return arr.filter(t => t.outcome === "WIN").length / arr.length * 100;
  });
  console.log(`  WR variance: ${Math.min(...wrByMonth).toFixed(1)}% → ${Math.max(...wrByMonth).toFixed(1)}%`);

  // Sequential pattern — max winning/losing streaks
  console.log(`\n=== SEQUENTIAL PATTERN ===`);
  let curWin = 0, curLoss = 0, maxWin = 0, maxLoss = 0;
  // Sort by time
  const sorted = [...trades].sort((a, b) => a.bar5mTime - b.bar5mTime);
  for (const t of sorted) {
    if (t.outcome === "WIN") { curWin++; curLoss = 0; if (curWin > maxWin) maxWin = curWin; }
    else { curLoss++; curWin = 0; if (curLoss > maxLoss) maxLoss = curLoss; }
  }
  console.log(`  Max winning streak: ${maxWin}`);
  console.log(`  Max losing streak: ${maxLoss}`);

  // Save full trades JSON for further analysis
  const out = {
    preset: PRESET,
    period: { from: new Date(c5[0].time).toISOString(), to: new Date(c5[c5.length - 1].time).toISOString() },
    summary: { total: trades.length, wins, losses, totalNet, wr: wins / trades.length * 100 },
    bySource: Object.fromEntries(Object.entries(bySrc).map(([k, v]) => [k, {
      count: v.length, wr: v.filter(t => t.outcome === "WIN").length / v.length * 100,
      net: v.reduce((s, t) => s + t.pnlNet, 0),
    }])),
    bySide: Object.fromEntries(Object.entries(bySide).map(([k, v]) => [k, {
      count: v.length, wr: v.filter(t => t.outcome === "WIN").length / v.length * 100,
      net: v.reduce((s, t) => s + t.pnlNet, 0),
    }])),
    hourOfDay: byHour.map((arr, h) => ({ h, count: arr.length, wr: arr.length ? arr.filter(t => t.outcome === "WIN").length / arr.length * 100 : 0, net: arr.reduce((s, t) => s + t.pnlNet, 0) })),
    dayOfWeek: byDow.map((arr, d) => ({ d, count: arr.length, wr: arr.length ? arr.filter(t => t.outcome === "WIN").length / arr.length * 100 : 0, net: arr.reduce((s, t) => s + t.pnlNet, 0) })),
    sequential: { maxWinningStreak: maxWin, maxLosingStreak: maxLoss },
    monthly: months.map(m => ({ month: m, count: byMonth[m].length, wr: byMonth[m].filter(t => t.outcome === "WIN").length / byMonth[m].length * 100 })),
  };
  const assetsDir = join(__dirname, "..", "assets");
  if (!existsSync(assetsDir)) mkdirSync(assetsDir, { recursive: true });
  const outPath = join(assetsDir, "analyze_whale_max_66_entries.json");
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\n💾 Saved: ${outPath}`);
})();
