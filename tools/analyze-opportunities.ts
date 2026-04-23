/**
 * analyze-opportunities.ts
 *
 * Question: "Có bao nhiêu lần giá di chuyển ±X% thực sự?
 *           So với rules đang catch được bao nhiêu?"
 *
 * For each candle, simulate "if I went LONG/SHORT at close, would price hit
 * +TP% before -SL% within N bars?". Count successful opportunities to see how
 * many trades a perfect rule could theoretically catch.
 *
 * Output: console table + writes assets/opportunities_15m.json
 *
 * Usage:
 *   npx tsx tools/analyze-opportunities.ts
 *   npx tsx tools/analyze-opportunities.ts --tf=1h --tp=3 --sl=1.5 --bars=100
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { Candle } from "../utils/backtester";

const BINANCE_REST = "https://api.binance.com/api/v3";

const args = process.argv.slice(2);
const argTF = args.find((a) => a.startsWith("--tf="))?.replace("--tf=", "") || "15m";
const argTP = parseFloat(args.find((a) => a.startsWith("--tp="))?.replace("--tp=", "") || "2");
const argSL = parseFloat(args.find((a) => a.startsWith("--sl="))?.replace("--sl=", "") || "1");
const argBars = parseInt(args.find((a) => a.startsWith("--bars="))?.replace("--bars=", "") || "50", 10);
const argCandles = parseInt(args.find((a) => a.startsWith("--candles="))?.replace("--candles=", "") || "1500", 10);

console.log(`=== analyze-opportunities ===`);
console.log(`TF: ${argTF} · TP: +${argTP}% · SL: -${argSL}% · max bars: ${argBars} · candles: ${argCandles}`);
console.log("");

async function fetchKlines(interval: string, total: number): Promise<Candle[]> {
  const all: Candle[] = [];
  let endTime: number | undefined;
  while (all.length < total) {
    const remaining = total - all.length;
    const limit = Math.min(1000, remaining);
    const params = new URLSearchParams({ symbol: "BTCUSDT", interval, limit: String(limit) });
    if (endTime) params.set("endTime", String(endTime));
    const res = await fetch(`${BINANCE_REST}/klines?${params.toString()}`);
    const data: any[] = await res.json();
    if (data.length === 0) break;
    const batch: Candle[] = data.map((k) => ({
      time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
      low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
    }));
    all.unshift(...batch);
    endTime = batch[0].time - 1;
    await new Promise((r) => setTimeout(r, 100));
  }
  const byTime = new Map<number, Candle>();
  for (const c of all) byTime.set(c.time, c);
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

interface Opportunity {
  index: number;
  time: number;
  type: "LONG" | "SHORT" | "BOTH";
  entryPrice: number;
  hitBars: number;        // how many bars to hit TP
  exitPrice: number;
  pctMove: number;        // raw price move %
}

/** For each candle, simulate going LONG/SHORT at close and check outcome */
function findOpportunities(candles: Candle[], tp: number, sl: number, maxBars: number): {
  longOps: Opportunity[];
  shortOps: Opportunity[];
  longLosers: number;     // entries that hit SL (could have been bad LONG)
  shortLosers: number;
  longTimeouts: number;
  shortTimeouts: number;
} {
  const longOps: Opportunity[] = [];
  const shortOps: Opportunity[] = [];
  let longLosers = 0;
  let shortLosers = 0;
  let longTimeouts = 0;
  let shortTimeouts = 0;

  for (let i = 0; i < candles.length - maxBars; i++) {
    const entry = candles[i].close;
    const tpL = entry * (1 + tp / 100);
    const slL = entry * (1 - sl / 100);
    const tpS = entry * (1 - tp / 100);
    const slS = entry * (1 + sl / 100);

    let longResolved: "WIN" | "LOSS" | "TIMEOUT" = "TIMEOUT";
    let longBars = maxBars;
    let longExitPx = candles[i + maxBars].close;
    let shortResolved: "WIN" | "LOSS" | "TIMEOUT" = "TIMEOUT";
    let shortBars = maxBars;
    let shortExitPx = candles[i + maxBars].close;

    for (let j = 1; j <= maxBars; j++) {
      const c = candles[i + j];
      // LONG outcome
      if (longResolved === "TIMEOUT") {
        if (c.low <= slL) { longResolved = "LOSS"; longBars = j; longExitPx = slL; }
        else if (c.high >= tpL) { longResolved = "WIN"; longBars = j; longExitPx = tpL; }
      }
      // SHORT outcome
      if (shortResolved === "TIMEOUT") {
        if (c.high >= slS) { shortResolved = "LOSS"; shortBars = j; shortExitPx = slS; }
        else if (c.low <= tpS) { shortResolved = "WIN"; shortBars = j; shortExitPx = tpS; }
      }
      if (longResolved !== "TIMEOUT" && shortResolved !== "TIMEOUT") break;
    }

    if (longResolved === "WIN") {
      longOps.push({
        index: i, time: candles[i].time, type: "LONG",
        entryPrice: entry, hitBars: longBars, exitPrice: longExitPx,
        pctMove: ((longExitPx - entry) / entry) * 100,
      });
    } else if (longResolved === "LOSS") longLosers++;
    else longTimeouts++;

    if (shortResolved === "WIN") {
      shortOps.push({
        index: i, time: candles[i].time, type: "SHORT",
        entryPrice: entry, hitBars: shortBars, exitPrice: shortExitPx,
        pctMove: -((shortExitPx - entry) / entry) * 100,
      });
    } else if (shortResolved === "LOSS") shortLosers++;
    else shortTimeouts++;
  }

  return { longOps, shortOps, longLosers, shortLosers, longTimeouts, shortTimeouts };
}

