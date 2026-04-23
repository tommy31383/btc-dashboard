/**
 * scan-features.ts
 *
 * Generic feature scan cho LONG/SHORT + single/pair/triple filter.
 *
 * Usage:
 *   npx tsx tools/scan-features.ts --side=LONG  --tp=5 --sl=2 --triple
 *   npx tsx tools/scan-features.ts --side=SHORT --tp=5 --sl=2
 *
 * Output: assets/scan_features_{SIDE}_tp{TP}sl{SL}.json
 */

import { writeFileSync } from "fs";
import { join } from "path";
import { calcRSISeriesAligned, calcMACDSeries, calcBollingerSeries, calcEMASeries } from "../utils/indicators";

const BINANCE = "https://api.binance.com/api/v3";
const args = process.argv.slice(2);
const getArg = (k: string, d: string) => { const a = args.find(x => x.startsWith(`--${k}=`)); return a ? a.split("=")[1] : d; };
const hasFlag = (k: string) => args.includes(`--${k}`);
const CANDLES = parseInt(getArg("candles", "10000"), 10);
const TP_PCT = parseFloat(getArg("tp", "5"));
const SL_PCT = parseFloat(getArg("sl", "2"));
const MAX_HOLD = parseInt(getArg("hold", "100"), 10);
const LEV = parseFloat(getArg("lev", "100"));
const FEE = parseFloat(getArg("fee", "0.04"));
const SIDE = (getArg("side", "LONG").toUpperCase() as "LONG" | "SHORT");
const TRIPLE = hasFlag("triple");
const FEE_PNL = FEE * 2 * LEV;

interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number; }

async function fetchKlines(interval: string, total: number): Promise<Candle[]> {
  const all: Candle[] = []; let endTime: number | undefined;
  while (all.length < total) {
    const limit = Math.min(1000, total - all.length);
    const params = new URLSearchParams({ symbol: "BTCUSDT", interval, limit: String(limit) });
    if (endTime) params.set("endTime", String(endTime));
    const res = await fetch(`${BINANCE}/klines?${params}`);
    const data: any[] = await res.json();
    if (!data.length) break;
    const batch = data.map(k => ({ time:k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5] }));
    all.unshift(...batch);
    endTime = batch[0].time - 1;
    await new Promise(r => setTimeout(r, 80));
  }
  const m = new Map<number, Candle>(); for (const c of all) m.set(c.time, c);
  return [...m.values()].sort((a,b) => a.time - b.time);
}

function findTFIndexAt(arr: Candle[], t: number): number {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid].time <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}

function atrPct(candles: Candle[], i: number, period = 14): number | null {
  if (i < period) return null;
  let sum = 0;
  for (let j = i - period + 1; j <= i; j++) {
    const prevClose = j > 0 ? candles[j - 1].close : candles[j].open;
    const tr = Math.max(
      candles[j].high - candles[j].low,
      Math.abs(candles[j].high - prevClose),
      Math.abs(candles[j].low - prevClose),
    );
    sum += tr;
  }
  return (sum / period) / candles[i].close * 100;
}

function simulate(candles: Candle[], entryIdx: number, side: "LONG"|"SHORT", tp: number, sl: number, maxHold: number): "WIN" | "LOSS" | "TIMEOUT" {
  const entry = candles[entryIdx].close;
  if (side === "LONG") {
    const tpAbs = entry * (1 + tp / 100);
    const slAbs = entry * (1 - sl / 100);
    for (let i = entryIdx + 1; i < Math.min(entryIdx + 1 + maxHold, candles.length); i++) {
      if (candles[i].low <= slAbs) return "LOSS";
      if (candles[i].high >= tpAbs) return "WIN";
    }
  } else {
    const tpAbs = entry * (1 - tp / 100);
    const slAbs = entry * (1 + sl / 100);
    for (let i = entryIdx + 1; i < Math.min(entryIdx + 1 + maxHold, candles.length); i++) {
      if (candles[i].high >= slAbs) return "LOSS";
      if (candles[i].low <= tpAbs) return "WIN";
    }
  }
  return "TIMEOUT";
}

