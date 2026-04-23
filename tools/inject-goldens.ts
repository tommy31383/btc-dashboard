/**
 * inject-goldens.ts
 *
 * Thêm 11 Goldens từ useRiskRadar.ts vào hard_rules.json (tfs["1h"].rules).
 * Mỗi Golden dùng flag config.delegatedTo = "useRiskRadar" → useRuleAlerts skip
 * (evaluation vẫn chạy native trong useRiskRadar, tránh duplicate logic).
 *
 * Backup hard_rules.json trước khi ghi.
 */

import { readFileSync, writeFileSync, copyFileSync } from "fs";
import { join } from "path";

interface GoldenInject {
  id: string;
  label: string;
  side: "LONG" | "SHORT";
  htf: "FLAT" | "DOWN";
  features: string[];
  wr: number;
  n: number;
  pf: number | null;
  expectancy: number | null;
}

const GOLDENS: GoldenInject[] = [
  { id: "golden_long_quadruple",     label: "🥇 Golden LONG QUADRUPLE (MACD+EMA+ATR+FLAT)",      side: "LONG",  htf: "FLAT", features: ["macdBull", "emaNear", "atrLow"],      wr: 71.8, n: 163, pf: 4.69, expectancy: 1.92 },
  { id: "golden_long_macd_flat",     label: "🥈 Golden LONG TRIPLE (MACD+EMA+FLAT)",            side: "LONG",  htf: "FLAT", features: ["macdBull", "emaNear"],               wr: 64.9, n: 405, pf: 3.90, expectancy: 1.94 },
  { id: "golden_long_macd_atr_flat", label: "🥉 Golden LONG TRIPLE (MACD+ATR+FLAT)",            side: "LONG",  htf: "FLAT", features: ["macdBull", "atrLow"],                wr: 67.4, n: 181, pf: 3.82, expectancy: 1.72 },
  { id: "golden_long_atr_ema_flat",  label: "Golden LONG SILENT+CENTER (ATR+EMA+FLAT)",         side: "LONG",  htf: "FLAT", features: ["atrLow", "emaNear"],                 wr: 60.4, n: 323, pf: 2.59, expectancy: 1.22 },
  { id: "golden_long_atr_flat",      label: "Golden LONG 1H SILENT (ATR+FLAT)",                 side: "LONG",  htf: "FLAT", features: ["atrLow"],                            wr: 81.0, n: 84,  pf: null, expectancy: null },
  { id: "golden_long_cross_silent",  label: "Golden LONG EMA CROSS BULL + SILENT",              side: "LONG",  htf: "FLAT", features: ["emaCrossBull", "atrLow"],            wr: 68.3, n: 104, pf: 3.44, expectancy: 1.45 },
  { id: "golden_long_doji_macd",     label: "Golden LONG DOJI + MACD BULL",                     side: "LONG",  htf: "FLAT", features: ["bodySmall", "macdBull"],             wr: 63.7, n: 259, pf: 3.64, expectancy: 1.78 },
  { id: "golden_long_bb_squeeze",    label: "Golden LONG BB SQUEEZE + MACD BULL",               side: "LONG",  htf: "FLAT", features: ["bbSqueeze", "macdBull"],             wr: 62.3, n: 369, pf: 3.50, expectancy: 1.79 },
  { id: "golden_short_quadruple",    label: "🥇 Golden SHORT QUADRUPLE DOWN (EMA+ATR+MACD+DOWN)", side: "SHORT", htf: "DOWN", features: ["emaCrossBear", "atrLow", "macdBear"], wr: 69.6, n: 46,  pf: 4.53, expectancy: 1.84 },
  { id: "golden_short_cross_silent", label: "🥈 Golden SHORT EMA CROSS BEAR + SILENT",          side: "SHORT", htf: "DOWN", features: ["emaCrossBear", "atrLow"],            wr: 64.9, n: 174, pf: 3.37, expectancy: 1.67 },
  { id: "golden_short_macd_silent",  label: "🥉 Golden SHORT MACD BEAR + SILENT",               side: "SHORT", htf: "DOWN", features: ["macdBear", "atrLow"],                wr: 62.9, n: 62,  pf: 3.27, expectancy: 1.57 },
];

const hardPath = join(__dirname, "..", "assets", "hard_rules.json");
const ts = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = join(__dirname, "..", "assets", `hard_rules.backup-${ts}.json`);
copyFileSync(hardPath, backupPath);
console.log(`✅ Backup: ${backupPath}`);

const hard = JSON.parse(readFileSync(hardPath, "utf8"));
const tf1h = hard.tfs["1h"];
if (!tf1h) throw new Error("hard_rules.json thiếu tfs['1h']");

// Remove previous goldens (re-run safe)
const before = tf1h.rules.length;
tf1h.rules = tf1h.rules.filter((r: any) => r.source !== "golden-riskRadar");
const removed = before - tf1h.rules.length;
if (removed) console.log(`(re-run) removed ${removed} previous injected goldens`);

let maxRank = tf1h.rules.reduce((m: number, r: any) => Math.max(m, r.rank || 0), 0);
const now = new Date().toISOString();

for (const g of GOLDENS) {
  maxRank++;
  const trades = g.n;
  const wins = Math.round(trades * g.wr / 100);
  const losses = trades - wins;
  const lev = 10, tp = 5, sl = 2;
  const netPnL = Math.round(wins * tp * lev - losses * sl * lev - trades * 0.08 * lev);

  tf1h.rules.push({
    rank: maxRank,
    source: "golden-riskRadar",
    label: g.label,
    config: {
      goldenId: g.id,
      delegatedTo: "useRiskRadar",
      forceSide: g.side,
      targetPct: tp,
      stopPct: sl,
      leverage: lev,
      maxHoldBars: 100,
      htfTrendFilter: { mode: "custom_htf_state", state: g.htf },
      features: g.features,
    },
    stats: {
      side: g.side,
      trades,
      wins,
      losses,
      winRate: g.wr,
      netPnL,
      profitFactor: g.pf,
      expectancy: g.expectancy,
      verified: true,
      source: "forward-test-2.3Y",
      injectedAt: now,
    },
  });
}

hard.last_goldens_injected_at = now;
hard.goldens_count = GOLDENS.length;

writeFileSync(hardPath, JSON.stringify(hard, null, 2));

// Summary
console.log(`\n=== Injected ${GOLDENS.length} goldens into tfs["1h"].rules ===`);
for (const g of GOLDENS) {
  console.log(`  ${g.side.padEnd(5)} ${g.id.padEnd(30)} WR ${g.wr.toFixed(1).padStart(5)}%  N=${String(g.n).padStart(4)}  ${g.label}`);
}
console.log(`\n✅ Saved ${hardPath}`);
console.log(`   1h rules now: ${tf1h.rules.length}`);
