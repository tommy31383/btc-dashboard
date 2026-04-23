/**
 * apply-flip.ts
 *
 * Apply kết quả flip-and-rescue vào hard_rules.json:
 *   - Rule gốc (loss>70%): set config.disabled = true (nếu chưa)
 *   - Append rule flipped mới với:
 *       source: "flipped-from-{tf}-rank{N}"
 *       config.forceSide = flipped side
 *       config.targetPct, config.stopPct = best combo
 *       stats.verified = true, stats.flippedAt
 *
 * Chỉ apply các rule flipStatus ∈ { FLIP_GOLD, FLIP_SILVER, FLIP_BRONZE }.
 * Dedupe bằng signature (tf+side+required+htf) — rule trùng config chỉ append 1 lần.
 *
 * Backup hard_rules.json trước.
 */

import { readFileSync, writeFileSync, copyFileSync } from "fs";
import { join } from "path";

const hardPath = join(__dirname, "..", "assets", "hard_rules.json");
const flipPath = join(__dirname, "..", "assets", "flip_rescue.json");

const ts = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = join(__dirname, "..", "assets", `hard_rules.backup-${ts}.json`);
copyFileSync(hardPath, backupPath);
console.log(`✅ Backup: ${backupPath}`);

const hard = JSON.parse(readFileSync(hardPath, "utf8"));
const flip = JSON.parse(readFileSync(flipPath, "utf8"));

const good = flip.results.filter((r: any) => ["FLIP_GOLD","FLIP_SILVER","FLIP_BRONZE"].includes(r.flipStatus));
console.log(`Flipped candidates: ${good.length}`);

// Dedupe theo signature
function sig(r: any): string {
  const req = [...(r.required||[])].sort().join(",") || "-";
  const htf = r.htfFilter || "-";
  return `${r.tfKey}|${r.flipSide}|${req}|${htf}|+${r.flipped.tp}/-${r.flipped.sl}`;
}
const seen = new Map<string, any>();
for (const r of good) {
  const s = sig(r);
  if (!seen.has(s) || seen.get(s).flipped.netPnL < r.flipped.netPnL) seen.set(s, r);
}
const unique = [...seen.values()];
console.log(`After dedupe: ${unique.length} unique flipped rules`);

const now = new Date().toISOString();
let disabledCount = 0, appendedCount = 0;

for (const r of unique) {
  const tfRules = hard.tfs[r.tfKey]?.rules;
  if (!tfRules) continue;

  // Disable rule gốc nếu chưa
  const origRule = tfRules.find((x: any) => x.rank === r.rank);
  if (origRule && origRule.config && !origRule.config.disabled) {
    origRule.config.disabled = true;
    origRule.stats = origRule.stats || {};
    origRule.stats.flippedAt = now;
    origRule.stats.flippedTo = { rank: null, side: r.flipSide, reason: "loss_gt_70_flipped" };
    disabledCount++;
  }

  // Append flipped rule
  let maxRank = tfRules.reduce((m: number, x: any) => Math.max(m, x.rank || 0), 0);
  maxRank++;
  const trades = r.flipped.trades;
  const wins = Math.round(trades * r.flipped.winRate / 100);
  const losses = trades - wins;

  // 2026-04-22 FIX: copy FULL config từ rule gốc (gồm candleReversalFilter, emaPosFilter,
  // minScore, stochOBLevel, rsiOBLevel, weights, ...) → chỉ override các field flip.
  // Flag invertedFromFlip trên candleReversalFilter + htfTrendFilter để replicate backtest semantic.
  const origCfg = origRule?.config || {};
  const newConfig: any = {
    ...origCfg,
    forceSide: r.flipSide,
    targetPct: r.flipped.tp,
    stopPct: r.flipped.sl,
    leverage: r.lev,
    maxHoldBars: r.maxHold,
    disabled: false,
  };
  // Remove stale flip-bookkeeping từ parent config (nếu có)
  delete newConfig.delegatedTo;
  delete newConfig.goldenId;
  // HTF filter: invertedFromFlip nếu có
  if (origCfg.htfTrendFilter) {
    const hf = typeof origCfg.htfTrendFilter === "string"
      ? { mode: origCfg.htfTrendFilter }
      : { ...origCfg.htfTrendFilter };
    hf.invertedFromFlip = true;
    newConfig.htfTrendFilter = hf;
  } else if (r.htfFilter) {
    newConfig.htfTrendFilter = { mode: r.htfFilter, invertedFromFlip: true };
  }
  // candleReversalFilter: invertedFromFlip vì useRuleAlerts tính want theo side
  if (origCfg.candleReversalFilter) {
    newConfig.candleReversalFilter = { ...origCfg.candleReversalFilter, invertedFromFlip: true };
  }

  tfRules.push({
    rank: maxRank,
    source: `flipped-from-${r.tfKey}-rank${r.rank}`,
    label: `[FLIPPED] ${r.origSide}→${r.flipSide} ${r.label}`,
    config: newConfig,
    stats: {
      side: r.flipSide,
      trades, wins, losses,
      winRate: r.flipped.winRate,
      netPnL: r.flipped.netPnL,
      profitFactor: r.flipped.pf,
      verified: true,
      source: "flip-grid-search-2.3Y-fullgrid",
      flippedFrom: { tfKey: r.tfKey, rank: r.rank, origSide: r.origSide, origWR: r.original.winRate },
      tier: r.flipStatus.replace("FLIP_",""),
      injectedAt: now,
    },
  });
  appendedCount++;
  if (r.flipSide) {
    hard.tfs[r.tfKey].rules = tfRules;
  }
  console.log(`  [${r.flipStatus.replace("FLIP_","")}] ${r.tfKey} rank${r.rank} ${r.origSide}→${r.flipSide}  WR ${r.original.winRate}%→${r.flipped.winRate}%  NET ${r.original.netPnL}%→${r.flipped.netPnL}%  combo +${r.flipped.tp}/-${r.flipped.sl}`);
}

hard.last_flipped_at = now;
hard.flip_summary = { candidates: good.length, uniqueCount: unique.length, disabled: disabledCount, appended: appendedCount, flippedAt: now };

writeFileSync(hardPath, JSON.stringify(hard, null, 2));
console.log(`\n=== Done ===`);
console.log(`  Rules disabled (gốc): ${disabledCount}`);
console.log(`  Rules appended (flipped): ${appendedCount}`);
console.log(`✅ Saved ${hardPath}`);
