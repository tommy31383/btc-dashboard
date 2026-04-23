/**
 * verify-all-goldens.ts
 *
 * Back test TẤT CẢ Golden rules hiện có trong hook useRiskRadar.ts
 * trên 20K candles 1h BTCUSDT (~2.3Y). TP5/SL2/hold100h/fee 0.05%×2.
 *
 * LONG (7):
 *   G1 QUADRUPLE   macd+ema+atr+FLAT
 *   G2 MACD+EMA    macd+ema+FLAT
 *   G3 MACD+ATR    macd+atr+FLAT
 *   G4 SILENT+CEN  atr+ema+FLAT
 *   G5 CROSS+SILNT emaCross+atr+FLAT
 *   G6 DOJI+MACD   bodySmall+macd+FLAT
 *   G7 BB+MACD     bbSqueeze+macd+FLAT
 * SHORT (1):
 *   G8 SHORT SCALP ema+atr+UP
 *
 * Output: console table + assets/verify_all_goldens.json
 */

import { writeFileSync } from "fs";
import { join } from "path";
import {
  calcRSISeriesAligned,
  calcMACDSeries,
  calcEMASeries,
  calcBollingerSeries,
} from "../utils/indicators";

const BINANCE = "https://api.binance.com/api/v3";
const args = process.argv.slice(2);
const getArg = (k: string, d: string) => {
  const a = args.find((x) => x.startsWith(`--${k}=`));
  return a ? a.split("=")[1] : d;
};
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

function simulate(candles: Candle[], i: number, side: "LONG"|"SHORT") {
  const entry = candles[i].close;
  const tpP = side === "LONG" ? entry*(1+TP/100) : entry*(1-TP/100);
  const slP = side === "LONG" ? entry*(1-SL/100) : entry*(1+SL/100);
  const end = Math.min(i + HOLD, candles.length - 1);
  for (let j = i+1; j <= end; j++) {
    if (side === "LONG") {
      if (candles[j].low <= slP) return { pnl: -SL, out: "SL" as const, hold: j-i };
      if (candles[j].high >= tpP) return { pnl: TP, out: "TP" as const, hold: j-i };
    } else {
      if (candles[j].high >= slP) return { pnl: -SL, out: "SL" as const, hold: j-i };
      if (candles[j].low <= tpP) return { pnl: TP, out: "TP" as const, hold: j-i };
    }
  }
  const exitP = candles[end].close;
  const pnl = side === "LONG" ? ((exitP-entry)/entry)*100 : ((entry-exitP)/entry)*100;
  return { pnl, out: "TIMEOUT" as const, hold: end-i };
}

interface Hit { pnl: number; out: string; hold: number; }
interface Metric { n: number; wr: number; sumPnl: number; avgWin: number; avgLoss: number; pf: number; exp: number; avgHold: number; }

function metrics(hits: Hit[]): Metric {
  let wins=0, sw=0, sl=0, sp=0, sh=0;
  const pnls: number[] = [];
  for (const h of hits) {
    const p = h.pnl - FEE*2;
    pnls.push(p); sp += p; sh += h.hold;
    if (p > 0) { wins++; sw += p; } else sl += p;
  }
  const n = hits.length;
  const wc = pnls.filter(p=>p>0).length;
  const lc = pnls.filter(p=>p<=0).length;
  return {
    n,
    wr: n ? +((wc/n)*100).toFixed(2) : 0,
    sumPnl: +sp.toFixed(2),
    avgWin: wc ? +(sw/wc).toFixed(2) : 0,
    avgLoss: lc ? +(sl/lc).toFixed(2) : 0,
    pf: sl<0 ? +(sw/Math.abs(sl)).toFixed(2) : (sw>0?99:0),
    exp: n ? +(sp/n).toFixed(3) : 0,
    avgHold: n ? +(sh/n).toFixed(1) : 0,
  };
}

