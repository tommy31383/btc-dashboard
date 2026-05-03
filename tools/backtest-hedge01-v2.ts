/**
 * backtest-hedge01-v2.ts (anh Tommy 2026-05-03)
 *
 * Hedge01 v2:
 *   - Entry: BULLISH divergence 1h (price LL + RSI HL) → ADD LONG (0.001 BTC × price)
 *   - Close: BEARISH divergence 4h (price HH + RSI LH) → CLOSE ALL LONG net
 *   - Lev 125x, cross margin
 *
 * Output: equity curve + max DD + budget cần + PnL realized
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const PIVOT_N_1H = 5;
const PIVOT_N_4H = 5;
const RSI_PERIOD = 14;
const MAX_BARS_BETWEEN = 100;

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
    for (let j = i - n; j <= i + n; j++) { if (j === i) continue; if (candles[j].low <= candles[i].low) { isLow = false; break; } }
    if (isLow) lows.push(i);
  }
  return lows;
}

function detectSwingHighs(candles: Candle[], n: number): number[] {
  const highs: number[] = [];
  for (let i = n; i < candles.length - n; i++) {
    let isHigh = true;
    for (let j = i - n; j <= i + n; j++) { if (j === i) continue; if (candles[j].high >= candles[i].high) { isHigh = false; break; } }
    if (isHigh) highs.push(i);
  }
  return highs;
}

interface Event { confirmTime: number; confirmPrice: number; }

function detectBullishDiv(candles: Candle[], n: number): Event[] {
  const closes = candles.map(c => c.close);
  const rsi = calcRSI(closes, RSI_PERIOD);
  const swings = detectSwingLows(candles, n);
  const events: Event[] = [];
  for (let i = 1; i < swings.length; i++) {
    const idx2 = swings[i], idx1 = swings[i - 1];
    if (idx2 - idx1 > MAX_BARS_BETWEEN) continue;
    const r1 = rsi[idx1], r2 = rsi[idx2];
    if (r1 === null || r2 === null) continue;
    if (candles[idx2].low < candles[idx1].low && r2 > r1) {
      const confirmIdx = idx2 + n;
      if (confirmIdx >= candles.length) continue;
      events.push({ confirmTime: candles[confirmIdx].time, confirmPrice: candles[confirmIdx].close });
    }
  }
  return events;
}

function detectBearishDiv(candles: Candle[], n: number): Event[] {
  const closes = candles.map(c => c.close);
  const rsi = calcRSI(closes, RSI_PERIOD);
  const swings = detectSwingHighs(candles, n);
  const events: Event[] = [];
  for (let i = 1; i < swings.length; i++) {
    const idx2 = swings[i], idx1 = swings[i - 1];
    if (idx2 - idx1 > MAX_BARS_BETWEEN) continue;
    const r1 = rsi[idx1], r2 = rsi[idx2];
    if (r1 === null || r2 === null) continue;
    // Bearish div: price HH + RSI LH
    if (candles[idx2].high > candles[idx1].high && r2 < r1) {
      const confirmIdx = idx2 + n;
      if (confirmIdx >= candles.length) continue;
      events.push({ confirmTime: candles[confirmIdx].time, confirmPrice: candles[confirmIdx].close });
    }
  }
  return events;
}

(async () => {
  console.log(`Loading 1h + 4h caches 3y...`);
  const c1h = loadCache("1h");
  const c4h = loadCache("4h");
  console.log(`  1h: ${c1h.length.toLocaleString()} · 4h: ${c4h.length.toLocaleString()}`);

  const bullEvents = detectBullishDiv(c1h, PIVOT_N_1H);
  const bearEvents = detectBearishDiv(c4h, PIVOT_N_4H);
  console.log(`\n  Bullish div 1h: ${bullEvents.length} entries`);
  console.log(`  Bearish div 4h: ${bearEvents.length} close signals\n`);

  // Merge events sorted by time
  type Ev = { time: number; price: number; kind: "ADD" | "CLOSE_ALL" };
  const events: Ev[] = [
    ...bullEvents.map(e => ({ time: e.confirmTime, price: e.confirmPrice, kind: "ADD" as const })),
    ...bearEvents.map(e => ({ time: e.confirmTime, price: e.confirmPrice, kind: "CLOSE_ALL" as const })),
  ].sort((a, b) => a.time - b.time);

  // Simulate
  let qty = 0, costBasis = 0;
  let realizedPnL = 0, totalFee = 0;
  let totalAdds = 0, totalCloses = 0;
  let wins = 0, losses = 0;
  const trades: { entryTime: number; closeTime: number; addsThisCycle: number; avgEntry: number; closePrice: number; pnl: number; }[] = [];
  let cycleAdds = 0;
  let cycleStart = 0;

  // Track equity for max DD using all 1h candles
  let evIdx = 0;
  const equityCurve: { t: number; price: number; qty: number; uPnL: number; equity: number; realized: number }[] = [];
  const sampleStep = Math.max(1, Math.floor(c1h.length / 1500));
  let peakEquity = 0, maxDD = 0;
  let maxNegUpnl = 0, maxMargin = 0;

  for (let i = 0; i < c1h.length; i++) {
    const t = c1h[i].time;
    const price = c1h[i].close;
    while (evIdx < events.length && events[evIdx].time <= t) {
      const ev = events[evIdx];
      if (ev.kind === "ADD") {
        if (qty === 0) cycleStart = ev.time;
        const addQty = MIN_QTY_BTC;
        const addNotional = addQty * ev.price;
        const fee = addNotional * (FEE_PER_SIDE_PCT / 100);
        qty += addQty;
        costBasis += addNotional;
        totalFee += fee;
        totalAdds++;
        cycleAdds++;
      } else if (ev.kind === "CLOSE_ALL" && qty > 0) {
        const avgEntry = costBasis / qty;
        const exitNotional = qty * ev.price;
        const exitFee = exitNotional * (FEE_PER_SIDE_PCT / 100);
        const grossPnL = qty * (ev.price - avgEntry);
        const netPnL = grossPnL - exitFee; // entry fees already in totalFee
        realizedPnL += grossPnL;
        totalFee += exitFee;
        totalCloses++;
        if (netPnL >= 0) wins++; else losses++;
        trades.push({ entryTime: cycleStart, closeTime: ev.time, addsThisCycle: cycleAdds, avgEntry, closePrice: ev.price, pnl: netPnL });
        qty = 0; costBasis = 0; cycleAdds = 0;
      }
      evIdx++;
    }
    if (i % sampleStep === 0 || i === c1h.length - 1) {
      const avgE = qty > 0 ? costBasis / qty : 0;
      const uPnL = qty * (price - avgE);
      const eq = realizedPnL + uPnL - totalFee;
      const margin = (qty * price) / LEVERAGE;
      equityCurve.push({ t, price, qty, uPnL, equity: eq, realized: realizedPnL });
      if (eq > peakEquity) peakEquity = eq;
      const dd = peakEquity - eq;
      if (dd > maxDD) maxDD = dd;
      if (uPnL < maxNegUpnl) maxNegUpnl = uPnL;
      if (margin > maxMargin) maxMargin = margin;
    }
  }

  const finalPrice = c1h[c1h.length - 1].close;
  const finalAvgEntry = qty > 0 ? costBasis / qty : 0;
  const finalUPnL = qty * (finalPrice - finalAvgEntry);
  const closeAllExitFee = qty * finalPrice * (FEE_PER_SIDE_PCT / 100);
  const finalIfClose = realizedPnL + finalUPnL - totalFee - closeAllExitFee;
  const budgetNeeded = Math.abs(maxNegUpnl) + maxMargin * MAINT_MARGIN_RATE * LEVERAGE + 100;

  console.log(`=== HEDGE01 v2: bull div 1h → ADD · bear div 4h → CLOSE ALL ===\n`);
  console.log(`Total ADDs:      ${totalAdds}`);
  console.log(`Total CLOSEs:    ${totalCloses} (cycles)`);
  console.log(`  Wins (close +): ${wins}`);
  console.log(`  Losses (close -): ${losses}`);
  console.log(`  Win rate:       ${trades.length > 0 ? (wins / trades.length * 100).toFixed(1) : 0}%`);
  console.log(`Realized PnL:    $${realizedPnL.toFixed(2)} (gross, all closed cycles)`);
  console.log(`Total fee paid:  $${totalFee.toFixed(2)}\n`);
  console.log(`Position còn OPEN:`);
  console.log(`  qty: ${qty.toFixed(4)} BTC · avg entry $${finalAvgEntry.toFixed(0)} · uPnL ${finalUPnL >= 0 ? '+' : ''}$${finalUPnL.toFixed(2)}\n`);
  console.log(`💰 PnL hôm nay (close hết @ $${finalPrice.toFixed(0)}): ${finalIfClose >= 0 ? '+' : ''}$${finalIfClose.toFixed(2)}`);
  console.log(`📉 Max DD: $${maxDD.toFixed(2)}`);
  console.log(`📉 Worst uPnL seen: $${maxNegUpnl.toFixed(2)}`);
  console.log(`💵 Max margin: $${maxMargin.toFixed(2)}`);
  console.log(`💵 BUDGET CẦN: ~$${budgetNeeded.toFixed(0)}\n`);

  // Trade summary
  if (trades.length > 0) {
    console.log(`=== TRADE-LEVEL SUMMARY ===`);
    const avgPnL = trades.reduce((s, t) => s + t.pnl, 0) / trades.length;
    const bestTrade = [...trades].sort((a, b) => b.pnl - a.pnl)[0];
    const worstTrade = [...trades].sort((a, b) => a.pnl - b.pnl)[0];
    console.log(`Avg pnl/cycle:   $${avgPnL.toFixed(2)}`);
    console.log(`Best cycle:      $${bestTrade.pnl.toFixed(2)} (${bestTrade.addsThisCycle} adds)`);
    console.log(`Worst cycle:     $${worstTrade.pnl.toFixed(2)} (${worstTrade.addsThisCycle} adds)`);
    console.log(`Avg adds/cycle:  ${(trades.reduce((s, t) => s + t.addsThisCycle, 0) / trades.length).toFixed(1)}\n`);
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

  const addMarkers = bullEvents.map(e => {
    const x = xOf(e.confirmTime); const y = yPriceOf(e.confirmPrice);
    return `<polygon points="${x},${y - 5} ${x - 4},${y + 4} ${x + 4},${y + 4}" fill="#22c55e" opacity="0.85" />`;
  }).join("");
  const closeMarkers = bearEvents.map(e => {
    const x = xOf(e.confirmTime); const y = yPriceOf(e.confirmPrice);
    return `<polygon points="${x},${y + 5} ${x - 4},${y - 4} ${x + 4},${y - 4}" fill="#ef4444" opacity="0.85" />`;
  }).join("");

  const xLabels: string[] = [];
  for (let i = 0; i <= 12; i++) {
    const t = tMin + (tRange * i) / 12;
    const d = new Date(t);
    xLabels.push(`<text x="${xOf(t).toFixed(1)}" y="${totalH - 10}" fill="#888" font-size="10" font-family="monospace" text-anchor="middle">${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getFullYear()).slice(2)}</text>`);
  }

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Hedge01 v2</title>
<style>body{font-family:monospace;background:#0a0a1a;color:#e7e7e7;padding:20px}h1{color:#f7931a}.meta{background:#1a1a2a;padding:14px;border-radius:6px;margin-bottom:16px;line-height:1.8}.stat{display:inline-block;padding:8px 14px;background:#2a2a3a;border-radius:4px;margin:4px 8px 4px 0}.green{color:#22c55e;font-weight:bold}.red{color:#ef4444;font-weight:bold}.orange{color:#f7931a;font-weight:bold}.blue{color:#3b82f6;font-weight:bold}svg{background:#0a0a1a;border:1px solid #333;border-radius:6px}</style></head><body>
<h1>📊 Hedge01 v2 — bull div 1h → ADD LONG · bear div 4h → CLOSE ALL · 3y BTC</h1>
<div class="meta">
<b>Period:</b> ${new Date(c1h[0].time).toISOString().slice(0,10)} → ${new Date(c1h[c1h.length-1].time).toISOString().slice(0,10)}<br>
<b>Setup:</b> ADD 0.001 BTC mỗi bullish div 1h. CLOSE TOÀN BỘ khi bear div 4h. Lev 125x cross.<br><br>
<div class="stat">Adds: <b>${totalAdds}</b></div>
<div class="stat">Cycles closed: <b>${totalCloses}</b></div>
<div class="stat">WR: <b>${trades.length > 0 ? (wins/trades.length*100).toFixed(1) : 0}%</b> (${wins}W/${losses}L)</div>
<div class="stat">Realized PnL: <b class="${realizedPnL >= 0 ? 'green' : 'red'}">${realizedPnL >= 0 ? '+' : ''}$${realizedPnL.toFixed(2)}</b></div>
<div class="stat">Total fee: $${totalFee.toFixed(2)}</div><br>
<div class="stat">Open qty: <b>${qty.toFixed(4)} BTC</b> @ avg <b>$${finalAvgEntry.toFixed(0)}</b></div>
<div class="stat">uPnL: <b class="${finalUPnL >= 0 ? 'green' : 'red'}">${finalUPnL >= 0 ? '+' : ''}$${finalUPnL.toFixed(2)}</b></div>
<div class="stat">💰 <b>PnL FINAL @ $${finalPrice.toFixed(0)}: <span class="${finalIfClose >= 0 ? 'green' : 'red'}">${finalIfClose >= 0 ? '+' : ''}$${finalIfClose.toFixed(2)}</span></b></div><br>
<div class="stat">📉 Max DD: <b class="red">$${maxDD.toFixed(2)}</b></div>
<div class="stat">📉 Worst uPnL: <b class="red">$${maxNegUpnl.toFixed(2)}</b></div>
<div class="stat">💵 Max margin: $${maxMargin.toFixed(2)}</div>
<div class="stat">💵 <b class="blue">BUDGET CẦN: ~$${budgetNeeded.toFixed(0)} USDT</b></div>
</div>
<svg width="${W}" height="${totalH}" viewBox="0 0 ${W} ${totalH}">
<text x="${pad}" y="20" fill="#f7931a" font-size="13" font-weight="bold" font-family="monospace">PRICE 1h · ▲ ADD bull div 1h · ▼ CLOSE bear div 4h</text>
<polyline points="${priceLine}" fill="none" stroke="#f7931a" stroke-width="1" opacity="0.85" />
${addMarkers}
${closeMarkers}
<line x1="0" y1="${Hp+gap/2}" x2="${W}" y2="${Hp+gap/2}" stroke="#333" stroke-width="0.5" />
<text x="${pad}" y="${Hp+gap+20}" fill="#3b82f6" font-size="13" font-weight="bold" font-family="monospace">uPnL (USDT) — open position only</text>
<line x1="${pad}" y1="${yUOf(0)}" x2="${W-pad}" y2="${yUOf(0)}" stroke="#666" stroke-width="0.6" />
<polyline points="${uLine}" fill="none" stroke="#3b82f6" stroke-width="1.2" opacity="0.9" />
<line x1="0" y1="${Hp+gap+Hu+gap/2}" x2="${W}" y2="${Hp+gap+Hu+gap/2}" stroke="#333" stroke-width="0.5" />
<text x="${pad}" y="${Hp+gap+Hu+gap+20}" fill="#22c55e" font-size="13" font-weight="bold" font-family="monospace">EQUITY (realized + uPnL - fees)</text>
<line x1="${pad}" y1="${yEOf(0)}" x2="${W-pad}" y2="${yEOf(0)}" stroke="#666" stroke-width="0.6" />
<polyline points="${eLine}" fill="none" stroke="#22c55e" stroke-width="1.2" opacity="0.9" />
${xLabels.join("")}
</svg></body></html>`;

  const outPath = join(__dirname, "..", "assets", "backtest_hedge01_v2.html");
  writeFileSync(outPath, html);
  console.log(`💾 HTML: ${outPath}`);
})();
