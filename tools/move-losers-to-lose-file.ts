/**
 * move-losers-to-lose-file.ts
 *
 * Tách các rule disabled khỏi assets/hard_rules.json, lưu vào
 * assets/lose_rules.json (giữ rank gốc + tf để có thể restore).
 * hard_rules.json sau khi tách CHỈ còn rule active (NET PnL > 0).
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const HARD = join(__dirname, "..", "assets", "hard_rules.json");
const LOSE = join(__dirname, "..", "assets", "lose_rules.json");
const NOW = new Date().toISOString();

function main() {
  const hard = JSON.parse(readFileSync(HARD, "utf8"));
  const lose = existsSync(LOSE)
    ? JSON.parse(readFileSync(LOSE, "utf8"))
    : { generated_at: NOW, note: "Disabled rules archived from hard_rules.json", tfs: {} as any };

  let moved = 0;
  for (const tf of Object.keys(hard.tfs)) {
    const rules: any[] = hard.tfs[tf].rules || [];
    const keep: any[] = [];
    const drop: any[] = [];
    for (const r of rules) (r.disabled === true ? drop : keep).push(r);
    if (drop.length === 0) continue;

    hard.tfs[tf].rules = keep;
    if (!lose.tfs[tf]) lose.tfs[tf] = { rules: [] };
    for (const r of drop) {
      r.archivedAt = NOW;
      lose.tfs[tf].rules.push(r);
    }
    moved += drop.length;
    console.log(`  ${tf}: moved ${drop.length} (kept ${keep.length})`);
  }

  hard.generated_at = NOW;
  lose.generated_at = NOW;

  writeFileSync(HARD, JSON.stringify(hard, null, 2));
  writeFileSync(LOSE, JSON.stringify(lose, null, 2));
  console.log(`\nMoved ${moved} losers → assets/lose_rules.json`);
  console.log(`hard_rules.json now contains only active rules.`);
}
main();
