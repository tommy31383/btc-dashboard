/**
 * inject-4h-top5.ts
 *
 * Inject 5 verified 4h LONG rules from spec-aligned scan:
 *   - fee 0.05%/side, SL→TP, one-position, HTF=1d UP enforced
 *   - TP=5%, SL=2.5%, hold=50, lev=100
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const HARD = join(__dirname, "..", "assets", "hard_rules.json");
const NOW = new Date().toISOString();

const baseCfg = {
  leverage: 100, targetPct: 5, stopPct: 2.5, maxHoldBars: 50,
  forceSide: "LONG" as const, minScore: 0,
  htfFilters: [{ type: "trend", tf: "1d", direction: "up" }],
};

type Rule = { label: string; cfg: any; stats: any };

const rules: Rule[] = [
  {
    label: "[GPT 4H v1] MACD>100 + ATR1-2% + Body>2% + HTF1d UP — WR 60% n=36 NET +6640%",
    cfg: { ...baseCfg,
      macdHistFilter: { op: ">", value: 100 },
      atrFilter: { op: "between", min: 1, max: 2 },
      bodyPctFilter: { op: ">", value: 2 },
      gptFeatureRule: "macd:>100 & atr:1-2% & body:>2% & htf:UP",
      note: "Spec-aligned 3y scan TP=5% SL=2.5%. PF 3.00.",
    },
    stats: { side: "LONG", trades: 36, winRate: 60, profitFactor: 3, netPnL: 6640, verified: true, source: "GPT_4H_v1_specaligned_3y", injectedAt: NOW },
  },
  {
    label: "[GPT 4H v1] RSI45-55 + MACD0-100 + Body0.3-1% + HTF1d UP — WR 55% n=42 NET +6080%",
    cfg: { ...baseCfg,
      rsiFilter: { op: "between", min: 45, max: 55 },
      macdHistFilter: { op: "between", min: 0, max: 100 },
      bodyPctFilter: { op: "between", min: 0.3, max: 1 },
      gptFeatureRule: "rsi:45-55 & macd:0..100 & body:0.3-1% & htf:UP",
      note: "Spec-aligned 3y scan. PF 2.44.",
    },
    stats: { side: "LONG", trades: 42, winRate: 55, profitFactor: 2.44, netPnL: 6080, verified: true, source: "GPT_4H_v1_specaligned_3y", injectedAt: NOW },
  },
  {
    label: "[GPT 4H v1] BB%>100 + Body>2% + CONT + HTF1d UP — WR 56.3% n=34 NET +5160%",
    cfg: { ...baseCfg,
      bbPercentFilter: { op: ">", value: 1 },
      bodyPctFilter: { op: ">", value: 2 },
      reversalFilter: { kind: "CONT" },
      gptFeatureRule: "bb%:>100 & body:>2% & rev:CONT & htf:UP",
      note: "Spec-aligned 3y scan. PF 2.57. BB %B > 1 = price above upper band.",
    },
    stats: { side: "LONG", trades: 34, winRate: 56.25, profitFactor: 2.57, netPnL: 5160, verified: true, source: "GPT_4H_v1_specaligned_3y", injectedAt: NOW },
  },
  {
    label: "[GPT 4H v1] RSI>70 + BB%75-100 + DOWN_REV + HTF1d UP — WR 57.1% n=31 NET +4690%",
    cfg: { ...baseCfg,
      rsiFilter: { op: ">", value: 70 },
      bbPercentFilter: { op: "between", min: 0.75, max: 1 },
      reversalFilter: { kind: "DOWN_REV" },
      gptFeatureRule: "rsi:>70 & bb%:75-100 & rev:DOWN_REV & htf:UP",
      note: "Spec-aligned 3y scan. PF 2.67. Mua khi pullback nhẹ trong xu thế tăng.",
    },
    stats: { side: "LONG", trades: 31, winRate: 57.14, profitFactor: 2.67, netPnL: 4690, verified: true, source: "GPT_4H_v1_specaligned_3y", injectedAt: NOW },
  },
  {
    label: "[GPT 4H v1] RSI30-45 + MACD-100..0 + Body0.3-1% + HTF1d UP — WR 55.6% n=30 NET +4200%",
    cfg: { ...baseCfg,
      rsiFilter: { op: "between", min: 30, max: 45 },
      macdHistFilter: { op: "between", min: -100, max: 0 },
      bodyPctFilter: { op: "between", min: 0.3, max: 1 },
      gptFeatureRule: "rsi:30-45 & macd:-100..0 & body:0.3-1% & htf:UP",
      note: "Spec-aligned 3y scan. PF 2.50. Mua đáy trong xu thế tăng (RSI low + macd hist còn âm).",
    },
    stats: { side: "LONG", trades: 30, winRate: 55.56, profitFactor: 2.5, netPnL: 4200, verified: true, source: "GPT_4H_v1_specaligned_3y", injectedAt: NOW },
  },
];

function main() {
  const j = JSON.parse(readFileSync(HARD, "utf8"));
  const tf = j.tfs["4h"];
  let nextRank = Math.max(...tf.rules.map((r: any) => r.rank)) + 1;
  for (const r of rules) {
    tf.rules.push({
      rank: nextRank++, source: "GPT_4H_v1", label: r.label,
      config: r.cfg, stats: r.stats,
      compositeScore: r.stats.winRate * Math.log(r.stats.trades + 1) / 100,
    });
  }
  j.generated_at = NOW;
  writeFileSync(HARD, JSON.stringify(j, null, 2));
  console.log(`Injected ${rules.length} new 4h rules.`);
  for (const r of tf.rules.slice(-rules.length)) console.log(`  + #${r.rank} ${r.source}: ${r.label}`);
}
main();
