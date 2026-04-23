/**
 * dedupe-and-rank.ts
 *
 * Input:
 *   - assets/rules_verification.json (fresh WR của 81 hard_rules)
 *   - 11 Goldens hard-coded từ useRiskRadar.ts (đã forward test 2.3Y)
 *
 * Output:
 *   - assets/all_rules_ranked.json
 *   - assets/all_rules_ranked_preview.html
 *
 * Logic:
 *   - Signature hard_rules = tf|side|htfFilter|[sorted required]|TPxSL|reversal|emaPos
 *     (không tính leverage — rule dup theo logic, khác lev = variant)
 *   - Signature Goldens = tf|side|htfState|[sorted features]  (features khác
 *     requiredConditions của hard_rules nên không overlap trực tiếp)
 *   - Duplicate nhóm nội bộ hard_rules (nhiều rule config giống nhau, khác lev)
 *   - Rank all theo WR (filter N >= 30)
 *   - Verdict: GOLD (WR>=60 & N>=50), SILVER (WR>=50 & N>=30), BRONZE (WR>=40),
 *     JUNK (<40 hoặc N<30)
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

interface HardRuleResult {
  tfKey: string;
  rank: number;
  label: string;
  side: "LONG" | "SHORT";
  config: {
    tpPct: number;
    slPct: number;
    lev: number;
    maxHold: number;
    required: string[];
    minScore: number;
    htfFilter: string | null;
    reversal: boolean;
    emaPosFilter: string | null;
  };
  fresh: { trades: number; wins: number; losses: number; timeouts: number; winRate: number; netPnL: number; avgHold: number };
  saved: { trades: number | null; winRate: number | null; netPnL: number | null };
  drift: { netPct: number | null; wrPct: number | null };
  verdict: string;
}

interface GoldenDef {
  id: string;
  title: string;
  side: "LONG" | "SHORT";
  tf: string;
  htf: string;
  features: string[];
  wr: number;
  n: number;
  pf: number | null;
  tpPct: number;
  slPct: number;
}

// 11 Goldens từ useRiskRadar.ts (forward test 2.3Y đã verify)
const GOLDENS: GoldenDef[] = [
  { id: "golden_long_quadruple",        title: "LONG QUADRUPLE MEGA",          side: "LONG",  tf: "1h", htf: "FLAT", features: ["macdBull", "emaNear", "atrLow"],            wr: 71.8, n: 163, pf: 4.69, tpPct: 5, slPct: 2 },
  { id: "golden_long_macd_flat",        title: "LONG TRIPLE MACD+EMA+FLAT",     side: "LONG",  tf: "1h", htf: "FLAT", features: ["macdBull", "emaNear"],                      wr: 64.9, n: 405, pf: 3.90, tpPct: 5, slPct: 2 },
  { id: "golden_long_macd_atr_flat",    title: "LONG TRIPLE MACD+ATR+FLAT",     side: "LONG",  tf: "1h", htf: "FLAT", features: ["macdBull", "atrLow"],                       wr: 67.4, n: 181, pf: 3.82, tpPct: 5, slPct: 2 },
  { id: "golden_long_atr_ema_flat",     title: "LONG SILENT + CENTER",          side: "LONG",  tf: "1h", htf: "FLAT", features: ["atrLow", "emaNear"],                        wr: 60.4, n: 323, pf: 2.59, tpPct: 5, slPct: 2 },
  { id: "golden_long_atr_flat",         title: "LONG 1H SILENT",                side: "LONG",  tf: "1h", htf: "FLAT", features: ["atrLow"],                                   wr: 81.0, n: 84,  pf: null, tpPct: 5, slPct: 2 },
  { id: "golden_long_cross_silent",     title: "LONG EMA CROSS BULL + SILENT",  side: "LONG",  tf: "1h", htf: "FLAT", features: ["emaCrossBull", "atrLow"],                   wr: 68.3, n: 104, pf: 3.44, tpPct: 5, slPct: 2 },
  { id: "golden_long_doji_macd",        title: "LONG DOJI + MACD BULL",         side: "LONG",  tf: "1h", htf: "FLAT", features: ["bodySmall", "macdBull"],                    wr: 63.7, n: 259, pf: 3.64, tpPct: 5, slPct: 2 },
  { id: "golden_long_bb_squeeze",       title: "LONG BB SQUEEZE + MACD BULL",   side: "LONG",  tf: "1h", htf: "FLAT", features: ["bbSqueeze", "macdBull"],                    wr: 62.3, n: 369, pf: 3.50, tpPct: 5, slPct: 2 },
  { id: "golden_short_quadruple",       title: "SHORT QUADRUPLE DOWN",          side: "SHORT", tf: "1h", htf: "DOWN", features: ["emaCrossBear", "atrLow", "macdBear"],       wr: 69.6, n: 46,  pf: 4.53, tpPct: 5, slPct: 2 },
  { id: "golden_short_cross_silent",    title: "SHORT EMA CROSS BEAR + SILENT", side: "SHORT", tf: "1h", htf: "DOWN", features: ["emaCrossBear", "atrLow"],                   wr: 64.9, n: 174, pf: 3.37, tpPct: 5, slPct: 2 },
  { id: "golden_short_macd_silent",     title: "SHORT MACD BEAR + SILENT",      side: "SHORT", tf: "1h", htf: "DOWN", features: ["macdBear", "atrLow"],                       wr: 62.9, n: 62,  pf: 3.27, tpPct: 5, slPct: 2 },
];

function hardRuleSig(r: HardRuleResult): string {
  const req = [...r.config.required].sort().join(",") || "-";
  const htf = r.config.htfFilter || "-";
  const rev = r.config.reversal ? "R" : "-";
  const ema = r.config.emaPosFilter || "-";
  return `${r.tfKey}|${r.side}|${htf}|${req}|${rev}|${ema}|TP${r.config.tpPct}/SL${r.config.slPct}`;
}

function classifyHard(r: HardRuleResult): "GOLD" | "SILVER" | "BRONZE" | "JUNK" | "DEAD" {
  const wr = r.fresh.winRate;
  const n = r.fresh.trades;
  if (n < 30) return "DEAD";
  if (wr >= 60 && n >= 50) return "GOLD";
  if (wr >= 50) return "SILVER";
  if (wr >= 40) return "BRONZE";
  return "JUNK";
}

function classifyGolden(g: GoldenDef): "GOLD" | "SILVER" | "BRONZE" {
  if (g.wr >= 60 && g.n >= 50) return "GOLD";
  if (g.wr >= 50) return "SILVER";
  return "BRONZE";
}

function run() {
  const verPath = join(__dirname, "..", "assets", "rules_verification.json");
  const ver = JSON.parse(readFileSync(verPath, "utf8"));
  const rules: HardRuleResult[] = ver.results;

  // Group hard rules by signature
  const sigGroups = new Map<string, HardRuleResult[]>();
  for (const r of rules) {
    const sig = hardRuleSig(r);
    if (!sigGroups.has(sig)) sigGroups.set(sig, []);
    sigGroups.get(sig)!.push(r);
  }

  // Mark duplicates (pick best by netPnL as canonical)
  const dupMap = new Map<string, { canonical: HardRuleResult; dupes: HardRuleResult[] }>();
  for (const [sig, grp] of sigGroups) {
    if (grp.length > 1) {
      const sorted = [...grp].sort((a, b) => b.fresh.netPnL - a.fresh.netPnL);
      dupMap.set(sig, { canonical: sorted[0], dupes: sorted.slice(1) });
    }
  }

  // Flatten enriched
  const hardEnriched = rules.map((r) => {
    const sig = hardRuleSig(r);
    const grp = sigGroups.get(sig)!;
    const isDup = grp.length > 1;
    const isCanonical = isDup && dupMap.get(sig)!.canonical === r;
    return {
      source: "hard_rules" as const,
      sig,
      isDup,
      isCanonical,
      dupCount: grp.length,
      tier: classifyHard(r),
      ...r,
    };
  });

  // Goldens (no dup detection internal vs hard_rules — different feature space)
  const goldensEnriched = GOLDENS.map((g) => ({
    source: "useRiskRadar" as const,
    sig: `${g.tf}|${g.side}|${g.htf}|${[...g.features].sort().join(",")}|-|-|TP${g.tpPct}/SL${g.slPct}`,
    isDup: false,
    isCanonical: true,
    dupCount: 1,
    tier: classifyGolden(g),
    tfKey: g.tf,
    rank: 0,
    label: g.title,
    side: g.side,
    config: {
      tpPct: g.tpPct,
      slPct: g.slPct,
      lev: 10,
      maxHold: 100,
      required: g.features,
      minScore: g.features.length,
      htfFilter: g.htf,
      reversal: false,
      emaPosFilter: null,
    },
    fresh: {
      trades: g.n,
      wins: Math.round(g.n * g.wr / 100),
      losses: g.n - Math.round(g.n * g.wr / 100),
      timeouts: 0,
      winRate: g.wr,
      netPnL: Math.round((g.n * g.wr / 100) * g.tpPct * 10 - (g.n * (1 - g.wr / 100)) * g.slPct * 10),
      avgHold: 0,
    },
    saved: { trades: null, winRate: null, netPnL: null },
    drift: { netPct: null, wrPct: null },
    verdict: "GOLDEN_VERIFIED",
    goldenId: g.id,
    pf: g.pf,
  }));

  // Combined + ranked by WR (N >= 30)
  const combined = [...hardEnriched, ...goldensEnriched];
  const ranked = [...combined].sort((a, b) => {
    // Primary: tier rank
    const tierScore: Record<string, number> = { GOLD: 4, SILVER: 3, BRONZE: 2, JUNK: 1, DEAD: 0 };
    const ta = tierScore[a.tier] ?? 0;
    const tb = tierScore[b.tier] ?? 0;
    if (ta !== tb) return tb - ta;
    return b.fresh.winRate - a.fresh.winRate;
  });

  // Summary
  const tierCount: Record<string, number> = {};
  for (const r of ranked) tierCount[r.tier] = (tierCount[r.tier] || 0) + 1;

  const dupGroups = Array.from(dupMap.values()).map((x) => ({
    sig: hardRuleSig(x.canonical),
    canonical: { tf: x.canonical.tfKey, rank: x.canonical.rank, label: x.canonical.label, lev: x.canonical.config.lev, wr: x.canonical.fresh.winRate, net: x.canonical.fresh.netPnL },
    dupes: x.dupes.map((d) => ({ tf: d.tfKey, rank: d.rank, label: d.label, lev: d.config.lev, wr: d.fresh.winRate, net: d.fresh.netPnL })),
  }));

  const out = {
    generatedAt: new Date().toISOString(),
    summary: {
      totalHardRules: rules.length,
      totalGoldens: GOLDENS.length,
      tierCount,
      duplicateGroups: dupGroups.length,
      totalDuplicateRules: Array.from(dupMap.values()).reduce((s, g) => s + g.dupes.length, 0),
    },
    dupGroups,
    ranked,
  };

  const outPath = join(__dirname, "..", "assets", "all_rules_ranked.json");
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`✅ Wrote ${outPath}`);
  console.log(`\nSummary: ${JSON.stringify(tierCount)}`);
  console.log(`Duplicate groups: ${dupGroups.length} (${out.summary.totalDuplicateRules} dup rules)`);

  // HTML preview
  const html = renderHTML(out);
  const htmlPath = join(__dirname, "..", "assets", "all_rules_ranked_preview.html");
  writeFileSync(htmlPath, html);
  console.log(`✅ Wrote ${htmlPath}`);
}

function renderHTML(data: any): string {
  const tierColor: Record<string, string> = {
    GOLD: "#F4B860", SILVER: "#C0C0C0", BRONZE: "#CD7F32", JUNK: "#666", DEAD: "#333",
  };
  const rows = data.ranked.map((r: any, i: number) => {
    const tc = tierColor[r.tier] || "#555";
    const srcBadge = r.source === "useRiskRadar"
      ? `<span style="background:#F4B860;color:#000;padding:2px 6px;border-radius:2px;font-size:10px;font-weight:700;">GOLDEN</span>`
      : `<span style="background:#353534;color:#aaa;padding:2px 6px;border-radius:2px;font-size:10px;">hard_rules</span>`;
    const dupBadge = r.isDup
      ? (r.isCanonical
          ? `<span style="background:#444;color:#F4B860;padding:1px 5px;border-radius:2px;font-size:9px;" title="Canonical of ${r.dupCount} duplicates">★${r.dupCount}</span>`
          : `<span style="background:#4a2222;color:#ff9999;padding:1px 5px;border-radius:2px;font-size:9px;" title="Duplicate">DUP</span>`)
      : "";
    const wr = r.fresh.winRate.toFixed(1);
    const conds = r.config.required.join("+") || "(any)";
    const htf = r.config.htfFilter || "-";
    const pfStr = r.pf ? ` · PF ${r.pf.toFixed(2)}` : "";
    return `
      <tr style="border-bottom:1px solid #2a2a2a;${r.isDup && !r.isCanonical ? "opacity:0.45;" : ""}">
        <td style="padding:8px;color:#888;font-family:monospace;font-size:11px;">${i + 1}</td>
        <td style="padding:8px;"><span style="background:${tc};color:#000;padding:3px 8px;border-radius:2px;font-size:10px;font-weight:800;letter-spacing:1px;">${r.tier}</span></td>
        <td style="padding:8px;">${srcBadge} ${dupBadge}</td>
        <td style="padding:8px;font-family:monospace;font-size:11px;color:#ddd;">${r.tfKey}</td>
        <td style="padding:8px;font-weight:700;color:${r.side === "LONG" ? "#4ade80" : "#f87171"};">${r.side}</td>
        <td style="padding:8px;color:#F4B860;font-family:monospace;font-size:11px;">${htf}</td>
        <td style="padding:8px;color:#eee;font-size:12px;max-width:320px;">${r.label}</td>
        <td style="padding:8px;color:#bbb;font-family:monospace;font-size:10px;">${conds}</td>
        <td style="padding:8px;color:#888;font-family:monospace;font-size:11px;">+${r.config.tpPct}/-${r.config.slPct}</td>
        <td style="padding:8px;text-align:right;font-family:monospace;font-weight:700;color:${Number(wr) >= 60 ? "#4ade80" : Number(wr) >= 50 ? "#fbbf24" : "#ef4444"};">${wr}%${pfStr}</td>
        <td style="padding:8px;text-align:right;font-family:monospace;color:#ccc;">${r.fresh.trades}</td>
        <td style="padding:8px;text-align:right;font-family:monospace;color:${r.fresh.netPnL >= 0 ? "#4ade80" : "#ef4444"};">${r.fresh.netPnL >= 0 ? "+" : ""}${r.fresh.netPnL}%</td>
      </tr>`;
  }).join("");

  const dupSection = data.dupGroups.length === 0 ? "" : `
    <h2 style="color:#F4B860;margin-top:32px;">🔁 Duplicate Groups (${data.dupGroups.length})</h2>
    <p style="color:#888;font-size:12px;">Rule trùng config logic (chỉ khác leverage). Canonical = variant có netPnL cao nhất. Dupes nên xóa.</p>
    <div style="display:flex;flex-direction:column;gap:12px;">
    ${data.dupGroups.map((g: any) => `
      <div style="background:#1c1b1b;border-left:3px solid #F4B860;padding:12px;border-radius:2px;">
        <div style="font-family:monospace;font-size:11px;color:#888;margin-bottom:6px;">${g.sig}</div>
        <div style="color:#F4B860;font-weight:700;">★ ${g.canonical.tf}#${g.canonical.rank} ${g.canonical.label} · lev ${g.canonical.lev}x · WR ${g.canonical.wr}% · NET ${g.canonical.net}%</div>
        ${g.dupes.map((d: any) => `<div style="color:#666;margin-top:3px;padding-left:12px;">✕ ${d.tf}#${d.rank} ${d.label} · lev ${d.lev}x · WR ${d.wr}% · NET ${d.net}%</div>`).join("")}
      </div>
    `).join("")}
    </div>
  `;

  const sumItems = Object.entries(data.summary.tierCount).map(([k, v]) =>
    `<span style="background:${tierColor[k]||"#555"};color:#000;padding:4px 10px;border-radius:2px;font-weight:800;font-size:11px;letter-spacing:1px;">${k}: ${v}</span>`
  ).join(" ");

  return `<!DOCTYPE html>
<html lang="vi"><head>
<meta charset="UTF-8">
<title>All Rules Ranked — v4.3.20</title>
<style>
  body { background:#121212; color:#eee; font-family:'Space Grotesk',system-ui,sans-serif; margin:0; padding:24px; }
  h1 { color:#F4B860; font-weight:800; letter-spacing:2px; margin:0 0 4px; }
  .sub { color:#888; font-size:13px; margin-bottom:20px; }
  table { width:100%; border-collapse:collapse; background:#1c1b1b; border-radius:4px; overflow:hidden; }
  thead { background:#2a2a2a; }
  thead th { padding:10px 8px; text-align:left; color:#F4B860; font-size:11px; letter-spacing:1.5px; text-transform:uppercase; font-weight:700; }
  tbody tr:hover { background:#242323; }
  h2 { color:#F4B860; font-size:18px; font-weight:700; letter-spacing:1.5px; }
</style>
</head><body>
  <h1>ALL RULES RANKED — BTC Dashboard v4.3.20</h1>
  <div class="sub">Generated ${new Date(data.generatedAt).toLocaleString("vi-VN")} · Forward test 20K candles (~2.3Y) · Fresh Binance data</div>
  <div style="margin-bottom:24px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
    <span style="color:#888;font-size:12px;margin-right:8px;">TIERS:</span>
    ${sumItems}
    <span style="color:#888;font-size:12px;margin-left:16px;">Hard rules: <strong style="color:#eee;">${data.summary.totalHardRules}</strong> · Goldens: <strong style="color:#F4B860;">${data.summary.totalGoldens}</strong> · Duplicates: <strong style="color:#ef4444;">${data.summary.totalDuplicateRules}</strong> in ${data.summary.duplicateGroups} groups</span>
  </div>

  ${dupSection}

  <h2 style="margin-top:32px;">📊 Full Ranking (sorted by Tier → WR)</h2>
  <p style="color:#888;font-size:12px;">Tier rules: <strong>GOLD</strong> = WR≥60% & N≥50. <strong>SILVER</strong> = WR≥50%. <strong>BRONZE</strong> = WR≥40%. <strong>JUNK</strong> = WR&lt;40%. <strong>DEAD</strong> = N&lt;30.</p>
  <table>
    <thead><tr>
      <th>#</th><th>TIER</th><th>SRC</th><th>TF</th><th>SIDE</th><th>HTF</th><th>LABEL</th><th>CONDITIONS</th><th>TP/SL</th><th style="text-align:right;">WR</th><th style="text-align:right;">N</th><th style="text-align:right;">NET</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <div style="margin-top:32px;color:#666;font-size:11px;text-align:center;">
    btc-dashboard v4.3.20 · forward-test 2.3Y · Tommy's quant stack
  </div>
</body></html>`;
}

run();
