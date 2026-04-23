/**
 * verdict-classifier-scan.ts — Grid search scheme verdict tốt hơn
 *
 * Pre-compute 1 lần snapshot đầy đủ cho mỗi 1h tick (RSI/StochK/Div của 7 TF,
 * + ATR1h, emaDist1h, HTF trend từ EMA50 của 4h/1d/1w, RSI 1d, multi-TF score).
 *
 * Sau đó test nhiều classifier variant cùng lúc:
 *   A. Baseline legacy (osCount / obCount / div) — để so sánh
 *   B. Legacy + trend filter 1d
 *   C. Legacy + trend 1d + 1w
 *   D. adj-stoch + trend filter
 *   E. GOLDEN_LONG (iter2): ATR1h<0.3% + emaDist1h∈[-0.5,0.5] + 1d FLAT
 *   F. GOLDEN_LONG_STRICT: D + emaDist1h∈[-0.3,0.3]
 *   G. MULTI_TF_SCORE ≥70 LONG (iter4)
 *   H. MULTI_TF_SCORE ≥80 LONG
 *   I. MULTI_TF_SCORE ≥60 LONG
 *   J. Combo golden + score≥60
 *
 * Simulate TP 3%/SL 2% maxHold 50h (giữ nguyên verdict backtest config).
 */
import { writeFileSync } from "fs";
import { join } from "path";
import { calcRSI, calcStochRSISeries, detectDivergence, calcRSISeriesAligned, calcEMASeries, calcATRPct } from "../utils/indicators";

const BINANCE = "https://api.binance.com/api/v3";
interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number; }

const TFS = [
  { key: "5m",  interval: "5m",  total: 10000 },
  { key: "15m", interval: "15m", total: 10000 },
  { key: "1h",  interval: "1h",  total: 10000 },
  { key: "4h",  interval: "4h",  total: 3000  },
  { key: "1d",  interval: "1d",  total: 800   },
  { key: "1w",  interval: "1w",  total: 200   },
  { key: "1M",  interval: "1M",  total: 100   },
];
const TF_ORDER = ["5m","15m","1h","4h","1d","1w","1M"] as const;

async function fetchKlines(interval: string, total: number): Promise<Candle[]> {
  const all: Candle[] = []; let endTime: number | undefined;
  while (all.length < total) {
    const limit = Math.min(1000, total - all.length);
    const params = new URLSearchParams({ symbol: "BTCUSDT", interval, limit: String(limit) });
    if (endTime) params.set("endTime", String(endTime));
    const res = await fetch(`${BINANCE}/klines?${params}`);
    const data: any[] = await res.json();
    if (!Array.isArray(data) || !data.length) break;
    const batch = data.map((k: any) => ({ time:+k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5] }));
    all.unshift(...batch);
    endTime = batch[0].time - 1;
    await new Promise(r => setTimeout(r, 80));
  }
  const m = new Map<number, Candle>(); for (const c of all) m.set(c.time, c);
  return [...m.values()].sort((a,b) => a.time - b.time);
}
function idxAtOrBefore(arr: Candle[], t: number): number {
  let lo=0,hi=arr.length-1,ans=-1;
  while (lo<=hi){const m=(lo+hi)>>1;if(arr[m].time<=t){ans=m;lo=m+1;}else hi=m-1;} return ans;
}
function trendFromEMA(price: number, ema: number | null): "UP"|"DOWN"|"FLAT" {
  if (ema == null) return "FLAT";
  const d = (price-ema)/ema*100;
  return d>0.3?"UP":d<-0.3?"DOWN":"FLAT";
}
function simulate(c: Candle[], i: number, side: "LONG"|"SHORT", tpPct: number, slPct: number, maxHold: number) {
  const ep = c[i].close;
  const tp = side==="LONG" ? ep*(1+tpPct/100) : ep*(1-tpPct/100);
  const sl = side==="LONG" ? ep*(1-slPct/100) : ep*(1+slPct/100);
  for (let j=i+1;j<Math.min(i+1+maxHold, c.length); j++) {
    if (side==="LONG") { if(c[j].low<=sl) return "LOSS" as const; if(c[j].high>=tp) return "WIN" as const; }
    else { if(c[j].high>=sl) return "LOSS" as const; if(c[j].low<=tp) return "WIN" as const; }
  }
  return "TIMEOUT" as const;
}

