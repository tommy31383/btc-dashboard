/**
 * gen-pnl-chart-tpsl.ts (anh Tommy 2026-04-28)
 * Render HTML chart PnL từ backtest_5mall_tpsl_grid_3y.json — overlay top picks.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

interface Run {
  preset: string;
  emoji: string;
  tpPct: number;
  slPct: number;
  stackMaxPerSide: number;
  netUsd: number;
  maxDrawdownUsd: number;
  maxDrawdownPct: number;
  winRate: number;
  profitFactor: number;
  total: number;
  equityCurve: number[];
}

const data = JSON.parse(readFileSync(join(__dirname, "..", "assets", "backtest_5mall_tpsl_grid_3y.json"), "utf8"));
const results: Run[] = data.results;

// 12 PICKS để overlay — phủ đủ profile rủi ro
function findRun(preset: string, tp: number, sl: number): Run | undefined {
  return results.find((r) => r.preset === preset && r.tpPct === tp && r.slPct === sl);
}

const picks: Array<{ run: Run; label: string; color: string; tag: string }> = [
  // ─── 4 max NET (yolo zone) ──
  { run: findRun("WHALE_MAX", 5, 6)!, label: "WHALE_MAX 5/6 (TOP NET)", color: "#ff3838", tag: "🏆 max NET $4.15M" },
  { run: findRun("WHALE_MAX", 6, 6)!, label: "WHALE_MAX 6/6", color: "#ff7f50", tag: "DD<1% $4.09M" },
  { run: findRun("WHALE_MAX", 8, 8)!, label: "WHALE_MAX 8/8", color: "#ffa07a", tag: "DD 0.1% $3.65M" },
  { run: findRun("WHALE_MAX", 5, 2.5)!, label: "WHALE_MAX 5/2.5 (CURRENT)", color: "#dc143c", tag: "current $3.03M" },
  // ─── TOMI_MAX 200 ──
  { run: findRun("TOMI_MAX", 5, 8)!, label: "TOMI_MAX 5/8", color: "#1e90ff", tag: "best TOMI $3.17M" },
  { run: findRun("TOMI_MAX", 8, 8)!, label: "TOMI_MAX 8/8", color: "#4169e1", tag: "min DD $3.09M" },
  { run: findRun("TOMI_MAX", 4, 4)!, label: "TOMI_MAX 4/4 (CURRENT)", color: "#0066cc", tag: "current $2.63M" },
  // ─── WHALE_MID 100 ──
  { run: findRun("WHALE_MID", 6, 6)!, label: "WHALE_MID 6/6", color: "#ff8c00", tag: "best $2.31M" },
  { run: findRun("WHALE_MID", 5, 2.5)!, label: "WHALE_MID 5/2.5 (CURRENT)", color: "#cd853f", tag: "current $1.89M" },
  // ─── TOMI_MID 100 ──
  { run: findRun("TOMI_MID", 5, 6)!, label: "TOMI_MID 5/6", color: "#32cd32", tag: "best $2.03M" },
  { run: findRun("TOMI_MID", 4, 4)!, label: "TOMI_MID 4/4 (CURRENT)", color: "#228b22", tag: "current $1.87M" },
  // ─── TOMI_MIN 50 (cực bảo thủ) ──
  { run: findRun("TOMI_MIN", 8, 8)!, label: "TOMI_MIN 8/8", color: "#dcdcdc", tag: "min DD $0.99M" },
  { run: findRun("TOMI_MIN", 4, 4)!, label: "TOMI_MIN 4/4 (CURRENT)", color: "#a9a9a9", tag: "current $1.17M" },
];

const W = 1400;
const H = 600;
const PAD_L = 80;
const PAD_R = 220;
const PAD_T = 40;
const PAD_B = 60;
const innerW = W - PAD_L - PAD_R;
const innerH = H - PAD_T - PAD_B;

// Y range — log scale vì NET range $1M-$4M
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
const fromStr = xRange.fromStr;
const toStr = xRange.toStr;

// Y ticks (log scale)
const yTicks: number[] = [];
const startTickLog = Math.ceil(yMinLog);
for (let lv = startTickLog; lv <= Math.floor(yMaxLog); lv++) yTicks.push(Math.pow(10, lv));
yTicks.push(yMax); // top tick

function chartSvg(yFn: (v: number) => number, title: string, isLog: boolean): string {
  const lines = picks.map((p, idx) => {
    const opacity = p.label.includes("CURRENT") ? 0.6 : 0.95;
    const dash = p.label.includes("CURRENT") ? `stroke-dasharray="6,4"` : "";
    const points = genPolyline(p.run.equityCurve, yFn);
    return `<polyline points="${points}" fill="none" stroke="${p.color}" stroke-width="2.2" opacity="${opacity}" ${dash} />`;
  }).join("\n");

  const yLabels = yTicks.map((t) => {
    const y = yFn(t);
    if (y < PAD_T - 5 || y > H - PAD_B + 5) return "";
    return `<line x1="${PAD_L}" y1="${y}" x2="${W - PAD_R}" y2="${y}" stroke="#2a2a40" stroke-width="0.4" stroke-dasharray="2,3" opacity="0.5" />
            <text x="${PAD_L - 8}" y="${y + 4}" text-anchor="end" fill="#888" font-size="11" font-family="monospace">${t >= 1e6 ? "$" + (t / 1e6).toFixed(1) + "M" : "$" + (t / 1e3).toFixed(0) + "k"}</text>`;
  }).join("\n");

  // X labels — date breakpoints (start, mid, end)
  const xLabels = [
    `<text x="${PAD_L}" y="${H - PAD_B + 22}" fill="#888" font-size="11" font-family="monospace">${fromStr}</text>`,
    `<text x="${PAD_L + innerW / 2}" y="${H - PAD_B + 22}" text-anchor="middle" fill="#888" font-size="11" font-family="monospace">${new Date((xRange.from + xRange.to) / 2).toISOString().slice(0, 10)} (mid)</text>`,
    `<text x="${W - PAD_R}" y="${H - PAD_B + 22}" text-anchor="end" fill="#888" font-size="11" font-family="monospace">${toStr}</text>`,
  ].join("\n");

  const legend = picks.map((p, idx) => {
    const y = PAD_T + idx * 18;
    return `<g>
      <line x1="${W - PAD_R + 10}" y1="${y}" x2="${W - PAD_R + 30}" y2="${y}" stroke="${p.color}" stroke-width="3" ${p.label.includes("CURRENT") ? `stroke-dasharray="4,3"` : ""} />
      <text x="${W - PAD_R + 36}" y="${y + 4}" fill="#e8e8f0" font-size="11" font-family="monospace">${p.label}</text>
      <text x="${W - PAD_R + 36}" y="${y + 16}" fill="#888" font-size="9" font-family="monospace">${p.tag}</text>
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
<html><head><meta charset="utf-8"><title>5m ALL TP/SL Grid — PnL Equity Curves</title>
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
</style></head>
<body>
<h1>📈 5m ALL TP/SL Grid — PnL Equity Curves (3y backtest)</h1>
<div class="meta">
  Period: ${fromStr} → ${toStr} · Capital $5000 · Margin $30×100x · Fee 0.05%/side<br>
  ${picks.length} picks overlay (5 current production + ${picks.length - 5} alternatives) — đường nét đứt = config CURRENT.
</div>

<h2>📊 LOG SCALE — full range $5k → $4.15M (best xem cả journey)</h2>
${chartSvg(yOfLog, "Equity curve (log scale, capital $5k → final)", true)}

<h2>📊 LINEAR SCALE — focus winner gap</h2>
${chartSvg(yOfLin, "Equity curve (linear scale)", false)}

<h2>📋 Bảng so sánh ${picks.length} picks</h2>
<table>
<thead><tr>
  <th>PICK</th><th>TYPE</th><th>STACK</th><th>TP/SL</th>
  <th>NET $</th><th>MAX DD $</th><th>DD %</th><th>WR</th><th>PF</th><th>TRADES</th>
</tr></thead>
<tbody>
${picks.map((p) => `<tr>
  <td><span style="color:${p.color};font-weight:700">●</span> ${p.label}</td>
  <td style="color:#888">${p.tag}</td>
  <td>${p.run.stackMaxPerSide}</td>
  <td>${p.run.tpPct}/${p.run.slPct}</td>
  <td class="pos">$${p.run.netUsd.toLocaleString()}</td>
  <td>$${p.run.maxDrawdownUsd.toLocaleString()}</td>
  <td>${p.run.maxDrawdownPct.toFixed(2)}%</td>
  <td>${p.run.winRate.toFixed(1)}%</td>
  <td>${p.run.profitFactor}</td>
  <td>${p.run.total.toLocaleString()}</td>
</tr>`).join("\n")}
</tbody>
</table>

<div class="note">
  <b>📖 Cách đọc:</b><br>
  • <b>Log scale</b>: ưu tiên xem giai đoạn đầu ($5k → $100k), xem rõ tốc độ start.<br>
  • <b>Linear scale</b>: ưu tiên xem khoảng cách cuối, gap giữa winner.<br>
  • <b>Đường nét đứt (--)</b>: config CURRENT đang chạy production.<br>
  • <b>Đường nét liền</b>: alternatives từ grid backtest (em đề xuất adopt nếu Tommy duyệt).<br>
  • Tất cả 13 đường tăng monotonic cho thấy NO config bị blew-up — chỉ chênh nhau tốc độ/biên độ swing.
</div>

</body></html>`;

writeFileSync(join(__dirname, "..", "assets", "pnl_chart_tpsl_grid_3y.html"), html);
console.log("✅ Chart written → assets/pnl_chart_tpsl_grid_3y.html");
