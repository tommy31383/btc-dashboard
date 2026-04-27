/**
 * backtest-5mall-3y.ts
 *
 * Backtest engine 5m ALL (utils/all5mAccount.ts) trên 3 năm BTC data.
 *
 * Engine logic mỗi cây 5m closed:
 *   1. Stoch5m K<10 → LONG (stoch_long); K>90 → SHORT (stoch_short)
 *   2. Else fallback S/R 15m: close ≤ support × 1.003 → LONG (sr_long);
 *      close ≥ resistance × 0.997 → SHORT (sr_short)
 *   3. No signal → skip
 *
 * Apply gates theo thứ tự (mirror tryEntry5mBar):
 *   ① Dedup theo bar5mTime
 *   ② Cooldown 10m all-side (lastEntryMs)
 *   ③ Free margin ≥ $30
 *   ④ Detect side + source
 *   ⑤ SMART STACK gates per side: max 15, spacing 10m, dist ≥ 0.3%
 *   ⑥ Push position
 *
 * Plan B monitor: scan từng cây 5m sau entry → first hit TP (+4%) hoặc SL (-2%) → close.
 * Cap loss tại -$30 (margin); fee $1.5/side ($3/trade).
 *
 * Output:
 *   • assets/backtest_5mall_3y.json
 *   • assets/backtest_5mall_3y_report.html
 *
 * Usage:
 *   npx tsx tools/backtest-5mall-3y.ts
 *   npx tsx tools/backtest-5mall-3y.ts --years=3 --fee=0.05 --stackMax=15 --stackSpacing=10 --stackDist=0.3
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { Candle } from "../utils/backtester";
import { calcStochRSISeries } from "../utils/indicators";

const BINANCE_REST = "https://api.binance.com/api/v3";

// ─── CLI ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const YEARS = parseFloat(args.find((a) => a.startsWith("--years="))?.replace("--years=", "") || "3");
const FEE_PER_SIDE_PCT = parseFloat(args.find((a) => a.startsWith("--fee="))?.replace("--fee=", "") || "0.05");
const STACK_MAX_PER_SIDE = parseFloat(args.find((a) => a.startsWith("--stackMax="))?.replace("--stackMax=", "") || "15");
const STACK_PER_SIDE_SPACING_MIN = parseFloat(args.find((a) => a.startsWith("--stackSpacing="))?.replace("--stackSpacing=", "") || "10");
const STACK_MIN_ENTRY_DIST_PCT = parseFloat(args.find((a) => a.startsWith("--stackDist="))?.replace("--stackDist=", "") || "0.3");

// Engine constants (mirror utils/all5mAccount.ts)
const INITIAL_CAPITAL = 1000;
const MARGIN_PER_TRADE = 30;
const LEVERAGE = 100;
const NOTIONAL = MARGIN_PER_TRADE * LEVERAGE; // 3000
const TP_PCT = 4;
const SL_PCT = 2;
const STOCH_LONG_LEVEL = 10;
const STOCH_SHORT_LEVEL = 90;
const COOLDOWN_MS = 10 * 60 * 1000;
const SR_PROXIMITY_PCT = 0.3;
const SR_LOOKBACK_15M = 50;
const STACK_PER_SIDE_SPACING_MS = STACK_PER_SIDE_SPACING_MIN * 60 * 1000;
const FEE_PER_SIDE = NOTIONAL * (FEE_PER_SIDE_PCT / 100); // $1.5

const BARS_PER_YEAR_5M = 365 * 24 * 12;
const BARS_PER_YEAR_15M = 365 * 24 * 4;

type Side = "LONG" | "SHORT";
type EntrySource = "stoch_long" | "stoch_short" | "sr_long" | "sr_short";

// ─── Fetch klines (cached) ──────────────────────────────────────────────────
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
      if (Array.isArray(data) && data.length >= total * 0.9) return data;
    } catch {}
  }
  const fetched = await fetchKlinesRaw(interval, total);
  writeFileSync(cachePath, JSON.stringify(fetched));
  return fetched;
}

// ─── S/R 15m precompute (rolling 50 candles, exclude in-progress) ───────────
function precomputeSR15m(candles15m: Candle[], lookback = SR_LOOKBACK_15M): { support: (number | null)[]; resistance: (number | null)[] } {
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

// ─── Trade types ────────────────────────────────────────────────────────────
interface TradeOutcome {
  bar5mTime: number;
  side: Side;
  source: EntrySource;
  entryPrice: number;
  exitPrice: number;
  exitMs: number;
  outcome: "WIN" | "LOSS";
  pnlPct: number;     // raw price %
  netUsd: number;     // gross - 2 × fee, capped at -margin
  holdBars: number;
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
}

// ─── Main backtest loop ─────────────────────────────────────────────────────
function runBacktest(
  candles5m: Candle[],
  stochK: (number | null)[],
  candles15m: Candle[],
  srSupport: (number | null)[],
  srResistance: (number | null)[],
) {
  const trades: TradeOutcome[] = [];
  const open: OpenPos[] = [];
  let lastEntryMs = 0;
  let capital = INITIAL_CAPITAL;

  const signalsBySource = { stoch_long: 0, stoch_short: 0, sr_long: 0, sr_short: 0 };
  const blocked = { cooldown: 0, stackFull: 0, spacing: 0, distance: 0 };

  // Per-trade equity history (capital snapshot AFTER each closed trade)
  const equityPerTrade: number[] = [];

  for (let i = SR_LOOKBACK_15M; i < candles5m.length; i++) {
    const bar = candles5m[i];
    const t = bar.time;
    const close = bar.close;

    // Plan B monitor: check OPEN positions trên cây i (high/low quét trong cây)
    for (let pi = open.length - 1; pi >= 0; pi--) {
      const p = open[pi];
      if (p.entryIdx >= i) continue; // entry cây trước, không check chính cây entry
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
      });
      equityPerTrade.push(capital);
      open.splice(pi, 1);
    }

    // Try entry trên cây 5m vừa close (close decision)
    // ① Dedup theo bar5mTime
    if (open.some((p) => p.bar5mTime === t)) continue;
    // ② Cooldown 10m all-side
    if (t - lastEntryMs < COOLDOWN_MS) {
      // chỉ count blocked nếu thực sự có signal candidate
      const k = stochK[i];
      const sr = srAtTime(candles15m, srSupport, srResistance, t);
      const hasSig = (k !== null && (k < STOCH_LONG_LEVEL || k > STOCH_SHORT_LEVEL))
        || (sr.support !== null && sr.resistance !== null && (
          ((close - sr.support) / sr.support) * 100 <= SR_PROXIMITY_PCT && close >= sr.support
          || ((sr.resistance - close) / close) * 100 <= SR_PROXIMITY_PCT && close <= sr.resistance
        ));
      if (hasSig) blocked.cooldown++;
      continue;
    }
    // ③ Free margin
    const usedMargin = open.length * MARGIN_PER_TRADE;
    if (capital - usedMargin < MARGIN_PER_TRADE) continue;

    // ④ Detect side + source
    let side: Side | null = null;
    let source: EntrySource | null = null;
    const k = stochK[i];
    if (k !== null && k < STOCH_LONG_LEVEL) { side = "LONG"; source = "stoch_long"; }
    else if (k !== null && k > STOCH_SHORT_LEVEL) { side = "SHORT"; source = "stoch_short"; }
    else {
      const sr = srAtTime(candles15m, srSupport, srResistance, t);
      if (sr.support !== null && sr.resistance !== null) {
        const distSup = ((close - sr.support) / sr.support) * 100;
        const distRes = ((sr.resistance - close) / close) * 100;
        if (distSup >= 0 && distSup <= SR_PROXIMITY_PCT) { side = "LONG"; source = "sr_long"; }
        else if (distRes >= 0 && distRes <= SR_PROXIMITY_PCT) { side = "SHORT"; source = "sr_short"; }
      }
    }
    if (!side || !source) continue;
    signalsBySource[source]++;

    // ⑤ SMART STACK gates (per side)
    const sameSide = open.filter((p) => p.side === side);
    if (sameSide.length >= STACK_MAX_PER_SIDE) { blocked.stackFull++; continue; }
    if (sameSide.length > 0) {
      const lastSame = sameSide.reduce((a, b) => (a.entryMs > b.entryMs ? a : b));
      if (t - lastSame.entryMs < STACK_PER_SIDE_SPACING_MS) { blocked.spacing++; continue; }
      const distPct = Math.abs(close - lastSame.entryPrice) / lastSame.entryPrice * 100;
      if (distPct < STACK_MIN_ENTRY_DIST_PCT) { blocked.distance++; continue; }
    }

    // ⑥ Push position
    const tpPrice = side === "LONG" ? close * (1 + TP_PCT / 100) : close * (1 - TP_PCT / 100);
    const slPrice = side === "LONG" ? close * (1 - SL_PCT / 100) : close * (1 + SL_PCT / 100);
    open.push({
      bar5mTime: t, entryIdx: i,
      side, source,
      entryPrice: close, entryMs: t,
      tpPrice, slPrice,
    });
    lastEntryMs = t;
  }

  return { trades, signalsBySource, blocked, finalCapital: capital, equityPerTrade };
}

// ─── Stats helpers ──────────────────────────────────────────────────────────
function summarizeTrades(trades: TradeOutcome[], finalCapital: number, equityPerTrade: number[]) {
  const total = trades.length;
  const wins = trades.filter((t) => t.outcome === "WIN").length;
  const losses = trades.filter((t) => t.outcome === "LOSS").length;
  const winRate = total ? (wins / total) * 100 : 0;
  const avgWinPct = wins ? trades.filter((t) => t.outcome === "WIN").reduce((s, t) => s + t.pnlPct, 0) / wins : 0;
  const avgLossPct = losses ? trades.filter((t) => t.outcome === "LOSS").reduce((s, t) => s + t.pnlPct, 0) / losses : 0;
  const netUsd = trades.reduce((s, t) => s + t.netUsd, 0);
  const roi = ((finalCapital - INITIAL_CAPITAL) / INITIAL_CAPITAL) * 100;

  // Equity in USD: prepend INITIAL_CAPITAL, downsample to 200
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

  // Max drawdown USD (over per-trade capital sequence)
  let peak = INITIAL_CAPITAL, maxDD = 0;
  for (const v of fullCurve) {
    if (v > peak) peak = v;
    const dd = peak - v;
    if (dd > maxDD) maxDD = dd;
  }

  const grossWinUsd = trades.filter((t) => t.netUsd > 0).reduce((s, t) => s + t.netUsd, 0);
  const grossLossUsd = Math.abs(trades.filter((t) => t.netUsd < 0).reduce((s, t) => s + t.netUsd, 0));
  const profitFactor = grossLossUsd > 0 ? grossWinUsd / grossLossUsd : (grossWinUsd > 0 ? 999 : 0);
  const avgHoldBars = total ? trades.reduce((s, t) => s + t.holdBars, 0) / total : 0;

  return {
    total, wins, losses,
    winRate: Math.round(winRate * 100) / 100,
    avgWinPct: Math.round(avgWinPct * 1000) / 1000,
    avgLossPct: Math.round(avgLossPct * 1000) / 1000,
    netUsd: Math.round(netUsd * 100) / 100,
    finalCapital: Math.round(finalCapital * 100) / 100,
    roi: Math.round(roi * 100) / 100,
    maxDrawdownUsd: Math.round(maxDD * 100) / 100,
    profitFactor: profitFactor === 999 ? 999 : Math.round(profitFactor * 100) / 100,
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
    const losses = sub.filter((t) => t.outcome === "LOSS").length;
    const wr = sub.length ? (wins / sub.length) * 100 : 0;
    const aw = wins ? sub.filter((t) => t.outcome === "WIN").reduce((s, t) => s + t.pnlPct, 0) / wins : 0;
    const al = losses ? sub.filter((t) => t.outcome === "LOSS").reduce((s, t) => s + t.pnlPct, 0) / losses : 0;
    const netUsd = sub.reduce((s, t) => s + t.netUsd, 0);
    const gw = sub.filter((t) => t.netUsd > 0).reduce((s, t) => s + t.netUsd, 0);
    const gl = Math.abs(sub.filter((t) => t.netUsd < 0).reduce((s, t) => s + t.netUsd, 0));
    const pf = gl > 0 ? gw / gl : (gw > 0 ? 999 : 0);
    out[src] = {
      trades: sub.length, wins, losses,
      winRate: Math.round(wr * 100) / 100,
      avgWinPct: Math.round(aw * 1000) / 1000,
      avgLossPct: Math.round(al * 1000) / 1000,
      netUsd: Math.round(netUsd * 100) / 100,
      profitFactor: pf === 999 ? 999 : Math.round(pf * 100) / 100,
    };
  }
  return out;
}

// ─── HTML report ────────────────────────────────────────────────────────────
function bigEquitySvgUsd(curve: number[], width = 720, height = 220): string {
  if (curve.length < 2) return `<svg width="${width}" height="${height}"></svg>`;
  const min = Math.min(...curve, INITIAL_CAPITAL);
  const max = Math.max(...curve, INITIAL_CAPITAL);
  const range = max - min || 1;
  const pts = curve.map((v, i) => {
    const x = (i / (curve.length - 1)) * width;
    const y = height - ((v - min) / range) * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const baseY = height - ((INITIAL_CAPITAL - min) / range) * height;
  return `<svg width="${width}" height="${height}" style="display:block">
    <line x1="0" y1="${baseY.toFixed(1)}" x2="${width}" y2="${baseY.toFixed(1)}" stroke="#666" stroke-dasharray="4,3" stroke-width="0.8"/>
    <polyline points="${pts}" fill="none" stroke="#F7931A" stroke-width="1.6"/>
    <text x="6" y="14" fill="#9f8e80" font-size="11">max $${max.toFixed(0)}</text>
    <text x="6" y="${(baseY - 4).toFixed(1)}" fill="#9f8e80" font-size="10">baseline $${INITIAL_CAPITAL}</text>
    <text x="6" y="${height - 6}" fill="#9f8e80" font-size="11">min $${min.toFixed(0)}</text>
  </svg>`;
}

function histogramSvg(trades: TradeOutcome[], width = 480, height = 160): string {
  if (trades.length === 0) return `<svg width="${width}" height="${height}"></svg>`;
  // Buckets: -2 (loss), and +4 (win) — pnlPct là raw price % và TP/SL fixed nên đa số sẽ rơi 2 bucket
  const buckets: Record<string, number> = {};
  const labels = ["-2.0", "-1.5", "-1.0", "-0.5", "0", "+0.5", "+1.0", "+1.5", "+2.0", "+2.5", "+3.0", "+3.5", "+4.0"];
  for (const l of labels) buckets[l] = 0;
  for (const t of trades) {
    const v = t.pnlPct;
    let bucket = labels[labels.length - 1];
    for (const l of labels) {
      if (v <= parseFloat(l) + 0.25) { bucket = l; break; }
    }
    buckets[bucket]++;
  }
  const maxCount = Math.max(...Object.values(buckets), 1);
  const barW = width / labels.length;
  const bars = labels.map((l, i) => {
    const cnt = buckets[l];
    const h = (cnt / maxCount) * (height - 30);
    const x = i * barW + 2;
    const y = height - 20 - h;
    const isLoss = parseFloat(l) < 0;
    const color = isLoss ? "#ffb4ab" : "#10b981";
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(barW - 4).toFixed(1)}" height="${h.toFixed(1)}" fill="${color}" opacity="0.85"/>
            <text x="${(x + barW / 2 - 2).toFixed(1)}" y="${height - 6}" fill="#9f8e80" font-size="9" text-anchor="middle">${l}</text>
            ${cnt > 0 ? `<text x="${(x + barW / 2 - 2).toFixed(1)}" y="${(y - 2).toFixed(1)}" fill="#cfc6bc" font-size="9" text-anchor="middle">${cnt}</text>` : ""}`;
  }).join("\n");
  return `<svg width="${width}" height="${height}">${bars}</svg>`;
}

function monthlyTradesSvg(trades: TradeOutcome[], width = 720, height = 120): string {
  if (trades.length === 0) return `<svg width="${width}" height="${height}"></svg>`;
  const monthMap = new Map<string, number>();
  for (const t of trades) {
    const d = new Date(t.bar5mTime);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    monthMap.set(key, (monthMap.get(key) || 0) + 1);
  }
  const keys = Array.from(monthMap.keys()).sort();
  const counts = keys.map((k) => monthMap.get(k) || 0);
  const maxCount = Math.max(...counts, 1);
  const barW = width / keys.length;
  const bars = keys.map((k, i) => {
    const cnt = counts[i];
    const h = (cnt / maxCount) * (height - 24);
    const x = i * barW + 1;
    const y = height - 16 - h;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, barW - 2).toFixed(1)}" height="${h.toFixed(1)}" fill="#F7931A" opacity="0.8"/>`;
  }).join("");
  const firstLabel = keys[0];
  const lastLabel = keys[keys.length - 1];
  return `<svg width="${width}" height="${height}">
    ${bars}
    <text x="2" y="${height - 2}" fill="#9f8e80" font-size="10">${firstLabel}</text>
    <text x="${width - 50}" y="${height - 2}" fill="#9f8e80" font-size="10">${lastLabel}</text>
    <text x="${width - 100}" y="12" fill="#9f8e80" font-size="10">max ${maxCount}/mo</text>
  </svg>`;
}

function renderHtml(payload: any): string {
  const s = payload.stats;
  const ps = payload.perSource;
  const sources: EntrySource[] = ["stoch_long", "stoch_short", "sr_long", "sr_short"];
  const sourceCards = sources.map((src) => {
    const x = ps[src];
    const wrColor = x.winRate >= 60 ? "#10b981" : x.winRate >= 45 ? "#ffb874" : "#ffb4ab";
    const netColor = x.netUsd >= 0 ? "#10b981" : "#ffb4ab";
    const pf = x.profitFactor === 999 ? "∞" : x.profitFactor.toFixed(2);
    const rawSig = payload.signalsBySource[src];
    return `<div class="srcCard">
      <div class="srcTitle">${src}</div>
      <div class="srcRow">Raw signals: <b>${rawSig}</b></div>
      <div class="srcRow">Trades: <b>${x.trades}</b> (W ${x.wins} / L ${x.losses})</div>
      <div class="srcRow">WR: <b style="color:${wrColor}">${x.winRate.toFixed(1)}%</b></div>
      <div class="srcRow">Avg W/L raw: +${x.avgWinPct.toFixed(2)}% / ${x.avgLossPct.toFixed(2)}%</div>
      <div class="srcRow">NET: <b style="color:${netColor}">${x.netUsd >= 0 ? "+" : ""}$${x.netUsd.toFixed(2)}</b></div>
      <div class="srcRow">PF: <b>${pf}</b></div>
    </div>`;
  }).join("");

  const recentTrades = payload.trades.slice(-50).reverse();
  const tradeRows = recentTrades.map((t: TradeOutcome) => {
    const dt = new Date(t.bar5mTime).toISOString().slice(0, 16).replace("T", " ");
    const sideColor = t.side === "LONG" ? "#10b981" : "#ffb4ab";
    const netColor = t.netUsd >= 0 ? "#10b981" : "#ffb4ab";
    const outcomeColor = t.outcome === "WIN" ? "#10b981" : "#ffb4ab";
    return `<tr>
      <td>${dt}</td>
      <td style="color:${sideColor};font-weight:700">${t.side}</td>
      <td style="font-size:10px">${t.source}</td>
      <td>$${t.entryPrice.toFixed(1)}</td>
      <td>$${t.exitPrice.toFixed(1)}</td>
      <td style="color:${netColor};font-weight:700">${t.netUsd >= 0 ? "+" : ""}$${t.netUsd.toFixed(2)}</td>
      <td style="color:${outcomeColor};font-weight:700">${t.outcome}</td>
    </tr>`;
  }).join("");

  const cfg = payload.config;
  const wrColor = s.winRate >= 60 ? "#10b981" : s.winRate >= 45 ? "#ffb874" : "#ffb4ab";
  const roiColor = s.roi >= 0 ? "#10b981" : "#ffb4ab";
  const pfStr = s.profitFactor === 999 ? "∞" : s.profitFactor.toFixed(2);

  return `<!DOCTYPE html>
<html lang="vi"><head><meta charset="UTF-8"/>
<title>5m ALL Backtest 3-Year · BTC Dashboard</title>
<style>
  body { background:#131313; color:#e5e2e1; font-family:'JetBrains Mono','Menlo',monospace; font-size:12px; padding:18px; margin:0; }
  h1 { color:#F7931A; font-size:20px; letter-spacing:1px; margin:0 0 6px 0; }
  h2 { color:#ffdcc0; font-size:14px; letter-spacing:1px; margin:24px 0 10px 0; border-bottom:1px solid #2a2a2a; padding-bottom:4px; }
  .info { color:#9f8e80; font-size:11px; margin-bottom:16px; line-height:1.7; }
  .card { background:#1a1a1a; border:1px solid #2a2a2a; padding:14px 18px; border-radius:6px; margin-bottom:14px; }
  .agg { display:flex; flex-wrap:wrap; gap:24px; align-items:center; }
  .stat { color:#cfc6bc; }
  .stat b { color:#ffdcc0; font-size:14px; }
  .pos { color:#10b981; }
  .neg { color:#ffb4ab; }
  .roiBadge { display:inline-block; padding:6px 14px; border-radius:14px; font-size:16px; font-weight:700; }
  .srcGrid { display:grid; grid-template-columns:repeat(4, 1fr); gap:12px; }
  .srcCard { background:#1a1a1a; border:1px solid #2a2a2a; border-radius:6px; padding:12px; }
  .srcTitle { color:#F7931A; font-size:13px; font-weight:700; margin-bottom:8px; letter-spacing:1px; }
  .srcRow { color:#cfc6bc; font-size:11px; line-height:1.7; }
  .srcRow b { color:#ffdcc0; }
  table { border-collapse:collapse; width:100%; }
  th, td { border:1px solid #2a2a2a; padding:6px 9px; text-align:left; }
  th { background:#1c1b1b; color:#F7931A; font-size:10px; letter-spacing:1px; text-transform:uppercase; }
  tr:nth-child(2n) td { background:#181818; }
  .blocks { color:#9f8e80; font-size:11px; line-height:1.8; }
  .blocks b { color:#ffb874; }
</style></head>
<body>
<h1>📊 5m ALL · LIVE-LOGIC BACKTEST · 3 YEAR · BTC/USDT</h1>
<div class="info">
  Generated: ${new Date(payload.generatedAt).toISOString()} ·
  Total 5m candles: <b>${payload.totalCandles5m.toLocaleString()}</b> ·
  Years: ${cfg.years} · Fee/side: ${cfg.fee}% · Stack max: ${cfg.stackMax}/side · Spacing: ${cfg.stackSpacing}m · MinDist: ${cfg.stackDist}%<br>
  Engine: Stoch5m K&lt;10 LONG / K&gt;90 SHORT, fallback S/R 15m (lookback 50, ≤0.3% proximity) · TP +4% / SL -2% · Margin $30 × 100x = $3000 notional · Cooldown 10m all-side
</div>

<div class="card">
  <h2 style="margin-top:0">⚡ AGGREGATE</h2>
  <div class="agg">
    <div class="stat">Trades: <b>${s.total}</b></div>
    <div class="stat">W/L: <b>${s.wins}/${s.losses}</b></div>
    <div class="stat">Win rate: <b style="color:${wrColor}">${s.winRate.toFixed(1)}%</b></div>
    <div class="stat">PF: <b>${pfStr}</b></div>
    <div class="stat">Avg hold: <b>${s.avgHoldBars.toFixed(1)} × 5m</b></div>
    <div class="stat">NET: <b class="${s.netUsd >= 0 ? 'pos' : 'neg'}">${s.netUsd >= 0 ? "+" : ""}$${s.netUsd.toFixed(2)}</b></div>
    <div class="stat">MaxDD: <b class="neg">-$${s.maxDrawdownUsd.toFixed(2)}</b></div>
    <div class="stat">Final capital: <b>$${s.finalCapital.toFixed(2)}</b></div>
    <div class="stat">ROI: <span class="roiBadge" style="background:${s.roi >= 0 ? '#10b98122' : '#ffb4ab22'};color:${roiColor}">${s.roi >= 0 ? "+" : ""}${s.roi.toFixed(1)}%</span></div>
  </div>
  <div class="blocks" style="margin-top:14px">
    Blocked entries — cooldown 10m all-side: <b>${payload.blocked.cooldown}</b> ·
    stack full: <b>${payload.blocked.stackFull}</b> ·
    spacing same-side: <b>${payload.blocked.spacing}</b> ·
    distance &lt;0.3%: <b>${payload.blocked.distance}</b>
  </div>
</div>

<h2>📈 EQUITY CURVE (USD · 200 pts · baseline $${INITIAL_CAPITAL})</h2>
<div class="card">${bigEquitySvgUsd(s.equityCurveUsd, 720, 220)}</div>

<h2>🎯 PER-SOURCE BREAKDOWN</h2>
<div class="srcGrid">${sourceCards}</div>

<h2>📊 PnL DISTRIBUTION (raw price %)</h2>
<div class="card">${histogramSvg(payload.trades, 720, 180)}</div>

<h2>📅 TRADES PER MONTH</h2>
<div class="card">${monthlyTradesSvg(payload.trades, 720, 140)}</div>

<h2>📋 RECENT 50 TRADES</h2>
<table>
<thead><tr>
  <th>Time (UTC)</th><th>Side</th><th>Source</th><th>Entry</th><th>Exit</th><th>Net $</th><th>Outcome</th>
</tr></thead>
<tbody>
${tradeRows}
</tbody></table>
</body></html>`;
}

// ─── Main ───────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n=== 5m ALL BACKTEST ${YEARS}Y · BTC/USDT ===`);
  console.log(`Fee/side: ${FEE_PER_SIDE_PCT}% ($${FEE_PER_SIDE.toFixed(2)}) · Stack max ${STACK_MAX_PER_SIDE}/side · Spacing ${STACK_PER_SIDE_SPACING_MIN}m · MinDist ${STACK_MIN_ENTRY_DIST_PCT}%`);

  // Fetch 5m + 15m
  const target5m = Math.ceil(BARS_PER_YEAR_5M * YEARS);
  const target15m = Math.ceil(BARS_PER_YEAR_15M * YEARS);
  console.log(`\nFetching candles (cached)...`);
  process.stdout.write(`  5m: target ${target5m.toLocaleString()}... `);
  let t0 = Date.now();
  const candles5m = await fetchKlinesCached("5m", target5m, YEARS);
  console.log(`got ${candles5m.length.toLocaleString()} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  process.stdout.write(`  15m: target ${target15m.toLocaleString()}... `);
  t0 = Date.now();
  const candles15m = await fetchKlinesCached("15m", target15m, YEARS);
  console.log(`got ${candles15m.length.toLocaleString()} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  // Precompute Stoch5m
  console.log(`\nPrecomputing Stoch5m K series...`);
  t0 = Date.now();
  const closes5m = candles5m.map((c) => c.close);
  const stoch = calcStochRSISeries(closes5m);
  console.log(`  done (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  // Precompute S/R 15m
  console.log(`\nPrecomputing S/R 15m (lookback ${SR_LOOKBACK_15M})...`);
  t0 = Date.now();
  const { support: srSupport, resistance: srResistance } = precomputeSR15m(candles15m, SR_LOOKBACK_15M);
  console.log(`  done (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  // Run backtest
  console.log(`\nRunning backtest engine over ${candles5m.length.toLocaleString()} 5m candles...`);
  t0 = Date.now();
  const { trades, signalsBySource, blocked, finalCapital, equityPerTrade } =
    runBacktest(candles5m, stoch.kSeries, candles15m, srSupport, srResistance);
  console.log(`  done (${((Date.now() - t0) / 1000).toFixed(1)}s) · ${trades.length} trades · final $${finalCapital.toFixed(2)}`);

  const stats = summarizeTrades(trades, finalCapital, equityPerTrade);
  const perSource = summarizePerSource(trades);

  const payload = {
    generatedAt: Date.now(),
    config: {
      years: YEARS,
      fee: FEE_PER_SIDE_PCT,
      stackMax: STACK_MAX_PER_SIDE,
      stackSpacing: STACK_PER_SIDE_SPACING_MIN,
      stackDist: STACK_MIN_ENTRY_DIST_PCT,
      tp: TP_PCT, sl: SL_PCT,
      margin: MARGIN_PER_TRADE, leverage: LEVERAGE, notional: NOTIONAL,
      cooldownMin: COOLDOWN_MS / 60_000,
      stochLong: STOCH_LONG_LEVEL, stochShort: STOCH_SHORT_LEVEL,
      srProximityPct: SR_PROXIMITY_PCT, srLookback15m: SR_LOOKBACK_15M,
    },
    totalCandles5m: candles5m.length,
    signalsBySource,
    blocked,
    trades,
    stats,
    perSource,
  };

  const outDir = join(__dirname, "..", "assets");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, "backtest_5mall_3y.json");
  const htmlPath = join(outDir, "backtest_5mall_3y_report.html");
  writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
  writeFileSync(htmlPath, renderHtml(payload));

  console.log(`\n✅ Output:`);
  console.log(`  ${jsonPath}`);
  console.log(`  ${htmlPath}`);
  console.log(`\nROI: ${stats.roi >= 0 ? "+" : ""}${stats.roi.toFixed(2)}% · Final $${stats.finalCapital.toFixed(2)} · WR ${stats.winRate.toFixed(1)}% · PF ${stats.profitFactor === 999 ? "∞" : stats.profitFactor.toFixed(2)}`);
})();
