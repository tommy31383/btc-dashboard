/**
 * slim-flip-summary.ts — one-shot cleanup cho flip_summary trong hard_rules.json.
 * Thay mảng `unique` nặng bằng `uniqueCount`.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const p = join(__dirname, "..", "assets", "hard_rules.json");
const h = JSON.parse(readFileSync(p, "utf8"));
if (h.flip_summary && Array.isArray(h.flip_summary.unique)) {
  const n = h.flip_summary.unique.length;
  delete h.flip_summary.unique;
  h.flip_summary.uniqueCount = n;
  writeFileSync(p, JSON.stringify(h, null, 2));
  console.log(`✅ Slimmed flip_summary. uniqueCount=${n}`);
} else {
  console.log("⏭️  flip_summary already slim.");
}
