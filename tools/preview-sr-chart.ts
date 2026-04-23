/**
 * preview-sr-chart.ts — Fetch real BTC klines for each TF, compute S/R levels,
 * render interactive SVG chart HTML so we can verify how they look before
 * running in the app.
 *
 * Usage: npx tsx tools/preview-sr-chart.ts
 */
import { writeFileSync } from "fs";
import { join } from "path";
import { detectSRLevels, formatSRPrice, SRLevel } from "../utils/supportResistance";
import { Kline } from "../hooks/useBinanceKlines";

const BINANCE_REST = "https://api.binance.com/api/v3";

async function fetchKlines(interval: string, limit: number): Promise<Kline[]> {
  const url = `${BINANCE_REST}/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance ${interval}: ${res.status}`);
  const raw = (await res.json()) as any[];
  return raw.map((r) => ({
    time: r[0],
    open: parseFloat(r[1]),
    high: parseFloat(r[2]),
    low: parseFloat(r[3]),
    close: parseFloat(r[4]),
    volume: parseFloat(r[5]),
  }));
}

const TFS = [
  { key: "5m",  label: "5M",  limit: 200, tune: { left: 3, right: 3, tol: 0.15 } },
  { key: "15m", label: "15M", limit: 200, tune: { left: 3, right: 3, tol: 0.25 } },
  { key: "1h",  label: "1H",  limit: 200, tune: { left: 4, right: 4, tol: 0.40 } },
  { key: "4h",  label: "4H",  limit: 200, tune: { left: 5, right: 5, tol: 0.60 } },
  { key: "1d",  label: "1D",  limit: 180, tune: { left: 5, right: 5, tol: 0.90 } },
];

