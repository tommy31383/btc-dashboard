/**
 * fetch-spot-5m-7y.ts (anh Tommy 2026-05-14)
 *
 * Fetch Binance Spot BTCUSDT 5m từ Jan 1 2019 đến hiện tại (~7 năm).
 * Save vào .cache/binance-5m-7y.json (override nếu có).
 *
 * Binance API: limit 1000 bars/request, rate-limit 6000 req/min.
 * 7y ≈ 736k bars → ~736 requests, mỗi request 150ms delay → ~2 phút total.
 */
import { writeFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";

const BINANCE_REST = "https://api.binance.com/api/v3";
const SYMBOL = "BTCUSDT";
const INTERVAL = "5m";
const START_TIME = Date.UTC(2019, 0, 1);  // Jan 1 2019 UTC
const OUT_PATH = join(__dirname, "..", ".cache", "binance-5m-7y.json");

interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number; }

async function fetchKlinesSince(startTime: number): Promise<Candle[]> {
  const all: Candle[] = [];
  let cursor = startTime;
  let req = 0;
  while (true) {
    const params = new URLSearchParams({ symbol: SYMBOL, interval: INTERVAL, limit: "1000", startTime: String(cursor) });
    const res = await fetch(`${BINANCE_REST}/klines?${params.toString()}`);
    if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;
    const batch = data.map((k: any[]) => ({
      time: Number(k[0]), open: Number(k[1]), high: Number(k[2]),
      low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]),
    })) as Candle[];
    all.push(...batch);
    req++;
    if (req % 50 === 0) {
      const d = new Date(batch[batch.length - 1].time).toISOString().slice(0, 10);
      console.log(`  req ${req}: ${all.length.toLocaleString()} bars, latest ${d}`);
    }
    if (batch.length < 1000) break;
    cursor = batch[batch.length - 1].time + 1;
    await new Promise(r => setTimeout(r, 150));  // gentle rate-limit
  }
  // Dedup + sort
  const uniq = new Map<number, Candle>();
  for (const c of all) if (c.time >= startTime) uniq.set(c.time, c);
  return Array.from(uniq.values()).sort((a, b) => a.time - b.time);
}

async function main() {
  console.log(`[fetch-7y] ${SYMBOL} ${INTERVAL} từ ${new Date(START_TIME).toISOString().slice(0, 10)}`);
  console.log(`[fetch-7y] Target: ${OUT_PATH}`);
  if (existsSync(OUT_PATH)) {
    const existing = JSON.parse(readFileSync(OUT_PATH, "utf8")) as Candle[];
    console.log(`[fetch-7y] File đã có ${existing.length.toLocaleString()} bars, latest ${new Date(existing[existing.length - 1].time).toISOString().slice(0, 10)}. Overwriting...`);
  }

  const t0 = Date.now();
  const candles = await fetchKlinesSince(START_TIME);
  const elapsedMin = ((Date.now() - t0) / 60000).toFixed(1);

  if (candles.length === 0) { console.error("[fetch-7y] ❌ Không tải được bar nào"); return; }

  const first = new Date(candles[0].time).toISOString().slice(0, 10);
  const last = new Date(candles[candles.length - 1].time).toISOString().slice(0, 10);
  const yearsCovered = (candles.length * 5 / (60 * 24 * 365)).toFixed(2);
  console.log(`\n[fetch-7y] ✅ Done in ${elapsedMin} min`);
  console.log(`  Bars: ${candles.length.toLocaleString()}`);
  console.log(`  Range: ${first} → ${last} (${yearsCovered} năm)`);
  console.log(`  Saving...`);
  writeFileSync(OUT_PATH, JSON.stringify(candles));
  const sizeMB = (JSON.stringify(candles).length / 1024 / 1024).toFixed(1);
  console.log(`  File size: ${sizeMB} MB`);
}

main().catch(e => { console.error(e); process.exit(1); });
