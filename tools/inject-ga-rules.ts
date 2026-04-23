/**
 * inject-ga-rules.ts
 *
 * Runs Genetic Algorithm (evolveRules) for a TF and APPENDS the top GA
 * results to the existing rules in assets/hard_rules.json. Doesn't replace
 * existing GRID/VERIFIED rules.
 *
 * After this, the GA rules will appear in the report with learned weights
 * shown in the "Trọng số (Genetic Algo)" column.
 *
 * Usage:
 *   npx tsx tools/inject-ga-rules.ts                           # 5m default
 *   npx tsx tools/inject-ga-rules.ts --tf=15m --top=5
 *   npx tsx tools/inject-ga-rules.ts --tfs=5m,15m --gens=20    # multiple
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import {
  Candle, BacktestConfig, DEFAULT_BACKTEST_CONFIG,
  evolveRules,
} from "../utils/backtester";

const BINANCE_REST = "https://api.binance.com/api/v3";

const args = process.argv.slice(2);
const tfsArg = args.find((a) => a.startsWith("--tfs="))?.replace("--tfs=", "");
const tfArg = args.find((a) => a.startsWith("--tf="))?.replace("--tf=", "");
const topN = parseInt(args.find((a) => a.startsWith("--top="))?.replace("--top=", "") || "5", 10);
const gens = parseInt(args.find((a) => a.startsWith("--gens="))?.replace("--gens=", "") || "30", 10);
const popSize = parseInt(args.find((a) => a.startsWith("--pop="))?.replace("--pop=", "") || "50", 10);
const candlesArg = parseInt(args.find((a) => a.startsWith("--candles="))?.replace("--candles=", "") || "1500", 10);

const tfs = tfsArg ? tfsArg.split(",") : (tfArg ? [tfArg] : ["5m"]);

const TF_INTERVAL: Record<string, string> = {
  "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d", "1w": "1w",
};

console.log(`=== inject-ga-rules ===`);
console.log(`TFs: ${tfs.join(", ")} · top ${topN} · gens ${gens} · pop ${popSize} · candles ${candlesArg}`);
console.log("");

async function fetchKlines(interval: string, total: number): Promise<Candle[]> {
  const all: Candle[] = [];
  let endTime: number | undefined;
  while (all.length < total) {
    const remaining = total - all.length;
    const limit = Math.min(1000, remaining);
    const params = new URLSearchParams({ symbol: "BTCUSDT", interval, limit: String(limit) });
    if (endTime) params.set("endTime", String(endTime));
    const res = await fetch(`${BINANCE_REST}/klines?${params.toString()}`);
    const data: any[] = await res.json();
    if (data.length === 0) break;
    const batch: Candle[] = data.map((k) => ({
      time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
      low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
    }));
    all.unshift(...batch);
    endTime = batch[0].time - 1;
    await new Promise((r) => setTimeout(r, 100));
  }
  const byTime = new Map<number, Candle>();
  for (const c of all) byTime.set(c.time, c);
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

async function processOneTF(tfKey: string, hardRules: any): Promise<boolean> {
  const interval = TF_INTERVAL[tfKey];
  if (!interval) {
    console.error(`Unknown TF: ${tfKey}`);
    return false;
  }

  console.log(`\n[${tfKey}] Fetching ${candlesArg} candles...`);
  const candles = await fetchKlines(interval, candlesArg);
  console.log(`[${tfKey}] Got ${candles.length} candles`);

  console.log(`[${tfKey}] Running GA (${gens} gens × ${popSize} pop)...`);
  const t0 = Date.now();
  const result = await evolveRules(candles, DEFAULT_BACKTEST_CONFIG, {
    populationSize: popSize,
    generations: gens,
    topN: topN,
    minWinRate: 40,
    minTrades: 5,
    onProgress: (info) => {
      if (info.generation % 5 === 0 || info.generation === gens) {
        const best = info.bestSoFar;
        const bestStr = best ? ` · best WR ${best.winRate.toFixed(0)}% (${best.trades}L)` : "";
        process.stdout.write(`  Gen ${info.generation}/${info.totalGenerations}${bestStr}\r`);
      }
    },
  });
  console.log(`\n[${tfKey}] GA done in ${((Date.now() - t0) / 1000).toFixed(1)}s · ${result.topConfigs.length} configs found`);

  if (result.topConfigs.length === 0) {
    console.log(`[${tfKey}] No GA rules found that pass filter`);
    return false;
  }

  // Build hard_rules entries from GA topConfigs
  const tfData = hardRules.tfs[tfKey];
  if (!tfData) {
    console.warn(`[${tfKey}] TF not in hard_rules.json — skipping`);
    return false;
  }

  const existingMaxRank = tfData.rules.reduce((m: number, r: any) => Math.max(m, r.rank), 0);
  const gaEntries = result.topConfigs.map((tc, i) => ({
    rank: existingMaxRank + i + 1,
    source: "GA" as const,
    config: tc.config,
    stats: {
      winRate: Math.round(tc.result.winRate * 10) / 10,
      profitFactor: tc.result.profitFactor === Infinity ? 999 : Math.round(tc.result.profitFactor * 100) / 100,
      trades: tc.result.totalSignals,
      avgWinPct: Math.round(tc.result.avgWinPct * 100) / 100,
      avgLossPct: Math.round(tc.result.avgLossPct * 100) / 100,
      avgHoldBars: Math.round(tc.result.avgHoldBars * 10) / 10,
      wins: tc.result.wins,
      losses: tc.result.losses,
      timeouts: tc.result.timeouts,
    },
    label: tc.label,
    compositeScore: Math.round(tc.compositeScore * 100) / 100,
  }));

  // Append (don't replace)
  tfData.rules = [...tfData.rules, ...gaEntries];

  console.log(`[${tfKey}] ✓ Appended ${gaEntries.length} GA rules:`);
  for (const e of gaEntries.slice(0, 5)) {
    const ws = e.config.weights
      ? Object.entries(e.config.weights).filter(([, w]) => (w ?? 0) > 0).map(([k, w]) => `${k}=${w}`).join(" ")
      : "";
    console.log(`     #${e.rank} WR ${e.stats.winRate}% PF ${e.stats.profitFactor} ${e.stats.trades}L · weights: ${ws}`);
  }

  return true;
}

async function main() {
  const hardRulesPath = join(__dirname, "..", "assets", "hard_rules.json");
  if (!existsSync(hardRulesPath)) {
    console.error(`hard_rules.json not found — run generate-hard-rules first`);
    process.exit(1);
  }
  const hardRules = JSON.parse(readFileSync(hardRulesPath, "utf-8"));

  let updated = 0;
  for (const tf of tfs) {
    if (await processOneTF(tf, hardRules)) updated++;
  }

  if (updated > 0) {
    hardRules.generated_at = new Date().toISOString();
    writeFileSync(hardRulesPath, JSON.stringify(hardRules, null, 2));
    console.log(`\n✅ Updated ${hardRulesPath}`);
    console.log(`   ${updated}/${tfs.length} TFs got GA rules appended`);
    console.log(`\n💡 Run: npx tsx tools/report-hard-rules.ts --open`);
  }
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
