/**
 * backtest-tomi5mall-compare-3y.ts
 *
 * So sánh 4 preset 5m ALL (WHALE / EAGLE / TURTLE / TOMI) trên 3 năm BTC data.
 *
 * TOMI: Stoch K<1→LONG / K>99→SHORT + PnL milestone trailing SL.
 *   - Mỗi milestone N×100% leveraged PnL hit → SL ratchet lên (N-1)×100% PnL.
 *   - Không có fixed TP — chỉ exit khi SL hit.
 *   - Initial SL = 2% raw (slPct = 2).
 *
 * Usage:
 *   npx tsx tools/backtest-tomi5mall-compare-3y.ts
 *   npx tsx tools/backtest-tomi5mall-compare-3y.ts --years=1
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { Candle } from "../utils/backtester";
import { calcStochRSISeries } from "../utils/indicators";

const BINANCE_REST = "https://api.binance.com/api/v3";
const args = process.argv.slice(2);
const YEARS = parseFloat(args.find((a) => a.startsWith("--years="))?.replace("--years=", "") || "3");

// Engine constants (mirror utils/all5mAccount.ts)
const INITIAL_CAPITAL = 5000;
const MARGIN_PER_TRADE = 30;
const LEVERAGE = 100;
const NOTIONAL = MARGIN_PER_TRADE * LEVERAGE;
const FEE_PER_SIDE_PCT = 0.05;
const FEE_PER_SIDE = NOTIONAL * (FEE_PER_SIDE_PCT / 100); // $1.5

const BARS_PER_YEAR_5M = 365 * 24 * 12;
const BARS_PER_YEAR_15M = 365 * 24 * 4;

type Side = "LONG" | "SHORT";
type EntrySource = "stoch_long" | "stoch_short" | "sr_long" | "sr_short";

// ─── Preset definitions (mirror all5mAccount.ts PRESETS) ────────────────────
interface PresetDef {
  key: string;
  label: string;
  emoji: string;
  tpPct: number;
  slPct: number;
  stackMaxPerSide: number;
  stackMinEntryDistPct: number;
  stackPerSideSpacingMin: number;
  cooldownMin: number;
  stochLongLevel: number;
  stochShortLevel: number;
  srProximityPct: number;
  srLookback15m: number;
  trailingStopEnabled?: boolean;
  /** Trail bắt đầu từ milestone này (default 1 = trail về hòa vốn khi PnL 100%) */
  trailStartMilestone?: number;
}

const PRESETS: PresetDef[] = [
  {
    key: "WHALE", label: "WHALE", emoji: "🔴",
    tpPct: 5, slPct: 2.5,
    stackMaxPerSide: 75, stackMinEntryDistPct: 0, stackPerSideSpacingMin: 0,
    cooldownMin: 5, stochLongLevel: 10, stochShortLevel: 90,
    srProximityPct: 0.4, srLookback15m: 30,
  },
  {
    key: "EAGLE", label: "EAGLE", emoji: "🟡",
    tpPct: 5, slPct: 2.5,
    stackMaxPerSide: 30, stackMinEntryDistPct: 0.1, stackPerSideSpacingMin: 10,
    cooldownMin: 5, stochLongLevel: 15, stochShortLevel: 85,
    srProximityPct: 0.4, srLookback15m: 50,
  },
  {
    key: "TURTLE", label: "TURTLE", emoji: "🟢",
    tpPct: 3.5, slPct: 2,
    stackMaxPerSide: 15, stackMinEntryDistPct: 0.3, stackPerSideSpacingMin: 10,
    cooldownMin: 15, stochLongLevel: 10, stochShortLevel: 90,
    srProximityPct: 0.4, srLookback15m: 80,
  },
  {
    key: "TOMI", label: "TOMI", emoji: "🔵",
    tpPct: 9999, slPct: 2,
    stackMaxPerSide: 50, stackMinEntryDistPct: 0, stackPerSideSpacingMin: 0,
    cooldownMin: 5, stochLongLevel: 5, stochShortLevel: 95,
    srProximityPct: 0.2, srLookback15m: 50,
    trailingStopEnabled: true,
    trailStartMilestone: 2,   // tắt trail hòa vốn: trail bắt đầu từ milestone 2
  },
];

