/**
 * analyze-losers-15m.ts
 *
 * Deep forensic of "what do the 523 LOSS entries look like" when simulating
 * LONG entries on every 15m candle with TP +2% / SL -1% / maxBars 50.
 *
 * Records snapshot of indicators at entry for every WIN and LOSS, then
 * contrasts distributions side-by-side. Output:
 *   console table summary
 *   assets/losers_15m.json          (raw entry-level data)
 *   assets/losers_15m_report.html   (visual comparison — opens in any browser)
 *
 * Usage:
 *   npx tsx tools/analyze-losers-15m.ts
 *   npx tsx tools/analyze-losers-15m.ts --tf=15m --tp=2 --sl=1 --bars=50 --candles=1500
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { Candle } from "../utils/backtester";
import { calcRSISeries, calcStochRSISeries, calcEMASeries } from "../utils/indicators";

const BINANCE_REST = "https://api.binance.com/api/v3";

const args = process.argv.slice(2);
const argTF = args.find((a) => a.startsWith("--tf="))?.replace("--tf=", "") || "15m";
const argTP = parseFloat(args.find((a) => a.startsWith("--tp="))?.replace("--tp=", "") || "2");
const argSL = parseFloat(args.find((a) => a.startsWith("--sl="))?.replace("--sl=", "") || "1");
const argBars = parseInt(args.find((a) => a.startsWith("--bars="))?.replace("--bars=", "") || "50", 10);
const argCandles = parseInt(args.find((a) => a.startsWith("--candles="))?.replace("--candles=", "") || "1500", 10);

const HTF_OF: Record<string, string> = { "5m": "15m", "15m": "1h", "1h": "4h", "4h": "1d" };
const HTF = HTF_OF[argTF] || "1h";

console.log(`=== analyze-losers-${argTF} ===`);
console.log(`TF: ${argTF} · HTF: ${HTF} · TP: +${argTP}% · SL: -${argSL}% · bars: ${argBars} · candles: ${argCandles}\n`);

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

interface IndSeries {
  rsi: (number | null)[];
  stochK: (number | null)[];
  stochD: (number | null)[];
  ema50: (number | null)[];
}
function computeSeries(candles: Candle[]): IndSeries {
  const closes = candles.map((c) => c.close);
  const rsi = [null, ...calcRSISeries(closes)]; // calcRSISeries returns length-14
  // Align RSI series to candles length (null-pad front)
  const rsiAligned: (number | null)[] = new Array(candles.length).fill(null);
  const rsiSrc = calcRSISeries(closes);
  // rsiSrc[0] corresponds to candle index 14 (rsi period)
  for (let i = 0; i < rsiSrc.length; i++) {
    const idx = 14 + i;
    if (idx < candles.length) rsiAligned[idx] = rsiSrc[i];
  }
  const { kSeries, dSeries } = calcStochRSISeries(closes);
  const ema50 = calcEMASeries(closes, 50);
  return { rsi: rsiAligned, stochK: kSeries, stochD: dSeries, ema50 };
  void rsi;
}

/** For each 15m candle i, return the index of the last CLOSED 1h candle at or before time i. */
function buildAlignment(entry: Candle[], htf: Candle[]): number[] {
  const out = new Array(entry.length).fill(-1);
  let j = 0;
  for (let i = 0; i < entry.length; i++) {
    while (j + 1 < htf.length && htf[j + 1].time <= entry[i].time) j++;
    if (htf[j] && htf[j].time <= entry[i].time) out[i] = j;
  }
  return out;
}

interface EntryRecord {
  index: number;
  time: number;
  outcome: "WIN" | "LOSS" | "TIMEOUT";
  hitBars: number;
  entryPrice: number;
  // 15m snapshots
  rsi15: number | null;
  stochK15: number | null;
  stochD15: number | null;
  emaDiffPct: number | null;  // (price - ema50) / ema50 * 100
  candleBodyPct: number | null; // (close - open) / open * 100
  // 1h snapshots (from last CLOSED 1h bar)
  rsi1h: number | null;
  stochK1h: number | null;
  stochD1h: number | null;
  // time features
  hour: number; // 0..23 UTC
  dow: number;  // 0=Sun
}