function bucket(name: string, v: number | null): string {
  if (v === null || !isFinite(v)) return `${name}:null`;
  if (name === "rsi") { if (v<30) return "rsi:<30"; if (v<45) return "rsi:30-45"; if (v<55) return "rsi:45-55"; if (v<70) return "rsi:55-70"; return "rsi:>70"; }
  if (name === "macdHist") { if (v<-50) return "macd:<-50"; if (v<0) return "macd:-50..0"; if (v<50) return "macd:0..50"; return "macd:>50"; }
  if (name === "bbPct") { if (v<0) return "bb%:<0"; if (v<0.25) return "bb%:0-25"; if (v<0.5) return "bb%:25-50"; if (v<0.75) return "bb%:50-75"; if (v<=1) return "bb%:75-100"; return "bb%:>100"; }
  if (name === "ema50Dist") { if (v<-2) return "ema:<-2%"; if (v<-0.5) return "ema:-2..-0.5%"; if (v<0.5) return "ema:-0.5..0.5%"; if (v<2) return "ema:0.5..2%"; return "ema:>2%"; }
  if (name === "atr") { if (v<0.3) return "atr:<0.3%"; if (v<0.6) return "atr:0.3-0.6%"; if (v<1.0) return "atr:0.6-1.0%"; if (v<2.0) return "atr:1.0-2.0%"; return "atr:>2%"; }
  if (name === "bodyPct") { if (v<0.1) return "body:<0.1%"; if (v<0.3) return "body:0.1-0.3%"; if (v<0.6) return "body:0.3-0.6%"; if (v<1.2) return "body:0.6-1.2%"; return "body:>1.2%"; }
  return `${name}:${v.toFixed(2)}`;
}

async function scanTF(tfKey: string, htfKey: string) {
  console.log(`\n=== Scan ${SIDE} ${tfKey.toUpperCase()} (HTF=${htfKey}) ${TRIPLE ? "[TRIPLE]" : ""} ===`);
  const [entry, htf] = await Promise.all([
    fetchKlines(tfKey, CANDLES),
    fetchKlines(htfKey, Math.ceil(CANDLES / (htfKey === "1h" ? 4 : htfKey === "4h" ? 16 : 1)) + 200),
  ]);
  console.log(`  got ${entry.length} entry, ${htf.length} htf`);

  const closes = entry.map(c => c.close);
  const rsiArr = calcRSISeriesAligned(closes, 14);
  const macdArr = calcMACDSeries(closes);
  const bbArr = calcBollingerSeries(closes);
  const ema50Arr = calcEMASeries(closes, 50);
  const htfCloses = htf.map(c => c.close);
  const htfEma = calcEMASeries(htfCloses, 50);

  const records: { features: Record<string,string>; outcome: "WIN"|"LOSS"|"TIMEOUT" }[] = [];
  const startIdx = 50;
  const endIdx = entry.length - MAX_HOLD - 1;

  for (let i = startIdx; i < endIdx; i++) {
    const outcome = simulate(entry, i, SIDE, TP_PCT, SL_PCT, MAX_HOLD);
    const c = entry[i]; const prev = entry[i-1];
    const prevBull = prev.close >= prev.open; const currBull = c.close >= c.open;
    const reversal = prevBull === currBull ? "CONT" : (!prevBull && currBull ? "UP_REV" : "DOWN_REV");
    const bodyPct = Math.abs(c.close - c.open) / c.open * 100;
    const rsi = rsiArr[i]; const macdH = macdArr.histogram[i];
    const bbUp = bbArr.upper[i], bbLo = bbArr.lower[i];
    const bbPct = (bbUp != null && bbLo != null && bbUp !== bbLo) ? (c.close - bbLo) / (bbUp - bbLo) : null;
    const ema50 = ema50Arr[i]; const emaDist = ema50 != null ? (c.close - ema50) / ema50 * 100 : null;
    const atrP = atrPct(entry, i, 14);
    const htfI = findTFIndexAt(htf, c.time);
    let htfTrend = "htf:na";
    if (htfI >= 0 && htfEma[htfI] != null) {
      const diff = (htf[htfI].close - htfEma[htfI]!) / htfEma[htfI]! * 100;
      htfTrend = diff > 0.5 ? "htf:UP" : diff < -0.5 ? "htf:DOWN" : "htf:FLAT";
    }
    records.push({
      outcome,
      features: {
        rsi: bucket("rsi", rsi), macdHist: bucket("macdHist", macdH),
        bbPct: bucket("bbPct", bbPct), ema50Dist: bucket("ema50Dist", emaDist),
        atr: bucket("atr", atrP), bodyPct: bucket("bodyPct", bodyPct),
        candle: currBull ? "candle:BULL" : "candle:BEAR",
        reversal: `rev:${reversal}`, htf: htfTrend,
      },
    });
  }

  const total = records.length;
  const wins = records.filter(r => r.outcome === "WIN").length;
  const losses = records.filter(r => r.outcome === "LOSS").length;
  const timeouts = records.filter(r => r.outcome === "TIMEOUT").length;
  const overallWR = wins / (wins + losses) * 100;
  console.log(`  Total=${total} · W=${wins} L=${losses} T=${timeouts} · WR=${overallWR.toFixed(1)}%`);

  // Single
  const singleStats: Record<string, { n:number; w:number; l:number; wr:number; edge:number }> = {};
  for (const r of records) {
    if (r.outcome === "TIMEOUT") continue;
    for (const key of Object.keys(r.features)) {
      const lb = r.features[key];
      if (!singleStats[lb]) singleStats[lb] = { n:0, w:0, l:0, wr:0, edge:0 };
      const s = singleStats[lb]; s.n++;
      if (r.outcome === "WIN") s.w++; else s.l++;
    }
  }
  for (const k of Object.keys(singleStats)) { const s = singleStats[k]; s.wr = s.w/(s.w+s.l)*100; s.edge = s.wr - overallWR; }

  // Pair
  const featKeys = ["rsi","macdHist","bbPct","ema50Dist","atr","bodyPct","candle","reversal","htf"];
  const pairStats: Record<string, { n:number; w:number; l:number; wr:number; edge:number }> = {};
  for (const r of records) {
    if (r.outcome === "TIMEOUT") continue;
    for (let i = 0; i < featKeys.length; i++) for (let j = i+1; j < featKeys.length; j++) {
      const k = `${r.features[featKeys[i]]} & ${r.features[featKeys[j]]}`;
      if (!pairStats[k]) pairStats[k] = { n:0, w:0, l:0, wr:0, edge:0 };
      const s = pairStats[k]; s.n++;
      if (r.outcome === "WIN") s.w++; else s.l++;
    }
  }
  const pairFiltered: Record<string, any> = {};
  for (const k of Object.keys(pairStats)) if (pairStats[k].n >= 50) {
    const s = pairStats[k]; s.wr = s.w/(s.w+s.l)*100; s.edge = s.wr - overallWR;
    pairFiltered[k] = s;
  }

  // Triple (optional — expensive)
  let tripleFiltered: Record<string, any> = {};
  if (TRIPLE) {
    const tripleStats: Record<string, any> = {};
    for (const r of records) {
      if (r.outcome === "TIMEOUT") continue;
      for (let i=0; i<featKeys.length; i++)
      for (let j=i+1; j<featKeys.length; j++)
      for (let k=j+1; k<featKeys.length; k++) {
        const key = `${r.features[featKeys[i]]} & ${r.features[featKeys[j]]} & ${r.features[featKeys[k]]}`;
        if (!tripleStats[key]) tripleStats[key] = { n:0, w:0, l:0, wr:0, edge:0 };
        const s = tripleStats[key]; s.n++;
        if (r.outcome === "WIN") s.w++; else s.l++;
      }
    }
    for (const key of Object.keys(tripleStats)) if (tripleStats[key].n >= 40) {
      const s = tripleStats[key]; s.wr = s.w/(s.w+s.l)*100; s.edge = s.wr - overallWR;
      tripleFiltered[key] = s;
    }
    console.log(`  triples: ${Object.keys(tripleFiltered).length} combo (N≥40)`);
  }

  return {
    tfKey, side: SIDE, total, wins, losses, timeouts, overallWR,
    tp: TP_PCT, sl: SL_PCT, lev: LEV, maxHold: MAX_HOLD,
    singleStats, pairStats: pairFiltered, tripleStats: tripleFiltered,
  };
}

