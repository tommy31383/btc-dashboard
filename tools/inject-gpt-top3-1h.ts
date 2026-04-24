/**
 * inject-gpt-top3-1h.ts
 *
 * Replace all existing GPT_HIGHWR_1H + GPT_SELECTED_1H_3Y_SHORT placeholder rules
 * in assets/hard_rules.json (1h tf) with 3 verified top rules from spec-aligned
 * 3-year backtest (post-fee 0.05%/side, HTF UP enforced).
 *
 * Stats source: assets/highwr_1h_rules_backtest.json (re-run 2026-04-24)
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const HARD_PATH = join(__dirname, "..", "assets", "hard_rules.json");
const NOW = new Date().toISOString();

type Cfg = {
  leverage: number;
  targetPct: number;
  stopPct: number;
  maxHoldBars: number;
  forceSide: "LONG" | "SHORT";
  minScore: number;
  disabled?: boolean;
  disabledReason?: string;
  htfFilters?: any[];
  atrFilter?: any;
  rsiFilter?: any;
  emaDistFilter?: any;
  gptFeatureRule?: string;
  note?: string;
};

const baseCfg = {
  leverage: 100,
  targetPct: 3,
  stopPct: 2,
  maxHoldBars: 100,
  forceSide: "LONG" as const,
  // pure-feature rule: no classic conditions required
  minScore: 0,
  // Spec: HTF UP via near (4h) trend
  htfFilters: [{ type: "trend", tf: "4h", direction: "up" }],
};

const top3: { label: string; cfg: Cfg; stats: any }[] = [
  {
    label: "[GPT-V2 1H] EMA0.5-2% & ATR<0.3% & HTF4h UP — WR 71.7% n=245 NET +329%",
    cfg: {
      ...baseCfg,
      gptFeatureRule: "ema:0.5..2% & atr:<0.3% & htf:UP",
      atrFilter: { op: "<", value: 0.3 },
      emaDistFilter: { op: "between", min: 0.5, max: 2 },
      note: "Verified 3y post-fee 0.05%/side. PF 3.81. Spec-aligned: SL→TP, entry@close, one-position.",
    },
    stats: { side: "LONG", trades: 245, winRate: 71.75, profitFactor: 3.81, netPnL: 329.5, verified: true, source: "GPT_HIGHWR_1H_v2_specaligned_3y", injectedAt: NOW },
  },
  {
    label: "[GPT-V2 1H] RSI55-70 & EMA0.5-2% & ATR<0.3% & HTF4h UP — WR 73.4% n=183 NET +264%",
    cfg: {
      ...baseCfg,
      gptFeatureRule: "rsi:55-70 & ema:0.5..2% & atr:<0.3% & htf:UP",
      rsiFilter: { op: "between", min: 55, max: 70 },
      atrFilter: { op: "<", value: 0.3 },
      emaDistFilter: { op: "between", min: 0.5, max: 2 },
      note: "Verified 3y post-fee 0.05%/side. PF 4.13.",
    },
    stats: { side: "LONG", trades: 183, winRate: 73.37, profitFactor: 4.13, netPnL: 263.7, verified: true, source: "GPT_HIGHWR_1H_v2_specaligned_3y", injectedAt: NOW },
  },
  {
    label: "[GPT-V2 1H] RSI55-70 & ATR<0.3% & HTF4h UP — WR 65.7% n=312 NET +321%",
    cfg: {
      ...baseCfg,
      gptFeatureRule: "rsi:55-70 & atr:<0.3% & htf:UP",
      rsiFilter: { op: "between", min: 55, max: 70 },
      atrFilter: { op: "<", value: 0.3 },
      note: "Verified 3y post-fee 0.05%/side. PF 2.87.",
    },
    stats: { side: "LONG", trades: 312, winRate: 65.69, profitFactor: 2.87, netPnL: 320.8, verified: true, source: "GPT_HIGHWR_1H_v2_specaligned_3y", injectedAt: NOW },
  },
];

function main() {
  const hard = JSON.parse(readFileSync(HARD_PATH, "utf8"));
  const tf1h = hard.tfs["1h"];
  const before = tf1h.rules.length;

  // Drop ALL old GPT placeholder rules (HIGHWR + SHORT) — they were never enabled-correctly
  tf1h.rules = tf1h.rules.filter((r: any) => {
    const src = r.source || "";
    return !src.startsWith("GPT_HIGHWR_1H") && !src.startsWith("GPT_SELECTED_1H_3Y_SHORT");
  });
  const afterDrop = tf1h.rules.length;

  // Add 3 new verified rules
  let nextRank = Math.max(...tf1h.rules.map((r: any) => r.rank)) + 1;
  for (const rule of top3) {
    tf1h.rules.push({
      rank: nextRank++,
      source: "GPT_HIGHWR_1H_v2",
      label: rule.label,
      config: rule.cfg,
      stats: rule.stats,
      compositeScore: rule.stats.winRate * Math.log(rule.stats.trades + 1) / 100,
    });
  }

  hard.generated_at = NOW;
  writeFileSync(HARD_PATH, JSON.stringify(hard, null, 2));

  console.log(`hard_rules.json updated:`);
  console.log(`  1h rules: ${before} → ${tf1h.rules.length} (dropped ${before - afterDrop} old GPT, added 3 new)`);
  console.log(`  Generated at: ${NOW}`);
  for (const r of tf1h.rules.slice(-3)) {
    console.log(`  + #${r.rank} ${r.source}: ${r.label}`);
  }
}

main();