async function main() {
  console.log(`Fetching ${argCandles} ${argTF} candles...`);
  const candles = await fetchKlines(argTF, argCandles);
  console.log(`Got ${candles.length} candles · ${new Date(candles[0].time).toISOString()} → ${new Date(candles[candles.length - 1].time).toISOString()}`);
  console.log("");

  const totalCandles = candles.length;
  const analyzedCandles = totalCandles - argBars;

  console.log(`Analyzing ${analyzedCandles} candles for TP +${argTP}% / SL -${argSL}% within ${argBars} bars...`);
  const t0 = Date.now();
  const result = findOpportunities(candles, argTP, argSL, argBars);
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log("");

  const totalLong = result.longOps.length + result.longLosers + result.longTimeouts;
  const totalShort = result.shortOps.length + result.shortLosers + result.shortTimeouts;

  console.log("=========================================");
  console.log(`📊 KẾT QUẢ TRÊN ${argTF.toUpperCase()} (${totalCandles} nến)`);
  console.log("=========================================");
  console.log("");
  console.log(`Nếu vào LONG ở MỌI nến (${totalLong} lần):`);
  console.log(`  ✅ THẮNG (giá tăng +${argTP}% trước -${argSL}%):  ${result.longOps.length.toString().padStart(5)} (${(result.longOps.length / totalLong * 100).toFixed(1)}%)`);
  console.log(`  ❌ THUA (chạm SL trước):                          ${result.longLosers.toString().padStart(5)} (${(result.longLosers / totalLong * 100).toFixed(1)}%)`);
  console.log(`  ⏱ TIMEOUT (không hit gì trong ${argBars} nến):    ${result.longTimeouts.toString().padStart(5)} (${(result.longTimeouts / totalLong * 100).toFixed(1)}%)`);
  console.log("");
  console.log(`Nếu vào SHORT ở MỌI nến (${totalShort} lần):`);
  console.log(`  ✅ THẮNG (giá giảm -${argTP}% trước +${argSL}%):  ${result.shortOps.length.toString().padStart(5)} (${(result.shortOps.length / totalShort * 100).toFixed(1)}%)`);
  console.log(`  ❌ THUA (chạm SL trước):                          ${result.shortLosers.toString().padStart(5)} (${(result.shortLosers / totalShort * 100).toFixed(1)}%)`);
  console.log(`  ⏱ TIMEOUT:                                        ${result.shortTimeouts.toString().padStart(5)} (${(result.shortTimeouts / totalShort * 100).toFixed(1)}%)`);
  console.log("");
  console.log("=========================================");
  console.log(`🎯 TỔNG CƠ HỘI ±${argTP}%: ${result.longOps.length + result.shortOps.length}`);
  console.log("=========================================");

  // Distribution by hit speed
  const allWins = [...result.longOps, ...result.shortOps];
  const fastHits = allWins.filter((o) => o.hitBars <= 5).length;
  const medHits = allWins.filter((o) => o.hitBars > 5 && o.hitBars <= 20).length;
  const slowHits = allWins.filter((o) => o.hitBars > 20).length;
  console.log("");
  console.log(`Phân bố tốc độ hit TP:`);
  console.log(`  ⚡ Nhanh (≤ 5 nến):  ${fastHits} (${(fastHits / allWins.length * 100).toFixed(1)}%)`);
  console.log(`  🚶 Trung (6-20):     ${medHits} (${(medHits / allWins.length * 100).toFixed(1)}%)`);
  console.log(`  🐢 Chậm (>20):       ${slowHits} (${(slowHits / allWins.length * 100).toFixed(1)}%)`);

  // Theoretical perfect rule
  console.log("");
  console.log(`💡 GIẢ SỬ có rule HOÀN HẢO catch hết:`);
  console.log(`   Sẽ vào ${result.longOps.length + result.shortOps.length} lệnh × +${argTP}% PnL = TỔNG +${((result.longOps.length + result.shortOps.length) * argTP * 100).toFixed(0)}% (vốn ban đầu)`);

  // Compare with current rule from hard_rules.json
  try {
    const hardRules = require(join(__dirname, "..", "assets", "hard_rules.json"));
    const tfData = hardRules.tfs[argTF];
    if (tfData) {
      console.log("");
      console.log(`📦 So với rule HARD #1 cho ${argTF.toUpperCase()}:`);
      const rule = tfData.rules[0];
      console.log(`   Rule catch: ${rule.stats.trades} lệnh · WR ${rule.stats.winRate}% · PF ${rule.stats.profitFactor}`);
      const captureRate = (rule.stats.trades / (result.longOps.length + result.shortOps.length) * 100).toFixed(1);
      console.log(`   ⚠️ CAPTURE RATE: ${captureRate}% (rule chỉ catch ${rule.stats.trades}/${result.longOps.length + result.shortOps.length} cơ hội)`);
    }
  } catch {}

  // Write JSON
  const outDir = join(__dirname, "..", "assets");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `opportunities_${argTF}.json`);
  writeFileSync(outPath, JSON.stringify({
    tf: argTF,
    tp: argTP,
    sl: argSL,
    maxBars: argBars,
    totalCandles,
    analyzed: analyzedCandles,
    summary: {
      longWins: result.longOps.length,
      longLosses: result.longLosers,
      longTimeouts: result.longTimeouts,
      shortWins: result.shortOps.length,
      shortLosses: result.shortLosers,
      shortTimeouts: result.shortTimeouts,
      totalOpportunities: result.longOps.length + result.shortOps.length,
    },
    longOpportunities: result.longOps.slice(0, 100), // sample first 100
    shortOpportunities: result.shortOps.slice(0, 100),
  }, null, 2));
  console.log("");
  console.log(`✅ Wrote ${outPath}`);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
