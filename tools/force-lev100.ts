/**
 * force-lev100.ts — cố định leverage = 100 cho TẤT CẢ rule trong hard_rules.json.
 * Không recalc stats.netPnL (giữ nguyên số scan cũ ở lev 100).
 */
import { readFileSync, writeFileSync, copyFileSync } from "fs";
import { join } from "path";

const p = join(__dirname, "..", "assets", "hard_rules.json");
const ts = new Date().toISOString().replace(/[:.]/g, "-");
copyFileSync(p, join(__dirname, "..", "assets", `hard_rules.backup-forcelev-${ts}.json`));

const h = JSON.parse(readFileSync(p, "utf8"));
let changed = 0, total = 0;
for (const tf of Object.keys(h.tfs)) {
  for (const r of h.tfs[tf].rules) {
    total++;
    r.config = r.config || {};
    if (r.config.leverage !== 100) {
      r.config.leverage = 100;
      changed++;
    }
  }
}
writeFileSync(p, JSON.stringify(h, null, 2));
console.log(`✅ Forced lev=100 cho ${changed}/${total} rule.`);
