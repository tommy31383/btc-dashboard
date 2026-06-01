/**
 * fetch-market-data-7y.ts — Fetch OI + L/S ratios + Taker B/S history từ Binance public.
 *
 * Endpoints:
 *   /futures/data/openInterestHist
 *   /futures/data/topLongShortAccountRatio
 *   /futures/data/topLongShortPositionRatio
 *   /futures/data/globalLongShortAccountRatio
 *   /futures/data/takerlongshortRatio
 *
 * Note: Binance data history start ~2020 (not 7y full). Saving available range.
 * Period: 1h (granular enough cho 4h trend setups, manageable size)
 */
import { writeFileSync } from "fs";
import { join } from "path";

const BASE = "https://fapi.binance.com";
const SYMBOL = "BTCUSDT";
const PERIOD = "1h";  // hourly granularity
const OUT_DIR = join(__dirname, "..", ".cache");

interface Entry { time: number; [k: string]: number; }

async function fetchPaged(endpoint: string, startTs: number, valueParser: (raw: any) => { time: number; vals: Record<string, number> }): Promise<Entry[]> {
  const all: Entry[] = [];
  let cursor = startTs;
  const now = Date.now();
  while (cursor < now) {
    const url = `${BASE}/futures/data/${endpoint}?symbol=${SYMBOL}&period=${PERIOD}&limit=500&startTime=${cursor}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) {
        console.warn(`  ${endpoint} HTTP ${res.status}: ${await res.text().catch(() => "")}`);
        cursor += 500 * 60 * 60_000;  // skip 500h
        continue;
      }
      const batch = await res.json() as any[];
      if (!Array.isArray(batch) || batch.length === 0) break;
      for (const raw of batch) {
        const { time, vals } = valueParser(raw);
        all.push({ time, ...vals });
      }
      const last = batch[batch.length - 1];
      const lastTime = parseInt(last.timestamp ?? last.time ?? "0");
      if (lastTime <= cursor) break;
      cursor = lastTime + 1;
      if (batch.length < 500) break;
      await new Promise(r => setTimeout(r, 100));  // rate limit
    } catch (e: any) {
      console.warn(`  ${endpoint} fetch fail: ${e?.message ?? e}`);
      cursor += 500 * 60 * 60_000;
    }
  }
  // Dedup + sort
  const seen = new Set<number>();
  const unique = all.filter(e => { if (seen.has(e.time)) return false; seen.add(e.time); return true; });
  unique.sort((a, b) => a.time - b.time);
  return unique;
}

async function main() {
  console.log("[fetch] Starting Binance Futures Data 7y collection...");
  const start7y = Date.now() - 7 * 365 * 24 * 60 * 60_000;
  // Binance starts ~2020 — accept whatever available

  console.log("\n[1] Open Interest History...");
  const oi = await fetchPaged("openInterestHist", start7y, (r) => ({
    time: parseInt(r.timestamp),
    vals: { sumOI: parseFloat(r.sumOpenInterest), sumOIValue: parseFloat(r.sumOpenInterestValue) },
  }));
  console.log(`  ${oi.length} entries: ${new Date(oi[0]?.time ?? 0).toISOString()} → ${new Date(oi[oi.length - 1]?.time ?? 0).toISOString()}`);
  writeFileSync(join(OUT_DIR, `binance-oi-${PERIOD}-7y.json`), JSON.stringify(oi));

  console.log("\n[2] Top Trader Long/Short Account Ratio...");
  const tla = await fetchPaged("topLongShortAccountRatio", start7y, (r) => ({
    time: parseInt(r.timestamp),
    vals: { longAcc: parseFloat(r.longAccount), shortAcc: parseFloat(r.shortAccount), ratio: parseFloat(r.longShortRatio) },
  }));
  console.log(`  ${tla.length} entries`);
  writeFileSync(join(OUT_DIR, `binance-topLSAccount-${PERIOD}-7y.json`), JSON.stringify(tla));

  console.log("\n[3] Top Trader Long/Short Position Ratio...");
  const tlp = await fetchPaged("topLongShortPositionRatio", start7y, (r) => ({
    time: parseInt(r.timestamp),
    vals: { longPos: parseFloat(r.longAccount), shortPos: parseFloat(r.shortAccount), ratio: parseFloat(r.longShortRatio) },
  }));
  console.log(`  ${tlp.length} entries`);
  writeFileSync(join(OUT_DIR, `binance-topLSPosition-${PERIOD}-7y.json`), JSON.stringify(tlp));

  console.log("\n[4] Global Long/Short Account Ratio (retail)...");
  const gla = await fetchPaged("globalLongShortAccountRatio", start7y, (r) => ({
    time: parseInt(r.timestamp),
    vals: { longAcc: parseFloat(r.longAccount), shortAcc: parseFloat(r.shortAccount), ratio: parseFloat(r.longShortRatio) },
  }));
  console.log(`  ${gla.length} entries`);
  writeFileSync(join(OUT_DIR, `binance-globalLS-${PERIOD}-7y.json`), JSON.stringify(gla));

  console.log("\n[5] Taker Long/Short Buy/Sell Volume Ratio...");
  const tk = await fetchPaged("takerlongshortRatio", start7y, (r) => ({
    time: parseInt(r.timestamp),
    vals: { buyVol: parseFloat(r.buyVol), sellVol: parseFloat(r.sellVol), ratio: parseFloat(r.buySellRatio) },
  }));
  console.log(`  ${tk.length} entries`);
  writeFileSync(join(OUT_DIR, `binance-takerRatio-${PERIOD}-7y.json`), JSON.stringify(tk));

  console.log("\n✅ All fetched. Summary:");
  console.log(`  OI:           ${oi.length} | TopLS Acc: ${tla.length} | TopLS Pos: ${tlp.length} | Global LS: ${gla.length} | Taker: ${tk.length}`);
}

main();
