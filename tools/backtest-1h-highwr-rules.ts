import { readFileSync, writeFileSync } from "fs";
import { calcRSISeriesAligned, calcMACDSeries, calcBollingerSeries, calcEMASeries } from "../utils/indicators";

type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type Outcome = "WIN" | "LOSS" | "TIMEOUT";

const BINANCE = "https://api.binance.com/api/v3";
const NOW = Date.now();
const START_TIME = NOW - 3 * 365 * 24 * 60 * 60 * 1000;
const SIDE = "LONG" as const;
const TP_PCT = 3;
const SL_PCT = 2;
const MAX_HOLD = 100;
const MIN_WR = 60;
const MIN_N = 40;

async function fetchKlines(interval: string, startTime: number): Promise<Candle[]> {
  const all: Candle[] = [];
  let cursor = startTime;
  while (true) {
    const params = new URLSearchParams({
      symbol: "BTCUSDT",
      interval,
      limit: "1000",
      startTime: String(cursor),
    });
    const res = await fetch(`${BINANCE}/klines?${params.toString()}`);
    if (!res.ok) throw new Error(`Fetch ${interval} failed: HTTP ${res.status}`);
    const data: any[] = await res.json();
    if (!data.length) break;
    const batch = data.map((k) => ({
      time: +k[0],
      open: +k[1],
      high: +k[2],
      low: +k[3],
      close: +k[4],
      volume: +k[5],
    }));
    all.push(...batch);
    if (batch.length < 1000) break;
    cursor = batch[batch.length - 1].time + 1;
    await new Promise((r) => setTimeout(r, 120));
  }
  const m = new Map<number, Candle>();
  for (const c of all) if (c.time >= startTime) m.set(c.time, c);
  return [...m.values()].sort((a, b) => a.time - b.time);
}

function findTFIndexAt(arr: Candle[], t: number): number {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].time <= t) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
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

function simulate(candles: Candle[], entryIdx: number): Outcome {
  const entry = candles[entryIdx].close;
  const tpAbs = entry * (1 + TP_PCT / 100);
  const slAbs = entry * (1 - SL_PCT / 100);
  for (let i = entryIdx + 1; i < Math.min(entryIdx + 1 + MAX_HOLD, candles.length); i++) {
    if (candles[i].low <= slAbs) return "LOSS";
    if (candles[i].high >= tpAbs) return "WIN";
  }
  return "TIMEOUT";
}

function bucket(name: string, v: number | null): string {
  if (v === null || !isFinite(v)) return `${name}:null`;
  if (name === "rsi") { if (v < 30) return "rsi:<30"; if (v < 45) return "rsi:30-45"; if (v < 55) return "rsi:45-55"; if (v < 70) return "rsi:55-70"; return "rsi:>70"; }
  if (name === "macdHist") { if (v < -50) return "macd:<-50"; if (v < 0) return "macd:-50..0"; if (v < 50) return "macd:0..50"; return "macd:>50"; }
  if (name === "bbPct") { if (v < 0) return "bb%:<0"; if (v < 0.25) return "bb%:0-25"; if (v < 0.5) return "bb%:25-50"; if (v < 0.75) return "bb%:50-75"; if (v <= 1) return "bb%:75-100"; return "bb%:>100"; }
  if (name === "ema50Dist") { if (v < -2) return "ema:<-2%"; if (v < -0.5) return "ema:-2..-0.5%"; if (v < 0.5) return "ema:-0.5..0.5%"; if (v < 2) return "ema:0.5..2%"; return "ema:>2%"; }
  if (name === "atr") { if (v < 0.3) return "atr:<0.3%"; if (v < 0.6) return "atr:0.3-0.6%"; if (v < 1.0) return "atr:0.6-1.0%"; if (v < 2.0) return "atr:1.0-2.0%"; return "atr:>2%"; }
  if (name === "bodyPct") { if (v < 0.1) return "body:<0.1%"; if (v < 0.3) return "body:0.1-0.3%"; if (v < 0.6) return "body:0.3-0.6%"; if (v < 1.2) return "body:0.6-1.2%"; return "body:>1.2%"; }
  return `${name}:${v.toFixed(2)}`;
}

function summarize(outcomes: Outcome[]) {
  const wins = outcomes.filter((o) => o === "WIN").length;
  const losses = outcomes.filter((o) => o === "LOSS").length;
  const timeouts = outcomes.filter((o) => o === "TIMEOUT").length;
  const wr = wins + losses > 0 ? wins / (wins + losses) * 100 : 0;
  const net = wins * TP_PCT - losses * SL_PCT;
  const pf = losses > 0 ? (wins * TP_PCT) / (losses * SL_PCT) : 0;
  return {
    trades: outcomes.length,
    wins,
    losses,
    timeouts,
    winRate: Number(wr.toFixed(2)),
    netRawPct: Number(net.toFixed(2)),
    profitFactor: Number(pf.toFixed(2)),
  };
}

