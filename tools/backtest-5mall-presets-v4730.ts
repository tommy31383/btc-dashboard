/**
 * backtest-5mall-presets-v4730.ts — re-confirm 3 PRESETS baseline (v4.7.30)
 *
 * Runs the 3 current PRESETS (WHALE/EAGLE/TURTLE) from utils/all5mAccount.ts
 * over BTCUSDT 3y with capital $5000, mode "off" (production setting).
 * Mirrors tryEntry5mBar logic + Plan B monitor.
 *
 * Output:
 *   assets/sweep_5mall_v2.json
 *   assets/sweep_5mall_v2_report.html
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { Candle } from "../utils/backtester";
import { calcStochRSISeries } from "../utils/indicators";

const YEARS = 3;
const FEE_PER_SIDE_PCT = 0.05;
const INITIAL_CAPITAL = 5000;
const MARGIN_PER_TRADE = 30;
const LEVERAGE = 100;
const NOTIONAL = MARGIN_PER_TRADE * LEVERAGE;
const FEE_PER_SIDE = NOTIONAL * (FEE_PER_SIDE_PCT / 100);

type Side = "LONG" | "SHORT";
type EntrySource = "stoch_long" | "stoch_short" | "sr_long" | "sr_short";

interface PresetCfg {
  key: string; label: string; emoji: string;
  tpPct: number; slPct: number;
  stackMaxPerSide: number; stackMinEntryDistPct: number; stackPerSideSpacingMin: number;
  cooldownMin: number;
  stochLongLevel: number; stochShortLevel: number;
  srProximityPct: number; srLookback15m: number;
  expectedNet3y: number; expectedMaxDd3y: number;
}

const PRESETS: PresetCfg[] = [
  { key: "AGGRESSIVE", label: "WHALE", emoji: "🔴",
    tpPct: 5, slPct: 2.5,
    stackMaxPerSide: 75, stackMinEntryDistPct: 0, stackPerSideSpacingMin: 0,
    cooldownMin: 5, stochLongLevel: 10, stochShortLevel: 90,
    srProximityPct: 0.4, srLookback15m: 30,
    expectedNet3y: 1516473, expectedMaxDd3y: 5874 },
  { key: "BALANCED", label: "EAGLE", emoji: "🟡",
    tpPct: 5, slPct: 2.5,
    stackMaxPerSide: 30, stackMinEntryDistPct: 0.1, stackPerSideSpacingMin: 10,
    cooldownMin: 5, stochLongLevel: 15, stochShortLevel: 85,
    srProximityPct: 0.4, srLookback15m: 50,
    expectedNet3y: 633753, expectedMaxDd3y: 1983 },
  { key: "SAFE", label: "TURTLE", emoji: "🟢",
    tpPct: 3.5, slPct: 2,
    stackMaxPerSide: 15, stackMinEntryDistPct: 0.3, stackPerSideSpacingMin: 10,
    cooldownMin: 15, stochLongLevel: 10, stochShortLevel: 90,
    srProximityPct: 0.4, srLookback15m: 80,
    expectedNet3y: 240975, expectedMaxDd3y: 792 },
];

function loadCached(interval: string): Candle[] {
  const cachePath = join(__dirname, "..", ".cache", `binance-${interval}-${YEARS}y.json`);
  if (!existsSync(cachePath)) throw new Error(`Missing cache ${cachePath}`);
  return JSON.parse(readFileSync(cachePath, "utf8")) as Candle[];
}

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

function srAtTime(candles15m: Candle[], sup: (number | null)[], res: (number | null)[], t: number) {
  let lo = 0, hi = candles15m.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles15m[mid].time <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (idx < 0) return { support: null, resistance: null };
  return { support: sup[idx], resistance: res[idx] };
}

function rawPctOf(side: Side, entry: number, exit: number) {
  return side === "LONG" ? ((exit - entry) / entry) * 100 : ((entry - exit) / entry) * 100;
}
function netUsdOf(rawPct: number) {
  let g = MARGIN_PER_TRADE * rawPct * LEVERAGE / 100;
  if (g < -MARGIN_PER_TRADE) g = -MARGIN_PER_TRADE;
  return g - 2 * FEE_PER_SIDE;
}

interface OpenPos { bar5mTime: number; entryIdx: number; side: Side; source: EntrySource; entryPrice: number; entryMs: number; tpPrice: number; slPrice: number; }
interface PerSourceStats { trades: number; wins: number; losses: number; winRate: number; netUsd: number; }
interface RunMetrics {
  trades: number; wins: number; losses: number; winRate: number;
  pf: number; netUsd: number; finalEquity: number; roiPct: number;
  maxDdUsd: number; sharpeLike: number;
  perSource: Record<EntrySource, PerSourceStats>;
  equityCurve: number[];
}

function runBacktest(preset: PresetCfg, candles5m: Candle[], stochK: (number | null)[], candles15m: Candle[]): RunMetrics {
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

    if (open.some((p) => p.bar5mTime === t)) continue;
    if (t - lastEntryMs < cooldownMs) continue;
    if (capital - open.length * MARGIN_PER_TRADE < MARGIN_PER_TRADE) continue;

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

    const sameSide = open.filter((p) => p.side === side);
    if (sameSide.length >= preset.stackMaxPerSide) continue;
    if (sameSide.length > 0) {
      const lastSame = sameSide.reduce((a, b) => (a.entryMs > b.entryMs ? a : b));
      if (spacingMs > 0 && t - lastSame.entryMs < spacingMs) continue;
      if (preset.stackMinEntryDistPct > 0) {
        const distPct = Math.abs(close - lastSame.entryPrice) / lastSame.entryPrice * 100;
        if (distPct < preset.stackMinEntryDistPct) continue;
      }
      // mode "off" → no better-entry gate
    }

    const tpPrice = side === "LONG" ? close * (1 + preset.tpPct / 100) : close * (1 - preset.tpPct / 100);
    const slPrice = side === "LONG" ? close * (1 - preset.slPct / 100) : close * (1 + preset.slPct / 100);
    open.push({ bar5mTime: t, entryIdx: i, side, source, entryPrice: close, entryMs: t, tpPrice, slPrice });
    lastEntryMs = t;
  }

  for (const src of Object.keys(perSource) as EntrySource[]) {
    const ps = perSource[src];
    ps.winRate = ps.trades > 0 ? Math.round((ps.wins / ps.trades) * 10000) / 100 : 0;
    ps.netUsd = Math.round(ps.netUsd * 100) / 100;
  }

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
    perSource, equityCurve: curve,
  };
}

interface RunRecord { preset: string; presetKey: string; emoji: string; cfg: PresetCfg; metrics: RunMetrics; driftPct: { net: number; dd: number }; }

async function main() {
  console.log("[v4.7.30 baseline] Loading 3y cache...");
  const candles5m = loadCached("5m");
  const candles15m = loadCached("15m");
  console.log(`[v4.7.30] 5m=${candles5m.length} candles, 15m=${candles15m.length} candles`);

  const closes5m = candles5m.map((c) => c.close);
  const stochResult = calcStochRSISeries(closes5m, 14, 14, 3, 3);
  const stochK = stochResult.kSeries;
  console.log(`[v4.7.30] Stoch precomputed`);

  const runs: RunRecord[] = [];
  for (const preset of PRESETS) {
    console.log(`\n[${preset.emoji} ${preset.label}] running...`);
    const m = runBacktest(preset, candles5m, stochK, candles15m);
    const driftNet = ((m.netUsd - preset.expectedNet3y) / preset.expectedNet3y) * 100;
    const driftDd = ((m.maxDdUsd - preset.expectedMaxDd3y) / preset.expectedMaxDd3y) * 100;
    runs.push({ preset: preset.label, presetKey: preset.key, emoji: preset.emoji, cfg: preset, metrics: m, driftPct: { net: Math.round(driftNet * 100) / 100, dd: Math.round(driftDd * 100) / 100 } });
    console.log(`  trades=${m.trades} WR=${m.winRate}% PF=${m.pf} NET=$${m.netUsd.toLocaleString()} DD=$${m.maxDdUsd.toLocaleString()} sharpe=${m.sharpeLike}`);
    console.log(`  expected NET=$${preset.expectedNet3y.toLocaleString()} (drift ${driftNet.toFixed(2)}%) · expected DD=$${preset.expectedMaxDd3y.toLocaleString()} (drift ${driftDd.toFixed(2)}%)`);
    console.log(`  perSource:`);
    for (const src of Object.keys(m.perSource) as EntrySource[]) {
      const ps = m.perSource[src];
      if (ps.trades > 0) console.log(`    ${src}: ${ps.trades} trades, WR ${ps.winRate}%, NET $${ps.netUsd.toLocaleString()}`);
    }
  }

  const assetsDir = join(__dirname, "..", "assets");
  if (!existsSync(assetsDir)) mkdirSync(assetsDir, { recursive: true });
  const out = { generatedAt: Date.now(), version: "v4.7.30", capital: INITIAL_CAPITAL, runs };
  writeFileSync(join(assetsDir, "sweep_5mall_v2.json"), JSON.stringify(out, null, 2));
  console.log(`\n✅ JSON → assets/sweep_5mall_v2.json`);

  const html = renderHtml(out);
  writeFileSync(join(assetsDir, "sweep_5mall_v2_report.html"), html);
  console.log(`✅ HTML → assets/sweep_5mall_v2_report.html`);
}

function renderHtml(payload: any): string {
  const runs: RunRecord[] = payload.runs;
  const card = (r: RunRecord) => {
    const driftNetClass = Math.abs(r.driftPct.net) > 5 ? "drift-bad" : "drift-ok";
    const driftDdClass = Math.abs(r.driftPct.dd) > 5 ? "drift-bad" : "drift-ok";
    const psRows = (Object.keys(r.metrics.perSource) as EntrySource[]).map((src) => {
      const ps = r.metrics.perSource[src];
      return `<tr><td>${src}</td><td>${ps.trades}</td><td>${ps.winRate}%</td><td>$${ps.netUsd.toLocaleString()}</td></tr>`;
    }).join("");
    return `<div class="card">
      <h2>${r.emoji} ${r.preset} <span class="key">(${r.presetKey})</span></h2>
      <div class="stats">
        <div><b>Trades</b> ${r.metrics.trades.toLocaleString()}</div>
        <div><b>WR</b> ${r.metrics.winRate}%</div>
        <div><b>PF</b> ${r.metrics.pf}</div>
        <div><b>NET</b> $${r.metrics.netUsd.toLocaleString()}</div>
        <div><b>MaxDD</b> $${r.metrics.maxDdUsd.toLocaleString()}</div>
        <div><b>Sharpe-like</b> ${r.metrics.sharpeLike}</div>
      </div>
      <div class="drift">
        <div>Expected NET: $${r.cfg.expectedNet3y.toLocaleString()} · drift <span class="${driftNetClass}">${r.driftPct.net.toFixed(2)}%</span></div>
        <div>Expected DD:  $${r.cfg.expectedMaxDd3y.toLocaleString()} · drift <span class="${driftDdClass}">${r.driftPct.dd.toFixed(2)}%</span></div>
      </div>
      <table class="ps">
        <thead><tr><th>Source</th><th>Trades</th><th>WR</th><th>NET</th></tr></thead>
        <tbody>${psRows}</tbody>
      </table>
    </div>`;
  };
  return `<!doctype html><html><head><meta charset="utf-8"/>
<title>5m ALL Presets — v4.7.30 baseline</title>
<style>
body { background:#1a1207; color:#e9dfd0; font-family:ui-monospace,monospace; padding:20px; }
h1 { color:#F7931A; border-bottom:1px solid #333; padding-bottom:8px; }
.cards { display:grid; grid-template-columns:repeat(3,1fr); gap:14px; }
.card { background:#241a0d; border-radius:6px; padding:16px; border:1px solid #4a3520; }
.card h2 { color:#F7931A; margin-top:0; }
.card .key { color:#9f8e80; font-size:13px; font-weight:normal; }
.stats { display:grid; grid-template-columns:repeat(2,1fr); gap:6px; font-size:13px; margin-bottom:12px; }
.drift { font-size:11px; color:#9f8e80; margin-bottom:10px; line-height:1.6; }
.drift-ok { color:#10b981; }
.drift-bad { color:#ffb4ab; }
table.ps { width:100%; border-collapse:collapse; font-size:11px; }
table.ps th, table.ps td { padding:4px 6px; text-align:left; border-bottom:1px solid #2a2010; }
table.ps th { background:#0f0a05; color:#F7931A; }
</style></head><body>
<h1>⚡ 5m ALL — v4.7.30 baseline · capital $${payload.capital.toLocaleString()}</h1>
<p>Generated ${new Date(payload.generatedAt).toISOString()}</p>
<div class="cards">${runs.map(card).join("")}</div>
</body></html>`;
}

main().catch((e) => { console.error(e); process.exit(1); });
