/**
 * apply-rescue.ts
 *
 * Apply kết quả rescue-rules.ts vào hard_rules.json:
 *   - RESCUED: update config.targetPct / config.stopPct sang best combo
 *              + update stats.winRate / stats.netPnL
 *              + thêm stats.rescuedAt, stats.originalTP, stats.originalSL
 *   - DEAD: set config.disabled = true + stats.deadAt
 *
 * Backup hard_rules.json → hard_rules.backup-<ISO>.json trước khi ghi đè.
 */

import { readFileSync, writeFileSync, copyFileSync } from "fs";
import { join } from "path";

const hardPath = join(__dirname, "..", "assets", "hard_rules.json");
const rescuePath = join(__dirname, "..", "assets", "rules_rescue.json");

const ts = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = join(__dirname, "..", "assets", `hard_rules.backup-${ts}.json`);
copyFileSync(hardPath, backupPath);
console.log(`✅ Backup: ${backupPath}`);

const hard = JSON.parse(readFileSync(hardPath, "utf8"));
const rescue = JSON.parse(readFileSync(rescuePath, "utf8"));

const now = new Date().toISOString();
let rescuedApplied = 0, deadApplied = 0, improvedFlagged = 0, notFound = 0;

for (const r of rescue.results) {
  const tfRules = hard.tfs[r.tfKey]?.rules;
  if (!tfRules) { notFound++; continue; }
  const rule = tfRules.find((x: any) => x.rank === r.rank);
  if (!rule) { notFound++; continue; }
  rule.config = rule.config || {};
  rule.stats = rule.stats || {};

  if (r.status === "RESCUED" && r.best) {
    // Save original TP/SL
    if (rule.stats.originalTP === undefined) rule.stats.originalTP = rule.config.targetPct;
    if (rule.stats.originalSL === undefined) rule.stats.originalSL = rule.config.stopPct;
    rule.config.targetPct = r.best.tp;
    rule.config.stopPct = r.best.sl;
    rule.stats.winRate = r.best.winRate;
    rule.stats.netPnL = r.best.netPnL;
    rule.stats.trades = r.best.trades;
    rule.stats.profitFactor = r.best.pf;
    rule.stats.rescuedAt = now;
    rule.stats.rescueSource = "grid-search-2.3Y";
    delete rule.config.disabled;
    rescuedApplied++;
  } else if (r.status === "DEAD") {
    rule.config.disabled = true;
    rule.stats.deadAt = now;
    rule.stats.winRate = r.current.winRate;
    rule.stats.netPnL = r.current.netPnL;
    rule.stats.bestAttempt = r.best ? { tp: r.best.tp, sl: r.best.sl, wr: r.best.winRate, net: r.best.netPnL } : null;
    deadApplied++;
  } else if (r.status === "IMPROVED") {
    // Flag but don't auto-apply (WR < 45% hoặc NET improve <1.5x)
    rule.stats.needsReview = true;
    rule.stats.improvedSuggestion = r.best ? { tp: r.best.tp, sl: r.best.sl, wr: r.best.winRate, net: r.best.netPnL } : null;
    improvedFlagged++;
  }
}

// Bump meta
hard.last_rescued_at = now;
hard.rescue_summary = {
  rescued: rescuedApplied,
  dead_disabled: deadApplied,
  improved_flagged: improvedFlagged,
  not_found: notFound,
};

writeFileSync(hardPath, JSON.stringify(hard, null, 2));
console.log(`\n=== Apply summary ===`);
console.log(`  RESCUED applied:     ${rescuedApplied}`);
console.log(`  DEAD disabled:       ${deadApplied}`);
console.log(`  IMPROVED flagged:    ${improvedFlagged}`);
console.log(`  Not found:           ${notFound}`);
console.log(`✅ Saved ${hardPath}`);
