/**
 * mark-10pct-candles-15m.ts (anh Tommy 2026-05-04)
 * Đánh dấu mọi cây 15m mà sau đó giá đạt ≥10% (high tương lai >= low cây × 1.10)
 * trong vòng 7 ngày (672 bars 15m).
 * Output: chart hiển thị tất cả markers + tooltip thời gian đạt +10%.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const TARGET_PCT = 10;
const LOOKFORWARD_BARS = 672; // 7 days × 24h × 4 bars/h = 672
const TF = "15m";

interface Candle { time: number; open: number; high: number; low: number; close: number; }

function loadCache(tf: string): Candle[] { return JSON.parse(readFileSync(join(__dirname,"..",".cache",`binance-${tf}-3y.json`),"utf8")); }

function main() {
  console.log(`[mark10] Loading ${TF}...`);
  const c = loadCache(TF);
  console.log(`[mark10] ${c.length} bars`);

  const winners: { ts: number; entryLow: number; targetPrice: number; hitTs: number; hitBars: number; maxGainPct: number; }[] = [];

  // For each candle, look forward up to LOOKFORWARD_BARS to see if any future high >= entryLow × 1.10
  for (let i = 0; i < c.length - 1; i++) {
    const entryLow = c[i].low;
    const target = entryLow * (1 + TARGET_PCT / 100);
    let hitIdx = -1;
    let maxHigh = entryLow;
    const limit = Math.min(c.length, i + 1 + LOOKFORWARD_BARS);
    for (let j = i + 1; j < limit; j++) {
      if (c[j].high > maxHigh) maxHigh = c[j].high;
      if (hitIdx < 0 && c[j].high >= target) {
        hitIdx = j;
        // continue to find max gain
      }
    }
    if (hitIdx >= 0) {
      winners.push({
        ts: c[i].time,
        entryLow,
        targetPrice: target,
        hitTs: c[hitIdx].time,
        hitBars: hitIdx - i,
        maxGainPct: (maxHigh - entryLow) / entryLow * 100,
      });
    }
  }

  console.log(`\n=== RESULTS ===`);
  console.log(`Total bars: ${c.length}`);
  console.log(`Bars có +10% sau đó (trong 7d): ${winners.length} = ${(winners.length / c.length * 100).toFixed(1)}%`);
  if (winners.length > 0) {
    const hitBarsArr = winners.map(w => w.hitBars).sort((a, b) => a - b);
    const maxGainArr = winners.map(w => w.maxGainPct).sort((a, b) => a - b);
    const med = (a: number[]) => a[Math.floor(a.length / 2)];
    const p25 = (a: number[]) => a[Math.floor(a.length * 0.25)];
    const p75 = (a: number[]) => a[Math.floor(a.length * 0.75)];
    const p90 = (a: number[]) => a[Math.floor(a.length * 0.9)];
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    console.log(`\nThời gian hit +10% (bars 15m):`);
    console.log(`  mean=${mean(hitBarsArr).toFixed(0)}  p25=${p25(hitBarsArr)}  median=${med(hitBarsArr)}  p75=${p75(hitBarsArr)}  p90=${p90(hitBarsArr)}`);
    console.log(`  Tương đương giờ: median=${(med(hitBarsArr) * 0.25).toFixed(1)}h  p75=${(p75(hitBarsArr) * 0.25).toFixed(1)}h  p90=${(p90(hitBarsArr) * 0.25).toFixed(1)}h`);
    console.log(`\nMax gain trong 7d:`);
    console.log(`  mean=${mean(maxGainArr).toFixed(1)}%  median=${med(maxGainArr).toFixed(1)}%  p75=${p75(maxGainArr).toFixed(1)}%  p90=${p90(maxGainArr).toFixed(1)}%`);
  }

  // Output JSON cho chart — decimate priceLine + winners
  const c5 = loadCache("5m");
  const priceLine: { ts: number; price: number }[] = [];
  const step = 10;
  for (let i = 0; i < c5.length; i += step) priceLine.push({ ts: c5[i].time, price: c5[i].close });

  // Winners là rất nhiều, có thể >10000 → for chart cap to 5000 random sampled hoặc keep all
  console.log(`\n[mark10] Saving ${winners.length} markers...`);
  writeFileSync(join(__dirname,"..","assets","mark_10pct_15m.json"), JSON.stringify({
    period: { start: c[0].time, end: c[c.length-1].time },
    config: { targetPct: TARGET_PCT, lookforwardBars: LOOKFORWARD_BARS, lookforwardDays: LOOKFORWARD_BARS / 96, tf: TF },
    totalBars: c.length,
    winnerCount: winners.length,
    winnerPct: winners.length / c.length * 100,
    winners,
    priceLine,
  }));
  console.log(`Saved → assets/mark_10pct_15m.json`);
}
main();
