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
type Side = "LONG" | "SHORT";

const BINANCE = "https://api.binance.com/api/v3";
const NOW = Date.now();
const START_TIME = NOW - 3 * 365 * 24 * 60 * 60 * 1000;

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

function simulate(candles: Candle[], entryIdx: number, side: Side, tpPct: number, slPct: number, maxHold: number): Outcome {
  const entry = candles[entryIdx].close;
  if (side === "LONG") {
    const tpAbs = entry * (1 + tpPct / 100);
    const slAbs = entry * (1 - slPct / 100);
    for (let i = entryIdx + 1; i < Math.min(entryIdx + 1 + maxHold, candles.length); i++) {
      if (candles[i].low <= slAbs) return "LOSS";
      if (candles[i].high >= tpAbs) return "WIN";
    }
  } else {
    const tpAbs = entry * (1 - tpPct / 100);
    const slAbs = entry * (1 + slPct / 100);
    for (let i = entryIdx + 1; i < Math.min(entryIdx + 1 + maxHold, candles.length); i++) {
      if (candles[i].high >= slAbs) return "LOSS";
      if (candles[i].low <= tpAbs) return "WIN";
    }
  }
  return "TIMEOUT";
}

function summarize(outcomes: Outcome[], tpPct: number, slPct: number) {
  const wins = outcomes.filter((o) => o === "WIN").length;
  const losses = outcomes.filter((o) => o === "LOSS").length;
  const timeouts = outcomes.filter((o) => o === "TIMEOUT").length;
  const wr = wins + losses > 0 ? wins / (wins + losses) * 100 : 0;
  const net = wins * tpPct - losses * slPct;
  const pf = losses > 0 ? (wins * tpPct) / (losses * slPct) : 0;
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

async function buildRecords(side: Side) {
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

  const records: { idx: number; features: Record<string, string> }[] = [];
  const startIdx = 50;
  const endIdx = entry.length - 145;
  for (let i = startIdx; i < endIdx; i++) {
    if (entry[i].time < START_TIME) continue;
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
    const atr = atrPct(entry, i, 14);
    const htfI = findTFIndexAt(htf, c.time);
    let htfTrend = "htf:na";
    if (htfI >= 0 && htfEma[htfI] != null) {
      const diff = (htf[htfI].close - htfEma[htfI]!) / htfEma[htfI]! * 100;
      htfTrend = diff > 0.5 ? "htf:UP" : diff < -0.5 ? "htf:DOWN" : "htf:FLAT";
    }
    records.push({
      idx: i,
      features: {
        rsi: bucket("rsi", rsi),
        macdHist: bucket("macdHist", macdH),
        bbPct: bucket("bbPct", bbPct),
        ema50Dist: bucket("ema50Dist", emaDist),
        atr: bucket("atr", atr),
        bodyPct: bucket("bodyPct", bodyPct),
        candle: currBull ? "candle:BULL" : "candle:BEAR",
        reversal: `rev:${reversal}`,
        htf: htfTrend,
      },
    });
  }
  return { entry, records };
}

async function main() {
  const selected = JSON.parse(readFileSync("E:/AI/BTC/btc-dashboard/assets/selected_1h_rules_3y_backtest.json", "utf8"));
  const longRules = selected.long.still60.slice(0, 3).map((r: any) => r.rule);
  const shortRules = selected.short.still60.slice(0, 3).map((r: any) => r.rule);

  const tpList = [2, 2.5, 3, 3.5, 4, 5];
  const slList = [1, 1.5, 2, 2.5];
  const holdList = [48, 72, 100, 144];

  const [{ entry: longEntry, records: longRecords }, { entry: shortEntry, records: shortRecords }] = await Promise.all([
    buildRecords("LONG"),
    buildRecords("SHORT"),
  ]);

  function optimizeRule(side: Side, rule: string, entry: Candle[], records: { idx: number; features: Record<string, string> }[]) {
    const parts = rule.split(" & ");
    const matched = records.filter((r) => parts.every((p) => Object.values(r.features).includes(p)));
    const combos: any[] = [];
    for (const tp of tpList) {
      for (const sl of slList) {
        for (const hold of holdList) {
          const outcomes = matched.map((m) => simulate(entry, m.idx, side, tp, sl, hold));
          const summary = summarize(outcomes, tp, sl);
          combos.push({ tp, sl, hold, ...summary });
        }
      }
    }
    return {
      side,
      rule,
      sampleTrades: matched.length,
      bestByNet: [...combos].sort((a, b) => b.netRawPct - a.netRawPct || b.profitFactor - a.profitFactor)[0],
      bestByPF: [...combos].sort((a, b) => b.profitFactor - a.profitFactor || b.netRawPct - a.netRawPct)[0],
      bestWR60: [...combos].filter((c) => c.winRate >= 60).sort((a, b) => b.netRawPct - a.netRawPct || b.profitFactor - a.profitFactor)[0] || null,
      topByNet: [...combos].sort((a, b) => b.netRawPct - a.netRawPct || b.profitFactor - a.profitFactor).slice(0, 10),
    };
  }

  const optimized = {
    generatedAt: new Date().toISOString(),
    period: "3 years",
    searchSpace: { tpList, slList, holdList },
    long: longRules.map((rule: string) => optimizeRule("LONG", rule, longEntry, longRecords)),
    short: shortRules.map((rule: string) => optimizeRule("SHORT", rule, shortEntry, shortRecords)),
  };

  const outPath = "E:/AI/BTC/btc-dashboard/assets/optimized_selected_1h_rules.json";
  writeFileSync(outPath, JSON.stringify(optimized, null, 2));
  console.log(JSON.stringify({
    long: optimized.long.map((r: any) => ({ rule: r.rule, bestByNet: r.bestByNet, bestWR60: r.bestWR60 })),
    short: optimized.short.map((r: any) => ({ rule: r.rule, bestByNet: r.bestByNet, bestWR60: r.bestWR60 })),
    outPath,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
