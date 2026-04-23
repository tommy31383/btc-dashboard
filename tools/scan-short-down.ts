/**
 * scan-short-down.ts
 *
 * Scan SHORT rules với gate htf:DOWN (hypothesis: SHORT ăn khi xuôi trend
 * giảm 4h, ngược logic scan-features cũ dùng htf:UP).
 *
 * 20K candles 1h BTCUSDT / TP5/SL2/hold100h/fee 0.05%×2
 * Buckets: singles, pairs, triples với đủ features mới + cũ.
 *
 * Output: assets/scan_short_down.json
 */

import { writeFileSync } from "fs";
import { join } from "path";
import { calcRSISeriesAligned, calcMACDSeries, calcEMASeries, calcBollingerSeries } from "../utils/indicators";

const BINANCE = "https://api.binance.com/api/v3";
const args = process.argv.slice(2);
const getArg = (k: string, d: string) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.split("=")[1] : d; };
const CANDLES = parseInt(getArg("candles", "20000"), 10);
const TP = 5, SL = 2, HOLD = 100, FEE = 0.05;

interface Candle { time:number; open:number; high:number; low:number; close:number; volume:number; }

async function fetchKlines(interval: string, total: number): Promise<Candle[]> {
  const all: Candle[] = []; let endTime: number | undefined;
  while (all.length < total) {
    const limit = Math.min(1000, total - all.length);
    const params = new URLSearchParams({ symbol: "BTCUSDT", interval, limit: String(limit) });
    if (endTime) params.set("endTime", String(endTime));
    const res = await fetch(`${BINANCE}/klines?${params}`);
    const data: any[] = await res.json();
    if (!data.length) break;
    const batch = data.map((k) => ({ time:k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5] }));
    all.unshift(...batch);
    endTime = batch[0].time - 1;
    await new Promise((r) => setTimeout(r, 80));
  }
  const m = new Map<number, Candle>(); for (const c of all) m.set(c.time, c);
  return [...m.values()].sort((a,b) => a.time - b.time);
}

function calcATRPctSeries(c: Candle[], p = 14): (number|null)[] {
  const n = c.length; const out: (number|null)[] = new Array(n).fill(null);
  if (n < p+1) return out;
  const trs: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i === 0) trs.push(c[i].high - c[i].low);
    else trs.push(Math.max(c[i].high-c[i].low, Math.abs(c[i].high-c[i-1].close), Math.abs(c[i].low-c[i-1].close)));
  }
  let atr = trs.slice(0,p).reduce((a,b)=>a+b,0)/p;
  out[p-1] = (atr/c[p-1].close)*100;
  for (let i = p; i < n; i++) { atr = (atr*(p-1)+trs[i])/p; out[i] = (atr/c[i].close)*100; }
  return out;
}

function findIdx(arr: Candle[], t: number): number {
  let lo=0, hi=arr.length-1, ans=-1;
  while (lo<=hi) { const m=(lo+hi)>>1; if (arr[m].time<=t) {ans=m; lo=m+1;} else hi=m-1; }
  return ans;
}

function simulateShort(candles: Candle[], i: number) {
  const entry = candles[i].close;
  const tpP = entry*(1-TP/100);
  const slP = entry*(1+SL/100);
  const end = Math.min(i + HOLD, candles.length - 1);
  for (let j = i+1; j <= end; j++) {
    if (candles[j].high >= slP) return { pnl: -SL, out: "SL" as const };
    if (candles[j].low <= tpP) return { pnl: TP, out: "TP" as const };
  }
  const exitP = candles[end].close;
  return { pnl: ((entry-exitP)/entry)*100, out: "TIMEOUT" as const };
}

