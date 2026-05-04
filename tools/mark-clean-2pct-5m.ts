/**
 * mark-clean-2pct-5m.ts (anh Tommy 2026-05-04)
 * Đánh dấu cây 5m mà SAU đó:
 *   - Giá tăng ≥ 2% (high tương lai >= entry × 1.02)
 *   - VÀ trước khi đạt 2%, giá KHÔNG giảm quá 1% (max adverse < 1%)
 * Lookforward: 24h = 288 bars 5m.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const TARGET_PCT = 2;
const MAX_ADVERSE_PCT = 1;
const LOOKFORWARD_BARS = 288; // 24h × 12 bars/h
const TF = "5m";

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }

function loadCache(tf: string): Candle[] { return JSON.parse(readFileSync(join(__dirname,"..",".cache",`binance-${tf}-3y.json`),"utf8")); }

function main() {
  console.log(`[clean2pct] Loading ${TF}...`);
  const c = loadCache(TF);
  console.log(`[clean2pct] ${c.length} bars`);

  const winners: { ts: number; entry: number; tpHit: number; tpHitBars: number; maeBefore: number; maxGain: number }[] = [];
  let dirtyHighMAE = 0;
  let neverHitTP = 0;

  for (let i = 0; i < c.length - 1; i++) {
    const entry = c[i].close;
    const tpTarget = entry * (1 + TARGET_PCT / 100);
    const slBound = entry * (1 - MAX_ADVERSE_PCT / 100);
    let mae = 0;
    let hitTP = -1;
    let stopped = false;
    let maxHi = entry;
    const limit = Math.min(c.length, i + 1 + LOOKFORWARD_BARS);
    for (let j = i + 1; j < limit; j++) {
      // Check SL first (low touches slBound)
      if (c[j].low <= slBound) {
        stopped = true;
        const adv = (entry - c[j].low) / entry * 100;
        if (adv > mae) mae = adv;
        break;
      }
      const adv = (entry - c[j].low) / entry * 100;
      if (adv > mae) mae = adv;
      if (c[j].high > maxHi) maxHi = c[j].high;
      if (c[j].high >= tpTarget) {
        hitTP = j;
        break;
      }
    }
    if (hitTP >= 0 && !stopped) {
      winners.push({
        ts: c[i].time, entry, tpHit: c[hitTP].time, tpHitBars: hitTP - i,
        maeBefore: mae, maxGain: (maxHi - entry) / entry * 100,
      });
    } else if (stopped) dirtyHighMAE++;
    else neverHitTP++;
  }

  console.log(`\n=== RESULTS ===`);
  console.log(`Total bars: ${c.length}`);
  console.log(`✅ CLEAN winners (TP +${TARGET_PCT}%, MAE < ${MAX_ADVERSE_PCT}%): ${winners.length} = ${(winners.length/c.length*100).toFixed(2)}%`);
  console.log(`❌ Dirty (giá rớt > ${MAX_ADVERSE_PCT}% trước TP): ${dirtyHighMAE} = ${(dirtyHighMAE/c.length*100).toFixed(2)}%`);
  console.log(`❌ Never hit TP trong 24h: ${neverHitTP} = ${(neverHitTP/c.length*100).toFixed(2)}%`);

  if (winners.length > 0) {
    const hb = winners.map(w=>w.tpHitBars).sort((a,b)=>a-b);
    const m = winners.map(w=>w.maeBefore).sort((a,b)=>a-b);
    const g = winners.map(w=>w.maxGain).sort((a,b)=>a-b);
    const med = (a: number[]) => a[Math.floor(a.length/2)];
    const p75 = (a: number[]) => a[Math.floor(a.length*0.75)];
    const p90 = (a: number[]) => a[Math.floor(a.length*0.9)];
    const mean = (a: number[]) => a.reduce((s,v)=>s+v,0)/a.length;
    console.log(`\nThời gian hit TP +2%: median=${med(hb)} bars 5m = ${(med(hb)*5/60).toFixed(1)}h  p75=${(p75(hb)*5/60).toFixed(1)}h  p90=${(p90(hb)*5/60).toFixed(1)}h`);
    console.log(`MAE trước TP: median=${med(m).toFixed(2)}%  mean=${mean(m).toFixed(2)}%  p75=${p75(m).toFixed(2)}%  p90=${p90(m).toFixed(2)}%`);
    console.log(`Max gain 24h: median=${med(g).toFixed(2)}%  mean=${mean(g).toFixed(2)}%  p90=${p90(g).toFixed(2)}%`);
    console.log(`\nNếu trade 100% clean (mơ tưởng): ${winners.length} × +${TARGET_PCT}% = ${winners.length*TARGET_PCT}% notional`);
  }

  // Output for chart
  const priceLine: { ts: number; price: number }[] = [];
  const step = 10;
  for (let i = 0; i < c.length; i += step) priceLine.push({ ts: c[i].time, price: c[i].close });

  writeFileSync(join(__dirname,"..","assets","mark_clean_2pct_5m.json"), JSON.stringify({
    period: { start: c[0].time, end: c[c.length-1].time },
    config: { tf: TF, targetPct: TARGET_PCT, maxAdversePct: MAX_ADVERSE_PCT, lookforwardBars: LOOKFORWARD_BARS, lookforwardHours: LOOKFORWARD_BARS*5/60 },
    totalBars: c.length, winnerCount: winners.length, dirtyHighMAE, neverHitTP,
    winnerPct: winners.length/c.length*100,
    winners,
    priceLine,
  }));
  console.log(`\nSaved → assets/mark_clean_2pct_5m.json`);
}
main();
