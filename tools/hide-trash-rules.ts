/**
 * hide-trash-rules.ts
 *
 * Disable rules with truly bad stats so they don't clutter the app:
 *   - WR < 25%
 *   - OR 3y NET PnL < -2000%
 *   - OR PF < 0.8
 *
 * Stats source: backtest_active_3y.json for 15m/1h/4h, else stored stats.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const HARD = join(__dirname, "..", "assets", "hard_rules.json");
const BT = join(__dirname, "..", "assets", "backtest_active_3y.json");
const NOW = new Date().toISOString();

const MIN_WR = 25;
const MIN_PF = 0.8;
const MIN_NET = -2000;

function main() {
  const hard = JSON.parse(readFileSync(HARD, "utf8"));
  const bt = JSON.parse(readFileSync(BT, "utf8"));
  const btIndex = new Map<string, any>();
  for (const r of bt.results) btIndex.set(`${r.tfKey}#${r.rank}`, r);

  let disabled = 0;
  const list: string[] = [];

  for (const tf of Object.keys(hard.tfs)) {
    for (const r of hard.tfs[tf].rules) {
      if (r.config.disabled === true) continue; // already hidden
      if (r.config.delegatedTo) continue;       // handled elsewhere

      const live = btIndex.get(`${tf}#${r.rank}`);
      const wr = live?.winRate ?? r.stats?.winRate ?? null;
      const pf = live?.profitFactor ?? r.stats?.profitFactor ?? null;
      const net = live?.netPnL ?? null;

      const reasons: string[] = [];
      if (wr !== null && wr < MIN_WR) reasons.push(`WR=${wr}% < ${MIN_WR}%`);
      if (pf !== null && pf < MIN_PF) reasons.push(`PF=${pf} < ${MIN_PF}`);
      if (net !== null && net < MIN_NET) reasons.push(`3y NET=${net}% < ${MIN_NET}%`);
      if (reasons.length === 0) continue;

      r.config.disabled = true;
      r.config.disabledReason = `hide-trash: ${reasons.join("; ")}`;
      r.config.disabledAt = NOW;
      disabled++;
      list.push(`[${tf}] #${r.rank} ${r.source}: ${reasons.join(" | ")}`);
    }
  }

  hard.generated_at = NOW;
  writeFileSync(HARD, JSON.stringify(hard, null, 2));

  console.log(`\n=== HIDE-TRASH-RULES ===`);
  console.log(`Disabled ${disabled} bad rules:`);
  for (const s of list) console.log(`  ✗ ${s}`);
}
main();
