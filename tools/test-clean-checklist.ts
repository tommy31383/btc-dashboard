/**
 * test-clean-checklist.ts
 *
 * Câu hỏi: Nếu PASS HẾT checklist trong useRiskRadar (0 warnings active)
 *          thì WR thực tế bao nhiêu?
 *
 * 8 LONG warnings: htf_down, ema_far, rsi_oversold, atr15m_low, macd_weak,
 *                  mom24_overheat, bb_expand, body_big
 * 3 SHORT warnings: htf_up, ema_low, rsi_overbought
 *
 * Simulation: mỗi bar 1h → nếu tất cả N warning của side đều inactive → entry
 *             simulate TP+5/SL-2 (default preset Goldens).
 *
 * Output: WR, N, PF, NET cho LONG clean + SHORT clean.
 */

import { calcRSISeriesAligned, calcMACDSeries, calcBollingerSeries, calcEMASeries, calcATRPct } from "../utils/indicators";

const BINANCE = "https://api.binance.com/api/v3";
interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number; }

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
    all.unshift(...batch); endTime = batch[0].time - 1;
    await new Promise(r => setTimeout(r, 80));
  }
  const m = new Map<number, Candle>(); for (const c of all) m.set(c.time, c);
  return [...m.values()].sort((a,b) => a.time - b.time);
}
function idxAt(arr: Candle[], t: number): number {
  let lo=0, hi=arr.length-1, ans=-1;
  while (lo<=hi) { const m=(lo+hi)>>1; if (arr[m].time<=t) { ans=m; lo=m+1; } else hi=m-1; }
  return ans;
}
function trendFromEMA(price: number, ema: number | null): "UP"|"DOWN"|"FLAT" {
  if (ema==null) return "FLAT";
  const d = (price-ema)/ema*100;
  return d>0.5 ? "UP" : d<-0.5 ? "DOWN" : "FLAT";
}
function simulate(c: Candle[], idx: number, entry: number, side: "LONG"|"SHORT", tp: number, sl: number, maxHold=100) {
  const tpP = side==="LONG" ? entry*(1+tp/100) : entry*(1-tp/100);
  const slP = side==="LONG" ? entry*(1-sl/100) : entry*(1+sl/100);
  for (let i=idx+1; i<Math.min(idx+1+maxHold, c.length); i++) {
    if (side==="LONG") { if (c[i].low<=slP) return "LOSS"; if (c[i].high>=tpP) return "WIN"; }
    else              { if (c[i].high>=slP) return "LOSS"; if (c[i].low<=tpP) return "WIN"; }
  }
  return "TIMEOUT";
}

