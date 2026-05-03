/**
 * backtest-tomihedge-15m.ts (anh Tommy 2026-05-02)
 *
 * TomiHedge rule = Binance HEDGE + CROSS:
 *   - CHỈ 2 NET positions song song: 1 LONG net + 1 SHORT net
 *   - Khi LONG signal fire → ADD vào LONG net:
 *       new_qty = old_qty + add_qty
 *       new_avg = (old_qty × old_avg + add_qty × current_price) / new_qty
 *   - Khi SHORT signal fire → ADD vào SHORT net (same formula)
 *   - PnL tính theo CHÊNH avg_entry vs current/exit price (KHÔNG per-entry)
 *   - Cross margin: wallet share, lời/lỗ 2 side bù trừ
 *
 * Signal: pivot detection 15m (local low → ADD LONG, local high → ADD SHORT)
 * Each ADD: $1 margin × 125x = $125 notional
 *
 * Output: equity curve + uPnL realtime + final PnL nếu close hết cuối period
 *
 * Usage:
 *   npx tsx tools/backtest-tomihedge-15m.ts                 # N=10 default, 3y
 *   npx tsx tools/backtest-tomihedge-15m.ts --N=5,10,20     # multi N compare
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const args = process.argv.slice(2);
const N_VALUES = (args.find((a) => a.startsWith("--N="))?.replace("--N=", "") || "5,10,20").split(",").map((s) => parseInt(s, 10));
const YEARS = parseInt(args.find((a) => a.startsWith("--years="))?.replace("--years=", "") || "3", 10);

const MARGIN_PER_ADD = 1;
const LEVERAGE = 125;
const NOTIONAL_PER_ADD = MARGIN_PER_ADD * LEVERAGE;
const FEE_PER_SIDE_PCT = 0.05;

interface Candle { time: number; open: number; high: number; low: number; close: number; }

function loadCache(): Candle[] {
  const p = join(__dirname, "..", ".cache", "binance-15m-3y.json");
  if (!existsSync(p)) throw new Error(`Missing ${p}`);
  return JSON.parse(readFileSync(p, "utf8"));
}

interface PivotEvent { confirmIdx: number; side: "LONG" | "SHORT"; entryPrice: number; time: number; }

function detectPivots(candles: Candle[], n: number): PivotEvent[] {
  const events: PivotEvent[] = [];
  for (let i = n; i < candles.length - n; i++) {
    const c = candles[i];
    let isLow = true, isHigh = true;
    for (let j = i - n; j <= i + n; j++) {
      if (j === i) continue;
      if (candles[j].low <= c.low) isLow = false;
      if (candles[j].high >= c.high) isHigh = false;
      if (!isLow && !isHigh) break;
    }
    // Entry @ confirm bar (i+n) close — REALISTIC, no look-ahead
    if (isLow) events.push({ confirmIdx: i + n, side: "LONG", entryPrice: candles[i + n].close, time: candles[i + n].time });
    else if (isHigh) events.push({ confirmIdx: i + n, side: "SHORT", entryPrice: candles[i + n].close, time: candles[i + n].time });
  }
  events.sort((a, b) => a.confirmIdx - b.confirmIdx);
  return events;
}

interface NetPos {
  qty: number;        // BTC
  avgEntry: number;   // weighted
  notionalAtEntry: number; // sum of (add_qty × add_price) — for fee tracking
}

function emptyNet(): NetPos { return { qty: 0, avgEntry: 0, notionalAtEntry: 0 }; }

function addToNet(net: NetPos, addQty: number, addPrice: number): NetPos {
  const newQty = net.qty + addQty;
  if (newQty <= 0) return emptyNet();
  const newAvg = (net.qty * net.avgEntry + addQty * addPrice) / newQty;
  return { qty: newQty, avgEntry: newAvg, notionalAtEntry: net.notionalAtEntry + addQty * addPrice };
}

interface BacktestResult {
  N: number;
  totalAdds: number;
  longAdds: number; shortAdds: number;
  longFinal: NetPos; shortFinal: NetPos;
  finalPrice: number;
  totalFee: number;
  uPnL_LONG_final: number;
  uPnL_SHORT_final: number;
  netPnL_final: number;       // sum 2 sides uPnL
  totalNetPnL_after_close: number; // sau khi close hết @ final price (giống realized)
  equityCurve: { t: number; longUpnl: number; shortUpnl: number; netUpnl: number; cumFee: number; equity: number }[];
}

function simulate(candles: Candle[], events: PivotEvent[], N: number): BacktestResult {
  let longNet = emptyNet();
  let shortNet = emptyNet();
  let totalFee = 0;
  let longAdds = 0, shortAdds = 0;
  const equityCurve: BacktestResult["equityCurve"] = [];

  // Pre-compute per add: qty = notional/price
  let evIdx = 0;
  // Sample equity every 100 candles
  const sampleStep = Math.max(1, Math.floor(candles.length / 1500));

  for (let i = 0; i < candles.length; i++) {
    // Process events firing AT this candle
    while (evIdx < events.length && events[evIdx].confirmIdx === i) {
      const ev = events[evIdx];
      const addQty = NOTIONAL_PER_ADD / ev.entryPrice;
      const fee = NOTIONAL_PER_ADD * (FEE_PER_SIDE_PCT / 100);
      totalFee += fee;
      if (ev.side === "LONG") {
        longNet = addToNet(longNet, addQty, ev.entryPrice);
        longAdds++;
      } else {
        shortNet = addToNet(shortNet, addQty, ev.entryPrice);
        shortAdds++;
      }
      evIdx++;
    }
    // Sample equity
    if (i % sampleStep === 0 || i === candles.length - 1) {
      const c = candles[i];
      const uL = longNet.qty * (c.close - longNet.avgEntry);
      const uS = shortNet.qty * (shortNet.avgEntry - c.close);
      const netUpnl = uL + uS;
      equityCurve.push({ t: c.time, longUpnl: uL, shortUpnl: uS, netUpnl, cumFee: totalFee, equity: netUpnl - totalFee });
    }
  }

  const finalPrice = candles[candles.length - 1].close;
  const uL = longNet.qty * (finalPrice - longNet.avgEntry);
  const uS = shortNet.qty * (shortNet.avgEntry - finalPrice);
  // Close all = realize uPnL + pay exit fee on remaining notional
  const closeFeeLONG = longNet.qty * finalPrice * (FEE_PER_SIDE_PCT / 100);
  const closeFeeSHORT = shortNet.qty * finalPrice * (FEE_PER_SIDE_PCT / 100);
  const totalNetPnL_after_close = uL + uS - totalFee - closeFeeLONG - closeFeeSHORT;

  return {
    N, totalAdds: longAdds + shortAdds, longAdds, shortAdds,
    longFinal: longNet, shortFinal: shortNet, finalPrice,
    totalFee, uPnL_LONG_final: uL, uPnL_SHORT_final: uS,
    netPnL_final: uL + uS,
    totalNetPnL_after_close,
    equityCurve,
  };
}

function renderHtml(results: BacktestResult[], periodStr: string): string {
  const W = 1600, H = 400, pad = 50;
  // Color per N
  const colors = ["#22c55e", "#f7931a", "#3b82f6", "#ef4444"];

  const allEquities = results.flatMap(r => r.equityCurve.map(p => p.equity));
  const eMin = Math.min(...allEquities, 0);
  const eMax = Math.max(...allEquities, 0);
  const eRange = (eMax - eMin) || 1;

  const allTs = results[0].equityCurve.map(p => p.t);
  const tMin = allTs[0], tMax = allTs[allTs.length - 1];
  const tRange = tMax - tMin;

  const w = W - pad * 2, h = H - pad * 2;
  const xOf = (t: number) => pad + ((t - tMin) / tRange) * w;
  const yOf = (e: number) => pad + h - ((e - eMin) / eRange) * h;

  const yZero = yOf(0);

  const polylines = results.map((r, idx) => {
    const pts = r.equityCurve.map(p => `${xOf(p.t).toFixed(1)},${yOf(p.equity).toFixed(1)}`).join(" ");
    return `<polyline points="${pts}" fill="none" stroke="${colors[idx]}" stroke-width="1.4" opacity="0.9" />`;
  }).join("");

  const ticks = [eMax, eMax * 0.5, 0, eMin * 0.5, eMin];
  const tickLines = ticks.map(e => `<line x1="${pad}" y1="${yOf(e).toFixed(1)}" x2="${W - pad}" y2="${yOf(e).toFixed(1)}" stroke="#333" stroke-width="0.4" stroke-dasharray="3,4" opacity="0.4" />`).join("");
  const tickLabels = ticks.map(e => `<text x="${W - pad + 4}" y="${yOf(e) + 4}" fill="#888" font-size="11" font-family="monospace">$${e.toFixed(0)}</text>`).join("");
  const zeroLine = `<line x1="${pad}" y1="${yZero}" x2="${W - pad}" y2="${yZero}" stroke="#888" stroke-width="0.8" />`;

  const xLabels: string[] = [];
  for (let i = 0; i <= 10; i++) {
    const t = tMin + (tRange * i) / 10;
    const d = new Date(t);
    xLabels.push(`<text x="${xOf(t).toFixed(1)}" y="${H - pad + 18}" fill="#888" font-size="10" font-family="monospace" text-anchor="middle">${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getFullYear()).slice(2)}</text>`);
  }

  const summary = results.map((r, idx) => `
    <div style="border-left: 3px solid ${colors[idx]}; padding-left: 10px; margin-bottom: 8px;">
      <h3 style="color: ${colors[idx]}; margin: 0 0 4px 0;">N=${r.N} pivot</h3>
      <div>Adds: ${r.totalAdds} (L${r.longAdds} / S${r.shortAdds})</div>
      <div>Final LONG net: <b>${r.longFinal.qty.toFixed(4)} BTC</b> @ avg <b>$${r.longFinal.avgEntry.toFixed(0)}</b></div>
      <div>Final SHORT net: <b>${r.shortFinal.qty.toFixed(4)} BTC</b> @ avg <b>$${r.shortFinal.avgEntry.toFixed(0)}</b></div>
      <div>Final price: <b>$${r.finalPrice.toFixed(0)}</b></div>
      <div>uPnL @ end: LONG <b style="color:${r.uPnL_LONG_final >= 0 ? '#22c55e' : '#ef4444'}">${r.uPnL_LONG_final >= 0 ? '+' : ''}$${r.uPnL_LONG_final.toFixed(0)}</b> · SHORT <b style="color:${r.uPnL_SHORT_final >= 0 ? '#22c55e' : '#ef4444'}">${r.uPnL_SHORT_final >= 0 ? '+' : ''}$${r.uPnL_SHORT_final.toFixed(0)}</b></div>
      <div>Total fee paid: $${r.totalFee.toFixed(2)}</div>
      <div style="margin-top:4px;font-size:14px;font-weight:bold;color:${r.totalNetPnL_after_close >= 0 ? '#22c55e' : '#ef4444'}">
        💰 PnL FINAL (close hết @ end): ${r.totalNetPnL_after_close >= 0 ? '+' : ''}$${r.totalNetPnL_after_close.toFixed(2)}
      </div>
    </div>
  `).join("");

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>TomiHedge backtest</title>
<style>
  body { font-family: monospace; background: #0a0a1a; color: #e7e7e7; padding: 20px; }
  h1 { color: #f7931a; }
  .meta { background: #1a1a2a; padding: 12px; border-radius: 6px; margin-bottom: 16px; }
  svg { background: #0a0a1a; border: 1px solid #333; border-radius: 6px; }
</style></head><body>
<h1>📊 TomiHedge — Pivot ADD-NET backtest 15m · ${periodStr}</h1>
<div class="meta">
<b>Rule:</b> Local LOW (N candles before/after) → ADD vào LONG net (weighted avg). Local HIGH → ADD vào SHORT net.<br>
Mỗi ADD: $${MARGIN_PER_ADD} × ${LEVERAGE}x = $${NOTIONAL_PER_ADD} notional. Fee 0.05%/side. KHÔNG close giữa chừng — accumulate đến cuối period.<br>
Equity curve = uPnL net (LONG + SHORT) − cumFee. Close hết cuối period để realize.
</div>

<svg width="${W}" height="${H + 30}" viewBox="0 0 ${W} ${H + 30}">
  ${tickLines}
  ${tickLabels}
  ${xLabels.join("")}
  ${zeroLine}
  ${polylines}
</svg>

<h2 style="color:#f7931a">Final state per N:</h2>
${summary}

<p style="color: #888; font-size: 11px; margin-top: 12px;">
  💡 Equity curve ở trên = uPnL chưa close. PnL FINAL = sau khi close cả 2 net @ price cuối.<br>
  Net direction (qty_L vs qty_S) → quyết định direction PnL theo giá BTC.
</p>
</body></html>`;
}

(async () => {
  console.log(`Loading 15m cache 3y...`);
  const all = loadCache();
  const cutoff = Date.now() - YEARS * 365 * 24 * 3600 * 1000;
  const candles = all.filter((c) => c.time >= cutoff);
  const periodStr = `${new Date(candles[0].time).toISOString().slice(0,10)} → ${new Date(candles[candles.length-1].time).toISOString().slice(0,10)} (${candles.length.toLocaleString()} candles 15m)`;
  console.log(`  ${periodStr}`);

  console.log(`\n=== TomiHedge ADD-NET backtest · ${YEARS}y · $${NOTIONAL_PER_ADD}/add · CROSS margin ===\n`);

  const results: BacktestResult[] = [];
  for (const N of N_VALUES) {
    const events = detectPivots(candles, N);
    const r = simulate(candles, events, N);
    results.push(r);
    console.log(`N=${N}:`);
    console.log(`  Adds: ${r.totalAdds} (LONG ${r.longAdds} · SHORT ${r.shortAdds})`);
    console.log(`  Final LONG net:  ${r.longFinal.qty.toFixed(4)} BTC @ avg $${r.longFinal.avgEntry.toFixed(0)}`);
    console.log(`  Final SHORT net: ${r.shortFinal.qty.toFixed(4)} BTC @ avg $${r.shortFinal.avgEntry.toFixed(0)}`);
    console.log(`  Final price:     $${r.finalPrice.toFixed(0)}`);
    console.log(`  uPnL @ end: LONG ${r.uPnL_LONG_final >= 0 ? '+' : ''}$${r.uPnL_LONG_final.toFixed(0)} · SHORT ${r.uPnL_SHORT_final >= 0 ? '+' : ''}$${r.uPnL_SHORT_final.toFixed(0)} = NET ${r.netPnL_final >= 0 ? '+' : ''}$${r.netPnL_final.toFixed(0)}`);
    console.log(`  Total fee paid:  $${r.totalFee.toFixed(2)}`);
    console.log(`  💰 PnL FINAL (close hết): ${r.totalNetPnL_after_close >= 0 ? '+' : ''}$${r.totalNetPnL_after_close.toFixed(2)}\n`);
  }

  const html = renderHtml(results, periodStr);
  const outPath = join(__dirname, "..", "assets", "backtest_tomihedge_15m.html");
  writeFileSync(outPath, html);
  console.log(`💾 HTML chart: ${outPath}`);
})();
