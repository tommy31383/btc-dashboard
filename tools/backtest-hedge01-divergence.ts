/**
 * backtest-hedge01-divergence.ts (anh Tommy 2026-05-03)
 *
 * Hedge01 setup TEST 1 (chỉ entry, chưa close):
 *   - Entry: tại MỌI điểm bullish divergence 1h 3y → ADD LONG vào TomiHedge LONG net
 *   - Size MIN: 0.001 BTC × price_at_entry (dynamic, ~$77 hiện tại)
 *   - KHÔNG close — accumulate đến cuối period (hôm nay)
 *   - LONG-only (không SHORT)
 *
 * Output:
 *   - Total adds + final NET position (qty + avg_entry)
 *   - Final uPnL @ price hôm nay
 *   - Max DD trong suốt 3y
 *   - Budget cần (max margin used + max negative uPnL buffer cho LIQ)
 *   - Equity curve HTML
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const PIVOT_N = 5;
const RSI_PERIOD = 14;
const MAX_BARS_BETWEEN = 100;

// Position config
const MIN_QTY_BTC = 0.001; // Binance min
const LEVERAGE = 125;
const FEE_PER_SIDE_PCT = 0.05;
const MAINT_MARGIN_RATE = 0.004; // tier 0

interface Candle { time: number; open: number; high: number; low: number; close: number; }

function loadCache(): Candle[] {
  const p = join(__dirname, "..", ".cache", "binance-1h-3y.json");
  if (!existsSync(p)) throw new Error(`Missing ${p}`);
  return JSON.parse(readFileSync(p, "utf8"));
}

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
    avgGain = (avgGain * (period - 1) + (ch > 0 ? ch : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (ch < 0 ? -ch : 0)) / period;
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

interface Divergence { confirmIdx: number; entryPrice: number; time: number; }

function detectDivergences(candles: Candle[]): Divergence[] {
  const closes = candles.map(c => c.close);
  const rsi = calcRSI(closes, RSI_PERIOD);
  const swingLows = detectSwingLows(candles, PIVOT_N);
  const divs: Divergence[] = [];
  for (let i = 1; i < swingLows.length; i++) {
    const idx2 = swingLows[i];
    const idx1 = swingLows[i - 1];
    if (idx2 - idx1 > MAX_BARS_BETWEEN) continue;
    const r1 = rsi[idx1], r2 = rsi[idx2];
    if (r1 === null || r2 === null) continue;
    const p1 = candles[idx1].low;
    const p2 = candles[idx2].low;
    if (p2 < p1 && r2 > r1) {
      // Confirm + entry @ idx2 + PIVOT_N (after pivot confirmed)
      const confirmIdx = idx2 + PIVOT_N;
      if (confirmIdx >= candles.length) continue;
      divs.push({ confirmIdx, entryPrice: candles[confirmIdx].close, time: candles[confirmIdx].time });
    }
  }
  return divs;
}

(async () => {
  console.log(`Loading 1h cache 3y...`);
  const candles = loadCache();
  const divs = detectDivergences(candles);
  console.log(`  ${candles.length.toLocaleString()} candles · ${divs.length} bullish divergences detected\n`);

  // Simulate: ADD LONG @ each divergence with MIN qty (dynamic)
  let totalQty = 0;
  let totalNotionalAtEntry = 0; // sum of (qty × entry_price) — for weighted avg + cost basis
  let totalEntryFee = 0;
  let totalAdds = 0;

  // Track equity timeline for max DD
  let evIdx = 0;
  const equityCurve: { t: number; price: number; qty: number; avgEntry: number; notionalCurrent: number; uPnL: number; marginUsed: number; equity: number; cumFee: number }[] = [];
  const sampleStep = Math.max(1, Math.floor(candles.length / 1500));

  let peakEquity = 0;
  let maxDD = 0;
  let maxMarginUsed = 0;
  let maxNegativeUpnl = 0; // worst uPnL seen (most negative)

  // We'll compute equity = uPnL - cumFee (no realized pnl since no close)
  // Budget needed = max margin used + max abs(maxNegativeUpnl) + maint_margin buffer
  for (let i = 0; i < candles.length; i++) {
    while (evIdx < divs.length && divs[evIdx].confirmIdx === i) {
      const d = divs[evIdx];
      const addQty = MIN_QTY_BTC; // 0.001 BTC
      const addNotional = addQty * d.entryPrice;
      const fee = addNotional * (FEE_PER_SIDE_PCT / 100);
      // Merge weighted avg
      const newQty = totalQty + addQty;
      const newCostBasis = totalNotionalAtEntry + addNotional;
      totalQty = newQty;
      totalNotionalAtEntry = newCostBasis;
      totalEntryFee += fee;
      totalAdds++;
      evIdx++;
    }
    if (i % sampleStep === 0 || i === candles.length - 1) {
      const c = candles[i];
      const avgEntry = totalQty > 0 ? totalNotionalAtEntry / totalQty : 0;
      const notionalCurrent = totalQty * c.close;
      const uPnL = totalQty * (c.close - avgEntry);
      const marginUsed = notionalCurrent / LEVERAGE;
      const equity = uPnL - totalEntryFee;
      equityCurve.push({ t: c.time, price: c.close, qty: totalQty, avgEntry, notionalCurrent, uPnL, marginUsed, equity, cumFee: totalEntryFee });
      if (equity > peakEquity) peakEquity = equity;
      const dd = peakEquity - equity;
      if (dd > maxDD) maxDD = dd;
      if (marginUsed > maxMarginUsed) maxMarginUsed = marginUsed;
      if (uPnL < maxNegativeUpnl) maxNegativeUpnl = uPnL;
    }
  }

  // Final state
  const finalCandle = candles[candles.length - 1];
  const finalPrice = finalCandle.close;
  const avgEntry = totalNotionalAtEntry / totalQty;
  const finalUPnL = totalQty * (finalPrice - avgEntry);
  const finalNotional = totalQty * finalPrice;
  const finalMarginUsed = finalNotional / LEVERAGE;
  const exitFeeIfClose = finalNotional * (FEE_PER_SIDE_PCT / 100);
  const finalRealizedIfClose = finalUPnL - totalEntryFee - exitFeeIfClose;

  // Budget: cần wallet đủ cover max negative uPnL + maint margin của max position
  const maxMaintMargin = maxMarginUsed * MAINT_MARGIN_RATE * LEVERAGE; // notional × MMR
  const budgetNeeded = Math.abs(maxNegativeUpnl) + maxMaintMargin + 100; // +$100 buffer

  console.log(`=== HEDGE01 BULLISH DIVERGENCE 3Y · LONG-ONLY · MIN size ===\n`);
  console.log(`Total ADDs:       ${totalAdds}`);
  console.log(`Total qty LONG:   ${totalQty.toFixed(4)} BTC`);
  console.log(`Avg entry price:  $${avgEntry.toFixed(0)}`);
  console.log(`Total cost basis: $${totalNotionalAtEntry.toFixed(0)} USDT (notional sum @ entries)`);
  console.log(`Total entry fee:  $${totalEntryFee.toFixed(2)}\n`);
  console.log(`Final price (today): $${finalPrice.toFixed(0)}`);
  console.log(`Final notional:      $${finalNotional.toFixed(0)} USDT`);
  console.log(`Final margin used:   $${finalMarginUsed.toFixed(2)} (cross)\n`);
  console.log(`💰 PnL realtime (uPnL): ${finalUPnL >= 0 ? '+' : ''}$${finalUPnL.toFixed(2)}`);
  console.log(`💰 PnL nếu close hết hôm nay: ${finalRealizedIfClose >= 0 ? '+' : ''}$${finalRealizedIfClose.toFixed(2)} (sau exit fee $${exitFeeIfClose.toFixed(2)})\n`);
  console.log(`📉 MAX DRAWDOWN trong 3y: $${maxDD.toFixed(2)} (từ peak equity)`);
  console.log(`📉 Worst uPnL seen:        ${maxNegativeUpnl >= 0 ? '+' : ''}$${maxNegativeUpnl.toFixed(2)}`);
  console.log(`💵 Max margin used:        $${maxMarginUsed.toFixed(2)}`);
  console.log(`💵 BUDGET CẦN (wallet min): ~$${budgetNeeded.toFixed(0)} USDT`);
  console.log(`   (= max abs(neg uPnL) + maint margin + $100 buffer)\n`);

  // Render HTML chart
  const W = 1800, Hp = 350, Hu = 200, He = 200, pad = 60, gap = 25;
  const totalH = Hp + gap + Hu + gap + He + 60;
  const tMin = equityCurve[0].t, tMax = equityCurve[equityCurve.length - 1].t;
  const tRange = tMax - tMin;
  const w = W - pad * 2;

  const xOf = (t: number) => pad + ((t - tMin) / tRange) * w;

  // Price chart
  const pMin = Math.min(...equityCurve.map(p => p.price));
  const pMax = Math.max(...equityCurve.map(p => p.price));
  const pRange = pMax - pMin;
  const yPriceOf = (p: number) => 30 + (Hp - pad) - ((p - pMin) / pRange) * (Hp - pad);

  // uPnL chart
  const uMin = Math.min(...equityCurve.map(p => p.uPnL), 0);
  const uMax = Math.max(...equityCurve.map(p => p.uPnL), 0);
  const uRange = (uMax - uMin) || 1;
  const yUOf = (u: number) => Hp + gap + 30 + (Hu - pad) - ((u - uMin) / uRange) * (Hu - pad);

  // Equity chart (uPnL - fees)
  const eMin = Math.min(...equityCurve.map(p => p.equity), 0);
  const eMax = Math.max(...equityCurve.map(p => p.equity), 0);
  const eRange = (eMax - eMin) || 1;
  const yEOf = (e: number) => Hp + gap + Hu + gap + 30 + (He - pad) - ((e - eMin) / eRange) * (He - pad);

  const priceLine = equityCurve.map(p => `${xOf(p.t).toFixed(1)},${yPriceOf(p.price).toFixed(1)}`).join(" ");
  const uLine = equityCurve.map(p => `${xOf(p.t).toFixed(1)},${yUOf(p.uPnL).toFixed(1)}`).join(" ");
  const eLine = equityCurve.map(p => `${xOf(p.t).toFixed(1)},${yEOf(p.equity).toFixed(1)}`).join(" ");

  // Add markers
  const addMarkers = divs.map(d => {
    const x = xOf(d.time);
    const y = yPriceOf(d.entryPrice);
    return `<polygon points="${x},${y - 5} ${x - 4},${y + 4} ${x + 4},${y + 4}" fill="#22c55e" opacity="0.8" />`;
  }).join("");

  const xLabels: string[] = [];
  for (let i = 0; i <= 12; i++) {
    const t = tMin + (tRange * i) / 12;
    const d = new Date(t);
    xLabels.push(`<text x="${xOf(t).toFixed(1)}" y="${totalH - 10}" fill="#888" font-size="10" font-family="monospace" text-anchor="middle">${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getFullYear()).slice(2)}</text>`);
  }

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Hedge01 Backtest</title>
<style>
  body { font-family: monospace; background: #0a0a1a; color: #e7e7e7; padding: 20px; }
  h1 { color: #f7931a; }
  .meta { background: #1a1a2a; padding: 14px; border-radius: 6px; margin-bottom: 16px; line-height: 1.8; }
  .stat { display: inline-block; padding: 8px 14px; background: #2a2a3a; border-radius: 4px; margin: 4px 8px 4px 0; }
  .green { color: #22c55e; font-weight: bold; }
  .red { color: #ef4444; font-weight: bold; }
  .orange { color: #f7931a; font-weight: bold; }
  .blue { color: #3b82f6; font-weight: bold; }
  svg { background: #0a0a1a; border: 1px solid #333; border-radius: 6px; }
</style></head><body>
<h1>📊 Hedge01 Backtest — Bullish Divergence ADD LONG · 3y BTC 1h</h1>
<div class="meta">
<b>Setup:</b> Mỗi bullish divergence (1h, RSI=14, pivot N=5) → ADD LONG ${MIN_QTY_BTC} BTC × price tại đó. KHÔNG close.<br>
<b>Period:</b> ${new Date(candles[0].time).toISOString().slice(0, 10)} → ${new Date(candles[candles.length - 1].time).toISOString().slice(0, 10)} (${candles.length.toLocaleString()} candles 1h)<br>
<b>Lev:</b> ${LEVERAGE}x · CROSS margin · Fee 0.05%/side · MMR ${(MAINT_MARGIN_RATE*100).toFixed(1)}%<br><br>

<div class="stat">Adds: <b>${totalAdds}</b></div>
<div class="stat">Total qty: <b>${totalQty.toFixed(4)} BTC</b></div>
<div class="stat">Avg entry: <b class="orange">$${avgEntry.toFixed(0)}</b></div>
<div class="stat">Cost basis: <b>$${totalNotionalAtEntry.toFixed(0)}</b></div>
<div class="stat">Final price: <b class="orange">$${finalPrice.toFixed(0)}</b></div>
<br>
<div class="stat">Final notional: <b>$${finalNotional.toFixed(0)}</b></div>
<div class="stat">Final margin: <b>$${finalMarginUsed.toFixed(2)}</b></div>
<div class="stat">Total fee: $${totalEntryFee.toFixed(2)}</div>
<div class="stat">💰 PnL nếu close hôm nay: <b class="${finalRealizedIfClose >= 0 ? 'green' : 'red'}">${finalRealizedIfClose >= 0 ? '+' : ''}$${finalRealizedIfClose.toFixed(2)}</b></div>
<br>
<div class="stat">📉 Max DD: <b class="red">$${maxDD.toFixed(2)}</b></div>
<div class="stat">📉 Worst uPnL: <b class="red">${maxNegativeUpnl >= 0 ? '+' : ''}$${maxNegativeUpnl.toFixed(2)}</b></div>
<div class="stat">💵 Max margin used: <b class="orange">$${maxMarginUsed.toFixed(2)}</b></div>
<div class="stat">💵 <b class="blue">BUDGET CẦN: ~$${budgetNeeded.toFixed(0)} USDT</b></div>
</div>

<svg width="${W}" height="${totalH}" viewBox="0 0 ${W} ${totalH}">
  <text x="${pad}" y="20" fill="#f7931a" font-size="13" font-weight="bold" font-family="monospace">PRICE 1h + ADD LONG markers ▲</text>
  <polyline points="${priceLine}" fill="none" stroke="#f7931a" stroke-width="1" opacity="0.85" />
  ${addMarkers}

  <line x1="0" y1="${Hp + gap / 2}" x2="${W}" y2="${Hp + gap / 2}" stroke="#333" stroke-width="0.5" />

  <text x="${pad}" y="${Hp + gap + 20}" fill="#3b82f6" font-size="13" font-weight="bold" font-family="monospace">uPnL (USDT)</text>
  <line x1="${pad}" y1="${yUOf(0)}" x2="${W - pad}" y2="${yUOf(0)}" stroke="#666" stroke-width="0.6" />
  <polyline points="${uLine}" fill="none" stroke="#3b82f6" stroke-width="1.2" opacity="0.9" />

  <line x1="0" y1="${Hp + gap + Hu + gap / 2}" x2="${W}" y2="${Hp + gap + Hu + gap / 2}" stroke="#333" stroke-width="0.5" />

  <text x="${pad}" y="${Hp + gap + Hu + gap + 20}" fill="#22c55e" font-size="13" font-weight="bold" font-family="monospace">EQUITY (uPnL - fees)</text>
  <line x1="${pad}" y1="${yEOf(0)}" x2="${W - pad}" y2="${yEOf(0)}" stroke="#666" stroke-width="0.6" />
  <polyline points="${eLine}" fill="none" stroke="#22c55e" stroke-width="1.2" opacity="0.9" />

  ${xLabels.join("")}
</svg>
</body></html>`;

  const outPath = join(__dirname, "..", "assets", "backtest_hedge01_divergence_3y.html");
  writeFileSync(outPath, html);
  console.log(`💾 HTML: ${outPath}`);
})();
