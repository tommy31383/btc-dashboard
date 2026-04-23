/**
 * preview-risk-radar.ts
 * Fetch live klines từ Binance, compute RiskRadar state, render HTML preview.
 */
import { writeFileSync } from "fs";
import { join } from "path";
import { calcRSI, calcMACD, calcEMA, calcATRPct } from "../utils/indicators";

const BINANCE = "https://api.binance.com/api/v3";

async function fetchKlines(interval: string, limit: number) {
  const res = await fetch(`${BINANCE}/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`);
  const data: any[] = await res.json();
  return data.map((k) => ({ time:k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5] }));
}

function emaDistPct(klines: any[]): number | null {
  if (klines.length < 50) return null;
  const closes = klines.map((k) => k.close);
  const ema = calcEMA(closes, 50);
  if (ema === null) return null;
  return ((closes[closes.length-1] - ema) / ema) * 100;
}

function htfState(dist: number | null): "UP" | "DOWN" | "FLAT" | "NA" {
  if (dist === null) return "NA";
  if (dist > 0.5) return "UP";
  if (dist < -0.5) return "DOWN";
  return "FLAT";
}

(async () => {
  console.log("Fetching live klines...");
  const [k15m, k1h, k4h] = await Promise.all([
    fetchKlines("15m", 500),
    fetchKlines("1h", 500),
    fetchKlines("4h", 500),
  ]);
  const closes1h = k1h.map((k) => k.close);
  const rsi1h = calcRSI(closes1h);
  const macdHist1h = calcMACD(closes1h).histogram;
  const atrPct1h = calcATRPct(k1h);
  const atrPct15m = calcATRPct(k15m);
  const atrPct4h = calcATRPct(k4h);
  const emaDist1h = emaDistPct(k1h);
  const emaDist4h = emaDistPct(k4h);
  const htf4hState = htfState(emaDist4h);

  const state = { rsi1h, macdHist1h, atrPct1h, atrPct15m, atrPct4h, emaDist1h, emaDist4h, htf4hState, price: closes1h[closes1h.length-1] };
  console.log(JSON.stringify(state, null, 2));

  const outPath = join(__dirname, "..", "assets", "risk_radar_state.json");
  writeFileSync(outPath, JSON.stringify(state, null, 2));
  console.log(`✅ Wrote ${outPath}`);
})();
