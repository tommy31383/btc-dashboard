/**
 * audit-btc-intraday-range.ts — Verify claim "BTC daily 1-3% / 1-5% moves nhiều".
 *
 * Stats từ 7y data:
 * - Daily range distribution (high-low) %
 * - 5m / 15m / 1h swing distribution
 * - Số ngày có 1-3% / 3-5% / 5%+ moves
 * - Số intra-day reversal opportunities
 */
import { readFileSync } from "fs";
import { join } from "path";

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }

function loadCache(name: string): Candle[] {
  return JSON.parse(readFileSync(join(__dirname, "..", ".cache", name), "utf8"));
}

function aggregateBars(c5: Candle[], minutes: number): Candle[] {
  const targetMs = minutes * 60_000;
  const out: Candle[] = [];
  let cur: { bucket: number; bars: Candle[] } | null = null;
  for (const b of c5) {
    const bucket = Math.floor(b.time / targetMs) * targetMs;
    if (!cur || cur.bucket !== bucket) {
      if (cur && cur.bars.length > 0) {
        const bars = cur.bars;
        let hi = -Infinity, lo = Infinity, vol = 0;
        for (const x of bars) { if (x.high > hi) hi = x.high; if (x.low < lo) lo = x.low; vol += x.volume ?? 0; }
        out.push({ time: cur.bucket, open: bars[0].open, high: hi, low: lo, close: bars[bars.length - 1].close, volume: vol });
      }
      cur = { bucket, bars: [b] };
    } else cur.bars.push(b);
  }
  if (cur && cur.bars.length > 0) {
    const bars = cur.bars;
    let hi = -Infinity, lo = Infinity, vol = 0;
    for (const x of bars) { if (x.high > hi) hi = x.high; if (x.low < lo) lo = x.low; vol += x.volume ?? 0; }
    out.push({ time: cur.bucket, open: bars[0].open, high: hi, low: lo, close: bars[bars.length - 1].close, volume: vol });
  }
  return out;
}

function percentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * p / 100);
  return sorted[idx];
}