// Multi-TF score (iter4 weights from tools/multi-tf-score-scan-v2.ts)
function computeScore(side: "LONG"|"SHORT", s: Snapshot): number {
  let L=0, S=0;
  if (s.t4==="FLAT") L+=30;
  if (s.t4==="DOWN") { L-=20; S-=20; }
  if (s.t4==="UP") S+=25;
  if (s.t1d==="FLAT" || s.t1d==="UP") L+=10;
  if (s.rsi1d!==null && s.rsi1d>75) L-=25;
  if (s.rsi1d!==null && s.rsi1d>65) S+=15;
  if (s.rsi1d!==null && s.rsi1d<40) S-=15;
  if (s.t1w==="UP" || s.t1w==="FLAT") L+=8;
  if (s.t1w==="UP") S+=10;
  if (s.atr1h!==null && s.atr1h<0.3) L+=25;
  if (s.emaDist1h!==null && s.emaDist1h>=-0.5 && s.emaDist1h<=0.5) L+=20;
  if (s.emaDist1h!==null && s.emaDist1h>2) S+=20;
  const rr = s.rsi1h;
  if (rr!==null && rr<60) L+=10;
  if (rr!==null && rr>70) { L-=30; S+=20; }
  if (rr!==null && rr<50) S-=15;
  return side==="LONG" ? L : S;
}

interface Snapshot {
  i: number; time: number;
  // per-TF RSI / stochK / divergence
  rsi: Record<string, number|null>;
  stochK: Record<string, number|null>;
  div: Record<string, string|null>;
  // 1h local
  atr1h: number|null;
  emaDist1h: number|null;
  rsi1h: number|null;
  // HTF trend (computed from EMA50)
  t4: "UP"|"DOWN"|"FLAT";
  t1d: "UP"|"DOWN"|"FLAT";
  t1w: "UP"|"DOWN"|"FLAT";
  rsi1d: number|null;
}

