/**
 * disable-loss-rules.ts
 *
 * Disable rules that lost heavily in 3-year spec-aligned backtest:
 * - 15m #4 VERIFIED: WR 0% / n=302 / NET -9002% — broken
 * - 4h #10 flipped-from-4h-rank2: WR 61.7% / n=253 / NET -12,904% — bad PnL pattern
 * - 1h #38/#39/#40 golden-riskRadar: NET -15,815% — TIER 2 placeholder, filter not evaluated
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const PATH = join(__dirname, "..", "assets", "hard_rules.json");
const NOW = new Date().toISOString();

const TARGETS: { tf: string; rank: number; reason: string }[] = [
  { tf: "15m", rank: 4, reason: "3y-backtest WR 0% n=302 NET -9002% — broken rule" },
  { tf: "4h", rank: 10, reason: "3y-backtest NET -12904% despite WR 61.7% — exit pattern bad" },
  { tf: "1h", rank: 38, reason: "3y-backtest NET -15815% — golden-riskRadar TIER2 placeholder" },
  { tf: "1h", rank: 39, reason: "3y-backtest NET -15815% — golden-riskRadar TIER2 placeholder" },
  { tf: "1h", rank: 40, reason: "3y-backtest NET -15815% — golden-riskRadar TIER2 placeholder" },
];

function main() {
  const j = JSON.parse(readFileSync(PATH, "utf8"));
  let n = 0;
  for (const t of TARGETS) {
    const r = j.tfs[t.tf].rules.find((x: any) => x.rank === t.rank);
    if (!r) { console.log(`  ✗ ${t.tf}#${t.rank} not found`); continue; }
    if (r.config.disabled === true) { console.log(`  · ${t.tf}#${t.rank} already disabled`); continue; }
    r.config.disabled = true;
    r.config.disabledReason = t.reason;
    r.config.disabledAt = NOW;
    n++;
    console.log(`  ✓ ${t.tf}#${t.rank} ${r.source} → disabled (${t.reason})`);
  }
  j.generated_at = NOW;
  writeFileSync(PATH, JSON.stringify(j, null, 2));
  console.log(`\nDisabled ${n}/${TARGETS.length} rules.`);
}
main();