async function main() {
  console.log("═".repeat(70));
  console.log("🔭 SCAN SHORT — htf gate tất cả (UP / DOWN / FLAT)");
  console.log("═".repeat(70));
  console.log("📡 Fetching …");
  const [k1h, k4h] = await Promise.all([
    fetchKlines("1h", CANDLES),
    fetchKlines("4h", Math.ceil(CANDLES/4)+200),
  ]);
  console.log(`  ✓ 1h:${k1h.length} · 4h:${k4h.length}\n`);

  const closes1h = k1h.map(c=>c.close);
  const closes4h = k4h.map(c=>c.close);
  const rsi1h = calcRSISeriesAligned(closes1h, 14);
  const macd1h = calcMACDSeries(closes1h, 12, 26, 9);
  const ema20 = calcEMASeries(closes1h, 20);
  const ema50_1h = calcEMASeries(closes1h, 50);
  const ema50_4h = calcEMASeries(closes4h, 50);
  const bb1h = calcBollingerSeries(closes1h, 20, 2);
  const atr1h = calcATRPctSeries(k1h, 14);

  type Hit = { pnl:number; out:string };
  const buckets: Map<string, Hit[]> = new Map();
  const add = (k: string, h: Hit) => { const a = buckets.get(k)||[]; a.push(h); buckets.set(k,a); };

  for (let i = 100; i < k1h.length - HOLD - 1; i++) {
    const rsi = rsi1h[i]; const mh = macd1h.histogram[i];
    const e20 = ema20[i], e50 = ema50_1h[i], a1 = atr1h[i];
    const bbU = bb1h.upper[i], bbL = bb1h.lower[i], bbM = bb1h.middle[i];
    if (rsi===null||mh===null||e20===null||e50===null||a1===null||bbU===null||bbL===null||bbM===null) continue;

    const close = k1h[i].close; const open = k1h[i].open;
    const emaDist1h = ((close-e50)/e50)*100;
    const bbWidth = ((bbU-bbL)/bbM)*100;
    const emaCrossBear = e20 < e50;
    const bodyPct = Math.abs(close-open)/open*100;
    const mom24 = i>=24 ? ((close-closes1h[i-24])/closes1h[i-24])*100 : null;
    if (mom24===null) continue;

    const idx4h = findIdx(k4h, k1h[i].time); if (idx4h<0) continue;
    const e4 = ema50_4h[idx4h]; if (e4===null) continue;
    const emaDist4h = ((k4h[idx4h].close-e4)/e4)*100;
    const htf = emaDist4h>0.5?"UP":emaDist4h<-0.5?"DOWN":"FLAT";

    const macdBear = mh<0 && mh>-50;
    const emaNear = Math.abs(emaDist1h)<0.5;
    const atrLow = a1<0.3;
    const rsiHigh = rsi>65;

    const sim = simulateShort(k1h, i);
    const h: Hit = { pnl: sim.pnl, out: sim.out };

    for (const gate of [htf]) {
      const tag = `htf:${gate}`;
      // singles
      if (macdBear) add(`macdBear + ${tag}`, h);
      if (emaNear) add(`emaNear + ${tag}`, h);
      if (atrLow) add(`atrLow + ${tag}`, h);
      if (rsiHigh) add(`rsiHigh + ${tag}`, h);
      if (emaCrossBear) add(`emaCrossBear + ${tag}`, h);
      if (bbWidth<1.5) add(`bbSqueeze + ${tag}`, h);
      if (bbWidth>4) add(`bbExpand + ${tag}`, h);
      if (bodyPct<0.1) add(`bodySmall + ${tag}`, h);
      if (bodyPct>1) add(`bodyBig + ${tag}`, h);
      if (mom24>2) add(`mom24>+2% + ${tag}`, h);
      if (mom24<-2) add(`mom24<-2% + ${tag}`, h);
      // pairs
      if (macdBear && emaNear) add(`macdBear + emaNear + ${tag}`, h);
      if (macdBear && atrLow) add(`macdBear + atrLow + ${tag}`, h);
      if (macdBear && bbWidth<1.5) add(`macdBear + bbSqueeze + ${tag}`, h);
      if (emaCrossBear && atrLow) add(`emaCrossBear + atrLow + ${tag}`, h);
      if (emaCrossBear && macdBear) add(`emaCrossBear + macdBear + ${tag}`, h);
      if (bbWidth>4 && macdBear) add(`bbExpand + macdBear + ${tag}`, h);
      if (rsiHigh && macdBear) add(`rsiHigh + macdBear + ${tag}`, h);
      if (mom24>2 && macdBear) add(`mom24>+2% + macdBear + ${tag}`, h);
      // triples
      if (macdBear && emaNear && atrLow) add(`macdBear + emaNear + atrLow + ${tag}`, h);
      if (emaCrossBear && atrLow && macdBear) add(`emaCrossBear + atrLow + macdBear + ${tag}`, h);
      if (bbWidth<1.5 && macdBear && emaNear) add(`bbSqueeze + macdBear + emaNear + ${tag}`, h);
    }
  }

  interface Rank { name: string; n: number; wr: number; sumPnl: number; pf: number; exp: number; }
  const ranks: Rank[] = [];
  for (const [name, hits] of buckets) {
    if (hits.length < 30) continue;
    let wins=0, sw=0, sl=0, sp=0;
    for (const h of hits) {
      const p = h.pnl - FEE*2;
      sp += p; if (p>0) { wins++; sw+=p; } else sl+=p;
    }
    const wr = (wins/hits.length)*100;
    ranks.push({
      name, n: hits.length, wr: +wr.toFixed(2),
      sumPnl: +sp.toFixed(2),
      pf: sl<0 ? +(sw/Math.abs(sl)).toFixed(2) : (sw>0?99:0),
      exp: +(sp/hits.length).toFixed(3),
    });
  }
  ranks.sort((a,b) => b.wr - a.wr);

  console.log("🏆 TOP 30 SHORT rules (N≥30, sort by WR):\n");
  console.log("┌──────────────────────────────────────────────────────────────┬──────┬────────┬────────┬───────┬────────┐");
  console.log("│ Rule                                                         │  N   │  WR %  │ Sum %  │  PF   │ Exp %  │");
  console.log("├──────────────────────────────────────────────────────────────┼──────┼────────┼────────┼───────┼────────┤");
  for (const r of ranks.slice(0, 30)) {
    console.log(`│ ${r.name.padEnd(60)} │ ${String(r.n).padStart(4)} │ ${r.wr.toFixed(2).padStart(6)} │ ${r.sumPnl.toFixed(2).padStart(6)} │ ${r.pf.toFixed(2).padStart(5)} │ ${r.exp.toFixed(3).padStart(6)} │`);
  }
  console.log("└──────────────────────────────────────────────────────────────┴──────┴────────┴────────┴───────┴────────┘");

  writeFileSync(join("assets", "scan_short_down.json"), JSON.stringify({
    meta: { candles: CANDLES, tp: TP, sl: SL, hold: HOLD, fee: FEE, generatedAt: new Date().toISOString() },
    ranks,
  }, null, 2));
  console.log("\n💾 Saved → assets/scan_short_down.json");

  // Highlight DOWN-gate rules
  console.log("\n🎯 TOP 15 SHORT rules với htf:DOWN:");
  const downRanks = ranks.filter(r => r.name.includes("htf:DOWN"));
  for (const r of downRanks.slice(0, 15)) {
    console.log(`  ${r.wr.toFixed(2).padStart(6)}%  PF ${r.pf.toFixed(2).padStart(5)}  N=${String(r.n).padStart(4)}  ${r.name}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
