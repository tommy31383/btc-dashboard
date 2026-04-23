/**
 * inject-verified-rules.ts
 *
 * Reads assets/scan_tpsl_<tf>.json (output of scan-tpsl.ts) and injects the
 * top profitable rules into assets/hard_rules.json so the app shows them
 * with source = "VERIFIED" (deep-analyzed + fee-aware).
 *
 * Usage:
 *   npx tsx tools/inject-verified-rules.ts                    # default 15m
 *   npx tsx tools/inject-verified-rules.ts --tf=15m --top=10
 *   npx tsx tools/inject-verified-rules.ts --tfs=5m,15m,1h    # multiple
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const args = process.argv.slice(2);
const tfsArg = args.find((a) => a.startsWith("--tfs="))?.replace("--tfs=", "");
const tfArg = args.find((a) => a.startsWith("--tf="))?.replace("--tf=", "");
const topN = parseInt(args.find((a) => a.startsWith("--top="))?.replace("--top=", "") || "10", 10);
const includeBoth = args.includes("--include-loss"); // include LONG even if barely profitable
const useHTF = args.includes("--htf"); // load scan_tpsl_htf_<tf>.json instead

const tfs = tfsArg ? tfsArg.split(",") : (tfArg ? [tfArg] : ["15m"]);

console.log(`=== inject-verified-rules ===`);
console.log(`TFs: ${tfs.join(", ")} · top ${topN}`);
console.log("");

interface ScanResult {
  type?: "LONG" | "SHORT";
  side?: "LONG" | "SHORT"; // htf scan uses 'side'
  conditionLabel: string;
  conditionKeys: string[];
  htfFilter?: string;
  htfFilterLabel?: string;
  tp: number;
  sl: number;
  fires: number;
  wins: number;
  losses: number;
  timeouts: number;
  realWR: number;
  grossPnL: number;
  feeCost: number;
  netPnL: number;
  avgHoldBars?: number; // added by scan-tpsl v2+ (may be missing in old scans)
}

interface ScanFile {
  tf: string;
  leverage: number;
  feePerSide: number;
  candlesAnalyzed: number;
  period: { from: string; to: string };
  topResults: ScanResult[];
}

interface HardRule {
  rank: number;
  source: "GRID" | "GA" | "VERIFIED";
  config: any;
  stats: any;
  label: string;
  compositeScore: number;
}

const ASSETS_DIR = join(__dirname, "..", "assets");

function loadHardRules(): any {
  const p = join(ASSETS_DIR, "hard_rules.json");
  if (!existsSync(p)) {
    return {
      generated_at: new Date().toISOString(),
      data_source: "Binance BTCUSDT (REST /klines) + Verified scan",
      tfs: {},
    };
  }
  return JSON.parse(readFileSync(p, "utf-8"));
}

function loadScan(tf: string, htf: boolean = false): ScanFile | null {
  const fname = htf ? `scan_tpsl_htf_${tf}.json` : `scan_tpsl_${tf}.json`;
  const p = join(ASSETS_DIR, fname);
  if (!existsSync(p)) {
    console.warn(`  ⚠️  ${p} not found — skipping`);
    return null;
  }
  return JSON.parse(readFileSync(p, "utf-8"));
}

function scanResultToHardRule(scan: ScanResult, rank: number, leverage: number): HardRule {
  const side = scan.side || scan.type || "LONG";
  const hasHTF = !!scan.htfFilter && scan.htfFilter !== "none";
  return {
    rank,
    source: "VERIFIED",
    config: {
      leverage,
      targetPct: scan.tp,
      stopPct: scan.sl,
      maxHoldBars: 100,
      minScore: 1,
      stochOBLevel: 95,
      stochOSLevel: 5,
      rsiOBLevel: 75,
      rsiOSLevel: 25,
      requiredConditions: scan.conditionKeys,
      forceSide: side,
      // HTF filter info — config-level metadata for the engine to apply.
      // Engine integration TBD; for now this is just informational.
      ...(hasHTF ? { htfTrendFilter: { mode: scan.htfFilter, label: scan.htfFilterLabel } } : {}),
    } as any,
    stats: {
      winRate: scan.realWR,
      profitFactor: scan.losses > 0 ? Math.round((scan.wins * scan.tp / (scan.losses * scan.sl)) * 100) / 100 : 999,
      trades: scan.fires,
      avgWinPct: scan.tp * leverage,
      avgLossPct: -scan.sl * leverage,
      avgHoldBars: scan.avgHoldBars ?? 0, // from scan-tpsl v2+ with holdBars tracking
      wins: scan.wins,
      losses: scan.losses,
      timeouts: scan.timeouts,
      grossPnL: scan.grossPnL,
      feeCost: scan.feeCost,
      netPnL: scan.netPnL,
      side,
      htfFilterLabel: scan.htfFilterLabel,
    } as any,
    label: `[${hasHTF ? "HTF " : ""}${side}] ${scan.conditionLabel}${hasHTF ? ` + ${scan.htfFilterLabel}` : ""} TP+${scan.tp}% SL-${scan.sl}% · WR ${scan.realWR}% · NET +${scan.netPnL}%`,
    compositeScore: scan.netPnL,
  };
}

function processOneTF(tf: string, hardRules: any): boolean {
  const scan = loadScan(tf, useHTF);
  if (!scan) return false;

  // Pick top N profitable (NET > 0). Mix SHORT + LONG.
  const profitable = scan.topResults
    .filter((r) => r.netPnL > 0)
    .sort((a, b) => b.netPnL - a.netPnL);

  if (profitable.length === 0) {
    console.log(`  [${tf}] No profitable rules in scan — skipping`);
    return false;
  }

  // Take top N (mostly SHORT for 15m given results)
  const picked = profitable.slice(0, topN);

  // Build hard_rules section
  const tfLabel = tf.toUpperCase();
  const oldRules = hardRules.tfs[tf];
  // For HTF scan, APPEND to existing rules (don't replace) so we keep both
  // the old VERIFIED rules and the new HTF-filtered ones together.
  if (useHTF && oldRules?.rules) {
    const startRank = oldRules.rules.reduce((m: number, r: any) => Math.max(m, r.rank), 0);
    const newEntries = picked.map((r, i) => scanResultToHardRule(r, startRank + i + 1, scan.leverage));
    hardRules.tfs[tf] = {
      ...oldRules,
      candles_used: scan.candlesAnalyzed,
      rules: [...oldRules.rules, ...newEntries],
    };
  } else {
    hardRules.tfs[tf] = {
      interval: tf,
      label: tfLabel === "1M" ? "1MO" : tfLabel,
      candles_used: scan.candlesAnalyzed,
      price_range: oldRules?.price_range || { min: 0, max: 0, first: 0, last: 0 },
      rules: picked.map((r, i) => scanResultToHardRule(r, i + 1, scan.leverage)),
    };
  }

  console.log(`  [${tf}] ✓ Injected ${picked.length} VERIFIED rules:`);
  for (const r of picked.slice(0, 5)) {
    console.log(`     #${picked.indexOf(r) + 1} ${r.type} ${r.conditionLabel} TP+${r.tp}/SL-${r.sl} · WR ${r.realWR}% · NET +${r.netPnL}%`);
  }
  if (picked.length > 5) console.log(`     ... và ${picked.length - 5} rule khác`);
  return true;
}

function main() {
  const hardRules = loadHardRules();
  let updated = 0;
  for (const tf of tfs) {
    if (processOneTF(tf, hardRules)) updated++;
  }

  if (updated === 0) {
    console.log("\n❌ Nothing injected. Run scan-tpsl first.");
    process.exit(1);
  }

  // Update timestamp + source
  hardRules.generated_at = new Date().toISOString();
  hardRules.data_source = "Binance BTCUSDT (REST /klines) + scan-tpsl with fees";

  const outPath = join(ASSETS_DIR, "hard_rules.json");
  writeFileSync(outPath, JSON.stringify(hardRules, null, 2));
  console.log("");
  console.log(`✅ Updated ${outPath}`);
  console.log(`   ${updated}/${tfs.length} TFs updated with VERIFIED rules`);
  console.log("");
  console.log(`💡 Run: npx tsx tools/report-hard-rules.ts --open`);
}

main();
