/**
 * detect-bullish-divergence-1h.ts (anh Tommy 2026-05-03 — TomiHedge Hedge01 research)
 *
 * Detect BULLISH DIVERGENCE (phân kỳ tăng) trên BTC 1h 3y:
 *   Price: low2 < low1 (lower low)
 *   RSI:   rsi[low2] > rsi[low1] (higher low)
 *   → bullish reversal signal — vào LONG
 *
 * Output: HTML chart 3y 1h với:
 *   - Price line (cam)
 *   - RSI subplot dưới (xanh)
 *   - 🔵 markers tại điểm divergence (price low + arrow lên RSI low)
 *
 * Usage:
 *   npx tsx tools/detect-bullish-divergence-1h.ts                # default pivot=5, RSI=14
 *   npx tsx tools/detect-bullish-divergence-1h.ts --pivot=10 --rsi=14
 *   npx tsx tools/detect-bullish-divergence-1h.ts --maxBars=200  # tối đa N bars giữa 2 swing lows
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const args = process.argv.slice(2);
const PIVOT_N = parseInt(args.find((a) => a.startsWith("--pivot="))?.replace("--pivot=", "") || "5", 10);
const RSI_PERIOD = parseInt(args.find((a) => a.startsWith("--rsi="))?.replace("--rsi=", "") || "14", 10);
const MAX_BARS_BETWEEN = parseInt(args.find((a) => a.startsWith("--maxBars="))?.replace("--maxBars=", "") || "100", 10);

interface Candle { time: number; open: number; high: number; low: number; close: number; }

function loadCache(): Candle[] {
  const p = join(__dirname, "..", ".cache", "binance-1h-3y.json");
  if (!existsSync(p)) throw new Error(`Missing ${p}`);
  return JSON.parse(readFileSync(p, "utf8"));
}

// Wilder RSI (cùng formula với indicators.ts)
function calcRSI(closes: number[], period: number): (number | null)[] {
  const rsi: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= period) return rsi;
  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gainSum += ch; else lossSum += -ch;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const gain = ch > 0 ? ch : 0;
    const loss = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

function detectSwingLows(candles: Candle[], n: number): number[] {
  const lows: number[] = [];
  for (let i = n; i < candles.length - n; i++) {
    let isLow = true;
    for (let j = i - n; j <= i + n; j++) {
      if (j === i) continue;
      if (candles[j].low <= candles[i].low) { isLow = false; break; }
    }
    if (isLow) lows.push(i);
  }
  return lows;
}

interface Divergence { lowIdx: number; prevLowIdx: number; price1: number; price2: number; rsi1: number; rsi2: number; time: number; }

function detectBullishDivergence(candles: Candle[], rsi: (number | null)[], swingLows: number[], maxBars: number): Divergence[] {
  const divs: Divergence[] = [];
  for (let i = 1; i < swingLows.length; i++) {
    const idx2 = swingLows[i];
    const idx1 = swingLows[i - 1];
    if (idx2 - idx1 > maxBars) continue; // 2 swing lows quá xa
    const r1 = rsi[idx1], r2 = rsi[idx2];
    if (r1 === null || r2 === null) continue;
    const p1 = candles[idx1].low;
    const p2 = candles[idx2].low;
    // Bullish div: price LL + RSI HL
    if (p2 < p1 && r2 > r1) {
      divs.push({ lowIdx: idx2, prevLowIdx: idx1, price1: p1, price2: p2, rsi1: r1, rsi2: r2, time: candles[idx2].time });
    }
  }
  return divs;
}

function renderHtml(candles: Candle[], rsi: (number | null)[], divs: Divergence[], swingLows: number[]): string {
  const targetPoints = 4000;
  const step = Math.max(1, Math.floor(candles.length / targetPoints));
  const sampledCandles: Candle[] = [];
  const sampledRsi: number[] = [];
  for (let i = 0; i < candles.length; i += step) {
    sampledCandles.push(candles[i]);
    sampledRsi.push(rsi[i] ?? 50);
  }
  if (sampledCandles[sampledCandles.length - 1].time !== candles[candles.length - 1].time) {
    sampledCandles.push(candles[candles.length - 1]);
    sampledRsi.push(rsi[candles.length - 1] ?? 50);
  }

  const tMin = sampledCandles[0].time, tMax = sampledCandles[sampledCandles.length - 1].time;
  const tRange = tMax - tMin;
  const allPrices = sampledCandles.map(c => c.close);
  const pMin = Math.min(...allPrices), pMax = Math.max(...allPrices);
  const pRange = pMax - pMin;

  const W = 1900, Hp = 500, Hr = 200, pad = 60, gap = 30;
  const w = W - pad * 2;
  const hp = Hp - pad;
  const hr = Hr - pad;

  const xOf = (t: number) => pad + ((t - tMin) / tRange) * w;
  const yPriceOf = (p: number) => 30 + hp - ((p - pMin) / pRange) * hp;
  const yRsiOf = (r: number) => Hp + gap + 30 + hr - (r / 100) * hr;

  const priceLine = sampledCandles.map(c => `${xOf(c.time).toFixed(1)},${yPriceOf(c.close).toFixed(1)}`).join(" ");
  const rsiLine = sampledCandles.map((c, i) => `${xOf(c.time).toFixed(1)},${yRsiOf(sampledRsi[i]).toFixed(1)}`).join(" ");

  // Divergence markers
  const divMarkers = divs.map((d) => {
    const c2 = candles[d.lowIdx];
    const c1 = candles[d.prevLowIdx];
    const x1 = xOf(c1.time), y1 = yPriceOf(c1.low);
    const x2 = xOf(c2.time), y2 = yPriceOf(c2.low);
    const r1y = yRsiOf(d.rsi1), r2y = yRsiOf(d.rsi2);
    return `
      <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#ef4444" stroke-width="1.4" opacity="0.7" />
      <line x1="${x1}" y1="${r1y}" x2="${x2}" y2="${r2y}" stroke="#22c55e" stroke-width="1.4" opacity="0.7" />
      <circle cx="${x2}" cy="${y2}" r="6" fill="#3b82f6" stroke="#fff" stroke-width="1.5" opacity="0.95" />
      <circle cx="${x2}" cy="${r2y}" r="4" fill="#3b82f6" stroke="#fff" stroke-width="1" opacity="0.85" />
    `;
  }).join("");

  // Y-axis ticks price
  const pTicks = [pMax, pMax - pRange * 0.25, (pMax + pMin) / 2, pMin + pRange * 0.25, pMin];
  const pTickLines = pTicks.map(p => `<line x1="${pad}" y1="${yPriceOf(p).toFixed(1)}" x2="${W - pad}" y2="${yPriceOf(p).toFixed(1)}" stroke="#333" stroke-width="0.4" stroke-dasharray="3,4" opacity="0.4" />`).join("");
  const pTickLabels = pTicks.map(p => `<text x="${W - pad + 4}" y="${yPriceOf(p) + 4}" fill="#888" font-size="11" font-family="monospace">$${p.toFixed(0)}</text>`).join("");
  // RSI ticks 30/50/70
  const rTickLines = [70, 50, 30].map(r => `<line x1="${pad}" y1="${yRsiOf(r).toFixed(1)}" x2="${W - pad}" y2="${yRsiOf(r).toFixed(1)}" stroke="${r === 50 ? '#666' : '#444'}" stroke-width="0.5" stroke-dasharray="${r === 50 ? '0' : '3,4'}" opacity="0.5" />`).join("");
  const rTickLabels = [70, 50, 30].map(r => `<text x="${W - pad + 4}" y="${yRsiOf(r) + 4}" fill="#888" font-size="10" font-family="monospace">${r}</text>`).join("");

  const xLabels: string[] = [];
  for (let i = 0; i <= 12; i++) {
    const t = tMin + (tRange * i) / 12;
    const d = new Date(t);
    xLabels.push(`<text x="${xOf(t).toFixed(1)}" y="${Hp + gap + Hr + 22}" fill="#888" font-size="10" font-family="monospace" text-anchor="middle">${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getFullYear()).slice(2)}</text>`);
  }

  const totalH = Hp + gap + Hr + 40;
  const periodFrom = new Date(candles[0].time).toISOString().slice(0, 10);
  const periodTo = new Date(candles[candles.length - 1].time).toISOString().slice(0, 10);

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Bullish Divergence 1h 3y</title>
<style>
  body { font-family: monospace; background: #0a0a1a; color: #e7e7e7; padding: 20px; }
  h1 { color: #f7931a; }
  .meta { background: #1a1a2a; padding: 12px; border-radius: 6px; margin-bottom: 16px; line-height: 1.7; }
  .legend { display: inline-block; margin-right: 16px; padding: 2px 8px; }
  svg { background: #0a0a1a; border: 1px solid #333; border-radius: 6px; }
</style></head><body>
<h1>📈 Bullish Divergence Detection — BTC 1h · ${periodFrom} → ${periodTo}</h1>

<div class="meta">
<b>Phân kỳ tăng (Bullish Divergence):</b> Price làm LOWER LOW nhưng RSI(${RSI_PERIOD}) làm HIGHER LOW → reversal signal vào LONG.<br>
<b>Setup:</b> Pivot N=${PIVOT_N} candles · RSI period=${RSI_PERIOD} · Max bars giữa 2 swing lows=${MAX_BARS_BETWEEN}<br>
<b>Total candles:</b> ${candles.length.toLocaleString()} · <b>Swing lows:</b> ${swingLows.length} · <b>Bullish divergences:</b> <b style="color:#3b82f6">${divs.length}</b><br>
<span class="legend"><span style="color:#ef4444">━━ red line</span> = price 2 lows (LOWER LOW)</span>
<span class="legend"><span style="color:#22c55e">━━ green line</span> = RSI 2 lows (HIGHER LOW)</span>
<span class="legend"><span style="color:#3b82f6">● blue dot</span> = divergence detected (entry LONG)</span><br>
<b>Density:</b> ~${(divs.length / 36).toFixed(1)}/month, ~${(divs.length / 1095).toFixed(2)}/day
</div>

<svg width="${W}" height="${totalH}" viewBox="0 0 ${W} ${totalH}">
  <!-- Price chart -->
  <text x="${pad}" y="20" fill="#f7931a" font-size="13" font-weight="bold" font-family="monospace">PRICE 1h</text>
  ${pTickLines}
  ${pTickLabels}
  <polyline points="${priceLine}" fill="none" stroke="#f7931a" stroke-width="1.0" opacity="0.85" />

  <!-- Separator -->
  <line x1="0" y1="${Hp + gap / 2}" x2="${W}" y2="${Hp + gap / 2}" stroke="#333" stroke-width="0.5" />

  <!-- RSI subplot -->
  <text x="${pad}" y="${Hp + gap + 20}" fill="#22c55e" font-size="13" font-weight="bold" font-family="monospace">RSI(${RSI_PERIOD})</text>
  ${rTickLines}
  ${rTickLabels}
  <polyline points="${rsiLine}" fill="none" stroke="#22c55e" stroke-width="1.0" opacity="0.85" />

  <!-- Divergence markers (overlay both charts) -->
  ${divMarkers}

  <!-- X-axis labels -->
  ${xLabels.join("")}
</svg>

<p style="margin-top: 16px; color: #888; font-size: 12px;">
  💡 Mỗi blue dot ● = 1 điểm divergence (entry tiềm năng LONG).<br>
  Red line trên price chart = 2 swing lows giảm dần (lower low).<br>
  Green line trên RSI = 2 swing low RSI tăng dần (higher low).<br>
  Tăng <code>--pivot=10</code> hoặc <code>--maxBars=50</code> để filter divergence rõ rệt hơn (ít markers hơn).<br>
  Tool: <code>npx tsx tools/detect-bullish-divergence-1h.ts --pivot=${PIVOT_N} --rsi=${RSI_PERIOD} --maxBars=${MAX_BARS_BETWEEN}</code>
</p>
</body></html>`;
}

(async () => {
  console.log(`Loading 1h cache 3y...`);
  const candles = loadCache();
  console.log(`  ${candles.length.toLocaleString()} candles 1h (${(candles.length / (24 * 365)).toFixed(2)}y)`);

  console.log(`\nComputing RSI(${RSI_PERIOD})...`);
  const rsi = calcRSI(candles.map(c => c.close), RSI_PERIOD);

  console.log(`Detecting swing lows N=${PIVOT_N}...`);
  const swingLows = detectSwingLows(candles, PIVOT_N);
  console.log(`  ${swingLows.length} swing lows`);

  console.log(`Detecting bullish divergences (max ${MAX_BARS_BETWEEN} bars between)...`);
  const divs = detectBullishDivergence(candles, rsi, swingLows, MAX_BARS_BETWEEN);
  const months = (candles[candles.length - 1].time - candles[0].time) / (30 * 24 * 3600 * 1000);
  console.log(`  ${divs.length} bullish divergences found (~${(divs.length / months).toFixed(1)}/month)\n`);

  // Print first + last 5 for verify
  console.log(`First 3 divergences:`);
  for (const d of divs.slice(0, 3)) {
    console.log(`  ${new Date(d.time).toISOString().slice(0, 16)} · price ${d.price1.toFixed(0)} → ${d.price2.toFixed(0)} (LL) · RSI ${d.rsi1.toFixed(1)} → ${d.rsi2.toFixed(1)} (HL)`);
  }
  console.log(`Last 3 divergences:`);
  for (const d of divs.slice(-3)) {
    console.log(`  ${new Date(d.time).toISOString().slice(0, 16)} · price ${d.price1.toFixed(0)} → ${d.price2.toFixed(0)} (LL) · RSI ${d.rsi1.toFixed(1)} → ${d.rsi2.toFixed(1)} (HL)`);
  }

  const html = renderHtml(candles, rsi, divs, swingLows);
  const outPath = join(__dirname, "..", "assets", `bullish_div_1h_3y_pivot${PIVOT_N}_rsi${RSI_PERIOD}.html`);
  writeFileSync(outPath, html);
  console.log(`\n💾 HTML: ${outPath}`);
})();
