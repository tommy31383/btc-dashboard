/**
 * backtest-hedge01-chart.ts (anh Tommy 2026-05-03)
 *
 * HEDGE01 — TREND FOLLOW MULTI-TF (replica của rules/hedge01.ts):
 *   - Weekly trend: close[w-1] > close[w-2] = UP (so 2 tuần ĐÃ đóng, no lookahead)
 *   - UP: ADD LONG khi 5m close TOUCH support (1d/4h/1h/15m swing lows ±0.4%)
 *   - DOWN: ADD SHORT khi 5m close TOUCH resistance
 *   - Trend FLIP → CLOSE ALL opposite side
 *   - 0.001 BTC/ADD, cooldown 1h
 *   - Capital $100k
 *
 * Output JSON: priceLine + events (ADD + CLOSE) + stats → chart HTML render.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const PIVOT_N = 10;
const TOUCH_PCT = 0.4;
const COOLDOWN_MS = 60 * 60_000;
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
  return { lows: lows.sort((a, b) => a - b), highs: highs.sort((a, b) => a - b) };
}

function nearLevel(price: number, levels: number[]): boolean {
  const tol = price * (TOUCH_PCT / 100);
  for (const lv of levels) {
    if (Math.abs(lv - price) <= tol) return true;
  }
  return false;
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
  console.log("[hedge01] Loading klines...");
  const c5 = loadCache("5m");
  const c15 = loadCache("15m");
  const c1h = loadCache("1h");
  const c4h = loadCache("4h");
  const c1d = loadCache("1d");
  const c1w = loadCache("1w");
  console.log(`[hedge01] 5m=${c5.length}, 15m=${c15.length}, 1h=${c1h.length}, 4h=${c4h.length}, 1d=${c1d.length}, 1w=${c1w.length}`);

  // S/R precompute (full history, sẽ filter live)
  const sr15 = detectSwingLevels(c15, PIVOT_N);
  const sr1h = detectSwingLevels(c1h, PIVOT_N);
  const sr4h = detectSwingLevels(c4h, PIVOT_N);
  const sr1d = detectSwingLevels(c1d, PIVOT_N);
  const supports = [...sr15.lows, ...sr1h.lows, ...sr4h.lows, ...sr1d.lows];
  const resistances = [...sr15.highs, ...sr1h.highs, ...sr4h.highs, ...sr1d.highs];

  let longNet: Net = { qty: 0, avg: 0 };
  let shortNet: Net = { qty: 0, avg: 0 };
  let wallet = INITIAL_CAPITAL;
  let totalFees = 0;
  let totalAddsLong = 0, totalAddsShort = 0;
  let totalCloses = 0;
  let totalRealizedPnl = 0;
  let lastAddLongMs = 0, lastAddShortMs = 0;
  let liquidated = false, liqAtMs = 0;
  let prevTrend: "UP" | "DOWN" | null = null;

  const equity: { ts: number; eq: number; long: number; short: number; price: number }[] = [];
  const events: { ts: number; kind: "ADD" | "CLOSE"; side: "LONG" | "SHORT"; price: number; qty: number; avgAfter: number; realizedPnl?: number }[] = [];

  for (let i = 100; i < c5.length; i++) {
    const bar = c5[i];
    const price = bar.close;

    const trend = getWeeklyTrend(c1w, bar.time);
    if (!trend) continue;

    // Trend flip → CLOSE opposite side
    if (prevTrend && trend !== prevTrend) {
      // Close opposite side
      if (trend === "UP" && shortNet.qty > 0) {
        const realized = shortNet.qty * (shortNet.avg - price);
        const fee = shortNet.qty * price * (FEE_PER_SIDE_PCT / 100);
        wallet += realized - fee;
        totalRealizedPnl += realized;
        totalFees += fee;
        totalCloses++;
        events.push({ ts: bar.time, kind: "CLOSE", side: "SHORT", price, qty: shortNet.qty, avgAfter: shortNet.avg, realizedPnl: realized - fee });
        shortNet = { qty: 0, avg: 0 };
      } else if (trend === "DOWN" && longNet.qty > 0) {
        const realized = longNet.qty * (price - longNet.avg);
        const fee = longNet.qty * price * (FEE_PER_SIDE_PCT / 100);
        wallet += realized - fee;
        totalRealizedPnl += realized;
        totalFees += fee;
        totalCloses++;
        events.push({ ts: bar.time, kind: "CLOSE", side: "LONG", price, qty: longNet.qty, avgAfter: longNet.avg, realizedPnl: realized - fee });
        longNet = { qty: 0, avg: 0 };
      }
    }
    prevTrend = trend;

    // Entry
    const longCool = bar.time - lastAddLongMs >= COOLDOWN_MS;
    const shortCool = bar.time - lastAddShortMs >= COOLDOWN_MS;
    if (trend === "UP" && longCool && shortNet.qty === 0) {
      if (nearLevel(price, supports)) {
        const qty = MIN_QTY_BTC;
        const fee = qty * price * (FEE_PER_SIDE_PCT / 100);
        longNet = addNet(longNet, qty, price);
        wallet -= fee; totalFees += fee; totalAddsLong++; lastAddLongMs = bar.time;
        events.push({ ts: bar.time, kind: "ADD", side: "LONG", price, qty, avgAfter: longNet.avg });
      }
    } else if (trend === "DOWN" && shortCool && longNet.qty === 0) {
      if (nearLevel(price, resistances)) {
        const qty = MIN_QTY_BTC;
        const fee = qty * price * (FEE_PER_SIDE_PCT / 100);
        shortNet = addNet(shortNet, qty, price);
        wallet -= fee; totalFees += fee; totalAddsShort++; lastAddShortMs = bar.time;
        events.push({ ts: bar.time, kind: "ADD", side: "SHORT", price, qty, avgAfter: shortNet.avg });
      }
    }

    // LIQ check
    let upnl = 0;
    if (longNet.qty > 0) upnl += longNet.qty * (price - longNet.avg);
    if (shortNet.qty > 0) upnl += shortNet.qty * (shortNet.avg - price);
    const eq = wallet + upnl;
    const netQty = longNet.qty - shortNet.qty;
    if (Math.abs(netQty) > 1e-9) {
      const mm = (longNet.qty + shortNet.qty) * price * MAINT_MARGIN_RATE;
      if (eq <= mm) {
        liquidated = true; liqAtMs = bar.time;
        console.log(`[hedge01] LIQ at ${new Date(bar.time).toISOString()} eq=${eq.toFixed(2)}`);
        break;
      }
    }
    if (i % 100 === 0) equity.push({ ts: bar.time, eq, long: longNet.qty, short: shortNet.qty, price });
  }

  const lastPrice = c5[c5.length - 1].close;
  const finalUpnlLong = longNet.qty > 0 ? longNet.qty * (lastPrice - longNet.avg) : 0;
  const finalUpnlShort = shortNet.qty > 0 ? shortNet.qty * (shortNet.avg - lastPrice) : 0;
  const finalUpnl = finalUpnlLong + finalUpnlShort;
  const finalEq = wallet + finalUpnl;
  const peak = equity.reduce((m, p) => Math.max(m, p.eq), INITIAL_CAPITAL);
  const trough = equity.reduce((m, p) => Math.min(m, p.eq), INITIAL_CAPITAL);
  const maxDD = peak - trough;
  const roi = ((finalEq - INITIAL_CAPITAL) / INITIAL_CAPITAL) * 100;

  console.log("\n=== HEDGE01 RESULT ===");
  console.log(`LIQUIDATED: ${liquidated ? "YES @ " + new Date(liqAtMs).toISOString() : "NO"}`);
  console.log(`ADDs: LONG ${totalAddsLong}, SHORT ${totalAddsShort}, CLOSES ${totalCloses}`);
  console.log(`Realized PnL: ${totalRealizedPnl >= 0 ? "+" : ""}$${totalRealizedPnl.toFixed(2)}`);
  console.log(`Final LONG: ${longNet.qty.toFixed(4)} @ $${longNet.avg.toFixed(0)}`);
  console.log(`Final SHORT: ${shortNet.qty.toFixed(4)} @ $${shortNet.avg.toFixed(0)}`);
  console.log(`uPnL TOTAL: ${finalUpnl >= 0 ? "+" : ""}$${finalUpnl.toFixed(2)}`);
  console.log(`Wallet: $${wallet.toFixed(2)}, Equity: $${finalEq.toFixed(2)}, ROI: ${roi >= 0 ? "+" : ""}${roi.toFixed(2)}%`);
  console.log(`Max DD: $${maxDD.toFixed(2)}, Fees: $${totalFees.toFixed(2)}`);

  const out = {
    config: { PIVOT_N, TOUCH_PCT, COOLDOWN_MS, MIN_QTY_BTC, INITIAL_CAPITAL },
    period: { start: c5[100].time, end: c5[c5.length - 1].time },
    liquidated, liqAtMs,
    finalLongNet: longNet, finalShortNet: shortNet, lastPrice,
    finalUpnl, finalEq, wallet, totalFees, roi, maxDD, peak, trough,
    totalAddsLong, totalAddsShort, totalCloses, totalRealizedPnl,
    events,
    priceLine: (() => {
      const out: { ts: number; price: number }[] = [];
      const step = Math.max(1, Math.floor(c5.length / 2000));
      for (let i = 0; i < c5.length; i += step) out.push({ ts: c5[i].time, price: c5[i].close });
      return out;
    })(),
  };
  const outPath = join(__dirname, "..", "assets", "backtest_hedge01_3y.json");
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\n[hedge01] Saved → ${outPath}`);
}

main();