function renderChart(klines: Kline[], levels: SRLevel[], label: string): string {
  const W = 900;
  const H = 340;
  const PADDING_L = 10;
  const PADDING_R = 70;
  const PADDING_T = 24;
  const PADDING_B = 40;
  const contentW = W - PADDING_L - PADDING_R;
  const contentH = H - PADDING_T - PADDING_B;

  let lo = Infinity, hi = -Infinity;
  klines.forEach((k) => {
    if (k.low < lo) lo = k.low;
    if (k.high > hi) hi = k.high;
  });
  const pad = (hi - lo) * 0.05;
  lo -= pad; hi += pad;
  const range = hi - lo;

  const priceToY = (p: number) => PADDING_T + ((hi - p) / range) * contentH;
  const candleW = Math.max(2, (contentW / klines.length) * 0.8);
  const step = contentW / klines.length;

  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="background:#0d1117;border-radius:8px">`;

  // Grid + price labels
  for (let i = 0; i <= 5; i++) {
    const p = hi - (i / 5) * range;
    const y = priceToY(p);
    svg += `<line x1="${PADDING_L}" y1="${y}" x2="${PADDING_L + contentW}" y2="${y}" stroke="#ffffff08" stroke-width="1"/>`;
    svg += `<text x="${PADDING_L + contentW + 4}" y="${y + 3}" fill="#666" font-size="9" font-family="monospace">${p.toFixed(0)}</text>`;
  }

  // Label
  svg += `<text x="${PADDING_L + 4}" y="14" fill="#f7931a" font-size="11" font-family="monospace" font-weight="bold">${label}</text>`;

  // Candles
  klines.forEach((k, i) => {
    const x = PADDING_L + i * step;
    const isGreen = k.close >= k.open;
    const color = isGreen ? "#2ed573" : "#ff4757";
    const bodyTop = priceToY(Math.max(k.open, k.close));
    const bodyBot = priceToY(Math.min(k.open, k.close));
    const bodyH = Math.max(bodyBot - bodyTop, 0.5);
    svg += `<line x1="${x + candleW / 2}" y1="${priceToY(k.high)}" x2="${x + candleW / 2}" y2="${priceToY(k.low)}" stroke="${color}" stroke-width="1"/>`;
    svg += `<rect x="${x}" y="${bodyTop}" width="${candleW}" height="${bodyH}" fill="${color}" stroke="${color}"/>`;
  });

  // S/R lines
  const last = klines[klines.length - 1];
  levels.forEach((lvl) => {
    const y = priceToY(lvl.price);
    if (y < PADDING_T || y > PADDING_T + contentH) return;
    const isRes = lvl.kind === "resistance";
    const color = isRes ? "#ff4757" : "#2ed573";
    const op = 0.4 + lvl.strength * 0.4;
    const sw = 1 + Math.min(2, lvl.strength * 2);
    const fromX = PADDING_L + lvl.firstFormedIdx * step;
    const toX = PADDING_L + contentW;
    svg += `<line x1="${fromX}" y1="${y}" x2="${toX}" y2="${y}" stroke="${color}" stroke-width="${sw}" opacity="${op}" stroke-dasharray="6,3"/>`;
    // Touch pill left
    svg += `<rect x="${fromX + 2}" y="${y - 6}" width="26" height="12" fill="${color}" opacity="0.85" rx="2"/>`;
    svg += `<text x="${fromX + 15}" y="${y + 3}" fill="#ffffff" font-size="8" font-family="monospace" font-weight="bold" text-anchor="middle">${lvl.touches}×</text>`;
    // Price label right
    svg += `<rect x="${PADDING_L + contentW + 1}" y="${y - 6}" width="48" height="12" fill="${color}" opacity="0.9" rx="2"/>`;
    svg += `<text x="${PADDING_L + contentW + 25}" y="${y + 3}" fill="#ffffff" font-size="8" font-family="monospace" font-weight="bold" text-anchor="middle">${formatSRPrice(lvl.price)}</text>`;
  });

  // Current price line
  const curY = priceToY(last.close);
  svg += `<line x1="${PADDING_L}" y1="${curY}" x2="${PADDING_L + contentW}" y2="${curY}" stroke="#f7931a" stroke-width="1" stroke-dasharray="2,2" opacity="0.7"/>`;
  svg += `<rect x="${PADDING_L + contentW + 1}" y="${curY - 7}" width="48" height="14" fill="#f7931a" rx="2"/>`;
  svg += `<text x="${PADDING_L + contentW + 25}" y="${curY + 4}" fill="#000" font-size="9" font-family="monospace" font-weight="900" text-anchor="middle">${last.close.toFixed(0)}</text>`;

  svg += `</svg>`;
  return svg;
}

async function main() {
  console.log("Fetching klines + computing S/R for all TFs...");
  const results: { tf: string; label: string; klines: Kline[]; levels: SRLevel[] }[] = [];

  for (const tf of TFS) {
    const klines = await fetchKlines(tf.key, tf.limit);
    const last = klines[klines.length - 1];
    const levels = detectSRLevels(klines, last.close, {
      leftBars: tf.tune.left,
      rightBars: tf.tune.right,
      tolerancePct: tf.tune.tol,
      minTouches: 2,
      maxPerSide: 4,
    });
    console.log(`  ${tf.label}: ${klines.length} nến · ${levels.length} S/R levels (current: ${last.close.toFixed(0)})`);
    levels.forEach((l) => console.log(`    ${l.kind === "resistance" ? "🔴 R" : "🟢 S"}: ${l.price.toFixed(2)} (${l.touches} touches, strength ${(l.strength * 100).toFixed(0)}%)`));
    results.push({ tf: tf.key, label: tf.label, klines, levels });
  }

  // Build HTML report
  let html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>📊 BTC Support/Resistance — All TFs</title>
<style>
  body { background:#0a0a1a; color:#fff; font-family: 'SF Mono', Consolas, monospace; padding:16px; margin:0; }
  h1 { color:#f7931a; font-size:16px; letter-spacing:1px; }
  .subtitle { color:#aaa; font-size:11px; margin-bottom:20px; font-style:italic; }
  .tf-block { margin-bottom:24px; background:#0d1117; border-radius:8px; padding:12px; border:1px solid #ffffff10; }
  .tf-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; }
  .tf-title { color:#f7931a; font-size:14px; font-weight:900; letter-spacing:1px; }
  .tf-stats { color:#aaa; font-size:11px; }
  .levels-table { width:100%; margin-top:12px; font-size:10px; border-collapse:collapse; }
  .levels-table th { color:#888; text-align:left; padding:4px 8px; border-bottom:1px solid #ffffff15; }
  .levels-table td { padding:4px 8px; border-bottom:1px solid #ffffff08; }
  .res { color:#ff4757; }
  .sup { color:#2ed573; }
  .strength-bar { display:inline-block; height:6px; background:#ffffff10; border-radius:3px; width:80px; vertical-align:middle; overflow:hidden; }
  .strength-fill { height:6px; display:block; border-radius:3px; }
  .legend { display:flex; gap:14px; font-size:11px; color:#aaa; margin-top:12px; padding:8px 12px; background:#ffffff05; border-radius:6px; flex-wrap:wrap; }
</style></head>
<body>
<h1>📊 BTC Support/Resistance — Multi-TF Preview</h1>
<div class="subtitle">Preview S/R levels rendered exactly like chart in app · ${new Date().toLocaleString("vi-VN")}</div>

<div class="legend">
  <span><b style="color:#ff4757">🔴 Resistance</b> — above current price (giá kháng cự)</span>
  <span><b style="color:#2ed573">🟢 Support</b> — below current price (giá hỗ trợ)</span>
  <span><b style="color:#f7931a">━━ Current price</b></span>
  <span><b>N×</b> — số lần giá đã test level này (càng nhiều = càng mạnh)</span>
</div>
`;

  for (const r of results) {
    const last = r.klines[r.klines.length - 1];
    html += `
<div class="tf-block">
  <div class="tf-header">
    <div class="tf-title">⏱ ${r.label} · ${r.klines.length} nến</div>
    <div class="tf-stats">Giá hiện tại: <b style="color:#f7931a">$${last.close.toFixed(2)}</b> · ${r.levels.length} S/R levels</div>
  </div>
  ${renderChart(r.klines, r.levels, `BTCUSDT · ${r.label} · ${r.klines.length} nến`)}
  <table class="levels-table">
    <thead><tr><th>Loại</th><th>Giá</th><th>Khoảng cách</th><th>Số touches</th><th>Strength</th></tr></thead>
    <tbody>`;
    const sortedLevels = [...r.levels].sort((a, b) => b.price - a.price);
    for (const lvl of sortedLevels) {
      const dist = ((lvl.price - last.close) / last.close * 100);
      const distStr = (dist >= 0 ? "+" : "") + dist.toFixed(2) + "%";
      const color = lvl.kind === "resistance" ? "#ff4757" : "#2ed573";
      const cls = lvl.kind === "resistance" ? "res" : "sup";
      html += `<tr>
        <td class="${cls}"><b>${lvl.kind === "resistance" ? "🔴 Kháng cự" : "🟢 Hỗ trợ"}</b></td>
        <td class="${cls}"><b>$${lvl.price.toFixed(2)}</b></td>
        <td class="${cls}">${distStr}</td>
        <td>${lvl.touches}×</td>
        <td><span class="strength-bar"><span class="strength-fill" style="width:${(lvl.strength * 100).toFixed(0)}%;background:${color}"></span></span> <b style="color:${color}">${(lvl.strength * 100).toFixed(0)}%</b></td>
      </tr>`;
    }
    html += `</tbody></table></div>`;
  }

  html += `</body></html>`;

  const outPath = join(process.cwd(), "assets", "sr_preview.html");
  writeFileSync(outPath, html);
  console.log(`\n✅ Wrote ${outPath}`);
  console.log(`   Open: file:///${outPath.replace(/\\/g, "/")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
