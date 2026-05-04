/**
 * backtest-wave-sweep.ts (anh Tommy 2026-05-03)
 *
 * Sweep params Method C (BB Reversal) + D (Multi-TF Confluence) tìm winner.
 * Output JSON ranking + top 10 charts cho mỗi method.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const INITIAL_CAPITAL = 100000;
const NOTIONAL_PER_ADD_USD = 1000;
const FEE_PER_SIDE_PCT = 0.05;
const MAINT_MARGIN_RATE = 0.004;
const COOLDOWN_MS_BASE = 60 * 60_000;

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }
interface Net { qty: number; avg: number; }

function loadCache(tf: string): Candle[] {
  const p = join(__dirname, "..", ".cache", `binance-${tf}-3y.json`);
  if (!existsSync(p)) throw new Error(`Missing ${p}`);
  return JSON.parse(readFileSync(p, "utf8"));
}

function findIndexAtOrBefore(arr: { time: number }[], t: number): number {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (arr[m].time <= t) { ans = m; lo = m + 1; } else hi = m - 1;
  }
  return ans;
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

function calcSMA(arr: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(arr.length).fill(null);
  if (arr.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += arr[i];
  out[period - 1] = sum / period;
  for (let i = period; i < arr.length; i++) {
    sum += arr[i] - arr[i - period];
    out[i] = sum / period;
  }
  return out;
}

function calcStdev(arr: number[], period: number, sma: (number|null)[]): (number|null)[] {
  const out: (number|null)[] = new Array(arr.length).fill(null);
  for (let i = period - 1; i < arr.length; i++) {
    const mean = sma[i]; if (mean === null) continue;
    let sq = 0;
    for (let j = i - period + 1; j <= i; j++) sq += (arr[j] - mean) ** 2;
    out[i] = Math.sqrt(sq / period);
  }
  return out;
}

function addNet(n: Net, qty: number, price: number): Net {
  const newQty = n.qty + qty;
  return { qty: newQty, avg: newQty > 0 ? (n.qty * n.avg + qty * price) / newQty : 0 };
}

interface Sig { ts: number; price: number; signal: "LONG" | "SHORT" | "CLOSE_LONG" | "CLOSE_SHORT" }

function simulate(signals: Sig[], priceLine: { ts: number; price: number }[], cooldownMs: number) {
  let longNet: Net = { qty: 0, avg: 0 };
  let shortNet: Net = { qty: 0, avg: 0 };
  let wallet = INITIAL_CAPITAL;
  let totalFees = 0, totalRealizedPnl = 0;
  let totalAddsLong = 0, totalAddsShort = 0, totalCloses = 0;
  let winCount = 0, lossCount = 0;
  let lastAddLongMs = 0, lastAddShortMs = 0;
  let liquidated = false, liqAtMs = 0;
  let peak = INITIAL_CAPITAL, trough = INITIAL_CAPITAL;

  const sigByTs = new Map<number, Sig[]>();
  for (const s of signals) {
    const arr = sigByTs.get(s.ts) || [];
    arr.push(s); sigByTs.set(s.ts, arr);
  }

  for (let i = 0; i < priceLine.length; i++) {
    const p = priceLine[i];
    const sigList = sigByTs.get(p.ts);
    if (sigList) for (const sig of sigList) {
      const price = sig.price;
      if (sig.signal === "LONG" && p.ts - lastAddLongMs >= cooldownMs) {
        const qty = NOTIONAL_PER_ADD_USD / price;
        const fee = qty * price * (FEE_PER_SIDE_PCT / 100);
        longNet = addNet(longNet, qty, price);
        wallet -= fee; totalFees += fee; totalAddsLong++; lastAddLongMs = p.ts;
      } else if (sig.signal === "SHORT" && p.ts - lastAddShortMs >= cooldownMs) {
        const qty = NOTIONAL_PER_ADD_USD / price;
        const fee = qty * price * (FEE_PER_SIDE_PCT / 100);
        shortNet = addNet(shortNet, qty, price);
        wallet -= fee; totalFees += fee; totalAddsShort++; lastAddShortMs = p.ts;
      } else if (sig.signal === "CLOSE_LONG" && longNet.qty > 0) {
        const realized = longNet.qty * (price - longNet.avg);
        const fee = longNet.qty * price * (FEE_PER_SIDE_PCT / 100);
        const net = realized - fee;
        wallet += net; totalRealizedPnl += realized; totalFees += fee; totalCloses++;
        if (net >= 0) winCount++; else lossCount++;
        longNet = { qty: 0, avg: 0 };
      } else if (sig.signal === "CLOSE_SHORT" && shortNet.qty > 0) {
        const realized = shortNet.qty * (shortNet.avg - price);
        const fee = shortNet.qty * price * (FEE_PER_SIDE_PCT / 100);
        const net = realized - fee;
        wallet += net; totalRealizedPnl += realized; totalFees += fee; totalCloses++;
        if (net >= 0) winCount++; else lossCount++;
        shortNet = { qty: 0, avg: 0 };
      }
    }
    let upnl = 0;
    if (longNet.qty > 0) upnl += longNet.qty * (p.price - longNet.avg);
    if (shortNet.qty > 0) upnl += shortNet.qty * (shortNet.avg - p.price);
    const eq = wallet + upnl;
    if (eq > peak) peak = eq;
    if (eq < trough) trough = eq;
    if (longNet.qty + shortNet.qty > 0) {
      const mm = (longNet.qty + shortNet.qty) * p.price * MAINT_MARGIN_RATE;
      if (eq <= mm) { liquidated = true; liqAtMs = p.ts; break; }
    }
  }
  const lastPrice = priceLine[priceLine.length - 1].price;
  const finalUpnl = (longNet.qty > 0 ? longNet.qty * (lastPrice - longNet.avg) : 0)
                 + (shortNet.qty > 0 ? shortNet.qty * (shortNet.avg - lastPrice) : 0);
  const finalEq = wallet + finalUpnl;
  const roi = ((finalEq - INITIAL_CAPITAL) / INITIAL_CAPITAL) * 100;
  const maxDD = peak - trough;
  const wr = winCount + lossCount > 0 ? winCount / (winCount + lossCount) : 0;
  return { liquidated, liqAtMs, totalAddsLong, totalAddsShort, totalCloses, totalRealizedPnl, totalFees, finalUpnl, finalEq, wallet, roi, maxDD, peak, trough, winCount, lossCount, wr };
}

// === Method C signals (param: bbPeriod, bbStdMult) ===
function methodC_signals(c1h: Candle[], bbPeriod: number, bbStdMult: number): Sig[] {
  const closes = c1h.map((b) => b.close);
  const sma = calcSMA(closes, bbPeriod);
  const sd = calcStdev(closes, bbPeriod, sma);
  const sigs: Sig[] = [];
  let inLong = false, inShort = false;
  for (let i = bbPeriod + 1; i < c1h.length; i++) {
    const m = sma[i], s = sd[i];
    if (m === null || s === null) continue;
    const upper = m + bbStdMult * s, lower = m - bbStdMult * s;
    const pm = sma[i - 1], ps = sd[i - 1];
    if (pm === null || ps === null) continue;
    const prevLower = pm - bbStdMult * ps, prevUpper = pm + bbStdMult * ps;
    const prevC = c1h[i - 1].close, curC = c1h[i].close;
    if (prevC < prevLower && curC > lower) {
      if (inShort) { sigs.push({ ts: c1h[i].time, price: curC, signal: "CLOSE_SHORT" }); inShort = false; }
      if (!inLong) { sigs.push({ ts: c1h[i].time, price: curC, signal: "LONG" }); inLong = true; }
    }
    if (prevC > prevUpper && curC < upper) {
      if (inLong) { sigs.push({ ts: c1h[i].time, price: curC, signal: "CLOSE_LONG" }); inLong = false; }
      if (!inShort) { sigs.push({ ts: c1h[i].time, price: curC, signal: "SHORT" }); inShort = true; }
    }
  }
  return sigs;
}

// === Method D signals ===
function methodD_signals(c5: Candle[], c1h: Candle[], c1d: Candle[], maPeriod: number, rsiOs: number, rsiOb: number, cooldownH: number, volMult: number): Sig[] {
  const closes1d = c1d.map((b) => b.close);
  const ma_1d = calcSMA(closes1d, maPeriod);
  const closes1h = c1h.map((b) => b.close);
  const rsi1h = calcRSI(closes1h, 14);
  const sigs: Sig[] = [];
  let inLong = false, inShort = false;
  let lastSigMs = 0;
  const vols = c5.map((b) => b.volume ?? 0);
  const smaVol = calcSMA(vols, 20);

  for (let i = 25; i < c5.length; i++) {
    const bar = c5[i];
    if (bar.time - lastSigMs < cooldownH * 60 * 60_000) continue;
    const idx1d = findIndexAtOrBefore(c1d, bar.time);
    const idx1h = findIndexAtOrBefore(c1h, bar.time);
    if (idx1d < maPeriod || idx1h < 14) continue;
    const ma1d = ma_1d[idx1d - 1] ?? null;
    if (ma1d === null) continue;
    const trendDayUp = c1d[idx1d - 1].close > ma1d;
    const r1h = rsi1h[idx1h - 1] ?? 50;
    const prev = c5[i - 1], cur = c5[i];
    const bullEngulf = prev.close < prev.open && cur.close > cur.open && cur.close > prev.open && cur.open < prev.close;
    const bearEngulf = prev.close > prev.open && cur.close < cur.open && cur.close < prev.open && cur.open > prev.close;
    const volSpike = (smaVol[i] ?? 0) > 0 && cur.volume! > volMult * smaVol[i]!;

    if (trendDayUp && r1h < rsiOs && bullEngulf && volSpike) {
      if (inShort) sigs.push({ ts: bar.time, price: bar.close, signal: "CLOSE_SHORT" });
      sigs.push({ ts: bar.time, price: bar.close, signal: "LONG" });
      inLong = true; inShort = false; lastSigMs = bar.time;
    } else if (!trendDayUp && r1h > rsiOb && bearEngulf && volSpike) {
      if (inLong) sigs.push({ ts: bar.time, price: bar.close, signal: "CLOSE_LONG" });
      sigs.push({ ts: bar.time, price: bar.close, signal: "SHORT" });
      inShort = true; inLong = false; lastSigMs = bar.time;
    } else if (inLong && (!trendDayUp || r1h > rsiOb)) {
      sigs.push({ ts: bar.time, price: bar.close, signal: "CLOSE_LONG" });
      inLong = false; lastSigMs = bar.time;
    } else if (inShort && (trendDayUp || r1h < rsiOs)) {
      sigs.push({ ts: bar.time, price: bar.close, signal: "CLOSE_SHORT" });
      inShort = false; lastSigMs = bar.time;
    }
  }
  return sigs;
}

function main() {
  console.log("[sweep] Loading...");
  const c5 = loadCache("5m");
  const c1h = loadCache("1h");
  const c1d = loadCache("1d");
  const fullPL = c5.map((b) => ({ ts: b.time, price: b.close }));
  console.log(`[sweep] 5m=${c5.length}, 1h=${c1h.length}, 1d=${c1d.length}`);

  // === Method C sweep: 3 periods × 4 stdMults = 12 ===
  const periods = [10, 20, 30, 50];
  const stds = [1.5, 2, 2.5, 3];
  const resultsC: any[] = [];
  console.log("\n[sweep C] BB period × stdev (16 combos)");
  for (const p of periods) for (const sd of stds) {
    const sigs = methodC_signals(c1h, p, sd);
    const r = simulate(sigs, fullPL, COOLDOWN_MS_BASE);
    resultsC.push({ method: "C", params: { bbPeriod: p, bbStd: sd }, ...r });
    console.log(`  C(${p},${sd}): ROI ${r.roi.toFixed(2)}% · DD $${r.maxDD.toFixed(0)} · ADD ${r.totalAddsLong+r.totalAddsShort} · CLOSES ${r.totalCloses} · WR ${(r.wr*100).toFixed(0)}% · LIQ ${r.liquidated}`);
  }

  // === Method D sweep: 3 MA × 3 RSI pair × 3 cooldown × 2 vol = 54 ===
  const mas = [20, 50, 100];
  const rsiPairs: [number, number][] = [[25, 75], [30, 70], [35, 65]];
  const cooldownsH = [2, 4, 8];
  const volMults = [1.2, 1.5, 2.0];
  const resultsD: any[] = [];
  console.log("\n[sweep D] MA × RSI × cooldown × volMult (81 combos)");
  let count = 0;
  for (const ma of mas) for (const [os, ob] of rsiPairs) for (const ch of cooldownsH) for (const v of volMults) {
    const sigs = methodD_signals(c5, c1h, c1d, ma, os, ob, ch, v);
    const r = simulate(sigs, fullPL, COOLDOWN_MS_BASE);
    resultsD.push({ method: "D", params: { ma, rsiOs: os, rsiOb: ob, cooldownH: ch, volMult: v }, ...r });
    count++;
    if (count % 10 === 0) console.log(`  ... ${count}/81`);
  }

  // Sort by ROI desc
  resultsC.sort((a, b) => b.roi - a.roi);
  resultsD.sort((a, b) => b.roi - a.roi);

  console.log("\n=== TOP 5 METHOD C ===");
  console.log("Params                               ROI%      DD$       Trades   CLOSES   WR%   LIQ");
  for (const r of resultsC.slice(0, 5)) {
    const ps = `bb=${r.params.bbPeriod} std=${r.params.bbStd}`;
    console.log(`${ps.padEnd(36)}${r.roi.toFixed(2).padStart(8)}  ${r.maxDD.toFixed(0).padStart(8)}  ${(r.totalAddsLong+r.totalAddsShort).toString().padStart(7)}  ${r.totalCloses.toString().padStart(7)}  ${(r.wr*100).toFixed(0).padStart(4)}%  ${r.liquidated?'YES':'NO'}`);
  }

  console.log("\n=== TOP 5 METHOD D ===");
  console.log("Params                               ROI%      DD$       Trades   CLOSES   WR%   LIQ");
  for (const r of resultsD.slice(0, 5)) {
    const ps = `ma=${r.params.ma} rsi=${r.params.rsiOs}/${r.params.rsiOb} cd=${r.params.cooldownH}h vol×${r.params.volMult}`;
    console.log(`${ps.padEnd(36)}${r.roi.toFixed(2).padStart(8)}  ${r.maxDD.toFixed(0).padStart(8)}  ${(r.totalAddsLong+r.totalAddsShort).toString().padStart(7)}  ${r.totalCloses.toString().padStart(7)}  ${(r.wr*100).toFixed(0).padStart(4)}%  ${r.liquidated?'YES':'NO'}`);
  }

  const outPath = join(__dirname, "..", "assets", "backtest_wave_sweep_3y.json");
  writeFileSync(outPath, JSON.stringify({
    period: { start: c5[0].time, end: c5[c5.length - 1].time },
    initialCapital: INITIAL_CAPITAL,
    notional: NOTIONAL_PER_ADD_USD,
    resultsC, resultsD,
  }));
  console.log(`\n[sweep] Saved → ${outPath}`);
}

main();