// ─── Data fetching (cached) ──────────────────────────────────────────────────
async function fetchKlinesRaw(interval: string, total: number): Promise<Candle[]> {
  const all: Candle[] = [];
  let endTime: number | undefined;
  while (all.length < total) {
    const remaining = total - all.length;
    const limit = Math.min(1000, remaining);
    const params = new URLSearchParams({ symbol: "BTCUSDT", interval, limit: String(limit) });
    if (endTime) params.set("endTime", String(endTime));
    const res = await fetch(`${BINANCE_REST}/klines?${params.toString()}`);
    const data: any[] = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;
    const batch: Candle[] = data.map((k) => ({
      time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
      low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
    }));
    all.unshift(...batch);
    endTime = batch[0].time - 1;
    await new Promise((r) => setTimeout(r, 200));
  }
  const byTime = new Map<number, Candle>();
  for (const c of all) byTime.set(c.time, c);
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

async function fetchKlinesCached(interval: string, total: number, years: number): Promise<Candle[]> {
  const cacheDir = join(__dirname, "..", ".cache");
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
  const cachePath = join(cacheDir, `binance-${interval}-${years}y.json`);
  if (existsSync(cachePath)) {
    try {
      const data = JSON.parse(readFileSync(cachePath, "utf8")) as Candle[];
      if (Array.isArray(data) && data.length >= total * 0.9) {
        console.log(`  [cache] ${interval} ${data.length} bars`);
        return data;
      }
    } catch {}
  }
  process.stdout.write(`  Fetching ${interval}...`);
  const fetched = await fetchKlinesRaw(interval, total);
  process.stdout.write(` ${fetched.length} bars\n`);
  writeFileSync(cachePath, JSON.stringify(fetched));
  return fetched;
}

// ─── S/R 15m precompute ──────────────────────────────────────────────────────
function precomputeSR15m(
  candles15m: Candle[],
  lookback: number,
): { support: (number | null)[]; resistance: (number | null)[] } {
  const n = candles15m.length;
  const support: (number | null)[] = new Array(n).fill(null);
  const resistance: (number | null)[] = new Array(n).fill(null);
  for (let i = lookback; i < n; i++) {
    let lo = Infinity, hi = -Infinity;
    for (let j = i - lookback; j < i; j++) {
      if (candles15m[j].low < lo) lo = candles15m[j].low;
      if (candles15m[j].high > hi) hi = candles15m[j].high;
    }
    support[i] = lo === Infinity ? null : lo;
    resistance[i] = hi === -Infinity ? null : hi;
  }
  return { support, resistance };
}

function srAtTime(
  candles15m: Candle[],
  srSupport: (number | null)[],
  srResistance: (number | null)[],
  t: number,
): { support: number | null; resistance: number | null } {
  let lo = 0, hi = candles15m.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles15m[mid].time <= t) { idx = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (idx < 0) return { support: null, resistance: null };
  return { support: srSupport[idx], resistance: srResistance[idx] };
}

// ─── Position type ───────────────────────────────────────────────────────────
interface OpenPos {
  bar5mTime: number;
  entryIdx: number;
  side: Side;
  source: EntrySource;
  entryPrice: number;
  entryMs: number;
  tpPrice: number;
  slPrice: number;
  trailingStopEnabled?: boolean;
  lastTrailMilestone: number;
  trailStartMilestone?: number;
}

interface TradeOutcome {
  bar5mTime: number;
  side: Side;
  source: EntrySource;
  entryPrice: number;
  exitPrice: number;
  exitMs: number;
  outcome: "WIN" | "LOSS";
  pnlPct: number;
  netUsd: number;
  holdBars: number;
  maxMilestone: number;  // TOMI: highest milestone hit during trade
}

// ─── Main backtest runner ────────────────────────────────────────────────────
function runBacktest(
  preset: PresetDef,
  candles5m: Candle[],
  stochK: (number | null)[],
  candles15m: Candle[],
): { trades: TradeOutcome[]; finalCapital: number; equityPerTrade: number[] } {
  const SR_LOOKBACK = preset.srLookback15m;
  const { support: srSupport, resistance: srResistance } = precomputeSR15m(candles15m, SR_LOOKBACK);

  const COOLDOWN_MS = preset.cooldownMin * 60 * 1000;
  const SPACING_MS = preset.stackPerSideSpacingMin * 60 * 1000;

  const trades: TradeOutcome[] = [];
  const open: OpenPos[] = [];
  let lastEntryMs = 0;
  let capital = INITIAL_CAPITAL;
  const equityPerTrade: number[] = [];

  for (let i = SR_LOOKBACK; i < candles5m.length; i++) {
    const bar = candles5m[i];
    const t = bar.time;
    const close = bar.close;

    // ── Plan B monitor: update + check OPEN positions ──────────────────
    for (let pi = open.length - 1; pi >= 0; pi--) {
      const p = open[pi];
      if (p.entryIdx >= i) continue;

      let outcome: "WIN" | "LOSS" | null = null;
      let exitPrice = close;

      if (p.trailingStopEnabled) {
        // ── Tomi5mALL trailing SL ──────────────────────────────────────
        // Step 1: Check SL hit (low for LONG, high for SHORT) at current SL price
        // WIN nếu SL đã trail lên trên entry (profitable exit), LOSS nếu SL dưới entry
        if (p.side === "LONG" && bar.low <= p.slPrice) {
          outcome = p.slPrice >= p.entryPrice ? "WIN" : "LOSS";
          exitPrice = p.slPrice;
        } else if (p.side === "SHORT" && bar.high >= p.slPrice) {
          outcome = p.slPrice <= p.entryPrice ? "WIN" : "LOSS";
          exitPrice = p.slPrice;
        }

        if (!outcome) {
          // Step 2: Check if best price reaches new milestone
          const bestPrice = p.side === "LONG" ? bar.high : bar.low;
          const leveragedPnlPct = (p.side === "LONG"
            ? (bestPrice - p.entryPrice) / p.entryPrice
            : (p.entryPrice - bestPrice) / p.entryPrice) * 100 * LEVERAGE;
          const milestone = Math.max(0, Math.floor(leveragedPnlPct / 100));
          const lastMilestone = p.lastTrailMilestone;

          const trailStart = p.trailStartMilestone ?? 1;
          if (milestone > lastMilestone && milestone >= trailStart) {
            // SL ratchet: milestone N (trailStart=1) → SL tại (N-1)×100% PnL
            //             milestone N (trailStart=2) → SL tại (N-2)×100% PnL
            const trailRawPct = Math.max(0, milestone - trailStart) / LEVERAGE;
            const newSl = p.side === "LONG"
              ? p.entryPrice * (1 + trailRawPct)
              : p.entryPrice * (1 - trailRawPct);
            // Only move SL in favor direction
            if (p.side === "LONG" && newSl > p.slPrice) p.slPrice = newSl;
            if (p.side === "SHORT" && newSl < p.slPrice) p.slPrice = newSl;
            p.lastTrailMilestone = milestone;
          }
        }
      } else {
        // ── Normal fixed TP / SL ───────────────────────────────────────
        if (p.side === "LONG") {
          if (bar.low <= p.slPrice) { outcome = "LOSS"; exitPrice = p.slPrice; }
          else if (bar.high >= p.tpPrice) { outcome = "WIN"; exitPrice = p.tpPrice; }
        } else {
          if (bar.high >= p.slPrice) { outcome = "LOSS"; exitPrice = p.slPrice; }
          else if (bar.low <= p.tpPrice) { outcome = "WIN"; exitPrice = p.tpPrice; }
        }
      }

      if (!outcome) continue;

      const rawPct = p.side === "LONG"
        ? ((exitPrice - p.entryPrice) / p.entryPrice) * 100
        : ((p.entryPrice - exitPrice) / p.entryPrice) * 100;
      let grossPnl = MARGIN_PER_TRADE * rawPct * LEVERAGE / 100;
      if (grossPnl < -MARGIN_PER_TRADE) grossPnl = -MARGIN_PER_TRADE;
      const netPnl = grossPnl - 2 * FEE_PER_SIDE;
      capital += netPnl;

      trades.push({
        bar5mTime: p.bar5mTime,
        side: p.side, source: p.source,
        entryPrice: p.entryPrice,
        exitPrice, exitMs: t,
        outcome,
        pnlPct: rawPct,
        netUsd: netPnl,
        holdBars: i - p.entryIdx,
        maxMilestone: p.lastTrailMilestone,
      });
      equityPerTrade.push(capital);
      open.splice(pi, 1);
    }

    // ── Try entry ─────────────────────────────────────────────────────
    if (open.some((p) => p.bar5mTime === t)) continue;
    if (t - lastEntryMs < COOLDOWN_MS) continue;
    const usedMargin = open.length * MARGIN_PER_TRADE;
    if (capital - usedMargin < MARGIN_PER_TRADE) continue;

    let side: Side | null = null;
    let source: EntrySource | null = null;
    const k = stochK[i];
    if (k !== null && k < preset.stochLongLevel) { side = "LONG"; source = "stoch_long"; }
    else if (k !== null && k > preset.stochShortLevel) { side = "SHORT"; source = "stoch_short"; }
    else {
      const sr = srAtTime(candles15m, srSupport, srResistance, t);
      if (sr.support !== null && sr.resistance !== null) {
        const distSup = ((close - sr.support) / sr.support) * 100;
        const distRes = ((sr.resistance - close) / close) * 100;
        if (distSup >= 0 && distSup <= preset.srProximityPct) { side = "LONG"; source = "sr_long"; }
        else if (distRes >= 0 && distRes <= preset.srProximityPct) { side = "SHORT"; source = "sr_short"; }
      }
    }
    if (!side || !source) continue;

    // SMART STACK gates
    const sameSide = open.filter((p) => p.side === side);
    if (sameSide.length >= preset.stackMaxPerSide) continue;
    if (sameSide.length > 0) {
      const lastSame = sameSide.reduce((a, b) => (a.entryMs > b.entryMs ? a : b));
      if (SPACING_MS > 0 && t - lastSame.entryMs < SPACING_MS) continue;
      if (preset.stackMinEntryDistPct > 0) {
        const distPct = Math.abs(close - lastSame.entryPrice) / lastSame.entryPrice * 100;
        if (distPct < preset.stackMinEntryDistPct) continue;
      }
    }

    const tpPrice = side === "LONG" ? close * (1 + preset.tpPct / 100) : close * (1 - preset.tpPct / 100);
    const slPrice = side === "LONG" ? close * (1 - preset.slPct / 100) : close * (1 + preset.slPct / 100);
    open.push({
      bar5mTime: t, entryIdx: i,
      side, source,
      entryPrice: close, entryMs: t,
      tpPrice, slPrice,
      trailingStopEnabled: preset.trailingStopEnabled,
      lastTrailMilestone: 0,
      trailStartMilestone: preset.trailStartMilestone,
    });
    lastEntryMs = t;
  }

  return { trades, finalCapital: capital, equityPerTrade };
}

// ─── Stats helpers ───────────────────────────────────────────────────────────
function calcStats(trades: TradeOutcome[], finalCapital: number, equityPerTrade: number[]) {
  const total = trades.length;
  const wins = trades.filter((t) => t.outcome === "WIN").length;
  const losses = trades.filter((t) => t.outcome === "LOSS").length;
  const winRate = total ? (wins / total) * 100 : 0;
  const netUsd = trades.reduce((s, t) => s + t.netUsd, 0);
  const roi = ((finalCapital - INITIAL_CAPITAL) / INITIAL_CAPITAL) * 100;

  const fullCurve = [INITIAL_CAPITAL, ...equityPerTrade];
  let peak = INITIAL_CAPITAL, maxDD = 0;
  for (const v of fullCurve) {
    if (v > peak) peak = v;
    const dd = peak - v;
    if (dd > maxDD) maxDD = dd;
  }

  const gw = trades.filter((t) => t.netUsd > 0).reduce((s, t) => s + t.netUsd, 0);
  const gl = Math.abs(trades.filter((t) => t.netUsd < 0).reduce((s, t) => s + t.netUsd, 0));
  const pf = gl > 0 ? gw / gl : (gw > 0 ? 999 : 0);
  const avgHold = total ? trades.reduce((s, t) => s + t.holdBars, 0) / total : 0;

  // Downsample equity curve to 200 points
  const MAX_PTS = 200;
  let equityCurve: number[];
  if (fullCurve.length <= MAX_PTS) {
    equityCurve = fullCurve.map((v) => Math.round(v * 100) / 100);
  } else {
    equityCurve = [];
    for (let i = 0; i < MAX_PTS; i++) {
      const idx = Math.floor((i / (MAX_PTS - 1)) * (fullCurve.length - 1));
      equityCurve.push(Math.round(fullCurve[idx] * 100) / 100);
    }
  }

  return {
    total, wins, losses,
    winRate: +winRate.toFixed(2),
    netUsd: +netUsd.toFixed(2),
    finalCapital: +finalCapital.toFixed(2),
    roi: +roi.toFixed(2),
    maxDrawdownUsd: +maxDD.toFixed(2),
    profitFactor: pf === 999 ? 999 : +pf.toFixed(3),
    avgHoldBars: +avgHold.toFixed(1),
    equityCurve,
    peakCapital: +peak.toFixed(2),
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────
(async () => {
  const total5m = Math.ceil(YEARS * BARS_PER_YEAR_5M);
  const total15m = Math.ceil(YEARS * BARS_PER_YEAR_15M);

  console.log(`\n=== BACKTEST 5m ALL — 4 PRESET COMPARE (${YEARS}y) ===`);
  console.log(`Capital=$${INITIAL_CAPITAL}  margin=$${MARGIN_PER_TRADE}×${LEVERAGE}x  fee=${FEE_PER_SIDE_PCT}%/side\n`);

  console.log(`Loading data...`);
  const c5 = await fetchKlinesCached("5m", total5m, YEARS);
  const c15 = await fetchKlinesCached("15m", total15m, YEARS);
  console.log(`5m: ${c5.length} bars  ·  15m: ${c15.length} bars`);
  console.log(`Range: ${new Date(c5[0].time).toISOString().slice(0,10)} → ${new Date(c5[c5.length-1].time).toISOString().slice(0,10)}\n`);

  console.log(`Computing StochRSI(14,14,3,3) on 5m closes...`);
  const closes5 = c5.map((x) => x.close);
  const { kSeries: stochK } = calcStochRSISeries(closes5, 14, 14, 3, 3);

  const results: any[] = [];

  for (const preset of PRESETS) {
    process.stdout.write(`Running ${preset.emoji} ${preset.key}...`);
    const t0 = Date.now();
    const { trades, finalCapital, equityPerTrade } = runBacktest(preset, c5, stochK, c15);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const stats = calcStats(trades, finalCapital, equityPerTrade);
    process.stdout.write(` ${trades.length} trades · ${elapsed}s\n`);
    results.push({ preset: preset.key, emoji: preset.emoji, label: preset.label, ...stats });
  }

  // ─── Comparison table ─────────────────────────────────────────────────────
  const pad = (s: string | number, n: number) => String(s).padStart(n);
  console.log(`\n${"─".repeat(90)}`);
  console.log(
    `${"PRESET".padEnd(8)} ${pad("TRADES",8)} ${pad("WR%",7)} ${pad("NET $",10)} ` +
    `${pad("FINAL $",10)} ${pad("MAX DD",8)} ${pad("PF",6)} ${pad("AVG HOLD",10)} ${pad("ROI%",8)}`
  );
  console.log(`${"─".repeat(90)}`);
  for (const r of results) {
    console.log(
      `${(r.emoji + " " + r.preset).padEnd(8)} ` +
      `${pad(r.total,8)} ${pad(r.winRate.toFixed(1)+"%",7)} ` +
      `${pad("$"+r.netUsd.toFixed(0),10)} ${pad("$"+r.finalCapital.toFixed(0),10)} ` +
      `${pad("$"+r.maxDrawdownUsd.toFixed(0),8)} ${pad(r.profitFactor,6)} ` +
      `${pad(r.avgHoldBars.toFixed(1)+"b",10)} ${pad(r.roi.toFixed(1)+"%",8)}`
    );
  }
  console.log(`${"─".repeat(90)}`);

  // TOMI extra: milestone distribution
  const tomiResult = results.find((r) => r.preset === "TOMI");
  if (tomiResult) {
    const { trades: tomiTrades } = runBacktest(PRESETS[3], c5, stochK, c15);
    const milestoneHits = tomiTrades.filter((t) => t.maxMilestone >= 1);
    const milestoneDistrib: Record<number, number> = {};
    for (const t of tomiTrades) {
      const m = t.maxMilestone;
      milestoneDistrib[m] = (milestoneDistrib[m] ?? 0) + 1;
    }
    console.log(`\n🔵 TOMI milestone distribution (max milestone per trade):`);
    const milestones = Object.keys(milestoneDistrib).map(Number).sort((a, b) => a - b);
    for (const m of milestones) {
      const count = milestoneDistrib[m];
      const pct = (count / tomiTrades.length * 100).toFixed(1);
      console.log(`  milestone ${m.toString().padStart(3)}: ${count.toString().padStart(5)} trades (${pct}%)`);
    }
    console.log(`  Trades that hit ≥1 milestone: ${milestoneHits.length} (${(milestoneHits.length/tomiTrades.length*100).toFixed(1)}%)`);
  }

  // ─── Save JSON ─────────────────────────────────────────────────────────────
  const assetsDir = join(__dirname, "..", "assets");
  if (!existsSync(assetsDir)) mkdirSync(assetsDir, { recursive: true });
  const outPath = join(assetsDir, "backtest_tomi5mall_compare_3y.json");
  const out = {
    generated_at: new Date().toISOString(),
    years: YEARS,
    initialCapital: INITIAL_CAPITAL,
    margin: MARGIN_PER_TRADE,
    leverage: LEVERAGE,
    feePerSidePct: FEE_PER_SIDE_PCT,
    range: { from: c5[0].time, to: c5[c5.length-1].time },
    results: results.map((r) => ({ ...r })),
  };
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nSaved → ${outPath}`);

  // Update PRESETS expectedNet3y / expectedMaxDd3y for TOMI
  const tomiStats = results.find((r) => r.preset === "TOMI");
  if (tomiStats) {
    console.log(`\n📝 TOMI expected values for all5mAccount.ts:`);
    console.log(`   expectedNet3y: ${Math.round(tomiStats.netUsd)}`);
    console.log(`   expectedMaxDd3y: ${Math.round(tomiStats.maxDrawdownUsd)}`);
  }
})();
