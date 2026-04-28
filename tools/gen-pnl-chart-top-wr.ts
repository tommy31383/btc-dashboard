/**
 * gen-pnl-chart-top-wr.ts (anh Tommy 2026-04-28)
 * Chart top WR picks + 5 current để compare.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

interface Run {
  preset: string; emoji: string; tpPct: number; slPct: number;
  stackMaxPerSide: number; netUsd: number; maxDrawdownUsd: number;
  maxDrawdownPct: number; winRate: number; profitFactor: number;
  total: number; equityCurve: number[];
}

const data = JSON.parse(readFileSync(join(__dirname, "..", "assets", "backtest_5mall_tpsl_grid_3y.json"), "utf8"));
const results: Run[] = data.results;

function findRun(preset: string, tp: number, sl: number): Run | undefined {
  return results.find((r) => r.preset === preset && r.tpPct === tp && r.slPct === sl);
}

// Top 10 by WR (filter NET>0) + 5 current
const top10ByWr = [...results].filter((r) => r.netUsd > 0).sort((a, b) => b.winRate - a.winRate).slice(0, 10);
const currents = [
  { p: "WHALE_MAX", tp: 5, sl: 2.5 },
  { p: "WHALE_MID", tp: 5, sl: 2.5 },
  { p: "TOMI_MAX", tp: 4, sl: 4 },
  { p: "TOMI_MID", tp: 4, sl: 4 },
  { p: "TOMI_MIN", tp: 4, sl: 4 },
];

const palette = ["#ff3838","#ff6b1a","#ffa500","#ffd700","#9acd32","#32cd32","#1e90ff","#4169e1","#9370db","#ba55d3"];

const picks: Array<{ run: Run; label: string; color: string; tag: string; isCurrent: boolean }> = [];
top10ByWr.forEach((r, i) => {
  picks.push({
    run: r,
    label: `${r.emoji} ${r.preset} ${r.tpPct}/${r.slPct}`,
    color: palette[i % palette.length],
    tag: `WR ${r.winRate.toFixed(1)}% · NET $${(r.netUsd / 1e6).toFixed(2)}M · DD ${r.maxDrawdownPct.toFixed(2)}%`,
    isCurrent: false,
  });
});
currents.forEach((c, i) => {
  const r = findRun(c.p, c.tp, c.sl);
  if (r) {
    picks.push({
      run: r,
      label: `${r.emoji} ${r.preset} ${r.tpPct}/${r.slPct} (CURRENT)`,
      color: ["#888","#aaa","#999","#bbb","#ccc"][i],
      tag: `WR ${r.winRate.toFixed(1)}% · NET $${(r.netUsd / 1e6).toFixed(2)}M · DD ${r.maxDrawdownPct.toFixed(2)}%`,
      isCurrent: true,
    });
  }
});

const W = 1400, H = 600;
const PAD_L = 80, PAD_R = 280, PAD_T = 40, PAD_B = 60;
const innerW = W - PAD_L - PAD_R;
const innerH = H - PAD_T - PAD_B;

const allCurves = picks.map((p) => p.run.equityCurve);
const yMin = Math.min(...allCurves.flat(), 5000);
const yMax = Math.max(...allCurves.flat());
const yMinLog = Math.log10(Math.max(1, yMin));
const yMaxLog = Math.log10(yMax);

function xOf(i: number, n: number): number { return PAD_L + (i / (n - 1)) * innerW; }
function yOfLog(v: number): number {
  const lv = Math.log10(Math.max(1, v));
  return PAD_T + innerH - ((lv - yMinLog) / (yMaxLog - yMinLog)) * innerH;
}
function yOfLin(v: number): number { return PAD_T + innerH - ((v - yMin) / (yMax - yMin)) * innerH; }

function genPolyline(curve: number[], yFn: (v: number) => number): string {
  return curve.map((v, i) => `${xOf(i, curve.length).toFixed(1)},${yFn(v).toFixed(1)}`).join(" ");
}

const xRange = data.range;
const fromStr = xRange.fromStr, toStr = xRange.toStr;

const yTicks: number[] = [];
const startTickLog = Math.ceil(yMinLog);
for (let lv = startTickLog; lv <= Math.floor(yMaxLog); lv++) yTicks.push(Math.pow(10, lv));
yTicks.push(yMax);

function chartSvg(yFn: (v: number) => number, title: string): string {
  const lines = picks.map((p) => {
    const opacity = p.isCurrent ? 0.5 : 0.95;
    const dash = p.isCurrent ? `stroke-dasharray="6,4"` : "";
    const sw = p.isCurrent ? "1.6" : "2.4";
    return `<polyline points="${genPolyline(p.run.equityCurve, yFn)}" fill="none" stroke="${p.color}" stroke-width="${sw}" opacity="${opacity}" ${dash} />`;
  }).join("\n");

  const yLabels = yTicks.map((t) => {
    const y = yFn(t);
    if (y < PAD_T - 5 || y > H - PAD_B + 5) return "";
    return `<line x1="${PAD_L}" y1="${y}" x2="${W - PAD_R}" y2="${y}" stroke="#2a2a40" stroke-width="0.4" stroke-dasharray="2,3" opacity="0.5" />
            <text x="${PAD_L - 8}" y="${y + 4}" text-anchor="end" fill="#888" font-size="11" font-family="monospace">${t >= 1e6 ? "$" + (t / 1e6).toFixed(1) + "M" : "$" + (t / 1e3).toFixed(0) + "k"}</text>`;
  }).join("\n");

  const xLabels = [
    `<text x="${PAD_L}" y="${H - PAD_B + 22}" fill="#888" font-size="11" font-family="monospace">${fromStr}</text>`,
    `<text x="${PAD_L + innerW / 2}" y="${H - PAD_B + 22}" text-anchor="middle" fill="#888" font-size="11" font-family="monospace">${new Date((xRange.from + xRange.to) / 2).toISOString().slice(0, 10)} (mid)</text>`,
    `<text x="${W - PAD_R}" y="${H - PAD_B + 22}" text-anchor="end" fill="#888" font-size="11" font-family="monospace">${toStr}</text>`,
  ].join("\n");

  const legend = picks.map((p, idx) => {
    const y = PAD_T + idx * 17;
    return `<g>
      <line x1="${W - PAD_R + 10}" y1="${y}" x2="${W - PAD_R + 30}" y2="${y}" stroke="${p.color}" stroke-width="3" ${p.isCurrent ? `stroke-dasharray="4,3"` : ""} opacity="${p.isCurrent ? 0.6 : 1}" />
      <text x="${W - PAD_R + 36}" y="${y + 4}" fill="#e8e8f0" font-size="10" font-family="monospace">${p.label}</text>
      <text x="${W - PAD_R + 36}" y="${y + 14}" fill="#888" font-size="8.5" font-family="monospace">${p.tag}</text>
    </g>`;
  }).join("\n");

  return `<svg width="${W}" height="${H + 30}" style="background:#0a0a1a">
    <text x="${W / 2}" y="22" text-anchor="middle" fill="#ffd700" font-size="14" font-family="-apple-system">${title}</text>
    <line x1="${PAD_L}" y1="${PAD_T}" x2="${PAD_L}" y2="${H - PAD_B}" stroke="#444" stroke-width="0.6"/>
    <line x1="${PAD_L}" y1="${H - PAD_B}" x2="${W - PAD_R}" y2="${H - PAD_B}" stroke="#444" stroke-width="0.6"/>
    ${yLabels}
    ${lines}
    ${xLabels}
    ${legend}
  </svg>`;
}

const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>5m ALL — TOP WR Equity Curves</title>
<style>
body { font-family: -apple-system, sans-serif; background: #0a0a1a; color: #e8e8f0; padding: 24px; max-width: 1500px; margin: 0 auto; }
h1 { color: #ffd700; }
h2 { color: #ffd700; margin-top: 32px; font-size: 16px; }
.meta { color: #888; margin-bottom: 24px; font-size: 13px; }
.note { color: #aaa; font-size: 12px; margin-top: 8px; padding: 12px; background: #11111e; border-left: 3px solid #ffd700; border-radius: 4px; }
.note b { color: #ffd700; }
table { width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 13px; }
th, td { border: 1px solid #2a2a40; padding: 8px 10px; text-align: right; }
th:first-child, td:first-child, th:nth-child(2), td:nth-child(2) { text-align: left; }
th { background: #1a1a2e; color: #ffd700; }
tr:nth-child(even) td { background: #11111e; }
.pos { color: #4ade80; font-weight: 600; }
.high { color: #4ade80; font-weight: 700; }
</style></head>
<body>
<h1>📈 5m ALL — TOP 10 by WIN RATE + 5 Current (3y backtest)</h1>
<div class="meta">
  Period: ${fromStr} → ${toStr} · Capital $5000 · Margin $30×100x · Fee 0.05%/side<br>
  Top 10 picks WR cao nhất (filter NET&gt;0) · 5 current production (đường <b>nét đứt</b>) để compare.
</div>

<h2>📊 LOG SCALE</h2>
${chartSvg(yOfLog, "TOP WR Equity Curves (log scale)")}

<h2>📊 LINEAR SCALE</h2>
${chartSvg(yOfLin, "TOP WR Equity Curves (linear scale)")}

<h2>📋 Bảng top 10 WR + current</h2>
<table>
<thead><tr>
  <th>PICK</th><th>STACK</th><th>TP/SL</th>
  <th>WR</th><th>NET $</th><th>MAX DD $</th><th>DD %</th><th>PF</th><th>TRADES</th>
</tr></thead>
<tbody>
${picks.map((p) => `<tr>
  <td><span style="color:${p.color};font-weight:700">●</span> ${p.label}</td>
  <td>${p.run.stackMaxPerSide}</td>
  <td>${p.run.tpPct}/${p.run.slPct}</td>
  <td class="${p.run.winRate >= 65 ? 'high' : ''}">${p.run.winRate.toFixed(1)}%</td>
  <td class="pos">$${p.run.netUsd.toLocaleString()}</td>
  <td>$${p.run.maxDrawdownUsd.toLocaleString()}</td>
  <td>${p.run.maxDrawdownPct.toFixed(2)}%</td>
  <td>${p.run.profitFactor}</td>
  <td>${p.run.total.toLocaleString()}</td>
</tr>`).join("\n")}
</tbody>
</table>

</body></html>`;

writeFileSync(join(__dirname, "..", "assets", "pnl_chart_top_wr_3y.html"), html);
console.log("✅ Chart written → assets/pnl_chart_top_wr_3y.html");
