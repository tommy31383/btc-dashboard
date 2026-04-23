/**
 * save-oos-and-rank.ts
 * 1. Save OOS results (đã chạy) vào stats.oos của 3 rule flipped active.
 * 2. Sort all ACTIVE rules (disabled=false, delegatedTo=undefined) theo WR + NET desc → in bảng.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const p = join(__dirname, "..", "assets", "hard_rules.json");
const h = JSON.parse(readFileSync(p, "utf8"));
const now = new Date().toISOString();

const OOS = [
  { tf:"4h", rank:10, oos:{ days:90, N:82,  WR:69.5, BE:76.9, edge:-7.4, PF:1.55, finalEquity:544,  maxDD:-637,  maxConsL:4 } },
  { tf:"1d", rank:9,  oos:{ days:90, N:1,   WR:100,  BE:50,   edge:50,   PF:999,  finalEquity:992,  maxDD:0,     maxConsL:0, note:"N=1, không đủ tin cậy" } },
  { tf:"1h", rank:41, oos:{ days:90, N:43,  WR:67.4, BE:87,   edge:-19.5,PF:1.09, finalEquity:6,    maxDD:-3228, maxConsL:3, note:"lev=100 rủi ro" } },
];

for (const u of OOS) {
  const r = h.tfs[u.tf].rules.find((x:any)=>x.rank===u.rank);
  if (r) { r.stats = r.stats || {}; r.stats.oos = u.oos; r.stats.oosTestedAt = now; }
}

writeFileSync(p, JSON.stringify(h, null, 2));
console.log(`✅ Saved OOS stats for ${OOS.length} rules\n`);

// Build flat list of ACTIVE rules
const rows: any[] = [];
for (const tf of Object.keys(h.tfs)) {
  for (const r of h.tfs[tf].rules) {
    const c = r.config || {}, s = r.stats || {};
    if (c.disabled) continue;
    if (c.delegatedTo) continue; // skip Goldens (feature-based, no comparable WR)
    rows.push({
      tf, rank: r.rank,
      side: c.forceSide || s.side || "?",
      tp: c.targetPct, sl: c.stopPct, lev: c.leverage || 10,
      WR: s.winRate ?? s.oos?.WR ?? 0,
      N: s.trades ?? 0,
      PF: s.profitFactor ?? 0,
      NET: s.netPnL ?? 0,
      source: r.source || "-",
      tier: s.tier || "-",
      oosWR: s.oos?.WR ?? null,
      oosN: s.oos?.N ?? null,
      maxDD: s.oos?.maxDD ?? null,
      consL: s.oos?.maxConsL ?? null,
    });
  }
}

// Sort by WR desc, then NET desc
const byWR = [...rows].sort((a,b)=> (b.WR - a.WR) || (b.NET - a.NET));
const byNET = [...rows].sort((a,b)=> (b.NET - a.NET) || (b.WR - a.WR));

function fmt(r:any): string {
  const oos = r.oosWR !== null ? `OOS ${r.oosWR}%/N${r.oosN}` : "-";
  const dd = r.maxDD !== null ? `DD${r.maxDD}%` : "-";
  const cl = r.consL !== null ? `L${r.consL}` : "-";
  return `${String(r.tf).padEnd(4)} r${String(r.rank).padStart(2)} ${String(r.side).padEnd(5)} +${r.tp}/-${r.sl} lv${r.lev}  WR=${String(r.WR).padStart(5)}%  N=${String(r.N).padStart(5)}  PF=${String(r.PF).padStart(5)}  NET=${String(r.NET).padStart(7)}%  ${oos} ${dd} ${cl}  [${r.tier}]  ${r.source}`;
}

console.log("\n╔═══ TOP 30 by WR (active rules, excl. Goldens) ═══");
byWR.slice(0,30).forEach((r,i)=> console.log(`${String(i+1).padStart(2)}. ${fmt(r)}`));

console.log("\n╔═══ TOP 30 by NET ═══");
byNET.slice(0,30).forEach((r,i)=> console.log(`${String(i+1).padStart(2)}. ${fmt(r)}`));

console.log(`\nTotal active rules (excl Goldens): ${rows.length}`);
