/**
 * multi-tf-score-scan-short-v3.ts — Iter5 (SHORT-focused euphoria-peak scheme)
 *
 * Thay vì alignment, SHORT weights tập trung vào EUPHORIA-PEAK signals:
 *   - 1h RSI > 75: +35  (overbought cực)
 *   - 1d RSI > 70: +25
 *   - 4h RSI > 65: +15
 *   - EMA dist > +3%: +25
 *   - EMA dist > +2%: +15
 *   - 1h MACD hist falling while price rising (bearish divergence proxy): +20
 *   - 1w trend UP + 1d trend UP (euphoria context): +15
 *   Penalty:
 *   - 1h RSI < 60: -30 (không overbought, không SHORT)
 *   - EMA dist < 0: -25 (đã dưới EMA, không SHORT từ đỉnh)
 */
import { writeFileSync } from "fs";
import { join } from "path";
import { calcRSISeriesAligned, calcMACDSeries, calcEMASeries } from "../utils/indicators";

const BINANCE = "https://api.binance.com/api/v3";
interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number; }
const TF_MIN: Record<string, number> = { "1h":60, "4h":240, "1d":1440, "1w":10080 };

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
function htfIdxAt(h: Candle[], t: number): number {
  let lo=0, hi=h.length-1, a=-1;
  while (lo<=hi){const m=(lo+hi)>>1;if(h[m].time<=t){a=m;lo=m+1;}else hi=m-1;} return a;
}
function trendFromEMA(p: number, e: number | null): "UP"|"DOWN"|"FLAT" {
  if (e == null) return "FLAT";
  const d = (p-e)/e*100; return d>0.3?"UP":d<-0.3?"DOWN":"FLAT";
}
function simulate(c: Candle[], i: number, side: "LONG"|"SHORT", tp: number, sl: number, mh: number) {
  const ep = c[i].close;
  const T = side==="LONG"?ep*(1+tp/100):ep*(1-tp/100);
  const S = side==="LONG"?ep*(1-sl/100):ep*(1+sl/100);
  for (let j=i+1;j<Math.min(i+1+mh,c.length);j++) {
    if (side==="LONG") { if(c[j].low<=S) return {o:"LOSS",h:j-i}; if(c[j].high>=T) return {o:"WIN",h:j-i}; }
    else { if(c[j].high>=S) return {o:"LOSS",h:j-i}; if(c[j].low<=T) return {o:"WIN",h:j-i}; }
  }
  return {o:"TIMEOUT",h:mh};
}

