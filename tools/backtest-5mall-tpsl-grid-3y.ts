/**
 * backtest-5mall-tpsl-grid-3y.ts (anh Tommy 2026-04-28 — Option B grid)
 *
 * Sweep TP × SL grid lớn cho 5 preset hiện tại (v4.8.23):
 *   - TP: [3, 4, 5, 6, 7, 8, 10, 12]  (8 values)
 *   - SL: [2, 2.5, 3, 4, 5, 6, 8]     (7 values)
 *   - Combos: 56 × 5 preset = 280 runs
 *
 * Hold preset gốc (stack/cooldown/stoch/srProx/srLB) — chỉ vary TP/SL.
 * Output: bảng compare + JSON + HTML heatmap report.
 *
 * Usage:
 *   npx tsx tools/backtest-5mall-tpsl-grid-3y.ts
 *   npx tsx tools/backtest-5mall-tpsl-grid-3y.ts --years=1
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { Candle } from "../utils/backtester";
import { calcStochRSISeries } from "../utils/indicators";

const BINANCE_REST = "https://api.binance.com/api/v3";
const args = process.argv.slice(2);
const YEARS = parseFloat(args.find((a) => a.startsWith("--years="))?.replace("--years=", "") || "3");

const INITIAL_CAPITAL = 5000;
const MARGIN_PER_TRADE = 30;
const LEVERAGE = 100;
const NOTIONAL = MARGIN_PER_TRADE * LEVERAGE;
const FEE_PER_SIDE_PCT = 0.05;
const FEE_PER_SIDE = NOTIONAL * (FEE_PER_SIDE_PCT / 100);

const BARS_PER_YEAR_5M = 365 * 24 * 12;
const BARS_PER_YEAR_15M = 365 * 24 * 4;

// 2026-04-28 (anh Tommy Option B): grid TP/SL lớn — 56 combos × 5 preset = 280 runs
const TP_LIST = [3, 4, 5, 6, 7, 8, 10, 12];
const SL_LIST = [2, 2.5, 3, 4, 5, 6, 8];

type Side = "LONG" | "SHORT";
type EntrySource = "stoch_long" | "stoch_short" | "sr_long" | "sr_short";

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
}

// 5 preset hiện tại (mirror utils/all5mAccount.ts v4.8.23 PRESETS).
// tpPct/slPct là PLACEHOLDER — sẽ override theo TP_LIST × SL_LIST grid.
const BASE_PRESETS: PresetDef[] = [
  {
    key: "WHALE_MAX", label: "WHALE 200", emoji: "🔴",
    tpPct: 5, slPct: 2.5,
    stackMaxPerSide: 200, stackMinEntryDistPct: 0, stackPerSideSpacingMin: 0,
    cooldownMin: 5, stochLongLevel: 10, stochShortLevel: 90,
    srProximityPct: 0.4, srLookback15m: 30,
  },
  {
    key: "WHALE_MID", label: "WHALE 100", emoji: "🟠",
    tpPct: 5, slPct: 2.5,
    stackMaxPerSide: 100, stackMinEntryDistPct: 0, stackPerSideSpacingMin: 0,
    cooldownMin: 5, stochLongLevel: 10, stochShortLevel: 90,
    srProximityPct: 0.4, srLookback15m: 30,
  },
  {
    key: "TOMI_MAX", label: "TOMI 200", emoji: "🔵",
    tpPct: 4, slPct: 4,
    stackMaxPerSide: 200, stackMinEntryDistPct: 0, stackPerSideSpacingMin: 0,
    cooldownMin: 5, stochLongLevel: 5, stochShortLevel: 95,
    srProximityPct: 0.2, srLookback15m: 50,
  },
  {
    key: "TOMI_MID", label: "TOMI 100", emoji: "🟢",
    tpPct: 4, slPct: 4,
    stackMaxPerSide: 100, stackMinEntryDistPct: 0, stackPerSideSpacingMin: 0,
    cooldownMin: 5, stochLongLevel: 5, stochShortLevel: 95,
    srProximityPct: 0.2, srLookback15m: 50,
  },
  {
    key: "TOMI_MIN", label: "TOMI 50", emoji: "⚪",
    tpPct: 4, slPct: 4,
    stackMaxPerSide: 50, stackMinEntryDistPct: 0, stackPerSideSpacingMin: 0,
    cooldownMin: 5, stochLongLevel: 5, stochShortLevel: 95,
    srProximityPct: 0.2, srLookback15m: 50,
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
}

// ─── Main backtest runner (fixed TP/SL only, no trailing) ───────────────────
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

    // Plan B monitor (fixed TP/SL)
    for (let pi = open.length - 1; pi >= 0; pi--) {
      const p = open[pi];
      if (p.entryIdx >= i) continue;
      let outcome: "WIN" | "LOSS" | null = null;
      let exitPrice = close;
      if (p.side === "LONG") {
        if (bar.low <= p.slPrice) { outcome = "LOSS"; exitPrice = p.slPrice; }
        else if (bar.high >= p.tpPrice) { outcome = "WIN"; exitPrice = p.tpPrice; }
      } else {
        if (bar.high >= p.slPrice) { outcome = "LOSS"; exitPrice = p.slPrice; }
        else if (bar.low <= p.tpPrice) { outcome = "WIN"; exitPrice = p.tpPrice; }
      }
      if (!outcome) continue;
      const rawPct = p.side === "LONG"
        ? ((exitPrice - p.entryPrice) / p.entryPrice) * 100
        : ((p.entryPrice - exitPrice) / p.entryPrice) * 100;
      // v2 (anh Tommy 2026-05-02 fix CROSS): KHÔNG cap loss tại -margin.
      // Anh dùng cross margin → loss = full leveraged. Vd SL=6% × 100x = -6 × margin.
      // Bug cũ cap tại -margin → understate loss 6x → backtest result SAI.
      const grossPnl = MARGIN_PER_TRADE * rawPct * LEVERAGE / 100;
      const netPnl = grossPnl - 2 * FEE_PER_SIDE;
      capital += netPnl;
      trades.push({
        bar5mTime: p.bar5mTime, side: p.side, source: p.source,
        entryPrice: p.entryPrice, exitPrice, exitMs: t,
        outcome, pnlPct: rawPct, netUsd: netPnl, holdBars: i - p.entryIdx,
      });
      equityPerTrade.push(capital);
      open.splice(pi, 1);
    }

    // Try entry
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
      bar5mTime: t, entryIdx: i, side, source,
      entryPrice: close, entryMs: t, tpPrice, slPrice,
    });
    lastEntryMs = t;
  }
  return { trades, finalCapital: capital, equityPerTrade };
}

function calcStats(trades: TradeOutcome[], finalCapital: number, equityPerTrade: number[]) {
  const total = trades.length;
  const wins = trades.filter((t) => t.outcome === "WIN").length;
  const losses = trades.filter((t) => t.outcome === "LOSS").length;
  const winRate = total ? (wins / total) * 100 : 0;
  const netUsd = trades.reduce((s, t) => s + t.netUsd, 0);
  const roi = ((finalCapital - INITIAL_CAPITAL) / INITIAL_CAPITAL) * 100;

  const fullCurve = [INITIAL_CAPITAL, ...equityPerTrade];
  let peak = INITIAL_CAPITAL, maxDD = 0, maxDDPct = 0;
  for (const v of fullCurve) {
    if (v > peak) peak = v;
    const dd = peak - v;
    if (dd > maxDD) { maxDD = dd; maxDDPct = peak > 0 ? (dd / peak) * 100 : 0; }
  }

  const gw = trades.filter((t) => t.netUsd > 0).reduce((s, t) => s + t.netUsd, 0);
  const gl = Math.abs(trades.filter((t) => t.netUsd < 0).reduce((s, t) => s + t.netUsd, 0));
  const pf = gl > 0 ? gw / gl : (gw > 0 ? 999 : 0);
  const avgHold = total ? trades.reduce((s, t) => s + t.holdBars, 0) / total : 0;

  // Equity curve trend: slope last 30% trades vs first 30%
  let equityTrend: "UP" | "FLAT" | "DOWN" = "FLAT";
  if (fullCurve.length > 10) {
    const seg = Math.max(2, Math.floor(fullCurve.length * 0.3));
    const startMid = fullCurve.slice(0, seg).reduce((s, v) => s + v, 0) / seg;
    const endMid = fullCurve.slice(-seg).reduce((s, v) => s + v, 0) / seg;
    const delta = (endMid - startMid) / Math.max(1, startMid);
    if (delta > 0.05) equityTrend = "UP";
    else if (delta < -0.05) equityTrend = "DOWN";
  }

  // Downsample to 100 points (per CLAUDE.md spec)
  const MAX_PTS = 100;
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
    maxDrawdownPct: +maxDDPct.toFixed(2),
    profitFactor: pf === 999 ? 999 : +pf.toFixed(3),
    avgHoldBars: +avgHold.toFixed(1),
    equityCurve,
    equityTrend,
    peakCapital: +peak.toFixed(2),
  };
}

// ─── HTML report ─────────────────────────────────────────────────────────────
function genHtml(results: any[], years: number, range: { from: number; to: number }): string {
  const fromStr = new Date(range.from).toISOString().slice(0, 10);
  const toStr = new Date(range.to).toISOString().slice(0, 10);
  const sorted = [...results].sort((a, b) => b.netUsd - a.netUsd);
  const winner = sorted[0];
  const safest = [...results].filter((r) => r.netUsd > 0).sort((a, b) => a.maxDrawdownPct - b.maxDrawdownPct)[0];

  const presetKeys = Array.from(new Set(results.map((r) => r.preset)));
  const tpVals = Array.from(new Set(results.map((r) => r.tpPct))).sort((a, b) => a - b);
  const slVals = Array.from(new Set(results.map((r) => r.slPct))).sort((a, b) => a - b);

  // Heatmap NET — color scale: red (loss) → black (zero) → green (gain), log-ish
  function netColor(net: number, max: number): string {
    if (net <= 0) return `rgba(248, 113, 113, ${Math.min(1, Math.abs(net) / Math.max(1, max) * 1.5 + 0.2)})`;
    const pct = Math.min(1, Math.log10(Math.max(1, net)) / Math.log10(Math.max(1, max)));
    return `rgba(74, 222, 128, ${0.2 + 0.7 * pct})`;
  }
  const maxNetAbs = Math.max(...results.map((r) => Math.abs(r.netUsd)));

  const heatmaps = presetKeys.map((pk) => {
    const subset = results.filter((r) => r.preset === pk);
    const sample = subset[0];
    const presetBest = subset.reduce((a, b) => (b.netUsd > a.netUsd ? b : a));
    // Build TP × SL grid
    const headerCells = `<th>TP↓ \\ SL→</th>` + slVals.map((sl) => `<th>${sl}</th>`).join("");
    const rows = tpVals.map((tp) => {
      const cells = slVals.map((sl) => {
        const cell = subset.find((r) => r.tpPct === tp && r.slPct === sl);
        if (!cell) return `<td>—</td>`;
        const isBest = cell === presetBest ? "⭐" : "";
        const tooltip = `${cell.tpPct}/${cell.slPct} | NET $${cell.netUsd.toFixed(0)} | DD ${cell.maxDrawdownPct.toFixed(1)}% | PF ${cell.profitFactor} | WR ${cell.winRate.toFixed(0)}% | ${cell.total}t`;
        return `<td class="cell" style="background:${netColor(cell.netUsd, maxNetAbs)}" title="${tooltip}">
          <div class="net">$${(cell.netUsd / 1000).toFixed(0)}k${isBest}</div>
          <div class="sub">DD ${cell.maxDrawdownPct.toFixed(1)}% · PF ${cell.profitFactor}</div>
        </td>`;
      }).join("");
      return `<tr><th>${tp}</th>${cells}</tr>`;
    }).join("\n");
    return `<div class="block">
      <h3>${sample.emoji} ${pk} <span class="meta">stack=${sample.stackMaxPerSide} · best ⭐ TP=${presetBest.tpPct}/SL=${presetBest.slPct} → NET $${presetBest.netUsd.toFixed(0)}</span></h3>
      <table class="grid"><thead><tr>${headerCells}</tr></thead><tbody>${rows}</tbody></table>
    </div>`;
  }).join("\n");

  // Top 30 ranking table
  const topRows = sorted.slice(0, 30).map((r, i) => {
    const trendBadge = r.equityTrend === "UP" ? "🟢 UP" : r.equityTrend === "DOWN" ? "🔴 DOWN" : "⚪ FLAT";
    const flag = r === winner ? " 🏆" : r === safest ? " 🛡️" : "";
    return `<tr>
      <td>${i + 1}${flag}</td>
      <td>${r.emoji} <b>${r.preset}</b></td>
      <td>${r.tpPct}/${r.slPct}</td>
      <td>${r.stackMaxPerSide}</td>
      <td>${r.total}</td>
      <td>${r.winRate.toFixed(1)}%</td>
      <td class="${r.netUsd >= 0 ? 'pos' : 'neg'}">$${r.netUsd.toLocaleString()}</td>
      <td>$${r.maxDrawdownUsd.toLocaleString()}</td>
      <td>${r.maxDrawdownPct.toFixed(1)}%</td>
      <td>${r.profitFactor}</td>
      <td>${trendBadge}</td>
    </tr>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>5m ALL TP/SL Grid Sweep ${years}y</title>
<style>
body { font-family: -apple-system, sans-serif; background: #0a0a1a; color: #e8e8f0; padding: 24px; max-width: 1600px; margin: 0 auto; }
h1 { color: #ffd700; }
h3 { color: #ffd700; margin: 24px 0 8px; }
h3 .meta { color: #888; font-size: 13px; font-weight: normal; }
.meta { color: #888; margin-bottom: 24px; font-size: 13px; }
table { border-collapse: collapse; margin-top: 16px; font-size: 13px; }
th, td { border: 1px solid #2a2a40; padding: 8px 10px; text-align: right; }
th { background: #1a1a2e; color: #ffd700; }
table.grid td.cell { padding: 6px 10px; min-width: 90px; }
table.grid td.cell .net { font-weight: 700; font-size: 13px; }
table.grid td.cell .sub { font-size: 10px; color: #ddd; }
.block { margin-bottom: 32px; }
.rank-table { width: 100%; }
.rank-table th:nth-child(2), .rank-table td:nth-child(2) { text-align: left; }
tr:nth-child(even) td { background: #11111e; }
.pos { color: #4ade80; font-weight: 600; }
.neg { color: #f87171; font-weight: 600; }
.legend { margin-top: 16px; font-size: 13px; color: #aaa; }
.legend b { color: #ffd700; }
</style></head>
<body>
<h1>🎯 5m ALL — TP/SL Grid Sweep (${years}y backtest)</h1>
<div class="meta">
  Period: ${fromStr} → ${toStr} · Capital $${INITIAL_CAPITAL} · Margin $${MARGIN_PER_TRADE}×${LEVERAGE}x · Fee ${FEE_PER_SIDE_PCT}%/side<br>
  ${presetKeys.length} PRESET × ${tpVals.length} TP × ${slVals.length} SL = ${results.length} combo · Hold preset gốc, vary TP/SL
</div>

<h2>📊 Heatmap NET per preset (cell = TP × SL, ⭐ = best per preset)</h2>
${heatmaps}

<h2>📋 TOP 30 by NET</h2>
<table class="rank-table">
<thead><tr>
  <th>RANK</th><th>PRESET</th><th>TP/SL</th><th>STACK</th><th>TRADES</th><th>WR</th>
  <th>NET $</th><th>MAX DD $</th><th>DD %</th><th>PF</th><th>TREND</th>
</tr></thead>
<tbody>${topRows}</tbody>
</table>

<div class="legend">
  <b>🏆 WINNER</b> = highest NET · <b>🛡️ SAFEST</b> = lowest DD% (NET>0) · <b>⭐</b> = best TP/SL per preset · <b>TREND</b> = equity slope (UP/FLAT/DOWN)<br>
  Color heatmap: green = profit (log-scale), red = loss. Hover cell để xem detail.
</div>

</body></html>`;
}

// ─── Main ────────────────────────────────────────────────────────────────────
(async () => {
  const total5m = Math.ceil(YEARS * BARS_PER_YEAR_5M);
  const total15m = Math.ceil(YEARS * BARS_PER_YEAR_15M);

  console.log(`\n=== BACKTEST 5m ALL — TP/SL GRID SWEEP (${YEARS}y) ===`);
  console.log(`${BASE_PRESETS.length} preset × ${TP_LIST.length} TP × ${SL_LIST.length} SL = ${BASE_PRESETS.length * TP_LIST.length * SL_LIST.length} combo`);
  console.log(`TP grid: [${TP_LIST.join(", ")}]`);
  console.log(`SL grid: [${SL_LIST.join(", ")}]`);
  console.log(`Capital=$${INITIAL_CAPITAL} margin=$${MARGIN_PER_TRADE}×${LEVERAGE}x fee=${FEE_PER_SIDE_PCT}%/side\n`);

  console.log(`Loading data...`);
  const c5 = await fetchKlinesCached("5m", total5m, YEARS);
  const c15 = await fetchKlinesCached("15m", total15m, YEARS);
  console.log(`5m: ${c5.length} bars · 15m: ${c15.length} bars`);
  const fromStr = new Date(c5[0].time).toISOString().slice(0, 10);
  const toStr = new Date(c5[c5.length - 1].time).toISOString().slice(0, 10);
  console.log(`Range: ${fromStr} → ${toStr}\n`);

  console.log(`Computing StochRSI(14,14,3,3)...`);
  const closes5 = c5.map((x) => x.close);
  const { kSeries: stochK } = calcStochRSISeries(closes5, 14, 14, 3, 3);

  const results: any[] = [];

  let idx = 0;
  const totalRuns = BASE_PRESETS.length * TP_LIST.length * SL_LIST.length;
  for (const base of BASE_PRESETS) {
    for (const tp of TP_LIST) {
      for (const sl of SL_LIST) {
        idx++;
        const preset: PresetDef = { ...base, tpPct: tp, slPct: sl };
        process.stdout.write(`[${String(idx).padStart(3)}/${totalRuns}] ${base.emoji} ${base.key} TP=${tp}/SL=${sl}...`);
        const t0 = Date.now();
        const { trades, finalCapital, equityPerTrade } = runBacktest(preset, c5, stochK, c15);
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        const stats = calcStats(trades, finalCapital, equityPerTrade);
        process.stdout.write(` ${trades.length} trades · ${elapsed}s · NET $${stats.netUsd.toFixed(0)}\n`);
        results.push({
          preset: base.key, emoji: base.emoji, label: base.label,
          stackMaxPerSide: base.stackMaxPerSide,
          tpPct: tp, slPct: sl,
          ...stats,
        });
      }
    }
  }

  // ─── Comparison table ─────────────────────────────────────────────────────
  const pad = (s: string | number, n: number) => String(s).padStart(n);
  console.log(`\n${"─".repeat(120)}`);
  console.log(
    `${"PRESET".padEnd(11)} ${pad("TP/SL", 8)} ${pad("STACK", 6)} ${pad("TRADES", 8)} ${pad("WR%", 7)} ` +
    `${pad("NET $", 12)} ${pad("MAX DD $", 10)} ${pad("DD%", 7)} ${pad("PF", 7)} ${pad("TREND", 7)} ${pad("HOLD", 8)}`
  );
  console.log(`${"─".repeat(120)}`);

  // Sort by NET descending for display — top 30 only
  const sorted = [...results].sort((a, b) => b.netUsd - a.netUsd);
  console.log(`\n📊 TOP 30 by NET:`);
  for (const r of sorted.slice(0, 30)) {
    console.log(
      `${(r.emoji + " " + r.preset).padEnd(11)} ` +
      `${pad(`${r.tpPct}/${r.slPct}`, 8)} ` +
      `${pad(r.stackMaxPerSide, 6)} ${pad(r.total, 8)} ${pad(r.winRate.toFixed(1) + "%", 7)} ` +
      `${pad("$" + r.netUsd.toFixed(0), 12)} ${pad("$" + r.maxDrawdownUsd.toFixed(0), 10)} ` +
      `${pad(r.maxDrawdownPct.toFixed(1) + "%", 7)} ${pad(r.profitFactor, 7)} ` +
      `${pad(r.equityTrend, 7)} ${pad(r.avgHoldBars.toFixed(1) + "b", 8)}`
    );
  }
  console.log(`${"─".repeat(120)}`);

  const winner = sorted[0];
  const safest = [...results].filter((r) => r.netUsd > 0).sort((a, b) => a.maxDrawdownPct - b.maxDrawdownPct)[0];
  // Best risk-adjusted: max NET/MaxDD ratio (NET cao, DD thấp)
  const bestRisk = [...results].filter((r) => r.maxDrawdownUsd > 0 && r.netUsd > 0)
    .sort((a, b) => (b.netUsd / b.maxDrawdownUsd) - (a.netUsd / a.maxDrawdownUsd))[0];

  console.log(`\n🏆 WINNER (highest NET): ${winner.emoji} ${winner.preset} TP=${winner.tpPct}/SL=${winner.slPct} → NET $${winner.netUsd.toFixed(0)} (DD ${winner.maxDrawdownPct.toFixed(1)}%, PF ${winner.profitFactor})`);
  console.log(`🛡️ SAFEST (lowest DD% w/ NET>0): ${safest.emoji} ${safest.preset} TP=${safest.tpPct}/SL=${safest.slPct} → DD ${safest.maxDrawdownPct.toFixed(1)}% (NET $${safest.netUsd.toFixed(0)})`);
  console.log(`⚖️ BEST RISK-ADJ (NET/DD): ${bestRisk.emoji} ${bestRisk.preset} TP=${bestRisk.tpPct}/SL=${bestRisk.slPct} → ratio ${(bestRisk.netUsd / bestRisk.maxDrawdownUsd).toFixed(1)}× (NET $${bestRisk.netUsd.toFixed(0)}, DD ${bestRisk.maxDrawdownPct.toFixed(1)}%)`);

  // Per-preset best TP/SL
  console.log(`\n📌 BEST TP/SL PER PRESET (by NET):`);
  for (const base of BASE_PRESETS) {
    const subset = results.filter((r) => r.preset === base.key);
    const best = subset.reduce((a, b) => (b.netUsd > a.netUsd ? b : a));
    const cur = subset.find((r) => r.tpPct === base.tpPct && r.slPct === base.slPct);
    const delta = cur ? best.netUsd - cur.netUsd : 0;
    const deltaPct = cur && cur.netUsd > 0 ? ((best.netUsd / cur.netUsd) - 1) * 100 : 0;
    const change = best.tpPct === base.tpPct && best.slPct === base.slPct ? "(NO CHANGE)" : `(was ${base.tpPct}/${base.slPct} → +$${delta.toFixed(0)} = +${deltaPct.toFixed(1)}%)`;
    console.log(`   ${base.emoji} ${base.key}: TP=${best.tpPct}/SL=${best.slPct} → NET $${best.netUsd.toFixed(0)} (DD ${best.maxDrawdownPct.toFixed(1)}%, ${best.total} trades) ${change}`);
  }

  // ─── Save JSON + HTML ─────────────────────────────────────────────────────
  const assetsDir = join(__dirname, "..", "assets");
  if (!existsSync(assetsDir)) mkdirSync(assetsDir, { recursive: true });

  const out = {
    generated_at: new Date().toISOString(),
    years: YEARS,
    initialCapital: INITIAL_CAPITAL,
    margin: MARGIN_PER_TRADE,
    leverage: LEVERAGE,
    feePerSidePct: FEE_PER_SIDE_PCT,
    range: { from: c5[0].time, to: c5[c5.length - 1].time, fromStr, toStr },
    tpList: TP_LIST,
    slList: SL_LIST,
    presets: BASE_PRESETS.map((p) => ({ key: p.key, label: p.label, emoji: p.emoji, baseTpPct: p.tpPct, baseSlPct: p.slPct, stackMaxPerSide: p.stackMaxPerSide })),
    results,
    winner: { preset: winner.preset, tp: winner.tpPct, sl: winner.slPct, netUsd: winner.netUsd },
    safest: { preset: safest.preset, tp: safest.tpPct, sl: safest.slPct, ddPct: safest.maxDrawdownPct },
    bestRiskAdjusted: { preset: bestRisk.preset, tp: bestRisk.tpPct, sl: bestRisk.slPct, ratio: bestRisk.netUsd / bestRisk.maxDrawdownUsd },
  };
  const jsonPath = join(assetsDir, "backtest_5mall_tpsl_grid_3y.json");
  writeFileSync(jsonPath, JSON.stringify(out, null, 2));
  console.log(`\n💾 JSON  → ${jsonPath}`);

  const htmlPath = join(assetsDir, "backtest_5mall_tpsl_grid_3y_report.html");
  writeFileSync(htmlPath, genHtml(results, YEARS, out.range));
  console.log(`💾 HTML  → ${htmlPath}`);
})();
