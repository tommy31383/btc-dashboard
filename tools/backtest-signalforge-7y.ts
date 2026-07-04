/**
 * backtest-signalforge-7y.ts — Research-only multi-timeframe Signal Forge audit.
 *
 * This tool does not touch hard_rules.json or any live/paper rule engine. It evaluates
 * the chart-only Signal Forge composite over 7y BTC 5m data, resampled per timeframe.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  DEFAULT_SIGNAL_FORGE_CONFIG,
  SIGNAL_FORGE_INDICATOR_KEYS,
  cloneSignalForgeConfig,
  runSignalForge,
  type SignalForgeConfig,
  type SignalForgeKline,
  type SignalForgeSide,
  type SignalForgeTrade,
} from "../utils/signalForge";

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Timeframe = "5m" | "15m" | "1h" | "4h" | "1d" | "1w" | "1mo";
export type RiskMode = "signalOnly" | "atrRisk";
export type CompositeMode = "AND" | "OR";
export type EquityTrend = "UP" | "FLAT" | "DOWN";

export interface ClosedSignalForgeTrade {
  side: SignalForgeSide;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  pnlPct: number;
  exitReason: NonNullable<SignalForgeTrade["exitReason"]>;
}

interface NetTrade extends ClosedSignalForgeTrade {
  netPnlPct: number;
}

interface FlatStats {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number;
  netPnlPct: number;
  profitPct: number;
  lossPct: number;
  maxDrawdownPct: number;
  equityCurve: number[];
  equityTrend: EquityTrend;
}

interface YearStats {
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  profitFactor: number | null;
  netPnlPct: number;
  profitPct: number;
  lossPct: number;
  maxDrawdownPct: number;
  equityCurve: number[];
  equityTrend: EquityTrend;
  reliable: boolean;
  note?: string;
}

export interface SummaryStats extends FlatStats {
  byYear: Record<string, YearStats>;
  lowTradeYears: string[];
}

interface ComboResult extends SummaryStats {
  id: string;
  timeframe: Timeframe;
  mode: CompositeMode;
  requireAll: boolean;
  riskMode: RiskMode;
  bars: number;
  enabledIndicatorCount: number;
  enabledIndicators: string[];
  activeTradeOpen: boolean;
  activeTrade?: {
    side: SignalForgeSide;
    entryTime: number;
    entryPrice: number;
  };
  trades: NetTrade[];
}

const SOURCE_FILE = "binance-5m-7y.json";
const SOURCE_PATH = join(__dirname, "..", ".cache", SOURCE_FILE);
const OUTPUT_PATH = join(__dirname, "..", "assets", "backtest_signalforge_7y.json");
const FEE_PCT_PER_SIDE = 0.05;
const MIN_TRADES_PER_YEAR = 20;
const TIMEFRAMES: Timeframe[] = ["5m", "15m", "1h", "4h", "1d", "1w", "1mo"];
const MODES: Array<{ mode: CompositeMode; requireAll: boolean }> = [
  { mode: "AND", requireAll: true },
  { mode: "OR", requireAll: false },
];
const RISK_MODES: RiskMode[] = ["signalOnly", "atrRisk"];

const FIXED_BUCKET_MS: Partial<Record<Timeframe, number>> = {
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
  "1w": 7 * 24 * 60 * 60_000,
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function bucketStart(time: number, timeframe: Timeframe): number {
  if (timeframe === "5m") return time;
  if (timeframe === "1mo") {
    const d = new Date(time);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  }
  const bucketMs = FIXED_BUCKET_MS[timeframe];
  if (!bucketMs) throw new Error(`Unsupported fixed timeframe: ${timeframe}`);
  return Math.floor(time / bucketMs) * bucketMs;
}

export function aggregateBars(candles: Candle[], timeframe: Timeframe): Candle[] {
  if (timeframe === "5m") return candles.map((c) => ({ ...c }));

  const out: Candle[] = [];
  let curBucket: number | null = null;
  let open = 0;
  let high = -Infinity;
  let low = Infinity;
  let close = 0;
  let volume = 0;

  const flush = () => {
    if (curBucket === null) return;
    out.push({ time: curBucket, open, high, low, close, volume });
  };

  for (const bar of candles) {
    const bucket = bucketStart(bar.time, timeframe);
    if (curBucket === null || bucket !== curBucket) {
      flush();
      curBucket = bucket;
      open = bar.open;
      high = bar.high;
      low = bar.low;
      close = bar.close;
      volume = bar.volume ?? 0;
      continue;
    }
    if (bar.high > high) high = bar.high;
    if (bar.low < low) low = bar.low;
    close = bar.close;
    volume += bar.volume ?? 0;
  }
  flush();
  return out;
}

export function buildSignalForgeBacktestConfig(requireAll: boolean, riskMode: RiskMode): SignalForgeConfig {
  const config = cloneSignalForgeConfig(DEFAULT_SIGNAL_FORGE_CONFIG);
  config.logic.requireAll = requireAll;
  for (const key of SIGNAL_FORGE_INDICATOR_KEYS) config.indicators[key].enabled = true;

  const enableRisk = riskMode === "atrRisk";
  config.risk.enableTp = enableRisk;
  config.risk.enableSl = enableRisk;
  config.risk.enableTs = enableRisk;
  return config;
}

function toSignalForgeKlines(candles: Candle[]): SignalForgeKline[] {
  return candles.map((c) => ({
    time: c.time,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }));
}

function loadSourceCandles(): Candle[] {
  const raw = JSON.parse(readFileSync(SOURCE_PATH, "utf8"));
  if (!Array.isArray(raw)) throw new Error(`${SOURCE_PATH} is not an array`);
  return raw
    .map((c): Candle => ({
      time: Number(c.time),
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume ?? 0),
    }))
    .filter((c) =>
      Number.isFinite(c.time) &&
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close) &&
      Number.isFinite(c.volume)
    )
    .sort((a, b) => a.time - b.time);
}

function coveredYears(candles: Candle[]): string[] {
  if (candles.length === 0) return [];
  const start = new Date(candles[0].time).getUTCFullYear();
  const end = new Date(candles[candles.length - 1].time).getUTCFullYear();
  const years: string[] = [];
  for (let y = start; y <= end; y++) years.push(String(y));
  return years;
}

function closedTradesFromSignalForge(trades: SignalForgeTrade[]): ClosedSignalForgeTrade[] {
  return trades
    .filter((t) => t.exitTime !== null && t.exitPrice !== null && t.pnlPct !== null && t.exitReason !== null)
    .map((t) => ({
      side: t.side,
      entryTime: t.entryTime,
      exitTime: t.exitTime!,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice!,
      pnlPct: t.pnlPct!,
      exitReason: t.exitReason!,
    }));
}

function netTrades(closedTrades: ClosedSignalForgeTrade[], feePctPerSide: number): NetTrade[] {
  const roundTripFee = feePctPerSide * 2;
  return closedTrades.map((trade) => ({
    ...trade,
    netPnlPct: round4(trade.pnlPct - roundTripFee),
  }));
}

function equityTrendFromCumulative(cum: number[]): EquityTrend {
  const n = cum.length;
  if (n === 0) return "FLAT";
  if (n < 6) return cum[n - 1] > 0 ? "UP" : cum[n - 1] < 0 ? "DOWN" : "FLAT";

  const splitIdx = Math.floor(n * 0.7);
  const earlySlope = (cum[splitIdx - 1] - cum[0]) / Math.max(1, splitIdx - 1);
  const lateSlope = (cum[n - 1] - cum[splitIdx - 1]) / Math.max(1, n - splitIdx);
  const range = Math.max(1, Math.abs(cum[n - 1]));
  const lateNorm = (lateSlope / range) * 100;

  if (lateSlope > earlySlope * 0.5 && lateNorm > 0.05) return "UP";
  if (lateSlope < 0 && Math.abs(lateNorm) > 0.05) return "DOWN";
  return "FLAT";
}

function downsampleCurve(cum: number[], maxPoints = 100): number[] {
  if (cum.length <= maxPoints) return cum.map(round2);
  const out: number[] = [];
  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.floor((i / (maxPoints - 1)) * (cum.length - 1));
    out.push(round2(cum[idx]));
  }
  return out;
}

function flatStats(trades: NetTrade[]): FlatStats {
  const totalTrades = trades.length;
  const wins = trades.filter((t) => t.netPnlPct > 0).length;
  const losses = totalTrades - wins;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const profitPct = trades.filter((t) => t.netPnlPct > 0).reduce((sum, t) => sum + t.netPnlPct, 0);
  const lossPct = trades.filter((t) => t.netPnlPct < 0).reduce((sum, t) => sum + t.netPnlPct, 0);
  const netPnlPct = profitPct + lossPct;
  const profitFactor = lossPct < 0 ? profitPct / Math.abs(lossPct) : profitPct > 0 ? 999 : 0;

  const cum: number[] = [];
  let running = 0;
  for (const trade of trades) {
    running += trade.netPnlPct;
    cum.push(running);
  }

  let peak = 0;
  let maxDrawdownPct = 0;
  for (const value of cum) {
    if (value > peak) peak = value;
    const drawdown = peak - value;
    if (drawdown > maxDrawdownPct) maxDrawdownPct = drawdown;
  }

  return {
    totalTrades,
    wins,
    losses,
    winRate: round2(winRate),
    profitFactor: profitFactor === 999 ? 999 : round2(profitFactor),
    netPnlPct: round2(netPnlPct),
    profitPct: round2(profitPct),
    lossPct: round2(lossPct),
    maxDrawdownPct: round2(maxDrawdownPct),
    equityCurve: downsampleCurve(cum),
    equityTrend: equityTrendFromCumulative(cum),
  };
}

export function summarizeClosedTrades(
  closedTrades: ClosedSignalForgeTrade[],
  years: string[],
  feePctPerSide = FEE_PCT_PER_SIDE
): SummaryStats {
  const trades = netTrades(closedTrades, feePctPerSide);
  const total = flatStats(trades);
  const byYear: Record<string, YearStats> = {};
  const lowTradeYears: string[] = [];

  for (const year of years) {
    const yearTrades = trades.filter((trade) => new Date(trade.exitTime).getUTCFullYear().toString() === year);
    const stats = flatStats(yearTrades);
    const reliable = stats.totalTrades >= MIN_TRADES_PER_YEAR;
    if (!reliable) lowTradeYears.push(`${year}(n=${stats.totalTrades})`);
    byYear[year] = {
      trades: stats.totalTrades,
      wins: stats.wins,
      losses: stats.losses,
      winRate: reliable ? stats.winRate : null,
      profitFactor: reliable ? stats.profitFactor : null,
      netPnlPct: stats.netPnlPct,
      profitPct: stats.profitPct,
      lossPct: stats.lossPct,
      maxDrawdownPct: stats.maxDrawdownPct,
      equityCurve: stats.equityCurve,
      equityTrend: stats.equityTrend,
      reliable,
      ...(reliable ? {} : { note: `n<${MIN_TRADES_PER_YEAR}, không đủ tin cậy` }),
    };
  }

  return {
    ...total,
    byYear,
    lowTradeYears,
  };
}

function runCombo(timeframe: Timeframe, bars: Candle[], years: string[], mode: CompositeMode, requireAll: boolean, riskMode: RiskMode): ComboResult {
  const config = buildSignalForgeBacktestConfig(requireAll, riskMode);
  const result = runSignalForge(toSignalForgeKlines(bars), config);
  const closedTrades = closedTradesFromSignalForge(result.compositeTrades);
  const stats = summarizeClosedTrades(closedTrades, years, FEE_PCT_PER_SIDE);
  const trades = netTrades(closedTrades, FEE_PCT_PER_SIDE);
  const id = `${timeframe}_${mode}_${riskMode}`;

  return {
    id,
    timeframe,
    mode,
    requireAll,
    riskMode,
    bars: bars.length,
    enabledIndicatorCount: result.enabledIndicatorKeys.length,
    enabledIndicators: [...result.enabledIndicatorKeys],
    activeTradeOpen: result.activeCompositeTrade !== null,
    ...(result.activeCompositeTrade
      ? {
          activeTrade: {
            side: result.activeCompositeTrade.side,
            entryTime: result.activeCompositeTrade.entryTime,
            entryPrice: result.activeCompositeTrade.entryPrice,
          },
        }
      : {}),
    ...stats,
    trades,
  };
}

function fmtPct(value: number): string {
  return `${value.toFixed(2)}%`;
}

function fmtPf(value: number): string {
  return value === 999 ? "999" : value.toFixed(2);
}

function pad(value: string | number, width: number): string {
  return String(value).padEnd(width);
}

function printSummary(results: ComboResult[]): void {
  console.log("\n=== SIGNAL FORGE 7Y MULTI-TF BACKTEST ===");
  console.log(`${pad("TF", 5)} | ${pad("mode", 15)} | ${pad("trades", 6)} | ${pad("WR%", 7)} | ${pad("PF", 6)} | ${pad("Net%", 10)} | ${pad("maxDD%", 8)} | ${pad("trend", 5)} | notes`);
  console.log("-".repeat(132));
  for (const r of results) {
    const mode = `${r.mode}-${r.riskMode === "atrRisk" ? "ATR" : "flip"}`;
    const notes = r.lowTradeYears.length > 0 ? `n<${MIN_TRADES_PER_YEAR}/năm không đủ tin cậy: ${r.lowTradeYears.join(", ")}` : "";
    console.log(
      `${pad(r.timeframe, 5)} | ${pad(mode, 15)} | ${String(r.totalTrades).padStart(6)} | ${String(r.winRate.toFixed(2)).padStart(7)} | ${String(fmtPf(r.profitFactor)).padStart(6)} | ${String(fmtPct(r.netPnlPct)).padStart(10)} | ${String(fmtPct(r.maxDrawdownPct)).padStart(8)} | ${pad(r.equityTrend, 5)} | ${notes}`
    );
  }
}

function shortIso(time: number): string {
  return new Date(time).toISOString();
}

function main(): void {
  console.log("[signalforge-7y] Loading .cache/binance-5m-7y.json...");
  const sourceCandles = loadSourceCandles();
  if (sourceCandles.length === 0) throw new Error("No source candles loaded");
  const years = coveredYears(sourceCandles);

  console.log(
    `[signalforge-7y] Source bars=${sourceCandles.length}, period=${shortIso(sourceCandles[0].time)} -> ${shortIso(sourceCandles[sourceCandles.length - 1].time)}, years=${years.join("/")}`
  );

  console.log("[signalforge-7y] Resampling timeframes...");
  const barsByTf = Object.fromEntries(TIMEFRAMES.map((tf) => [tf, aggregateBars(sourceCandles, tf)])) as Record<Timeframe, Candle[]>;
  console.log(
    `[signalforge-7y] ${TIMEFRAMES.map((tf) => `${tf}=${barsByTf[tf].length}`).join(", ")}`
  );

  const results: ComboResult[] = [];
  for (const tf of TIMEFRAMES) {
    for (const { mode, requireAll } of MODES) {
      for (const riskMode of RISK_MODES) {
        console.log(`[signalforge-7y] Running ${tf} ${mode} ${riskMode}...`);
        results.push(runCombo(tf, barsByTf[tf], years, mode, requireAll, riskMode));
      }
    }
  }

  const output = {
    name: "SIGNALFORGE_MULTITF_v1",
    version: 1,
    generated_at: new Date().toISOString(),
    description:
      "Research-only Signal Forge composite backtest over BTC 5m 7y data, resampled to 5m/15m/1h/4h/1d/1w/1mo. All 11 indicators enabled; AND and OR composite variants; signal-flip and ATR TP/SL/trailing variants.",
    source_meta: {
      path: ".cache/binance-5m-7y.json",
      source_bars: sourceCandles.length,
      from: shortIso(sourceCandles[0].time),
      to: shortIso(sourceCandles[sourceCandles.length - 1].time),
      years,
      fee_pct_per_side: FEE_PCT_PER_SIDE,
      leverage: 1,
      min_trades_per_year: MIN_TRADES_PER_YEAR,
    },
    config_meta: {
      default_config_source: "utils/signalForge.ts DEFAULT_SIGNAL_FORGE_CONFIG",
      enabled_indicators: [...SIGNAL_FORGE_INDICATOR_KEYS],
      require_all_variants: MODES.map((m) => ({ mode: m.mode, requireAll: m.requireAll })),
      risk_variants: [
        { riskMode: "signalOnly", enableTp: false, enableSl: false, enableTs: false },
        {
          riskMode: "atrRisk",
          enableTp: true,
          enableSl: true,
          enableTs: true,
          tpMultiplier: DEFAULT_SIGNAL_FORGE_CONFIG.risk.tpMultiplier,
          slMultiplier: DEFAULT_SIGNAL_FORGE_CONFIG.risk.slMultiplier,
          tsMultiplier: DEFAULT_SIGNAL_FORGE_CONFIG.risk.tsMultiplier,
        },
      ],
    },
    timeframe_counts: Object.fromEntries(TIMEFRAMES.map((tf) => [tf, barsByTf[tf].length])),
    results,
  };

  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  printSummary(results);
  console.log(`\n[signalforge-7y] Written assets/backtest_signalforge_7y.json`);
}

if (require.main === module) {
  main();
}