async function main() {
  console.log(`Fetching klines...`);
  const [candles, htfCandles] = await Promise.all([
    fetchKlines(argTF, argCandles),
    fetchKlines(HTF, Math.min(argCandles, 2000)),
  ]);
  console.log(`  ${argTF}: ${candles.length} candles`);
  console.log(`  ${HTF}: ${htfCandles.length} candles`);
  console.log(`  Period: ${new Date(candles[0].time).toISOString().slice(0, 10)} → ${new Date(candles[candles.length - 1].time).toISOString().slice(0, 10)}\n`);

  console.log(`Computing indicator series...`);
  const ind15 = computeSeries(candles);
  const ind1h = computeSeries(htfCandles);
  const align = buildAlignment(candles, htfCandles);

  console.log(`Simulating LONG entry at every candle (TP +${argTP}% / SL -${argSL}% / ${argBars} bars)...\n`);
  const records: EntryRecord[] = [];

  for (let i = 50; i < candles.length - argBars - 1; i++) {
    const entry = candles[i].close;
    const tpL = entry * (1 + argTP / 100);
    const slL = entry * (1 - argSL / 100);

    let outcome: "WIN" | "LOSS" | "TIMEOUT" = "TIMEOUT";
    let hitBars = argBars;
    for (let j = 1; j <= argBars; j++) {
      const c = candles[i + j];
      if (c.low <= slL) { outcome = "LOSS"; hitBars = j; break; }
      if (c.high >= tpL) { outcome = "WIN"; hitBars = j; break; }
    }

    const htfIdx = align[i];
    const price = entry;
    const ema = ind15.ema50[i];
    const open = candles[i].open;
    const d = new Date(candles[i].time);

    records.push({
      index: i,
      time: candles[i].time,
      outcome, hitBars,
      entryPrice: entry,
      rsi15: ind15.rsi[i],
      stochK15: ind15.stochK[i],
      stochD15: ind15.stochD[i],
      emaDiffPct: ema !== null ? ((price - ema) / ema) * 100 : null,
      candleBodyPct: ((price - open) / open) * 100,
      rsi1h: htfIdx >= 0 ? ind1h.rsi[htfIdx] : null,
      stochK1h: htfIdx >= 0 ? ind1h.stochK[htfIdx] : null,
      stochD1h: htfIdx >= 0 ? ind1h.stochD[htfIdx] : null,
      hour: d.getUTCHours(),
      dow: d.getUTCDay(),
    });
  }

  const wins = records.filter((r) => r.outcome === "WIN");
  const losses = records.filter((r) => r.outcome === "LOSS");
  const timeouts = records.filter((r) => r.outcome === "TIMEOUT");

  console.log("=========================================");
  console.log(`RESULTS: ${records.length} entries simulated`);
  console.log("=========================================");
  console.log(`  ✅ WIN (+${argTP}%): ${wins.length} (${(wins.length / records.length * 100).toFixed(1)}%)`);
  console.log(`  ❌ LOSS (-${argSL}%): ${losses.length} (${(losses.length / records.length * 100).toFixed(1)}%)`);
  console.log(`  ⏱ TIMEOUT: ${timeouts.length} (${(timeouts.length / records.length * 100).toFixed(1)}%)`);
  console.log("");

  // ── Distribution comparison: mean/median of each indicator ─────────────
  const stats = (arr: number[]): { mean: number; median: number; min: number; max: number } => {
    const s = arr.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    if (s.length === 0) return { mean: NaN, median: NaN, min: NaN, max: NaN };
    const mean = s.reduce((a, b) => a + b, 0) / s.length;
    const median = s[Math.floor(s.length / 2)];
    return { mean, median, min: s[0], max: s[s.length - 1] };
  };

  const metrics: Array<{
    key: keyof EntryRecord; label: string;
  }> = [
    { key: "rsi15", label: "RSI 15m" },
    { key: "stochK15", label: "StochK 15m" },
    { key: "stochD15", label: "StochD 15m" },
    { key: "rsi1h", label: "RSI 1h" },
    { key: "stochK1h", label: "StochK 1h" },
    { key: "stochD1h", label: "StochD 1h" },
    { key: "emaDiffPct", label: "Distance from EMA50 (%)" },
    { key: "candleBodyPct", label: "Entry candle body (%)" },
  ];

  const comparisons: Array<{
    label: string;
    winMean: number; lossMean: number; delta: number;
    winMedian: number; lossMedian: number;
  }> = [];

  console.log("─── DISTRIBUTION COMPARISON: WIN vs LOSS ───");
  console.log(`${"Indicator".padEnd(25)}  ${"Win mean".padStart(10)}  ${"Loss mean".padStart(10)}  ${"Δ".padStart(8)}  ${"Win median".padStart(11)}  ${"Loss median".padStart(11)}`);
  for (const m of metrics) {
    const w = stats(wins.map((r) => (r as any)[m.key] as number));
    const l = stats(losses.map((r) => (r as any)[m.key] as number));
    const delta = l.mean - w.mean;
    comparisons.push({ label: m.label, winMean: w.mean, lossMean: l.mean, delta, winMedian: w.median, lossMedian: l.median });
    console.log(`${m.label.padEnd(25)}  ${w.mean.toFixed(1).padStart(10)}  ${l.mean.toFixed(1).padStart(10)}  ${(delta >= 0 ? "+" : "") + delta.toFixed(1)}`.padEnd(59) + `  ${w.median.toFixed(1).padStart(11)}  ${l.median.toFixed(1).padStart(11)}`);
  }

  // ── Histogram helper ────────────────────────────────────────────────
  function histogram(vals: number[], min: number, max: number, bucket: number): number[] {
    const n = Math.ceil((max - min) / bucket);
    const h = new Array(n).fill(0);
    for (const v of vals) {
      if (!Number.isFinite(v)) continue;
      const idx = Math.min(n - 1, Math.max(0, Math.floor((v - min) / bucket)));
      h[idx]++;
    }
    return h;
  }
  function histogramPair(key: keyof EntryRecord, min: number, max: number, bucket: number): { labels: string[]; winH: number[]; lossH: number[] } {
    const winVals = wins.map((r) => (r as any)[key] as number);
    const lossVals = losses.map((r) => (r as any)[key] as number);
    const winH = histogram(winVals, min, max, bucket);
    const lossH = histogram(lossVals, min, max, bucket);
    const labels: string[] = [];
    for (let x = min; x < max; x += bucket) {
      labels.push(`${x.toFixed(0)}-${(x + bucket).toFixed(0)}`);
    }
    return { labels, winH, lossH };
  }

  const hRsi15 = histogramPair("rsi15", 0, 100, 10);
  const hStochK15 = histogramPair("stochK15", 0, 100, 10);
  const hRsi1h = histogramPair("rsi1h", 0, 100, 10);
  const hStochK1h = histogramPair("stochK1h", 0, 100, 10);
  const hHour = histogramPair("hour", 0, 24, 1);

  // ── Write JSON ──────────────────────────────────────────────────────
  const outDir = join(__dirname, "..", "assets");
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, `losers_${argTF}.json`);
  writeFileSync(jsonPath, JSON.stringify({
    tf: argTF, tp: argTP, sl: argSL, maxBars: argBars, totalCandles: candles.length,
    period: {
      from: new Date(candles[0].time).toISOString(),
      to: new Date(candles[candles.length - 1].time).toISOString(),
    },
    summary: { wins: wins.length, losses: losses.length, timeouts: timeouts.length, analyzed: records.length },
    comparisons,
    histograms: { rsi15: hRsi15, stochK15: hStochK15, rsi1h: hRsi1h, stochK1h: hStochK1h, hour: hHour },
    // keep samples small: first 200 of each
    samples: {
      wins: wins.slice(0, 200),
      losses: losses.slice(0, 200),
    },
  }, null, 2));
  console.log(`\n✅ Wrote ${jsonPath}`);

  // ── Write HTML report ──────────────────────────────────────────────
  const htmlPath = join(outDir, `losers_${argTF}_report.html`);
  writeFileSync(htmlPath, buildHTML({
    tf: argTF, tp: argTP, sl: argSL, bars: argBars,
    period: {
      from: new Date(candles[0].time).toISOString().slice(0, 10),
      to: new Date(candles[candles.length - 1].time).toISOString().slice(0, 10),
    },
    total: records.length,
    wins: wins.length, losses: losses.length, timeouts: timeouts.length,
    comparisons,
    hRsi15, hStochK15, hRsi1h, hStochK1h, hHour,
    lossSamples: losses.slice(0, 40),
    winSamples: wins.slice(0, 40),
  }));
  console.log(`✅ Wrote ${htmlPath}`);
  console.log(`   Open: file://${htmlPath.replace(/\\/g, "/")}`);
}

