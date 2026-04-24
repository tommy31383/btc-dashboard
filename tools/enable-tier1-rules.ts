/**
 * enable-tier1-rules.ts
 *
 * Flip disabled:false on 10 TIER-1 disabled rules with strong 3-year backtest.
 * All HTF SHORT MACD-based or flipped LONG variants. Sample n ≥ 247, PF ≥ 1.28.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const PATH = join(__dirname, "..", "assets", "hard_rules.json");
// [tf, rank]
const TIER1: [string, number][] = [
  ["15m", 16], ["15m", 10], ["15m", 9], ["15m", 26],
  ["1h", 24], ["1h", 42], ["1h", 11], ["1h", 12], ["1h", 13], ["1h", 27],
];

function main() {
  const j = JSON.parse(readFileSync(PATH, "utf8"));
  let flipped = 0;
  for (const [tf, rank] of TIER1) {
    const r = j.tfs[tf].rules.find((x: any) => x.rank === rank);
    if (!r) { console.log(`  ✗ ${tf}#${rank} not found`); continue; }
    if (r.config.disabled !== true) { console.log(`  · ${tf}#${rank} already enabled`); continue; }
    r.config.disabled = false;
    delete r.config.disabledReason;
    r.config.revivedAt = new Date().toISOString();
    r.config.revivedNote = "TIER1 revival 2026-04-24: 3y backtest n≥247 PF≥1.28 NET +8k%~+16k%";
    flipped++;
    console.log(`  ✓ ${tf}#${rank} ${r.source} → enabled`);
  }
  j.generated_at = new Date().toISOString();
  writeFileSync(PATH, JSON.stringify(j, null, 2));
  console.log(`\nFlipped ${flipped}/${TIER1.length} rules.`);
}
main();
