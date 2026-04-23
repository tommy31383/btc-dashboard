/**
 * backtest-verdict.ts — v2 scheme (post verdict-classifier-scan)
 *
 * Mirrors classifier logic trong hooks/useAlerts.ts:
 *   💎 GOLDEN LONG SETUP           (atr1h<0.3 + emaDist±0.5 + 1d FLAT)
 *   🚀 STRONG LONG (SCORE)         (score LONG ≥ 80)
 *   📊 POTENTIAL LONG (SCORE)      (score LONG ≥ 60)
 *   🟢 WEAK LONG (SCORE)           (score LONG ≥ 50)
 *   ⚡ STOCH REVERSAL LONG         (adjStochOS + 1d ≠ DOWN)
 *   🔴 SHORT CAUTION   (obCount≥3 OR bearDiv>0, 1d ≠ UP)
 *   ⏸ TRUNG TÍNH                   fallback
 *
 * Output:
 *   - assets/verdict_accuracy.json  (UI đọc để show % Tin cậy)
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
function trendFromEMA(p: number, e: number | null): "UP"|"DOWN"|"FLAT" {
  if (e == null) return "FLAT";
  const d = (p-e)/e*100; return d>0.3?"UP":d<-0.3?"DOWN":"FLAT";
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

(async () => {
  console.log("=== backtest-verdict v2 (new scheme) ===\n");
  const allTF: Record<string, Candle[]> = {};
  for (const { key, interval, total } of TFS) {
    allTF[key] = await fetchKlines(interval, total);
    console.log(`  ${key}: ${allTF[key].length}`);
  }
  const c1h = allTF["1h"];
  const closes1h = c1h.map(k=>k.close);
  const ema1h_50 = calcEMASeries(closes1h, 50);
  const rsi1h_series = calcRSISeriesAligned(closes1h, 14);
  const atrArr: (number|null)[] = new Array(c1h.length).fill(null);
  for (let i=30;i<c1h.length;i++) atrArr[i] = calcATRPct(c1h.slice(Math.max(0,i-50), i+1), 14);
  const ema4h = calcEMASeries(allTF["4h"].map(k=>k.close), 50);
  const ema1d = calcEMASeries(allTF["1d"].map(k=>k.close), 50);
  const rsi1d_series = calcRSISeriesAligned(allTF["1d"].map(k=>k.close), 14);
  const ema1w = calcEMASeries(allTF["1w"].map(k=>k.close), 50);

  const TP = 3, SL = 2, MAX_HOLD = 50, COOLDOWN = 8, LEV = 100, FEE = 0.04*2*LEV;
  const BE = ((SL*LEV+FEE)/((SL+TP)*LEV))*100;

  const buckets: Record<string, { side: "LONG"|"SHORT"|"NEUTRAL"; wins: number; losses: number; timeouts: number; N: number; ticks: number }> = {};
  function bump(text: string, side: "LONG"|"SHORT"|"NEUTRAL", outcome: "WIN"|"LOSS"|"TIMEOUT"|"SKIP") {
    if (!buckets[text]) buckets[text] = { side, wins: 0, losses: 0, timeouts: 0, N: 0, ticks: 0 };
    buckets[text].ticks++;
    if (outcome === "SKIP") return;
    buckets[text].N++;
    if (outcome === "WIN") buckets[text].wins++;
    else if (outcome === "LOSS") buckets[text].losses++;
    else buckets[text].timeouts++;
  }

  const lastEntry: Record<string, number> = {};
  const startIdx = 500;
  const endIdx = c1h.length - MAX_HOLD - 2;

  console.log(`\nReplay [${startIdx}..${endIdx}]…`);
  for (let i = startIdx; i <= endIdx; i++) {
    const t = c1h[i].time;

    // per-TF RSI/stoch/div (for osCount, obCount, adjStochOS, bearDiv)
    let osCount = 0, obCount = 0, bullDiv = 0, bearDiv = 0;
    const stochK: Record<string, number|null> = {};
    for (const k of TF_ORDER) {
      const arr = allTF[k];
      const idx = idxAtOrBefore(arr, t);
      if (idx < 30) { stochK[k] = null; continue; }
      const window = arr.slice(Math.max(0, idx-99), idx+1).map(c=>c.close);
      const rsi = window.length>=15 ? calcRSI(window, 14) : null;
      if (rsi !== null) {
        if (rsi > 70) obCount++;
        if (rsi < 30) osCount++;
      }
      const st = window.length>=35 ? calcStochRSISeries(window,14,14,3,3) : null;
      stochK[k] = st ? st.kSeries[st.kSeries.length-1] : null;
      const div = window.length>=30 ? detectDivergence(window,14,30) : null;
      if (div === "BULLISH_DIV") bullDiv++;
      if (div === "BEARISH_DIV") bearDiv++;
    }
    let adjStochOS = false, adjStochOB = false;
    for (let k=0;k<TF_ORDER.length-1;k++){const a=stochK[TF_ORDER[k]],b=stochK[TF_ORDER[k+1]];if(a!==null&&b!==null){if(a<20&&b<20) adjStochOS=true;if(a>80&&b>80) adjStochOB=true;}}

    // HTF trend
    const i4 = idxAtOrBefore(allTF["4h"], t);
    const t4 = i4>=0 ? trendFromEMA(allTF["4h"][i4].close, ema4h[i4]) : "FLAT";
    const i1d = idxAtOrBefore(allTF["1d"], t);
    const t1d = i1d>=0 ? trendFromEMA(allTF["1d"][i1d].close, ema1d[i1d]) : "FLAT";
    const rsi1d = i1d>=0 ? rsi1d_series[i1d] : null;
    const iw = idxAtOrBefore(allTF["1w"], t);
    const t1w = iw>=0 ? trendFromEMA(allTF["1w"][iw].close, ema1w[iw]) : "FLAT";

    const atr1h = atrArr[i];
    const e = ema1h_50[i];
    const emaDist1h = e!==null && e>0 ? ((closes1h[i]-e)/e)*100 : null;
    const rsi1h = rsi1h_series[i];

    // Multi-TF score (LONG only — SHORT not reliable)
    let scoreLONG = 0;
    if (t4==="FLAT") scoreLONG += 30;
    if (t4==="DOWN") scoreLONG -= 20;
    if (t1d==="FLAT"||t1d==="UP") scoreLONG += 10;
    if (rsi1d!==null && rsi1d>75) scoreLONG -= 25;
    if (t1w==="UP"||t1w==="FLAT") scoreLONG += 8;
    if (atr1h!==null && atr1h<0.3) scoreLONG += 25;
    if (emaDist1h!==null && emaDist1h>=-0.5 && emaDist1h<=0.5) scoreLONG += 20;
    if (rsi1h!==null && rsi1h<60) scoreLONG += 10;
    if (rsi1h!==null && rsi1h>70) scoreLONG -= 30;

    const goldenLONG = atr1h!==null && atr1h<0.3
      && emaDist1h!==null && emaDist1h>=-0.5 && emaDist1h<=0.5
      && t1d === "FLAT";

    let text: string, side: "LONG"|"SHORT"|"NEUTRAL";
    if (goldenLONG) { text = "GOLDEN LONG SETUP"; side = "LONG"; }
    else if (scoreLONG >= 80) { text = "STRONG LONG (SCORE)"; side = "LONG"; }
    else if (scoreLONG >= 60) { text = "POTENTIAL LONG (SCORE)"; side = "LONG"; }
    else if (scoreLONG >= 50) { text = "WEAK LONG (SCORE)"; side = "LONG"; }
    else if (adjStochOS && t1d !== "DOWN") { text = "STOCH REVERSAL LONG"; side = "LONG"; }
    else if ((obCount >= 3 || bearDiv > 0) && t1d !== "UP") { text = "SHORT CAUTION"; side = "SHORT"; }
    else { text = "TRUNG TÍNH"; side = "NEUTRAL"; }

    if (lastEntry[text] !== undefined && i - lastEntry[text] < COOLDOWN) { bump(text, side, "SKIP"); continue; }
    if (side === "NEUTRAL") { bump(text, side, "SKIP"); continue; }

    lastEntry[text] = i;
    const out = simulate(c1h, i, side, TP, SL, MAX_HOLD);
    bump(text, side, out);
  }

  const results = Object.entries(buckets).map(([text, b]) => {
    const wr = b.N>0 ? (b.wins/b.N)*100 : 0;
    const gross = b.wins*TP*LEV - b.losses*SL*LEV;
    const net = gross - b.N*FEE;
    return { text, side: b.side, N: b.N, ticks: b.ticks, wins: b.wins, losses: b.losses, timeouts: b.timeouts,
      wr: +wr.toFixed(1), breakEven: +BE.toFixed(1), edge: +(wr-BE).toFixed(1),
      netPct: +net.toFixed(0), netPerTrade: b.N>0 ? +(net/b.N).toFixed(1) : 0 };
  }).sort((a,b) => b.netPerTrade - a.netPerTrade);

  console.log("\nVerdict                          | Side    | N    | WR%   | Edge   | NET/tr | NET");
  console.log("---------------------------------|---------|------|-------|--------|--------|-----");
  for (const r of results) {
    const flag = r.edge>=5?"🟢":r.edge>=0?"🟡":"🔴";
    console.log(` ${flag} ${r.text.padEnd(30)}| ${r.side.padEnd(7)} | ${String(r.N).padStart(4)} | ${String(r.wr).padStart(5)}% | ${r.edge>=0?"+":""}${String(r.edge).padStart(5)}% | ${r.netPerTrade>=0?"+":""}${String(r.netPerTrade).padStart(5)}% | ${r.netPct>=0?"+":""}${r.netPct}%`);
  }

  const outPath = join(__dirname, "..", "assets", "verdict_accuracy.json");
  const payload = {
    generatedAt: new Date().toISOString(),
    scheme: "v2-classifier-scan-post-iter5",
    dataSource: "Binance BTCUSDT 10000×1h (replay)",
    simParams: { TP, SL, MAX_HOLD, LEV, FEE, COOLDOWN, breakEven: +BE.toFixed(1) },
    results,
    byText: Object.fromEntries(results.map(r => [r.text, r])),
  };
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`\n✅ Wrote ${outPath}`);
})();
