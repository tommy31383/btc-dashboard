/**
 * sync-rules-from-backtest.ts
 *
 * Sync hard_rules.json với backtest_active_3y.json:
 *   - Update trades/winRate/profitFactor/netPnL/avgHold cho mỗi rule
 *   - NET > 0  → enable: clear cả rule.disabled VÀ config.disabled
 *   - NET <= 0 → disable: set rule.disabled = true (giữ delegatedTo nếu có)
 *   - Không động tới delegatedTo (cấu trúc dedup, không phải on/off)
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const HARD = join(__dirname, "..", "assets", "hard_rules.json");
const BT = join(__dirname, "..", "assets", "backtest_active_3y.json");
const NOW = new Date().toISOString();

function main() {
  const hard = JSON.parse(readFileSync(HARD, "utf8"));
  const bt = JSON.parse(readFileSync(BT, "utf8"));
  const idx = new Map<string, any>();
  for (const r of bt.results) idx.set(`${r.tfKey}#${r.rank}`, r);

  let upd = 0, en = 0, dis = 0, missing = 0;
  const flips: string[] = [];

  for (const tf of Object.keys(hard.tfs)) {
    for (const rule of hard.tfs[tf].rules) {
      const r = idx.get(`${tf}#${rule.rank}`);
      if (!r) { missing++; continue; }
      const wasDisabled = rule.disabled === true || (rule.config && rule.config.disabled === true);
      const shouldDisable = r.netPnL <= 0;

      rule.stats = rule.stats || {};
      Object.assign(rule.stats, {
        trades: r.trades,
        winRate: r.winRate,
        profitFactor: r.profitFactor,
        netPnL: r.netPnL,
        avgHold: r.avgHold,
        equityCurve: r.equityCurve ?? [],
        equityTrend: r.equityTrend ?? "FLAT",
        maxDrawdownPct: r.maxDrawdownPct ?? 0,
        verified: true,
        lastBacktestAt: NOW,
        lastBacktestSource: "backtest_active_3y_6tf",
      });
      upd++;

      if (shouldDisable) {
        if (!wasDisabled) flips.push(`DISABLE ${tf} #${rule.rank}: NET ${r.netPnL}%`);
        rule.disabled = true;
        rule.disableReason = `NET ${r.netPnL}% <= 0 (3y replay 6-TF)`;
        if (rule.config) rule.config.disabled = true; // keep cfg.disabled in sync
        dis++;
      } else {
        if (wasDisabled) flips.push(`ENABLE  ${tf} #${rule.rank}: NET +${r.netPnL}%`);
        delete rule.disabled;
        delete rule.disableReason;
        if (rule.config) delete rule.config.disabled;
        en++;
      }
    }
  }

  hard.generated_at = NOW;
  writeFileSync(HARD, JSON.stringify(hard, null, 2));

  console.log(`Updated: ${upd}, Enable: ${en}, Disable: ${dis}, Missing: ${missing}`);
  console.log(`\nFlips (${flips.length}):`);
  for (const f of flips) console.log("  " + f);
}
main();
