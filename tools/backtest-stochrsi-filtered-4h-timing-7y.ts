import { readFile } from "node:fs/promises";

import { calcEMASeries } from "../utils/indicators";
import { aggregateCandles, buildStochPoints, HOUR_MS, WEEK_MS, type CampaignSignal, type Candle, type StochPoint } from "./stochrsi-macro-cycle/core";
import { runVariant, type FundingPayment } from "./stochrsi-macro-cycle/replay";

function parseFunding(value: any): FundingPayment { return value.mark === null ? { time: Number(value.time), rate: Number(value.rate) } : { time: Number(value.time), rate: Number(value.rate), mark: Number(value.mark) }; }
function bullCross(points: StochPoint[], i: number): boolean { const p = points[i]; const q = points[i - 1]; return p.k !== null && p.d !== null && q.k !== null && q.d !== null && q.k <= q.d && p.k > p.d; }
function bearCross(points: StochPoint[], i: number): boolean { const p = points[i]; const q = points[i - 1]; return p.k !== null && p.d !== null && q.k !== null && q.d !== null && q.k >= q.d && p.k < p.d; }

function buildMacroEvents(two: StochPoint[], weekly: StochPoint[], ema: (number | null)[], entryMode: "CROSS" | "SLOPE", requireTrend: boolean): number[] {
  const out: number[] = [];
  for (let i = 2; i < two.length; i += 1) {
    const cross = bullCross(two, i);
    const currentTwoK = two[i].k;
    const previousTwoK = two[i - 1].k;
    const priorTwoK = two[i - 2].k;
    const slopeTurn = currentTwoK !== null && previousTwoK !== null && priorTwoK !== null && priorTwoK >= previousTwoK && currentTwoK > previousTwoK;
    if (!(entryMode === "CROSS" ? cross : slopeTurn) || previousTwoK === null || priorTwoK === null) continue;
    const wi = weekly.findIndex((point) => point.closeTime === two[i].closeTime);
    const wp = wi >= 0 ? weekly[wi] : undefined;
    const prev = wi >= 1 ? weekly[wi - 1] : undefined;
    if (!wp || !prev || wp.k === null || prev.k === null || wp.k <= prev.k || previousTwoK === null || priorTwoK === null || Math.min(previousTwoK, priorTwoK) >= 20) continue;
    if (requireTrend && (ema[wi] === null || ema[wi - 1] === null || wp.close <= ema[wi]! || ema[wi]! <= ema[wi - 1]!)) continue;
    out.push(two[i].closeTime);
  }
  return out;
}

function first4HEntry(event: number, points: StochPoint[], mode: "RECLAIM" | "BREAK"): number | null {
  let oversold = false;
  for (let i = 1; i < points.length; i += 1) {
    const p = points[i]; const q = points[i - 1];
    if (p.closeTime <= event || p.k === null || q.k === null) continue;
    if (p.k < 20) oversold = true;
    if (!oversold) continue;
    if (mode === "RECLAIM" && p.k > q.k && p.k < 50) return p.closeTime;
    if (mode === "BREAK" && p.close > q.high) return p.closeTime;
  }
  return null;
}

function aggregate4H(source: Candle[], asOfMs: number): Candle[] {
  const span = 4 * HOUR_MS;
  const buckets = new Map<number, Candle[]>();
  for (const bar of source) {
    const start = Math.floor(bar.time / span) * span;
    const bucket = buckets.get(start) ?? [];
    bucket.push(bar);
    buckets.set(start, bucket);
  }
  return [...buckets.entries()]
    .filter(([start, bars]) => start + span <= asOfMs && bars.length === 4 && bars[0].time === start && bars[3].time === start + 3 * HOUR_MS)
    .map(([time, bars]) => ({
      time,
      open: bars[0].open,
      high: Math.max(...bars.map((bar) => bar.high)),
      low: Math.min(...bars.map((bar) => bar.low)),
      close: bars[3].close,
      volume: bars.reduce((sum, bar) => sum + bar.volume, 0),
    }));
}

function buildCampaigns(events: number[], fourH: StochPoint[], weekly: StochPoint[], mode: "ARM" | "RECLAIM" | "BREAK"): CampaignSignal[] {
  const out: CampaignSignal[] = [];
  let blocked = -Infinity;
  for (const event of events) {
    if (event < blocked) continue;
    const entry = mode === "ARM" ? event : first4HEntry(event, fourH, mode);
    if (entry === null) continue;
    const exit = weekly.find((point, index) => point.closeTime > entry && bearCross(weekly, index));
    out.push({ armTime: event, episodeEntries: [entry], episodeRecoveryTimes: [null], dailyOversoldEntries: [entry], ...(exit ? { exitTime: exit.closeTime } : {}) });
    blocked = exit?.closeTime ?? Number.POSITIVE_INFINITY;
  }
  return out;
}

async function main(): Promise<void> {
  const hourly = (JSON.parse(await readFile(process.env.STOCHRSI_HOURLY ?? ".cache/binance-futures-btcusdt-1h-7y.json", "utf8")) as any[]).map((r) => ({ time: Number(r.time), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume) } satisfies Candle));
  const funding = (JSON.parse(await readFile(process.env.STOCHRSI_FUNDING ?? ".cache/binance-futures-btcusdt-funding-7y.json", "utf8")) as any[]).map(parseFunding);
  const asOf = hourly.at(-1)!.time + HOUR_MS;
  const weekly = buildStochPoints(aggregateCandles(hourly, "1w", asOf), WEEK_MS);
  const two = buildStochPoints(aggregateCandles(hourly, "2w", asOf), 2 * WEEK_MS);
  const ema = calcEMASeries(weekly.map((point) => point.close), 20);
  const fourH = buildStochPoints(aggregate4H(hourly, asOf), 4 * HOUR_MS);
  const entryMode = process.env.STOCHRSI_ENTRY_MODE === "SLOPE" ? "SLOPE" : "CROSS";
  const requireTrend = process.env.STOCHRSI_REQUIRE_WEEKLY_TREND !== "0";
  const events = buildMacroEvents(two, weekly, ema, entryMode, requireTrend);
  for (const mode of ["ARM", "RECLAIM", "BREAK"] as const) {
    const campaigns = buildCampaigns(events, fourH, weekly, mode);
    const result = runVariant("DAILY_EPISODE", campaigns, hourly, funding);
    const closed = result.campaigns.filter((c) => c.closed && c.legs.length > 0);
    const wins = closed.filter((c) => c.netPnl > 0).length;
    const values = result.campaigns.map((c) => c.netPnl).sort((a, b) => b - a);
    console.log(`${mode}: entries=${campaigns.length} WR=${closed.length ? (wins / closed.length * 100).toFixed(1) : "0.0"}% net=$${result.netPnl.toFixed(2)} withoutBest=$${(result.netPnl - (values[0] ?? 0)).toFixed(2)} maxDD=$${(-result.maxDrawdown).toFixed(2)} ${result.campaigns.map((c) => `${new Date(c.armTime).toISOString().slice(0, 10)}:${c.netPnl.toFixed(2)}`).join(" ")}`);
  }
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode = 1; });
