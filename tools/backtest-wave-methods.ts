/**
 * backtest-wave-methods.ts (anh Tommy 2026-05-03)
 *
 * Test 4 phương pháp DETECT SÓNG → mua đáy / bán đỉnh:
 *   A. ZigZag % Swing
 *   B. RSI Divergence + Fractal
 *   C. Bollinger Reversal
 *   D. Multi-TF Confluence
 *
 * Common: $100k cap, 0.001 BTC/ADD, lev 125x cross, 3y, hedge mode.
 * Mỗi method emit: ROI, WR, max DD, trades, equity curve, events.
 * Output: 1 JSON tổng hợp 4 method để frontend chart compare.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const INITIAL_CAPITAL = 100000;
const NOTIONAL_PER_ADD_USD = 1000; // 1% capital — fair so kết quả không micro
const FEE_PER_SIDE_PCT = 0.05;
const MAINT_MARGIN_RATE = 0.004;
const COOLDOWN_MS = 60 * 60_000;

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

function calcStochK(candles: Candle[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (candles[j].high > hi) hi = candles[j].high;
      if (candles[j].low < lo) lo = candles[j].low;
    }
    const r = hi - lo;
    out[i] = r === 0 ? 50 : ((candles[i].close - lo) / r) * 100;
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
    const mean = sma[i];
    if (mean === null) continue;
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

interface Event { ts: number; kind: "ADD" | "CLOSE"; side: "LONG" | "SHORT"; price: number; qty: number; avgAfter: number; realizedPnl?: number; }

interface MethodResult {
  name: string;
  liquidated: boolean; liqAtMs: number;
  totalAddsLong: number; totalAddsShort: number; totalCloses: number;
  totalRealizedPnl: number; totalFees: number;
  finalLong: Net; finalShort: Net;
  finalUpnl: number; finalEq: number; wallet: number;
  roi: number; maxDD: number; peak: number; trough: number;
  winCount: number; lossCount: number;
  events: Event[];
  equityCurve: { ts: number; eq: number }[];
}

function simulate(name: string, signals: { ts: number; price: number; signal: "LONG" | "SHORT" | "CLOSE_LONG" | "CLOSE_SHORT" }[], priceLine: { ts: number; price: number }[]): MethodResult {
  let longNet: Net = { qty: 0, avg: 0 };
  let shortNet: Net = { qty: 0, avg: 0 };
  let wallet = INITIAL_CAPITAL;
  let totalFees = 0, totalRealizedPnl = 0;
  let totalAddsLong = 0, totalAddsShort = 0, totalCloses = 0;
  let winCount = 0, lossCount = 0;
  let lastAddLongMs = 0, lastAddShortMs = 0;
  let liquidated = false, liqAtMs = 0;
  const events: Event[] = [];
  const equityCurve: { ts: number; eq: number }[] = [];

  // Sort signals + group by ts (multi signals same ts xảy ra)
  const sigByTs = new Map<number, typeof signals>();
  for (const s of signals) {
    const arr = sigByTs.get(s.ts) || [];
    arr.push(s);
    sigByTs.set(s.ts, arr);
  }

  for (let i = 0; i < priceLine.length; i++) {
    const p = priceLine[i];
    const sigList = sigByTs.get(p.ts);
    if (sigList) for (const sig of sigList) {
      const price = sig.price;
      if (sig.signal === "LONG" && p.ts - lastAddLongMs >= COOLDOWN_MS) {
        const qty = NOTIONAL_PER_ADD_USD / price;
        const fee = qty * price * (FEE_PER_SIDE_PCT / 100);
        longNet = addNet(longNet, qty, price);
        wallet -= fee; totalFees += fee; totalAddsLong++; lastAddLongMs = p.ts;
        events.push({ ts: p.ts, kind: "ADD", side: "LONG", price, qty, avgAfter: longNet.avg });
      } else if (sig.signal === "SHORT" && p.ts - lastAddShortMs >= COOLDOWN_MS) {
        const qty = NOTIONAL_PER_ADD_USD / price;
        const fee = qty * price * (FEE_PER_SIDE_PCT / 100);
        shortNet = addNet(shortNet, qty, price);
        wallet -= fee; totalFees += fee; totalAddsShort++; lastAddShortMs = p.ts;
        events.push({ ts: p.ts, kind: "ADD", side: "SHORT", price, qty, avgAfter: shortNet.avg });
      } else if (sig.signal === "CLOSE_LONG" && longNet.qty > 0) {
        const realized = longNet.qty * (price - longNet.avg);
        const fee = longNet.qty * price * (FEE_PER_SIDE_PCT / 100);
        const net = realized - fee;
        wallet += net;
        totalRealizedPnl += realized; totalFees += fee; totalCloses++;
        if (net >= 0) winCount++; else lossCount++;
        events.push({ ts: p.ts, kind: "CLOSE", side: "LONG", price, qty: longNet.qty, avgAfter: longNet.avg, realizedPnl: net });
        longNet = { qty: 0, avg: 0 };
      } else if (sig.signal === "CLOSE_SHORT" && shortNet.qty > 0) {
        const realized = shortNet.qty * (shortNet.avg - price);
        const fee = shortNet.qty * price * (FEE_PER_SIDE_PCT / 100);
        const net = realized - fee;
        wallet += net;
        totalRealizedPnl += realized; totalFees += fee; totalCloses++;
        if (net >= 0) winCount++; else lossCount++;
        events.push({ ts: p.ts, kind: "CLOSE", side: "SHORT", price, qty: shortNet.qty, avgAfter: shortNet.avg, realizedPnl: net });
        shortNet = { qty: 0, avg: 0 };
      }
    }
    let upnl = 0;
    if (longNet.qty > 0) upnl += longNet.qty * (p.price - longNet.avg);
    if (shortNet.qty > 0) upnl += shortNet.qty * (shortNet.avg - p.price);
    const eq = wallet + upnl;
    if (longNet.qty + shortNet.qty > 0) {
      const mm = (longNet.qty + shortNet.qty) * p.price * MAINT_MARGIN_RATE;
      if (eq <= mm) { liquidated = true; liqAtMs = p.ts; break; }
    }
    if (i % 50 === 0) equityCurve.push({ ts: p.ts, eq });
  }

  const lastPrice = priceLine[priceLine.length - 1].price;
  const finalUpnl = (longNet.qty > 0 ? longNet.qty * (lastPrice - longNet.avg) : 0)
                   + (shortNet.qty > 0 ? shortNet.qty * (shortNet.avg - lastPrice) : 0);
  const finalEq = wallet + finalUpnl;
  const peak = equityCurve.reduce((m, p) => Math.max(m, p.eq), INITIAL_CAPITAL);
  const trough = equityCurve.reduce((m, p) => Math.min(m, p.eq), INITIAL_CAPITAL);
  const maxDD = peak - trough;
  const roi = ((finalEq - INITIAL_CAPITAL) / INITIAL_CAPITAL) * 100;

  return {
    name, liquidated, liqAtMs,
    totalAddsLong, totalAddsShort, totalCloses,
    totalRealizedPnl, totalFees,
    finalLong: longNet, finalShort: shortNet,
    finalUpnl, finalEq, wallet, roi, maxDD, peak, trough,
    winCount, lossCount,
    events, equityCurve,
  };
}

// === METHOD A — ZigZag % Swing ===
function methodA_signals(c5: Candle[], swingPct = 3, reversalPct = 1) {
  const sigs: { ts: number; price: number; signal: "LONG" | "SHORT" | "CLOSE_LONG" | "CLOSE_SHORT" }[] = [];
  let pivotPrice = c5[0].close;
  let direction: "UP" | "DOWN" = "UP";
  let swingExtreme = pivotPrice;
  let inLong = false, inShort = false;

  for (let i = 1; i < c5.length; i++) {
    const c = c5[i];
    if (direction === "UP") {
      if (c.high > swingExtreme) swingExtreme = c.high;
      const dropPct = ((swingExtreme - c.close) / swingExtreme) * 100;
      if (dropPct >= swingPct) {
        // Confirmed reversal to DOWN. Pivot top = swingExtreme.
        pivotPrice = swingExtreme;
        direction = "DOWN";
        swingExtreme = c.low;
        // Đỉnh xác nhận → CLOSE LONG nếu đang LONG, hoặc SHORT
        if (inLong) { sigs.push({ ts: c.time, price: c.close, signal: "CLOSE_LONG" }); inLong = false; }
        if (!inShort) { sigs.push({ ts: c.time, price: c.close, signal: "SHORT" }); inShort = true; }
      }
    } else {
      if (c.low < swingExtreme) swingExtreme = c.low;
      const risePct = ((c.close - swingExtreme) / swingExtreme) * 100;
      if (risePct >= swingPct) {
        pivotPrice = swingExtreme;
        direction = "UP";
        swingExtreme = c.high;
        if (inShort) { sigs.push({ ts: c.time, price: c.close, signal: "CLOSE_SHORT" }); inShort = false; }
        if (!inLong) { sigs.push({ ts: c.time, price: c.close, signal: "LONG" }); inLong = true; }
      }
    }
  }
  return sigs;
}

// === METHOD B — RSI Divergence + Fractal (1H) ===
function methodB_signals(c1h: Candle[]) {
  const closes = c1h.map((b) => b.close);
  const rsi = calcRSI(closes, 14);
  const sigs: { ts: number; price: number; signal: "LONG" | "SHORT" | "CLOSE_LONG" | "CLOSE_SHORT" }[] = [];
  // Fractal swing lows/highs (5-bar)
  const lowsIdx: number[] = [], highsIdx: number[] = [];
  for (let i = 2; i < c1h.length - 2; i++) {
    if (c1h[i].low < c1h[i-1].low && c1h[i].low < c1h[i-2].low && c1h[i].low < c1h[i+1].low && c1h[i].low < c1h[i+2].low) lowsIdx.push(i);
    if (c1h[i].high > c1h[i-1].high && c1h[i].high > c1h[i-2].high && c1h[i].high > c1h[i+1].high && c1h[i].high > c1h[i+2].high) highsIdx.push(i);
  }
  let inLong = false, inShort = false;
  // Walk fractal lows: bullish divergence = price LL + RSI HL → LONG
  for (let k = 1; k < lowsIdx.length; k++) {
    const a = lowsIdx[k - 1], b = lowsIdx[k];
    if (c1h[b].low < c1h[a].low && (rsi[b] ?? 0) > (rsi[a] ?? 0)) {
      const ts = c1h[b + 2]?.time ?? c1h[b].time; // wait 2 bars confirm
      const price = c1h[b + 2]?.close ?? c1h[b].close;
      if (inShort) sigs.push({ ts, price, signal: "CLOSE_SHORT" });
      if (!inLong) { sigs.push({ ts, price, signal: "LONG" }); inLong = true; inShort = false; }
    }
  }
  for (let k = 1; k < highsIdx.length; k++) {
    const a = highsIdx[k - 1], b = highsIdx[k];
    if (c1h[b].high > c1h[a].high && (rsi[b] ?? 100) < (rsi[a] ?? 100)) {
      const ts = c1h[b + 2]?.time ?? c1h[b].time;
      const price = c1h[b + 2]?.close ?? c1h[b].close;
      if (inLong) sigs.push({ ts, price, signal: "CLOSE_LONG" });
      if (!inShort) { sigs.push({ ts, price, signal: "SHORT" }); inShort = true; inLong = false; }
    }
  }
  sigs.sort((a, b) => a.ts - b.ts);
  return sigs;
}

// === METHOD C — Bollinger Reversal (1H BB 20,2) ===
function methodC_signals(c1h: Candle[]) {
  const closes = c1h.map((b) => b.close);
  const sma = calcSMA(closes, 20);
  const sd = calcStdev(closes, 20, sma);
  const sigs: { ts: number; price: number; signal: "LONG" | "SHORT" | "CLOSE_LONG" | "CLOSE_SHORT" }[] = [];
  let inLong = false, inShort = false;
  for (let i = 21; i < c1h.length; i++) {
    const m = sma[i], s = sd[i];
    if (m === null || s === null) continue;
    const upper = m + 2 * s, lower = m - 2 * s;
    const prevC = c1h[i - 1].close;
    const curC = c1h[i].close;
    const pm = sma[i - 1], ps = sd[i - 1];
    if (pm === null || ps === null) continue;
    const prevUpper = pm + 2 * ps, prevLower = pm - 2 * ps;
    // Long signal: prev close < lower AND cur close > lower (back inside)
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

// === METHOD D — Multi-TF Confluence ===
function methodD_signals(c5: Candle[], c1h: Candle[], c1d: Candle[]) {
  const closes1d = c1d.map((b) => b.close);
  const ma50_1d = calcSMA(closes1d, 50);
  const closes1h = c1h.map((b) => b.close);
  const rsi1h = calcRSI(closes1h, 14);
  const sigs: { ts: number; price: number; signal: "LONG" | "SHORT" | "CLOSE_LONG" | "CLOSE_SHORT" }[] = [];
  let inLong = false, inShort = false;
  let lastSigMs = 0;
  // Avg volume on 5m for spike check
  const vols = c5.map((b) => b.volume ?? 0);
  const smaVol = calcSMA(vols, 20);

  for (let i = 25; i < c5.length; i++) {
    const bar = c5[i];
    if (bar.time - lastSigMs < 4 * 60 * 60_000) continue; // 4h cooldown signal

    const idx1d = findIndexAtOrBefore(c1d, bar.time);
    const idx1h = findIndexAtOrBefore(c1h, bar.time);
    if (idx1d < 50 || idx1h < 14) continue;
    const ma1d = ma50_1d[idx1d - 1] ?? null;
    if (ma1d === null) continue;
    const trendDayUp = c1d[idx1d - 1].close > ma1d;
    const r1h = rsi1h[idx1h - 1] ?? 50;

    // Reversal candle 5m (bullish/bearish engulfing simple check)
    const prev = c5[i - 1], cur = c5[i];
    const bullEngulf = prev.close < prev.open && cur.close > cur.open && cur.close > prev.open && cur.open < prev.close;
    const bearEngulf = prev.close > prev.open && cur.close < cur.open && cur.close < prev.open && cur.open > prev.close;
    const volSpike = (smaVol[i] ?? 0) > 0 && cur.volume! > 1.5 * smaVol[i]!;

    // LONG condition: trend day UP + RSI 1H < 30 + bull engulf + vol spike
    if (trendDayUp && r1h < 30 && bullEngulf && volSpike) {
      if (inShort) sigs.push({ ts: bar.time, price: bar.close, signal: "CLOSE_SHORT" });
      sigs.push({ ts: bar.time, price: bar.close, signal: "LONG" });
      inLong = true; inShort = false;
      lastSigMs = bar.time;
    } else if (!trendDayUp && r1h > 70 && bearEngulf && volSpike) {
      if (inLong) sigs.push({ ts: bar.time, price: bar.close, signal: "CLOSE_LONG" });
      sigs.push({ ts: bar.time, price: bar.close, signal: "SHORT" });
      inShort = true; inLong = false;
      lastSigMs = bar.time;
    } else if (inLong && (!trendDayUp || r1h > 70)) {
      // Exit LONG on weakening
      sigs.push({ ts: bar.time, price: bar.close, signal: "CLOSE_LONG" });
      inLong = false; lastSigMs = bar.time;
    } else if (inShort && (trendDayUp || r1h < 30)) {
      sigs.push({ ts: bar.time, price: bar.close, signal: "CLOSE_SHORT" });
      inShort = false; lastSigMs = bar.time;
    }
  }
  return sigs;
}

function main() {
  console.log("[wave] Loading klines...");
  const c5 = loadCache("5m");
  const c1h = loadCache("1h");
  const c1d = loadCache("1d");
  console.log(`[wave] 5m=${c5.length}, 1h=${c1h.length}, 1d=${c1d.length}`);

  const priceLine: { ts: number; price: number }[] = [];
  const step = Math.max(1, Math.floor(c5.length / 4000));
  for (let i = 0; i < c5.length; i += step) priceLine.push({ ts: c5[i].time, price: c5[i].close });
  // Ensure last bar included
  if (priceLine[priceLine.length - 1].ts !== c5[c5.length - 1].time) {
    priceLine.push({ ts: c5[c5.length - 1].time, price: c5[c5.length - 1].close });
  }

  console.log("[wave] Building full priceLine for sim...");
  // Sim needs FULL price walk for accurate LIQ — use c5 as priceLine for sim, but downsample for chart later
  const fullPL = c5.map((b) => ({ ts: b.time, price: b.close }));

  console.log("[wave] Method A — ZigZag 3%...");
  const sigA = methodA_signals(c5, 3, 1);
  const resA = simulate("A: ZigZag 3%", sigA, fullPL);
  console.log(`  → ROI ${resA.roi.toFixed(2)}% · ADD ${resA.totalAddsLong}/${resA.totalAddsShort} · CLOSE ${resA.totalCloses} · WR ${resA.winCount}/${resA.winCount+resA.lossCount} · DD $${resA.maxDD.toFixed(0)} · LIQ ${resA.liquidated}`);

  console.log("[wave] Method B — RSI Divergence 1H...");
  const sigB = methodB_signals(c1h);
  const resB = simulate("B: RSI Divergence 1H", sigB, fullPL);
  console.log(`  → ROI ${resB.roi.toFixed(2)}% · ADD ${resB.totalAddsLong}/${resB.totalAddsShort} · CLOSE ${resB.totalCloses} · WR ${resB.winCount}/${resB.winCount+resB.lossCount} · DD $${resB.maxDD.toFixed(0)} · LIQ ${resB.liquidated}`);

  console.log("[wave] Method C — Bollinger Reversal 1H...");
  const sigC = methodC_signals(c1h);
  const resC = simulate("C: BB Reversal 1H", sigC, fullPL);
  console.log(`  → ROI ${resC.roi.toFixed(2)}% · ADD ${resC.totalAddsLong}/${resC.totalAddsShort} · CLOSE ${resC.totalCloses} · WR ${resC.winCount}/${resC.winCount+resC.lossCount} · DD $${resC.maxDD.toFixed(0)} · LIQ ${resC.liquidated}`);

  console.log("[wave] Method D — Multi-TF Confluence...");
  const sigD = methodD_signals(c5, c1h, c1d);
  const resD = simulate("D: Multi-TF Confluence", sigD, fullPL);
  console.log(`  → ROI ${resD.roi.toFixed(2)}% · ADD ${resD.totalAddsLong}/${resD.totalAddsShort} · CLOSE ${resD.totalCloses} · WR ${resD.winCount}/${resD.winCount+resD.lossCount} · DD $${resD.maxDD.toFixed(0)} · LIQ ${resD.liquidated}`);

  // Save aggregate
  const out = {
    period: { start: c5[0].time, end: c5[c5.length - 1].time },
    initialCapital: INITIAL_CAPITAL,
    priceLine,
    methods: [resA, resB, resC, resD].map((r) => ({
      ...r,
      // cap events to 1500 newest cho UI nhẹ
      events: r.events.slice(-1500),
      equityCurve: r.equityCurve.filter((_, i) => i % 4 === 0).slice(-1500),
    })),
  };
  const outPath = join(__dirname, "..", "assets", "backtest_wave_methods_3y.json");
  writeFileSync(outPath, JSON.stringify(out));
  console.log(`\n[wave] Saved → ${outPath}`);

  // Summary table
  console.log("\n=== COMPARISON ===");
  console.log("Method                    ROI%      DD$       Trades   WR        LIQ");
  for (const r of [resA, resB, resC, resD]) {
    const wr = r.winCount + r.lossCount > 0 ? `${r.winCount}/${r.winCount+r.lossCount} (${(r.winCount/(r.winCount+r.lossCount)*100).toFixed(0)}%)` : "—";
    console.log(`${r.name.padEnd(26)}${r.roi.toFixed(2).padStart(8)}  ${r.maxDD.toFixed(0).padStart(8)}  ${(r.totalAddsLong+r.totalAddsShort).toString().padStart(7)}  ${wr.padEnd(10)}${r.liquidated ? 'YES' : 'NO'}`);
  }
}

main();
