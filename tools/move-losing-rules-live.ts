/**
 * move-losing-rules-live.ts
 *
 * Anh Tommy v4.6.7: di chuyển rules losing trong live backtest 3y → file riêng.
 *
 * Read assets/live_backtest_3y.json (output từ backtest-live-rules.ts).
 * Identify rules có NET %lev < threshold (default 0).
 * Move khỏi hard_rules.json → assets/losers_live_3y.json (giữ original config + stats).
 * Backup hard_rules.json → hard_rules.json.bak trước khi sửa.
 *
 * Usage:
 *   npx tsx tools/move-losing-rules-live.ts                    # default threshold 0
 *   npx tsx tools/move-losing-rules-live.ts --threshold=-500   # NET < -500
 *   npx tsx tools/move-losing-rules-live.ts --dry              # dry run, không write
 *   npx tsx tools/move-losing-rules-live.ts --restore          # khôi phục từ losers_live_3y.json
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "fs";
import { join } from "path";

const args = process.argv.slice(2);
const THRESHOLD = parseFloat(args.find((a) => a.startsWith("--threshold="))?.replace("--threshold=", "") || "0");
const DRY = args.includes("--dry");
const RESTORE = args.includes("--restore");

const ROOT = join(__dirname, "..");
const HARD_PATH = join(ROOT, "assets", "hard_rules.json");
const HARD_BAK = HARD_PATH + ".bak";
const BACKTEST_PATH = join(ROOT, "assets", "live_backtest_3y.json");
const LOSERS_PATH = join(ROOT, "assets", "losers_live_3y.json");

interface LoserEntry {
  ruleId: string;
  tfKey: string;
  rank: number;
  movedAt: string;
  reason: string;
  /** Snapshot stats từ backtest live 3y khi move */
  liveBacktestStats: {
    netPctLev: number;
    winRate: number;
    trades: number;
    profitFactor: number;
    maxDrawdownPct: number;
    equityTrend: string;
  };
  /** Original rule entry từ hard_rules.json (full config + stats) — để restore dễ */
  rule: any;
}

interface LosersFile {
  version: 1;
  generatedAt: string;
  threshold: number;
  count: number;
  entries: LoserEntry[];
}

function fmt(n: number): string {
  return (n >= 0 ? "+" : "") + n.toFixed(0) + "%";
}