// ── HTML builder ────────────────────────────────────────────────────────
interface HistPair { labels: string[]; winH: number[]; lossH: number[]; }
interface HTMLData {
  tf: string; tp: number; sl: number; bars: number;
  period: { from: string; to: string };
  total: number; wins: number; losses: number; timeouts: number;
  comparisons: Array<{ label: string; winMean: number; lossMean: number; delta: number; winMedian: number; lossMedian: number }>;
  hRsi15: HistPair; hStochK15: HistPair; hRsi1h: HistPair; hStochK1h: HistPair; hHour: HistPair;
  lossSamples: EntryRecord[];
  winSamples: EntryRecord[];
}

function fmt(v: number | null | undefined, d = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return v.toFixed(d);
}
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function histogramHTML(title: string, h: HistPair): string {
  const maxCount = Math.max(...h.winH, ...h.lossH, 1);
  const bars = h.labels.map((lbl, i) => {
    const wPct = (h.winH[i] / maxCount) * 100;
    const lPct = (h.lossH[i] / maxCount) * 100;
    return `
      <tr>
        <td class="bucket">${esc(lbl)}</td>
        <td class="bar-cell">
          <div class="bar-pair">
            <div class="bar win" style="width:${wPct}%" title="WIN: ${h.winH[i]}"></div>
            <span class="bar-count win-count">${h.winH[i]}</span>
          </div>
        </td>
        <td class="bar-cell">
          <div class="bar-pair">
            <div class="bar loss" style="width:${lPct}%" title="LOSS: ${h.lossH[i]}"></div>
            <span class="bar-count loss-count">${h.lossH[i]}</span>
          </div>
        </td>
      </tr>`;
  }).join("");
  return `
    <section class="hist-card">
      <h3>${esc(title)}</h3>
      <table class="hist">
        <thead><tr><th>Bucket</th><th>WIN (${h.winH.reduce((a, b) => a + b, 0)})</th><th>LOSS (${h.lossH.reduce((a, b) => a + b, 0)})</th></tr></thead>
        <tbody>${bars}</tbody>
      </table>
    </section>`;
}

