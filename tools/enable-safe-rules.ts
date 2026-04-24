/**
 * enable-safe-rules.ts
 *
 * Flip disabled:false on rules meeting safety criteria:
 *   - sample n ≥ 50
 *   - WR ≥ 30%
 *   - PF ≥ 1.0
 *   - NOT delegatedTo (engine can't eval those)
 *
 * Stats source: backtest_active_3y.json for 15m/1h/4h, else stored stats.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const HARD = join(__dirname, "..", "assets", "hard_rules.json");
const BT = join(__dirname, "..", "assets", "backtest_active_3y.json");
const NOW = new Date().toISOString();

const MIN_N = 50;
const MIN_WR = 30;
const MIN_PF = 1.0;

function main() {
  const hard = JSON.parse(readFileSync(HARD, "utf8"));
  const bt = JSON.parse(readFileSync(BT, "utf8"));

  const btIndex = new Map<string, any>();
  for (const r of bt.results) btIndex.set(`${r.tfKey}#${r.rank}`, r);

  let flipped = 0, skippedDelegated = 0, skippedBadStats = 0, skippedNoStats = 0;
  const flippedList: string[] = [];

  for (const tf of Object.keys(hard.tfs)) {
    for (const r of hard.tfs[tf].rules) {
      if (r.config.disabled !== true) continue;
      if (r.config.delegatedTo) { skippedDelegated++; continue; }

      const live = btIndex.get(`${tf}#${r.rank}`);
      const stats = live ?? r.stats;
      if (!stats) { skippedNoStats++; continue; }

      const n = stats.trades ?? stats.n ?? 0;
      const wr = stats.winRate ?? 0;
      const pf = stats.profitFactor ?? 0;

      if (n < MIN_N || wr < MIN_WR || pf < MIN_PF) {
        skippedBadStats++;
        continue;
      }

      r.config.disabled = false;
      delete r.config.disabledReason;
      delete r.config.disabledAt;
      r.config.revivedAt = NOW;
      r.config.revivedNote = `enable-safe-rules: n=${n} WR=${wr}% PF=${pf} (source=${live ? "backtest_3y" : "stored"})`;
      flipped++;
      flippedList.push(`[${tf}] #${r.rank} ${r.source}: n=${n} WR=${wr}% PF=${pf}`);
    }
  }

  hard.generated_at = NOW;
  writeFileSync(HARD, JSON.stringify(hard, null, 2));

  console.log(`\n=== ENABLE-SAFE-RULES ===`);
  console.log(`Criteria: n ≥ ${MIN_N}, WR ≥ ${MIN_WR}%, PF ≥ ${MIN_PF}`);
  console.log(`\nFlipped ${flipped} rules:`);
  for (const s of flippedList) console.log(`  ✓ ${s}`);
  console.log(`\nSkipped:`);
  console.log(`  - ${skippedDelegated} delegatedTo (engine cannot eval)`);
  console.log(`  - ${skippedBadStats} below safety threshold`);
  console.log(`  - ${skippedNoStats} no stats`);
}
main();
