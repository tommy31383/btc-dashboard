/**
 * save-hedge02-winners.ts (anh Tommy 2026-05-14)
 *
 * Lưu TOÀN BỘ winners của SPEC A (TP+1.5% / SL-1% / 24h LONG) ra file JSON
 * để anh Tommy inspect: index, time, OHLC bar đó, barsToTP, MFE, MAE
 * + features tại moment đóng cây (RSI, Stoch, MACD, wick, body, BB, dMA, mom).
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const TP_PCT = 1.5;
const SL_PCT = 1.0;
const WINDOW_BARS = 288;

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }

function loadCache(tf: string): Candle[] {
  return JSON.parse(readFileSync(join(__dirname, "..", ".cache", `binance-${tf}-3y.json`), "utf8"));
}

function calcSMA(a: number[], p: number): (number|null)[] {
  const o: (number|null)[] = new Array(a.length).fill(null);
  if (a.length < p) return o;
  let s = 0; for (let i = 0; i < p; i++) s += a[i];
  o[p-1] = s/p;
  for (let i = p; i < a.length; i++) { s += a[i] - a[i-p]; o[i] = s/p; }
  return o;
}
function calcEMA(a: number[], p: number): (number|null)[] {
  const o: (number|null)[] = new Array(a.length).fill(null);
  if (a.length < p) return o;
  const k = 2/(p+1); let e = 0;
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
  const v: number[] = [], idxMap: number[] = [];
  for (let i = 0; i < macd.length; i++) if (macd[i] !== null) { v.push(macd[i]!); idxMap.push(i); }
  const sigEma = calcEMA(v, 9);
  const signal: (number|null)[] = new Array(c.length).fill(null);
  for (let k = 0; k < sigEma.length; k++) if (sigEma[k] !== null) signal[idxMap[k]] = sigEma[k];
  return c.map((_, i) => (macd[i] != null && signal[i] != null) ? macd[i]!-signal[i]! : null);
}

function main() {
  console.log(`[save-winners] SPEC A: TP+${TP_PCT}% / SL-${SL_PCT}% / 24h LONG`);
  const c = loadCache("5m");
  console.log(`  loaded ${c.length} bars 5m (Apr 2023 — Apr 2026 ~3y)`);

  // Pre-compute indicators
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

  interface Winner {
    i: number;
    time: number;
    dateUTC: string;
    open: number; high: number; low: number; close: number; volume: number;
    barsToTP: number;
    mfe: number;
    mae: number;
    // features tại moment đóng cây (no peek)
    features: {
      rsi14: number;
      stochK14: number;
      macdHist: number;
      ma20: number | null;
      ma50: number | null;
      ma200: number | null;
      distMA50_pct: number;
      distMA200_pct: number;
      bbPos_pct: number;
      dnWick_pct: number;
      upWick_pct: number;
      body_pct: number;
      isBull: number;
      volRatio: number;
      atrRatio: number;
      mom5_pct: number;
      mom10_pct: number;
      mom20_pct: number;
    };
    // 2 conditions của best combo (để dễ filter sau)
    matches_distMA50_le_neg3: boolean;
    matches_distMA200_le_neg5: boolean;
    matches_best_combo: boolean;
  }

  const winners: Winner[] = [];
  let scanned = 0;
  for (let i = 200; i < c.length - WINDOW_BARS; i++) {
    scanned++;
    const entry = c[i].close;
    const tp = entry * (1 + TP_PCT/100);
    const sl = entry * (1 - SL_PCT/100);
    let won = false, lost = false;
    let barsToTP = -1, mfe = 0, mae = 0;
    for (let j = i+1; j < i+1+WINDOW_BARS; j++) {
      const upPct = (c[j].high - entry) / entry * 100;
      const dnPct = (c[j].low - entry) / entry * 100;
      if (upPct > mfe) mfe = upPct;
      if (dnPct < mae) mae = dnPct;
      if (c[j].low <= sl) { lost = true; break; }
      if (c[j].high >= tp) { won = true; barsToTP = j - i; break; }
    }
    if (!won) continue;

    // Compute features
    const bar = c[i];
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

    const m1 = dMA50 <= -3;
    const m2 = dMA200 <= -5;

    winners.push({
      i, time: bar.time, dateUTC: new Date(bar.time).toISOString(),
      open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume ?? 0,
      barsToTP, mfe, mae,
      features: {
        rsi14: +(rsi[i] ?? 50).toFixed(2),
        stochK14: +(stochK[i] ?? 50).toFixed(2),
        macdHist: +(macdH[i] ?? 0).toFixed(2),
        ma20: ma20[i] !== null ? +ma20[i]!.toFixed(2) : null,
        ma50: ma50[i] !== null ? +ma50[i]!.toFixed(2) : null,
        ma200: ma200[i] !== null ? +ma200[i]!.toFixed(2) : null,
        distMA50_pct: +dMA50.toFixed(3),
        distMA200_pct: +dMA200.toFixed(3),
        bbPos_pct: +bbPos.toFixed(2),
        dnWick_pct: +dnWick.toFixed(3),
        upWick_pct: +upWick.toFixed(3),
        body_pct: +body.toFixed(3),
        isBull,
        volRatio: +volR.toFixed(3),
        atrRatio: +atrR.toFixed(3),
        mom5_pct: +mom5.toFixed(3),
        mom10_pct: +mom10.toFixed(3),
        mom20_pct: +mom20.toFixed(3),
      },
      matches_distMA50_le_neg3: m1,
      matches_distMA200_le_neg5: m2,
      matches_best_combo: m1 && m2,
    });
  }

  // Stats
  const matchBest = winners.filter(w => w.matches_best_combo).length;
  const meanBars = winners.reduce((s, w) => s + w.barsToTP, 0) / winners.length;
  const meanMAE = winners.reduce((s, w) => s + w.mae, 0) / winners.length;
  const meanMFE = winners.reduce((s, w) => s + w.mfe, 0) / winners.length;

  console.log(`\n=== STATS ===`);
  console.log(`  Bars scanned: ${scanned.toLocaleString()}`);
  console.log(`  Winners (TP+1.5% trước SL-1% trong 24h): ${winners.length.toLocaleString()}`);
  console.log(`  Match BEST combo (distMA50≤-3% AND distMA200≤-5%): ${matchBest.toLocaleString()}`);
  console.log(`  Mean bars to TP: ${meanBars.toFixed(1)} (${(meanBars*5).toFixed(0)} phút ≈ ${(meanBars*5/60).toFixed(1)}h)`);
  console.log(`  Mean MAE: ${meanMAE.toFixed(2)}% (drawdown TB của winners trước khi hit TP)`);
  console.log(`  Mean MFE: ${meanMFE.toFixed(2)}% (max favorable excursion TB)`);

  // Save
  const outPath = join(__dirname, "..", "assets", "hedge02_winners_spec_a_tp1.5_sl1_24h.json");
  const meta = {
    spec: "SPEC_A_TP1.5_SL1_24h_LONG",
    description: "Tất cả cây 5m mà sau đó tăng ≥1.5% TRƯỚC khi giảm quá -1%, window 24h",
    TP_PCT, SL_PCT, WINDOW_BARS, side: "LONG",
    bars_source: "Binance Spot BTCUSDT 5m, Apr 2023 — Apr 2026 (~3y, 315k bars)",
    bars_scanned: scanned,
    winners_total: winners.length,
    winners_matching_best_combo: matchBest,
    best_combo: "distMA50 ≤ -3% AND distMA200 ≤ -5% (WR 54.75%, lift 1.39×, ROI3y +59.4%)",
    stats: {
      mean_bars_to_tp: +meanBars.toFixed(2),
      mean_minutes_to_tp: +(meanBars*5).toFixed(0),
      mean_hours_to_tp: +(meanBars*5/60).toFixed(2),
      mean_mae_pct: +meanMAE.toFixed(3),
      mean_mfe_pct: +meanMFE.toFixed(3),
    },
    generated_at: new Date().toISOString(),
  };
  writeFileSync(outPath, JSON.stringify({ meta, winners }, null, 2));
  console.log(`\n[save-winners] ✅ Saved ${winners.length.toLocaleString()} winners → ${outPath}`);
  const sizeBytes = JSON.parse(readFileSync(outPath, "utf8"));
  const sizeMB = (JSON.stringify(sizeBytes).length / 1024 / 1024).toFixed(1);
  console.log(`              file size: ${sizeMB} MB`);
}

main();