function main() {
  console.log("[audit] Loading 5m 7y...");
  const c5 = loadCache("binance-5m-7y.json");
  console.log(`  ${c5.length} bars`);

  const c1d = aggregateBars(c5, 1440);
  const c1h = aggregateBars(c5, 60);
  console.log(`  Derived: 1d=${c1d.length}, 1h=${c1h.length}`);

  // === 1. Daily range distribution ===
  console.log("\n=== 1. DAILY (1d) RANGE DISTRIBUTION 7y ===");
  const dailyRanges = c1d.map(b => (b.high - b.low) / b.low * 100);  // % range high-low
  const dailyAbsClose = c1d.map(b => Math.abs(b.close - b.open) / b.open * 100);  // |close-open|

  console.log(`Total days: ${dailyRanges.length}`);
  console.log(`Daily RANGE (high-low) %:`);
  console.log(`  Min: ${Math.min(...dailyRanges).toFixed(2)}%`);
  console.log(`  Max: ${Math.max(...dailyRanges).toFixed(2)}%`);
  console.log(`  Mean: ${(dailyRanges.reduce((a,b)=>a+b,0)/dailyRanges.length).toFixed(2)}%`);
  console.log(`  Median: ${percentile(dailyRanges, 50).toFixed(2)}%`);
  console.log(`  P25: ${percentile(dailyRanges, 25).toFixed(2)}%`);
  console.log(`  P75: ${percentile(dailyRanges, 75).toFixed(2)}%`);
  console.log(`  P90: ${percentile(dailyRanges, 90).toFixed(2)}%`);
  console.log(`  P95: ${percentile(dailyRanges, 95).toFixed(2)}%`);

  const ranges = {
    "0-1%":  dailyRanges.filter(r => r < 1).length,
    "1-2%":  dailyRanges.filter(r => r >= 1 && r < 2).length,
    "2-3%":  dailyRanges.filter(r => r >= 2 && r < 3).length,
    "3-5%":  dailyRanges.filter(r => r >= 3 && r < 5).length,
    "5-10%": dailyRanges.filter(r => r >= 5 && r < 10).length,
    "10%+":  dailyRanges.filter(r => r >= 10).length,
  };
  console.log(`\nDaily range buckets:`);
  for (const [k, v] of Object.entries(ranges)) {
    const pct = (v / dailyRanges.length * 100).toFixed(1);
    console.log(`  ${k.padEnd(8)}: ${String(v).padStart(4)} days (${pct}%)`);
  }

  // === 2. Hourly (1h) swing distribution ===
  console.log("\n=== 2. HOURLY (1h) RANGE DISTRIBUTION 7y ===");
  const hourlyRanges = c1h.map(b => (b.high - b.low) / b.low * 100);
  console.log(`Total hours: ${hourlyRanges.length}`);
  console.log(`Hourly RANGE %:`);
  console.log(`  Mean: ${(hourlyRanges.reduce((a,b)=>a+b,0)/hourlyRanges.length).toFixed(3)}%`);
  console.log(`  Median: ${percentile(hourlyRanges, 50).toFixed(3)}%`);
  console.log(`  P75: ${percentile(hourlyRanges, 75).toFixed(3)}%`);
  console.log(`  P90: ${percentile(hourlyRanges, 90).toFixed(3)}%`);
  console.log(`  P95: ${percentile(hourlyRanges, 95).toFixed(3)}%`);
  console.log(`  P99: ${percentile(hourlyRanges, 99).toFixed(3)}%`);

  const hRanges = {
    "<0.3%":   hourlyRanges.filter(r => r < 0.3).length,
    "0.3-0.5%": hourlyRanges.filter(r => r >= 0.3 && r < 0.5).length,
    "0.5-1%":  hourlyRanges.filter(r => r >= 0.5 && r < 1).length,
    "1-2%":    hourlyRanges.filter(r => r >= 1 && r < 2).length,
    "2-3%":    hourlyRanges.filter(r => r >= 2 && r < 3).length,
    "3%+":     hourlyRanges.filter(r => r >= 3).length,
  };
  console.log(`\nHourly range buckets:`);
  for (const [k, v] of Object.entries(hRanges)) {
    const pct = (v / hourlyRanges.length * 100).toFixed(1);
    console.log(`  ${k.padEnd(10)}: ${String(v).padStart(5)} hours (${pct}%)`);
  }

  // === 3. Intra-day reversal opportunities ===
  console.log("\n=== 3. INTRA-DAY REVERSAL OPPORTUNITIES ===");
  // Count days where (high-open) AND (open-low) both >= 1% → reversal day
  let reversalDays = 0;
  let bigReversalDays = 0;  // >= 2% both ways
  let oneSidedDays = 0;
  for (const b of c1d) {
    const upMove = (b.high - b.open) / b.open * 100;
    const downMove = (b.open - b.low) / b.open * 100;
    if (upMove >= 1 && downMove >= 1) reversalDays++;
    if (upMove >= 2 && downMove >= 2) bigReversalDays++;
    if (upMove >= 2 && downMove < 0.5) oneSidedDays++;
    if (downMove >= 2 && upMove < 0.5) oneSidedDays++;
  }
  console.log(`Reversal days (both up & down ≥1%): ${reversalDays} / ${c1d.length} (${(reversalDays/c1d.length*100).toFixed(1)}%)`);
  console.log(`Big reversal days (both ≥2%): ${bigReversalDays} / ${c1d.length} (${(bigReversalDays/c1d.length*100).toFixed(1)}%)`);
  console.log(`One-sided trending days (move ≥2%, opposite <0.5%): ${oneSidedDays} / ${c1d.length} (${(oneSidedDays/c1d.length*100).toFixed(1)}%)`);

  // === 4. v0.4.40 fire frequency mismatch ===
  console.log("\n=== 4. v0.4.40 TREND SETUP FIRE FREQUENCY vs OPPORTUNITY ===");
  const tradingDays = c1d.length;
  console.log(`Trading days 7y: ${tradingDays}`);
  console.log(`Expected entries v0.4.40 (from backtest): ~150/yr = ~0.4/day`);
  console.log(`Days với 1-3% intra-day range: ~${ranges["1-2%"] + ranges["2-3%"]} (${((ranges["1-2%"] + ranges["2-3%"])/tradingDays*100).toFixed(1)}%)`);
  console.log(`Days với 1-5% intra-day range: ~${ranges["1-2%"] + ranges["2-3%"] + ranges["3-5%"]} (${((ranges["1-2%"] + ranges["2-3%"] + ranges["3-5%"])/tradingDays*100).toFixed(1)}%)`);
  console.log(`\n→ GAP: v0.4.40 chỉ fire ~0.4/day nhưng có 60-80% days có swing 1-3%+ tiềm năng entry`);
}

main();
