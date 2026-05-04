/**
 * backtest-boll-1h-hedge.ts (anh Tommy 2026-05-03)
 *
 * Rule:
 *   - TF 1H, BB(20, 2)
 *   - LONG khi giá CROSS XUỐNG lower BB → ADD LONG
 *   - SHORT khi giá CROSS LÊN upper BB → ADD SHORT
 *   - KHÔNG close — hold tới cuối
 *   - Cooldown 1h (mỗi 1H bar tối đa 1 ADD/side)
 *   - Capital $100k, $1000 notional/ADD, lev 125x cross hedge
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const INITIAL_CAPITAL = 100000;
const NOTIONAL_PER_ADD_USD = 1000;
const FEE_PER_SIDE_PCT = 0.05;
const MAINT_MARGIN_RATE = 0.004;
const TF = "1h";
const BB_PERIOD = 20;
const BB_STD = 2;

interface Candle { time: number; open: number; high: number; low: number; close: number; }
interface Net { qty: number; avg: number; }

function loadCache(tf: string): Candle[] {
  const p = join(__dirname, "..", ".cache", `binance-${tf}-3y.json`);
  if (!existsSync(p)) throw new Error(`Missing ${p}`);
  return JSON.parse(readFileSync(p, "utf8"));
}
function calcSMA(arr: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(arr.length).fill(null);
  if (arr.length < period) return out;
  let sum = 0; for (let i = 0; i < period; i++) sum += arr[i];
  out[period - 1] = sum / period;
  for (let i = period; i < arr.length; i++) { sum += arr[i] - arr[i - period]; out[i] = sum / period; }
  return out;
}
function calcStdev(arr: number[], period: number, sma: (number|null)[]): (number|null)[] {
  const out: (number|null)[] = new Array(arr.length).fill(null);
  for (let i = period - 1; i < arr.length; i++) {
    const m = sma[i]; if (m === null) continue;
    let sq = 0; for (let j = i - period + 1; j <= i; j++) sq += (arr[j] - m) ** 2;
    out[i] = Math.sqrt(sq / period);
  }
  return out;
}
function addNet(n: Net, qty: number, price: number): Net {
  const newQty = n.qty + qty;
  return { qty: newQty, avg: newQty > 0 ? (n.qty * n.avg + qty * price) / newQty : 0 };
}

function main() {
  const c1h = loadCache(TF);
  const c5 = loadCache("5m");
  const closes = c1h.map((b) => b.close);
  const sma = calcSMA(closes, BB_PERIOD);
  const sd = calcStdev(closes, BB_PERIOD, sma);

  let longNet: Net = { qty: 0, avg: 0 };
  let shortNet: Net = { qty: 0, avg: 0 };
  let wallet = INITIAL_CAPITAL;
  let totalFees = 0;
  let totalAddsLong = 0, totalAddsShort = 0;
  let liquidated = false, liqAtMs = 0;
  let peak = INITIAL_CAPITAL, trough = INITIAL_CAPITAL;
  const events: any[] = [];
  const bandLine: any[] = [];
  // Build events from 1H bars first
  for (let i = BB_PERIOD; i < c1h.length; i++) {
    const m = sma[i], s = sd[i]; if (m === null || s === null) continue;
    const upper = m + BB_STD * s, lower = m - BB_STD * s;
    if (i % 4 === 0) bandLine.push({ ts: c1h[i].time, mid: m, upper, lower });
    const pm = sma[i - 1], ps = sd[i - 1]; if (pm === null || ps === null) continue;
    const prevLower = pm - BB_STD * ps, prevUpper = pm + BB_STD * ps;
    const prevC = c1h[i - 1].close, curC = c1h[i].close;
    const ts = c1h[i].time;
    // Cross XUỐNG lower → LONG
    if (prevC >= prevLower && curC < lower) {
      const qty = NOTIONAL_PER_ADD_USD / curC;
      const fee = qty * curC * (FEE_PER_SIDE_PCT / 100);
      longNet = addNet(longNet, qty, curC);
      wallet -= fee; totalFees += fee; totalAddsLong++;
      events.push({ ts, kind: "ADD", side: "LONG", price: curC, qty, avgAfter: longNet.avg, bbLower: lower, bbUpper: upper, bbMid: m });
    }
    // Cross LÊN upper → SHORT
    if (prevC <= prevUpper && curC > upper) {
      const qty = NOTIONAL_PER_ADD_USD / curC;
      const fee = qty * curC * (FEE_PER_SIDE_PCT / 100);
      shortNet = addNet(shortNet, qty, curC);
      wallet -= fee; totalFees += fee; totalAddsShort++;
      events.push({ ts, kind: "ADD", side: "SHORT", price: curC, qty, avgAfter: shortNet.avg, bbLower: lower, bbUpper: upper, bbMid: m });
    }
  }

  // Walk 5m for accurate LIQ + peak/trough
  const eqStateByTs: any[] = []; // optional sample
  // Replay events on 5m timeline
  const evByTs = new Map<number, any[]>();
  for (const e of events) { const a = evByTs.get(e.ts) || []; a.push(e); evByTs.set(e.ts, a); }
  // Reset and walk
  longNet = { qty: 0, avg: 0 }; shortNet = { qty: 0, avg: 0 };
  wallet = INITIAL_CAPITAL; totalFees = 0; totalAddsLong = 0; totalAddsShort = 0;

  for (let i = 0; i < c5.length; i++) {
    const bar = c5[i];
    const evs = evByTs.get(bar.time);
    if (evs) for (const e of evs) {
      if (e.side === "LONG") {
        longNet = addNet(longNet, e.qty, e.price);
        wallet -= e.qty * e.price * (FEE_PER_SIDE_PCT / 100);
        totalFees += e.qty * e.price * (FEE_PER_SIDE_PCT / 100);
        totalAddsLong++;
      } else {
        shortNet = addNet(shortNet, e.qty, e.price);
        wallet -= e.qty * e.price * (FEE_PER_SIDE_PCT / 100);
        totalFees += e.qty * e.price * (FEE_PER_SIDE_PCT / 100);
        totalAddsShort++;
      }
    }
    let upnl = 0;
    if (longNet.qty > 0) upnl += longNet.qty * (bar.close - longNet.avg);
    if (shortNet.qty > 0) upnl += shortNet.qty * (shortNet.avg - bar.close);
    const eq = wallet + upnl;
    if (eq > peak) peak = eq; if (eq < trough) trough = eq;
    if (longNet.qty + shortNet.qty > 0) {
      const mm = (longNet.qty + shortNet.qty) * bar.close * MAINT_MARGIN_RATE;
      if (eq <= mm) { liquidated = true; liqAtMs = bar.time; break; }
    }
  }
  const lastPrice = c5[c5.length - 1].close;
  const finalUpnlLong = longNet.qty > 0 ? longNet.qty * (lastPrice - longNet.avg) : 0;
  const finalUpnlShort = shortNet.qty > 0 ? shortNet.qty * (shortNet.avg - lastPrice) : 0;
  const finalUpnl = finalUpnlLong + finalUpnlShort;
  const finalEq = wallet + finalUpnl;
  const roi = ((finalEq - INITIAL_CAPITAL) / INITIAL_CAPITAL) * 100;
  const maxDD = peak - trough;

  console.log(`[boll1h-hedge] TF=${TF} bb=${BB_PERIOD} std=${BB_STD} NO-CLOSE`);
  console.log(`  LIQ: ${liquidated ? "YES @ "+new Date(liqAtMs).toISOString() : "NO"}`);
  console.log(`  ADDs: LONG ${totalAddsLong}, SHORT ${totalAddsShort}`);
  console.log(`  Final LONG:  ${longNet.qty.toFixed(4)} @ $${longNet.avg.toFixed(0)} → uPnL ${finalUpnlLong>=0?"+":""}$${finalUpnlLong.toFixed(2)}`);
  console.log(`  Final SHORT: ${shortNet.qty.toFixed(4)} @ $${shortNet.avg.toFixed(0)} → uPnL ${finalUpnlShort>=0?"+":""}$${finalUpnlShort.toFixed(2)}`);
  console.log(`  Last price: $${lastPrice.toFixed(0)}`);
  console.log(`  Total uPnL: ${finalUpnl>=0?"+":""}$${finalUpnl.toFixed(2)}`);
  console.log(`  Wallet: $${wallet.toFixed(2)} · Fees: $${totalFees.toFixed(2)}`);
  console.log(`  Final EQUITY: $${finalEq.toFixed(2)} · ROI: ${roi>=0?"+":""}${roi.toFixed(2)}% · Max DD: $${maxDD.toFixed(2)}`);

  const priceLine: { ts: number; price: number }[] = [];
  const step = Math.max(1, Math.floor(c5.length / 4000));
  for (let i = 0; i < c5.length; i += step) priceLine.push({ ts: c5[i].time, price: c5[i].close });

  const out = {
    config: { tf: TF, period: BB_PERIOD, std: BB_STD, capital: INITIAL_CAPITAL, notional: NOTIONAL_PER_ADD_USD },
    period: { start: c5[0].time, end: c5[c5.length - 1].time },
    liquidated, liqAtMs,
    finalLong: longNet, finalShort: shortNet, lastPrice,
    finalUpnlLong, finalUpnlShort, finalUpnl,
    finalEq, wallet, roi, maxDD, peak, trough,
    totalAddsLong, totalAddsShort, totalFees,
    events, bandLine, priceLine,
  };
  writeFileSync(join(__dirname, "..", "assets", "backtest_boll_1h_hedge_3y.json"), JSON.stringify(out));
  console.log(`Saved → assets/backtest_boll_1h_hedge_3y.json`);
}

main();
