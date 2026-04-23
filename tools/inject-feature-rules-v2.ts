/**
 * inject-feature-rules-v2.ts — v4.3.15 Learning iteration 2
 *
 * Dựa trên finding iter1:
 *   - R4, R5 DISASTER (SHORT in UP fail hoàn toàn) → XÓA
 *   - R1 quá strict (N=8) → widen (bỏ macdHistFilter)
 *   - R2, R3 verified vàng → GIỮ
 *   - Thêm 2 rule LONG mới dùng HTF context (1d RSI filter)
 *
 * Rule v2 final (5 rule):
 *   1. LONG Widened MACD+EMA+FLAT (bỏ macdHist filter)
 *   2. LONG Golden ATR+EMA+FLAT (giữ nguyên)
 *   3. LONG Golden ATR+FLAT (giữ nguyên)
 *   4. LONG Trend-follow ATR+UP+1d-RSI mid (mới)
 *   5. LONG Bottom-fish EMA-far+DOWN+1d-RSI stable (mới)
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

const V2_RULES = [
  {
    // R1 — Widened: drop macdHist filter để tăng N
    source: "FEATURE_SCAN_v4.3.15_iter2",
    label: "LONG Widened EMA+FLAT",
    config: {
      leverage: 100, targetPct: 5, stopPct: 2, maxHoldBars: 100, minScore: 0,
      stochOBLevel: 95, stochOSLevel: 5, rsiOBLevel: 75, rsiOSLevel: 25,
      forceSide: "LONG",
      emaDistFilter: { op: "between", min: -0.5, max: 0.5 },
      htfTrendFilter: { mode: "far_flat" },
    },
    stats: {
      winRate: 0, profitFactor: 0, trades: 0, avgWinPct: 500, avgLossPct: -200,
      avgHoldBars: 0, wins: 0, losses: 0, timeouts: 0, grossPnL: 0, feeCost: 0, netPnL: 0,
      side: "LONG",
    },
  },
  {
    // R2 — Keep as verified gold
    source: "FEATURE_SCAN_v4.3.15_iter2",
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
    // R3 — Keep as verified gold
    source: "FEATURE_SCAN_v4.3.15_iter2",
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
    // R4v2 — LONG trend-follow: 4h UP + 1d RSI 40-70 (trend mạnh, chưa quá nóng) + ATR low
    source: "FEATURE_SCAN_v4.3.15_iter2",
    label: "LONG Trend-follow ATR+4hUP+1dRSImid",
    config: {
      leverage: 100, targetPct: 5, stopPct: 2, maxHoldBars: 100, minScore: 0,
      stochOBLevel: 95, stochOSLevel: 5, rsiOBLevel: 75, rsiOSLevel: 25,
      forceSide: "LONG",
      atrFilter: { op: "<", value: 0.4 },
      emaDistFilter: { op: "between", min: -0.5, max: 1.0 },
      htfTrendFilter: { mode: { want: "UP", tf: "near" } as any },
      htfRsiFilter: { tf: "1d", op: "<", value: 70 }, // daily chưa quá nóng
    },
    stats: {
      winRate: 0, profitFactor: 0, trades: 0, avgWinPct: 500, avgLossPct: -200,
      avgHoldBars: 0, wins: 0, losses: 0, timeouts: 0, grossPnL: 0, feeCost: 0, netPnL: 0,
      side: "LONG",
    },
  },
  {
    // R5v2 — LONG bottom-fish: 4h DOWN + 1d RSI>40 (daily chưa sập) + EMA xa dưới
    source: "FEATURE_SCAN_v4.3.15_iter2",
    label: "LONG Bottom-fish EMAfar+4hDOWN+1dRSIstable",
    config: {
      leverage: 100, targetPct: 5, stopPct: 2, maxHoldBars: 100, minScore: 0,
      stochOBLevel: 95, stochOSLevel: 5, rsiOBLevel: 75, rsiOSLevel: 25,
      forceSide: "LONG",
      emaDistFilter: { op: "<", value: -2 },
      htfTrendFilter: { mode: { want: "DOWN", tf: "near" } as any },
      htfRsiFilter: { tf: "1d", op: ">", value: 40 }, // daily chưa oversold cực độ
    },
    stats: {
      winRate: 0, profitFactor: 0, trades: 0, avgWinPct: 500, avgLossPct: -200,
      avgHoldBars: 0, wins: 0, losses: 0, timeouts: 0, grossPnL: 0, feeCost: 0, netPnL: 0,
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

  // Remove all rules from 1h TF that are FEATURE_SCAN_v4.3.15 (both iter1 + anything from source)
  const before = raw.tfs["1h"].rules.length;
  raw.tfs["1h"].rules = raw.tfs["1h"].rules.filter((r: any) => !String(r.source || "").startsWith("FEATURE_SCAN_v4.3.15"));
  const afterClean = raw.tfs["1h"].rules.length;
  console.log(`🗑️  Removed ${before - afterClean} iter1 rules`);

  // Inject V2 at top
  const newRules = V2_RULES.map((r) => ({ rank: 0, source: r.source, label: r.label, config: r.config, stats: r.stats }));
  raw.tfs["1h"].rules = [...newRules, ...raw.tfs["1h"].rules];
  raw.tfs["1h"].rules.forEach((r: any, i: number) => { r.rank = i + 1; });
  console.log(`✨ Injected ${V2_RULES.length} iter2 rules`);

  raw.generated_at = new Date().toISOString();
  raw.data_source = (raw.data_source || "").replace(/ \+ inject-feature-rules.*$/, "") + " + inject-feature-rules-v2.ts iter2";

  writeFileSync(RULES_PATH, JSON.stringify(raw, null, 2));
  console.log(`✅ Wrote ${RULES_PATH}`);
  V2_RULES.forEach((r, i) => {
    console.log(`   ${i+1}. [${r.stats.side}] ${r.label}`);
  });
}

main();