// ═════════ MOVE MODE ═════════════════════════════════════════════════════
function move() {
  if (!existsSync(BACKTEST_PATH)) {
    console.error(`❌ Không tìm thấy ${BACKTEST_PATH}. Chạy backtest-live-rules.ts trước.`);
    process.exit(1);
  }
  if (!existsSync(HARD_PATH)) {
    console.error(`❌ Không tìm thấy ${HARD_PATH}.`);
    process.exit(1);
  }

  const backtest = JSON.parse(readFileSync(BACKTEST_PATH, "utf8"));
  const hard = JSON.parse(readFileSync(HARD_PATH, "utf8"));

  // Load existing losers (nếu có) — append
  let existingLosers: LosersFile = { version: 1, generatedAt: new Date().toISOString(), threshold: THRESHOLD, count: 0, entries: [] };
  if (existsSync(LOSERS_PATH)) {
    try { existingLosers = JSON.parse(readFileSync(LOSERS_PATH, "utf8")); } catch {}
  }
  const alreadyMovedIds = new Set(existingLosers.entries.map((e) => e.ruleId));

  // Filter losing rules từ SOLO mode
  const losing = (backtest.solo || []).filter((r: any) => r.netPctLev < THRESHOLD);
  console.log(`Threshold: NET < ${THRESHOLD}%`);
  console.log(`Losing rules from backtest: ${losing.length}`);

  // Backup hard_rules
  if (!DRY && !existsSync(HARD_BAK)) {
    copyFileSync(HARD_PATH, HARD_BAK);
    console.log(`💾 Backup: ${HARD_BAK}`);
  } else if (!DRY) {
    // Already exists — overwrite with current state
    copyFileSync(HARD_PATH, HARD_BAK);
    console.log(`💾 Backup overwritten: ${HARD_BAK}`);
  }

  const movedEntries: LoserEntry[] = [];
  let actuallyMoved = 0;
  let skippedAlreadyMoved = 0;

  for (const lr of losing) {
    const ruleId: string = lr.ruleId;
    const [tfKey, rankStr] = ruleId.split(":");
    const rank = parseInt(rankStr, 10);

    if (alreadyMovedIds.has(ruleId)) {
      skippedAlreadyMoved++;
      continue;
    }

    // Find rule in hard_rules
    const tfBucket = hard.tfs?.[tfKey];
    if (!tfBucket?.rules) {
      console.log(`  ⚠️  Skip ${ruleId}: tf bucket missing`);
      continue;
    }
    const idx = tfBucket.rules.findIndex((r: any) => r.rank === rank);
    if (idx < 0) {
      console.log(`  ⚠️  Skip ${ruleId}: rank not found in hard_rules`);
      continue;
    }
    const rule = tfBucket.rules[idx];

    movedEntries.push({
      ruleId,
      tfKey,
      rank,
      movedAt: new Date().toISOString(),
      reason: `live-backtest-3y NET ${fmt(lr.netPctLev)} WR ${lr.winRate.toFixed(1)}% ${lr.trades}T trend ${lr.equityTrend}`,
      liveBacktestStats: {
        netPctLev: lr.netPctLev,
        winRate: lr.winRate,
        trades: lr.trades,
        profitFactor: lr.profitFactor,
        maxDrawdownPct: lr.maxDrawdownPct,
        equityTrend: lr.equityTrend,
      },
      rule,
    });
    if (!DRY) tfBucket.rules.splice(idx, 1);
    actuallyMoved++;
    console.log(`  ✓ Move ${ruleId} ${(lr.side || "?").padEnd(5)} NET ${fmt(lr.netPctLev).padStart(8)} WR ${lr.winRate.toFixed(1).padStart(5)}% ${String(lr.trades).padStart(4)}T`);
  }

  console.log("");
  console.log(`Moved: ${actuallyMoved} rules`);
  if (skippedAlreadyMoved > 0) console.log(`Already in losers file (skip): ${skippedAlreadyMoved}`);

  if (DRY) {
    console.log(`\n🚧 DRY RUN — no files written. Remove --dry to apply.`);
    return;
  }
  if (actuallyMoved === 0) {
    console.log(`\n→ Không có rule nào để move.`);
    return;
  }

  // Append to losers file
  existingLosers.entries.push(...movedEntries);
  existingLosers.count = existingLosers.entries.length;
  existingLosers.generatedAt = new Date().toISOString();
  existingLosers.threshold = THRESHOLD;
  writeFileSync(LOSERS_PATH, JSON.stringify(existingLosers, null, 2));
  console.log(`💾 Wrote losers: ${LOSERS_PATH} (total ${existingLosers.count} entries)`);

  // Write back hard_rules
  writeFileSync(HARD_PATH, JSON.stringify(hard, null, 2));
  console.log(`💾 Updated: ${HARD_PATH}`);
  console.log(`\n→ Để khôi phục: npx tsx tools/move-losing-rules-live.ts --restore`);
}

// ═════════ RESTORE MODE ═════════════════════════════════════════════════
function restore() {
  if (!existsSync(LOSERS_PATH)) {
    console.error(`❌ Không tìm thấy ${LOSERS_PATH} để restore.`);
    process.exit(1);
  }
  const losers: LosersFile = JSON.parse(readFileSync(LOSERS_PATH, "utf8"));
  if (losers.entries.length === 0) {
    console.log(`Losers file rỗng, không có gì restore.`);
    return;
  }
  const hard = JSON.parse(readFileSync(HARD_PATH, "utf8"));

  if (!DRY) {
    copyFileSync(HARD_PATH, HARD_BAK);
    console.log(`💾 Backup: ${HARD_BAK}`);
  }

  let restored = 0, skippedExist = 0;
  for (const entry of losers.entries) {
    const tfBucket = hard.tfs?.[entry.tfKey];
    if (!tfBucket) continue;
    if (!tfBucket.rules) tfBucket.rules = [];
    if (tfBucket.rules.some((r: any) => r.rank === entry.rank)) {
      console.log(`  ⚠️ ${entry.ruleId} đã có trong hard_rules (skip)`);
      skippedExist++;
      continue;
    }
    if (!DRY) tfBucket.rules.push(entry.rule);
    restored++;
    console.log(`  ↩ Restore ${entry.ruleId}`);
  }

  console.log(`\nRestored: ${restored}, Skipped (exists): ${skippedExist}`);
  if (DRY) {
    console.log(`🚧 DRY RUN — no files written.`);
    return;
  }
  if (restored > 0) {
    writeFileSync(HARD_PATH, JSON.stringify(hard, null, 2));
    // Clear losers file (đã restore hết)
    writeFileSync(LOSERS_PATH, JSON.stringify({ ...losers, entries: [], count: 0, generatedAt: new Date().toISOString() }, null, 2));
    console.log(`💾 Updated: ${HARD_PATH}`);
    console.log(`💾 Cleared: ${LOSERS_PATH}`);
  }
}

// ═════════ MAIN ═════════════════════════════════════════════════════════
console.log(`=== ${RESTORE ? "RESTORE" : "MOVE"} losing rules from live backtest 3y ===\n`);
if (RESTORE) restore();
else move();
