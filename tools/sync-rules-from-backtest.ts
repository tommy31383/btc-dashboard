/**
 * sync-rules-from-backtest.ts
 *
 * Sync hard_rules.json stats với kết quả 3y backtest:
 *   - Update trades/winRate/profitFactor/netPnL/avgHold cho từng rule
 *   - NET PnL > 0 → enable (xóa disabled flag)
 *   - NET PnL <= 0 → disable (set disabled=true, lưu reason)
 *
 * Source: assets/backtest_active_3y.json
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const HARD = join(__dirname, "..", "assets", "hard_rules.json");
const BT = join(__dirname, "..", "assets", "backtest_active_3y.json");

const NOW = new Date().toISOString();

function main() {
  const hard = JSON.parse(readFileSync(HARD, "utf8"));
  const bt = JSON.parse(readFileSync(BT, "utf8"));
  const results: any[] = bt.results;

  const idx = new Map<string, any>();
  for (const r of results) idx.set(`${r.tfKey}#${r.rank}`, r);

  let enabled = 0, disabled = 0, updated = 0, missing = 0;
  const flips: string[] = [];

  for (const tf of Object.keys(hard.tfs)) {
    if (!["15m", "1h", "4h"].includes(tf)) continue;
    for (const rule of hard.tfs[tf].rules) {
      const r = idx.get(`${tf}#${rule.rank}`);
      if (!r) { missing++; continue; }
      const wasDisabled = rule.disabled === true;
      const shouldDisable = r.netPnL <= 0;

      // update stats
      rule.stats = rule.stats || {};
      rule.stats.trades = r.trades;
      rule.stats.winRate = r.winRate;
      rule.stats.profitFactor = r.profitFactor;
      rule.stats.netPnL = r.netPnL;
      rule.stats.avgHold = r.avgHold;
      rule.stats.verified = true;
      rule.stats.lastBacktestAt = NOW;
      rule.stats.lastBacktestSource = "backtest_active_3y_specaligned";
      updated++;

      if (shouldDisable) {
        if (!wasDisabled) {
          rule.disabled = true;
          rule.disableReason = `NET ${r.netPnL}% <= 0 (3y replay 2026-04-24)`;
          flips.push(`DISABLE ${tf} #${rule.rank}: NET ${r.netPnL}% WR ${r.winRate}%`);
        }
        disabled++;
      } else {
        if (wasDisabled) {
          delete rule.disabled;
          delete rule.disableReason;
          rule.stats.reEnabledAt = NOW;
          rule.stats.reEnableReason = `NET +${r.netPnL}% > 0 (3y replay)`;
          flips.push(`ENABLE  ${tf} #${rule.rank}: NET +${r.netPnL}% WR ${r.winRate}%`);
        }
        enabled++;
      }
    }
  }

  hard.generated_at = NOW;
  writeFileSync(HARD, JSON.stringify(hard, null, 2));

  console.log(`Updated stats: ${updated} rules`);
  console.log(`Active (NET>0): ${enabled}`);
  console.log(`Disabled (NET<=0): ${disabled}`);
  if (missing) console.log(`Missing in backtest: ${missing}`);
  console.log(`\nFlips (${flips.length}):`);
  for (const f of flips) console.log("  " + f);
}
main();