(async () => {
  console.log(`=== scan-features ===`);
  console.log(`Side=${SIDE} · TP +${TP_PCT}% · SL -${SL_PCT}% · lev ${LEV}x · maxHold ${MAX_HOLD} · fee ${FEE}%`);
  const res15m = await scanTF("15m", "1h");
  const res1h = await scanTF("1h", "4h");
  const out = { generatedAt: new Date().toISOString(), side: SIDE, params: { TP_PCT, SL_PCT, MAX_HOLD, LEV, FEE, TRIPLE }, tfs: { "15m": res15m, "1h": res1h } };
  const outPath = join(__dirname, "..", "assets", `scan_features_${SIDE}_tp${TP_PCT}sl${SL_PCT}.json`);
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\n✅ Wrote ${outPath}`);

  // Summary print
  for (const tf of ["15m","1h"]) {
    const res = tf === "15m" ? res15m : res1h;
    if (TRIPLE) {
      console.log(`\n=== ${tf.toUpperCase()} Top 15 TRIPLE (N≥40, sorted WR) ===`);
      const triples = Object.entries(res.tripleStats).filter(([,s]:any) => s.n >= 40).sort((a:any,b:any) => b[1].wr - a[1].wr).slice(0, 15);
      for (const [k,s] of triples as any) console.log(`  ${k.padEnd(70)} n=${s.n} WR=${s.wr.toFixed(1)}% edge=${s.edge>0?"+":""}${s.edge.toFixed(1)}%`);
    }
    console.log(`\n=== ${tf.toUpperCase()} Top 10 PAIR (N≥80) ===`);
    const pairs = Object.entries(res.pairStats).filter(([,s]:any) => s.n >= 80).sort((a:any,b:any) => b[1].wr - a[1].wr).slice(0, 10);
    for (const [k,s] of pairs as any) console.log(`  ${k.padEnd(55)} n=${s.n} WR=${s.wr.toFixed(1)}% edge=+${s.edge.toFixed(1)}%`);
  }
})();
