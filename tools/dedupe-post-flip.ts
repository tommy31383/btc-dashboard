/**
 * dedupe-post-flip.ts
 *
 * Scan hard_rules.json sau khi apply-flip, phát hiện duplicate bằng signature:
 *   {tf}|{forceSide|side}|[sorted requiredConditions]|{htfFilter}|TP{tp}/SL{sl}
 *
 * Với mỗi group dup:
 *   - Keep rule có `verified=true` hoặc netPnL cao nhất
 *   - Disable các rule còn lại (config.disabled=true, stats.dedupeDisabledAt)
 *
 * Skip rule đã disabled, skip rule delegatedTo.
 */
import { readFileSync, writeFileSync, copyFileSync } from "fs";
import { join } from "path";

const p = join(__dirname, "..", "assets", "hard_rules.json");
const ts = new Date().toISOString().replace(/[:.]/g, "-");
const backup = join(__dirname, "..", "assets", `hard_rules.backup-dedupe-${ts}.json`);
copyFileSync(p, backup);
console.log(`✅ Backup: ${backup}`);

const h = JSON.parse(readFileSync(p, "utf8"));
const now = new Date().toISOString();

function sig(tf: string, r: any): string {
  const c = r.config || {};
  const side = c.forceSide || r.stats?.side || "?";
  const req = [...(c.requiredConditions || [])].sort().join(",") || "-";
  const htf = c.htfTrendFilter?.mode || c.htfTrendFilter || "-";
  return `${tf}|${side}|${req}|${htf}|TP${c.targetPct}/SL${c.stopPct}`;
}

let totalGroups = 0, totalDisabled = 0;

for (const tf of Object.keys(h.tfs)) {
  const rules = h.tfs[tf].rules;
  const groups = new Map<string, any[]>();
  for (const r of rules) {
    if (r.config?.disabled) continue;
    if (r.config?.delegatedTo) continue; // Goldens: signature sẽ khác vì feature-based
    const s = sig(tf, r);
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s)!.push(r);
  }

  for (const [s, gr] of groups) {
    if (gr.length < 2) continue;
    totalGroups++;
    // Keep rule: verified=true priority → netPnL cao nhất
    gr.sort((a, b) => {
      const av = a.stats?.verified ? 1 : 0;
      const bv = b.stats?.verified ? 1 : 0;
      if (av !== bv) return bv - av;
      return (b.stats?.netPnL || 0) - (a.stats?.netPnL || 0);
    });
    const keep = gr[0];
    const drop = gr.slice(1);
    console.log(`[${tf}] group: ${s}`);
    console.log(`  KEEP  rank${keep.rank} netPnL=${keep.stats?.netPnL}%  (${keep.source || "native"})`);
    for (const d of drop) {
      d.config = d.config || {};
      d.config.disabled = true;
      d.stats = d.stats || {};
      d.stats.dedupeDisabledAt = now;
      d.stats.dedupeReason = `dup-of-rank-${keep.rank}`;
      console.log(`  DROP  rank${d.rank} netPnL=${d.stats?.netPnL}% (disabled)`);
      totalDisabled++;
    }
  }
}

h.last_dedupe_at = now;
h.dedupe_summary = { groups: totalGroups, disabled: totalDisabled };
writeFileSync(p, JSON.stringify(h, null, 2));
console.log(`\n=== Done ===\n  Duplicate groups: ${totalGroups}\n  Rules disabled: ${totalDisabled}\n✅ Saved ${p}`);
