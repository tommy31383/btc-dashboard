/**
 * detect-pivot-15m.ts (anh Tommy 2026-05-02 — TomiHedge research phase 1)
 *
 * Detect pivot points (điểm quay đầu) trên 3y BTC 15m:
 *   - Local LOW: candle có low < low của N candles trước AND N candles sau → LONG entry
 *   - Local HIGH: candle có high > high của N candles trước AND N candles sau → SHORT entry
 *
 * Output: HTML chart với markers ▲ (LONG) ▼ (SHORT) tại pivot points.
 * Tommy verify vị trí có đúng "quay đầu" không trước khi backtest PnL.
 *
 * Usage:
 *   npx tsx tools/detect-pivot-15m.ts                # N=5 default, last 6 months
 *   npx tsx tools/detect-pivot-15m.ts --N=3          # pivot density cao
 *   npx tsx tools/detect-pivot-15m.ts --N=10         # pivot rõ rệt
 *   npx tsx tools/detect-pivot-15m.ts --months=12    # last 12 months
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const args = process.argv.slice(2);
const N = parseInt(args.find((a) => a.startsWith("--N="))?.replace("--N=", "") || "5", 10);
const MONTHS = parseInt(args.find((a) => a.startsWith("--months="))?.replace("--months=", "") || "6", 10);

interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number; }

function loadCache(): Candle[] {
  const p = join(__dirname, "..", ".cache", "binance-15m-3y.json");
  if (!existsSync(p)) throw new Error(`Missing ${p}`);
  return JSON.parse(readFileSync(p, "utf8"));
}

function detectPivots(candles: Candle[], n: number): { lows: number[]; highs: number[] } {
  const lows: number[] = [];
  const highs: number[] = [];
  for (let i = n; i < candles.length - n; i++) {
    const c = candles[i];
    let isLow = true, isHigh = true;
    for (let j = i - n; j <= i + n; j++) {
      if (j === i) continue;
      if (candles[j].low <= c.low) isLow = false;
      if (candles[j].high >= c.high) isHigh = false;
      if (!isLow && !isHigh) break;
    }
    if (isLow) lows.push(i);
    if (isHigh) highs.push(i);
  }
  return { lows, highs };
}

function renderHtml(candles: Candle[], lows: number[], highs: number[], n: number): string {
  // Downsample to ~3000 points for chart speed
  const targetPoints = 3000;
  const step = Math.max(1, Math.floor(candles.length / targetPoints));
  const sampledCandles: Candle[] = [];
  const sampledIdx: number[] = []; // map sampled idx → original idx
  for (let i = 0; i < candles.length; i += step) {
    sampledCandles.push(candles[i]);
    sampledIdx.push(i);
  }
  // Always include last
  if (sampledIdx[sampledIdx.length - 1] !== candles.length - 1) {
    sampledCandles.push(candles[candles.length - 1]);
    sampledIdx.push(candles.length - 1);
  }

  const tMin = sampledCandles[0].time;
  const tMax = sampledCandles[sampledCandles.length - 1].time;
  const tRange = tMax - tMin;
  const allPrices = [...sampledCandles.map((c) => c.close), ...lows.map((i) => candles[i].low), ...highs.map((i) => candles[i].high)];
  const pMin = Math.min(...allPrices);
  const pMax = Math.max(...allPrices);
  const pRange = pMax - pMin;

  const W = 1800, H = 600, pad = 60;
  const w = W - pad * 2, h = H - pad * 2;
  const xOf = (t: number) => pad + ((t - tMin) / tRange) * w;
  const yOf = (p: number) => pad + h - ((p - pMin) / pRange) * h;

  const linePoints = sampledCandles.map((c) => `${xOf(c.time).toFixed(1)},${yOf(c.close).toFixed(1)}`).join(" ");

  // Markers (filter to candles within sampled time range)
  const lowMarkers = lows
    .filter((i) => candles[i].time >= tMin && candles[i].time <= tMax)
    .map((i) => {
      const c = candles[i];
      const x = xOf(c.time), y = yOf(c.low);
      return `<polygon points="${x},${y + 8} ${x - 6},${y + 18} ${x + 6},${y + 18}" fill="#22c55e" opacity="0.85" />`;
    }).join("");

  const highMarkers = highs
    .filter((i) => candles[i].time >= tMin && candles[i].time <= tMax)
    .map((i) => {
      const c = candles[i];
      const x = xOf(c.time), y = yOf(c.high);
      return `<polygon points="${x},${y - 8} ${x - 6},${y - 18} ${x + 6},${y - 18}" fill="#ef4444" opacity="0.85" />`;
    }).join("");

  // Y-axis ticks
  const ticks = [pMax, pMax - pRange * 0.25, (pMax + pMin) / 2, pMin + pRange * 0.25, pMin];
  const tickLines = ticks.map((p) => `<line x1="${pad}" y1="${yOf(p).toFixed(1)}" x2="${W - pad}" y2="${yOf(p).toFixed(1)}" stroke="#333" stroke-width="0.4" stroke-dasharray="3,4" opacity="0.4" />`).join("");
  const tickLabels = ticks.map((p) => `<text x="${W - pad + 4}" y="${yOf(p) + 4}" fill="#888" font-size="11" font-family="monospace">$${p.toFixed(0)}</text>`).join("");

  // X-axis date labels (every ~10% bars)
  const xLabels: string[] = [];
  for (let i = 0; i <= 10; i++) {
    const t = tMin + (tRange * i) / 10;
    const d = new Date(t);
    const lbl = `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getFullYear()).slice(2)}`;
    xLabels.push(`<text x="${xOf(t).toFixed(1)}" y="${H - pad + 20}" fill="#888" font-size="10" font-family="monospace" text-anchor="middle">${lbl}</text>`);
  }

  const periodFrom = new Date(candles[0].time).toISOString().slice(0, 10);
  const periodTo = new Date(candles[candles.length - 1].time).toISOString().slice(0, 10);
  const lowsCount = lows.length;
  const highsCount = highs.length;
  const totalEntries = lowsCount + highsCount;
  const months = (candles[candles.length - 1].time - candles[0].time) / (30 * 24 * 3600 * 1000);
  const entriesPerMonth = totalEntries / months;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Pivot Detection N=${n}</title>
<style>
  body { font-family: monospace; background: #0a0a1a; color: #e7e7e7; padding: 20px; }
  h1 { color: #f7931a; }
  .meta { background: #1a1a2a; padding: 12px; border-radius: 6px; margin-bottom: 16px; line-height: 1.7; }
  .legend { display: inline-block; margin-right: 16px; }
  .legend-long { color: #22c55e; }
  .legend-short { color: #ef4444; }
  svg { background: #0a0a1a; border: 1px solid #333; border-radius: 6px; }
</style></head><body>
<h1>📍 Pivot Detection N=${n} · 15m · ${periodFrom} → ${periodTo}</h1>

<div class="meta">
<b>Pivot rule:</b> Local LOW = low &lt; low của ${n} candles trước AND ${n} candles sau (LONG entry).
                  Local HIGH = high &gt; high của ${n} candles trước/sau (SHORT entry).<br>
<b>Total candles:</b> ${candles.length.toLocaleString()} (${months.toFixed(1)} months)<br>
<b>Pivots detected:</b>
  <span class="legend-long">▲ ${lowsCount} LONG (local lows)</span> ·
  <span class="legend-short">▼ ${highsCount} SHORT (local highs)</span> ·
  Total <b>${totalEntries}</b> entries
  (~<b>${entriesPerMonth.toFixed(1)}/month</b>, ~<b>${(entriesPerMonth/30).toFixed(2)}/day</b>)<br>
<b>Sampled to chart:</b> ${sampledCandles.length} points (every ${step} candles)<br>
<span class="legend"><span class="legend-long">▲ LONG</span> tại local low (giá quay đầu TĂNG)</span>
<span class="legend"><span class="legend-short">▼ SHORT</span> tại local high (giá quay đầu GIẢM)</span>
</div>

<svg width="${W}" height="${H + 30}" viewBox="0 0 ${W} ${H + 30}">
  ${tickLines}
  ${tickLabels}
  ${xLabels.join("")}
  <polyline points="${linePoints}" fill="none" stroke="#f7931a" stroke-width="1.2" opacity="0.8" />
  ${lowMarkers}
  ${highMarkers}
</svg>

<p style="margin-top: 16px; color: #888; font-size: 12px;">
  💡 Mỗi pivot là 1 entry tiềm năng. Anh check vị trí có đúng "quay đầu rõ rệt" không.<br>
  Tăng N → pivots ít hơn, rõ rệt hơn (swing lớn). Giảm N → pivots nhiều hơn, dày đặc.<br>
  Tool: <code>npx tsx tools/detect-pivot-15m.ts --N=${n} --months=${MONTHS}</code>
</p>
</body></html>`;
}

(async () => {
  console.log(`Loading 15m cache 3y...`);
  const all = loadCache();
  console.log(`  ${all.length.toLocaleString()} candles`);

  // Filter to last MONTHS
  const cutoff = Date.now() - MONTHS * 30 * 24 * 3600 * 1000;
  const candles = all.filter((c) => c.time >= cutoff);
  console.log(`  Filter last ${MONTHS} months → ${candles.length.toLocaleString()} candles`);

  console.log(`\nDetecting pivots N=${N}...`);
  const t0 = Date.now();
  const { lows, highs } = detectPivots(candles, N);
  const dur = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  ${lows.length} LONG (local lows) · ${highs.length} SHORT (local highs) · total ${lows.length + highs.length} (${dur}s)`);

  const months = (candles[candles.length - 1].time - candles[0].time) / (30 * 24 * 3600 * 1000);
  console.log(`  Density: ${((lows.length + highs.length) / months).toFixed(1)} entries/month, ${((lows.length + highs.length) / (months * 30)).toFixed(2)} entries/day`);

  const html = renderHtml(candles, lows, highs, N);
  const outPath = join(__dirname, "..", "assets", `pivot_15m_N${N}_${MONTHS}m.html`);
  writeFileSync(outPath, html);
  console.log(`\n💾 HTML: ${outPath}`);
})();
