/**
 * export-trend-samples-7y.ts — Export trend setup samples (S12/S13/S14) cho ML training.
 *
 * Generate CSV: mỗi lần trend signal fires trên 7y data, log features + label (TP=1, SL=0).
 *
 * Features (18):
 *   trendKind (1=S12, 2=S13, 3=S14), side (1=LONG, -1=SHORT)
 *   ema_diff_pct (EMA50 vs EMA200 4h), ema_slope_pct (EMA50 momentum 5 bars)
 *   rsi1h, rsi4h, distMA200_d, distMA50_d
 *   atr14_4h_pct, vol_ratio_1h, vol_ratio_4h
 *   bbPos_4h, donchian_pos_4h
 *   regime_code, hour_utc, day_of_week
 *   trend_persistence_bars (số bar EMA50 > EMA200 liên tiếp)
 *
 * Label: 1 nếu trend trade hit TP (ATR×3 chase), 0 nếu hit SL.
 * Time horizon: track tới khi exit hoặc 7 day timeout.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const TREND_ATR_SL_MULT = 3;
const TIME_HORIZON_BARS = 2016;  // 7 ngày × 288 bars/day
const EMA_FAST = 50;
const EMA_SLOW = 200;
const ATR_BREAKOUT_MULT = 1.5;
const DONCHIAN_LOOKBACK = 20;

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }

function loadCache(name: string): Candle[] { return JSON.parse(readFileSync(join(__dirname, "..", ".cache", name), "utf8")); }
function aggregateBars(c5: Candle[], minutes: number): Candle[] {
  const targetMs = minutes * 60_000;
  const out: Candle[] = [];
  let cur: { bucket: number; bars: Candle[] } | null = null;
  for (const b of c5) {
    const bucket = Math.floor(b.time / targetMs) * targetMs;
    if (!cur || cur.bucket !== bucket) {
      if (cur && cur.bars.length > 0) {
        const bars = cur.bars;
        let hi = -Infinity, lo = Infinity, vol = 0;
        for (const x of bars) { if (x.high > hi) hi = x.high; if (x.low < lo) lo = x.low; vol += x.volume ?? 0; }
        out.push({ time: cur.bucket, open: bars[0].open, high: hi, low: lo, close: bars[bars.length - 1].close, volume: vol });
      }
      cur = { bucket, bars: [b] };
    } else cur.bars.push(b);
  }
  if (cur && cur.bars.length > 0) {
    const bars = cur.bars;
    let hi = -Infinity, lo = Infinity, vol = 0;
    for (const x of bars) { if (x.high > hi) hi = x.high; if (x.low < lo) lo = x.low; vol += x.volume ?? 0; }
    out.push({ time: cur.bucket, open: bars[0].open, high: hi, low: lo, close: bars[bars.length - 1].close, volume: vol });
  }
  return out;
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
function calcATR(c: Candle[], p: number): (number | null)[] {
  const o: (number | null)[] = new Array(c.length).fill(null); if (c.length <= p) return o;
  const tr: number[] = new Array(c.length).fill(0);
  for (let i = 1; i < c.length; i++) tr[i] = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
  let s = 0; for (let i = 1; i <= p; i++) s += tr[i]; o[p] = s / p;
  for (let i = p + 1; i < c.length; i++) o[i] = (o[i - 1]! * (p - 1) + tr[i]) / p; return o;
}
function findIdx(arr: { time: number }[], ts: number, hint: number = 0): number {
  let lo = hint, hi = arr.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (arr[mid].time <= ts) lo = mid; else hi = mid - 1; }
  return lo;
}

function main() {
  console.log("[export-trend-samples] Loading...");
  const c5 = loadCache("binance-5m-7y.json");
  const c1h = aggregateBars(c5, 60);
  const c4h = aggregateBars(c5, 240);
  const c1d = aggregateBars(c5, 1440);
  console.log(`  5m=${c5.length}, 1h=${c1h.length}, 4h=${c4h.length}, 1d=${c1d.length}`);

  console.log("[export-trend-samples] Pre-computing indicators...");
  const close1h = c1h.map(b => b.close);
  const close4h = c4h.map(b => b.close);
  const close1d = c1d.map(b => b.close);
  const ema50_4h = calcEMA(close4h, 50);
  const ema200_4h = calcEMA(close4h, 200);
  const rsi1h = calcRSI(close1h, 14);
  const rsi4h = calcRSI(close4h, 14);
  const atr14_4h = calcATR(c4h, 14);
  const ma200d = calcSMA(close1d, 200);
  const ma50d = calcSMA(close1d, 50);
  const ma20_4h = calcSMA(close4h, 20);
  const sd20_4h = calcStdev(close4h, 20, ma20_4h);
  const volMA_1h = calcSMA(c1h.map(b => b.volume ?? 0), 20);
  const volMA_4h = calcSMA(c4h.map(b => b.volume ?? 0), 20);

  console.log("[export-trend-samples] Generating samples via signal replay...");
  const samples: any[] = [];
  let idx1h = 0, idx1d = 0, idx4h = 0;
  let last4hIdx = -1;
  let trendPersistBars = 0;
  let prevTrend: "UP" | "DOWN" | null = null;

  for (let i = 0; i < c5.length; i++) {
    const bar = c5[i]; const ts = bar.time; const mark = bar.close;
    if (i < 100) continue;
    idx1h = findIdx(c1h, ts, idx1h); idx4h = findIdx(c4h, ts, idx4h); idx1d = findIdx(c1d, ts, idx1d);
    const idx4hc = idx4h - 1; const idx1hc = idx1h - 1; const idx1dc = idx1d - 1;
    if (idx4hc < EMA_SLOW + 1 || idx4hc === last4hIdx) continue;
    last4hIdx = idx4hc;

    const e50 = ema50_4h[idx4hc]; const e200 = ema200_4h[idx4hc];
    if (e50 === null || e200 === null) continue;
    const curTrend: "UP" | "DOWN" = e50 > e200 ? "UP" : "DOWN";
    if (curTrend !== prevTrend) {
      trendPersistBars = 1;
      prevTrend = curTrend;
    } else trendPersistBars++;

    // Detect trend signals
    let ema12: "LONG" | "SHORT" | null = null;
    let atr13: "LONG" | "SHORT" | null = null;
    let don14: "LONG" | "SHORT" | null = null;
    const atrVal4h = atr14_4h[idx4hc];
    if (atrVal4h === null || atrVal4h <= 0) continue;
    const fp = ema50_4h[idx4hc - 1], sp = ema200_4h[idx4hc - 1];
    const fc = e50, sc = e200;
    if (fp <= sp && fc > sc) ema12 = "LONG";
    else if (fp >= sp && fc < sc) ema12 = "SHORT";
    if (idx4hc >= 1) {
      const prev4h = c4h[idx4hc - 1]; const last4h = c4h[idx4hc];
      if (last4h.close > prev4h.close + atrVal4h * ATR_BREAKOUT_MULT) atr13 = "LONG";
      else if (last4h.close < prev4h.close - atrVal4h * ATR_BREAKOUT_MULT) atr13 = "SHORT";
    }
    if (idx4hc >= DONCHIAN_LOOKBACK) {
      let hi = -Infinity, lo = Infinity;
      for (let j = idx4hc - DONCHIAN_LOOKBACK; j < idx4hc; j++) {
        if (c4h[j].high > hi) hi = c4h[j].high; if (c4h[j].low < lo) lo = c4h[j].low;
      }
      const l4 = c4h[idx4hc];
      if (l4.close > hi) don14 = "LONG";
      else if (l4.close < lo) don14 = "SHORT";
    }

    // For each signal, compute features + lookahead label
    const recordSample = (kind: "S12" | "S13" | "S14", side: "LONG" | "SHORT") => {
      const slPx = side === "LONG" ? mark - atrVal4h * TREND_ATR_SL_MULT : mark + atrVal4h * TREND_ATR_SL_MULT;
      const tpPx = side === "LONG" ? mark + atrVal4h * TREND_ATR_SL_MULT : mark - atrVal4h * TREND_ATR_SL_MULT;
      // Simplistic label: hit TP (chase trailing) wins, hit SL loses
      let label: 0 | 1 | -1 = -1;  // -1 = timeout
      for (let k = i + 1; k < Math.min(c5.length, i + 1 + TIME_HORIZON_BARS); k++) {
        const fwd = c5[k];
        if (side === "LONG") {
          if (fwd.high >= tpPx) { label = 1; break; }
          if (fwd.low <= slPx) { label = 0; break; }
        } else {
          if (fwd.low <= tpPx) { label = 1; break; }
          if (fwd.high >= slPx) { label = 0; break; }
        }
      }
      if (label === -1) return;  // skip timeout samples

      // Compute features
      const lastD = c1d[idx1dc];
      const m200d = ma200d[idx1dc]; const m50d = ma50d[idx1dc];
      const distMA200_d = m200d !== null ? (lastD.close - m200d) / m200d * 100 : 0;
      const distMA50_d = m50d !== null ? (lastD.close - m50d) / m50d * 100 : 0;
      const ema_diff_pct = (e50 - e200) / e200 * 100;
      const slopeBase = idx4hc >= 5 ? ema50_4h[idx4hc - 5] : null;
      const ema_slope_pct = slopeBase !== null ? (e50 - slopeBase) / slopeBase * 100 : 0;
      const atr_pct = atrVal4h / mark * 100;
      const r1h = rsi1h[idx1hc] ?? 50;
      const r4h = rsi4h[idx4hc] ?? 50;
      const vmh = volMA_1h[idx1hc] ?? 0;
      const v1hRatio = vmh > 0 ? (c1h[idx1hc].volume ?? 0) / vmh : 1;
      const vm4 = volMA_4h[idx4hc] ?? 0;
      const v4hRatio = vm4 > 0 ? (c4h[idx4hc].volume ?? 0) / vm4 : 1;
      const m20v = ma20_4h[idx4hc]; const s20v = sd20_4h[idx4hc];
      const bbPos = m20v !== null && s20v !== null && s20v > 0 ? (mark - (m20v - 2 * s20v)) / (4 * s20v) * 100 : 50;
      // Donchian position: where mark sits in 20-bar range
      let dhi = -Infinity, dlo = Infinity;
      for (let j = idx4hc - DONCHIAN_LOOKBACK; j < idx4hc; j++) {
        if (c4h[j].high > dhi) dhi = c4h[j].high; if (c4h[j].low < dlo) dlo = c4h[j].low;
      }
      const donchianPos = dhi !== dlo ? (mark - dlo) / (dhi - dlo) * 100 : 50;
      const regime = m200d !== null && lastD.close < m200d ? -1 : (m50d !== null && lastD.close > m50d && m50d > m200d ? 1 : 0);
      const d = new Date(ts);
      const hour = d.getUTCHours();
      const dow = d.getUTCDay();

      samples.push({
        timestamp: ts,
        kind, side: side === "LONG" ? 1 : -1,
        trend_kind: kind === "S12" ? 1 : kind === "S13" ? 2 : 3,
        side_code: side === "LONG" ? 1 : -1,
        ema_diff_pct, ema_slope_pct,
        rsi1h: r1h, rsi4h: r4h,
        distMA200_d, distMA50_d,
        atr_pct,
        vol_ratio_1h: v1hRatio, vol_ratio_4h: v4hRatio,
        bbPos_4h: bbPos, donchian_pos_4h: donchianPos,
        regime_code: regime, hour, dow,
        trend_persistence_bars: trendPersistBars,
        label,
      });
    };

    if (ema12) recordSample("S12", ema12);
    if (atr13) recordSample("S13", atr13);
    if (don14) recordSample("S14", don14);
  }

  console.log(`\n[export-trend-samples] Generated ${samples.length} samples`);
  const pos = samples.filter(s => s.label === 1).length;
  console.log(`  Positive rate (TP hit): ${(pos / samples.length * 100).toFixed(1)}%`);
  // Per-kind breakdown
  const kinds: Record<string, { count: number; pos: number }> = {};
  for (const s of samples) {
    const k = `${s.kind}_${s.side}`;
    kinds[k] = kinds[k] ?? { count: 0, pos: 0 };
    kinds[k].count++;
    if (s.label === 1) kinds[k].pos++;
  }
  console.log("  Per-setup breakdown:");
  for (const [k, v] of Object.entries(kinds)) {
    console.log(`    ${k}: ${v.count} samples, ${(v.pos / v.count * 100).toFixed(1)}% TP`);
  }

  // CSV export
  const header = [
    "timestamp", "kind", "side", "trend_kind", "side_code",
    "ema_diff_pct", "ema_slope_pct", "rsi1h", "rsi4h",
    "distMA200_d", "distMA50_d", "atr_pct",
    "vol_ratio_1h", "vol_ratio_4h", "bbPos_4h", "donchian_pos_4h",
    "regime_code", "hour", "dow", "trend_persistence_bars", "label",
  ];
  const lines = [header.join(",")];
  for (const s of samples) {
    lines.push(header.map(h => {
      const v = s[h as keyof typeof s];
      if (typeof v === "number") return v.toFixed(4);
      return v;
    }).join(","));
  }
  const outPath = join(__dirname, "..", "assets", "meta_samples_trend_7y.csv");
  writeFileSync(outPath, lines.join("\n"));
  console.log(`\nWritten ${outPath}`);
}

main();
