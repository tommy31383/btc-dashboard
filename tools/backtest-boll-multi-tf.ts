/**
 * backtest-boll-multi-tf.ts (anh Tommy 2026-05-03)
 *
 * Run BB(20,2) NO-CLOSE LONG+SHORT trên ALL TF: 15m, 1h, 4h, 1d
 * Output: 1 JSON với 4 dataset → UI selector switch TF
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const INITIAL_CAPITAL = 100000;
const NOTIONAL_PER_ADD_USD = 1000;
const FEE_PER_SIDE_PCT = 0.05;
const MAINT_MARGIN_RATE = 0.004;
const BB_PERIOD = 20;
const BB_STD = 2;
const TF_LIST = ["15m", "1h", "4h", "1d", "1w"];

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

function runTF(tf: string, c5: Candle[]) {
  const candles = loadCache(tf);
  const closes = candles.map((b) => b.close);
  const sma = calcSMA(closes, BB_PERIOD);
  const sd = calcStdev(closes, BB_PERIOD, sma);

  const events: any[] = [];
  const bandLine: any[] = [];
  // OPTION 2 (anh Tommy): WICK touch band → fire mỗi bar
  //   - LONG: low <= lower band (bóng dưới chạm/xuyên dưới)
  //   - SHORT: high >= upper band (bóng trên chạm/xuyên trên)
  // Giá entry = close của bar đó (giá thực sau khi wick).
  for (let i = BB_PERIOD; i < candles.length; i++) {
    const m = sma[i], s = sd[i]; if (m === null || s === null) continue;
    const upper = m + BB_STD * s, lower = m - BB_STD * s;
    bandLine.push({ ts: candles[i].time, mid: m, upper, lower });
    const bar = candles[i];
    const ts = bar.time;
    if (bar.low <= lower) {
      events.push({ ts, kind: "ADD", side: "LONG", price: bar.close, bbLower: lower, bbUpper: upper, bbMid: m });
    }
    if (bar.high >= upper) {
      events.push({ ts, kind: "ADD", side: "SHORT", price: bar.close, bbLower: lower, bbUpper: upper, bbMid: m });
    }
  }

  // Replay events on c5 timeline for accurate LIQ + final
  const evByTs = new Map<number, any[]>();
  for (const e of events) { const a = evByTs.get(e.ts) || []; a.push(e); evByTs.set(e.ts, a); }
  let longNet: Net = { qty: 0, avg: 0 };
  let shortNet: Net = { qty: 0, avg: 0 };
  let wallet = INITIAL_CAPITAL;
  let totalFees = 0, totalAddsLong = 0, totalAddsShort = 0;
  let liquidated = false, liqAtMs = 0;
  let peak = INITIAL_CAPITAL, trough = INITIAL_CAPITAL;
  for (let i = 0; i < c5.length; i++) {
    const bar = c5[i];
    const evs = evByTs.get(bar.time);
    if (evs) for (const e of evs) {
      const qty = NOTIONAL_PER_ADD_USD / e.price;
      const fee = qty * e.price * (FEE_PER_SIDE_PCT / 100);
      if (e.side === "LONG") { longNet = addNet(longNet, qty, e.price); totalAddsLong++; e.qty = qty; e.avgAfter = longNet.avg; }
      else { shortNet = addNet(shortNet, qty, e.price); totalAddsShort++; e.qty = qty; e.avgAfter = shortNet.avg; }
      wallet -= fee; totalFees += fee;
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

  // FULL bandLine cho TF >= 15m (chỉ 15m mới decimate vì 105k bars).
  // Đảm bảo zoom in line bám sát event.
  const bandSlim = tf === "15m"
    ? bandLine.filter((_, i) => i % 3 === 0)  // 105k → 35k
    : bandLine;                                  // full

  console.log(`[${tf}] LIQ ${liquidated} · ADD L${totalAddsLong}/S${totalAddsShort} · uPnL ${finalUpnl>=0?"+":""}$${finalUpnl.toFixed(0)} · ROI ${roi>=0?"+":""}${roi.toFixed(2)}% · DD $${maxDD.toFixed(0)}`);

  return {
    tf, period: BB_PERIOD, std: BB_STD,
    liquidated, liqAtMs,
    finalLong: longNet, finalShort: shortNet, lastPrice,
    finalUpnlLong, finalUpnlShort, finalUpnl,
    finalEq, wallet, roi, maxDD, peak, trough,
    totalAddsLong, totalAddsShort, totalFees,
    events, bandLine: bandSlim,
  };
}

function main() {
  console.log("[multi-tf-boll] Loading 5m for sim...");
  const c5 = loadCache("5m");
  // Bump resolution: step 10 = 31,536 points (=~5MB JSON). Đủ chính xác zoom.
  const priceLine: { ts: number; price: number }[] = [];
  const step = 10;
  for (let i = 0; i < c5.length; i += step) priceLine.push({ ts: c5[i].time, price: c5[i].close });
  if (priceLine[priceLine.length - 1].ts !== c5[c5.length - 1].time) priceLine.push({ ts: c5[c5.length - 1].time, price: c5[c5.length - 1].close });

  const results: any[] = [];
  for (const tf of TF_LIST) {
    console.log(`\n[multi-tf-boll] Running ${tf}...`);
    results.push(runTF(tf, c5));
  }

  const out = {
    config: { period: BB_PERIOD, std: BB_STD, capital: INITIAL_CAPITAL, notional: NOTIONAL_PER_ADD_USD, tfList: TF_LIST },
    period: { start: c5[0].time, end: c5[c5.length - 1].time },
    priceLine,
    results,
  };
  writeFileSync(join(__dirname, "..", "assets", "backtest_boll_multi_tf_3y.json"), JSON.stringify(out));
  console.log(`\nSaved → assets/backtest_boll_multi_tf_3y.json`);
}

main();
