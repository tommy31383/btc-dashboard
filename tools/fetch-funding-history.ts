/**
 * fetch-funding-history.ts — fetch BTC funding rate history từ Binance public API.
 *
 * Endpoint: GET /fapi/v1/fundingRate?symbol=BTCUSDT&limit=1000&startTime=X
 * Returns: [{ symbol, fundingTime, fundingRate, markPrice }, ...]
 * Funding 3 lần/ngày (00/08/16 UTC) → 3y = ~3285 entries → 4 calls (1000 limit each).
 *
 * Save: .cache/binance-funding-3y.json
 */
import { writeFileSync, existsSync } from "fs";
import { join } from "path";

const BASE = "https://fapi.binance.com";
const SYMBOL = "BTCUSDT";
const OUT_PATH = join(__dirname, "..", ".cache", "binance-funding-3y.json");

interface FundingEntry { symbol: string; fundingTime: number; fundingRate: string; markPrice: string; }

async function fetchPage(startTime?: number): Promise<FundingEntry[]> {
  const url = startTime
    ? `${BASE}/fapi/v1/fundingRate?symbol=${SYMBOL}&limit=1000&startTime=${startTime}`
    : `${BASE}/fapi/v1/fundingRate?symbol=${SYMBOL}&limit=1000`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch fail ${res.status}: ${await res.text()}`);
  return res.json() as Promise<FundingEntry[]>;
}

async function main() {
  console.log("[funding] Fetching BTCUSDT funding history 3y...");
  // 3 năm = ~3y × 365 × 3 funding/day = 3285. Fetch 4 pages từ oldest đến newest.
  const start3y = Date.now() - 3 * 365 * 24 * 60 * 60_000;
  let all: FundingEntry[] = [];
  let cursor = start3y;
  for (let page = 0; page < 5; page++) {
    const batch = await fetchPage(cursor);
    if (batch.length === 0) break;
    all = all.concat(batch);
    const last = batch[batch.length - 1];
    cursor = last.fundingTime + 1;
    console.log(`  Page ${page + 1}: ${batch.length} entries, cursor → ${new Date(cursor).toISOString()}`);
    if (batch.length < 1000) break;
    await new Promise(r => setTimeout(r, 200));
  }
  // Dedup + sort
  const seen = new Set<number>();
  const unique = all.filter(f => {
    if (seen.has(f.fundingTime)) return false;
    seen.add(f.fundingTime); return true;
  }).sort((a, b) => a.fundingTime - b.fundingTime);

  // Save
  const out = unique.map(f => ({
    time: f.fundingTime,
    rate: parseFloat(f.fundingRate),
    mark: parseFloat(f.markPrice),
  }));
  writeFileSync(OUT_PATH, JSON.stringify(out));
  console.log(`\nSaved ${out.length} funding entries → ${OUT_PATH}`);
  console.log(`Period: ${new Date(out[0].time).toISOString()} → ${new Date(out[out.length - 1].time).toISOString()}`);
  console.log(`Min rate: ${Math.min(...out.map(o => o.rate))} | Max rate: ${Math.max(...out.map(o => o.rate))} | Avg: ${(out.reduce((s, o) => s + o.rate, 0) / out.length).toFixed(6)}`);
}

main();