function buildHTML(d: HTMLData): string {
  const totalEvaluated = d.wins + d.losses + d.timeouts;

  const comparisonRows = d.comparisons.map((c) => {
    const dClass = c.delta > 3 ? "delta-high-loss" : c.delta < -3 ? "delta-high-win" : "delta-neutral";
    const sign = c.delta >= 0 ? "+" : "";
    const interpretation = c.delta > 3
      ? `LOSS cao hơn ${c.delta.toFixed(1)} — entry khi chỉ số đã cao dễ thua`
      : c.delta < -3
        ? `WIN cao hơn ${Math.abs(c.delta).toFixed(1)} — chỉ số này cao → lợi cho LONG`
        : "Không khác biệt rõ";
    return `
      <tr>
        <td class="metric">${esc(c.label)}</td>
        <td class="win-text">${fmt(c.winMean)}</td>
        <td class="loss-text">${fmt(c.lossMean)}</td>
        <td class="${dClass}">${sign}${fmt(c.delta)}</td>
        <td class="dim">${fmt(c.winMedian)} / ${fmt(c.lossMedian)}</td>
        <td class="dim" style="font-size:10px">${esc(interpretation)}</td>
      </tr>`;
  }).join("");

  const sampleLossRows = d.lossSamples.slice(0, 30).map((r) => `
    <tr>
      <td class="dim">${new Date(r.time).toISOString().slice(0, 16).replace("T", " ")}</td>
      <td>${r.hitBars}</td>
      <td>${fmt(r.rsi15)}</td>
      <td>${fmt(r.stochK15)}</td>
      <td>${fmt(r.rsi1h)}</td>
      <td>${fmt(r.stochK1h)}</td>
      <td class="${(r.emaDiffPct ?? 0) >= 0 ? 'win-text' : 'loss-text'}">${fmt(r.emaDiffPct, 2)}</td>
      <td class="${(r.candleBodyPct ?? 0) >= 0 ? 'win-text' : 'loss-text'}">${fmt(r.candleBodyPct, 2)}</td>
      <td class="dim">${r.hour}h UTC</td>
    </tr>
  `).join("");

  const sampleWinRows = d.winSamples.slice(0, 30).map((r) => `
    <tr>
      <td class="dim">${new Date(r.time).toISOString().slice(0, 16).replace("T", " ")}</td>
      <td>${r.hitBars}</td>
      <td>${fmt(r.rsi15)}</td>
      <td>${fmt(r.stochK15)}</td>
      <td>${fmt(r.rsi1h)}</td>
      <td>${fmt(r.stochK1h)}</td>
      <td class="${(r.emaDiffPct ?? 0) >= 0 ? 'win-text' : 'loss-text'}">${fmt(r.emaDiffPct, 2)}</td>
      <td class="${(r.candleBodyPct ?? 0) >= 0 ? 'win-text' : 'loss-text'}">${fmt(r.candleBodyPct, 2)}</td>
      <td class="dim">${r.hour}h UTC</td>
    </tr>
  `).join("");

  // Key findings auto-generated
  const keyFindings: string[] = [];
  for (const c of d.comparisons) {
    if (c.delta > 5) keyFindings.push(`🔴 <b>${esc(c.label)}</b>: LOSS mean ${fmt(c.lossMean)} cao hơn WIN ${fmt(c.winMean)} (+${fmt(c.delta)}). Entry khi ${esc(c.label)} cao → XU HƯỚNG THUA.`);
    else if (c.delta < -5) keyFindings.push(`🟢 <b>${esc(c.label)}</b>: WIN mean ${fmt(c.winMean)} cao hơn LOSS ${fmt(c.lossMean)} (${fmt(c.delta)}). ${esc(c.label)} cao → XU HƯỚNG THẮNG.`);
  }
  if (keyFindings.length === 0) keyFindings.push("(Không có indicator nào khác biệt > 5 đơn vị — các entry LONG random phân bố đều.)");

  return `<!DOCTYPE html>
<html lang="vi"><head><meta charset="UTF-8"><title>Losers Analysis ${d.tf} — TP +${d.tp}% / SL -${d.sl}%</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0a0a1a; color: #fff; font-family: Consolas, 'Courier New', monospace; padding: 24px; font-size: 13px; line-height: 1.5; }
  h1 { color: #f7931a; font-size: 22px; margin-bottom: 4px; letter-spacing: 1px; }
  h2 { color: #f7931a; font-size: 16px; margin: 24px 0 10px; letter-spacing: 0.5px; border-bottom: 1px solid #ffffff15; padding-bottom: 6px; }
  h3 { color: #ffa502; font-size: 13px; margin: 0 0 8px; letter-spacing: 0.5px; }
  .header { background: linear-gradient(135deg, #f7931a22, #f7931a08); border: 1px solid #f7931a44; border-radius: 10px; padding: 16px; margin-bottom: 20px; }
  .sub { color: #aaa; font-size: 12px; }
  .summary-row { display: flex; gap: 20px; flex-wrap: wrap; margin-top: 10px; }
  .stat-box { background: #ffffff08; padding: 10px 14px; border-radius: 6px; border: 1px solid #ffffff15; }
  .stat-label { color: #888; font-size: 10px; text-transform: uppercase; letter-spacing: 1px; }
  .stat-val { color: #fff; font-size: 18px; font-weight: 900; }
  .win-text { color: #2ed573; font-weight: 800; }
  .loss-text { color: #ff4757; font-weight: 800; }
  .dim { color: #888; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 14px; }
  th, td { padding: 6px 8px; border-bottom: 1px solid #ffffff08; text-align: left; vertical-align: middle; }
  thead th { background: #ffffff08; color: #f7931a; font-size: 10px; text-transform: uppercase; letter-spacing: 1px; }
  tbody tr:hover { background: #ffffff05; }
  .metric { font-weight: 800; color: #ffa502; }
  .delta-high-loss { color: #ff4757; font-weight: 900; background: #ff475720; }
  .delta-high-win { color: #2ed573; font-weight: 900; background: #2ed57320; }
  .delta-neutral { color: #888; }
  .hist-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 16px; }
  .hist-card { background: #ffffff05; padding: 12px; border-radius: 8px; border: 1px solid #ffffff10; }
  .hist { font-size: 11px; }
  .hist th { font-size: 9px; }
  .bucket { width: 70px; color: #ffa502; font-weight: 700; white-space: nowrap; }
  .bar-cell { padding: 4px 8px; width: 45%; }
  .bar-pair { display: flex; align-items: center; gap: 6px; }
  .bar { height: 14px; border-radius: 3px; min-width: 1px; }
  .bar.win { background: linear-gradient(90deg, #2ed573aa, #2ed573); }
  .bar.loss { background: linear-gradient(90deg, #ff4757aa, #ff4757); }
  .bar-count { font-size: 10px; font-weight: 800; font-family: monospace; }
  .win-count { color: #2ed573; }
  .loss-count { color: #ff4757; }
  .findings { background: #f7931a10; border: 1px solid #f7931a44; border-radius: 8px; padding: 14px; margin: 14px 0; }
  .findings li { margin-bottom: 6px; list-style: none; line-height: 1.6; }
  .samples-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .samples-grid table { font-size: 10px; }
  .samples-grid th { font-size: 9px; }
  @media (max-width: 900px) { .samples-grid { grid-template-columns: 1fr; } }
</style></head>
<body>
  <div class="header">
    <h1>🔍 Losers Analysis — ${esc(d.tf.toUpperCase())}</h1>
    <p class="sub">Mô phỏng <b>vào LONG ở MỌI nến</b> ${esc(d.tf)} với TP <span class="win-text">+${d.tp}%</span> / SL <span class="loss-text">-${d.sl}%</span> / max ${d.bars} nến · Period ${esc(d.period.from)} → ${esc(d.period.to)}</p>
    <div class="summary-row">
      <div class="stat-box"><div class="stat-label">Đã phân tích</div><div class="stat-val">${d.total.toLocaleString()}</div></div>
      <div class="stat-box"><div class="stat-label">✅ Thắng (+${d.tp}%)</div><div class="stat-val win-text">${d.wins} <span class="dim" style="font-size:11px">(${(d.wins / totalEvaluated * 100).toFixed(1)}%)</span></div></div>
      <div class="stat-box"><div class="stat-label">❌ Thua (-${d.sl}%)</div><div class="stat-val loss-text">${d.losses} <span class="dim" style="font-size:11px">(${(d.losses / totalEvaluated * 100).toFixed(1)}%)</span></div></div>
      <div class="stat-box"><div class="stat-label">⏱ Hết hạn</div><div class="stat-val dim">${d.timeouts} <span style="font-size:11px">(${(d.timeouts / totalEvaluated * 100).toFixed(1)}%)</span></div></div>
    </div>
  </div>

  <h2>💡 KEY FINDINGS — Điểm khác biệt giữa THẮNG và THUA</h2>
  <div class="findings">
    <ul>
      ${keyFindings.map((k) => `<li>${k}</li>`).join("")}
    </ul>
  </div>

  <h2>📊 So sánh Mean/Median — WIN vs LOSS</h2>
  <table>
    <thead><tr><th>Indicator</th><th>WIN mean</th><th>LOSS mean</th><th>Δ (loss-win)</th><th>Median W/L</th><th>Ý nghĩa</th></tr></thead>
    <tbody>${comparisonRows}</tbody>
  </table>

  <h2>📈 Phân bố giá trị — WIN (xanh) vs LOSS (đỏ)</h2>
  <div class="hist-grid">
    ${histogramHTML("RSI 15m (entry)", d.hRsi15)}
    ${histogramHTML("StochK 15m (entry)", d.hStochK15)}
    ${histogramHTML("RSI 1h (HTF)", d.hRsi1h)}
    ${histogramHTML("StochK 1h (HTF)", d.hStochK1h)}
    ${histogramHTML("Giờ vào lệnh (UTC)", d.hHour)}
  </div>

  <h2>🔴 Mẫu 30 lệnh THUA đầu</h2>
  <div class="samples-grid">
    <table>
      <thead><tr><th>Time</th><th>Bars</th><th>RSI15</th><th>SK15</th><th>RSI1H</th><th>SK1H</th><th>ΔEMA50%</th><th>Body%</th><th>Giờ</th></tr></thead>
      <tbody>${sampleLossRows}</tbody>
    </table>
    <table>
      <thead><tr><th>Time</th><th>Bars</th><th>RSI15</th><th>SK15</th><th>RSI1H</th><th>SK1H</th><th>ΔEMA50%</th><th>Body%</th><th>Giờ</th></tr></thead>
      <tbody>${sampleWinRows}</tbody>
    </table>
  </div>
  <p class="dim" style="font-size:10px">Bên trái: <span class="loss-text">LOSS</span> · Bên phải: <span class="win-text">WIN</span></p>
</body></html>`;
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