async function main() {
  console.log("═".repeat(78));
  console.log("🔬 VERIFY ALL GOLDEN RULES — back test 2.3Y fresh data");
  console.log("═".repeat(78));
  console.log(`Period: ${CANDLES} candles 1h · TP${TP}/SL${SL} · hold${HOLD}h · fee ${FEE}%×2\n`);

  console.log("📡 Fetching …");
  const [k1h, k4h] = await Promise.all([
    fetchKlines("1h", CANDLES),
    fetchKlines("4h", Math.ceil(CANDLES/4)+200),
  ]);
  console.log(`  ✓ 1h:${k1h.length} · 4h:${k4h.length}`);

  console.log("🧮 Computing features …");
  const closes1h = k1h.map(c=>c.close);
  const closes4h = k4h.map(c=>c.close);
  const macd1h = calcMACDSeries(closes1h, 12, 26, 9);
  const ema20 = calcEMASeries(closes1h, 20);
  const ema50_1h = calcEMASeries(closes1h, 50);
  const ema50_4h = calcEMASeries(closes4h, 50);
  const bb1h = calcBollingerSeries(closes1h, 20, 2);
  const atr1h = calcATRPctSeries(k1h, 14);

  console.log("🔎 Scanning & simulating …");
  const g1: Hit[] = [], g2: Hit[] = [], g3: Hit[] = [], g4: Hit[] = [];
  const g5: Hit[] = [], g6: Hit[] = [], g7: Hit[] = [], g8: Hit[] = [];
  let baseLong: Hit[] = [];

  for (let i = 100; i < k1h.length - HOLD - 1; i++) {
    const mh = macd1h.histogram[i];
    const e20 = ema20[i], e50 = ema50_1h[i], a1 = atr1h[i];
    const bbU = bb1h.upper[i], bbL = bb1h.lower[i], bbM = bb1h.middle[i];
    if (mh===null||e20===null||e50===null||a1===null||bbU===null||bbL===null||bbM===null) continue;

    const close = k1h[i].close; const open = k1h[i].open;
    const emaDist1h = ((close-e50)/e50)*100;
    const bbWidth = ((bbU-bbL)/bbM)*100;
    const emaCrossBull = e20 > e50;
    const bodyPct = Math.abs(close-open)/open*100;

    const idx4h = findIdx(k4h, k1h[i].time); if (idx4h<0) continue;
    const e4 = ema50_4h[idx4h]; if (e4===null) continue;
    const emaDist4h = ((k4h[idx4h].close-e4)/e4)*100;
    const htf = emaDist4h>0.5?"UP":emaDist4h<-0.5?"DOWN":"FLAT";

    // Predicates
    const macdBull = mh>=0 && mh<50;
    const emaNear = Math.abs(emaDist1h) < 0.5;
    const atrLow = a1 < 0.3;
    const flat = htf==="FLAT"; const up = htf==="UP";

    const longSim = simulate(k1h, i, "LONG");
    const shortSim = simulate(k1h, i, "SHORT");
    const hL: Hit = { pnl: longSim.pnl, out: longSim.out, hold: longSim.hold };
    const hS: Hit = { pnl: shortSim.pnl, out: shortSim.out, hold: shortSim.hold };

    baseLong.push(hL);

    // G1 QUADRUPLE
    if (macdBull && emaNear && atrLow && flat) g1.push(hL);
    // G2 MACD+EMA+FLAT
    if (macdBull && emaNear && flat) g2.push(hL);
    // G3 MACD+ATR+FLAT
    if (macdBull && atrLow && flat) g3.push(hL);
    // G4 ATR+EMA+FLAT
    if (atrLow && emaNear && flat) g4.push(hL);
    // G5 CROSS+ATR+FLAT
    if (emaCrossBull && atrLow && flat) g5.push(hL);
    // G6 BODY+MACD+FLAT
    if (bodyPct < 0.1 && macdBull && flat) g6.push(hL);
    // G7 BB+MACD+FLAT
    if (bbWidth < 1.5 && macdBull && flat) g7.push(hL);
    // G8 SHORT: ema+atr+UP
    if (emaNear && atrLow && up) g8.push(hS);
  }

  const all = {
    G1_QUADRUPLE: { pred: "macd0-50 + ema±0.5% + atr<0.3% + FLAT", side: "LONG", claim: 71.8, m: metrics(g1) },
    G2_MACD_EMA:  { pred: "macd0-50 + ema±0.5% + FLAT",            side: "LONG", claim: 64.9, m: metrics(g2) },
    G3_MACD_ATR:  { pred: "macd0-50 + atr<0.3% + FLAT",            side: "LONG", claim: 67.4, m: metrics(g3) },
    G4_ATR_EMA:   { pred: "atr<0.3% + ema±0.5% + FLAT",            side: "LONG", claim: 60.4, m: metrics(g4) },
    G5_CROSS_ATR: { pred: "ema20>ema50 + atr<0.3% + FLAT",         side: "LONG", claim: 68.3, m: metrics(g5) },
    G6_DOJI_MACD: { pred: "body<0.1% + macd0-50 + FLAT",           side: "LONG", claim: 63.7, m: metrics(g6) },
    G7_BB_MACD:   { pred: "bbWidth<1.5% + macd0-50 + FLAT",        side: "LONG", claim: 62.3, m: metrics(g7) },
    G8_SHORT:     { pred: "ema±0.5% + atr<0.3% + UP",              side: "SHORT", claim: 86.7, m: metrics(g8) },
    BASELINE_LONG:{ pred: "LONG every bar",                         side: "LONG", claim: 35.5, m: metrics(baseLong) },
  };

  console.log("");
  console.log("┌──────────────┬──────────────────────────────────────────────┬───────┬────────┬───────┬───────┬────────┬────────┬────────┐");
  console.log("│ ID           │ Predicate                                    │   N   │  WR %  │ Claim │  Δ    │   PF   │ Exp %  │  Hold  │");
  console.log("├──────────────┼──────────────────────────────────────────────┼───────┼────────┼───────┼───────┼────────┼────────┼────────┤");
  for (const [key, r] of Object.entries(all)) {
    const d = r.m.wr - r.claim;
    const mark = r.m.wr >= 60 ? "✅" : r.m.wr >= 50 ? "🟡" : "❌";
    console.log(`│ ${mark} ${key.padEnd(11)} │ ${r.pred.padEnd(44)} │ ${String(r.m.n).padStart(5)} │ ${r.m.wr.toFixed(2).padStart(6)} │ ${String(r.claim).padStart(5)} │ ${(d>=0?"+":"")+d.toFixed(1).padStart(4)} │ ${r.m.pf.toFixed(2).padStart(6)} │ ${r.m.exp.toFixed(3).padStart(6)} │ ${r.m.avgHold.toFixed(1).padStart(6)} │`);
  }
  console.log("└──────────────┴──────────────────────────────────────────────┴───────┴────────┴───────┴───────┴────────┴────────┴────────┘");

  console.log("");
  console.log("📊 SUMMARY:");
  const longRules = [all.G1_QUADRUPLE, all.G2_MACD_EMA, all.G3_MACD_ATR, all.G4_ATR_EMA, all.G5_CROSS_ATR, all.G6_DOJI_MACD, all.G7_BB_MACD];
  const above60 = longRules.filter(r => r.m.wr >= 60).length;
  const above70 = longRules.filter(r => r.m.wr >= 70).length;
  console.log(`  LONG rules WR ≥ 60%: ${above60}/7`);
  console.log(`  LONG rules WR ≥ 70%: ${above70}/7`);
  console.log(`  SHORT G8 WR: ${all.G8_SHORT.m.wr}% (claim ${all.G8_SHORT.claim}%) — ${all.G8_SHORT.m.wr >= 60 ? "✅ HOLDS" : "❌ DIVERGE"}`);
  console.log(`  Baseline LONG WR: ${all.BASELINE_LONG.m.wr}% · PF ${all.BASELINE_LONG.m.pf}`);

  writeFileSync(join("assets", "verify_all_goldens.json"), JSON.stringify({
    meta: { candles: CANDLES, tp: TP, sl: SL, hold: HOLD, fee: FEE, generatedAt: new Date().toISOString() },
    rules: all,
  }, null, 2));
  console.log("\n💾 Saved → assets/verify_all_goldens.json");
}

main().catch(e => { console.error(e); process.exit(1); });
