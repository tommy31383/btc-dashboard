/**
 * backtest-verdict-by-tf.ts — Phương án A+B kết hợp
 *
 * Với mỗi TF entry ∈ {5m, 15m, 1h, 4h, 1d, 1w, 1M}:
 *   - Fetch raw klines + 2 HTF lớn hơn làm context
 *   - Tính adaptive atrTight = P30 historical ATR của TF đó (per-TF thay vì fixed 0.3%)
 *   - Giữ formula classifier (goldenLONG + scoreLONG + adjStoch...) nhưng context từ
 *     HTF tương đối (near + far) của TF đang test
 *   - TP/SL scale theo TF (5m tiny, 1M huge)
 *   - Simulate trên candles của TF đó (entry là close candle, exit qua TP/SL)
 *
 * Output: assets/verdict_accuracy_by_tf.json  {[tf]: {[verdictText]: stats}}
 */
import { writeFileSync } from "fs";
import { join } from "path";
import { calcRSI, calcStochRSISeries, detectDivergence, calcRSISeriesAligned, calcEMASeries, calcATRPct } from "../utils/indicators";

const BINANCE = "https://api.binance.com/api/v3";
interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number; }

const TFS = [
  { key: "5m",  total: 10000, tp: 0.5,  sl: 0.3, maxHold: 40, near: "15m", far: "1h" },
  { key: "15m", total: 10000, tp: 1.0,  sl: 0.5, maxHold: 40, near: "1h",  far: "4h" },
  { key: "1h",  total: 10000, tp: 3.0,  sl: 2.0, maxHold: 50, near: "4h",  far: "1d" },
  { key: "4h",  total: 3000,  tp: 4.0,  sl: 2.5, maxHold: 50, near: "1d",  far: "1w" },
  { key: "1d",  total: 800,   tp: 6.0,  sl: 3.0, maxHold: 30, near: "1w",  far: "1M" },
  { key: "1w",  total: 200,   tp: 12.0, sl: 6.0, maxHold: 20, near: "1M",  far: "1M" },
  { key: "1M",  total: 100,   tp: 20.0, sl: 10.0, maxHold: 12, near: "1M", far: "1M" },
] as const;

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
  while(lo<=hi){const m=(lo+hi)>>1;if(arr[m].time<=t){ans=m;lo=m+1;}else hi=m-1;} return ans;
}
function trendFromEMA(p: number, e: number | null): "UP"|"DOWN"|"FLAT" {
  if (e==null) return "FLAT";
  const d = (p-e)/e*100; return d>0.3?"UP":d<-0.3?"DOWN":"FLAT";
}
function simulate(c: Candle[], i: number, side: "LONG"|"SHORT", tpPct: number, slPct: number, mh: number) {
  const ep = c[i].close;
  const tp = side==="LONG" ? ep*(1+tpPct/100) : ep*(1-tpPct/100);
  const sl = side==="LONG" ? ep*(1-slPct/100) : ep*(1+slPct/100);
  for (let j=i+1;j<Math.min(i+1+mh, c.length); j++) {
    if (side==="LONG") { if(c[j].low<=sl) return "LOSS" as const; if(c[j].high>=tp) return "WIN" as const; }
    else { if(c[j].high>=sl) return "LOSS" as const; if(c[j].low<=tp) return "WIN" as const; }
  }
  return "TIMEOUT" as const;
}

