/**
 * patch-flipped-htf.ts
 *
 * Patch hard_rules.json: với các rule có source="flipped-from-*" và có htfTrendFilter,
 * set htfTrendFilter.invertedFromFlip = true (để useRuleAlerts invert want).
 *
 * Đồng thời disable các rule flipped BRONZE có dấu hiệu overfit / edge âm sâu:
 *   - 5m rank9 (N=6325 PF=999, overfit)
 *   - 15m rank26 (BRONZE, edge -41%)
 *   - 1h rank42 (BRONZE, edge -28%)
 */
import { readFileSync, writeFileSync, copyFileSync } from "fs";
import { join } from "path";

const p = join(__dirname, "..", "assets", "hard_rules.json");
const ts = new Date().toISOString().replace(/[:.]/g, "-");
copyFileSync(p, join(__dirname, "..", "assets", `hard_rules.backup-patchhtf-${ts}.json`));

const h = JSON.parse(readFileSync(p, "utf8"));
const now = new Date().toISOString();

const DISABLE_LIST = new Set(["5m-9", "15m-26", "1h-42"]);
let patched = 0, disabled = 0;

for (const tf of Object.keys(h.tfs)) {
  for (const r of h.tfs[tf].rules) {
    if (!r.source || !r.source.startsWith("flipped-from-")) continue;
    const key = `${tf}-${r.rank}`;

    // Patch HTF invertedFromFlip
    if (r.config?.htfTrendFilter && !r.config.htfTrendFilter.invertedFromFlip) {
      if (typeof r.config.htfTrendFilter === "string") {
        r.config.htfTrendFilter = { mode: r.config.htfTrendFilter, invertedFromFlip: true };
      } else {
        r.config.htfTrendFilter.invertedFromFlip = true;
      }
      console.log(`  PATCH ${tf} rank${r.rank} → htfTrendFilter.invertedFromFlip=true`);
      patched++;
    }

    // Disable overfit / low-edge BRONZE
    if (DISABLE_LIST.has(key) && !r.config?.disabled) {
      r.config = r.config || {};
      r.config.disabled = true;
      r.stats = r.stats || {};
      r.stats.disabledAt = now;
      r.stats.disabledReason = "post-flip-review: edge âm hoặc overfit";
      console.log(`  DISABLE ${tf} rank${r.rank} (overfit/low-edge)`);
      disabled++;
    }
  }
}

writeFileSync(p, JSON.stringify(h, null, 2));
console.log(`\n=== Done ===\n  HTF patched: ${patched}\n  Rules disabled: ${disabled}\n`);
