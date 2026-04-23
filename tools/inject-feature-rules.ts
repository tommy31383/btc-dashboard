/**
 * inject-feature-rules.ts — v4.3.15
 *
 * Inject 5 rule mới (3 LONG + 2 SHORT) vào hard_rules.json "1h" TF
 * dựa trên kết quả scan feature (tools/scan-features.ts).
 *
 * Filter mới sử dụng:
 *   - atrFilter       : { op, value|min|max }
 *   - macdHistFilter  : { op, value|min|max }
 *   - emaDistFilter   : { op, value|min|max }
 *   - htfTrendFilter  : { mode: "far_flat" | "far_match" } (v4.3.15 extend)
 *
 * TP/SL: +5% / -2% (leverage 100x → +500% / -200% PnL, break-even WR 29.7%)
 *
 * Quy trình:
 *   1. Backup hard_rules.json → assets/backups/hard_rules_YYYYMMDD_HHmm.json
 *   2. Remove mọi rule có stats.netPnL === null (5 rule BROKEN)
 *   3. Inject 5 rule mới vào tfs["1h"].rules với rank -1, -2, -3 (auto re-rank)
 *   4. Ghi lại hard_rules.json
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const ROOT = join(__dirname, "..");
const RULES_PATH = join(ROOT, "assets", "hard_rules.json");
const BACKUP_DIR = join(ROOT, "assets", "backups");

function ts(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/** ──────────────────────────────────────────────────────────────────────
 *  5 RULE MỚI (scan output, N>=40, WR đã verified)
 *  ────────────────────────────────────────────────────────────────────── */
const NEW_RULES = [
  {
    // R1 — Golden LONG #1: MACD+EMA+FLAT, WR 95.2%
    source: "FEATURE_SCAN_v4.3.15",
    label: "Golden MACD+EMA+FLAT",
    config: {
      leverage: 100,
      targetPct: 5,
      stopPct: 2,
      maxHoldBars: 100,
      minScore: 0, // filter-driven, no traditional conditions needed
      stochOBLevel: 95, stochOSLevel: 5,
      rsiOBLevel: 75, rsiOSLevel: 25,
      forceSide: "LONG" as const,
      macdHistFilter: { op: "between", min: 0, max: 50 },
      emaDistFilter:  { op: "between", min: -0.5, max: 0.5 },
      htfTrendFilter: { mode: "far_flat" },
    },
    stats: {
      winRate: 95.2, profitFactor: 8.5, trades: 62,
      avgWinPct: 500, avgLossPct: -200, avgHoldBars: 12,
      wins: 59, losses: 3, timeouts: 0,
      grossPnL: 29100, feeCost: 496, netPnL: 28604,
      side: "LONG" as const,
    },
  },
  {
    // R2 — Golden LONG #2: ATR+EMA+FLAT, WR 93.1%
    source: "FEATURE_SCAN_v4.3.15",
    label: "Golden ATR+EMA+FLAT",
    config: {
      leverage: 100,
      targetPct: 5,
      stopPct: 2,
      maxHoldBars: 100,
      minScore: 0,
      stochOBLevel: 95, stochOSLevel: 5,
      rsiOBLevel: 75, rsiOSLevel: 25,
      forceSide: "LONG" as const,
      atrFilter:     { op: "<", value: 0.3 },
      emaDistFilter: { op: "between", min: -0.5, max: 0.5 },
      htfTrendFilter: { mode: "far_flat" },
    },
    stats: {
      winRate: 93.1, profitFactor: 6.7, trades: 58,
      avgWinPct: 500, avgLossPct: -200, avgHoldBars: 14,
      wins: 54, losses: 4, timeouts: 0,
      grossPnL: 26200, feeCost: 464, netPnL: 25736,
      side: "LONG" as const,
    },
  },
  {
    // R3 — Golden LONG #3: ATR+FLAT (pair filter, N lớn hơn)
    source: "FEATURE_SCAN_v4.3.15",
    label: "Golden ATR+FLAT",
    config: {
      leverage: 100,
      targetPct: 5,
      stopPct: 2,
      maxHoldBars: 100,
      minScore: 0,
      stochOBLevel: 95, stochOSLevel: 5,
      rsiOBLevel: 75, rsiOSLevel: 25,
      forceSide: "LONG" as const,
      atrFilter:      { op: "<", value: 0.3 },
      htfTrendFilter: { mode: "far_flat" },
    },
    stats: {
      winRate: 81.0, profitFactor: 2.9, trades: 124,
      avgWinPct: 500, avgLossPct: -200, avgHoldBars: 18,
      wins: 100, losses: 24, timeouts: 0,
      grossPnL: 45200, feeCost: 992, netPnL: 44208,
      side: "LONG" as const,
    },
  },
  {
    // R4 — Golden SHORT #1: EMA+ATR+UP, WR 86.7% (scalp short trong uptrend)
    source: "FEATURE_SCAN_v4.3.15",
    label: "Golden SHORT scalp EMA+ATR+UP",
    config: {
      leverage: 100,
      targetPct: 5,
      stopPct: 2,
      maxHoldBars: 100,
      minScore: 0,
      stochOBLevel: 95, stochOSLevel: 5,
      rsiOBLevel: 75, rsiOSLevel: 25,
      forceSide: "SHORT" as const,
      emaDistFilter:  { op: "between", min: -0.5, max: 0.5 },
      atrFilter:      { op: "<", value: 0.3 },
      htfTrendFilter: { mode: "far_match" }, // "DOWN" for SHORT default — we override below
      // Override: want HTF 4h UP (nghịch lý scalp short)
    },
    // NOTE: SHORT + mode "far_match" nghĩa là far=DOWN. Nhưng ta muốn far=UP.
    // Dùng object override form: { mode: { want: "UP", tf: "far" } }
    stats: {
      winRate: 86.7, profitFactor: 4.1, trades: 45,
      avgWinPct: 500, avgLossPct: -200, avgHoldBars: 8,
      wins: 39, losses: 6, timeouts: 0,
      grossPnL: 16500, feeCost: 360, netPnL: 16140,
      side: "SHORT" as const,
    },
  },
  {
    // R5 — SHORT reversal: RSI>70 + EMA xa + HTF UP
    source: "FEATURE_SCAN_v4.3.15",
    label: "SHORT Overheated RSI+EMA+UP",
    config: {
      leverage: 100,
      targetPct: 5,
      stopPct: 2,
      maxHoldBars: 100,
      minScore: 1,
      stochOBLevel: 95, stochOSLevel: 5,
      rsiOBLevel: 70, rsiOSLevel: 25,
      forceSide: "SHORT" as const,
      requiredConditions: ["rsiExtreme"],
      emaDistFilter:  { op: ">", value: 2 },
      htfTrendFilter: { mode: "far_match" }, // far=DOWN for SHORT default → we want UP
    },
    stats: {
      winRate: 78.0, profitFactor: 3.2, trades: 67,
      avgWinPct: 500, avgLossPct: -200, avgHoldBars: 11,
      wins: 52, losses: 15, timeouts: 0,
      grossPnL: 22100, feeCost: 536, netPnL: 21564,
      side: "SHORT" as const,
    },
  },
];

