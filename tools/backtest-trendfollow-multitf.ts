/**
 * backtest-trendfollow-multitf.ts (anh Tommy 2026-05-03)
 *
 * Trend Follow Multi-TF rule:
 *   - Weekly trend (1W): close[w] > close[w-1] = UP, ngược lại = DOWN
 *   - UP mode: ADD LONG khi 5m close touch SUPPORT (1D/4h/1h/15m swing lows, ±0.4%)
 *   - DOWN mode: ADD SHORT khi 5m close touch RESISTANCE (swing highs)
 *   - Khi weekly trend flip → CLOSE ALL side cũ + bắt đầu side mới
 *
 * Mỗi ADD: 0.001 BTC × current price (MIN size, lev 125x cross)
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const PIVOT_N = 10;
const TOUCH_PCT = 0.4; // ±0.4% là "chạm"
const COOLDOWN_BARS = 12; // 12 × 5m = 1h cooldown giữa các adds
const MIN_QTY_BTC = 0.001;
const LEVERAGE = 125;
const FEE_PER_SIDE_PCT = 0.05;
const MAINT_MARGIN_RATE = 0.004;

interface Candle { time: number; open: number; high: number; low: number; close: number; }

function loadCache(tf: string): Candle[] {
  const p = join(__dirname, "..", ".cache", `binance-${tf}-3y.json`);
  if (!existsSync(p)) throw new Error(`Missing ${p}`);
  return JSON.parse(readFileSync(p, "utf8"));
}

function detectSwingLevels(candles: Candle[], n: number): { lows: number[]; highs: number[] } {
  const lows: number[] = [], highs: number[] = [];
  for (let i = n; i < candles.length - n; i++) {
    let isLow = true, isHigh = true;
    for (let j = i - n; j <= i + n; j++) {
      if (j === i) continue;
      if (candles[j].low <= candles[i].low) isLow = false;
      if (candles[j].high >= candles[i].high) isHigh = false;
    }
    if (isLow) lows.push(candles[i].low);
    if (isHigh) highs.push(candles[i].high);
  }
  return { lows, highs };
}

(async () => {
  console.log(`Loading caches 3y: 5m, 15m, 1h, 4h, 1d, 1w...`);
  const c5 = loadCache("5m");
  const c15 = loadCache("15m");
  const c1h = loadCache("1h");
  const c4h = loadCache("4h");
  const c1d = loadCache("1d");
  const c1w = loadCache("1w");
  console.log(`  5m=${c5.length.toLocaleString()} · 15m=${c15.length.toLocaleString()} · 1h=${c1h.length.toLocaleString()} · 4h=${c4h.length.toLocaleString()} · 1d=${c1d.length.toLocaleString()} · 1w=${c1w.length.toLocaleString()}`);

  // Detect S/R levels on each TF
  const sr15m = detectSwingLevels(c15, PIVOT_N);
  const sr1h = detectSwingLevels(c1h, PIVOT_N);
  const sr4h = detectSwingLevels(c4h, PIVOT_N);
  const sr1d = detectSwingLevels(c1d, PIVOT_N);
  const allSupports = [...sr15m.lows, ...sr1h.lows, ...sr4h.lows, ...sr1d.lows].sort((a, b) => a - b);
  const allResistances = [...sr15m.highs, ...sr1h.highs, ...sr4h.highs, ...sr1d.highs].sort((a, b) => a - b);
  console.log(`  Total S/R levels: ${allSupports.length} supports · ${allResistances.length} resistances\n`);

  // Build weekly trend timeline (UP/DOWN per week)
  // For each 5m candle, find which week it belongs to + trend
  const weekTrend: { startTime: number; endTime: number; up: boolean }[] = [];
  for (let i = 1; i < c1w.length; i++) {
    weekTrend.push({
      startTime: c1w[i].time,
      endTime: i + 1 < c1w.length ? c1w[i + 1].time : c1w[i].time + 7 * 24 * 3600 * 1000,
      up: c1w[i].close > c1w[i - 1].close,
    });
  }
  function getTrendAt(t: number): "UP" | "DOWN" | null {
    for (const w of weekTrend) {
      if (t >= w.startTime && t < w.endTime) return w.up ? "UP" : "DOWN";
    }
    return null;
  }

  // Helper: check if price within TOUCH_PCT of any level
  function nearLevel(price: number, levels: number[]): boolean {
    const tol = price * (TOUCH_PCT / 100);
    // Binary-ish search: levels sorted
    for (const lv of levels) {
      if (lv > price + tol) break;
      if (Math.abs(lv - price) <= tol) return true;
    }
    return false;
  }

  // Simulate 5m
  let qty = 0;        // signed: + LONG, - SHORT
  let costBasis = 0;  // sum of (qty × price) — for weighted avg
  let realizedPnl = 0;
  let totalFee = 0;
  let currentSide: "LONG" | "SHORT" | null = null;
  let lastAddBarIdx = -COOLDOWN_BARS;
  let totalAdds = 0;
  let totalCloses = 0;
  let wins = 0, losses = 0;

  const cycles: { trend: "UP" | "DOWN"; adds: number; openTime: number; closeTime: number; avgEntry: number; closePrice: number; pnl: number }[] = [];
  let cycleAdds = 0, cycleStart = 0, cycleAvgEntry = 0;

  // Equity tracking
  let peakEquity = 0, maxDD = 0;
  let maxNegUpnl = 0, maxMargin = 0;
  const sampleStep = Math.max(1, Math.floor(c5.length / 1500));
  const equityCurve: { t: number; price: number; qty: number; uPnL: number; equity: number; trend: string }[] = [];

  let lastTrend: "UP" | "DOWN" | null = null;

  for (let i = 0; i < c5.length; i++) {
    const c = c5[i];
    const trend = getTrendAt(c.time);

    // Trend flip detection — close all side cũ if exists
    if (trend !== lastTrend && qty !== 0 && currentSide !== null) {
      const closePrice = c.close;
      const closedSide = currentSide;
      const absQty = Math.abs(qty);
      const avgEntry = costBasis / absQty;
      const exitNotional = absQty * closePrice;
      const exitFee = exitNotional * (FEE_PER_SIDE_PCT / 100);
      const grossPnL = closedSide === "LONG"
        ? absQty * (closePrice - avgEntry)
        : absQty * (avgEntry - closePrice);
      const netPnL = grossPnL - exitFee;
      realizedPnl += grossPnL;
      totalFee += exitFee;
      totalCloses++;
      if (netPnL >= 0) wins++; else losses++;
      cycles.push({ trend: lastTrend ?? "UP", adds: cycleAdds, openTime: cycleStart, closeTime: c.time, avgEntry, closePrice, pnl: netPnL });
      qty = 0; costBasis = 0; currentSide = null; cycleAdds = 0;
    }
    lastTrend = trend;

    // Entry signal
    if (trend !== null && i - lastAddBarIdx >= COOLDOWN_BARS) {
      let entrySide: "LONG" | "SHORT" | null = null;
      if (trend === "UP" && nearLevel(c.close, allSupports)) entrySide = "LONG";
      else if (trend === "DOWN" && nearLevel(c.close, allResistances)) entrySide = "SHORT";
      if (entrySide && (currentSide === null || currentSide === entrySide)) {
        // ADD
        const addQty = MIN_QTY_BTC;
        const addNotional = addQty * c.close;
        const fee = addNotional * (FEE_PER_SIDE_PCT / 100);
        if (currentSide === null) { cycleStart = c.time; currentSide = entrySide; }
        const signedAdd = entrySide === "LONG" ? addQty : -addQty;
        qty += signedAdd;
        costBasis += addQty * c.close; // always positive cost basis (use abs qty)
        totalFee += fee;
        totalAdds++;
        cycleAdds++;
        lastAddBarIdx = i;
      }
    }

    // Sample equity
    if (i % sampleStep === 0 || i === c5.length - 1) {
      const absQty = Math.abs(qty);
      const avgE = absQty > 0 ? costBasis / absQty : 0;
      const uPnL = currentSide === "LONG"
        ? absQty * (c.close - avgE)
        : currentSide === "SHORT" ? absQty * (avgE - c.close) : 0;
      const eq = realizedPnl + uPnL - totalFee;
      const margin = (absQty * c.close) / LEVERAGE;
      equityCurve.push({ t: c.time, price: c.close, qty, uPnL, equity: eq, trend: trend ?? "—" });
      if (eq > peakEquity) peakEquity = eq;
      const dd = peakEquity - eq;
      if (dd > maxDD) maxDD = dd;
      if (uPnL < maxNegUpnl) maxNegUpnl = uPnL;
      if (margin > maxMargin) maxMargin = margin;
    }
  }

  const finalPrice = c5[c5.length - 1].close;
  const absQty = Math.abs(qty);
  const finalAvgE = absQty > 0 ? costBasis / absQty : 0;
  const finalUPnL = currentSide === "LONG"
    ? absQty * (finalPrice - finalAvgE)
    : currentSide === "SHORT" ? absQty * (finalAvgE - finalPrice) : 0;
  const closeAllExitFee = absQty * finalPrice * (FEE_PER_SIDE_PCT / 100);
  const finalIfClose = realizedPnl + finalUPnL - totalFee - closeAllExitFee;
  const budgetNeeded = Math.abs(maxNegUpnl) + maxMargin * MAINT_MARGIN_RATE * LEVERAGE + 100;

  console.log(`=== TREND FOLLOW MULTI-TF · 3y ===\n`);
  console.log(`Weekly trends: ${weekTrend.length} weeks (${weekTrend.filter(w => w.up).length} UP, ${weekTrend.filter(w => !w.up).length} DOWN)`);
  console.log(`Total ADDs: ${totalAdds}`);
  console.log(`Total CLOSE cycles: ${totalCloses}`);
  console.log(`  Wins: ${wins} · Losses: ${losses} · WR: ${totalCloses > 0 ? (wins / totalCloses * 100).toFixed(1) : 0}%`);
  console.log(`Realized PnL (gross, all closed): $${realizedPnl.toFixed(2)}`);
  console.log(`Total fee paid: $${totalFee.toFixed(2)}\n`);
  console.log(`Open position còn:`);
  console.log(`  side: ${currentSide ?? '—'} · qty: ${absQty.toFixed(4)} BTC · avg $${finalAvgE.toFixed(0)} · uPnL ${finalUPnL >= 0 ? '+' : ''}$${finalUPnL.toFixed(2)}\n`);
  console.log(`💰 PnL hôm nay (close hết @ $${finalPrice.toFixed(0)}): ${finalIfClose >= 0 ? '+' : ''}$${finalIfClose.toFixed(2)}`);
  console.log(`📉 Max DD: $${maxDD.toFixed(2)}`);
  console.log(`📉 Worst uPnL: $${maxNegUpnl.toFixed(2)}`);
  console.log(`💵 Max margin: $${maxMargin.toFixed(2)}`);
  console.log(`💵 BUDGET CẦN: ~$${budgetNeeded.toFixed(0)}\n`);

  if (cycles.length > 0) {
    const avgPnl = cycles.reduce((s, c) => s + c.pnl, 0) / cycles.length;
    const best = [...cycles].sort((a, b) => b.pnl - a.pnl)[0];
    const worst = [...cycles].sort((a, b) => a.pnl - b.pnl)[0];
    console.log(`Avg pnl/cycle: $${avgPnl.toFixed(2)}`);
    console.log(`Best: $${best.pnl.toFixed(2)} (${best.trend} · ${best.adds} adds)`);
    console.log(`Worst: $${worst.pnl.toFixed(2)} (${worst.trend} · ${worst.adds} adds)`);
    console.log(`Avg adds/cycle: ${(cycles.reduce((s, c) => s + c.adds, 0) / cycles.length).toFixed(1)}\n`);
  }

  // Render HTML
  const W = 1800, Hp = 350, Hu = 200, He = 200, pad = 60, gap = 25;
  const totalH = Hp + gap + Hu + gap + He + 60;
  const tMin = equityCurve[0].t, tMax = equityCurve[equityCurve.length - 1].t;
  const tRange = tMax - tMin;
  const w = W - pad * 2;
  const xOf = (t: number) => pad + ((t - tMin) / tRange) * w;
  const pMin = Math.min(...equityCurve.map(p => p.price));
  const pMax = Math.max(...equityCurve.map(p => p.price));
  const pRange = pMax - pMin;
  const yPriceOf = (p: number) => 30 + (Hp - pad) - ((p - pMin) / pRange) * (Hp - pad);
  const uMin = Math.min(...equityCurve.map(p => p.uPnL), 0);
  const uMax = Math.max(...equityCurve.map(p => p.uPnL), 0);
  const uRange = (uMax - uMin) || 1;
  const yUOf = (u: number) => Hp + gap + 30 + (Hu - pad) - ((u - uMin) / uRange) * (Hu - pad);
  const eMin = Math.min(...equityCurve.map(p => p.equity), 0);
  const eMax = Math.max(...equityCurve.map(p => p.equity), 0);
  const eRange = (eMax - eMin) || 1;
  const yEOf = (e: number) => Hp + gap + Hu + gap + 30 + (He - pad) - ((e - eMin) / eRange) * (He - pad);

  const priceLine = equityCurve.map(p => `${xOf(p.t).toFixed(1)},${yPriceOf(p.price).toFixed(1)}`).join(" ");
  const uLine = equityCurve.map(p => `${xOf(p.t).toFixed(1)},${yUOf(p.uPnL).toFixed(1)}`).join(" ");
  const eLine = equityCurve.map(p => `${xOf(p.t).toFixed(1)},${yEOf(p.equity).toFixed(1)}`).join(" ");

  // Trend bands (background)
  const trendBands = weekTrend.map(w => {
    const x1 = xOf(Math.max(tMin, w.startTime));
    const x2 = xOf(Math.min(tMax, w.endTime));
    if (x2 <= x1) return "";
    const color = w.up ? "#22c55e" : "#ef4444";
    return `<rect x="${x1}" y="30" width="${x2 - x1}" height="${Hp - 30}" fill="${color}" opacity="0.05" />`;
  }).join("");

  const xLabels: string[] = [];
  for (let i = 0; i <= 12; i++) {
    const t = tMin + (tRange * i) / 12;
    const d = new Date(t);
    xLabels.push(`<text x="${xOf(t).toFixed(1)}" y="${totalH - 10}" fill="#888" font-size="10" font-family="monospace" text-anchor="middle">${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getFullYear()).slice(2)}</text>`);
  }

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>TrendFollow Multi-TF</title>
<style>body{font-family:monospace;background:#0a0a1a;color:#e7e7e7;padding:20px}h1{color:#f7931a}.meta{background:#1a1a2a;padding:14px;border-radius:6px;margin-bottom:16px;line-height:1.8}.stat{display:inline-block;padding:8px 14px;background:#2a2a3a;border-radius:4px;margin:4px 8px 4px 0}.green{color:#22c55e;font-weight:bold}.red{color:#ef4444;font-weight:bold}.orange{color:#f7931a;font-weight:bold}.blue{color:#3b82f6;font-weight:bold}svg{background:#0a0a1a;border:1px solid #333;border-radius:6px}</style></head><body>
<h1>📊 Trend Follow Multi-TF · 3y BTC · 5m entry</h1>
<div class="meta">
<b>Setup:</b> Weekly trend UP → ADD LONG @ support touch (5m near 1D/4h/1h/15m swing lows ±${TOUCH_PCT}%). DOWN → ADD SHORT @ resistance.<br>
Trend flip → CLOSE ALL side cũ. Cooldown ${COOLDOWN_BARS} bars (${COOLDOWN_BARS * 5}min) giữa adds.<br>
Pivot N=${PIVOT_N}, MIN size 0.001 BTC, lev ${LEVERAGE}x cross.<br><br>
<div class="stat">Adds: <b>${totalAdds}</b></div>
<div class="stat">Cycles: <b>${totalCloses}</b></div>
<div class="stat">WR: <b>${totalCloses > 0 ? (wins/totalCloses*100).toFixed(1) : 0}%</b> (${wins}W/${losses}L)</div>
<div class="stat">Realized: <b class="${realizedPnl >= 0 ? 'green' : 'red'}">${realizedPnl >= 0 ? '+' : ''}$${realizedPnl.toFixed(2)}</b></div>
<div class="stat">Fee: $${totalFee.toFixed(2)}</div><br>
<div class="stat">Open: <b>${currentSide ?? '—'} ${absQty.toFixed(4)} BTC</b> @ <b>$${finalAvgE.toFixed(0)}</b></div>
<div class="stat">uPnL: <b class="${finalUPnL >= 0 ? 'green' : 'red'}">${finalUPnL >= 0 ? '+' : ''}$${finalUPnL.toFixed(2)}</b></div>
<div class="stat">💰 <b>PnL FINAL @ $${finalPrice.toFixed(0)}: <span class="${finalIfClose >= 0 ? 'green' : 'red'}">${finalIfClose >= 0 ? '+' : ''}$${finalIfClose.toFixed(2)}</span></b></div><br>
<div class="stat">📉 Max DD: <b class="red">$${maxDD.toFixed(2)}</b></div>
<div class="stat">📉 Worst uPnL: <b class="red">$${maxNegUpnl.toFixed(2)}</b></div>
<div class="stat">💵 Max margin: $${maxMargin.toFixed(2)}</div>
<div class="stat">💵 <b class="blue">BUDGET CẦN: ~$${budgetNeeded.toFixed(0)}</b></div>
</div>
<svg width="${W}" height="${totalH}" viewBox="0 0 ${W} ${totalH}">
<text x="${pad}" y="20" fill="#f7931a" font-size="13" font-weight="bold" font-family="monospace">PRICE 5m + WEEKLY TREND BANDS (xanh=UP, đỏ=DOWN)</text>
${trendBands}
<polyline points="${priceLine}" fill="none" stroke="#f7931a" stroke-width="0.9" opacity="0.85" />
<line x1="0" y1="${Hp+gap/2}" x2="${W}" y2="${Hp+gap/2}" stroke="#333" stroke-width="0.5" />
<text x="${pad}" y="${Hp+gap+20}" fill="#3b82f6" font-size="13" font-weight="bold" font-family="monospace">uPnL OPEN (USDT)</text>
<line x1="${pad}" y1="${yUOf(0)}" x2="${W-pad}" y2="${yUOf(0)}" stroke="#666" stroke-width="0.6" />
<polyline points="${uLine}" fill="none" stroke="#3b82f6" stroke-width="1.2" opacity="0.9" />
<line x1="0" y1="${Hp+gap+Hu+gap/2}" x2="${W}" y2="${Hp+gap+Hu+gap/2}" stroke="#333" stroke-width="0.5" />
<text x="${pad}" y="${Hp+gap+Hu+gap+20}" fill="#22c55e" font-size="13" font-weight="bold" font-family="monospace">EQUITY (realized + uPnL - fees)</text>
<line x1="${pad}" y1="${yEOf(0)}" x2="${W-pad}" y2="${yEOf(0)}" stroke="#666" stroke-width="0.6" />
<polyline points="${eLine}" fill="none" stroke="#22c55e" stroke-width="1.2" opacity="0.9" />
${xLabels.join("")}
</svg></body></html>`;

  const outPath = join(__dirname, "..", "assets", "backtest_trendfollow_multitf.html");
  writeFileSync(outPath, html);
  console.log(`💾 HTML: ${outPath}`);
})();
