/**
 * backtest-5mall-better-entry-3y.ts
 *
 * Test 5m ALL Engine STANDALONE (paper account, NOT in LIVE) over 3 years
 * BTCUSDT with the new `stackBetterEntryMode` gate.
 *
 * Verifies if "better entry only" rule (4 modes) improves the standalone
 * 5m ALL Engine across 3 presets (WHALE/EAGLE/TURTLE) × 4 modes = 12 runs.
 *
 *   For each preset in [WHALE, EAGLE, TURTLE]:
 *     For each mode in ["off", "vs-last", "vs-best", "vs-avg"]:
 *       runBacktest(preset config + stackBetterEntryMode: mode)
 *
 * Engine logic mirrors utils/all5mAccount.ts::tryEntry5mBar:
 *   - Stoch K < preset.stochLongLevel  → LONG
 *   - Stoch K > preset.stochShortLevel → SHORT
 *   - Else fallback S/R 15m: close ≤ support × (1 + preset.srProximityPct%) → LONG
 *                            close ≥ resistance × (1 - preset.srProximityPct%) → SHORT
 *   - Gates: cooldown (chung), stack max per side, spacing per side,
 *            distance per side, **better-entry per mode**
 *   - Plan B monitor: scan every bar after entry, hit TP/SL → close
 *
 * Capital $5000, margin $30, lev 100x, fee 0.05%/side.
 *
 * Output:
 *   • assets/sweep_5mall_better_entry_3y.json
 *   • assets/sweep_5mall_better_entry_3y_report.html
 *
 * Usage:
 *   npx tsx tools/backtest-5mall-better-entry-3y.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { Candle } from "../utils/backtester";
import { calcStochRSISeries } from "../utils/indicators";

// ─── Constants (mirror utils/all5mAccount.ts) ───────────────────────────────
const YEARS = 3;
const FEE_PER_SIDE_PCT = 0.05;
const INITIAL_CAPITAL = 5000;
const MARGIN_PER_TRADE = 30;
const LEVERAGE = 100;
const NOTIONAL = MARGIN_PER_TRADE * LEVERAGE; // $3000
const FEE_PER_SIDE = NOTIONAL * (FEE_PER_SIDE_PCT / 100); // $1.5

type Side = "LONG" | "SHORT";
type EntrySource = "stoch_long" | "stoch_short" | "sr_long" | "sr_short";
type BetterEntryMode = "off" | "vs-last" | "vs-best" | "vs-avg";

// ─── Preset configs (snapshot of utils/all5mAccount.ts PRESETS) ─────────────
interface PresetCfg {
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

const PRESETS: PresetCfg[] = [
  {
    key: "AGGRESSIVE", label: "WHALE", emoji: "🔴",
    tpPct: 5, slPct: 2.5,
    stackMaxPerSide: 75, stackMinEntryDistPct: 0, stackPerSideSpacingMin: 0,
    cooldownMin: 5,
    stochLongLevel: 10, stochShortLevel: 90,
    srProximityPct: 0.4, srLookback15m: 30,
  },
  {
    key: "BALANCED", label: "EAGLE", emoji: "🟡",
    tpPct: 5, slPct: 2.5,
    stackMaxPerSide: 30, stackMinEntryDistPct: 0.1, stackPerSideSpacingMin: 10,
    cooldownMin: 5,
    stochLongLevel: 15, stochShortLevel: 85,
    srProximityPct: 0.4, srLookback15m: 50,
  },
  {
    key: "SAFE", label: "TURTLE", emoji: "🟢",
    tpPct: 3.5, slPct: 2,
    stackMaxPerSide: 15, stackMinEntryDistPct: 0.3, stackPerSideSpacingMin: 10,
    cooldownMin: 15,
    stochLongLevel: 10, stochShortLevel: 90,
    srProximityPct: 0.4, srLookback15m: 80,
  },
];

const MODES: BetterEntryMode[] = ["off", "vs-last", "vs-best", "vs-avg"];

// ─── Cache load ─────────────────────────────────────────────────────────────
function loadCached(interval: string): Candle[] {
  const cachePath = join(__dirname, "..", ".cache", `binance-${interval}-${YEARS}y.json`);
  if (!existsSync(cachePath)) throw new Error(`Missing cache ${cachePath}`);
  return JSON.parse(readFileSync(cachePath, "utf8")) as Candle[];
}

// ─── S/R 15m precompute ─────────────────────────────────────────────────────
function precomputeSR15m(candles15m: Candle[], lookback: number) {
  const n = candles15m.length;
  const sup: (number | null)[] = new Array(n).fill(null);
  const res: (number | null)[] = new Array(n).fill(null);
  for (let i = lookback; i < n; i++) {
    let lo = Infinity, hi = -Infinity;
    for (let j = i - lookback; j < i; j++) {
      if (candles15m[j].low < lo) lo = candles15m[j].low;
      if (candles15m[j].high > hi) hi = candles15m[j].high;
    }
    sup[i] = lo === Infinity ? null : lo;
    res[i] = hi === -Infinity ? null : hi;
  }
  return { sup, res };
}

function srAtTime(
  candles15m: Candle[],
  sup: (number | null)[],
  res: (number | null)[],
  t: number,
) {
  let lo = 0, hi = candles15m.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles15m[mid].time <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (idx < 0) return { support: null, resistance: null };
  return { support: sup[idx], resistance: res[idx] };
}

// ─── PnL helpers ────────────────────────────────────────────────────────────
function rawPctOf(side: Side, entry: number, exit: number) {
  return side === "LONG" ? ((exit - entry) / entry) * 100 : ((entry - exit) / entry) * 100;
}

function netUsdOf(rawPct: number) {
  let g = MARGIN_PER_TRADE * rawPct * LEVERAGE / 100;
  if (g < -MARGIN_PER_TRADE) g = -MARGIN_PER_TRADE;
  return g - 2 * FEE_PER_SIDE;
}

// ─── Trade types ────────────────────────────────────────────────────────────
interface OpenPos {
  bar5mTime: number; entryIdx: number; side: Side; source: EntrySource;
  entryPrice: number; entryMs: number; tpPrice: number; slPrice: number;
}

interface PerSourceStats {
  trades: number; wins: number; losses: number;
  winRate: number; netUsd: number;
}

interface RunMetrics {
  trades: number; wins: number; losses: number; winRate: number;
  pf: number; netUsd: number; finalEquity: number; roiPct: number;
  maxDdUsd: number;
  sharpeLike: number; // NET / sqrt(MaxDD)
  perSource: Record<EntrySource, PerSourceStats>;
  // Equity curve (downsampled to 200 pts) — used for HTML overlay chart
  equityCurve: number[];
}

// ─── Run backtest with given preset + mode ──────────────────────────────────
function runBacktest(
  preset: PresetCfg,
  mode: BetterEntryMode,
  candles5m: Candle[],
  stochK: (number | null)[],
  candles15m: Candle[],
): RunMetrics {
  const { sup, res } = precomputeSR15m(candles15m, preset.srLookback15m);
  const cooldownMs = preset.cooldownMin * 60 * 1000;
  const spacingMs = preset.stackPerSideSpacingMin * 60 * 1000;
  const open: OpenPos[] = [];
  let lastEntryMs = 0;
  let capital = INITIAL_CAPITAL;
  const equityPoints: number[] = [INITIAL_CAPITAL];

  let wins = 0, losses = 0, gw = 0, gl = 0, trades = 0;
  const perSource: Record<EntrySource, PerSourceStats> = {
    stoch_long:  { trades: 0, wins: 0, losses: 0, winRate: 0, netUsd: 0 },
    stoch_short: { trades: 0, wins: 0, losses: 0, winRate: 0, netUsd: 0 },
    sr_long:     { trades: 0, wins: 0, losses: 0, winRate: 0, netUsd: 0 },
    sr_short:    { trades: 0, wins: 0, losses: 0, winRate: 0, netUsd: 0 },
  };

  for (let i = preset.srLookback15m; i < candles5m.length; i++) {
    const bar = candles5m[i];
    const t = bar.time;
    const close = bar.close;

    // Plan B monitor: check OPEN positions on bar i (high/low scan)
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
      const rp = rawPctOf(p.side, p.entryPrice, exitPrice);
      const net = netUsdOf(rp);
      capital += net;
      if (net >= 0) { wins++; gw += net; } else { losses++; gl += -net; }
      trades++;
      const ps = perSource[p.source];
      ps.trades++;
      if (net >= 0) ps.wins++; else ps.losses++;
      ps.netUsd += net;
      equityPoints.push(capital);
      open.splice(pi, 1);
    }

    // Try entry on this 5m close
    if (open.some((p) => p.bar5mTime === t)) continue;
    if (t - lastEntryMs < cooldownMs) continue;
    if (capital - open.length * MARGIN_PER_TRADE < MARGIN_PER_TRADE) continue;

    // Detect side + source
    const k = stochK[i];
    let side: Side | null = null;
    let source: EntrySource | null = null;
    if (k !== null && k < preset.stochLongLevel) { side = "LONG"; source = "stoch_long"; }
    else if (k !== null && k > preset.stochShortLevel) { side = "SHORT"; source = "stoch_short"; }
    else {
      const sr = srAtTime(candles15m, sup, res, t);
      if (sr.support !== null && sr.resistance !== null) {
        const distSup = ((close - sr.support) / sr.support) * 100;
        const distRes = ((sr.resistance - close) / close) * 100;
        if (distSup >= 0 && distSup <= preset.srProximityPct) { side = "LONG"; source = "sr_long"; }
        else if (distRes >= 0 && distRes <= preset.srProximityPct) { side = "SHORT"; source = "sr_short"; }
      }
    }
    if (!side || !source) continue;

    // SMART STACK gates per side
    const sameSide = open.filter((p) => p.side === side);
    if (sameSide.length >= preset.stackMaxPerSide) continue;
    if (sameSide.length > 0) {
      const lastSame = sameSide.reduce((a, b) => (a.entryMs > b.entryMs ? a : b));
      if (spacingMs > 0 && t - lastSame.entryMs < spacingMs) continue;
      if (preset.stackMinEntryDistPct > 0) {
        const distPct = Math.abs(close - lastSame.entryPrice) / lastSame.entryPrice * 100;
        if (distPct < preset.stackMinEntryDistPct) continue;
      }
      // ─── BETTER ENTRY ONLY (the gate under test) ─────────────────────
      if (mode !== "off") {
        let benchmark: number;
        if (mode === "vs-last") {
          benchmark = lastSame.entryPrice;
        } else if (mode === "vs-best") {
          benchmark = side === "LONG"
            ? Math.min(...sameSide.map((p) => p.entryPrice))
            : Math.max(...sameSide.map((p) => p.entryPrice));
        } else {
          // vs-avg (count-weighted, mirroring all5mAccount.ts)
          const sumE = sameSide.reduce((a, b) => a + b.entryPrice, 0);
          benchmark = sumE / sameSide.length;
        }
        if (side === "LONG" && close >= benchmark) continue;
        if (side === "SHORT" && close <= benchmark) continue;
      }
    }

    const tpPrice = side === "LONG" ? close * (1 + preset.tpPct / 100) : close * (1 - preset.tpPct / 100);
    const slPrice = side === "LONG" ? close * (1 - preset.slPct / 100) : close * (1 + preset.slPct / 100);
    open.push({ bar5mTime: t, entryIdx: i, side, source, entryPrice: close, entryMs: t, tpPrice, slPrice });
    lastEntryMs = t;
  }

  // Finalize per-source winRate
  for (const src of Object.keys(perSource) as EntrySource[]) {
    const ps = perSource[src];
    ps.winRate = ps.trades > 0 ? Math.round((ps.wins / ps.trades) * 10000) / 100 : 0;
    ps.netUsd = Math.round(ps.netUsd * 100) / 100;
  }

  // Aggregate stats
  const winRate = trades ? (wins / trades) * 100 : 0;
  const pf = gl > 0 ? gw / gl : (gw > 0 ? 999 : 0);
  const netUsd = capital - INITIAL_CAPITAL;
  const roiPct = (netUsd / INITIAL_CAPITAL) * 100;
  let peak = INITIAL_CAPITAL, maxDD = 0;
  for (const v of equityPoints) {
    if (v > peak) peak = v;
    const dd = peak - v;
    if (dd > maxDD) maxDD = dd;
  }
  const sharpeLike = maxDD > 0 ? netUsd / Math.sqrt(maxDD) : netUsd;

  // Downsample equity curve to 200 pts
  const MAX_PTS = 200;
  let curve: number[];
  if (equityPoints.length <= MAX_PTS) curve = equityPoints.map((v) => Math.round(v * 100) / 100);
  else {
    curve = [];
    for (let i = 0; i < MAX_PTS; i++) {
      const idx = Math.floor((i / (MAX_PTS - 1)) * (equityPoints.length - 1));
      curve.push(Math.round(equityPoints[idx] * 100) / 100);
    }
  }

  return {
    trades, wins, losses,
    winRate: Math.round(winRate * 100) / 100,
    pf: pf === 999 ? 999 : Math.round(pf * 100) / 100,
    netUsd: Math.round(netUsd),
    finalEquity: Math.round(capital),
    roiPct: Math.round(roiPct),
    maxDdUsd: Math.round(maxDD),
    sharpeLike: Math.round(sharpeLike * 10) / 10,
    perSource,
    equityCurve: curve,
  };
}

// ─── Render HTML ────────────────────────────────────────────────────────────
const MODE_COLORS: Record<BetterEntryMode, string> = {
  "off":     "#9f8e80",
  "vs-last": "#10b981",
  "vs-best": "#a78bfa",
  "vs-avg":  "#F7931A",
};

interface RunRecord {
  id: string;
  preset: string;       // "WHALE" | "EAGLE" | "TURTLE"
  presetKey: string;    // "AGGRESSIVE" | "BALANCED" | "SAFE"
  emoji: string;
  mode: BetterEntryMode;
  cfg: PresetCfg;
  metrics: RunMetrics;
}

function equityOverlaySvg(runs: RunRecord[], width = 980, height = 320): string {
  if (runs.length === 0) return "";
  const allCurves = runs.map((r) => r.metrics.equityCurve);
  const allFlat = allCurves.flat();
  const min = Math.min(...allFlat, INITIAL_CAPITAL);
  const max = Math.max(...allFlat, INITIAL_CAPITAL);
  const range = max - min || 1;
  const baseY = height - ((INITIAL_CAPITAL - min) / range) * height;

  const lines = runs.map((r) => {
    const c = r.metrics.equityCurve;
    if (c.length < 2) return "";
    const pts = c.map((v, i) => {
      const x = (i / (c.length - 1)) * width;
      const y = height - ((v - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
    const color = MODE_COLORS[r.mode];
    const dash = r.preset === "WHALE" ? "" : r.preset === "EAGLE" ? "stroke-dasharray=\"4,3\"" : "stroke-dasharray=\"1,2\"";
    return `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.4" opacity="0.85" ${dash}>
      <title>${r.id} · NET $${r.metrics.netUsd.toLocaleString()} · DD $${r.metrics.maxDdUsd.toLocaleString()}</title>
    </polyline>`;
  }).join("\n");

  return `<svg width="${width}" height="${height}" style="display:block">
    <line x1="0" y1="${baseY.toFixed(1)}" x2="${width}" y2="${baseY.toFixed(1)}" stroke="#666" stroke-dasharray="4,3" stroke-width="0.6"/>
    ${lines}
    <text x="6" y="14" fill="#9f8e80" font-size="11">max $${max.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}</text>
    <text x="6" y="${(baseY - 4).toFixed(1)}" fill="#9f8e80" font-size="10">baseline $${INITIAL_CAPITAL.toLocaleString()}</text>
    <text x="6" y="${height - 6}" fill="#9f8e80" font-size="11">min $${min.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}</text>
  </svg>`;
}

function renderHtml(payload: any): string {
  const all: RunRecord[] = payload.runs;
  const sorted = [...all].sort((a, b) => b.metrics.netUsd - a.metrics.netUsd);
  const sortedRows = sorted.map((r) => {
    const ps = r.metrics.perSource;
    return `
      <tr>
        <td>${r.preset} ${r.emoji}</td>
        <td><span class="modeChip" style="background:${MODE_COLORS[r.mode]}33;color:${MODE_COLORS[r.mode]}">${r.mode}</span></td>
        <td>${r.metrics.trades.toLocaleString()}</td>
        <td>${r.metrics.winRate}%</td>
        <td>${r.metrics.pf === 999 ? "∞" : r.metrics.pf}</td>
        <td style="color:${r.metrics.netUsd > 0 ? '#10b981' : '#ffb4ab'};font-weight:700">$${r.metrics.netUsd.toLocaleString()}</td>
        <td>$${r.metrics.maxDdUsd.toLocaleString()}</td>
        <td>${r.metrics.sharpeLike}</td>
        <td>$${r.metrics.finalEquity.toLocaleString()}</td>
        <td>${r.metrics.roiPct}%</td>
        <td style="font-size:10px;color:#9f8e80">SL ${ps.stoch_long.trades}/${ps.stoch_long.winRate}% · SS ${ps.stoch_short.trades}/${ps.stoch_short.winRate}% · srL ${ps.sr_long.trades}/${ps.sr_long.winRate}% · srS ${ps.sr_short.trades}/${ps.sr_short.winRate}%</td>
      </tr>`;
  }).join("");

  // Per-preset block: 4 modes side-by-side
  const presetBlocks = PRESETS.map((p) => {
    const presetRuns = all.filter((r) => r.preset === p.label).sort((a, b) =>
      MODES.indexOf(a.mode) - MODES.indexOf(b.mode));
    const baselineNet = presetRuns.find((r) => r.mode === "off")?.metrics.netUsd ?? 0;
    const cards = presetRuns.map((r) => {
      const delta = r.metrics.netUsd - baselineNet;
      const deltaPct = baselineNet !== 0 ? (delta / Math.abs(baselineNet)) * 100 : 0;
      const isWinner = r.mode !== "off" && r.metrics.netUsd === Math.max(...presetRuns.map((x) => x.metrics.netUsd));
      const winnerStyle = isWinner ? "border:2px solid #F7931A;" : "";
      return `<div class="modeCard" style="${winnerStyle}">
        <div class="modeHead" style="color:${MODE_COLORS[r.mode]}">${r.mode}${isWinner ? " 🏆" : ""}</div>
        <div class="modeStat"><b>NET</b> <span style="color:${r.metrics.netUsd > 0 ? '#10b981' : '#ffb4ab'}">$${r.metrics.netUsd.toLocaleString()}</span></div>
        <div class="modeStat"><b>vs off</b> <span style="color:${delta >= 0 ? '#10b981' : '#ffb4ab'}">${delta >= 0 ? '+' : ''}$${delta.toLocaleString()} (${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(1)}%)</span></div>
        <div class="modeStat"><b>MaxDD</b> $${r.metrics.maxDdUsd.toLocaleString()}</div>
        <div class="modeStat"><b>Trades</b> ${r.metrics.trades.toLocaleString()}</div>
        <div class="modeStat"><b>WR</b> ${r.metrics.winRate}%</div>
        <div class="modeStat"><b>PF</b> ${r.metrics.pf === 999 ? "∞" : r.metrics.pf}</div>
        <div class="modeStat"><b>Sharpe</b> ${r.metrics.sharpeLike}</div>
        <div class="modeStat"><b>Final</b> $${r.metrics.finalEquity.toLocaleString()}</div>
      </div>`;
    }).join("");
    // Pick best mode by NET
    const best = presetRuns.reduce((a, b) => b.metrics.netUsd > a.metrics.netUsd ? b : a);
    return `<div class="presetBlock">
      <h2>${p.emoji} ${p.label} <span class="presetMeta">(${p.key} · TP${p.tpPct}/SL${p.slPct} · stack ${p.stackMaxPerSide} · cd ${p.cooldownMin}m · stoch ${p.stochLongLevel}/${p.stochShortLevel})</span></h2>
      <div class="winnerBanner">Best mode: <b style="color:${MODE_COLORS[best.mode]}">${best.mode}</b> · NET $${best.metrics.netUsd.toLocaleString()} · MaxDD $${best.metrics.maxDdUsd.toLocaleString()} · Sharpe ${best.metrics.sharpeLike}</div>
      <div class="modeGrid">${cards}</div>
    </div>`;
  }).join("");

  // Equity overlay
  const overlay = equityOverlaySvg(all);

  // Legend (mode color × preset dash)
  const legend = `
    <div class="legend">
      <div><b>Modes (color):</b>
        ${MODES.map((m) => `<span class="legendDot" style="background:${MODE_COLORS[m]}"></span>${m}`).join("  ")}
      </div>
      <div style="margin-top:6px"><b>Presets (line style):</b>
        WHALE — solid · EAGLE — dashed · TURTLE — dotted
      </div>
    </div>`;

  return `<!DOCTYPE html>
<html lang="vi"><head><meta charset="UTF-8"/>
<title>5m ALL · Better-Entry Modes · 3 Year</title>
<style>
  body { background:#1a1207; color:#e9dfd0; font-family:'JetBrains Mono','Menlo',monospace; font-size:12px; padding:20px; margin:0; }
  h1 { color:#F7931A; font-size:20px; letter-spacing:1px; margin:0 0 6px 0; border-bottom:1px solid #4a3520; padding-bottom:8px; }
  h2 { color:#ffdcc0; font-size:14px; letter-spacing:1px; margin:18px 0 10px 0; }
  .info { color:#9f8e80; font-size:11px; line-height:1.7; margin-bottom:18px; }
  .info b { color:#ffdcc0; }
  .card { background:#241a0d; border:1px solid #4a3520; border-radius:6px; padding:14px 18px; margin-bottom:14px; }
  .presetBlock { background:#241a0d; border:1px solid #4a3520; border-radius:6px; padding:14px 18px; margin-bottom:14px; }
  .presetBlock h2 { margin-top:0; color:#F7931A; }
  .presetMeta { color:#9f8e80; font-size:11px; font-weight:normal; }
  .winnerBanner { background:#0f0a05; padding:8px 12px; border-radius:4px; margin-bottom:10px; color:#cfc6bc; }
  .winnerBanner b { color:#F7931A; }
  .modeGrid { display:grid; grid-template-columns:repeat(4, 1fr); gap:10px; }
  .modeCard { background:#0f0a05; border:1px solid #2a2010; border-radius:6px; padding:10px 12px; }
  .modeHead { font-size:13px; font-weight:700; margin-bottom:8px; letter-spacing:1px; }
  .modeStat { color:#cfc6bc; font-size:11px; line-height:1.7; display:flex; justify-content:space-between; }
  .modeStat b { color:#9f8e80; font-weight:500; }
  table { border-collapse:collapse; width:100%; font-size:11px; }
  th, td { padding:6px 9px; text-align:left; border-bottom:1px solid #2a2010; }
  th { background:#0f0a05; color:#F7931A; position:sticky; top:0; }
  tr:hover { background:#241a0d; }
  .modeChip { padding:2px 8px; border-radius:8px; font-size:10px; font-weight:700; }
  .legend { background:#0f0a05; padding:10px 14px; border-radius:4px; margin:12px 0; color:#cfc6bc; font-size:11px; }
  .legend b { color:#ffdcc0; }
  .legendDot { display:inline-block; width:10px; height:10px; border-radius:2px; vertical-align:middle; margin:0 6px 0 0; }
</style></head>
<body>
<h1>⚡ 5m ALL · Better-Entry Modes Sweep · 3 Year · BTC/USDT</h1>
<div class="info">
  Generated: <b>${new Date(payload.generatedAt).toISOString()}</b> ·
  Total runs: <b>${all.length}</b> (3 presets × 4 modes) ·
  Capital <b>$${INITIAL_CAPITAL.toLocaleString()}</b> · margin <b>$${MARGIN_PER_TRADE}</b> × <b>${LEVERAGE}x</b> · fee <b>${FEE_PER_SIDE_PCT}%/side</b><br>
  Modes: <b>off</b> = no gate · <b>vs-last</b> = better than nearest same-side entry · <b>vs-best</b> = better than ALL same-side entries · <b>vs-avg</b> = better than count-avg entry
</div>

${presetBlocks}

<h2>📈 EQUITY CURVE OVERLAY (12 runs · baseline $${INITIAL_CAPITAL.toLocaleString()})</h2>
<div class="card">${overlay}</div>
${legend}

<h2>📋 ALL RUNS (sorted by NET ↓)</h2>
<div class="card" style="padding:0;overflow-x:auto">
<table>
<thead><tr>
  <th>Preset</th><th>Mode</th><th>Trades</th><th>WR</th><th>PF</th><th>NET</th><th>MaxDD</th><th>Sharpe</th><th>Final</th><th>ROI</th><th>Per-source (trades/WR)</th>
</tr></thead>
<tbody>${sortedRows}</tbody>
</table>
</div>
</body></html>`;
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== 5m ALL · BETTER-ENTRY SWEEP · 3Y · BTC/USDT ===`);
  console.log(`Capital $${INITIAL_CAPITAL} · margin $${MARGIN_PER_TRADE} × ${LEVERAGE}x · fee ${FEE_PER_SIDE_PCT}%/side\n`);

  console.log("Loading 3y cache...");
  const candles5m = loadCached("5m");
  const candles15m = loadCached("15m");
  console.log(`  5m: ${candles5m.length.toLocaleString()} candles`);
  console.log(`  15m: ${candles15m.length.toLocaleString()} candles`);

  console.log("\nPrecomputing Stoch5m K series (constant across runs)...");
  const t0 = Date.now();
  const closes5m = candles5m.map((c) => c.close);
  const stoch = calcStochRSISeries(closes5m, 14, 14, 3, 3);
  console.log(`  done (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  const allRuns: RunRecord[] = [];

  for (const preset of PRESETS) {
    console.log(`\n[${preset.emoji} ${preset.label}] (${preset.key}) ─────────────────────`);
    for (const mode of MODES) {
      const tStart = Date.now();
      const m = runBacktest(preset, mode, candles5m, stoch.kSeries, candles15m);
      const id = `${preset.label}_${mode}`;
      allRuns.push({
        id,
        preset: preset.label,
        presetKey: preset.key,
        emoji: preset.emoji,
        mode,
        cfg: preset,
        metrics: m,
      });
      const dt = ((Date.now() - tStart) / 1000).toFixed(1);
      console.log(`  ${mode.padEnd(8)} → trades ${m.trades.toString().padStart(5)} · WR ${m.winRate}% · NET $${m.netUsd.toLocaleString().padStart(10)} · DD $${m.maxDdUsd.toLocaleString().padStart(7)} · Sharpe ${m.sharpeLike}  (${dt}s)`);
    }
  }

  // ─── Save JSON ────────────────────────────────────────────────────────────
  const assetsDir = join(__dirname, "..", "assets");
  if (!existsSync(assetsDir)) mkdirSync(assetsDir, { recursive: true });
  const payload = {
    generatedAt: Date.now(),
    config: {
      years: YEARS,
      initialCapital: INITIAL_CAPITAL,
      marginPerTrade: MARGIN_PER_TRADE,
      leverage: LEVERAGE,
      feePerSidePct: FEE_PER_SIDE_PCT,
    },
    presets: PRESETS,
    modes: MODES,
    totalRuns: allRuns.length,
    runs: allRuns,
  };
  const jsonPath = join(assetsDir, "sweep_5mall_better_entry_3y.json");
  const htmlPath = join(assetsDir, "sweep_5mall_better_entry_3y_report.html");
  writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
  writeFileSync(htmlPath, renderHtml(payload));

  console.log(`\n✅ Output:`);
  console.log(`  ${jsonPath}`);
  console.log(`  ${htmlPath}`);

  // ─── Console summary per preset ───────────────────────────────────────────
  console.log(`\n═══ SUMMARY PER PRESET (best mode by NET) ═══`);
  for (const p of PRESETS) {
    const presetRuns = allRuns.filter((r) => r.preset === p.label);
    const baseline = presetRuns.find((r) => r.mode === "off")!;
    const best = presetRuns.reduce((a, b) => b.metrics.netUsd > a.metrics.netUsd ? b : a);
    const delta = best.metrics.netUsd - baseline.metrics.netUsd;
    const deltaStr = delta >= 0 ? `+$${delta.toLocaleString()}` : `-$${Math.abs(delta).toLocaleString()}`;
    console.log(`${p.emoji} ${p.label.padEnd(7)} best=${best.mode.padEnd(8)} NET $${best.metrics.netUsd.toLocaleString().padStart(10)} (Δ vs off: ${deltaStr}) · DD $${best.metrics.maxDdUsd.toLocaleString().padStart(7)} · trades ${best.metrics.trades.toLocaleString().padStart(5)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