async function run() {
  console.log("=== test-clean-checklist · TP+5/SL-2 ===\n");
  console.log("Fetching klines...");
  const k1h = await fetchKlines("1h", 10000);
  const k4h = await fetchKlines("4h", 3000);
  const k15m = await fetchKlines("15m", 10000);
  console.log(`  1h: ${k1h.length}  |  4h: ${k4h.length}  |  15m: ${k15m.length}`);

  const closes1h = k1h.map(x=>x.close);
  const rsi1h = calcRSISeriesAligned(closes1h, 14);
  const macd1h = calcMACDSeries(closes1h);
  const bb1h = calcBollingerSeries(closes1h, 20, 2);
  const ema50_1h = calcEMASeries(closes1h, 50);
  const ema50_4h = calcEMASeries(k4h.map(x=>x.close), 50);

  // atrPct per 1h bar
  const atrPct_1h: (number|null)[] = new Array(k1h.length).fill(null);
  for (let i=20; i<k1h.length; i++) atrPct_1h[i] = calcATRPct(k1h.slice(0,i+1), 14);

  // atrPct 15m evaluated at 1h bar time
  const atrPct_15m_series: (number|null)[] = new Array(k15m.length).fill(null);
  for (let i=20; i<k15m.length; i++) atrPct_15m_series[i] = calcATRPct(k15m.slice(0,i+1), 14);

  let longEntries=0, longW=0, longL=0, longT=0;
  let shortEntries=0, shortW=0, shortL=0, shortT=0;
  let longPassCount=0, shortPassCount=0;

  // Track how many times each warning was active (to see which is strict filter)
  const longWarnCount: Record<string, number> = { htf_down:0, ema_far:0, rsi_oversold:0, atr15m_low:0, macd_weak:0, mom24_overheat:0, bb_expand:0, body_big:0 };
  const shortWarnCount: Record<string, number> = { htf_up:0, ema_low:0, rsi_overbought:0 };

  for (let i = 50; i < k1h.length - 100; i++) {
    const price = closes1h[i];
    const rsi = rsi1h[i];
    const mh = macd1h.histogram[i];
    const bbU = bb1h.upper[i], bbL = bb1h.lower[i], bbM = bb1h.middle[i];
    const e50_1h = ema50_1h[i];
    const atr1h = atrPct_1h[i];

    // HTF 4h at time of 1h bar close
    const t = k1h[i].time + 60*60*1000 - 1;
    const i4h = idxAt(k4h, t);
    const htfState = i4h>=0 ? trendFromEMA(k4h[i4h].close, ema50_4h[i4h]) : "FLAT";

    // atrPct 15m at this time
    const i15 = idxAt(k15m, t);
    const atr15 = i15>=20 ? atrPct_15m_series[i15] : null;

    // mom24 (1h): close now vs close 24 bars ago
    const mom24 = i>=24 ? ((price - closes1h[i-24])/closes1h[i-24])*100 : null;

    // BB width
    const bbWidth = (bbU!==null && bbL!==null && bbM!==null && bbM!==0) ? ((bbU-bbL)/bbM)*100 : null;

    // EMA dist 1h
    const emaDist = (e50_1h!==null && e50_1h!==0) ? ((price-e50_1h)/e50_1h)*100 : null;

    // Body pct
    const body = (Math.abs(k1h[i].close - k1h[i].open) / k1h[i].open) * 100;

    // Skip bars thiếu data
    if (rsi===null || mh===null || e50_1h===null || atr1h===null || atr15===null || mom24===null || bbWidth===null || emaDist===null) continue;

    // 8 LONG warnings
    const longWarns = {
      htf_down:        htfState === "DOWN",
      ema_far:         emaDist > 2,
      rsi_oversold:    rsi < 30,
      atr15m_low:      atr15 < 0.3,
      macd_weak:       mh < -50,
      mom24_overheat:  mom24 > 2,
      bb_expand:       bbWidth > 4,
      body_big:        body > 1,
    };
    const longActive = Object.values(longWarns).filter(Boolean).length;
    for (const [k,v] of Object.entries(longWarns)) if (v) longWarnCount[k]++;

    // 3 SHORT warnings
    const shortWarns = {
      htf_up:           htfState === "UP",
      ema_low:          emaDist < -2,
      rsi_overbought:   rsi > 70,
    };
    const shortActive = Object.values(shortWarns).filter(Boolean).length;
    for (const [k,v] of Object.entries(shortWarns)) if (v) shortWarnCount[k]++;

    // LONG clean entry
    if (longActive === 0) {
      longPassCount++;
      longEntries++;
      const r = simulate(k1h, i, price, "LONG", 5, 2);
      if (r==="WIN") longW++; else if (r==="LOSS") longL++; else longT++;
    }
    // SHORT clean entry
    if (shortActive === 0) {
      shortPassCount++;
      shortEntries++;
      const r = simulate(k1h, i, price, "SHORT", 5, 2);
      if (r==="WIN") shortW++; else if (r==="LOSS") shortL++; else shortT++;
    }
  }

  const lN = longW+longL+longT, sN = shortW+shortL+shortT;
  const lWR = lN>0 ? longW/lN*100 : 0;
  const sWR = sN>0 ? shortW/sN*100 : 0;
  const lev = 10, fee = 0.08*lev;
  const lNet = longW*5*lev - longL*2*lev - lN*fee;
  const sNet = shortW*5*lev - shortL*2*lev - sN*fee;
  const lPF = longL>0 ? (longW*5)/(longL*2) : (longW>0?999:0);
  const sPF = shortL>0 ? (shortW*5)/(shortL*2) : (shortW>0?999:0);

  const totalBars = k1h.length - 150;

  console.log(`\n╔═══ LONG CLEAN CHECKLIST (pass hết 8/8) ═══════════╗`);
  console.log(`  Bars qualified:  ${longPassCount} / ${totalBars} (${(longPassCount/totalBars*100).toFixed(1)}%)`);
  console.log(`  Trades (N):      ${lN}`);
  console.log(`  Wins / Losses:   ${longW} / ${longL} (timeout ${longT})`);
  console.log(`  WR:              ${lWR.toFixed(2)}%`);
  console.log(`  PF:              ${lPF.toFixed(2)}`);
  console.log(`  NET (lev 10x):   ${lNet>=0?'+':''}${lNet.toFixed(0)}%`);
  console.log(`  Expectancy:      ${lN>0?(lNet/lN).toFixed(2):0}%/trade`);

  console.log(`\n╔═══ SHORT CLEAN CHECKLIST (pass hết 3/3) ══════════╗`);
  console.log(`  Bars qualified:  ${shortPassCount} / ${totalBars} (${(shortPassCount/totalBars*100).toFixed(1)}%)`);
  console.log(`  Trades (N):      ${sN}`);
  console.log(`  Wins / Losses:   ${shortW} / ${shortL} (timeout ${shortT})`);
  console.log(`  WR:              ${sWR.toFixed(2)}%`);
  console.log(`  PF:              ${sPF.toFixed(2)}`);
  console.log(`  NET (lev 10x):   ${sNet>=0?'+':''}${sNet.toFixed(0)}%`);
  console.log(`  Expectancy:      ${sN>0?(sNet/sN).toFixed(2):0}%/trade`);

  console.log(`\n╔═══ LONG warning activation rate ═══╗`);
  for (const [k,v] of Object.entries(longWarnCount).sort((a,b)=>b[1]-a[1])) {
    console.log(`  ${k.padEnd(18)}: ${v} bars (${(v/totalBars*100).toFixed(1)}%)`);
  }
  console.log(`\n╔═══ SHORT warning activation rate ═══╗`);
  for (const [k,v] of Object.entries(shortWarnCount).sort((a,b)=>b[1]-a[1])) {
    console.log(`  ${k.padEnd(18)}: ${v} bars (${(v/totalBars*100).toFixed(1)}%)`);
  }
}

run();
