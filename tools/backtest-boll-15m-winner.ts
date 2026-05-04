/**
 * backtest-boll-15m-winner.ts (anh Tommy 2026-05-03)
 * Re-run BB pure trên 15m với best params (bb=20, std=3) → save full events cho chart.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const INITIAL_CAPITAL = 100000;
const NOTIONAL_PER_ADD_USD = 1000;
const FEE_PER_SIDE_PCT = 0.05;
const MAINT_MARGIN_RATE = 0.004;
const COOLDOWN_MS = 60 * 60_000;
const TF = "15m";
const BB_PERIOD = 20;
const BB_STD = 3;

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
  const c15 = loadCache(TF);
  const c5 = loadCache("5m");
  const closes = c15.map((b) => b.close);
  const sma = calcSMA(closes, BB_PERIOD);
  const sd = calcStdev(closes, BB_PERIOD, sma);

  let longNet: Net = { qty: 0, avg: 0 };
  let wallet = INITIAL_CAPITAL;
  let totalFees = 0, totalRealizedPnl = 0;
  let totalAdds = 0, totalCloses = 0, winCount = 0, lossCount = 0;
  let lastAddMs = 0;
  let inLong = false;
  const events: any[] = [];
  const bandLine: any[] = [];

  // Walk 15m bars
  for (let i = BB_PERIOD; i < c15.length; i++) {
    const m = sma[i], s = sd[i]; if (m === null || s === null) continue;
    const upper = m + BB_STD * s, lower = m - BB_STD * s;
    if (i % 4 === 0) bandLine.push({ ts: c15[i].time, mid: m, upper, lower });
    const pm = sma[i - 1], ps = sd[i - 1]; if (pm === null || ps === null) continue;
    const prevLower = pm - BB_STD * ps;
    const prevC = c15[i - 1].close, curC = c15[i].close;
    const ts = c15[i].time;
    if (!inLong && prevC >= prevLower && curC < lower && ts - lastAddMs >= COOLDOWN_MS) {
      const qty = NOTIONAL_PER_ADD_USD / curC;
      const fee = qty * curC * (FEE_PER_SIDE_PCT / 100);
      longNet = addNet(longNet, qty, curC);
      wallet -= fee; totalFees += fee; totalAdds++; lastAddMs = ts;
      events.push({ ts, kind: "ADD", price: curC, qty, avgAfter: longNet.avg, bbLower: lower, bbUpper: upper, bbMid: m });
      inLong = true;
    }
    if (inLong && curC >= upper) {
      const realized = longNet.qty * (curC - longNet.avg);
      const fee = longNet.qty * curC * (FEE_PER_SIDE_PCT / 100);
      const net = realized - fee;
      wallet += net; totalRealizedPnl += realized; totalFees += fee; totalCloses++;
      if (net >= 0) winCount++; else lossCount++;
      events.push({ ts, kind: "CLOSE", price: curC, qty: longNet.qty, avgAfter: longNet.avg, realizedPnl: net, bbLower: lower, bbUpper: upper, bbMid: m });
      longNet = { qty: 0, avg: 0 };
      inLong = false;
    }
  }
  const lastPrice = c5[c5.length - 1].close;
  const finalUpnl = longNet.qty > 0 ? longNet.qty * (lastPrice - longNet.avg) : 0;
  const finalEq = wallet + finalUpnl;
  const roi = ((finalEq - INITIAL_CAPITAL) / INITIAL_CAPITAL) * 100;

  console.log(`[boll15m] TF=${TF} bb=${BB_PERIOD} std=${BB_STD}`);
  console.log(`  ROI ${roi.toFixed(2)}% · ADD ${totalAdds} · CLOSES ${totalCloses} · WR ${winCount}/${winCount+lossCount} (${(winCount/Math.max(1,winCount+lossCount)*100).toFixed(0)}%)`);
  console.log(`  Realized PnL: $${totalRealizedPnl.toFixed(2)} · Fees: $${totalFees.toFixed(2)}`);
  console.log(`  Final LONG: ${longNet.qty.toFixed(4)} @ $${longNet.avg.toFixed(0)} · uPnL $${finalUpnl.toFixed(2)}`);
  console.log(`  Final equity: $${finalEq.toFixed(2)}`);

  const priceLine: { ts: number; price: number }[] = [];
  const step = Math.max(1, Math.floor(c5.length / 4000));
  for (let i = 0; i < c5.length; i += step) priceLine.push({ ts: c5[i].time, price: c5[i].close });

  const out = {
    config: { tf: TF, period: BB_PERIOD, std: BB_STD, capital: INITIAL_CAPITAL, notional: NOTIONAL_PER_ADD_USD, cooldownMs: COOLDOWN_MS },
    period: { start: c5[0].time, end: c5[c5.length - 1].time },
    roi, totalAdds, totalCloses, totalRealizedPnl, totalFees, winCount, lossCount,
    finalLong: longNet, finalUpnl, finalEq, wallet,
    events, bandLine, priceLine,
    liquidated: false,
  };
  writeFileSync(join(__dirname, "..", "assets", "backtest_boll_15m_3y.json"), JSON.stringify(out));
  console.log(`Saved → assets/backtest_boll_15m_3y.json`);
}

main();
