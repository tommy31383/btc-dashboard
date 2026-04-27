/**
 * sweep-5mall-improve-v2.ts — Phase 2 micro-sweep
 *
 * Strategy: 3 anchors (current AGGRESSIVE/BALANCED/SAFE presets), one-at-a-time
 * tuning sweep on knobs not previously tested in v1:
 *   - cooldownMin: 5, 10, 15
 *   - stochThr: (10,90), (5,95), (15,85)
 *   - srProxPct: 0.2, 0.3, 0.4
 *   - srLookback: 30, 50, 80
 *   - distPct (within preset envelope)
 *   - stackMax (within preset envelope)
 *
 * Hedge mode preserved (LONG+SHORT independent stacks, per-entry TP/SL,
 * partial close on hit).
 *
 * Selection criteria (anh Tommy):
 *   1. WHALE 🔴  → highest NET
 *   2. EAGLE 🟡  → max NET / sqrt(MaxDD) (Sharpe-like)
 *   3. TURTLE 🟢 → min MaxDD with NET ≥ $100k
 *
 * Output:
 *   assets/sweep_5mall_v2.json
 *   assets/sweep_5mall_v2_report.html
 *
 * Usage: npx tsx tools/sweep-5mall-improve-v2.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { Candle } from "../utils/backtester";
import { calcStochRSISeries } from "../utils/indicators";

const YEARS = 3;
const FEE_PER_SIDE_PCT = 0.05;
const INITIAL_CAPITAL = 1000;
const MARGIN_PER_TRADE = 30;
const LEVERAGE = 100;
const NOTIONAL = MARGIN_PER_TRADE * LEVERAGE;
const FEE_PER_SIDE = NOTIONAL * (FEE_PER_SIDE_PCT / 100);

type Side = "LONG" | "SHORT";
type EntrySource = "stoch_long" | "stoch_short" | "sr_long" | "sr_short";

interface Cfg {
  tpPct: number;
  slPct: number;
  stackMax: number;
  spacingMin: number;
  distPct: number;
  cooldownMin: number;
  stochLong: number;
  stochShort: number;
  srProxPct: number;
  srLookback: number;
}

interface OpenPos {
  bar5mTime: number; entryIdx: number; side: Side; source: EntrySource;
  entryPrice: number; entryMs: number; tpPrice: number; slPrice: number;
}

function loadCached(interval: string): Candle[] {
  const cachePath = join(__dirname, "..", ".cache", `binance-${interval}-${YEARS}y.json`);
  if (!existsSync(cachePath)) throw new Error(`Missing cache ${cachePath}`);
  return JSON.parse(readFileSync(cachePath, "utf8")) as Candle[];
}

function precomputeSR15m(candles: Candle[], lookback: number) {
  const n = candles.length;
  const sup: (number | null)[] = new Array(n).fill(null);
  const res: (number | null)[] = new Array(n).fill(null);
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

interface Metrics {
  trades: number; wins: number; losses: number; winRate: number;
  pf: number; netUsd: number; finalEquity: number; roiPct: number;
  maxDdUsd: number;
  sharpeLike: number; // NET / sqrt(MaxDD)
}

function runBacktest(
  cfg: Cfg,
  candles5m: Candle[], stochK: (number | null)[],
  candles15m: Candle[],
): Metrics {
  const { sup, res } = precomputeSR15m(candles15m, cfg.srLookback);
  const cooldownMs = cfg.cooldownMin * 60 * 1000;
  const spacingMs = cfg.spacingMin * 60 * 1000;
  const open: OpenPos[] = [];
  let lastEntryMs = 0;
  let capital = INITIAL_CAPITAL;
  const equityPoints: number[] = [INITIAL_CAPITAL];
  let wins = 0, losses = 0, gw = 0, gl = 0;
  let trades = 0;

  for (let i = cfg.srLookback; i < candles5m.length; i++) {
    const bar = candles5m[i];
    const t = bar.time;
    const close = bar.close;

    // Monitor open
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
      if (outcome) {
        const rp = rawPctOf(p.side, p.entryPrice, exitPrice);
        const net = netUsdOf(rp);
        capital += net;
        if (net >= 0) { wins++; gw += net; } else { losses++; gl += -net; }
        trades++;
        equityPoints.push(capital);
        open.splice(pi, 1);
      }
    }

    // Try entry
    if (open.some((p) => p.bar5mTime === t)) continue;
    if (t - lastEntryMs < cooldownMs) continue;
    if (capital - open.length * MARGIN_PER_TRADE < MARGIN_PER_TRADE) continue;

    const k = stochK[i];
    let side: Side | null = null;
    let source: EntrySource | null = null;
    if (k !== null && k < cfg.stochLong) { side = "LONG"; source = "stoch_long"; }
    else if (k !== null && k > cfg.stochShort) { side = "SHORT"; source = "stoch_short"; }
    else {
      const sr = srAtTime(candles15m, sup, res, t);
      if (sr.support !== null && sr.resistance !== null) {
        const distSup = ((close - sr.support) / sr.support) * 100;
        const distRes = ((sr.resistance - close) / close) * 100;
        if (distSup >= 0 && distSup <= cfg.srProxPct) { side = "LONG"; source = "sr_long"; }
        else if (distRes >= 0 && distRes <= cfg.srProxPct) { side = "SHORT"; source = "sr_short"; }
      }
    }
    if (!side || !source) continue;

    const sameSide = open.filter((p) => p.side === side);
    if (sameSide.length >= cfg.stackMax) continue;
    if (sameSide.length > 0) {
      const lastSame = sameSide.reduce((a, b) => (a.entryMs > b.entryMs ? a : b));
      if (t - lastSame.entryMs < spacingMs) continue;
      if (cfg.distPct > 0) {
        const distPct = Math.abs(close - lastSame.entryPrice) / lastSame.entryPrice * 100;
        if (distPct < cfg.distPct) continue;
      }
    }

    const tpPrice = side === "LONG" ? close * (1 + cfg.tpPct / 100) : close * (1 - cfg.tpPct / 100);
    const slPrice = side === "LONG" ? close * (1 - cfg.slPct / 100) : close * (1 + cfg.slPct / 100);
    open.push({ bar5mTime: t, entryIdx: i, side, source, entryPrice: close, entryMs: t, tpPrice, slPrice });
    lastEntryMs = t;
  }

  // Stats
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

  return {
    trades, wins, losses,
    winRate: Math.round(winRate * 100) / 100,
    pf: pf === 999 ? 999 : Math.round(pf * 100) / 100,
    netUsd: Math.round(netUsd),
    finalEquity: Math.round(capital),
    roiPct: Math.round(roiPct),
    maxDdUsd: Math.round(maxDD),
    sharpeLike: Math.round(sharpeLike * 10) / 10,
  };
}

// ─── Anchors (current presets) ──────────────────────────────────────────────
const ANCHORS: Record<string, Cfg> = {
  AGGRESSIVE: { tpPct: 4, slPct: 2, stackMax: 50, spacingMin: 0, distPct: 0,
    cooldownMin: 10, stochLong: 10, stochShort: 90, srProxPct: 0.3, srLookback: 50 },
  BALANCED: { tpPct: 4, slPct: 2, stackMax: 30, spacingMin: 10, distPct: 0.2,
    cooldownMin: 10, stochLong: 10, stochShort: 90, srProxPct: 0.3, srLookback: 50 },
  SAFE: { tpPct: 5, slPct: 2.5, stackMax: 15, spacingMin: 10, distPct: 0.3,
    cooldownMin: 10, stochLong: 10, stochShort: 90, srProxPct: 0.3, srLookback: 50 },
};

// ─── Sweep loop ─────────────────────────────────────────────────────────────
type RunRecord = { id: string; anchor: string; knob: string; cfg: Cfg; metrics: Metrics };

function clone(c: Cfg): Cfg { return { ...c }; }

function pickBestForCriterion(
  records: RunRecord[],
  criterion: "NET" | "SHARPE" | "MINDD",
): RunRecord {
  if (criterion === "NET") {
    return records.reduce((a, b) => b.metrics.netUsd > a.metrics.netUsd ? b : a);
  }
  if (criterion === "SHARPE") {
    return records.reduce((a, b) => b.metrics.sharpeLike > a.metrics.sharpeLike ? b : a);
  }
  // MINDD: lowest DD with NET ≥ 100k
  const filtered = records.filter((r) => r.metrics.netUsd >= 100000);
  if (filtered.length === 0) return records.reduce((a, b) => b.metrics.netUsd > a.metrics.netUsd ? b : a);
  return filtered.reduce((a, b) => b.metrics.maxDdUsd < a.metrics.maxDdUsd ? b : a);
}

async function main() {
  console.log("[sweep v2] Loading 3y cache...");
  const candles5m = loadCached("5m");
  const candles15m = loadCached("15m");
  console.log(`[sweep v2] 5m=${candles5m.length} candles, 15m=${candles15m.length} candles`);

  // Precompute stoch (constant across runs)
  const closes5m = candles5m.map((c) => c.close);
  const stochResult = calcStochRSISeries(closes5m, 14, 14, 3, 3);
  const stochK = stochResult.kSeries;
  console.log(`[sweep v2] Stoch precomputed`);

  const allRuns: RunRecord[] = [];

  // Knob sweep grids
  const knobs = {
    cooldownMin: [5, 10, 15],
    stochThr: [[10, 90], [5, 95], [15, 85]] as [number, number][],
    srProxPct: [0.2, 0.3, 0.4],
    srLookback: [30, 50, 80],
    distPct: [0, 0.1, 0.2, 0.3, 0.5],
    stackMax: [15, 30, 50, 75],
    tpsl: [[3.5, 2], [4, 2], [4.5, 2.25], [5, 2.5]] as [number, number][],
  };

  for (const [anchorName, anchorCfg] of Object.entries(ANCHORS)) {
    console.log(`\n[anchor ${anchorName}] starting...`);
    let cur = clone(anchorCfg);

    // Run anchor baseline first
    const baseM = runBacktest(cur, candles5m, stochK, candles15m);
    allRuns.push({ id: `${anchorName}_base`, anchor: anchorName, knob: "(base)", cfg: clone(cur), metrics: baseM });
    console.log(`  base: NET ${baseM.netUsd} / DD ${baseM.maxDdUsd} / sharpe ${baseM.sharpeLike}`);

    // Sweep one knob at a time, keep best (by NET) for next stage
    const knobOrder: (keyof typeof knobs)[] = ["cooldownMin", "stochThr", "srProxPct", "srLookback", "distPct", "stackMax", "tpsl"];
    for (const knob of knobOrder) {
      const variants = knobs[knob];
      const localRuns: RunRecord[] = [];
      for (const v of variants) {
        const test = clone(cur);
        if (knob === "cooldownMin") test.cooldownMin = v as number;
        else if (knob === "stochThr") { test.stochLong = (v as [number, number])[0]; test.stochShort = (v as [number, number])[1]; }
        else if (knob === "srProxPct") test.srProxPct = v as number;
        else if (knob === "srLookback") test.srLookback = v as number;
        else if (knob === "distPct") test.distPct = v as number;
        else if (knob === "stackMax") test.stackMax = v as number;
        else if (knob === "tpsl") { test.tpPct = (v as [number, number])[0]; test.slPct = (v as [number, number])[1]; }
        const m = runBacktest(test, candles5m, stochK, candles15m);
        const id = `${anchorName}_${knob}_${JSON.stringify(v)}`;
        const rec = { id, anchor: anchorName, knob: String(knob), cfg: clone(test), metrics: m };
        allRuns.push(rec);
        localRuns.push(rec);
      }
      // Pick best for THIS anchor's selection bias:
      //   AGGRESSIVE → NET; BALANCED → SHARPE; SAFE → MINDD
      const bias = anchorName === "AGGRESSIVE" ? "NET" : anchorName === "BALANCED" ? "SHARPE" : "MINDD";
      const winner = pickBestForCriterion(localRuns, bias as "NET" | "SHARPE" | "MINDD");
      cur = clone(winner.cfg);
      console.log(`  knob=${knob} → winner ${JSON.stringify(
        knob === "tpsl" ? [winner.cfg.tpPct, winner.cfg.slPct]
        : knob === "stochThr" ? [winner.cfg.stochLong, winner.cfg.stochShort]
        : (winner.cfg as any)[knob]
      )} NET ${winner.metrics.netUsd} DD ${winner.metrics.maxDdUsd} sharpe ${winner.metrics.sharpeLike}`);
    }

    // Final tuned
    const finalM = runBacktest(cur, candles5m, stochK, candles15m);
    allRuns.push({ id: `${anchorName}_FINAL`, anchor: anchorName, knob: "FINAL", cfg: clone(cur), metrics: finalM });
    console.log(`  FINAL ${anchorName}: NET ${finalM.netUsd} / DD ${finalM.maxDdUsd} / sharpe ${finalM.sharpeLike}`);
  }

  // ─── Pick winners by criterion ─────────────────────────────────────────────
  const allFinals = allRuns; // pool everything
  const whale = pickBestForCriterion(allFinals, "NET");
  const eagle = pickBestForCriterion(allFinals, "SHARPE");
  const turtle = pickBestForCriterion(allFinals, "MINDD");

  // ─── Save JSON ─────────────────────────────────────────────────────────────
  const assetsDir = join(__dirname, "..", "assets");
  if (!existsSync(assetsDir)) mkdirSync(assetsDir, { recursive: true });
  const outJson = {
    generatedAt: Date.now(),
    totalRuns: allRuns.length,
    winners: { whale, eagle, turtle },
    runs: allRuns,
  };
  writeFileSync(join(assetsDir, "sweep_5mall_v2.json"), JSON.stringify(outJson, null, 2));
  console.log(`\n✅ JSON written → assets/sweep_5mall_v2.json (${allRuns.length} runs)`);

  // ─── Render HTML ───────────────────────────────────────────────────────────
  const html = renderHtml(outJson);
  writeFileSync(join(assetsDir, "sweep_5mall_v2_report.html"), html);
  console.log(`✅ HTML written → assets/sweep_5mall_v2_report.html`);

  // Console summary
  console.log("\n═══ WINNERS ═══");
  console.log(`🔴 WHALE  (max NET):       NET +$${whale.metrics.netUsd.toLocaleString()} · DD $${whale.metrics.maxDdUsd.toLocaleString()} · sharpe ${whale.metrics.sharpeLike}`);
  console.log(`   cfg: ${JSON.stringify(whale.cfg)}`);
  console.log(`🟡 EAGLE  (max sharpe):    NET +$${eagle.metrics.netUsd.toLocaleString()} · DD $${eagle.metrics.maxDdUsd.toLocaleString()} · sharpe ${eagle.metrics.sharpeLike}`);
  console.log(`   cfg: ${JSON.stringify(eagle.cfg)}`);
  console.log(`🟢 TURTLE (min DD if NET≥$100k): NET +$${turtle.metrics.netUsd.toLocaleString()} · DD $${turtle.metrics.maxDdUsd.toLocaleString()} · sharpe ${turtle.metrics.sharpeLike}`);
  console.log(`   cfg: ${JSON.stringify(turtle.cfg)}`);
}

function renderHtml(payload: any): string {
  const all = payload.runs as RunRecord[];
  const sorted = [...all].sort((a, b) => b.metrics.netUsd - a.metrics.netUsd);
  const rows = sorted.map((r) => `
    <tr>
      <td>${r.id}</td>
      <td>${r.anchor}</td>
      <td>${r.knob}</td>
      <td>TP${r.cfg.tpPct}/SL${r.cfg.slPct}</td>
      <td>${r.cfg.stackMax}</td>
      <td>${r.cfg.distPct}%</td>
      <td>${r.cfg.cooldownMin}m</td>
      <td>${r.cfg.stochLong}/${r.cfg.stochShort}</td>
      <td>${r.cfg.srProxPct}%</td>
      <td>${r.cfg.srLookback}</td>
      <td>${r.metrics.trades}</td>
      <td>${r.metrics.winRate}%</td>
      <td>${r.metrics.pf}</td>
      <td style="color:${r.metrics.netUsd > 0 ? '#10b981' : '#ffb4ab'}"><b>$${r.metrics.netUsd.toLocaleString()}</b></td>
      <td>$${r.metrics.maxDdUsd.toLocaleString()}</td>
      <td>${r.metrics.sharpeLike}</td>
    </tr>`).join("");
  const w = payload.winners;
  const winnerCard = (name: string, emoji: string, label: string, criterion: string, r: RunRecord) => `
    <div class="card">
      <h2>${emoji} ${name} <span class="label">"${label}"</span></h2>
      <p class="crit">${criterion}</p>
      <div class="stats">
        <div><b>NET</b> $${r.metrics.netUsd.toLocaleString()}</div>
        <div><b>MaxDD</b> $${r.metrics.maxDdUsd.toLocaleString()}</div>
        <div><b>Sharpe-like</b> ${r.metrics.sharpeLike}</div>
        <div><b>Trades</b> ${r.metrics.trades.toLocaleString()}</div>
        <div><b>WR</b> ${r.metrics.winRate}%</div>
        <div><b>PF</b> ${r.metrics.pf}</div>
      </div>
      <pre>${JSON.stringify(r.cfg, null, 2)}</pre>
    </div>`;
  return `<!doctype html><html><head><meta charset="utf-8"/>
<title>5m ALL Sweep v2 — Phase 2 Improvements</title>
<style>
body { background:#1a1207; color:#e9dfd0; font-family:ui-monospace,monospace; padding:20px; }
h1 { color:#F7931A; border-bottom:1px solid #333; padding-bottom:8px; }
.winners { display:grid; grid-template-columns:repeat(3,1fr); gap:14px; margin-bottom:24px; }
.card { background:#241a0d; border-radius:6px; padding:16px; border:1px solid #4a3520; }
.card h2 { color:#F7931A; margin-top:0; }
.card .label { color:#9f8e80; font-size:14px; font-weight:normal; }
.card .crit { color:#a78bfa; font-size:12px; margin:0 0 12px 0; }
.card .stats { display:grid; grid-template-columns:repeat(2,1fr); gap:6px; font-size:13px; margin-bottom:10px; }
.card pre { background:#0f0a05; padding:8px; border-radius:4px; font-size:11px; overflow-x:auto; }
table { width:100%; border-collapse:collapse; font-size:11px; }
th, td { padding:5px 8px; text-align:left; border-bottom:1px solid #2a2010; }
th { background:#0f0a05; color:#F7931A; position:sticky; top:0; }
tr:hover { background:#241a0d; }
</style></head><body>
<h1>⚡ 5m ALL — Sweep v2 (Phase 2 Improvements)</h1>
<p>Generated ${new Date(payload.generatedAt).toISOString()} · ${payload.totalRuns} runs · 3 anchors × one-at-a-time tuning</p>
<div class="winners">
  ${winnerCard("WHALE", "🔴", "Highest PnL", "max NET regardless of DD", w.whale)}
  ${winnerCard("EAGLE", "🟡", "Balanced (Sharpe-like)", "max NET / sqrt(MaxDD)", w.eagle)}
  ${winnerCard("TURTLE", "🟢", "Lowest MaxDD", "min MaxDD with NET ≥ $100k", w.turtle)}
</div>
<h2>All ${all.length} runs (sorted by NET)</h2>
<table>
<thead><tr><th>id</th><th>anchor</th><th>knob</th><th>tp/sl</th><th>stack</th><th>dist</th><th>cd</th><th>stoch</th><th>srProx</th><th>srLB</th><th>trades</th><th>wr</th><th>pf</th><th>NET</th><th>MaxDD</th><th>sharpe</th></tr></thead>
<tbody>${rows}</tbody>
</table>
</body></html>`;
}

main().catch((e) => { console.error(e); process.exit(1); });
