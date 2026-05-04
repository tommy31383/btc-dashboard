/**
 * backtest-hedge02.ts (anh Tommy 2026-05-03)
 *
 * HEDGE02 — TREND FOLLOW BUY-THE-DIP / SELL-THE-RIP, NO CLOSE.
 *
 * UP trend (1W close > prev close) → bias LONG:
 *   ANY 1 of 4 → ADD LONG (0.001 BTC × price):
 *     1. Stoch K < 10
 *     2. RSI < 20
 *     3. Gần support 1H/4H (±0.4%)
 *     4. DCA: giá < longNet.avgEntry × 0.98 (chỉ áp dụng khi đã có LONG)
 *
 * DOWN trend → bias SHORT (mirror): K>90, RSI>80, gần res, DCA giá > avg×1.02
 *
 * KHÔNG CLOSE — chạy đến cuối, output 2 NET (LONG + SHORT) gộp PnL.
 * Cooldown 1h giữa các ADD (mỗi side riêng).
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const MA_PERIOD_1H = 20;
const MA_DEVIATION_PCT = 2.0;
const RSI_PERIOD = 14;
const STOCH_PERIOD = 14;
const STOCH_K_OS = 10;
const STOCH_K_OB = 90;
const RSI_OS = 20;
const RSI_OB = 80;
const DCA_PCT = 2.0;            // giá lệch >2% so avgEntry → DCA
const COOLDOWN_MS = 60 * 60_000; // 1h
const MIN_QTY_BTC = 0.001;
const FEE_PER_SIDE_PCT = 0.05;
const MAINT_MARGIN_RATE = 0.004;
const INITIAL_CAPITAL = 100000;

interface Candle { time: number; open: number; high: number; low: number; close: number; }

function loadCache(tf: string): Candle[] {
  const p = join(__dirname, "..", ".cache", `binance-${tf}-3y.json`);
  if (!existsSync(p)) throw new Error(`Missing ${p}`);
  return JSON.parse(readFileSync(p, "utf8"));
}

function calcRSI(closes: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) g += ch; else l -= ch;
  }
  let ag = g / period, al = l / period;
  out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(ch, 0)) / period;
    al = (al * (period - 1) + Math.max(-ch, 0)) / period;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

function calcStochK(candles: Candle[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (candles[j].high > hi) hi = candles[j].high;
      if (candles[j].low < lo) lo = candles[j].low;
    }
    const range = hi - lo;
    out[i] = range === 0 ? 50 : ((candles[i].close - lo) / range) * 100;
  }
  return out;
}

function calcSMA(closes: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  out[period - 1] = sum / period;
  for (let i = period; i < closes.length; i++) {
    sum += closes[i] - closes[i - period];
    out[i] = sum / period;
  }
  return out;
}

function findIndexAtOrBefore(arr: { time: number }[], t: number): number {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (arr[m].time <= t) { ans = m; lo = m + 1; } else hi = m - 1;
  }
  return ans;
}

function getWeeklyTrend(c1w: Candle[], t: number): "UP" | "DOWN" | null {
  // Fix lookahead bug: c1w[idx] = tuần hiện tại CHƯA đóng (close là tương lai trong dataset).
  // So sánh 2 tuần ĐÃ đóng: idx-1 vs idx-2.
  const idx = findIndexAtOrBefore(c1w, t);
  if (idx < 2) return null;
  return c1w[idx - 1].close > c1w[idx - 2].close ? "UP" : "DOWN";
}

interface Net { qty: number; avg: number; }
function addNet(n: Net, qty: number, price: number): Net {
  const newQty = n.qty + qty;
  const newAvg = newQty > 0 ? (n.qty * n.avg + qty * price) / newQty : 0;
  return { qty: newQty, avg: newAvg };
}

function main() {
  console.log("[hedge02] Loading klines...");
  const c5 = loadCache("5m");
  const c15 = loadCache("15m");
  const c1h = loadCache("1h");
  const c4h = loadCache("4h");
  const c1w = loadCache("1w");
  console.log(`[hedge02] 5m=${c5.length}, 15m=${c15.length}, 1h=${c1h.length}, 4h=${c4h.length}, 1w=${c1w.length}`);

  // Pre-compute indicators
  const closes5 = c5.map((b) => b.close);
  const rsi5 = calcRSI(closes5, RSI_PERIOD);
  const stochK5 = calcStochK(c5, STOCH_PERIOD);

  // Fix 1: bỏ S/R, thêm MA20(1H) filter
  const closes1h = c1h.map((b) => b.close);
  const ma1h = calcSMA(closes1h, MA_PERIOD_1H);

  // State
  let longNet: Net = { qty: 0, avg: 0 };
  let shortNet: Net = { qty: 0, avg: 0 };
  let wallet = INITIAL_CAPITAL;
  let totalFees = 0;
  let totalAddsLong = 0;
  let totalAddsShort = 0;
  let lastAddLongMs = 0;
  let lastAddShortMs = 0;
  let liquidated = false;
  let liqAtMs = 0;

  // Equity curve sample mỗi ~100 bar 5m (~8h)
  const equity: { ts: number; eq: number; long: number; short: number; price: number }[] = [];
  const events: { ts: number; side: "LONG" | "SHORT"; price: number; reason: string; avgAfter: number }[] = [];

  // Skip warmup
  const start = Math.max(STOCH_PERIOD + 1, RSI_PERIOD + 1);
  for (let i = start; i < c5.length; i++) {
    const bar = c5[i];
    const price = bar.close;
    const k = stochK5[i];
    const r = rsi5[i];
    if (k === null || r === null) continue;

    const trend = getWeeklyTrend(c1w, bar.time);
    if (!trend) continue;

    // MA20(1H) at current bar.time
    const idx1h = findIndexAtOrBefore(c1h, bar.time);
    const maNow = idx1h >= 0 ? ma1h[idx1h] : null;
    if (maNow === null) continue;

    const longCool = bar.time - lastAddLongMs >= COOLDOWN_MS;
    const shortCool = bar.time - lastAddShortMs >= COOLDOWN_MS;

    if (trend === "UP" && longCool) {
      // 4 conditions OR (Fix 1: bỏ S/R, thêm MA filter)
      const c1 = k < STOCH_K_OS;                                      // oversold Stoch
      const c2 = r < RSI_OS;                                           // oversold RSI
      const c3 = price < maNow * (1 - MA_DEVIATION_PCT / 100);         // price below MA1H by >2%
      const c4 = longNet.qty > 0 && price < longNet.avg * (1 - DCA_PCT / 100);  // DCA
      if (c1 || c2 || c3 || c4) {
        const qty = MIN_QTY_BTC;
        const fee = qty * price * (FEE_PER_SIDE_PCT / 100);
        longNet = addNet(longNet, qty, price);
        wallet -= fee;
        totalFees += fee;
        totalAddsLong++;
        lastAddLongMs = bar.time;
        const reason = c1 ? "K<10" : c2 ? "RSI<20" : c3 ? "MA<-2%" : "DCA";
        events.push({ ts: bar.time, side: "LONG", price, reason, avgAfter: longNet.avg });
      }
    } else if (trend === "DOWN" && shortCool) {
      const c1 = k > STOCH_K_OB;
      const c2 = r > RSI_OB;
      const c3 = price > maNow * (1 + MA_DEVIATION_PCT / 100);         // price above MA1H by >2%
      const c4 = shortNet.qty > 0 && price > shortNet.avg * (1 + DCA_PCT / 100);
      if (c1 || c2 || c3 || c4) {
        const qty = MIN_QTY_BTC;
        const fee = qty * price * (FEE_PER_SIDE_PCT / 100);
        shortNet = addNet(shortNet, qty, price);
        wallet -= fee;
        totalFees += fee;
        totalAddsShort++;
        lastAddShortMs = bar.time;
        const reason = c1 ? "K>90" : c2 ? "RSI>80" : c3 ? "MA>+2%" : "DCA";
        events.push({ ts: bar.time, side: "SHORT", price, reason, avgAfter: shortNet.avg });
      }
    }

    // LIQ check (cross margin, NET direction)
    const netQty = longNet.qty - shortNet.qty;
    let upnl = 0;
    if (longNet.qty > 0) upnl += longNet.qty * (price - longNet.avg);
    if (shortNet.qty > 0) upnl += shortNet.qty * (shortNet.avg - price);
    const eq = wallet + upnl;
    if (Math.abs(netQty) > 1e-9) {
      const longNotional = longNet.qty * price;
      const shortNotional = shortNet.qty * price;
      const mm = (longNotional + shortNotional) * MAINT_MARGIN_RATE;
      if (eq <= mm) {
        liquidated = true;
        liqAtMs = bar.time;
        console.log(`[hedge02] LIQUIDATED at bar ${i} time=${new Date(bar.time).toISOString()} price=$${price.toFixed(0)} eq=$${eq.toFixed(2)}`);
        break;
      }
    }

    if (i % 100 === 0) {
      equity.push({ ts: bar.time, eq, long: longNet.qty, short: shortNet.qty, price });
    }
  }

  // Final stats
  const lastPrice = c5[c5.length - 1].close;
  let finalUpnlLong = longNet.qty > 0 ? longNet.qty * (lastPrice - longNet.avg) : 0;
  let finalUpnlShort = shortNet.qty > 0 ? shortNet.qty * (shortNet.avg - lastPrice) : 0;
  const finalUpnl = finalUpnlLong + finalUpnlShort;
  const finalEq = wallet + finalUpnl;
  const peak = equity.reduce((m, p) => Math.max(m, p.eq), INITIAL_CAPITAL);
  const trough = equity.reduce((m, p) => Math.min(m, p.eq), INITIAL_CAPITAL);
  const maxDD = peak - trough;
  const roi = ((finalEq - INITIAL_CAPITAL) / INITIAL_CAPITAL) * 100;
  const totalNotional = (longNet.qty + shortNet.qty) * lastPrice;
  const marginNeeded = totalNotional / 125;

  // Reason breakdown
  const reasonCount: Record<string, number> = {};
  for (const e of events) reasonCount[`${e.side}-${e.reason}`] = (reasonCount[`${e.side}-${e.reason}`] || 0) + 1;

  console.log("\n=== HEDGE02 BACKTEST RESULT ===");
  console.log(`Period: ${new Date(c5[start].time).toISOString().slice(0, 10)} → ${new Date(c5[c5.length - 1].time).toISOString().slice(0, 10)}`);
  console.log(`Initial capital: $${INITIAL_CAPITAL}`);
  console.log(`LIQUIDATED: ${liquidated ? `YES @ ${new Date(liqAtMs).toISOString()}` : "NO"}`);
  console.log(`Total ADDs: LONG ${totalAddsLong}, SHORT ${totalAddsShort}`);
  console.log(`Final LONG net: qty ${longNet.qty.toFixed(4)} BTC @ avg $${longNet.avg.toFixed(0)}`);
  console.log(`Final SHORT net: qty ${shortNet.qty.toFixed(4)} BTC @ avg $${shortNet.avg.toFixed(0)}`);
  console.log(`Last price: $${lastPrice.toFixed(0)}`);
  console.log(`uPnL LONG: ${finalUpnlLong >= 0 ? "+" : ""}$${finalUpnlLong.toFixed(2)}`);
  console.log(`uPnL SHORT: ${finalUpnlShort >= 0 ? "+" : ""}$${finalUpnlShort.toFixed(2)}`);
  console.log(`uPnL TOTAL: ${finalUpnl >= 0 ? "+" : ""}$${finalUpnl.toFixed(2)}`);
  console.log(`Wallet (after fees): $${wallet.toFixed(2)}`);
  console.log(`Final EQUITY: $${finalEq.toFixed(2)}`);
  console.log(`ROI: ${roi >= 0 ? "+" : ""}${roi.toFixed(2)}%`);
  console.log(`Max DD: $${maxDD.toFixed(2)} (peak $${peak.toFixed(2)} → trough $${trough.toFixed(2)})`);
  console.log(`Total fees: $${totalFees.toFixed(2)}`);
  console.log(`Total notional: $${totalNotional.toFixed(0)} → margin needed at 125x: $${marginNeeded.toFixed(2)}`);
  console.log(`Reason breakdown:`, reasonCount);

  const out = {
    config: { STOCH_K_OS, STOCH_K_OB, RSI_OS, RSI_OB, DCA_PCT, COOLDOWN_MS, MIN_QTY_BTC, INITIAL_CAPITAL },
    period: { start: c5[start].time, end: c5[c5.length - 1].time },
    liquidated, liqAtMs,
    finalLongNet: longNet,
    finalShortNet: shortNet,
    lastPrice,
    finalUpnl, finalEq, wallet, totalFees, roi, maxDD, peak, trough,
    totalAddsLong, totalAddsShort,
    totalNotional, marginNeeded125x: marginNeeded,
    reasonCount,
    equityCurve: equity.slice(-2000),  // cap để JSON nhẹ
    events,                              // FULL events cho chart
    // Price line decimated cho chart (khoảng 2000 points)
    priceLine: (() => {
      const out: { ts: number; price: number }[] = [];
      const step = Math.max(1, Math.floor(c5.length / 2000));
      for (let i = 0; i < c5.length; i += step) out.push({ ts: c5[i].time, price: c5[i].close });
      return out;
    })(),
    weeklyLine: c1w.map((b) => ({ ts: b.time, close: b.close })),
  };
  const outPath = join(__dirname, "..", "assets", "backtest_hedge02_3y.json");
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\n[hedge02] Saved → ${outPath}`);
}

main();