(async () => {
  console.log("=== backtest-verdict-by-tf — per-TF verdict accuracy ===\n");

  // Fetch all distinct intervals
  const intervalSet = new Set<string>();
  for (const t of TFS) { intervalSet.add(t.key); intervalSet.add(t.near); intervalSet.add(t.far); }
  const totalMap: Record<string, number> = Object.fromEntries(TFS.map(t=>[t.key, t.total]));
  const rawAll: Record<string, Candle[]> = {};
  for (const interval of intervalSet) {
    const total = totalMap[interval] ?? 3000;
    rawAll[interval] = await fetchKlines(interval, total);
    console.log(`  ${interval}: ${rawAll[interval].length}`);
  }

  const LEV = 100, FEE_RATE = 0.04 * 2;
  const out: Record<string, any> = {};

  for (const tfDef of TFS) {
    const { key: tfKey, tp, sl, maxHold, near, far } = tfDef;
    const entry = rawAll[tfKey];
    const nearArr = rawAll[near];
    const farArr = rawAll[far];

    if (entry.length < 100) {
      console.log(`\n[${tfKey}] skip (only ${entry.length} candles)`);
      out[tfKey] = { skipped: true, reason: "data too small" };
      continue;
    }

    const closes = entry.map(k=>k.close);
    const ema50 = calcEMASeries(closes, 50);
    const rsiArr = calcRSISeriesAligned(closes, 14);
    const atrArr: (number|null)[] = new Array(entry.length).fill(null);
    for (let i=30;i<entry.length;i++) atrArr[i] = calcATRPct(entry.slice(Math.max(0,i-50), i+1), 14);

    // Adaptive atrTight = P30 of non-null ATR
    const atrValid = atrArr.filter((v):v is number => v!==null).sort((a,b)=>a-b);
    const atrTight = atrValid.length > 50 ? atrValid[Math.floor(atrValid.length * 0.30)] : 0.3;

    const nearCloses = nearArr.map(k=>k.close);
    const nearEma = calcEMASeries(nearCloses, 50);
    const nearRsi = calcRSISeriesAligned(nearCloses, 14);

    const farCloses = farArr.map(k=>k.close);
    const farEma = calcEMASeries(farCloses, 50);

    const FEE = FEE_RATE * LEV;
    const BE = ((sl*LEV + FEE) / ((sl+tp)*LEV)) * 100;

    const buckets: Record<string, { side: "LONG"|"SHORT"|"NEUTRAL"; wins: number; losses: number; timeouts: number; N: number; ticks: number }> = {};
    const bump = (text: string, side: "LONG"|"SHORT"|"NEUTRAL", o: "WIN"|"LOSS"|"TIMEOUT"|"SKIP") => {
      if (!buckets[text]) buckets[text] = { side, wins:0, losses:0, timeouts:0, N:0, ticks:0 };
      buckets[text].ticks++;
      if (o === "SKIP") return;
      buckets[text].N++;
      if (o === "WIN") buckets[text].wins++;
      else if (o === "LOSS") buckets[text].losses++;
      else buckets[text].timeouts++;
    };

    const lastEntry: Record<string, number> = {};
    const COOLDOWN = Math.max(4, Math.floor(maxHold / 6));
    const startIdx = 60;
    const endIdx = entry.length - maxHold - 2;

    // stoch on entry TF
    const stoch = calcStochRSISeries(closes, 14, 14, 3, 3);

    for (let i = startIdx; i <= endIdx; i++) {
      const t = entry[i].time;
      const price = closes[i];
      const e = ema50[i];
      const emaDist = e!==null && e>0 ? ((price-e)/e)*100 : null;
      const atr = atrArr[i];
      const rsi = rsiArr[i];
      const stK = stoch.kSeries[i];

      // HTF trend
      const iN = idxAtOrBefore(nearArr, t);
      const tN = iN>=0 ? trendFromEMA(nearArr[iN].close, nearEma[iN]) : "FLAT";
      const rN = iN>=0 ? nearRsi[iN] : null;
      const iF = idxAtOrBefore(farArr, t);
      const tF = iF>=0 ? trendFromEMA(farArr[iF].close, farEma[iF]) : "FLAT";

      // Adjacent stoch on entry TF (check prev bar)
      const stKPrev = i>0 ? stoch.kSeries[i-1] : null;
      const adjStochOS = stK!==null && stKPrev!==null && stK<20 && stKPrev<20;
      const adjStochOB = stK!==null && stKPrev!==null && stK>80 && stKPrev>80;

      // Divergence on entry TF
      const divWindow = closes.slice(Math.max(0, i-29), i+1);
      const div = divWindow.length>=30 ? detectDivergence(divWindow, 14, 30) : null;

      // Score LONG (using near as "4h equivalent", far as "1d equivalent")
      let scoreLONG = 0;
      if (tN === "FLAT") scoreLONG += 30;
      if (tN === "DOWN") scoreLONG -= 20;
      if (tF === "FLAT" || tF === "UP") scoreLONG += 10;
      if (rN !== null && rN > 75) scoreLONG -= 25;
      if (tF === "UP" || tF === "FLAT") scoreLONG += 8;
      if (atr !== null && atr < atrTight) scoreLONG += 25;
      if (emaDist !== null && emaDist >= -0.5 && emaDist <= 0.5) scoreLONG += 20;
      if (rsi !== null && rsi < 60) scoreLONG += 10;
      if (rsi !== null && rsi > 70) scoreLONG -= 30;

      const goldenLONG = atr !== null && atr < atrTight
        && emaDist !== null && emaDist >= -0.5 && emaDist <= 0.5
        && tF === "FLAT";

      // Simple per-bar obCount/osCount on entry TF (for SHORT CAUTION)
      const obHere = rsi !== null && rsi > 70;
      const osHere = rsi !== null && rsi < 30;

      let text: string, side: "LONG"|"SHORT"|"NEUTRAL";
      if (goldenLONG) { text = "GOLDEN LONG SETUP"; side = "LONG"; }
      else if (scoreLONG >= 80) { text = "STRONG LONG (SCORE)"; side = "LONG"; }
      else if (scoreLONG >= 60) { text = "POTENTIAL LONG (SCORE)"; side = "LONG"; }
      else if (scoreLONG >= 50) { text = "WEAK LONG (SCORE)"; side = "LONG"; }
      else if (adjStochOS && tF !== "DOWN") { text = "STOCH REVERSAL LONG"; side = "LONG"; }
      else if ((obHere || div === "BEARISH_DIV") && tF !== "UP") { text = "SHORT CAUTION"; side = "SHORT"; }
      else { text = "TRUNG TÍNH"; side = "NEUTRAL"; }

      if (lastEntry[text] !== undefined && i - lastEntry[text] < COOLDOWN) { bump(text, side, "SKIP"); continue; }
      if (side === "NEUTRAL") { bump(text, side, "SKIP"); continue; }

      lastEntry[text] = i;
      const o = simulate(entry, i, side, tp, sl, maxHold);
      bump(text, side, o);
    }

    const results = Object.entries(buckets).map(([text, b]) => {
      const wr = b.N>0 ? (b.wins/b.N)*100 : 0;
      const gross = b.wins*tp*LEV - b.losses*sl*LEV;
      const net = gross - b.N*FEE;
      return { text, side: b.side, N: b.N, wins: b.wins, losses: b.losses, timeouts: b.timeouts,
        wr: +wr.toFixed(1), breakEven: +BE.toFixed(1), edge: +(wr-BE).toFixed(1),
        netPct: +net.toFixed(0), netPerTrade: b.N>0 ? +(net/b.N).toFixed(1) : 0 };
    }).sort((a,b) => b.netPerTrade - a.netPerTrade);

    out[tfKey] = {
      tfKey, near, far, tp, sl, maxHold, atrTight: +atrTight.toFixed(3),
      breakEven: +BE.toFixed(1),
      candleCount: entry.length,
      results,
      byText: Object.fromEntries(results.map(r => [r.text, r])),
    };

    console.log(`\n[${tfKey}] atrTight=${atrTight.toFixed(3)}% tp=${tp}% sl=${sl}% BE=${BE.toFixed(1)}% HTF=${near}+${far}`);
    console.log("Verdict                          | Side  |  N   | WR%   | Edge   | NET/tr | NET");
    for (const r of results) {
      const flag = r.edge>=5?"🟢":r.edge>=0?"🟡":"🔴";
      console.log(` ${flag} ${r.text.padEnd(30)}| ${r.side.padEnd(5)} | ${String(r.N).padStart(4)} | ${String(r.wr).padStart(5)}% | ${r.edge>=0?"+":""}${String(r.edge).padStart(5)}% | ${r.netPerTrade>=0?"+":""}${String(r.netPerTrade).padStart(5)}% | ${r.netPct>=0?"+":""}${r.netPct}%`);
    }
  }

  const outPath = join(__dirname, "..", "assets", "verdict_accuracy_by_tf.json");
  writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), scheme: "per-tf-adaptive-atr", byTF: out }, null, 2));
  console.log(`\n✅ Wrote ${outPath}`);
})();
