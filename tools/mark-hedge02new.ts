/**
 * mark-hedge02new.ts (anh Tommy 2026-05-14)
 *
 * Spec từ anh Tommy: "tìm hết những cây nến 5 phút mà sau đó tăng 1.5%
 * nhưng không được giảm quá 1%". → bộ SLTP hedge02-new.
 *
 * Pipeline:
 *   1. Mark winners: scan 315k bars 5m, cho mỗi bar i kiểm tra forward 288 bars (24h)
 *      - TP = close × 1.015, SL = close × 0.99
 *      - WINNER: high chạm TP TRƯỚC khi low chạm SL
 *      - LOSER: low chạm SL trước, hoặc timeout
 *   2. Compute features tại moment đóng cây (NO PEEK)
 *   3. So sánh distribution winners vs baseline → top features lift > 1.5×
 *
 * Output:
 *   - assets/mark_hedge02new_tp1.5_sl1_24h_5m.json (full dataset)
 *   - stdout: lift table + summary
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const TP_PCT = 1.5;
const SL_PCT = 1.0;
const WINDOW_BARS = 288;        // 24h × 12 bars/h
const FEE_PER_SIDE_PCT = 0.05;
const POS_BTC = 0.001;

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }

function loadCache(tf: string): Candle[] {
  return JSON.parse(readFileSync(join(__dirname, "..", ".cache", `binance-${tf}-3y.json`), "utf8"));
}

// === Indicator series helpers (aligned to input length, null-padded) ===
function calcSMA(a: number[], p: number): (number|null)[] {
  const o: (number|null)[] = new Array(a.length).fill(null);
  if (a.length < p) return o;
  let s = 0;
  for (let i = 0; i < p; i++) s += a[i];
  o[p-1] = s/p;
  for (let i = p; i < a.length; i++) { s += a[i] - a[i-p]; o[i] = s/p; }
  return o;
}
function calcEMA(a: number[], p: number): (number|null)[] {
  const o: (number|null)[] = new Array(a.length).fill(null);
  if (a.length < p) return o;
  const k = 2/(p+1);
  let e = 0;
  for (let i = 0; i < p; i++) e += a[i];
  e /= p; o[p-1] = e;
  for (let i = p; i < a.length; i++) { e = a[i]*k + e*(1-k); o[i] = e; }
  return o;
}
function calcStdev(a: number[], p: number, sma: (number|null)[]): (number|null)[] {
  const o: (number|null)[] = new Array(a.length).fill(null);
  for (let i = p-1; i < a.length; i++) {
    const m = sma[i]; if (m === null) continue;
    let sq = 0; for (let j = i-p+1; j <= i; j++) sq += (a[j]-m)**2;
    o[i] = Math.sqrt(sq/p);
  }
  return o;
}
function calcRSI(c: number[], p: number): (number|null)[] {
  const o: (number|null)[] = new Array(c.length).fill(null);
  if (c.length <= p) return o;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const ch = c[i]-c[i-1]; if (ch >= 0) g += ch; else l -= ch; }
  let ag = g/p, al = l/p;
  o[p] = al === 0 ? 100 : 100-100/(1+ag/al);
  for (let i = p+1; i < c.length; i++) {
    const ch = c[i]-c[i-1];
    ag = (ag*(p-1)+Math.max(ch,0))/p;
    al = (al*(p-1)+Math.max(-ch,0))/p;
    o[i] = al === 0 ? 100 : 100-100/(1+ag/al);
  }
  return o;
}
function calcStochK(c: Candle[], p: number): (number|null)[] {
  const o: (number|null)[] = new Array(c.length).fill(null);
  for (let i = p-1; i < c.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i-p+1; j <= i; j++) { if (c[j].high > hi) hi = c[j].high; if (c[j].low < lo) lo = c[j].low; }
    o[i] = hi === lo ? 50 : ((c[i].close-lo)/(hi-lo))*100;
  }
  return o;
}
function calcATR(c: Candle[], p: number): (number|null)[] {
  const o: (number|null)[] = new Array(c.length).fill(null);
  if (c.length <= p) return o;
  const tr: number[] = new Array(c.length).fill(0);
  for (let i = 1; i < c.length; i++)
    tr[i] = Math.max(c[i].high-c[i].low, Math.abs(c[i].high-c[i-1].close), Math.abs(c[i].low-c[i-1].close));
  let s = 0;
  for (let i = 1; i <= p; i++) s += tr[i];
  o[p] = s/p;
  for (let i = p+1; i < c.length; i++) o[i] = (o[i-1]!*(p-1)+tr[i])/p;
  return o;
}
function calcMACDHist(c: number[]): (number|null)[] {
  const e12 = calcEMA(c, 12), e26 = calcEMA(c, 26);
  const macd: (number|null)[] = c.map((_, i) => (e12[i] != null && e26[i] != null) ? e12[i]!-e26[i]! : null);
  // Compact non-null for signal EMA
  const v: number[] = [], idxMap: number[] = [];
  for (let i = 0; i < macd.length; i++) if (macd[i] !== null) { v.push(macd[i]!); idxMap.push(i); }
  const sigEma = calcEMA(v, 9);
  const signal: (number|null)[] = new Array(c.length).fill(null);
  for (let k = 0; k < sigEma.length; k++) if (sigEma[k] !== null) signal[idxMap[k]] = sigEma[k];
  return c.map((_, i) => (macd[i] != null && signal[i] != null) ? macd[i]!-signal[i]! : null);
}

function main() {
  console.log(`[mark-hedge02new] TP+${TP_PCT}% / SL-${SL_PCT}% / window ${WINDOW_BARS} bars (24h) / LONG only`);
  console.log("[mark-hedge02new] Loading 5m cache...");
  const c = loadCache("5m");
  console.log(`  loaded ${c.length} bars`);

  // Pre-compute indicators (single pass)
  console.log("[mark-hedge02new] Pre-computing indicators...");
  const closes = c.map(b => b.close);
  const vols = c.map(b => b.volume ?? 0);
  const rsi = calcRSI(closes, 14);
  const stochK = calcStochK(c, 14);
  const macdH = calcMACDHist(closes);
  const ma50 = calcSMA(closes, 50);
  const ma20 = calcSMA(closes, 20);
  const ma200 = calcSMA(closes, 200);
  const sd20 = calcStdev(closes, 20, ma20);
  const atr14 = calcATR(c, 14);
  const volMA20 = calcSMA(vols, 20);

  // === Mark winners ===
  console.log("[mark-hedge02new] Marking winners...");
  interface Mark {
    i: number;            // bar index
    time: number;
    close: number;
    winner: boolean;
    barsToTP: number;     // -1 if loser
    mfe: number;          // max favorable excursion (pct)
    mae: number;          // max adverse excursion (pct, negative)
  }
  const marks: Mark[] = [];
  let winners = 0, losers = 0, skipped = 0;
  for (let i = 200; i < c.length - WINDOW_BARS; i++) {
    const entry = c[i].close;
    const tp = entry * (1 + TP_PCT/100);
    const sl = entry * (1 - SL_PCT/100);
    let mfe = 0, mae = 0;
    let won = false, lost = false;
    let barsToTP = -1;
    for (let j = i+1; j < i+1+WINDOW_BARS; j++) {
      const upPct = (c[j].high - entry) / entry * 100;
      const dnPct = (c[j].low - entry) / entry * 100;
      if (upPct > mfe) mfe = upPct;
      if (dnPct < mae) mae = dnPct;
      // Conservative: if both touched in same bar, assume SL hit first (worst case)
      if (c[j].low <= sl) { lost = true; break; }
      if (c[j].high >= tp) { won = true; barsToTP = j - i; break; }
    }
    if (won) { winners++; marks.push({ i, time: c[i].time, close: entry, winner: true, barsToTP, mfe, mae }); }
    else if (lost) { losers++; marks.push({ i, time: c[i].time, close: entry, winner: false, barsToTP: -1, mfe, mae }); }
    else { skipped++; }   // timeout — không tính winner cũng không tính loser
  }
  const total = winners + losers;
  const wr = winners / total * 100;
  console.log(`\n=== MARK RESULTS ===`);
  console.log(`  Winners:  ${winners.toLocaleString()} (${wr.toFixed(2)}% WR)`);
  console.log(`  Losers:   ${losers.toLocaleString()}`);
  console.log(`  Timeouts: ${skipped.toLocaleString()} (no TP, no SL trong 24h)`);
  console.log(`  Total scanned: ${(c.length - WINDOW_BARS - 200).toLocaleString()}`);

  // ROI nếu vào HẾT (no filter)
  const grossPerWin = POS_BTC * (TP_PCT/100);     // BTC pnl normalized by entry
  const grossPerLoss = POS_BTC * (SL_PCT/100);
  // BTC PnL (price-relative — easier comparison)
  const grossBtc = winners * grossPerWin - losers * grossPerLoss;
  // $ equivalent — use mean BTC price during dataset for rough estimate
  const meanPrice = c.reduce((s, b) => s + b.close, 0) / c.length;
  const feesPerTrade = POS_BTC * meanPrice * (FEE_PER_SIDE_PCT/100) * 2;  // entry + exit
  const totalFees = total * feesPerTrade;
  const grossUsd = grossBtc * meanPrice;
  const netUsd = grossUsd - totalFees;
  console.log(`\n=== NO-FILTER ROI (vào HẾT mỗi cây thoả condition) ===`);
  console.log(`  Mean BTC price 3y: $${meanPrice.toFixed(0)}`);
  console.log(`  Gross BTC PnL: ${grossBtc.toFixed(4)} BTC ≈ $${grossUsd.toFixed(0)}`);
  console.log(`  Fees (${total.toLocaleString()} trades × ${POS_BTC} BTC × ${FEE_PER_SIDE_PCT}% × 2): -$${totalFees.toFixed(0)}`);
  console.log(`  Net: $${netUsd.toFixed(0)}`);
  console.log(`  Expected value/trade: $${(netUsd/total).toFixed(2)}`);

  // === Feature analysis: lift @ thresholds ===
  console.log(`\n=== FEATURE LIFT (winners ${winners.toLocaleString()} vs all marked ${total.toLocaleString()}) ===`);
  const baseRate = wr / 100;

  // Helper: tính winrate khi feature condition true
  type Cond = { name: string; check: (i: number) => boolean | null };
  const cond = (name: string, check: (i: number) => boolean | null): Cond => ({ name, check });

  // Pre-compute features per bar (NO PEEK — chỉ dùng data ≤ i)
  function feat(i: number) {
    const bar = c[i], prev = i > 0 ? c[i-1] : bar;
    const dnWick = (Math.min(bar.open, bar.close) - bar.low) / bar.open * 100;
    const upWick = (bar.high - Math.max(bar.open, bar.close)) / bar.open * 100;
    const body = Math.abs(bar.close - bar.open) / bar.open * 100;
    const isBull = bar.close > bar.open ? 1 : 0;
    const volR = (volMA20[i] && volMA20[i]! > 0) ? (bar.volume ?? 0) / volMA20[i]! : 0;
    const atrR = atr14[i] ? (bar.high - bar.low) / atr14[i]! : 0;
    const bbPos = (ma20[i] !== null && sd20[i] !== null && sd20[i]! > 0)
      ? (bar.close - (ma20[i]! - 2*sd20[i]!)) / (4*sd20[i]!) * 100 : 50;
    const dMA50 = ma50[i] !== null ? (bar.close - ma50[i]!)/ma50[i]! * 100 : 0;
    const dMA200 = ma200[i] !== null ? (bar.close - ma200[i]!)/ma200[i]! * 100 : 0;
    const mom5 = i >= 6 ? (bar.close - c[i-6].close)/c[i-6].close * 100 : 0;
    const mom10 = i >= 11 ? (bar.close - c[i-11].close)/c[i-11].close * 100 : 0;
    const mom20 = i >= 21 ? (bar.close - c[i-21].close)/c[i-21].close * 100 : 0;
    return { dnWick, upWick, body, isBull, volR, atrR, bbPos, dMA50, dMA200, mom5, mom10, mom20,
             rsi: rsi[i] ?? 50, stochK: stochK[i] ?? 50, macdH: macdH[i] ?? 0 };
  }

  // Compute liftSweep for many conditions
  interface Lift { name: string; freq: number; matchTotal: number; wins: number; wr: number; lift: number; evPerTrade: number; }
  const conds: Array<{ name: string; check: (f: ReturnType<typeof feat>) => boolean }> = [
    // Pattern features
    { name: "dnWick ≥ 0.3%", check: f => f.dnWick >= 0.3 },
    { name: "dnWick ≥ 0.5%", check: f => f.dnWick >= 0.5 },
    { name: "dnWick ≥ 1.0%", check: f => f.dnWick >= 1.0 },
    { name: "upWick ≥ 0.3%", check: f => f.upWick >= 0.3 },
    { name: "upWick ≥ 0.5%", check: f => f.upWick >= 0.5 },
    { name: "body ≥ 0.3%", check: f => f.body >= 0.3 },
    { name: "body ≥ 0.5%", check: f => f.body >= 0.5 },
    { name: "isBull (xanh)", check: f => f.isBull === 1 },
    { name: "isBear (đỏ)", check: f => f.isBull === 0 },
    // Volume / volatility
    { name: "volR ≥ 1.5×", check: f => f.volR >= 1.5 },
    { name: "volR ≥ 2.0×", check: f => f.volR >= 2.0 },
    { name: "volR ≥ 3.0×", check: f => f.volR >= 3.0 },
    { name: "atrRatio ≥ 1.2×", check: f => f.atrR >= 1.2 },
    { name: "atrRatio ≥ 1.5×", check: f => f.atrR >= 1.5 },
    { name: "atrRatio ≥ 2.0×", check: f => f.atrR >= 2.0 },
    // RSI / Stoch
    { name: "RSI ≤ 25", check: f => f.rsi <= 25 },
    { name: "RSI ≤ 30", check: f => f.rsi <= 30 },
    { name: "RSI ≤ 35", check: f => f.rsi <= 35 },
    { name: "RSI ≤ 40", check: f => f.rsi <= 40 },
    { name: "RSI ≥ 60", check: f => f.rsi >= 60 },
    { name: "RSI ≥ 70", check: f => f.rsi >= 70 },
    { name: "stochK ≤ 20", check: f => f.stochK <= 20 },
    { name: "stochK ≤ 30", check: f => f.stochK <= 30 },
    { name: "stochK ≥ 70", check: f => f.stochK >= 70 },
    { name: "stochK ≥ 80", check: f => f.stochK >= 80 },
    // BB / MA
    { name: "bbPos ≤ 5%", check: f => f.bbPos <= 5 },
    { name: "bbPos ≤ 10%", check: f => f.bbPos <= 10 },
    { name: "bbPos ≤ 20%", check: f => f.bbPos <= 20 },
    { name: "bbPos ≥ 80%", check: f => f.bbPos >= 80 },
    { name: "bbPos ≥ 95%", check: f => f.bbPos >= 95 },
    { name: "distMA50 ≤ -2%", check: f => f.dMA50 <= -2 },
    { name: "distMA50 ≤ -3%", check: f => f.dMA50 <= -3 },
    { name: "distMA50 ≥ +2%", check: f => f.dMA50 >= 2 },
    { name: "distMA200 ≤ -5%", check: f => f.dMA200 <= -5 },
    { name: "distMA200 ≥ +5%", check: f => f.dMA200 >= 5 },
    // Momentum
    { name: "mom5 ≤ -1%", check: f => f.mom5 <= -1 },
    { name: "mom5 ≤ -2%", check: f => f.mom5 <= -2 },
    { name: "mom10 ≤ -2%", check: f => f.mom10 <= -2 },
    { name: "mom20 ≤ -3%", check: f => f.mom20 <= -3 },
    { name: "mom5≥0 && mom10≥0 && mom20≥0", check: f => f.mom5 >= 0 && f.mom10 >= 0 && f.mom20 >= 0 },
    { name: "mom5≤0 && mom10≤0 && mom20≤0", check: f => f.mom5 < 0 && f.mom10 < 0 && f.mom20 < 0 },
    // MACD
    { name: "macdH ≤ -50", check: f => f.macdH <= -50 },
    { name: "macdH ≤ -100", check: f => f.macdH <= -100 },
    { name: "macdH ≥ +50", check: f => f.macdH >= 50 },
    { name: "macdH ≥ +100", check: f => f.macdH >= 100 },
  ];

  const lifts: Lift[] = [];
  // Pre-allocate features per marked index
  const markedFeats = marks.map(m => feat(m.i));
  for (const { name, check } of conds) {
    let matchTotal = 0, matchWin = 0;
    for (let k = 0; k < marks.length; k++) {
      if (!check(markedFeats[k])) continue;
      matchTotal++;
      if (marks[k].winner) matchWin++;
    }
    if (matchTotal < 100) continue;  // skip thin conditions
    const matchWr = matchWin / matchTotal;
    const lift = matchWr / baseRate;
    // EV per trade: WR×TP - (1-WR)×SL - fees
    const evPct = matchWr * TP_PCT - (1 - matchWr) * SL_PCT - 2 * FEE_PER_SIDE_PCT;
    const evPerTrade = (POS_BTC * meanPrice) * (evPct / 100);
    lifts.push({ name, freq: matchTotal/total, matchTotal, wins: matchWin, wr: matchWr*100, lift, evPerTrade });
  }
  lifts.sort((a, b) => b.lift - a.lift);

  console.log(`\nBaseline WR: ${(baseRate*100).toFixed(2)}%   Total marked: ${total.toLocaleString()}\n`);
  console.log("Top 20 LIFT (winrate uplift vs base):");
  console.log("Rank  Feature                              Match    WR%     Lift   EV/trade  Freq%");
  console.log("----  -----------------------------------  -------  ------  -----  --------  -----");
  for (let r = 0; r < Math.min(20, lifts.length); r++) {
    const l = lifts[r];
    console.log(`${String(r+1).padStart(2)}    ${l.name.padEnd(36)} ${l.matchTotal.toString().padStart(7)}  ${l.wr.toFixed(2).padStart(5)}%  ${l.lift.toFixed(2).padStart(4)}×  $${l.evPerTrade.toFixed(3).padStart(7)}  ${(l.freq*100).toFixed(2)}%`);
  }
  console.log("\nBottom 5 (lift < 1.0 = HẠI):");
  for (let r = lifts.length-1; r >= Math.max(0, lifts.length-5); r--) {
    const l = lifts[r];
    console.log(`      ${l.name.padEnd(36)} ${l.matchTotal.toString().padStart(7)}  ${l.wr.toFixed(2).padStart(5)}%  ${l.lift.toFixed(2).padStart(4)}×`);
  }

  // Save full dataset
  const outPath = join(__dirname, "..", "assets", "mark_hedge02new_tp1.5_sl1_24h_5m.json");
  console.log(`\n[mark-hedge02new] Saving dataset → ${outPath}`);
  writeFileSync(outPath, JSON.stringify({
    spec: { TP_PCT, SL_PCT, WINDOW_BARS, side: "LONG" },
    summary: { winners, losers, skipped, total, wr, baseRate, meanPrice },
    lifts: lifts.slice(0, 50),
  }, null, 2));
  console.log("[mark-hedge02new] ✅ Done");
}

main();
