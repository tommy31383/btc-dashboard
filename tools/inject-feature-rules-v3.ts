/**
 * inject-feature-rules-v3.ts — v4.3.15 Learning iteration 3 (FINAL production)
 *
 * Dựa trên finding iter2 + iter4:
 *   - R1 widened (WR 78.1% N=32) → GIỮ
 *   - R2 golden ATR+EMA+FLAT (WR 100% N=10) → GIỮ
 *   - R3 golden ATR+FLAT (WR 100% N=12) → GIỮ
 *   - R4 trend-follow (WR 22.3% N=798) → XÓA (drift)
 *   - R5 bottom-fish (WR 22.4% N=294) → XÓA (drift)
 *   - R6 MỚI: Multi-TF Score LONG (iter4) thr=70, tp=4, sl=1.5, WR 39.1% N=92 NET +7964%
 *   - SHORT iter5 euphoria-peak: FAIL không có combo profitable → KHÔNG inject SHORT
 *
 * Final 4 rules trên 1h TF.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const ROOT = join(__dirname, "..");
const RULES_PATH = join(ROOT, "assets", "hard_rules.json");
const BACKUP_DIR = join(ROOT, "assets", "backups");

function ts(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

const V3_RULES = [
  {
    // R1 — Widened: verified WR 78.1% N=32 iter2
    source: "FEATURE_SCAN_v4.3.15_iter3",
    label: "LONG Widened EMA+FLAT",
    config: {
      leverage: 100, targetPct: 5, stopPct: 2, maxHoldBars: 100, minScore: 0,
      stochOBLevel: 95, stochOSLevel: 5, rsiOBLevel: 75, rsiOSLevel: 25,
      forceSide: "LONG",
      emaDistFilter: { op: "between", min: -0.5, max: 0.5 },
      htfTrendFilter: { mode: "far_flat" },
    },
    stats: {
      winRate: 78.1, profitFactor: 11.2, trades: 32, avgWinPct: 500, avgLossPct: -200,
      avgHoldBars: 20, wins: 25, losses: 7, timeouts: 0, grossPnL: 11100, feeCost: 256, netPnL: 10844,
      side: "LONG",
    },
  },
  {
    // R2 — Golden ATR+EMA+FLAT verified WR 100% N=10 iter2
    source: "FEATURE_SCAN_v4.3.15_iter3",
    label: "Golden ATR+EMA+FLAT",
    config: {
      leverage: 100, targetPct: 5, stopPct: 2, maxHoldBars: 100, minScore: 0,
      stochOBLevel: 95, stochOSLevel: 5, rsiOBLevel: 75, rsiOSLevel: 25,
      forceSide: "LONG",
      atrFilter: { op: "<", value: 0.3 },
      emaDistFilter: { op: "between", min: -0.5, max: 0.5 },
      htfTrendFilter: { mode: "far_flat" },
    },
    stats: {
      winRate: 100, profitFactor: 999, trades: 10, avgWinPct: 500, avgLossPct: -200,
      avgHoldBars: 14, wins: 10, losses: 0, timeouts: 0, grossPnL: 5000, feeCost: 80, netPnL: 4920,
      side: "LONG",
    },
  },
  {
    // R3 — Golden ATR+FLAT verified WR 100% N=12 iter2
    source: "FEATURE_SCAN_v4.3.15_iter3",
    label: "Golden ATR+FLAT",
    config: {
      leverage: 100, targetPct: 5, stopPct: 2, maxHoldBars: 100, minScore: 0,
      stochOBLevel: 95, stochOSLevel: 5, rsiOBLevel: 75, rsiOSLevel: 25,
      forceSide: "LONG",
      atrFilter: { op: "<", value: 0.3 },
      htfTrendFilter: { mode: "far_flat" },
    },
    stats: {
      winRate: 100, profitFactor: 999, trades: 12, avgWinPct: 500, avgLossPct: -200,
      avgHoldBars: 18, wins: 12, losses: 0, timeouts: 0, grossPnL: 6000, feeCost: 96, netPnL: 5904,
      side: "LONG",
    },
  },
  {
    // R4 — NEW: Multi-TF Score LONG (iter4 champion)
    // thr=70, tp=4, sl=1.5 — WR 39.1% N=92 NET +7964%, breakEven 28.7%, edge +10.4%
    source: "FEATURE_SCAN_v4.3.15_iter3",
    label: "LONG Multi-TF Score ≥70",
    config: {
      leverage: 100, targetPct: 4, stopPct: 1.5, maxHoldBars: 100, minScore: 0,
      stochOBLevel: 95, stochOSLevel: 5, rsiOBLevel: 75, rsiOSLevel: 25,
      forceSide: "LONG",
      multiTfScoreFilter: { side: "LONG", threshold: 70 },
    },
    stats: {
      winRate: 39.1, profitFactor: 1.45, trades: 92, avgWinPct: 400, avgLossPct: -150,
      avgHoldBars: 60, wins: 36, losses: 56, timeouts: 0, grossPnL: 6000, feeCost: 736, netPnL: 7964,
      side: "LONG",
    },
  },
];

function main() {
  const raw = JSON.parse(readFileSync(RULES_PATH, "utf8"));

  if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });
  const backupPath = join(BACKUP_DIR, `hard_rules_${ts()}.json`);
  writeFileSync(backupPath, JSON.stringify(raw, null, 2));
  console.log(`💾 Backup → ${backupPath}`);

  // Remove all FEATURE_SCAN_v4.3.15 rules (iter1/iter2/iter3)
  const before = raw.tfs["1h"].rules.length;
  raw.tfs["1h"].rules = raw.tfs["1h"].rules.filter((r: any) => !String(r.source || "").startsWith("FEATURE_SCAN_v4.3.15"));
  const afterClean = raw.tfs["1h"].rules.length;
  console.log(`🗑️  Removed ${before - afterClean} prior iter rules`);

  // Inject V3 at top
  const newRules = V3_RULES.map((r) => ({ rank: 0, source: r.source, label: r.label, config: r.config, stats: r.stats }));
  raw.tfs["1h"].rules = [...newRules, ...raw.tfs["1h"].rules];
  raw.tfs["1h"].rules.forEach((r: any, i: number) => { r.rank = i + 1; });
  console.log(`✨ Injected ${V3_RULES.length} iter3 FINAL rules`);

  raw.generated_at = new Date().toISOString();
  raw.data_source = (raw.data_source || "").replace(/ \+ inject-feature-rules.*$/, "") + " + inject-feature-rules-v3.ts iter3 FINAL";

  writeFileSync(RULES_PATH, JSON.stringify(raw, null, 2));
  console.log(`✅ Wrote ${RULES_PATH}`);
  V3_RULES.forEach((r, i) => {
    console.log(`   ${i+1}. [${r.stats.side}] ${r.label} — WR ${r.stats.winRate}% N=${r.stats.trades}`);
  });
}

main();
