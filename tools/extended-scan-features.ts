/**
 * extended-scan-features.ts
 *
 * Scan RỘNG hơn scan-features.ts với features MỚI:
 *   - volSpike:  volume / SMA20(volume)  (spike = >1.5, silent = <0.7)
 *   - bbWidth:   (BB.upper - BB.lower) / BB.middle * 100  (squeeze = <1.5%)
 *   - emaCross:  ema20 vs ema50         (bull / bear)
 *   - mom24:     (close - close[-24]) / close[-24] * 100  (24h return)
 *   - bodyPct:   |close-open|/open * 100  (small = <0.1%, big = >1%)
 *
 * Scan pair (new feat × htf:FLAT/UP/DOWN) + triple (new feat × existing feat × htf).
 * Fee: 0.05% × 2 side. TP5 / SL2 / maxHold 100h.
 *
 * Usage: npx tsx tools/extended-scan-features.ts --side=LONG
 * Output: assets/extended_scan_{SIDE}.json
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
const SIDE = getArg("side", "LONG").toUpperCase() as "LONG" | "SHORT";
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
      if (candles[j].low <= slP) return { pnl: -SL, out: "SL" as const };
      if (candles[j].high >= tpP) return { pnl: TP, out: "TP" as const };
    } else {
      if (candles[j].high >= slP) return { pnl: -SL, out: "SL" as const };
      if (candles[j].low <= tpP) return { pnl: TP, out: "TP" as const };
    }
  }
  const exitP = candles[end].close;
  const pnl = side === "LONG" ? ((exitP-entry)/entry)*100 : ((entry-exitP)/entry)*100;
  return { pnl, out: "TIMEOUT" as const };
}

// Volume SMA
function smaSeries(vals: number[], period: number): (number|null)[] {
  const out: (number|null)[] = new Array(vals.length).fill(null);
  let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    sum += vals[i];
    if (i >= period) sum -= vals[i-period];
    if (i >= period-1) out[i] = sum/period;
  }
  return out;
}

async function main() {
  console.log("═".repeat(70));
  console.log(`🔭 EXTENDED SCAN — ${SIDE} — NEW FEATURES`);
  console.log("═".repeat(70));
  console.log(`Period: ${CANDLES} candles 1h · TP${TP}/SL${SL} · maxHold${HOLD}h\n`);

  console.log("📡 Fetching …");
  const [k1h, k4h] = await Promise.all([
    fetchKlines("1h", CANDLES),
    fetchKlines("4h", Math.ceil(CANDLES/4)+200),
  ]);
  console.log(`  ✓ 1h:${k1h.length} · 4h:${k4h.length}`);

  console.log("🧮 Computing features …");
  const closes1h = k1h.map(c=>c.close);
  const vols1h = k1h.map(c=>c.volume);
  const closes4h = k4h.map(c=>c.close);
  const rsi1h = calcRSISeriesAligned(closes1h, 14);
  const macd1h = calcMACDSeries(closes1h, 12, 26, 9);
  const ema20 = calcEMASeries(closes1h, 20);
  const ema50_1h = calcEMASeries(closes1h, 50);
  const ema50_4h = calcEMASeries(closes4h, 50);
  const bb1h = calcBollingerSeries(closes1h, 20, 2);
  const atr1h = calcATRPctSeries(k1h, 14);
  const volSMA = smaSeries(vols1h, 20);

  console.log("🔎 Building feature labels + simulating …");
  type Hit = { pnl: number; out: string };
  const buckets: Map<string, Hit[]> = new Map();
  const add = (key: string, h: Hit) => {
    const arr = buckets.get(key) || []; arr.push(h); buckets.set(key, arr);
  };

  let regFlat=0, regUp=0, regDn=0;

  for (let i = 100; i < k1h.length - HOLD - 1; i++) {
    const rsi = rsi1h[i]; const mh = macd1h.histogram[i];
    const e20 = ema20[i]; const e50 = ema50_1h[i]; const a1 = atr1h[i];
    const bbU = bb1h.upper[i]; const bbL = bb1h.lower[i]; const bbM = bb1h.middle[i];
    const vs = volSMA[i];
    if (rsi===null||mh===null||e20===null||e50===null||a1===null||vs===null||bbU===null||bbL===null||bbM===null) continue;

    const close = k1h[i].close;
    const open = k1h[i].open;
    const emaDist1h = ((close-e50)/e50)*100;
    const bbWidth = ((bbU - bbL)/bbM)*100;
    const emaCrossBull = e20 > e50;
    const volSpike = vols1h[i] / vs; // ratio
    const bodyPct = Math.abs(close-open)/open*100;
    const mom24 = i >= 24 ? ((close - closes1h[i-24]) / closes1h[i-24]) * 100 : null;
    if (mom24 === null) continue;

    // HTF
    const idx4h = findIdx(k4h, k1h[i].time); if (idx4h<0) continue;
    const e4 = ema50_4h[idx4h]; if (e4===null) continue;
    const emaDist4h = ((k4h[idx4h].close - e4)/e4)*100;
    const htf = emaDist4h>0.5?"UP":emaDist4h<-0.5?"DOWN":"FLAT";
    if (htf==="UP") regUp++; else if (htf==="DOWN") regDn++; else regFlat++;

    // Existing
    const macdBull = mh>=0 && mh<50;
    const emaNear = Math.abs(emaDist1h) < 0.5;
    const atrLow = a1 < 0.3;
    const htfFlat = htf==="FLAT";

    const sim = simulate(k1h, i, SIDE);
    const h = { pnl: sim.pnl, out: sim.out };

    // NEW feature buckets (pair with htf:FLAT for LONG, htf:UP for SHORT per lesson)
    const htfGate = SIDE === "LONG" ? htfFlat : htf==="UP";
    const gateLabel = SIDE === "LONG" ? "htf:FLAT" : "htf:UP";
    if (!htfGate) continue;

    // Singles (under htf gate)
    if (volSpike > 1.5) add(`volSpike>1.5 + ${gateLabel}`, h);
    if (volSpike < 0.7) add(`volSilent<0.7 + ${gateLabel}`, h);
    if (bbWidth < 1.5) add(`bbSqueeze<1.5% + ${gateLabel}`, h);
    if (bbWidth > 4) add(`bbExpand>4% + ${gateLabel}`, h);
    if (emaCrossBull) add(`ema20>ema50 + ${gateLabel}`, h);
    if (!emaCrossBull) add(`ema20<ema50 + ${gateLabel}`, h);
    if (bodyPct < 0.1) add(`bodySmall<0.1% + ${gateLabel}`, h);
    if (bodyPct > 1) add(`bodyBig>1% + ${gateLabel}`, h);
    if (mom24 < -2) add(`mom24<-2% + ${gateLabel}`, h);
    if (mom24 > 2) add(`mom24>+2% + ${gateLabel}`, h);
    if (Math.abs(mom24) < 0.5) add(`mom24flat + ${gateLabel}`, h);

    // Pairs (new feat × existing feat × htf)
    if (volSpike < 0.7 && atrLow) add(`volSilent + atrLow + ${gateLabel}`, h);
    if (volSpike < 0.7 && macdBull) add(`volSilent + macdBull + ${gateLabel}`, h);
    if (bbWidth < 1.5 && macdBull) add(`bbSqueeze + macdBull + ${gateLabel}`, h);
    if (bbWidth < 1.5 && atrLow) add(`bbSqueeze + atrLow + ${gateLabel}`, h);
    if (bbWidth < 1.5 && emaNear) add(`bbSqueeze + emaNear + ${gateLabel}`, h);
    if (emaCrossBull && macdBull && SIDE === "LONG") add(`emaCrossBull + macdBull + ${gateLabel}`, h);
    if (emaCrossBull && atrLow && SIDE === "LONG") add(`emaCrossBull + atrLow + ${gateLabel}`, h);
    if (bodyPct < 0.1 && macdBull) add(`bodySmall + macdBull + ${gateLabel}`, h);
    if (bodyPct < 0.1 && atrLow) add(`bodySmall + atrLow + ${gateLabel}`, h);
    if (Math.abs(mom24) < 0.5 && atrLow) add(`mom24flat + atrLow + ${gateLabel}`, h);
    if (Math.abs(mom24) < 0.5 && macdBull) add(`mom24flat + macdBull + ${gateLabel}`, h);
    if (mom24 < -2 && SIDE === "LONG") add(`mom24<-2% (dip buy) + ${gateLabel}`, h);
  }

  console.log(`\n🌐 Regime: UP ${regUp} · DOWN ${regDn} · FLAT ${regFlat}`);
  const total = regUp+regDn+regFlat;
  console.log(`         ${((regUp/total)*100).toFixed(1)}% · ${((regDn/total)*100).toFixed(1)}% · ${((regFlat/total)*100).toFixed(1)}%\n`);

  // Rank
  interface Rank { name: string; n: number; wins: number; wr: number; sumPnl: number; pf: number; exp: number; }
  const ranks: Rank[] = [];
  for (const [name, hits] of buckets) {
    if (hits.length < 25) continue;
    let wins=0, sw=0, sl=0, sp=0;
    for (const h of hits) {
      const pnl = h.pnl - FEE*2;
      sp += pnl;
      if (pnl > 0) { wins++; sw += pnl; } else sl += pnl;
    }
    const wr = (wins/hits.length)*100;
    const pf = sl < 0 ? sw/Math.abs(sl) : (sw>0?99:0);
    ranks.push({ name, n: hits.length, wins, wr: +wr.toFixed(2), sumPnl: +sp.toFixed(2), pf: +pf.toFixed(2), exp: +(sp/hits.length).toFixed(3) });
  }
  ranks.sort((a,b) => b.wr - a.wr);

  console.log(`🏆 TOP rules (N≥25, sort by WR):\n`);
  console.log("┌────────────────────────────────────────────────────────┬──────┬────────┬────────┬───────┬────────┐");
  console.log("│ Rule                                                   │  N   │  WR %  │ Sum %  │  PF   │  Exp % │");
  console.log("├────────────────────────────────────────────────────────┼──────┼────────┼────────┼───────┼────────┤");
  for (const r of ranks.slice(0, 25)) {
    console.log(`│ ${r.name.padEnd(54)} │ ${String(r.n).padStart(4)} │ ${r.wr.toFixed(2).padStart(6)} │ ${r.sumPnl.toFixed(2).padStart(6)} │ ${r.pf.toFixed(2).padStart(5)} │ ${r.exp.toFixed(3).padStart(6)} │`);
  }
  console.log("└────────────────────────────────────────────────────────┴──────┴────────┴────────┴───────┴────────┘");

  const outPath = join("assets", `extended_scan_${SIDE}.json`);
  writeFileSync(outPath, JSON.stringify({
    meta: { side: SIDE, candles: CANDLES, tp: TP, sl: SL, hold: HOLD, fee: FEE, generatedAt: new Date().toISOString() },
    regime: { up: regUp, down: regDn, flat: regFlat },
    ranks,
  }, null, 2));
  console.log(`\n💾 Saved → ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
