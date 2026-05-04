/**
 * backtest-boll-pure.ts (anh Tommy 2026-05-03)
 *
 * Rule:
 *   - ENTRY LONG: prev close >= BB lower AND cur close < BB lower (cross xuống)
 *   - CLOSE LONG: cur close >= BB upper (chạm upper band)
 *   - LONG only, không SHORT
 *   - Test trên nhiều TF (15m / 1H / 4H / 1d) + nhiều BB params
 *   - Capital $100k, $1000 notional/ADD, lev 125x cross
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const INITIAL_CAPITAL = 100000;
const NOTIONAL_PER_ADD_USD = 1000;
const FEE_PER_SIDE_PCT = 0.05;
const MAINT_MARGIN_RATE = 0.004;
const COOLDOWN_MS = 60 * 60_000; // 1h cooldown giữa các ADD

interface Candle { time: number; open: number; high: number; low: number; close: number; }
interface Net { qty: number; avg: number; }
interface Sig { ts: number; price: number; signal: "LONG" | "CLOSE_LONG"; }
interface Event { ts: number; kind: "ADD" | "CLOSE"; price: number; qty: number; avgAfter: number; realizedPnl?: number; bbLower?: number; bbUpper?: number; bbMid?: number; }

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

function buildSignals(candles: Candle[], period: number, stdMult: number): { sigs: Sig[]; bands: { ts: number; mid: number; upper: number; lower: number }[] } {
  const closes = candles.map((b) => b.close);
  const sma = calcSMA(closes, period);
  const sd = calcStdev(closes, period, sma);
  const sigs: Sig[] = [];
  const bands: { ts: number; mid: number; upper: number; lower: number }[] = [];
  let inLong = false;
  for (let i = period; i < candles.length; i++) {
    const m = sma[i], s = sd[i]; if (m === null || s === null) continue;
    const upper = m + stdMult * s, lower = m - stdMult * s;
    bands.push({ ts: candles[i].time, mid: m, upper, lower });
    const pm = sma[i - 1], ps = sd[i - 1]; if (pm === null || ps === null) continue;
    const prevLower = pm - stdMult * ps;
    const prevUpper = pm + stdMult * ps;
    const prevC = candles[i - 1].close, curC = candles[i].close;
    // Cross XUỐNG lower → LONG (chỉ entry mới khi chưa LONG)
    if (!inLong && prevC >= prevLower && curC < lower) {
      sigs.push({ ts: candles[i].time, price: curC, signal: "LONG" });
      inLong = true;
    }
    // Chạm upper → CLOSE LONG
    if (inLong && curC >= upper) {
      sigs.push({ ts: candles[i].time, price: curC, signal: "CLOSE_LONG" });
      inLong = false;
    }
  }
  return { sigs, bands };
}

function simulate(sigs: Sig[], priceLine: { ts: number; price: number }[], bands: { ts: number; mid: number; upper: number; lower: number }[]) {
  let longNet: Net = { qty: 0, avg: 0 };
  let wallet = INITIAL_CAPITAL;
  let totalFees = 0, totalRealizedPnl = 0;
  let totalAdds = 0, totalCloses = 0;
  let winCount = 0, lossCount = 0;
  let lastAddMs = 0;
  let liquidated = false, liqAtMs = 0;
  let peak = INITIAL_CAPITAL, trough = INITIAL_CAPITAL;
  const events: Event[] = [];

  const sigByTs = new Map<number, Sig[]>();
  for (const s of sigs) { const arr = sigByTs.get(s.ts) || []; arr.push(s); sigByTs.set(s.ts, arr); }
  const bandByTs = new Map<number, typeof bands[0]>();
  for (const b of bands) bandByTs.set(b.ts, b);

  for (let i = 0; i < priceLine.length; i++) {
    const p = priceLine[i];
    const sl = sigByTs.get(p.ts);
    if (sl) for (const sig of sl) {
      const price = sig.price;
      const b = bandByTs.get(p.ts);
      if (sig.signal === "LONG" && p.ts - lastAddMs >= COOLDOWN_MS) {
        const qty = NOTIONAL_PER_ADD_USD / price;
        const fee = qty * price * (FEE_PER_SIDE_PCT / 100);
        longNet = addNet(longNet, qty, price);
        wallet -= fee; totalFees += fee; totalAdds++; lastAddMs = p.ts;
        events.push({ ts: p.ts, kind: "ADD", price, qty, avgAfter: longNet.avg, bbLower: b?.lower, bbUpper: b?.upper, bbMid: b?.mid });
      } else if (sig.signal === "CLOSE_LONG" && longNet.qty > 0) {
        const realized = longNet.qty * (price - longNet.avg);
        const fee = longNet.qty * price * (FEE_PER_SIDE_PCT / 100);
        const net = realized - fee;
        wallet += net; totalRealizedPnl += realized; totalFees += fee; totalCloses++;
        if (net >= 0) winCount++; else lossCount++;
        events.push({ ts: p.ts, kind: "CLOSE", price, qty: longNet.qty, avgAfter: longNet.avg, realizedPnl: net, bbLower: b?.lower, bbUpper: b?.upper, bbMid: b?.mid });
        longNet = { qty: 0, avg: 0 };
      }
    }
    let upnl = longNet.qty > 0 ? longNet.qty * (p.price - longNet.avg) : 0;
    const eq = wallet + upnl;
    if (eq > peak) peak = eq; if (eq < trough) trough = eq;
    if (longNet.qty > 0) {
      const mm = longNet.qty * p.price * MAINT_MARGIN_RATE;
      if (eq <= mm) { liquidated = true; liqAtMs = p.ts; break; }
    }
  }
  const lastPrice = priceLine[priceLine.length - 1].price;
  const finalUpnl = longNet.qty > 0 ? longNet.qty * (lastPrice - longNet.avg) : 0;
  const finalEq = wallet + finalUpnl;
  const roi = ((finalEq - INITIAL_CAPITAL) / INITIAL_CAPITAL) * 100;
  const maxDD = peak - trough;
  const wr = winCount + lossCount > 0 ? winCount / (winCount + lossCount) : 0;
  return { liquidated, liqAtMs, totalAdds, totalCloses, totalRealizedPnl, totalFees, finalLong: longNet, finalUpnl, finalEq, wallet, roi, maxDD, peak, trough, winCount, lossCount, wr, events };
}

function main() {
  console.log("[boll] Loading...");
  const c5 = loadCache("5m");
  const fullPL = c5.map((b) => ({ ts: b.time, price: b.close }));

  // Sweep TF + period + std
  const tfList = ["15m", "1h", "4h", "1d"];
  const periods = [10, 20, 50];
  const stds = [1.5, 2, 2.5, 3];
  const all: any[] = [];

  for (const tf of tfList) {
    const candles = loadCache(tf);
    console.log(`\n[boll] TF=${tf} (${candles.length} bars)`);
    for (const p of periods) for (const sd of stds) {
      const { sigs, bands } = buildSignals(candles, p, sd);
      const r = simulate(sigs, fullPL, bands);
      all.push({ tf, period: p, std: sd, ...r });
      console.log(`  ${tf} bb=${p} std=${sd}: ROI ${r.roi.toFixed(2)}% · DD $${r.maxDD.toFixed(0)} · ADD ${r.totalAdds} · CLOSES ${r.totalCloses} · WR ${(r.wr*100).toFixed(0)}% · LIQ ${r.liquidated}`);
    }
  }

  all.sort((a, b) => b.roi - a.roi);
  console.log("\n=== TOP 10 ALL ===");
  console.log("TF    bb  std    ROI%       DD$     ADD   CLOSES  WR%   LIQ");
  for (const r of all.slice(0, 10)) {
    console.log(`${r.tf.padEnd(5)} ${String(r.period).padStart(2)} ${String(r.std).padStart(3)}  ${r.roi.toFixed(2).padStart(7)}  ${r.maxDD.toFixed(0).padStart(6)}  ${String(r.totalAdds).padStart(5)}  ${String(r.totalCloses).padStart(6)}  ${(r.wr*100).toFixed(0).padStart(4)}  ${r.liquidated?'YES':'NO'}`);
  }

  // Save winner full chart data + top 5 list
  const winner = all[0];
  const out = {
    period: { start: c5[0].time, end: c5[c5.length - 1].time },
    initialCapital: INITIAL_CAPITAL,
    notional: NOTIONAL_PER_ADD_USD,
    allResults: all.map((r) => ({ tf: r.tf, period: r.period, std: r.std, roi: r.roi, maxDD: r.maxDD, totalAdds: r.totalAdds, totalCloses: r.totalCloses, wr: r.wr, liquidated: r.liquidated, finalEq: r.finalEq, totalRealizedPnl: r.totalRealizedPnl, totalFees: r.totalFees, finalUpnl: r.finalUpnl })),
    winner: {
      tf: winner.tf, period: winner.period, std: winner.std,
      roi: winner.roi, maxDD: winner.maxDD, totalAdds: winner.totalAdds, totalCloses: winner.totalCloses, wr: winner.wr,
      liquidated: winner.liquidated, liqAtMs: winner.liqAtMs,
      finalEq: winner.finalEq, totalRealizedPnl: winner.totalRealizedPnl, totalFees: winner.totalFees,
      finalLong: winner.finalLong, finalUpnl: winner.finalUpnl, wallet: winner.wallet,
      events: winner.events,
    },
    priceLine: (() => {
      const out: { ts: number; price: number }[] = [];
      const step = Math.max(1, Math.floor(c5.length / 4000));
      for (let i = 0; i < c5.length; i += step) out.push({ ts: c5[i].time, price: c5[i].close });
      return out;
    })(),
  };
  const outPath = join(__dirname, "..", "assets", "backtest_boll_pure_3y.json");
  writeFileSync(outPath, JSON.stringify(out));
  console.log(`\n[boll] Winner: ${winner.tf} bb=${winner.period} std=${winner.std} → ROI ${winner.roi.toFixed(2)}%`);
  console.log(`[boll] Saved → ${outPath}`);
}

main();