(async () => {
  console.log("=== SHORT scan v3 euphoria-peak (iter5) ===");
  const [e1h, e4h, e1d, e1w] = await Promise.all([
    fetchKlines("1h", 10000), fetchKlines("4h", 3000), fetchKlines("1d", 800), fetchKlines("1w", 200),
  ]);
  console.log(`  1h=${e1h.length} 4h=${e4h.length} 1d=${e1d.length} 1w=${e1w.length}`);

  const c1h = e1h.map(k=>k.close);
  const rsi1h = calcRSISeriesAligned(c1h, 14);
  const macd1h = calcMACDSeries(c1h);
  const ema1h = calcEMASeries(c1h, 50);
  const emaDist1h: (number|null)[] = c1h.map((p,i)=>{const e=ema1h[i];return e!==null&&e>0?((p-e)/e)*100:null;});

  const rsi4h = calcRSISeriesAligned(e4h.map(k=>k.close), 14);
  const ema4h = calcEMASeries(e4h.map(k=>k.close), 50);
  const rsi1d = calcRSISeriesAligned(e1d.map(k=>k.close), 14);
  const ema1d = calcEMASeries(e1d.map(k=>k.close), 50);
  const ema1w = calcEMASeries(e1w.map(k=>k.close), 50);

  const tfMs = TF_MIN["1h"]*60*1000;

  function score(i: number): number {
    let S = 0;
    const p = c1h[i];
    const t = e1h[i].time + tfMs - 1;

    const rr = rsi1h[i];
    if (rr!==null) {
      if (rr>75) S += 35;
      else if (rr>70) S += 25;
      else if (rr>65) S += 10;
      else if (rr<60) S -= 30;
    }

    const ed = emaDist1h[i];
    if (ed!==null) {
      if (ed>3) S += 25;
      else if (ed>2) S += 15;
      else if (ed<0) S -= 25;
    }

    const i4 = htfIdxAt(e4h,t);
    if (i4>=0) {
      const r4v = rsi4h[i4];
      if (r4v!==null && r4v>65) S += 15;
    }
    const i1 = htfIdxAt(e1d,t);
    if (i1>=0) {
      const r1v = rsi1d[i1];
      if (r1v!==null && r1v>70) S += 25;
      const t1 = trendFromEMA(e1d[i1].close, ema1d[i1]);
      if (t1==="UP") S += 8;
    }
    const iw = htfIdxAt(e1w,t);
    if (iw>=0) {
      const tw = trendFromEMA(e1w[iw].close, ema1w[iw]);
      if (tw==="UP") S += 7;
    }

    // Bearish momentum proxy: MACD hist falling + price up
    const mh = macd1h.histogram[i];
    const pmh = i>0 ? macd1h.histogram[i-1] : null;
    if (mh!==null && pmh!==null && mh<pmh && p>c1h[i-1]) S += 20;

    return S;
  }

  const scored: {i:number; S:number}[] = [];
  for (let i=60;i<e1h.length-101;i++) scored.push({i, S: score(i)});
  const sSorted = scored.map(x=>x.S).sort((a,b)=>a-b);
  const pct = (q: number) => sSorted[Math.floor(sSorted.length*q)];
  console.log(`SHORT p50/p75/p90/p95/p99: ${pct(0.5)}/${pct(0.75)}/${pct(0.9)}/${pct(0.95)}/${pct(0.99)}`);

  const thrs = [30,40,50,60,70,80,90,100];
  const tps = [3,4,5];
  const sls = [1,1.5,2];
  const maxHold = 100, lev = 100, fee = 0.04*2*lev;

  const results: any[] = [];
  for (const thr of thrs) for (const tp of tps) for (const sl of sls) {
    let w=0, l=0, t=0, sh=0; let last = -999;
    for (const s of scored) {
      if (s.S<thr) continue;
      if (s.i-last<8) continue;
      last = s.i;
      const o = simulate(e1h, s.i, "SHORT", tp, sl, maxHold);
      if (o.o==="WIN") w++; else if (o.o==="LOSS") l++; else t++;
      sh += o.h;
    }
    const N = w+l+t;
    if (N<15) continue;
    const gross = w*tp*lev - l*sl*lev;
    const net = gross - N*fee;
    const wr = w/N*100;
    const be = (sl*lev + fee) / ((sl+tp)*lev) * 100;
    results.push({ thr, tp, sl, N, wins:w, losses:l, timeouts:t, wr:+wr.toFixed(1), net:+net.toFixed(0), netPerTrade:+(net/N).toFixed(1), breakEven:+be.toFixed(1), edge:+(wr-be).toFixed(1) });
  }

  const prof = results.filter(r=>r.net>0 && r.edge>5).sort((a,b)=>b.netPerTrade-a.netPerTrade || b.N-a.N);
  console.log(`\n${results.length} combos, ${prof.length} profitable (edge>5).`);
  console.log("thr | tp/sl    | N    | wr%    | breakEven | edge   | net/trade | NET");
  for (const r of prof.slice(0,10)) {
    console.log(` ${String(r.thr).padStart(3)}| ${r.tp}/${r.sl}    | ${String(r.N).padStart(4)} | ${String(r.wr).padStart(5)}% | ${String(r.breakEven).padStart(7)}%  | ${r.edge>=0?"+":""}${r.edge}% | ${r.netPerTrade>=0?"+":""}${r.netPerTrade}%     | ${r.net>=0?"+":""}${r.net}%`);
  }

  const best = prof[0];
  if (best) console.log(`\n🏆 SHORT best: thr=${best.thr} ${best.tp}/${best.sl} WR=${best.wr}% N=${best.N} net/trade +${best.netPerTrade}% total +${best.net}%`);
  else console.log(`\n❌ No profitable SHORT combo.`);

  const outPath = join(__dirname, "..", "assets", "short_scan_v3.json");
  writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), scheme: "euphoria-peak", totalScored: scored.length, results, bestSHORT: best ?? null, top20: prof.slice(0,20) }, null, 2));
  console.log(`✅ Wrote ${outPath}`);
})();
