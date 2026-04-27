/**
 * sweep-5mall-improve.ts
 *
 * Run multiple variants of the 5m ALL paper-trading engine over 3 years of
 * BTCUSDT cache data and produce a comparison JSON + HTML report.
 *
 * Variants:
 *   baseline — current live config
 *   A1: TP=3% / SL=1.5%
 *   A2: TP=5% / SL=2.5%
 *   A3: stackMax=30, distance=0.2%
 *   A4: stackMax=50, distance=0%
 *   B1: stoch-only (drop sr_long / sr_short)
 *   B2: EMA200 5m trend filter
 *   B3: confluence — require BOTH stoch trigger AND S/R proximity
 *   C1: trailing stop after +2% unrealized, trail 1% behind peak
 *   C2: partial TP — 50% close at +2%, rest rides original TP/SL
 *   C3: time exit — close after >4h (48 bars) without TP/SL hit
 *
 * Hedge mode preserved: LONG and SHORT coexist as independent stacks,
 * each entry has own TP/SL, partial close on hit.
 *
 * Output:
 *   assets/sweep_5mall_improve.json
 *   assets/sweep_5mall_improve_report.html
 *
 * Usage:
 *   npx tsx tools/sweep-5mall-improve.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { Candle } from "../utils/backtester";
import { calcStochRSISeries, calcEMASeries } from "../utils/indicators";

const YEARS = 3;
const FEE_PER_SIDE_PCT = 0.05;
const INITIAL_CAPITAL = 1000;
const MARGIN_PER_TRADE = 30;
const LEVERAGE = 100;
const NOTIONAL = MARGIN_PER_TRADE * LEVERAGE;
const FEE_PER_SIDE = NOTIONAL * (FEE_PER_SIDE_PCT / 100);
const STOCH_LONG_LEVEL = 10;
const STOCH_SHORT_LEVEL = 90;
const COOLDOWN_MS = 10 * 60 * 1000;
const SR_PROXIMITY_PCT = 0.3;
const SR_LOOKBACK_15M = 50;

type Side = "LONG" | "SHORT";
type EntrySource = "stoch_long" | "stoch_short" | "sr_long" | "sr_short";

interface VariantConfig {
  id: string;
  label: string;
  tpPct: number;
  slPct: number;
  stackMax: number;
  spacingMin: number;
  distPct: number;
  // signal filters
  stochOnly?: boolean;
  ema200Filter?: boolean;
  confluence?: boolean;
  // exits
  trailing?: boolean;     // C1
  partialTp?: boolean;    // C2
  timeExitBars?: number;  // C3 (e.g. 48)
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
  exitReason: "TP" | "SL" | "TRAIL" | "PARTIAL" | "TIME";
}

interface OpenPos {
  bar5mTime: number;
  entryIdx: number;
  side: Side;
  source: EntrySource;
  entryPrice: number;
  entryMs: number;
  tpPrice: number;
  slPrice: number;
  qtyFrac: number;       // for partial TP: 1.0 then 0.5
  partialDone?: boolean; // C2
  peakPrice?: number;    // C1: best favorable price seen
  trailActive?: boolean; // C1: armed once +2% unrealized hit
}

// ─── Cache loaders ──────────────────────────────────────────────────────────
function loadCached(interval: string): Candle[] {
  const cachePath = join(__dirname, "..", ".cache", `binance-${interval}-${YEARS}y.json`);
  if (!existsSync(cachePath)) {
    throw new Error(`Cache file not found: ${cachePath}. Run backtest-5mall-3y.ts first.`);
  }
  const data = JSON.parse(readFileSync(cachePath, "utf8")) as Candle[];
  return data;
}

// ─── S/R precompute ─────────────────────────────────────────────────────────
function precomputeSR15m(candles15m: Candle[], lookback = SR_LOOKBACK_15M) {
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

// ─── PnL helper ─────────────────────────────────────────────────────────────
function rawPctOf(side: Side, entry: number, exit: number): number {
  return side === "LONG"
    ? ((exit - entry) / entry) * 100
    : ((entry - exit) / entry) * 100;
}

function netUsdOf(rawPct: number, qtyFrac: number): number {
  let gross = MARGIN_PER_TRADE * rawPct * LEVERAGE / 100 * qtyFrac;
  // Cap loss at -margin × qtyFrac
  const cap = -MARGIN_PER_TRADE * qtyFrac;
  if (gross < cap) gross = cap;
  // Both legs charged (entry + exit), proportional to qty
  return gross - 2 * FEE_PER_SIDE * qtyFrac;
}

// ─── Backtest core (variant-aware) ──────────────────────────────────────────
function runBacktest(
  cfg: VariantConfig,
  candles5m: Candle[],
  stochK: (number | null)[],
  ema200: (number | null)[],
  candles15m: Candle[],
  srSupport: (number | null)[],
  srResistance: (number | null)[],
) {
  const trades: TradeOutcome[] = [];
  const open: OpenPos[] = [];
  let lastEntryMs = 0;
  let capital = INITIAL_CAPITAL;
  const equityPerTrade: number[] = [];
  const spacingMs = cfg.spacingMin * 60 * 1000;

  const closeAt = (
    p: OpenPos,
    exitPrice: number,
    exitMs: number,
    holdBars: number,
    reason: TradeOutcome["exitReason"],
    qtyFrac: number,
  ) => {
    const rp = rawPctOf(p.side, p.entryPrice, exitPrice);
    const net = netUsdOf(rp, qtyFrac);
    capital += net;
    const outcome: "WIN" | "LOSS" = net >= 0 ? "WIN" : "LOSS";
    trades.push({
      bar5mTime: p.bar5mTime,
      side: p.side, source: p.source,
      entryPrice: p.entryPrice,
      exitPrice, exitMs,
      outcome,
      pnlPct: rp,
      netUsd: net,
      holdBars,
      exitReason: reason,
    });
    equityPerTrade.push(capital);
  };

  for (let i = SR_LOOKBACK_15M; i < candles5m.length; i++) {
    const bar = candles5m[i];
    const t = bar.time;
    const close = bar.close;

    // Monitor open positions
    for (let pi = open.length - 1; pi >= 0; pi--) {
      const p = open[pi];
      if (p.entryIdx >= i) continue;

      // C2: partial TP — close 50% at +2% favorable, rest keeps original TP/SL
      if (cfg.partialTp && !p.partialDone) {
        const partialTrigPrice = p.side === "LONG"
          ? p.entryPrice * (1 + 2 / 100)
          : p.entryPrice * (1 - 2 / 100);
        const hitPartial = p.side === "LONG"
          ? bar.high >= partialTrigPrice
          : bar.low <= partialTrigPrice;
        if (hitPartial) {
          // Close 50%, keep 50%
          closeAt(p, partialTrigPrice, t, i - p.entryIdx, "PARTIAL", 0.5);
          p.partialDone = true;
          p.qtyFrac = 0.5;
          // continue checking remaining 50% on same bar for TP/SL
        }
      }

      // C1: trailing — arm once +2% unrealized, trail 1% behind highest favorable
      if (cfg.trailing) {
        // update peak based on bar extremes (favorable extreme)
        const fav = p.side === "LONG" ? bar.high : bar.low;
        if (p.peakPrice === undefined) p.peakPrice = fav;
        else p.peakPrice = p.side === "LONG" ? Math.max(p.peakPrice, fav) : Math.min(p.peakPrice, fav);

        if (!p.trailActive) {
          const armPrice = p.side === "LONG"
            ? p.entryPrice * (1 + 2 / 100)
            : p.entryPrice * (1 - 2 / 100);
          const armed = p.side === "LONG" ? bar.high >= armPrice : bar.low <= armPrice;
          if (armed) p.trailActive = true;
        }
        if (p.trailActive && p.peakPrice !== undefined) {
          const trailStop = p.side === "LONG"
            ? p.peakPrice * (1 - 1 / 100)
            : p.peakPrice * (1 + 1 / 100);
          // if trailStop is favorable vs original SL, use the tighter stop
          const newStop = p.side === "LONG"
            ? Math.max(p.slPrice, trailStop)
            : Math.min(p.slPrice, trailStop);
          // hit?
          const hit = p.side === "LONG" ? bar.low <= newStop : bar.high >= newStop;
          if (hit) {
            closeAt(p, newStop, t, i - p.entryIdx, "TRAIL", p.qtyFrac);
            open.splice(pi, 1);
            continue;
          }
        }
      }

      // Original TP/SL check
      let outcome: "WIN" | "LOSS" | null = null;
      let exitPrice = close;
      let reason: TradeOutcome["exitReason"] = "TP";
      if (p.side === "LONG") {
        if (bar.low <= p.slPrice) { outcome = "LOSS"; exitPrice = p.slPrice; reason = "SL"; }
        else if (bar.high >= p.tpPrice) { outcome = "WIN"; exitPrice = p.tpPrice; reason = "TP"; }
      } else {
        if (bar.high >= p.slPrice) { outcome = "LOSS"; exitPrice = p.slPrice; reason = "SL"; }
        else if (bar.low <= p.tpPrice) { outcome = "WIN"; exitPrice = p.tpPrice; reason = "TP"; }
      }
      if (outcome) {
        closeAt(p, exitPrice, t, i - p.entryIdx, reason, p.qtyFrac);
        open.splice(pi, 1);
        continue;
      }

      // C3: time exit
      if (cfg.timeExitBars && (i - p.entryIdx) > cfg.timeExitBars) {
        closeAt(p, close, t, i - p.entryIdx, "TIME", p.qtyFrac);
        open.splice(pi, 1);
        continue;
      }
    }

    // Try entry
    if (open.some((p) => p.bar5mTime === t)) continue;
    if (t - lastEntryMs < COOLDOWN_MS) continue;

    const usedMargin = open.reduce((s, p) => s + MARGIN_PER_TRADE * p.qtyFrac, 0);
    if (capital - usedMargin < MARGIN_PER_TRADE) continue;

    // Detect signals
    const k = stochK[i];
    const stochLong = k !== null && k < STOCH_LONG_LEVEL;
    const stochShort = k !== null && k > STOCH_SHORT_LEVEL;

    const sr = srAtTime(candles15m, srSupport, srResistance, t);
    let srLong = false, srShort = false;
    if (sr.support !== null && sr.resistance !== null) {
      const distSup = ((close - sr.support) / sr.support) * 100;
      const distRes = ((sr.resistance - close) / close) * 100;
      if (distSup >= 0 && distSup <= SR_PROXIMITY_PCT) srLong = true;
      else if (distRes >= 0 && distRes <= SR_PROXIMITY_PCT) srShort = true;
    }

    let side: Side | null = null;
    let source: EntrySource | null = null;

    if (cfg.confluence) {
      // require BOTH stoch + SR on same side
      if (stochLong && srLong) { side = "LONG"; source = "stoch_long"; }
      else if (stochShort && srShort) { side = "SHORT"; source = "stoch_short"; }
    } else if (cfg.stochOnly) {
      if (stochLong) { side = "LONG"; source = "stoch_long"; }
      else if (stochShort) { side = "SHORT"; source = "stoch_short"; }
    } else {
      // baseline-style: stoch first, fallback SR
      if (stochLong) { side = "LONG"; source = "stoch_long"; }
      else if (stochShort) { side = "SHORT"; source = "stoch_short"; }
      else if (srLong) { side = "LONG"; source = "sr_long"; }
      else if (srShort) { side = "SHORT"; source = "sr_short"; }
    }

    if (!side || !source) continue;

    // B2: EMA200 trend filter
    if (cfg.ema200Filter) {
      const e = ema200[i];
      if (e === null) continue;
      if (side === "LONG" && close <= e) continue;
      if (side === "SHORT" && close >= e) continue;
    }

    // SMART STACK gates
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
    open.push({
      bar5mTime: t, entryIdx: i,
      side, source,
      entryPrice: close, entryMs: t,
      tpPrice, slPrice,
      qtyFrac: 1.0,
    });
    lastEntryMs = t;
  }

  return { trades, finalCapital: capital, equityPerTrade };
}

// ─── Stats ──────────────────────────────────────────────────────────────────
function summarize(trades: TradeOutcome[], finalCapital: number, equityPerTrade: number[]) {
  const total = trades.length;
  const wins = trades.filter((t) => t.outcome === "WIN").length;
  const losses = trades.filter((t) => t.outcome === "LOSS").length;
  const winRate = total ? (wins / total) * 100 : 0;
  const netUsd = trades.reduce((s, t) => s + t.netUsd, 0);
  const roiPct = ((finalCapital - INITIAL_CAPITAL) / INITIAL_CAPITAL) * 100;
  const gw = trades.filter((t) => t.netUsd > 0).reduce((s, t) => s + t.netUsd, 0);
  const gl = Math.abs(trades.filter((t) => t.netUsd < 0).reduce((s, t) => s + t.netUsd, 0));
  const pf = gl > 0 ? gw / gl : (gw > 0 ? 999 : 0);

  const fullCurve = [INITIAL_CAPITAL, ...equityPerTrade];
  const MAX_PTS = 200;
  let curve: number[];
  if (fullCurve.length <= MAX_PTS) {
    curve = fullCurve.map((v) => Math.round(v * 100) / 100);
  } else {
    curve = [];
    for (let i = 0; i < MAX_PTS; i++) {
      const idx = Math.floor((i / (MAX_PTS - 1)) * (fullCurve.length - 1));
      curve.push(Math.round(fullCurve[idx] * 100) / 100);
    }
  }

  let peak = INITIAL_CAPITAL, maxDD = 0;
  for (const v of fullCurve) {
    if (v > peak) peak = v;
    const dd = peak - v;
    if (dd > maxDD) maxDD = dd;
  }

  const avgHoldBars = total ? trades.reduce((s, t) => s + t.holdBars, 0) / total : 0;

  return {
    trades: total,
    wins,
    losses,
    winRate: Math.round(winRate * 100) / 100,
    pf: pf === 999 ? 999 : Math.round(pf * 100) / 100,
    netUsd: Math.round(netUsd * 100) / 100,
    finalEquity: Math.round(finalCapital * 100) / 100,
    roiPct: Math.round(roiPct * 100) / 100,
    maxDdUsd: Math.round(maxDD * 100) / 100,
    avgHoldBars: Math.round(avgHoldBars * 10) / 10,
    equityCurveUsd: curve,
  };
}

function summarizePerSource(trades: TradeOutcome[]) {
  const sources: EntrySource[] = ["stoch_long", "stoch_short", "sr_long", "sr_short"];
  const out: any = {};
  for (const src of sources) {
    const sub = trades.filter((t) => t.source === src);
    const wins = sub.filter((t) => t.outcome === "WIN").length;
    const wr = sub.length ? (wins / sub.length) * 100 : 0;
    const netUsd = sub.reduce((s, t) => s + t.netUsd, 0);
    out[src] = {
      trades: sub.length,
      wins,
      losses: sub.length - wins,
      winRate: Math.round(wr * 100) / 100,
      netUsd: Math.round(netUsd * 100) / 100,
    };
  }
  return out;
}

// ─── HTML rendering helpers ─────────────────────────────────────────────────
const COLORS = [
  "#F7931A", // baseline orange
  "#10b981", "#60a5fa", "#a78bfa", "#f472b6",
  "#fbbf24", "#34d399", "#22d3ee", "#fb7185",
  "#c084fc", "#fda4af", "#84cc16",
];

function overlayEquitySvg(
  variants: { id: string; label: string; curve: number[] }[],
  width = 900,
  height = 320,
): string {
  if (variants.length === 0) return `<svg width="${width}" height="${height}"></svg>`;
  const allVals: number[] = [];
  for (const v of variants) allVals.push(...v.curve);
  const min = Math.min(...allVals, INITIAL_CAPITAL);
  const max = Math.max(...allVals, INITIAL_CAPITAL);
  const range = max - min || 1;

  const polylines = variants.map((v, idx) => {
    const color = idx === 0 ? COLORS[0] : COLORS[idx % COLORS.length];
    const isBase = v.id === "baseline";
    const sw = isBase ? 2.4 : 1.3;
    const opacity = isBase ? 1.0 : 0.85;
    const pts = v.curve.map((val, i) => {
      const x = (i / Math.max(1, v.curve.length - 1)) * width;
      const y = height - ((val - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
    return `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="${sw}" opacity="${opacity}"/>`;
  }).join("\n");

  const baseY = height - ((INITIAL_CAPITAL - min) / range) * height;
  const baselineMarker = `<line x1="0" y1="${baseY.toFixed(1)}" x2="${width}" y2="${baseY.toFixed(1)}" stroke="#666" stroke-dasharray="4,3" stroke-width="0.6"/>`;

  // Use log-style label if range huge
  const fmt = (v: number) => v >= 10000 ? `$${(v / 1000).toFixed(1)}k` : `$${v.toFixed(0)}`;

  return `<svg width="${width}" height="${height}" style="display:block">
    ${baselineMarker}
    ${polylines}
    <text x="6" y="14" fill="#9f8e80" font-size="11">max ${fmt(max)}</text>
    <text x="6" y="${(baseY - 4).toFixed(1)}" fill="#9f8e80" font-size="10">baseline $${INITIAL_CAPITAL}</text>
    <text x="6" y="${height - 6}" fill="#9f8e80" font-size="11">min ${fmt(min)}</text>
  </svg>`;
}

function legendHtml(variants: { id: string; label: string }[]): string {
  return `<div class="legend">${variants.map((v, i) => {
    const color = i === 0 ? COLORS[0] : COLORS[i % COLORS.length];
    const isBase = v.id === "baseline";
    return `<div class="legendItem"><span class="swatch" style="background:${color};${isBase ? 'height:5px;' : ''}"></span><span>${v.id}${isBase ? ' (baseline)' : ''} — ${v.label}</span></div>`;
  }).join("")}</div>`;
}

function renderHtml(payload: any): string {
  const variants = payload.variants;
  const sortedByNet = [...variants].sort((a: any, b: any) => b.metrics.netUsd - a.metrics.netUsd);
  const baseline = variants.find((v: any) => v.id === "baseline");
  const baseNet = baseline.metrics.netUsd;
  const baseDd = baseline.metrics.maxDdUsd;

  const tableRows = sortedByNet.map((v: any) => {
    const m = v.metrics;
    const beatsNet = m.netUsd > baseNet;
    const beatsDd = m.maxDdUsd < baseDd;
    const color = v.id === "baseline" ? "#F7931A"
      : beatsNet && beatsDd ? "#10b981"
      : beatsNet ? "#fbbf24"
      : "#ffb4ab";
    const pf = m.pf === 999 ? "∞" : m.pf.toFixed(2);
    return `<tr>
      <td style="color:${color};font-weight:700">${v.id}</td>
      <td style="font-size:10px;color:#cfc6bc">${v.label}</td>
      <td>${m.trades}</td>
      <td>${m.winRate.toFixed(1)}%</td>
      <td>${pf}</td>
      <td style="color:${m.netUsd >= 0 ? '#10b981' : '#ffb4ab'};font-weight:700">${m.netUsd >= 0 ? '+' : ''}$${m.netUsd.toLocaleString()}</td>
      <td>$${m.finalEquity.toLocaleString()}</td>
      <td>${m.roiPct >= 0 ? '+' : ''}${m.roiPct.toLocaleString()}%</td>
      <td style="color:#ffb4ab">-$${m.maxDdUsd.toLocaleString()}</td>
      <td>${m.avgHoldBars.toFixed(1)}</td>
      <td>${beatsNet && beatsDd ? '✅' : beatsNet ? '⚠️' : v.id === 'baseline' ? '—' : '❌'}</td>
    </tr>`;
  }).join("");

  const variantCards = sortedByNet.map((v: any) => {
    const m = v.metrics;
    const ps = v.perSource;
    const pf = m.pf === 999 ? "∞" : m.pf.toFixed(2);
    const headerColor = v.id === "baseline" ? "#F7931A" : "#ffdcc0";
    const psRows = (["stoch_long", "stoch_short", "sr_long", "sr_short"] as const).map((src) => {
      const x = ps[src];
      return `<tr><td>${src}</td><td>${x.trades}</td><td>${x.winRate.toFixed(1)}%</td><td style="color:${x.netUsd >= 0 ? '#10b981' : '#ffb4ab'}">${x.netUsd >= 0 ? '+' : ''}$${x.netUsd.toLocaleString()}</td></tr>`;
    }).join("");
    const paramsStr = Object.entries(v.params).map(([k, val]) => `${k}=${val}`).join(", ");
    return `<div class="vcard">
      <div class="vhead" style="color:${headerColor}">${v.id} — ${v.label}</div>
      <div class="vparams">${paramsStr}</div>
      <div class="vmetrics">
        <span>Trades <b>${m.trades}</b></span>
        <span>WR <b>${m.winRate.toFixed(1)}%</b></span>
        <span>PF <b>${pf}</b></span>
        <span>NET <b style="color:${m.netUsd >= 0 ? '#10b981' : '#ffb4ab'}">${m.netUsd >= 0 ? '+' : ''}$${m.netUsd.toLocaleString()}</b></span>
        <span>Final <b>$${m.finalEquity.toLocaleString()}</b></span>
        <span>ROI <b>${m.roiPct >= 0 ? '+' : ''}${m.roiPct.toLocaleString()}%</b></span>
        <span>MaxDD <b style="color:#ffb4ab">-$${m.maxDdUsd.toLocaleString()}</b></span>
        <span>Avg hold <b>${m.avgHoldBars.toFixed(1)} bars</b></span>
      </div>
      <table class="psTbl"><thead><tr><th>source</th><th>trades</th><th>WR</th><th>NET</th></tr></thead><tbody>${psRows}</tbody></table>
    </div>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="vi"><head><meta charset="UTF-8"/>
<title>Sweep · 5m ALL Improve · 3Y · BTC</title>
<style>
  body { background:#131313; color:#e5e2e1; font-family:'JetBrains Mono','Menlo',monospace; font-size:12px; padding:18px; margin:0; }
  h1 { color:#F7931A; font-size:20px; letter-spacing:1px; margin:0 0 6px 0; }
  h2 { color:#ffdcc0; font-size:14px; letter-spacing:1px; margin:24px 0 10px 0; border-bottom:1px solid #2a2a2a; padding-bottom:4px; }
  .info { color:#9f8e80; font-size:11px; margin-bottom:16px; line-height:1.7; }
  .card { background:#1a1a1a; border:1px solid #2a2a2a; padding:14px 18px; border-radius:6px; margin-bottom:14px; }
  table { border-collapse:collapse; width:100%; }
  th, td { border:1px solid #2a2a2a; padding:6px 9px; text-align:left; }
  th { background:#1c1b1b; color:#F7931A; font-size:10px; letter-spacing:1px; text-transform:uppercase; }
  tr:nth-child(2n) td { background:#181818; }
  .legend { display:flex; flex-wrap:wrap; gap:14px; margin-top:10px; }
  .legendItem { display:flex; align-items:center; gap:6px; color:#cfc6bc; font-size:11px; }
  .swatch { width:18px; height:3px; display:inline-block; border-radius:2px; }
  .vgrid { display:grid; grid-template-columns:repeat(2, 1fr); gap:14px; }
  .vcard { background:#1a1a1a; border:1px solid #2a2a2a; border-radius:6px; padding:12px 14px; }
  .vhead { font-size:13px; font-weight:700; letter-spacing:1px; margin-bottom:4px; }
  .vparams { color:#9f8e80; font-size:10px; margin-bottom:8px; }
  .vmetrics { display:flex; flex-wrap:wrap; gap:12px; color:#cfc6bc; font-size:11px; margin-bottom:8px; }
  .vmetrics b { color:#ffdcc0; }
  .psTbl { font-size:10px; margin-top:6px; }
  .psTbl th, .psTbl td { padding:3px 6px; }
</style></head>
<body>
<h1>📊 SWEEP · 5m ALL IMPROVE · ${YEARS}-YEAR · BTC/USDT</h1>
<div class="info">
  Generated: ${new Date(payload.generatedAt).toISOString()} ·
  Variants: <b>${variants.length}</b> ·
  Total 5m candles: <b>${payload.totalCandles5m.toLocaleString()}</b> ·
  Baseline: NET <b style="color:#F7931A">${baseNet >= 0 ? '+' : ''}$${baseNet.toLocaleString()}</b> · MaxDD <b>$${baseDd.toLocaleString()}</b><br>
  Hedge mode preserved per variant (LONG + SHORT independent stacks, per-entry TP/SL, partial-close on hit).
</div>

<h2>📈 EQUITY CURVE OVERLAY</h2>
<div class="card">
  ${overlayEquitySvg(variants.map((v: any) => ({ id: v.id, label: v.label, curve: v.metrics.equityCurveUsd })), 900, 320)}
  ${legendHtml(variants.map((v: any) => ({ id: v.id, label: v.label })))}
</div>

<h2>🏁 COMPARISON (sorted by NET)</h2>
<div class="card">
  <table>
    <thead><tr>
      <th>Variant</th><th>Label</th><th>Trades</th><th>WR</th><th>PF</th>
      <th>NET</th><th>Final</th><th>ROI</th><th>MaxDD</th><th>Avg hold</th><th>vs base</th>
    </tr></thead>
    <tbody>${tableRows}</tbody>
  </table>
  <div style="margin-top:10px;color:#9f8e80;font-size:11px">
    ✅ beats baseline on BOTH NET and MaxDD · ⚠️ beats NET but worse MaxDD (risk-off tradeoff) · ❌ lost vs baseline
  </div>
</div>

<h2>🃏 VARIANT CARDS</h2>
<div class="vgrid">${variantCards}</div>

</body></html>`;
}

// ─── Main ───────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n=== SWEEP 5m ALL IMPROVE · ${YEARS}Y · BTC/USDT ===`);
  console.log(`Loading cached candles...`);
  const candles5m = loadCached("5m");
  const candles15m = loadCached("15m");
  console.log(`  5m: ${candles5m.length.toLocaleString()} · 15m: ${candles15m.length.toLocaleString()}`);

  console.log(`Precomputing Stoch5m K + EMA200 5m...`);
  const closes5m = candles5m.map((c) => c.close);
  const stoch = calcStochRSISeries(closes5m);
  const ema200 = calcEMASeries(closes5m, 200);
  console.log(`Precomputing S/R 15m (lookback ${SR_LOOKBACK_15M})...`);
  const { support: srSupport, resistance: srResistance } = precomputeSR15m(candles15m, SR_LOOKBACK_15M);

  const variantConfigs: VariantConfig[] = [
    { id: "baseline", label: "TP4/SL2 stoch+SR fallback", tpPct: 4, slPct: 2, stackMax: 15, spacingMin: 10, distPct: 0.3 },
    { id: "A1", label: "Tighter TP3/SL1.5", tpPct: 3, slPct: 1.5, stackMax: 15, spacingMin: 10, distPct: 0.3 },
    { id: "A2", label: "Looser TP5/SL2.5", tpPct: 5, slPct: 2.5, stackMax: 15, spacingMin: 10, distPct: 0.3 },
    { id: "A3", label: "Stack 30 / dist 0.2%", tpPct: 4, slPct: 2, stackMax: 30, spacingMin: 10, distPct: 0.2 },
    { id: "A4", label: "Stack 50 / dist 0% (PRESET B)", tpPct: 4, slPct: 2, stackMax: 50, spacingMin: 10, distPct: 0 },
    { id: "B1", label: "Stoch-only (no SR fallback)", tpPct: 4, slPct: 2, stackMax: 15, spacingMin: 10, distPct: 0.3, stochOnly: true },
    { id: "B2", label: "EMA200 5m trend filter", tpPct: 4, slPct: 2, stackMax: 15, spacingMin: 10, distPct: 0.3, ema200Filter: true },
    { id: "B3", label: "Confluence (stoch AND SR)", tpPct: 4, slPct: 2, stackMax: 15, spacingMin: 10, distPct: 0.3, confluence: true },
    { id: "C1", label: "Trailing stop (arm +2%, trail 1%)", tpPct: 4, slPct: 2, stackMax: 15, spacingMin: 10, distPct: 0.3, trailing: true },
    { id: "C2", label: "Partial TP 50% @+2%", tpPct: 4, slPct: 2, stackMax: 15, spacingMin: 10, distPct: 0.3, partialTp: true },
    { id: "C3", label: "Time exit > 4h (48 bars)", tpPct: 4, slPct: 2, stackMax: 15, spacingMin: 10, distPct: 0.3, timeExitBars: 48 },
  ];

  const variantResults: any[] = [];
  for (const vc of variantConfigs) {
    process.stdout.write(`\n[${vc.id}] ${vc.label}... `);
    const t0 = Date.now();
    const { trades, finalCapital, equityPerTrade } = runBacktest(
      vc, candles5m, stoch.kSeries, ema200, candles15m, srSupport, srResistance,
    );
    const metrics = summarize(trades, finalCapital, equityPerTrade);
    const perSource = summarizePerSource(trades);
    console.log(`done ${(Date.now() - t0) / 1000 | 0}s · ${metrics.trades} trades · NET $${metrics.netUsd.toLocaleString()} · Final $${metrics.finalEquity.toLocaleString()} · MaxDD $${metrics.maxDdUsd.toLocaleString()}`);
    variantResults.push({
      id: vc.id,
      label: vc.label,
      params: {
        tpPct: vc.tpPct, slPct: vc.slPct,
        stackMax: vc.stackMax, spacingMin: vc.spacingMin, distPct: vc.distPct,
        stochOnly: vc.stochOnly || false,
        ema200Filter: vc.ema200Filter || false,
        confluence: vc.confluence || false,
        trailing: vc.trailing || false,
        partialTp: vc.partialTp || false,
        timeExitBars: vc.timeExitBars || 0,
      },
      metrics,
      perSource,
    });
  }

  const payload = {
    generatedAt: Date.now(),
    years: YEARS,
    initialCapital: INITIAL_CAPITAL,
    totalCandles5m: candles5m.length,
    totalCandles15m: candles15m.length,
    variants: variantResults,
  };

  const outDir = join(__dirname, "..", "assets");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, "sweep_5mall_improve.json");
  const htmlPath = join(outDir, "sweep_5mall_improve_report.html");
  writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
  writeFileSync(htmlPath, renderHtml(payload));

  console.log(`\n✅ Output:`);
  console.log(`  ${jsonPath}`);
  console.log(`  ${htmlPath}`);

  console.log(`\n=== TOP 5 by NET ===`);
  const sorted = [...variantResults].sort((a, b) => b.metrics.netUsd - a.metrics.netUsd);
  for (const v of sorted.slice(0, 5)) {
    console.log(`  ${v.id.padEnd(10)} NET $${v.metrics.netUsd.toLocaleString().padStart(12)} · Final $${v.metrics.finalEquity.toLocaleString().padStart(12)} · MaxDD $${v.metrics.maxDdUsd.toLocaleString().padStart(8)} · WR ${v.metrics.winRate.toFixed(1)}% · ${v.label}`);
  }
})();