(async () => {
  console.log("=== verdict-classifier-scan — grid search scheme mới ===\n");
  console.log("Fetching 7 TFs…");
  const allTF: Record<string, Candle[]> = {};
  for (const { key, interval, total } of TFS) {
    allTF[key] = await fetchKlines(interval, total);
    console.log(`  ${key}: ${allTF[key].length}`);
  }

  const c1h = allTF["1h"];
  const closes1h = c1h.map(k=>k.close);
  const ema1h_50 = calcEMASeries(closes1h, 50);
  const rsi1h_series = calcRSISeriesAligned(closes1h, 14);
  // ATR1h series
  const atrArr: (number|null)[] = new Array(c1h.length).fill(null);
  for (let i = 30; i < c1h.length; i++) atrArr[i] = calcATRPct(c1h.slice(Math.max(0,i-50), i+1), 14);

  const ema4h = calcEMASeries(allTF["4h"].map(k=>k.close), 50);
  const ema1d = calcEMASeries(allTF["1d"].map(k=>k.close), 50);
  const rsi1d_series = calcRSISeriesAligned(allTF["1d"].map(k=>k.close), 14);
  const ema1w = calcEMASeries(allTF["1w"].map(k=>k.close), 50);

  console.log("\nPre-computing 9449 snapshots…");
  const snaps: Snapshot[] = [];
  const startIdx = 500;
  const endIdx = c1h.length - 52;
  for (let i = startIdx; i <= endIdx; i++) {
    const t = c1h[i].time;
    const s: Snapshot = {
      i, time: t,
      rsi: {}, stochK: {}, div: {},
      atr1h: atrArr[i],
      emaDist1h: (() => { const e = ema1h_50[i]; return e!==null && e>0 ? ((closes1h[i]-e)/e)*100 : null; })(),
      rsi1h: rsi1h_series[i],
      t4: "FLAT", t1d: "FLAT", t1w: "FLAT",
      rsi1d: null,
    };

    for (const tfKey of TF_ORDER) {
      const arr = allTF[tfKey];
      const idx = idxAtOrBefore(arr, t);
      if (idx < 30) { s.rsi[tfKey]=null; s.stochK[tfKey]=null; s.div[tfKey]=null; continue; }
      const start = Math.max(0, idx-99);
      const window = arr.slice(start, idx+1);
      const closes = window.map(k=>k.close);
      s.rsi[tfKey] = closes.length>=15 ? calcRSI(closes,14) : null;
      const st = closes.length>=35 ? calcStochRSISeries(closes,14,14,3,3) : null;
      s.stochK[tfKey] = st ? st.kSeries[st.kSeries.length-1] : null;
      s.div[tfKey] = closes.length>=30 ? detectDivergence(closes,14,30) : null;
    }

    // HTF trend
    const i4 = idxAtOrBefore(allTF["4h"], t);
    if (i4 >= 0) s.t4 = trendFromEMA(allTF["4h"][i4].close, ema4h[i4]);
    const i1d = idxAtOrBefore(allTF["1d"], t);
    if (i1d >= 0) { s.t1d = trendFromEMA(allTF["1d"][i1d].close, ema1d[i1d]); s.rsi1d = rsi1d_series[i1d]; }
    const iw = idxAtOrBefore(allTF["1w"], t);
    if (iw >= 0) s.t1w = trendFromEMA(allTF["1w"][iw].close, ema1w[iw]);

    snaps.push(s);
    if (snaps.length % 1000 === 0) process.stdout.write(`  ${snaps.length}…\n`);
  }
  console.log(`  done. ${snaps.length} snapshots`);

  // Classifier variants
  type Cls = { name: string; side: "LONG"|"SHORT"; match: (s: Snapshot) => boolean; };

  const helpers = {
    osCount: (s: Snapshot, thr = 30) => TF_ORDER.reduce((n,k)=> n + (s.rsi[k]!==null && s.rsi[k]! < thr ? 1:0), 0),
    obCount: (s: Snapshot, thr = 70) => TF_ORDER.reduce((n,k)=> n + (s.rsi[k]!==null && s.rsi[k]! > thr ? 1:0), 0),
    bullDiv: (s: Snapshot) => TF_ORDER.reduce((n,k)=> n + (s.div[k]==="BULLISH_DIV"?1:0), 0),
    bearDiv: (s: Snapshot) => TF_ORDER.reduce((n,k)=> n + (s.div[k]==="BEARISH_DIV"?1:0), 0),
    adjStochOS: (s: Snapshot) => {
      for (let i=0;i<TF_ORDER.length-1;i++){const a=s.stochK[TF_ORDER[i]],b=s.stochK[TF_ORDER[i+1]];if(a!==null&&b!==null&&a<20&&b<20)return true;}return false;
    },
    adjStochOB: (s: Snapshot) => {
      for (let i=0;i<TF_ORDER.length-1;i++){const a=s.stochK[TF_ORDER[i]],b=s.stochK[TF_ORDER[i+1]];if(a!==null&&b!==null&&a>80&&b>80)return true;}return false;
    },
  };
  const H = helpers;

  const variants: Cls[] = [
    // A. Baseline legacy (sanity check)
    { name: "A.legacy_osCount≥3_LONG", side: "LONG", match: s => H.osCount(s,30) >= 3 },
    { name: "A.legacy_obCount≥3_SHORT", side: "SHORT", match: s => H.obCount(s,70) >= 3 },
    { name: "A.legacy_osCount≥2_LONG", side: "LONG", match: s => H.osCount(s,30) >= 2 || H.bullDiv(s) > 0 },
    { name: "A.legacy_obCount≥2_SHORT", side: "SHORT", match: s => H.obCount(s,70) >= 2 || H.bearDiv(s) > 0 },
    { name: "A.adjStochOS_LONG", side: "LONG", match: s => H.adjStochOS(s) },
    { name: "A.adjStochOB_SHORT", side: "SHORT", match: s => H.adjStochOB(s) },

    // B. Legacy + trend gate 1d
    { name: "B.osCount≥3_1dNotDOWN", side: "LONG", match: s => H.osCount(s,30) >= 3 && s.t1d !== "DOWN" },
    { name: "B.osCount≥2_1dNotDOWN", side: "LONG", match: s => (H.osCount(s,30) >= 2 || H.bullDiv(s)>0) && s.t1d !== "DOWN" },
    { name: "B.obCount≥3_1dNotUP", side: "SHORT", match: s => H.obCount(s,70) >= 3 && s.t1d !== "UP" },
    { name: "B.adjStochOS_1dNotDOWN", side: "LONG", match: s => H.adjStochOS(s) && s.t1d !== "DOWN" },
    { name: "B.adjStochOB_1dNotUP", side: "SHORT", match: s => H.adjStochOB(s) && s.t1d !== "UP" },

    // C. Legacy + trend 1d + 1w
    { name: "C.osCount≥2_1d&1wUP", side: "LONG", match: s => (H.osCount(s,30) >= 2 || H.bullDiv(s)>0) && s.t1d !== "DOWN" && s.t1w !== "DOWN" },
    { name: "C.osCount≥3_1dFLAT", side: "LONG", match: s => H.osCount(s,30) >= 3 && s.t1d === "FLAT" },

    // D. adj-stoch + additional gates
    { name: "D.adjOS_1wUP", side: "LONG", match: s => H.adjStochOS(s) && s.t1w === "UP" },
    { name: "D.adjOS_1dUP", side: "LONG", match: s => H.adjStochOS(s) && s.t1d === "UP" },
    { name: "D.adjOS_bullDivAny", side: "LONG", match: s => H.adjStochOS(s) && H.bullDiv(s) > 0 },

    // E. GOLDEN_LONG (iter2 R2)
    { name: "E.GOLDEN_LONG", side: "LONG",
      match: s => s.atr1h!==null && s.atr1h<0.3
        && s.emaDist1h!==null && s.emaDist1h>=-0.5 && s.emaDist1h<=0.5
        && s.t1d === "FLAT" },
    // F. Strict
    { name: "F.GOLDEN_LONG_strict", side: "LONG",
      match: s => s.atr1h!==null && s.atr1h<0.3
        && s.emaDist1h!==null && s.emaDist1h>=-0.3 && s.emaDist1h<=0.3
        && s.t1d === "FLAT" },
    // G-I. Multi-TF score
    { name: "G.SCORE_LONG≥70", side: "LONG", match: s => computeScore("LONG", s) >= 70 },
    { name: "H.SCORE_LONG≥80", side: "LONG", match: s => computeScore("LONG", s) >= 80 },
    { name: "I.SCORE_LONG≥60", side: "LONG", match: s => computeScore("LONG", s) >= 60 },
    { name: "I2.SCORE_LONG≥50", side: "LONG", match: s => computeScore("LONG", s) >= 50 },

    // J. Combo GOLDEN + SCORE
    { name: "J.GOLDEN+SCORE≥60", side: "LONG",
      match: s => s.atr1h!==null && s.atr1h<0.3 && s.emaDist1h!==null && s.emaDist1h>=-0.5 && s.emaDist1h<=0.5 && s.t1d === "FLAT" && computeScore("LONG",s) >= 60 },

    // K. SHORT score variants
    { name: "K.SCORE_SHORT≥50", side: "SHORT", match: s => computeScore("SHORT", s) >= 50 },
    { name: "K.SCORE_SHORT≥60", side: "SHORT", match: s => computeScore("SHORT", s) >= 60 },

    // L. Confluence LONG (osCount + bullDiv + trend UP)
    { name: "L.CONFLUENCE_LONG", side: "LONG",
      match: s => (H.osCount(s,30) >= 2) && H.bullDiv(s) > 0 && s.t1d !== "DOWN" },
    // M. Confluence SHORT
    { name: "M.CONFLUENCE_SHORT", side: "SHORT",
      match: s => (H.obCount(s,70) >= 2) && H.bearDiv(s) > 0 && s.t1d !== "UP" },
  ];

  // Run each variant
  const TP = 3, SL = 2, MAX_HOLD = 50, COOLDOWN = 8, LEV = 100, FEE = 0.04 * 2 * LEV;
  const BE = ((SL * LEV + FEE) / ((SL + TP) * LEV)) * 100;

  const results = variants.map(cls => {
    let wins=0, losses=0, timeouts=0, lastI = -999;
    for (const s of snaps) {
      if (!cls.match(s)) continue;
      if (s.i - lastI < COOLDOWN) continue;
      lastI = s.i;
      const o = simulate(c1h, s.i, cls.side, TP, SL, MAX_HOLD);
      if (o === "WIN") wins++; else if (o === "LOSS") losses++; else timeouts++;
    }
    const N = wins+losses+timeouts;
    const wr = N > 0 ? wins/N*100 : 0;
    const gross = wins*TP*LEV - losses*SL*LEV;
    const net = gross - N*FEE;
    return { name: cls.name, side: cls.side, N, wins, losses, timeouts,
      wr: +wr.toFixed(1), be: +BE.toFixed(1), edge: +(wr-BE).toFixed(1),
      net: +net.toFixed(0), netPerTrade: N>0 ? +(net/N).toFixed(1) : 0,
    };
  }).sort((a,b) => b.netPerTrade - a.netPerTrade);

  console.log("\n=== RANKING (sorted by NET/trade) ===");
  console.log("Name                                | Side  |   N   | WR%    | Edge   | NET/tr  | NET");
  console.log("------------------------------------|-------|-------|--------|--------|---------|------");
  for (const r of results) {
    const flag = r.edge >= 5 ? "🟢" : r.edge >= 0 ? "🟡" : "🔴";
    console.log(` ${flag} ${r.name.padEnd(35)}| ${r.side.padEnd(5)} | ${String(r.N).padStart(5)} | ${String(r.wr).padStart(5)}% | ${r.edge>=0?"+":""}${String(r.edge).padStart(5)}% | ${r.netPerTrade>=0?"+":""}${String(r.netPerTrade).padStart(6)}% | ${r.net>=0?"+":""}${r.net}%`);
  }

  const prof = results.filter(r => r.net > 0 && r.N >= 15);
  console.log(`\n${prof.length}/${results.length} variant có NET>0 && N≥15`);
  if (prof.length) {
    console.log("\n🏆 Top profitable variants:");
    prof.slice(0,10).forEach((r,i) => console.log(`  ${i+1}. ${r.name} — WR ${r.wr}% N=${r.N} edge ${r.edge>=0?"+":""}${r.edge}% NET ${r.net>=0?"+":""}${r.net}%`));
  }

  const outPath = join(__dirname, "..", "assets", "verdict_scheme_scan.json");
  writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), simParams: { TP, SL, MAX_HOLD, COOLDOWN, LEV, breakEven: BE }, totalSnapshots: snaps.length, results }, null, 2));
  console.log(`\n✅ Wrote ${outPath}`);
})();
