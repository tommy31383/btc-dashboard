/**
 * export-meta-labeling-samples.ts — Direction 3 ML pipeline.
 *
 * Replay backtest hedge01 v0.4.33 trên 3y data, export CSV samples cho LightGBM training:
 *   feature_1..feature_N, label (1=win, 0=lose), timestamp, setup_id
 *
 * Mỗi entry → 1 row. Label = 1 nếu trade hit TP, 0 nếu hit SL.
 * Time-to-resolution (TTR) cũng được log để debug.
 *
 * Output: assets/meta_samples_h01_3y.csv (ready for scripts/meta_labeling/train.py)
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const FEE_PCT = 0.05;
const TP_PCT = 10;
const SL_PCT = 8;
const MAX_HOLD_BARS = 1440;  // 5 days × 288 bars/day = max wait

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }
type Regime = "BULL" | "RANGE" | "BEAR";

function loadCache(tf: string): Candle[] {
  return JSON.parse(readFileSync(join(__dirname, "..", ".cache", `binance-${tf}-3y.json`), "utf8"));
}
function calcSMA(a: number[], p: number): (number | null)[] {
  const o: (number | null)[] = new Array(a.length).fill(null); if (a.length < p) return o;
  let s = 0; for (let i = 0; i < p; i++) s += a[i]; o[p - 1] = s / p;
  for (let i = p; i < a.length; i++) { s += a[i] - a[i - p]; o[i] = s / p; } return o;
}
function calcEMA(a: number[], p: number): (number | null)[] {
  const o: (number | null)[] = new Array(a.length).fill(null); if (a.length < p) return o;
  const k = 2 / (p + 1); let e = 0;
  for (let i = 0; i < p; i++) e += a[i]; e /= p; o[p - 1] = e;
  for (let i = p; i < a.length; i++) { e = a[i] * k + e * (1 - k); o[i] = e; } return o;
}
function calcStdev(a: number[], p: number, sma: (number | null)[]): (number | null)[] {
  const o: (number | null)[] = new Array(a.length).fill(null);
  for (let i = p - 1; i < a.length; i++) {
    const m = sma[i]; if (m === null) continue;
    let sq = 0; for (let j = i - p + 1; j <= i; j++) sq += (a[j] - m) ** 2; o[i] = Math.sqrt(sq / p);
  } return o;
}
function calcRSI(c: number[], p: number): (number | null)[] {
  const o: (number | null)[] = new Array(c.length).fill(null); if (c.length <= p) return o;
  let g = 0, l = 0; for (let i = 1; i <= p; i++) { const ch = c[i] - c[i - 1]; if (ch >= 0) g += ch; else l -= ch; }
  let ag = g / p, al = l / p; o[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = p + 1; i < c.length; i++) {
    const ch = c[i] - c[i - 1];
    ag = (ag * (p - 1) + Math.max(ch, 0)) / p; al = (al * (p - 1) + Math.max(-ch, 0)) / p;
    o[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  } return o;
}
function calcStochK(c: Candle[], p: number): (number | null)[] {
  const o: (number | null)[] = new Array(c.length).fill(null);
  for (let i = p - 1; i < c.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - p + 1; j <= i; j++) { if (c[j].high > hi) hi = c[j].high; if (c[j].low < lo) lo = c[j].low; }
    o[i] = hi === lo ? 50 : ((c[i].close - lo) / (hi - lo)) * 100;
  } return o;
}
function calcATR(c: Candle[], p: number): (number | null)[] {
  const o: (number | null)[] = new Array(c.length).fill(null); if (c.length <= p) return o;
  const tr: number[] = new Array(c.length).fill(0);
  for (let i = 1; i < c.length; i++) tr[i] = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
  let s = 0; for (let i = 1; i <= p; i++) s += tr[i]; o[p] = s / p;
  for (let i = p + 1; i < c.length; i++) o[i] = (o[i - 1]! * (p - 1) + tr[i]) / p; return o;
}
function calcMACDHist(c: number[]): (number | null)[] {
  const e12 = calcEMA(c, 12), e26 = calcEMA(c, 26);
  const macd: (number | null)[] = c.map((_, i) => (e12[i] != null && e26[i] != null) ? e12[i]! - e26[i]! : null);
  const v: number[] = [], m: number[] = [];
  for (let i = 0; i < macd.length; i++) if (macd[i] !== null) { v.push(macd[i]!); m.push(i); }
  const sigEma = calcEMA(v, 9);
  const signal: (number | null)[] = new Array(c.length).fill(null);
  for (let k = 0; k < sigEma.length; k++) if (sigEma[k] !== null) signal[m[k]] = sigEma[k];
  return c.map((_, i) => (macd[i] != null && signal[i] != null) ? macd[i]! - signal[i]! : null);
}
function findIdx(arr: Candle[], ts: number, hint: number = 0): number {
  let lo = hint, hi = arr.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (arr[mid].time <= ts) lo = mid; else hi = mid - 1; }
  return lo;
}

interface Sample {
  timestamp: number;
  setup_id: string;
  side: "LONG" | "SHORT";
  entry_price: number;
  longScore: number; shortScore: number;
  rsi15: number; rsi1h: number; stoch15: number; macdH15: number;
  distMA50_15: number; bbPos15: number;
  mom5_15: number; mom10_15: number; mom20_15: number;
  atrRatio15: number; volRatio15: number; distMA200_5: number;
  regime_code: number; hour: number; dow: number;
  label?: 0 | 1;
  ttr_bars?: number;
  exit_reason?: "TP" | "SL" | "TIMEOUT";
}

function main() {
  console.log("[meta-export] Loading caches...");
  const c5 = loadCache("5m");
  const c15 = loadCache("15m");
  const c1h = loadCache("1h");
  const c1d = loadCache("1d");

  console.log("[meta-export] Pre-computing indicators...");
  const close15 = c15.map(b => b.close);
  const vol15 = c15.map(b => b.volume ?? 0);
  const ma20_15 = calcSMA(close15, 20);
  const ma50_15 = calcSMA(close15, 50);
  const sd20_15 = calcStdev(close15, 20, ma20_15);
  const rsi15 = calcRSI(close15, 14);
  const stoch15 = calcStochK(c15, 14);
  const macdH15 = calcMACDHist(close15);
  const atr14_15 = calcATR(c15, 14);
  const volMA_15 = calcSMA(vol15, 20);
  const rsi1h = calcRSI(c1h.map(b => b.close), 14);
  const ma200_5m = calcSMA(c5.map(b => b.close), 200);
  const ma200d = calcSMA(c1d.map(b => b.close), 200);
  const ma50d = calcSMA(c1d.map(b => b.close), 50);

  console.log("[meta-export] Generating samples...");
  const samples: Sample[] = [];
  let idx15 = 0, idx1h = 0, idx1d = 0;
  let last15IdxProcessed = -1;

  for (let i = 60; i < c5.length; i++) {
    const bar = c5[i]; const ts = bar.time; const mark = bar.close;
    idx15 = findIdx(c15, ts, idx15);
    idx1h = findIdx(c1h, ts, idx1h);
    idx1d = findIdx(c1d, ts, idx1d);
    const idx15c = idx15 - 1; const idx5c = i - 1; const idx1hc = idx1h - 1; const idx1dc = idx1d - 1;
    if (idx15c < 60 || idx15c <= last15IdxProcessed) continue;
    last15IdxProcessed = idx15c;

    // Score
    const last = c15[idx15c];
    const r = rsi15[idx15c] ?? 50, sk = stoch15[idx15c] ?? 50, mh = macdH15[idx15c] ?? 0;
    const m50v = ma50_15[idx15c], m20v = ma20_15[idx15c], s20v = sd20_15[idx15c] ?? 0;
    const atr14v = atr14_15[idx15c] ?? 0, vmv = volMA_15[idx15c] ?? 0;
    const dnWick = (Math.min(last.open, last.close) - last.low) / last.open * 100;
    const upWick = (last.high - Math.max(last.open, last.close)) / last.open * 100;
    const body = Math.abs(last.close - last.open) / last.open * 100;
    const isBull = last.close > last.open ? 1 : 0;
    const volR = vmv > 0 ? (last.volume ?? 0) / vmv : 0;
    const bbPos = (m20v !== null && s20v > 0) ? (last.close - (m20v - 2 * s20v)) / (4 * s20v) * 100 : 50;
    const mom5 = idx15c >= 5 ? (last.close - c15[idx15c - 5].close) / c15[idx15c - 5].close * 100 : 0;
    const mom10 = idx15c >= 10 ? (last.close - c15[idx15c - 10].close) / c15[idx15c - 10].close * 100 : 0;
    const mom20 = idx15c >= 20 ? (last.close - c15[idx15c - 20].close) / c15[idx15c - 20].close * 100 : 0;
    const atrRatio = atr14v > 0 ? (last.high - last.low) / atr14v : 0;
    const distMA50 = m50v !== null ? (last.close - m50v) / m50v * 100 : 0;
    let lS = 0, sS = 0;
    if (dnWick >= 0.5) lS++; if (body >= 0.5) lS++; if (isBull === 0) lS++;
    if (volR >= 2.0) lS++; if (atrRatio >= 1.5) lS++; if (r <= 35) lS++;
    if (sk <= 30) lS++; if (mh <= -100) lS++; if (bbPos <= 5) lS++;
    if (distMA50 <= -3) lS++; if (mom5 < 0 && mom10 < 0 && mom20 < 0) lS++;
    if (upWick >= 0.5) sS++; if (body >= 0.5) sS++; if (isBull === 1) sS++;
    if (volR >= 2.0) sS++; if (atrRatio >= 1.5) sS++; if (r >= 65) sS++;
    if (sk >= 70) sS++; if (mh >= 100) sS++; if (bbPos >= 95) sS++;
    if (distMA50 >= 3) sS++; if (mom5 > 0 && mom10 > 0 && mom20 > 0) sS++;

    // Regime
    const m200d = ma200d[idx1dc]; const m50d = ma50d[idx1dc];
    let regimeCode = 0;
    if (idx1dc >= 200 && m200d !== null) {
      const lastD = c1d[idx1dc];
      if (lastD.close < m200d) regimeCode = -1;
      else if (m50d !== null && lastD.close > m50d && m50d > m200d) regimeCode = 1;
    }

    // distMA200 5m
    let distMA200_5 = 0;
    const m200_5 = ma200_5m[idx5c];
    if (m200_5 !== null) distMA200_5 = (mark - m200_5) / m200_5 * 100;

    const d = new Date(ts);
    const hour = d.getUTCHours();
    const dow = d.getUTCDay();

    // Fire condition (score ≥ 9)
    if (lS >= 9) {
      const sample: Sample = {
        timestamp: ts, setup_id: `agg(${lS})`, side: "LONG", entry_price: mark,
        longScore: lS, shortScore: sS, rsi15: r, rsi1h: rsi1h[idx1hc] ?? 50,
        stoch15: sk, macdH15: mh, distMA50_15: distMA50, bbPos15: bbPos,
        mom5_15: mom5, mom10_15: mom10, mom20_15: mom20,
        atrRatio15: atrRatio, volRatio15: volR, distMA200_5: distMA200_5,
        regime_code: regimeCode, hour, dow,
      };
      // Lookahead: trade outcome trên 5m bars sau ts đến TP or SL or timeout
      const tp = mark * (1 + TP_PCT / 100);
      const sl = mark * (1 - SL_PCT / 100);
      let resolved = false;
      for (let k = i + 1; k < Math.min(c5.length, i + 1 + MAX_HOLD_BARS); k++) {
        const fwd = c5[k];
        if (fwd.high >= tp) { sample.label = 1; sample.exit_reason = "TP"; sample.ttr_bars = k - i; resolved = true; break; }
        if (fwd.low <= sl) { sample.label = 0; sample.exit_reason = "SL"; sample.ttr_bars = k - i; resolved = true; break; }
      }
      if (!resolved) { sample.label = 0; sample.exit_reason = "TIMEOUT"; sample.ttr_bars = MAX_HOLD_BARS; }
      samples.push(sample);
    }
    if (sS >= 9) {
      const sample: Sample = {
        timestamp: ts, setup_id: `aggS(${sS})`, side: "SHORT", entry_price: mark,
        longScore: lS, shortScore: sS, rsi15: r, rsi1h: rsi1h[idx1hc] ?? 50,
        stoch15: sk, macdH15: mh, distMA50_15: distMA50, bbPos15: bbPos,
        mom5_15: mom5, mom10_15: mom10, mom20_15: mom20,
        atrRatio15: atrRatio, volRatio15: volR, distMA200_5: distMA200_5,
        regime_code: regimeCode, hour, dow,
      };
      const tp = mark * (1 - TP_PCT / 100);
      const sl = mark * (1 + SL_PCT / 100);
      let resolved = false;
      for (let k = i + 1; k < Math.min(c5.length, i + 1 + MAX_HOLD_BARS); k++) {
        const fwd = c5[k];
        if (fwd.low <= tp) { sample.label = 1; sample.exit_reason = "TP"; sample.ttr_bars = k - i; resolved = true; break; }
        if (fwd.high >= sl) { sample.label = 0; sample.exit_reason = "SL"; sample.ttr_bars = k - i; resolved = true; break; }
      }
      if (!resolved) { sample.label = 0; sample.exit_reason = "TIMEOUT"; sample.ttr_bars = MAX_HOLD_BARS; }
      samples.push(sample);
    }
  }

  console.log(`[meta-export] Generated ${samples.length} samples`);
  const pos = samples.filter(s => s.label === 1).length;
  console.log(`  Positive rate: ${(pos / samples.length * 100).toFixed(1)}%`);
  const tp_count = samples.filter(s => s.exit_reason === "TP").length;
  const sl_count = samples.filter(s => s.exit_reason === "SL").length;
  const to_count = samples.filter(s => s.exit_reason === "TIMEOUT").length;
  console.log(`  TP: ${tp_count}, SL: ${sl_count}, TIMEOUT: ${to_count}`);

  // CSV export
  const header = ["timestamp", "setup_id", "side", "entry_price",
    "longScore", "shortScore", "rsi15", "rsi1h", "stoch15", "macdH15",
    "distMA50_15", "bbPos15", "mom5_15", "mom10_15", "mom20_15",
    "atrRatio15", "volRatio15", "distMA200_5",
    "regime_code", "hour", "dow", "label", "ttr_bars", "exit_reason"];
  const lines = [header.join(",")];
  for (const s of samples) {
    lines.push([
      s.timestamp, s.setup_id, s.side, s.entry_price,
      s.longScore, s.shortScore, s.rsi15.toFixed(3), s.rsi1h.toFixed(3),
      s.stoch15.toFixed(3), s.macdH15.toFixed(3),
      s.distMA50_15.toFixed(4), s.bbPos15.toFixed(3),
      s.mom5_15.toFixed(4), s.mom10_15.toFixed(4), s.mom20_15.toFixed(4),
      s.atrRatio15.toFixed(4), s.volRatio15.toFixed(4), s.distMA200_5.toFixed(4),
      s.regime_code, s.hour, s.dow, s.label ?? 0, s.ttr_bars ?? 0, s.exit_reason ?? ""
    ].join(","));
  }
  const outPath = join(__dirname, "..", "assets", "meta_samples_h01_3y.csv");
  writeFileSync(outPath, lines.join("\n"));
  console.log(`\nWritten ${outPath}`);
  console.log(`\nNext step:`);
  console.log(`  cd /Users/lap16116/BTC_PC/btc-trader-server/scripts/meta_labeling`);
  console.log(`  pip install -r requirements.txt`);
  console.log(`  python train.py --input ../../btc-dashboard/assets/meta_samples_h01_3y.csv --output ../models/meta_h01_v1.onnx`);
}

main();
