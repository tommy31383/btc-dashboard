/**
 * fetch-altcoins-5m-3y.ts — Fetch BNB/XRP/DOGE/AVAX 5m 3y từ Binance Spot.
 */
import { writeFileSync, existsSync } from "fs";
import { join } from "path";

const BINANCE_REST = "https://api.binance.com/api/v3";
const INTERVAL = "5m";
const START_TIME = new Date("2023-05-25T00:00:00Z").getTime();
const SYMBOLS = ["BNBUSDT", "XRPUSDT", "DOGEUSDT", "AVAXUSDT"];

interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number; }

async function fetchKlinesSince(symbol: string, startTime: number): Promise<Candle[]> {
  const all: Candle[] = [];
  let cursor = startTime;
  let req = 0;
  while (true) {
    const params = new URLSearchParams({ symbol, interval: INTERVAL, limit: "1000", startTime: String(cursor) });
    const res = await fetch(`${BINANCE_REST}/klines?${params.toString()}`);
    if (!res.ok) throw new Error(`Fetch ${symbol} failed: HTTP ${res.status}`);
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
      console.log(`  [${symbol}] req ${req}: ${all.length.toLocaleString()} bars, latest ${d}`);
    }
    if (batch.length < 1000) break;
    cursor = batch[batch.length - 1].time + 1;
    await new Promise(r => setTimeout(r, 150));
  }
  const uniq = new Map<number, Candle>();
  for (const c of all) if (c.time >= startTime) uniq.set(c.time, c);
  return Array.from(uniq.values()).sort((a, b) => a.time - b.time);
}

async function main() {
  for (const symbol of SYMBOLS) {
    const sym = symbol.replace("USDT", "").toLowerCase();
    const outPath = join(__dirname, "..", ".cache", `binance-${sym}-5m-3y.json`);
    console.log(`\n[fetch] ${symbol} 5m từ ${new Date(START_TIME).toISOString().slice(0, 10)}`);
    if (existsSync(outPath)) { console.log(`  Skip — already exists`); continue; }
    const t0 = Date.now();
    const candles = await fetchKlinesSince(symbol, START_TIME);
    if (candles.length === 0) { console.error(`  ❌ Không tải được`); continue; }
    const first = new Date(candles[0].time).toISOString().slice(0, 10);
    const last = new Date(candles[candles.length - 1].time).toISOString().slice(0, 10);
    console.log(`  ✅ ${candles.length.toLocaleString()} bars (${first} → ${last}) in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
    writeFileSync(outPath, JSON.stringify(candles));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