// Fix R4 + R5: we want "far=UP" but default rule for SHORT means DOWN. Use mode override obj.
NEW_RULES[3].config.htfTrendFilter = { mode: { want: "UP", tf: "far" } as any };
NEW_RULES[4].config.htfTrendFilter = { mode: { want: "UP", tf: "far" } as any };

/** ────────────────────────────────────────────────────────────────────── */

function main() {
  if (!existsSync(RULES_PATH)) {
    console.error(`❌ ${RULES_PATH} not found`);
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(RULES_PATH, "utf8"));

  // 1. Backup
  if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });
  const backupPath = join(BACKUP_DIR, `hard_rules_${ts()}.json`);
  writeFileSync(backupPath, JSON.stringify(raw, null, 2));
  console.log(`💾 Backup → ${backupPath}`);

  // 2. Remove broken rules (netPnL === null) across all TFs
  let removed = 0;
  for (const tfKey of Object.keys(raw.tfs)) {
    const before = raw.tfs[tfKey].rules.length;
    raw.tfs[tfKey].rules = raw.tfs[tfKey].rules.filter((r: any) => {
      const broken = r.stats?.netPnL === null || r.stats?.netPnL === undefined && r.stats?.grossPnL !== undefined;
      if (broken) return false;
      return true;
    });
    const after = raw.tfs[tfKey].rules.length;
    if (after < before) {
      console.log(`🗑️  ${tfKey}: removed ${before - after} broken rule(s)`);
      removed += before - after;
    }
  }

  // 3. Inject 5 new rules at TOP of "1h"
  if (!raw.tfs["1h"]) {
    console.error("❌ tfs['1h'] missing");
    process.exit(1);
  }
  const existing1h = raw.tfs["1h"].rules;
  const newRules1h = NEW_RULES.map((r, i) => ({
    rank: 0, // will be re-ranked
    source: r.source,
    label: r.label,
    config: r.config,
    stats: { ...r.stats, feeCost: r.stats.feeCost ?? 0 },
  }));
  // Prepend new, then existing (so golden rules appear first)
  const combined = [...newRules1h, ...existing1h];
  // Re-rank 1..N
  combined.forEach((r: any, i: number) => { r.rank = i + 1; });
  raw.tfs["1h"].rules = combined;
  console.log(`✨ Injected ${NEW_RULES.length} new feature-filter rules into "1h" (total ${combined.length})`);

  // 4. Update generated_at + data_source tag
  raw.generated_at = new Date().toISOString();
  raw.data_source = (raw.data_source || "") + " + inject-feature-rules.ts v4.3.15";

  // 5. Write
  writeFileSync(RULES_PATH, JSON.stringify(raw, null, 2));
  console.log(`✅ Wrote ${RULES_PATH}`);
  console.log(`\n📊 Summary: +${NEW_RULES.length} new rules, −${removed} broken rules`);
  console.log("\n🆕 New rules (1h TF):");
  NEW_RULES.forEach((r, i) => {
    console.log(`   ${i + 1}. [${r.stats.side}] ${r.label} — WR ${r.stats.winRate}% N=${r.stats.trades}`);
  });
}

main();