async function main() {
  console.log("Loading scanned >60% rules for 1H...");
  const scan = JSON.parse(readFileSync("E:/AI/BTC/btc-dashboard/assets/scan_features_LONG_tp3sl2.json", "utf8"));
  const tf = scan.tfs["1h"];

  const pairCandidates = Object.entries<any>(tf.pairStats)
    .filter(([, s]) => s.n >= MIN_N && s.wr >= MIN_WR)
    .map(([rule, s]) => ({ kind: "pair", rule, scanN: s.n, scanWR: s.wr }));
  const tripleCandidates = Object.entries<any>(tf.tripleStats)
    .filter(([, s]) => s.n >= MIN_N && s.wr >= MIN_WR)
    .map(([rule, s]) => ({ kind: "triple", rule, scanN: s.n, scanWR: s.wr }));

  const candidates = [...pairCandidates, ...tripleCandidates];
  console.log(`Found ${candidates.length} 1H rules with WR > ${MIN_WR}% in scan sample.`);

  const [entry, htf] = await Promise.all([
    fetchKlines("1h", START_TIME - 30 * 60 * 60 * 1000),
    fetchKlines("4h", START_TIME - 30 * 4 * 60 * 60 * 1000),
  ]);

  const closes = entry.map((c) => c.close);
  const rsiArr = calcRSISeriesAligned(closes, 14);
  const macdArr = calcMACDSeries(closes);
  const bbArr = calcBollingerSeries(closes);
  const ema50Arr = calcEMASeries(closes, 50);
  const htfCloses = htf.map((c) => c.close);
  const htfEma = calcEMASeries(htfCloses, 50);

  const records: { idx: number; time: number; features: Record<string, string>; outcome: Outcome }[] = [];
  const startIdx = 50;
  const endIdx = entry.length - MAX_HOLD - 1;

  for (let i = startIdx; i < endIdx; i++) {
    if (entry[i].time < START_TIME) continue;
    const outcome = simulate(entry, i);
    const c = entry[i];
    const prev = entry[i - 1];
    const prevBull = prev.close >= prev.open;
    const currBull = c.close >= c.open;
    const reversal = prevBull === currBull ? "CONT" : (!prevBull && currBull ? "UP_REV" : "DOWN_REV");
    const bodyPct = Math.abs(c.close - c.open) / c.open * 100;
    const rsi = rsiArr[i];
    const macdH = macdArr.histogram[i];
    const bbUp = bbArr.upper[i], bbLo = bbArr.lower[i];
    const bbPct = (bbUp != null && bbLo != null && bbUp !== bbLo) ? (c.close - bbLo) / (bbUp - bbLo) : null;
    const ema50 = ema50Arr[i];
    const emaDist = ema50 != null ? (c.close - ema50) / ema50 * 100 : null;
    const atrP = atrPct(entry, i, 14);
    const htfI = findTFIndexAt(htf, c.time);
    let htfTrend = "htf:na";
    if (htfI >= 0 && htfEma[htfI] != null) {
      const diff = (htf[htfI].close - htfEma[htfI]!) / htfEma[htfI]! * 100;
      htfTrend = diff > 0.5 ? "htf:UP" : diff < -0.5 ? "htf:DOWN" : "htf:FLAT";
    }
    records.push({
      idx: i,
      time: c.time,
      outcome,
      features: {
        rsi: bucket("rsi", rsi),
        macdHist: bucket("macdHist", macdH),
        bbPct: bucket("bbPct", bbPct),
        ema50Dist: bucket("ema50Dist", emaDist),
        atr: bucket("atr", atrP),
        bodyPct: bucket("bodyPct", bodyPct),
        candle: currBull ? "candle:BULL" : "candle:BEAR",
        reversal: `rev:${reversal}`,
        htf: htfTrend,
      },
    });
  }

  const results = candidates.map((candidate) => {
    const parts = candidate.rule.split(" & ");
    const matched = records.filter((r) => parts.every((p) => Object.values(r.features).includes(p)));
    const summary = summarize(matched.map((m) => m.outcome));
    return {
      ...candidate,
      ...summary,
      edgeVsBaseline: Number((summary.winRate - 41.2).toFixed(2)),
    };
  }).sort((a, b) => b.netRawPct - a.netRawPct);

  const out = {
    generatedAt: new Date().toISOString(),
    period: "3 years",
    params: { side: SIDE, tp: TP_PCT, sl: SL_PCT, hold: MAX_HOLD, minWr: MIN_WR, minN: MIN_N },
    totalCandidates: candidates.length,
    topByNet: results.slice(0, 30),
    topByWinRate: [...results].sort((a, b) => b.winRate - a.winRate).slice(0, 30),
  };

  const outPath = "E:/AI/BTC/btc-dashboard/assets/highwr_1h_rules_backtest.json";
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({
    totalCandidates: out.totalCandidates,
    topByNet: out.topByNet.slice(0, 10),
  }, null, 2));
  console.log(`\nSaved: ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
