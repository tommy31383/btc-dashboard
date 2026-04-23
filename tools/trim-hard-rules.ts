/**
 * trim-hard-rules.ts
 *
 * Slim down hard_rules.json for production app:
 *   - Per TF, keep only top N rules by NET PnL (default 15)
 *   - Deduplicate similar rules (same WR/PF/trades within tolerance)
 *   - Round numeric fields to 2 decimals (smaller JSON parse)
 *   - Drop any unused fields
 *
 * Output: assets/hard_rules.json (replaces in place — the original is
 * regenerated any time you run generate-hard-rules.ts)
 *
 * Usage:
 *   npx tsx tools/trim-hard-rules.ts            # default top 15 per TF
 *   npx tsx tools/trim-hard-rules.ts --top=10
 */

import { readFileSync, writeFileSync, statSync } from "fs";
import { join } from "path";

const args = process.argv.slice(2);
const topN = parseInt(args.find((a) => a.startsWith("--top="))?.replace("--top=", "") || "15", 10);

const PATH = join(__dirname, "..", "assets", "hard_rules.json");

interface Rule {
  rank: number;
  source: string;
  config: any;
  stats: any;
  label?: string;
  compositeScore?: number;
}

function round(v: any, decimals: number = 2): any {
  if (typeof v === "number" && !isNaN(v) && isFinite(v)) {
    const f = Math.pow(10, decimals);
    return Math.round(v * f) / f;
  }
  return v;
}

/** Recursively round all numbers in object */
function roundDeep(obj: any, decimals: number = 2): any {
  if (Array.isArray(obj)) return obj.map((v) => roundDeep(v, decimals));
  if (obj && typeof obj === "object") {
    const out: any = {};
    for (const k of Object.keys(obj)) out[k] = roundDeep(obj[k], decimals);
    return out;
  }
  return round(obj, decimals);
}

/** Two rules are duplicates if their stats are very close */
function isDuplicate(a: Rule, b: Rule): boolean {
  const sa = a.stats, sb = b.stats;
  if (Math.abs((sa.winRate || 0) - (sb.winRate || 0)) > 1.5) return false;
  if (Math.abs((sa.trades || 0) - (sb.trades || 0)) > 2) return false;
  const pfA = sa.profitFactor === 999 ? 100 : (sa.profitFactor || 0);
  const pfB = sb.profitFactor === 999 ? 100 : (sb.profitFactor || 0);
  if (Math.abs(pfA - pfB) > 0.4) return false;
  // Side must match if both have it
  if (sa.side && sb.side && sa.side !== sb.side) return false;
  return true;
}

/** Scoring: GA rules use compositeScore (WR×PF proxy), VERIFIED use netPnL */
function ruleScore(r: Rule): number {
  if (r.stats.netPnL !== undefined) return r.stats.netPnL;
  if (r.compositeScore) return r.compositeScore;
  // Fallback for GA rules without compositeScore: WR × PF × trades
  return (r.stats.winRate || 0) * (r.stats.profitFactor || 0);
}

/** Pick top N diverse rules, ensuring at least MIN_PER_SIDE per side */
function pickTopDiverse(rules: Rule[], n: number): Rule[] {
  const MIN_PER_SIDE = 3; // guarantee at least 3 LONG & 3 SHORT if available

  const sorted = [...rules].sort((a, b) => ruleScore(b) - ruleScore(a));

  // Separate by side
  const longs = sorted.filter((r) => (r.stats.side || r.config?.forceSide) === "LONG");
  const shorts = sorted.filter((r) => (r.stats.side || r.config?.forceSide) === "SHORT");
  const others = sorted.filter((r) => !(r.stats.side || r.config?.forceSide));

  // First: reserve MIN_PER_SIDE slots for each side (if available)
  const reserved: Rule[] = [];
  const addUnique = (r: Rule) => {
    if (!reserved.some((p) => isDuplicate(p, r))) { reserved.push(r); return true; }
    return false;
  };
  for (const r of longs) { if (reserved.filter((p) => (p.stats.side || p.config?.forceSide) === "LONG").length >= MIN_PER_SIDE) break; addUnique(r); }
  for (const r of shorts) { if (reserved.filter((p) => (p.stats.side || p.config?.forceSide) === "SHORT").length >= MIN_PER_SIDE) break; addUnique(r); }

  // Fill rest from global sorted order
  const picked = [...reserved];
  for (const r of sorted) {
    if (picked.length >= n) break;
    if (picked.some((p) => isDuplicate(p, r))) continue;
    if (reserved.includes(r)) continue;
    picked.push(r);
  }

  // Re-sort final list by score for clean ranking
  picked.sort((a, b) => ruleScore(b) - ruleScore(a));
  return picked.slice(0, n);
}

function main() {
  const beforeSize = statSync(PATH).size;
  const data = JSON.parse(readFileSync(PATH, "utf-8"));

  let beforeTotal = 0;
  let afterTotal = 0;

  for (const tfKey of Object.keys(data.tfs)) {
    const tf = data.tfs[tfKey];
    beforeTotal += tf.rules.length;

    // Trim + round
    const trimmed = pickTopDiverse(tf.rules, topN).map((r, i) => ({
      ...r,
      rank: i + 1,
      // Round all numbers in stats + config (smaller JSON)
      stats: roundDeep(r.stats, 2),
      config: roundDeep(r.config, 4),
      // Drop label (UI rebuilds it from config) and compositeScore (not used in UI)
      label: undefined,
      compositeScore: undefined,
    })).map((r) => {
      const { label, compositeScore, ...rest } = r;
      return rest;
    });

    tf.rules = trimmed;
    afterTotal += trimmed.length;

    console.log(`[${tfKey}] ${tf.rules.length} rules (was ${beforeTotal - (beforeTotal - tf.rules.length)})`);
  }

  // Compact write (no pretty print to save space)
  writeFileSync(PATH, JSON.stringify(data));
  const afterSize = statSync(PATH).size;

  console.log("");
  console.log(`✅ Trimmed ${beforeTotal} → ${afterTotal} rules`);
  console.log(`   Size: ${(beforeSize / 1024).toFixed(1)} KB → ${(afterSize / 1024).toFixed(1)} KB (${((1 - afterSize / beforeSize) * 100).toFixed(0)}% smaller)`);
}

main();
