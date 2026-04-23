/**
 * inject-ga-sided.ts
 *
 * Run GA TWICE — once forcing LONG-only, once forcing SHORT-only — and
 * filter results by trade frequency (default ~1 trade/day).
 *
 * Why: each TF can have asymmetric edges (e.g., 15M only profitable SHORTing).
 * A side-agnostic GA mixes everything; a sided GA discovers each side's best
 * pure rule.
 *
 * Why frequency filter: high-frequency rules get destroyed by fees, low-freq
 * rules give too few trades to be statistically reliable. ~1/day is a good
 * sweet spot (manageable + ~30 trades/month for stats).
 *
 * Usage:
 *   npx tsx tools/inject-ga-sided.ts --tf=15m
 *   npx tsx tools/inject-ga-sided.ts --tf=5m --target-freq=2  # 2/day
 *   npx tsx tools/inject-ga-sided.ts --tfs=5m,15m --top=5 --gens=30
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
const candlesArg = parseInt(args.find((a) => a.startsWith("--candles="))?.replace("--candles=", "") || "2000", 10);
const targetFreqPerDay = parseFloat(args.find((a) => a.startsWith("--target-freq="))?.replace("--target-freq=", "") || "1");

const tfs = tfsArg ? tfsArg.split(",") : (tfArg ? [tfArg] : ["15m"]);

const TF_INTERVAL: Record<string, string> = { "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d", "1w": "1w" };
const INTERVAL_MIN: Record<string, number> = { "5m": 5, "15m": 15, "1h": 60, "4h": 240, "1d": 1440, "1w": 10080 };

console.log(`=== inject-ga-sided ===`);
console.log(`TFs: ${tfs.join(", ")} · target ~${targetFreqPerDay} trade/day · top ${topN} per side · gens ${gens} · pop ${popSize}`);
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

async function runGAForSide(
  candles: Candle[],
  side: "LONG" | "SHORT",
  tfKey: string,
  days: number,
  freqMin: number,
  freqMax: number,
) {
  const baseWithSide: BacktestConfig = { ...DEFAULT_BACKTEST_CONFIG, forceSide: side };
  console.log(`  [${tfKey}] GA ${side}-only — ${gens} gens × ${popSize} pop...`);
  const t0 = Date.now();
  const result = await evolveRules(candles, baseWithSide, {
    populationSize: popSize,
    generations: gens,
    topN: topN * 4, // overshoot — we'll filter by frequency
    minWinRate: 40,
    minTrades: Math.max(5, Math.floor(freqMin)),
    onProgress: (info) => {
      if (info.generation % 10 === 0 || info.generation === gens) {
        const best = info.bestSoFar;
        const bestStr = best ? ` · best WR ${best.winRate.toFixed(0)}% (${best.trades}L)` : "";
        process.stdout.write(`    ${side} Gen ${info.generation}/${info.totalGenerations}${bestStr}\r`);
      }
    },
  });
  console.log(`\n  [${tfKey}] ${side} done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${result.topConfigs.length} candidates`);

  // Filter by frequency: keep rules with trades in [freqMin, freqMax]
  const filtered = result.topConfigs.filter((tc) => {
    const trades = tc.result.totalSignals;
    return trades >= freqMin && trades <= freqMax;
  });

  // Sort by NET expected (using TP/SL/WR, no fees here — simple proxy)
  filtered.sort((a, b) => {
    const ea = a.result.winRate * a.result.profitFactor;
    const eb = b.result.winRate * b.result.profitFactor;
    return eb - ea;
  });

  return filtered.slice(0, topN);
}

async function processOneTF(tfKey: string, hardRules: any): Promise<boolean> {
  const interval = TF_INTERVAL[tfKey];
  if (!interval) { console.error(`Unknown TF: ${tfKey}`); return false; }

  console.log(`\n[${tfKey}] Fetching ${candlesArg} candles...`);
  const candles = await fetchKlines(interval, candlesArg);
  const days = (candles.length * (INTERVAL_MIN[tfKey] || 60)) / 60 / 24;
  const freqTarget = days * targetFreqPerDay;
  const freqMin = Math.max(5, Math.floor(freqTarget * 0.5));
  const freqMax = Math.ceil(freqTarget * 2.5);
  console.log(`[${tfKey}] Got ${candles.length} candles · ${days.toFixed(1)} ngày · target ${freqMin}-${freqMax} lệnh (~${targetFreqPerDay}/day)`);

  // Run both sides
  const longRules = await runGAForSide(candles, "LONG", tfKey, days, freqMin, freqMax);
  const shortRules = await runGAForSide(candles, "SHORT", tfKey, days, freqMin, freqMax);

  console.log(`\n[${tfKey}] After freq filter [${freqMin}-${freqMax} trades]:`);
  console.log(`  LONG : ${longRules.length} rules`);
  console.log(`  SHORT: ${shortRules.length} rules`);

  if (longRules.length === 0 && shortRules.length === 0) {
    console.log(`[${tfKey}] No rules matched freq filter`);
    return false;
  }

  const tfData = hardRules.tfs[tfKey];
  if (!tfData) { console.warn(`[${tfKey}] TF not in hard_rules.json`); return false; }
  const existingMaxRank = tfData.rules.reduce((m: number, r: any) => Math.max(m, r.rank), 0);

  const allNew = [
    ...longRules.map((tc) => ({ tc, side: "LONG" as const })),
    ...shortRules.map((tc) => ({ tc, side: "SHORT" as const })),
  ];

  const gaEntries = allNew.map((item, i) => ({
    rank: existingMaxRank + i + 1,
    source: "GA" as const,
    config: item.tc.config,
    stats: {
      winRate: Math.round(item.tc.result.winRate * 10) / 10,
      profitFactor: item.tc.result.profitFactor === Infinity ? 999 : Math.round(item.tc.result.profitFactor * 100) / 100,
      trades: item.tc.result.totalSignals,
      avgWinPct: Math.round(item.tc.result.avgWinPct * 100) / 100,
      avgLossPct: Math.round(item.tc.result.avgLossPct * 100) / 100,
      avgHoldBars: Math.round(item.tc.result.avgHoldBars * 10) / 10,
      wins: item.tc.result.wins,
      losses: item.tc.result.losses,
      timeouts: item.tc.result.timeouts,
      side: item.side, // critical so report shows the right badge
    },
    label: `[GA ${item.side}] ${item.tc.label}`,
    compositeScore: Math.round(item.tc.compositeScore * 100) / 100,
  }));

  tfData.rules = [...tfData.rules, ...gaEntries];

  console.log(`\n[${tfKey}] ✓ Appended ${gaEntries.length} sided GA rules:`);
  for (const e of gaEntries) {
    const ws = (e.config as any).weights
      ? Object.entries((e.config as any).weights).filter(([, w]: any) => (w ?? 0) > 0).map(([k, w]) => `${k}=${w}`).join(" ")
      : "";
    const tradesPerDay = (e.stats.trades / ((tfData.candles_used * (INTERVAL_MIN[tfKey] || 60)) / 60 / 24)).toFixed(2);
    console.log(`     #${e.rank} ${e.stats.side} · WR ${e.stats.winRate}% · PF ${e.stats.profitFactor} · ${e.stats.trades}L (${tradesPerDay}/day) · ${ws}`);
  }
  return true;
}

async function main() {
  const hardRulesPath = join(__dirname, "..", "assets", "hard_rules.json");
  if (!existsSync(hardRulesPath)) {
    console.error(`hard_rules.json not found`);
    process.exit(1);
  }
  const hardRules = JSON.parse(readFileSync(hardRulesPath, "utf-8"));

  let updated = 0;
  for (const tf of tfs) {
    if (await processOneTF(tf, hardRules)) {
      updated++;
      // Save AFTER EACH TF so progress isn't lost if killed mid-run
      hardRules.generated_at = new Date().toISOString();
      writeFileSync(hardRulesPath, JSON.stringify(hardRules, null, 2));
      console.log(`\n💾 Saved ${tf} progress to ${hardRulesPath}`);
    }
  }

  if (updated > 0) {
    console.log(`\n✅ Done — ${updated}/${tfs.length} TFs updated`);
    console.log(`💡 Run: npx tsx tools/report-hard-rules.ts --open`);
  }
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
