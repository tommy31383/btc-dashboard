/**
 * analyze-peak-bottom-1h.ts (anh Tommy 2026-05-04)
 *
 * Phân tích đặc điểm cây nến TẠI đỉnh/đáy thực sự trên 1H:
 *   - Đỉnh: high[i] = max(±24h) AND giá rớt ≥5% trong 48h tiếp theo
 *   - Đáy:  low[i] = min(±24h) AND giá tăng ≥5% trong 48h tiếp theo
 *
 * Đo 12 features tại mỗi đỉnh/đáy + so với nền chung (random).
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const WINDOW = 24;             // ±24 bar 1H = ±1 ngày
const REV_LOOKAHEAD = 48;      // 48 bar = 2 ngày
const REV_PCT = 5;             // ≥5% reversal

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }

function loadCache(tf: string): Candle[] {
  const p = join(__dirname, "..", ".cache", `binance-${tf}-3y.json`);
  if (!existsSync(p)) throw new Error(`Missing ${p}`);
  return JSON.parse(readFileSync(p, "utf8"));
}
function calcSMA(a: number[], p: number): (number|null)[] {
  const out: (number|null)[] = new Array(a.length).fill(null);
  if (a.length < p) return out;
  let s=0; for (let i=0;i<p;i++) s+=a[i]; out[p-1]=s/p;
  for (let i=p;i<a.length;i++){s+=a[i]-a[i-p]; out[i]=s/p;}
  return out;
}
function calcEMA(a: number[], p: number): (number|null)[] {
  const out: (number|null)[] = new Array(a.length).fill(null);
  if (a.length<p) return out;
  const k=2/(p+1);
  let e=0; for (let i=0;i<p;i++) e+=a[i]; e/=p; out[p-1]=e;
  for (let i=p;i<a.length;i++){e=a[i]*k+e*(1-k); out[i]=e;}
  return out;
}
function calcStdev(a: number[], p: number, sma: (number|null)[]): (number|null)[] {
  const out: (number|null)[] = new Array(a.length).fill(null);
  for (let i=p-1;i<a.length;i++){const m=sma[i]; if (m===null) continue; let sq=0; for (let j=i-p+1;j<=i;j++) sq+=(a[j]-m)**2; out[i]=Math.sqrt(sq/p);}
  return out;
}
function calcRSI(c: number[], p: number): (number|null)[] {
  const out: (number|null)[] = new Array(c.length).fill(null);
  if (c.length<=p) return out;
  let g=0,l=0;
  for (let i=1;i<=p;i++){const ch=c[i]-c[i-1]; if (ch>=0) g+=ch; else l-=ch;}
  let ag=g/p, al=l/p; out[p]=al===0?100:100-100/(1+ag/al);
  for (let i=p+1;i<c.length;i++){const ch=c[i]-c[i-1]; ag=(ag*(p-1)+Math.max(ch,0))/p; al=(al*(p-1)+Math.max(-ch,0))/p; out[i]=al===0?100:100-100/(1+ag/al);}
  return out;
}
function calcStochK(c: Candle[], p: number): (number|null)[] {
  const out: (number|null)[] = new Array(c.length).fill(null);
  for (let i=p-1;i<c.length;i++){
    let hi=-Infinity, lo=Infinity;
    for (let j=i-p+1;j<=i;j++){if (c[j].high>hi) hi=c[j].high; if (c[j].low<lo) lo=c[j].low;}
    out[i] = hi===lo ? 50 : ((c[i].close-lo)/(hi-lo))*100;
  }
  return out;
}
function calcATR(c: Candle[], p: number): (number|null)[] {
  const out: (number|null)[] = new Array(c.length).fill(null);
  if (c.length<=p) return out;
  const tr: number[] = new Array(c.length).fill(0);
  for (let i=1;i<c.length;i++) tr[i]=Math.max(c[i].high-c[i].low, Math.abs(c[i].high-c[i-1].close), Math.abs(c[i].low-c[i-1].close));
  let s=0; for (let i=1;i<=p;i++) s+=tr[i]; out[p]=s/p;
  for (let i=p+1;i<c.length;i++) out[i]=(out[i-1]!*(p-1)+tr[i])/p;
  return out;
}
function calcMACDHist(c: number[]): (number|null)[] {
  const e12 = calcEMA(c,12), e26 = calcEMA(c,26);
  const macd: (number|null)[] = c.map((_,i) => (e12[i]!=null && e26[i]!=null) ? e12[i]!-e26[i]! : null);
  const valid: number[] = []; const map: number[] = [];
  for (let i=0;i<macd.length;i++) if (macd[i]!==null){valid.push(macd[i]!); map.push(i);}
  const sigEma = calcEMA(valid, 9);
  const signal: (number|null)[] = new Array(c.length).fill(null);
  for (let k=0;k<sigEma.length;k++) if (sigEma[k]!==null) signal[map[k]] = sigEma[k];
  const hist: (number|null)[] = c.map((_,i) => (macd[i]!=null && signal[i]!=null) ? macd[i]!-signal[i]! : null);
  return hist;
}

function pct(x: number[], q: number): number {
  if (x.length===0) return NaN;
  const sorted = [...x].sort((a,b)=>a-b);
  const idx = Math.floor(sorted.length * q);
  return sorted[Math.min(idx, sorted.length-1)];
}
function mean(x: number[]): number { return x.length ? x.reduce((s,v)=>s+v,0)/x.length : NaN; }

function main() {
  console.log("[peak-bottom] Loading 1H...");
  const c = loadCache("1h");
  const closes = c.map(b=>b.close);
  console.log(`[peak-bottom] ${c.length} bars 1H`);

  // Indicators
  const rsi = calcRSI(closes, 14);
  const stochK = calcStochK(c, 14);
  const macdH = calcMACDHist(closes);
  const ma50 = calcSMA(closes, 50);
  const ma20 = calcSMA(closes, 20);
  const sd20 = calcStdev(closes, 20, ma20);
  const atr14 = calcATR(c, 14);
  const vols = c.map(b=>b.volume??0);
  const volMA = calcSMA(vols, 20);

  // Identify peaks + bottoms
  const peaks: number[] = []; // indices
  const bottoms: number[] = [];
  for (let i = WINDOW; i < c.length - REV_LOOKAHEAD; i++) {
    // Peak: high[i] = max in [i-WINDOW..i+WINDOW]
    let isMax = true;
    for (let j=i-WINDOW; j<=i+WINDOW; j++) if (j!==i && c[j].high >= c[i].high) {isMax = false; break;}
    if (isMax) {
      // Reversal: min low in [i+1..i+REV_LOOKAHEAD] <= high[i] × (1 - 5%)
      let minLow = Infinity;
      for (let j=i+1; j<=i+REV_LOOKAHEAD; j++) if (c[j].low < minLow) minLow = c[j].low;
      if (minLow <= c[i].high * (1 - REV_PCT/100)) peaks.push(i);
    }
    let isMin = true;
    for (let j=i-WINDOW; j<=i+WINDOW; j++) if (j!==i && c[j].low <= c[i].low) {isMin = false; break;}
    if (isMin) {
      let maxHigh = -Infinity;
      for (let j=i+1; j<=i+REV_LOOKAHEAD; j++) if (c[j].high > maxHigh) maxHigh = c[j].high;
      if (maxHigh >= c[i].low * (1 + REV_PCT/100)) bottoms.push(i);
    }
  }
  console.log(`[peak-bottom] Found ${peaks.length} peaks, ${bottoms.length} bottoms (definition C)`);

  // Random baseline
  const randomIdx: number[] = [];
  const RANDOM_N = Math.max(peaks.length, bottoms.length) * 5;
  for (let k=0;k<RANDOM_N;k++) randomIdx.push(Math.floor(Math.random()*(c.length-WINDOW-REV_LOOKAHEAD)) + WINDOW);

  // Extract features
  function feats(idx: number) {
    const b = c[idx];
    const body = Math.abs(b.close-b.open)/b.open*100;
    const upWick = (b.high - Math.max(b.open,b.close))/b.open*100;
    const dnWick = (Math.min(b.open,b.close) - b.low)/b.open*100;
    const isBull = b.close > b.open ? 1 : 0;
    const volR = volMA[idx] && volMA[idx]! > 0 ? (b.volume??0) / volMA[idx]! : NaN;
    const ma = ma20[idx], sd = sd20[idx];
    const bbPos = (ma!==null && sd!==null && sd>0) ? (b.close - (ma-2*sd))/((ma+2*sd)-(ma-2*sd))*100 : NaN;
    const mom5 = idx>=5 ? (b.close - c[idx-5].close)/c[idx-5].close*100 : NaN;
    const atr = atr14[idx]; const range = b.high - b.low;
    const atrRatio = atr && atr>0 ? range/atr : NaN;
    const distMA50 = ma50[idx] && ma50[idx]! > 0 ? (b.close - ma50[idx]!)/ma50[idx]!*100 : NaN;
    return {
      rsi: rsi[idx] ?? NaN,
      stochK: stochK[idx] ?? NaN,
      macdH: macdH[idx] ?? NaN,
      body, upWick, dnWick, isBull,
      volRatio: volR,
      bbPos,
      mom5,
      atrRatio,
      distMA50,
    };
  }

  const peakFeats = peaks.map(feats);
  const botFeats = bottoms.map(feats);
  const randFeats = randomIdx.map(feats);

  // Stats per feature
  const FEATS = ["rsi","stochK","macdH","body","upWick","dnWick","isBull","volRatio","bbPos","mom5","atrRatio","distMA50"];
  function stats(arr: any[], key: string){
    const vals = arr.map(o=>o[key]).filter(v=>Number.isFinite(v));
    return {n: vals.length, mean: mean(vals), p25: pct(vals,0.25), median: pct(vals,0.5), p75: pct(vals,0.75)};
  }

  console.log("\n=== FEATURES AT PEAKS vs BOTTOMS vs BASELINE ===");
  console.log("Feature        | PEAK (n="+peakFeats.length+")              | BOTTOM (n="+botFeats.length+")            | BASELINE (n="+randFeats.length+")");
  console.log("               | mean   p25    med    p75   | mean   p25    med    p75   | mean   p25    med    p75");
  console.log("-".repeat(125));
  for (const f of FEATS){
    const p = stats(peakFeats, f), bo = stats(botFeats, f), ra = stats(randFeats, f);
    const fmt = (s: any) => `${s.mean.toFixed(2).padStart(6)} ${s.p25.toFixed(2).padStart(6)} ${s.median.toFixed(2).padStart(6)} ${s.p75.toFixed(2).padStart(6)}`;
    console.log(`${f.padEnd(14)} | ${fmt(p)} | ${fmt(bo)} | ${fmt(ra)}`);
  }

  // Highlight features with strong signal (peak/bottom mean far from baseline)
  console.log("\n=== TOP DISCRIMINATING FEATURES (|peak−base| + |bottom−base|, normalized) ===");
  const scored: { feat: string; peakDelta: number; botDelta: number; score: number; peakMean: number; botMean: number; baseMean: number }[] = [];
  for (const f of FEATS){
    const p = stats(peakFeats, f), bo = stats(botFeats, f), ra = stats(randFeats, f);
    if (!Number.isFinite(p.mean) || !Number.isFinite(bo.mean) || !Number.isFinite(ra.mean)) continue;
    const baseRange = (Math.abs(ra.p75-ra.p25)) || Math.abs(ra.mean) || 1;
    const peakDelta = (p.mean - ra.mean) / baseRange;
    const botDelta = (bo.mean - ra.mean) / baseRange;
    const score = Math.abs(peakDelta) + Math.abs(botDelta);
    scored.push({feat:f, peakDelta, botDelta, score, peakMean:p.mean, botMean:bo.mean, baseMean:ra.mean});
  }
  scored.sort((a,b)=>b.score-a.score);
  console.log("Feature        | Peak mean | Bot mean  | Base mean | PeakΔ(σ) | BotΔ(σ) | Score");
  for (const s of scored){
    console.log(`${s.feat.padEnd(14)} | ${s.peakMean.toFixed(2).padStart(9)} | ${s.botMean.toFixed(2).padStart(9)} | ${s.baseMean.toFixed(2).padStart(9)} | ${s.peakDelta.toFixed(2).padStart(8)} | ${s.botDelta.toFixed(2).padStart(7)} | ${s.score.toFixed(2)}`);
  }

  // Save events for chart (top 50 + 50)
  const peakEvents = peaks.map(i => ({ts: c[i].time, kind:"PEAK", price: c[i].high, ...feats(i)}));
  const botEvents = bottoms.map(i => ({ts: c[i].time, kind:"BOTTOM", price: c[i].low, ...feats(i)}));

  const priceLine = c.map(b=>({ts:b.time, price:b.close}));

  const out = {
    period: { start: c[0].time, end: c[c.length-1].time },
    config: { window: WINDOW, revLookahead: REV_LOOKAHEAD, revPct: REV_PCT, definition: "C" },
    peaks: peakEvents, bottoms: botEvents,
    discriminating: scored,
    priceLine,
  };
  writeFileSync(join(__dirname,"..","assets","analyze_peaks_bottoms_1h.json"), JSON.stringify(out));
  console.log("\nSaved → assets/analyze_peaks_bottoms_1h.json");
}
main();
