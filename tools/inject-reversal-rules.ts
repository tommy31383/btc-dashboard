/**
 * inject-reversal-rules.ts
 *
 * Inject 4 rule REVERSAL_4H_UP (LONG) vào assets/hard_rules.json ở tf "4h".
 * Rule dựa trên scan-reversals-4h.ts (6000 nến 4H, 2.7 năm, lev 10x).
 *
 * KHÔNG xoá rule cũ ở tf 4h — chỉ PREPEND 4 rule mới lên đầu (rank 1-4),
 * rule cũ đẩy xuống (rank 5+).
 *
 * Auto-backup trước khi ghi đè.
 */

import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const RULES_PATH = join(__dirname, "..", "assets", "hard_rules.json");
const BACKUP_DIR = join(__dirname, "..", "assets", "backups");

interface ReversalRule {
  rank: number;
  source: "VERIFIED_REVERSAL";
  config: {
    leverage: number;
    targetPct: number;
    stopPct: number;
    maxHoldBars: number;
    candleReversalFilter: { tf: string; type: "UP" | "DOWN" };
    emaPosFilter?: "above" | "below";
    forceSide: "LONG" | "SHORT";
    minScore: 0;
    requiredConditions: [];
  };
  stats: {
    winRate: number;
    profitFactor: number;
    trades: number;
    avgWinPct: number;  // leveraged
    avgLossPct: number; // leveraged (negative)
    avgHoldBars: number;
    wins: number;
    losses: number;
    timeouts: number;
    grossPnL: number;
    feeCost: number;
    netPnL: number;
    side: "LONG" | "SHORT";
    htfFilterLabel: string;
  };
  label: string;
  compositeScore: number;
}

// 4 rule từ scan kết quả (lev 10x)
const NEW_RULES: Omit<ReversalRule, "rank">[] = [
  {
    source: "VERIFIED_REVERSAL",
    config: {
      leverage: 10, targetPct: 5, stopPct: 3, maxHoldBars: 50,
      candleReversalFilter: { tf: "4h", type: "UP" },
      forceSide: "LONG", minScore: 0, requiredConditions: [],
    },
    stats: {
      winRate: 36.1, profitFactor: 1.67, trades: 1588,
      avgWinPct: 50, avgLossPct: -30, avgHoldBars: 12.0,
      wins: 573, losses: 683, timeouts: 332,
      grossPnL: 8165, feeCost: 6465, netPnL: 1700,
      side: "LONG", htfFilterLabel: "Mọi UP reversal 4h",
    },
    label: "[REVERSAL 4H LONG] Mọi UP reversal · TP+5% SL-3% · WR 36.1% · NET +1700%",
    compositeScore: 1700,
  },
  {
    source: "VERIFIED_REVERSAL",
    config: {
      leverage: 10, targetPct: 5, stopPct: 2, maxHoldBars: 50,
      candleReversalFilter: { tf: "4h", type: "UP" },
      emaPosFilter: "below",
      forceSide: "LONG", minScore: 0, requiredConditions: [],
    },
    stats: {
      winRate: 30.3, profitFactor: 1.52, trades: 846,
      avgWinPct: 50, avgLossPct: -20, avgHoldBars: 13.5,
      wins: 256, losses: 460, timeouts: 130,
      grossPnL: 3600, feeCost: 2617, netPnL: 983,
      side: "LONG", htfFilterLabel: "UP reversal + giá dưới EMA50 4h",
    },
    label: "[REVERSAL 4H LONG] UP + dưới EMA50 · TP+5% SL-2% · WR 30.3% · NET +983%",
    compositeScore: 983,
  },
  {
    source: "VERIFIED_REVERSAL",
    config: {
      leverage: 10, targetPct: 5, stopPct: 3, maxHoldBars: 50,
      candleReversalFilter: { tf: "4h", type: "UP" },
      emaPosFilter: "above",
      forceSide: "LONG", minScore: 0, requiredConditions: [],
    },
    stats: {
      winRate: 35.9, profitFactor: 1.65, trades: 728,
      avgWinPct: 50, avgLossPct: -30, avgHoldBars: 11.8,
      wins: 262, losses: 312, timeouts: 154,
      grossPnL: 3740, feeCost: 2852, netPnL: 888,
      side: "LONG", htfFilterLabel: "UP reversal + giá trên EMA50 4h (pullback)",
    },
    label: "[REVERSAL 4H LONG] UP + trên EMA50 (pullback) · TP+5% SL-3% · WR 35.9% · NET +888%",
    compositeScore: 888,
  },
  {
    source: "VERIFIED_REVERSAL",
    config: {
      leverage: 10, targetPct: 3, stopPct: 1.5, maxHoldBars: 50,
      candleReversalFilter: { tf: "4h", type: "UP" },
      emaPosFilter: "below",
      forceSide: "LONG", minScore: 0, requiredConditions: [],
    },
    stats: {
      winRate: 37.0, profitFactor: 1.48, trades: 846,
      avgWinPct: 30, avgLossPct: -15, avgHoldBars: 10.3,
      wins: 313, losses: 409, timeouts: 124,
      grossPnL: 3255, feeCost: 2537, netPnL: 718,
      side: "LONG", htfFilterLabel: "UP reversal + giá dưới EMA50 4h",
    },
    label: "[REVERSAL 4H LONG] UP + dưới EMA50 · TP+3% SL-1.5% · WR 37.0% · NET +718%",
    compositeScore: 718,
  },
];

// ── Execute ──
console.log(`=== inject-reversal-rules ===`);

// Auto-backup
mkdirSync(BACKUP_DIR, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const backupPath = join(BACKUP_DIR, `hard_rules_${ts}_before_reversal_inject.json`);
copyFileSync(RULES_PATH, backupPath);
console.log(`📦 Backup → ${backupPath}`);

const raw = JSON.parse(readFileSync(RULES_PATH, "utf8"));
const tf4h = raw.tfs["4h"];
if (!tf4h) throw new Error("tf 4h not found in hard_rules.json");

// Bump existing ranks by 4
const bumped = (tf4h.rules || []).map((r: any) => ({ ...r, rank: r.rank + NEW_RULES.length }));

// Prepend new rules with rank 1..4
const newRulesRanked: ReversalRule[] = NEW_RULES.map((r, i) => ({ ...r, rank: i + 1 }));

tf4h.rules = [...newRulesRanked, ...bumped];
raw.generated_at = new Date().toISOString();

writeFileSync(RULES_PATH, JSON.stringify(raw, null, 2));

console.log(`\n✅ Injected ${NEW_RULES.length} REVERSAL_4H_UP rules at top of tf 4h:`);
for (const r of newRulesRanked) {
  console.log(`   #${r.rank} ${r.label}`);
}
console.log(`\n   Total rules in tf 4h: ${tf4h.rules.length}`);
console.log(`\n💡 Rule cũ ở 4h giờ rank ${NEW_RULES.length + 1}..${tf4h.rules.length}`);
