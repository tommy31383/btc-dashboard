/**
 * generate-hard-rules.ts
 *
 * Pre-bake top-N trading rules per timeframe by:
 *   1. Fetching BTCUSDT klines from Binance for each TF (large window for stats)
 *   2. Running the SAME backtest + optimizer + GA used in-app
 *   3. Writing the top N rules to assets/hard_rules.json
 *
 * The app loads this JSON at startup so users get sensible rules out of the
 * box without waiting for the optimizer to run on their phone.
 *
 * Usage:
 *   npx tsx tools/generate-hard-rules.ts
 *   npx tsx tools/generate-hard-rules.ts --tfs 5m,15m --skip-ga
 *
 * Reuses utils/backtester.ts so any logic change in the app propagates here.
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import {
  Candle,
  BacktestConfig,
  DEFAULT_BACKTEST_CONFIG,
  DEFAULT_GRID_CONFIG,
  optimizeRules,
  evolveRules,
  TopConfigResult,
} from "../utils/backtester";

const BINANCE_REST = "https://api.binance.com/api/v3";

// How many candles to use per TF. Bigger = more reliable rules but slower run.
// Binance allows max 1000 per request, so we paginate when needed.
// 1000 candles per TF balances statistical reliability vs generation time.
// Each TF takes ~3-5 min for grid (920 combos) on a single core.
const TF_WINDOWS: Record<string, { interval: string; candles: number; label: string }> = {
  "5m":  { interval: "5m",  candles: 1500, label: "5M" },  // ~5 days
  "15m": { interval: "15m", candles: 1500, label: "15M" }, // ~16 days
  "1h":  { interval: "1h",  candles: 1500, label: "1H" },  // ~62 days
  "4h":  { interval: "4h",  candles: 1500, label: "4H" },  // ~250 days
  "1d":  { interval: "1d",  candles: 1500, label: "1D" },  // ~4 years
  "1w":  { interval: "1w",  candles: 500,  label: "1W" },  // ~10 years (max)
};

// CLI args
const args = process.argv.slice(2);
const filterTFs = args.find((a) => a.startsWith("--tfs="))?.replace("--tfs=", "").split(",");
const skipGA = args.includes("--skip-ga");
const skipGrid = args.includes("--skip-grid");
const topN = parseInt(args.find((a) => a.startsWith("--top="))?.replace("--top=", "") || "10", 10);

console.log("=== generate-hard-rules ===");
console.log(`TFs: ${filterTFs ? filterTFs.join(", ") : Object.keys(TF_WINDOWS).join(", ")}`);
console.log(`Top N: ${topN} · GA: ${!skipGA} · Grid: ${!skipGrid}`);
console.log("");

/** Fetch klines from Binance, paginating when limit > 1000 */
async function fetchKlines(interval: string, total: number): Promise<Candle[]> {
  const all: Candle[] = [];
  let endTime: number | undefined;
  while (all.length < total) {
    const remaining = total - all.length;
    const limit = Math.min(1000, remaining);
    const params = new URLSearchParams({
      symbol: "BTCUSDT",
      interval,
      limit: String(limit),
    });
    if (endTime) params.set("endTime", String(endTime));
    const url = `${BINANCE_REST}/klines?${params.toString()}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);
    const data: any[] = await res.json();
    if (data.length === 0) break;
    const batch: Candle[] = data.map((k) => ({
      time: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
    // prepend batch (older ones come from earlier endTime)
    all.unshift(...batch);
    endTime = batch[0].time - 1;
    process.stdout.write(`  fetched ${all.length}/${total}\r`);
    // tiny delay to be nice to Binance
    await new Promise((r) => setTimeout(r, 100));
  }
  // Dedup by time + sort
  const byTime = new Map<number, Candle>();
  for (const c of all) byTime.set(c.time, c);
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

interface HardRuleEntry {
  rank: number;
  source: "GRID" | "GA";
  config: BacktestConfig;
  stats: {
    winRate: number;
    profitFactor: number;
    trades: number;
    avgWinPct: number;
    avgLossPct: number;
    avgHoldBars: number;
    wins: number;
    losses: number;
    timeouts: number;
  };
  label: string;
  compositeScore: number;
}

interface HardRulesByTF {
  generated_at: string;
  data_source: string;
  tfs: Record<string, {
    interval: string;
    label: string;
    candles_used: number;
    price_range: { min: number; max: number; first: number; last: number };
    rules: HardRuleEntry[];
  }>;
}

function statsFromTop(top: TopConfigResult, source: "GRID" | "GA"): HardRuleEntry {
  return {
    rank: top.rank,
    source,
    config: top.config,
    stats: {
      winRate: Math.round(top.result.winRate * 10) / 10,
      profitFactor: top.result.profitFactor === Infinity ? 999 : Math.round(top.result.profitFactor * 100) / 100,
      trades: top.result.totalSignals,
      avgWinPct: Math.round(top.result.avgWinPct * 100) / 100,
      avgLossPct: Math.round(top.result.avgLossPct * 100) / 100,
      avgHoldBars: Math.round(top.result.avgHoldBars * 10) / 10,
      wins: top.result.wins,
      losses: top.result.losses,
      timeouts: top.result.timeouts,
    },
    label: top.label,
    compositeScore: Math.round(top.compositeScore * 100) / 100,
  };
}

async function processOneTF(tfKey: string): Promise<HardRulesByTF["tfs"][string]> {
  const meta = TF_WINDOWS[tfKey];
  console.log(`\n[${meta.label}] fetching ${meta.candles} candles (${meta.interval})...`);
  const candles = await fetchKlines(meta.interval, meta.candles);
  console.log(`[${meta.label}] got ${candles.length} candles · ${new Date(candles[0].time).toISOString()} → ${new Date(candles[candles.length - 1].time).toISOString()}`);

  const allRules: HardRuleEntry[] = [];

  // ---- Grid Search ----
  if (!skipGrid) {
    console.log(`[${meta.label}] running GRID optimizer...`);
    const t0 = Date.now();
    const gridResult = await optimizeRules(candles, DEFAULT_BACKTEST_CONFIG, {
      gridConfig: { ...DEFAULT_GRID_CONFIG, topN: topN * 2, minWinRate: 40 },
      onProgress: (info) => {
        if (info.label.includes(`/`)) {
          const pct = Math.round(info.pct * 100);
          process.stdout.write(`  GRID ${pct}% (${info.label})\r`);
        }
      },
    });
    console.log(`\n[${meta.label}] GRID done in ${Math.round((Date.now() - t0) / 1000)}s · ${gridResult.topConfigs.length} configs`);
    for (const top of gridResult.topConfigs) {
      allRules.push(statsFromTop(top, "GRID"));
    }
  }

  // ---- Genetic Algorithm ----
  if (!skipGA) {
    console.log(`[${meta.label}] running GA evolution...`);
    const t0 = Date.now();
    const gaResult = await evolveRules(candles, DEFAULT_BACKTEST_CONFIG, {
      populationSize: 60,
      generations: 40,
      topN: topN * 2,
      minWinRate: 40,
      onProgress: (info) => {
        process.stdout.write(`  GA gen ${info.generation}/${info.totalGenerations} (${info.evaluated} evals)\r`);
      },
    });
    console.log(`\n[${meta.label}] GA done in ${Math.round((Date.now() - t0) / 1000)}s · ${gaResult.topConfigs.length} configs`);
    for (const top of gaResult.topConfigs) {
      allRules.push(statsFromTop(top, "GA"));
    }
  }

  // Sort by composite score and trim to topN.
  // (No additional dedup here — optimizeRules / evolveRules already dedupe
  // internally. Adding another stats-similarity filter on top was too strict
  // and reduced 10 candidates per TF down to 1-3.)
  allRules.sort((a, b) => b.compositeScore - a.compositeScore);

  // Light dedup: only drop rules with EXACTLY identical config (can happen if
  // GA and GRID converge on the same combo).
  const seenKeys = new Set<string>();
  const finalTop: HardRuleEntry[] = [];
  for (const r of allRules) {
    const key = `${r.config.targetPct}|${r.config.stopPct}|${r.config.stochOSLevel}|${r.config.rsiOSLevel}|${r.config.minScore}|${(r.config.requiredConditions || []).sort().join(",")}|${JSON.stringify(r.config.weights || {})}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    finalTop.push({ ...r, rank: finalTop.length + 1 });
    if (finalTop.length >= topN) break;
  }

  console.log(`[${meta.label}] FINAL top ${finalTop.length}:`);
  for (const r of finalTop) {
    const cfg = r.config;
    const lev = cfg.leverage || 100;
    console.log(
      `  #${r.rank} [${r.source}] WR ${r.stats.winRate}% · PF ${r.stats.profitFactor} · ${r.stats.trades}L · ` +
      `TP+${(cfg.targetPct * lev).toFixed(0)}% PnL · SL-${(cfg.stopPct * lev).toFixed(0)}% PnL`
    );
  }

  const prices = candles.map((c) => c.close);
  return {
    interval: meta.interval,
    label: meta.label,
    candles_used: candles.length,
    price_range: {
      min: Math.round(Math.min(...prices)),
      max: Math.round(Math.max(...prices)),
      first: Math.round(prices[0]),
      last: Math.round(prices[prices.length - 1]),
    },
    rules: finalTop,
  };
}

async function main() {
  const tfKeys = filterTFs && filterTFs.length > 0
    ? filterTFs.filter((k) => TF_WINDOWS[k])
    : Object.keys(TF_WINDOWS);

  const result: HardRulesByTF = {
    generated_at: new Date().toISOString(),
    data_source: "Binance BTCUSDT (REST /klines)",
    tfs: {},
  };

  for (const tfKey of tfKeys) {
    try {
      result.tfs[tfKey] = await processOneTF(tfKey);
    } catch (e) {
      console.error(`\n[${tfKey}] FAILED:`, e);
    }
  }

  const outDir = join(__dirname, "..", "assets");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "hard_rules.json");
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\n✅ Wrote ${outPath}`);
  console.log(`   ${Object.keys(result.tfs).length} TFs, ${Object.values(result.tfs).reduce((s, t) => s + t.rules.length, 0)} total rules`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
